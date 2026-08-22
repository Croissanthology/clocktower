#!/usr/bin/env python3
"""
transcribe.py — live multichannel transcription daemon for a Blood on the
Clocktower table.

Opens an input stream on the named device (built-in mic today = 1 channel;
Behringer UMC1820 later = up to 8 channels, no code changes needed —
channel count is clamped to whatever the device actually reports).
Audio is chunked into ~5s windows; each channel's RMS is checked against
--threshold to skip silence; active channels are transcribed in parallel
via a thread pool using whisper (mlx-whisper on Apple Silicon, falling
back to faster-whisper if mlx isn't installed). Each transcription is
POSTed to <server>/api/hear as {"mic": <1-based channel>, "text": "..."}.
If the server is unreachable, the line is printed instead and the daemon
keeps running.

Examples:
    venv/bin/python transcribe.py --list
    venv/bin/python transcribe.py --device "MacBook Air Microphone" --channels 1 --dry-run
    venv/bin/python transcribe.py --device "UMC1820" --channels 8 --server http://localhost:4141
"""
import argparse
import queue
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from math import gcd

import numpy as np
import sounddevice as sd

try:
    import requests
except ImportError:
    requests = None


# ---------------------------------------------------------------------------
# Whisper engine selection: mlx-whisper preferred (Apple-Silicon GPU via
# Metal), faster-whisper as a fallback if mlx isn't installed on this
# machine.
# ---------------------------------------------------------------------------
ENGINE = None
try:
    import mlx_whisper

    ENGINE = "mlx"
except ImportError:
    try:
        from faster_whisper import WhisperModel

        ENGINE = "faster-whisper"
    except ImportError:
        ENGINE = None

MODEL_MAP_MLX = {
    "tiny": "mlx-community/whisper-tiny-mlx",
    "base": "mlx-community/whisper-base-mlx",
    "small": "mlx-community/whisper-small-mlx",
    "medium": "mlx-community/whisper-medium-mlx",
    "large-v3": "mlx-community/whisper-large-v3-mlx",
}
MODEL_MAP_FASTER = {
    "tiny": "tiny",
    "base": "base",
    "small": "small",
    "medium": "medium",
    "large-v3": "large-v3",
}

HALLUCINATION_PHRASES = {
    "thank you",
    "thank you.",
    "thanks for watching",
    "thanks for watching!",
    "thank you for watching",
    "you",
    "you.",
    "bye",
    "bye.",
    "bye bye",
    "the end",
    "subtitles by the amara.org community",
    "www.amara.org",
    ".",
    "...",
    "",
}

_faster_model = None  # lazily-constructed faster-whisper model, cached per process


def die(msg):
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(1)


def list_devices():
    print(f"{'idx':>4}  {'in_ch':>5}  {'rate':>7}  name")
    for idx, dev in enumerate(sd.query_devices()):
        if dev["max_input_channels"] > 0:
            print(
                f"{idx:>4}  {dev['max_input_channels']:>5}  "
                f"{int(dev['default_samplerate']):>7}  {dev['name']}"
            )


def resolve_input_device(spec):
    devices = sd.query_devices()
    try:
        idx = int(spec)
        if 0 <= idx < len(devices):
            return idx, devices[idx]
        die(f"device index {idx} out of range (0..{len(devices) - 1})")
    except ValueError:
        pass
    matches = [
        (i, d)
        for i, d in enumerate(devices)
        if spec.lower() in d["name"].lower() and d["max_input_channels"] > 0
    ]
    if not matches:
        any_matches = [
            (i, d) for i, d in enumerate(devices) if spec.lower() in d["name"].lower()
        ]
        if any_matches:
            die(
                f"device matching '{spec}' found but has no input channels: "
                f"{[d['name'] for _, d in any_matches]}"
            )
        die(f"no input device matching '{spec}'. Run with --list to see available devices.")
    if len(matches) > 1:
        names = ", ".join(f"{i}:{d['name']}" for i, d in matches)
        die(f"device spec '{spec}' is ambiguous, matches: {names}. Use an index instead.")
    return matches[0]


def rms(x):
    if x.size == 0:
        return 0.0
    return float(np.sqrt(np.mean(np.square(x, dtype=np.float64))))


def resample_to_16k(x, orig_sr):
    target = 16000
    if orig_sr == target:
        return x.astype(np.float32)
    g = gcd(int(orig_sr), target)
    up, down = target // g, int(orig_sr) // g
    from scipy.signal import resample_poly

    y = resample_poly(x, up, down)
    return y.astype(np.float32)


def is_hallucination(text):
    t = text.strip().lower().strip(".").strip()
    if not t:
        return True
    if t in HALLUCINATION_PHRASES:
        return True
    words = t.split()
    if len(words) >= 4 and len(set(words)) == 1:
        return True  # e.g. "you you you you"
    return False


def transcribe_mlx(audio_16k, lang, model_repo):
    kwargs = dict(
        path_or_hf_repo=model_repo,
        verbose=False,
        condition_on_previous_text=False,
        no_speech_threshold=0.6,
    )
    if lang and lang != "auto":
        kwargs["language"] = lang
    result = mlx_whisper.transcribe(audio_16k, **kwargs)
    return result["text"].strip()


def transcribe_faster(audio_16k, lang, model_size):
    global _faster_model
    if _faster_model is None:
        _faster_model = WhisperModel(model_size, device="auto", compute_type="int8")
    kwargs = {}
    if lang and lang != "auto":
        kwargs["language"] = lang
    segments, _info = _faster_model.transcribe(audio_16k, **kwargs)
    return " ".join(seg.text for seg in segments).strip()


def transcribe_channel(audio_16k, lang, model_ref):
    if ENGINE == "mlx":
        return transcribe_mlx(audio_16k, lang, model_ref)
    elif ENGINE == "faster-whisper":
        return transcribe_faster(audio_16k, lang, model_ref)
    else:
        raise RuntimeError("no whisper engine available")


def post_or_print(server, dry_run, channel, text):
    payload = {"mic": channel, "text": text}
    if dry_run or requests is None:
        print(f"  [dry-run] would POST {server}/api/hear  {payload}")
        return
    try:
        requests.post(f"{server}/api/hear", json=payload, timeout=2)
    except requests.exceptions.RequestException as e:
        print(f"  [server unreachable: {e}] {payload}")


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--device", help="input device name (substring) or index")
    ap.add_argument("--channels", type=int, default=1, help="requested channel count (clamped to device max)")
    ap.add_argument("--server", default="http://localhost:4141", help="game server base URL")
    ap.add_argument("--lang", default="auto", help="language code, or 'auto' to detect per chunk")
    ap.add_argument("--threshold", type=float, default=0.02, help="RMS silence threshold, 0..1 (default 0.02)")
    ap.add_argument("--chunk-seconds", type=float, default=5.0, help="chunk window length in seconds")
    ap.add_argument("--model", default="small", choices=sorted(MODEL_MAP_MLX.keys()), help="whisper model size")
    ap.add_argument("--dry-run", action="store_true", help="never POST, just print what would be sent")
    ap.add_argument("--duration", type=float, default=None, help="stop after this many seconds (default: run forever)")
    ap.add_argument("--list", action="store_true", help="list input devices and exit")
    args = ap.parse_args()

    if args.list:
        list_devices()
        return

    if ENGINE is None:
        die("no whisper engine installed. pip install mlx-whisper (Apple Silicon) or faster-whisper")

    if not args.device:
        ap.error("--device is required unless --list is given")

    idx, dev = resolve_input_device(args.device)
    max_in = dev["max_input_channels"]
    n_channels = args.channels
    if n_channels > max_in:
        print(
            f"warning: requested {n_channels} channels but device '{dev['name']}' "
            f"only supports {max_in}; clamping to {max_in}",
            file=sys.stderr,
        )
        n_channels = max_in
    if n_channels < 1:
        die(f"device '{dev['name']}' reports 0 input channels")

    samplerate = int(dev["default_samplerate"])
    chunk_frames = int(args.chunk_seconds * samplerate)

    model_ref = MODEL_MAP_MLX[args.model] if ENGINE == "mlx" else MODEL_MAP_FASTER[args.model]

    print(
        f"engine={ENGINE} model={args.model} ({model_ref})  device=#{idx} '{dev['name']}'  "
        f"channels={n_channels}  rate={samplerate}Hz  chunk={args.chunk_seconds}s  "
        f"threshold={args.threshold}  server={args.server}  dry_run={args.dry_run}"
    )

    # Warm the model once up front (outside the request path) so the first
    # real chunk isn't paying model-load latency.
    print("warming model...")
    t0 = time.time()
    try:
        transcribe_channel(np.zeros(16000, dtype=np.float32), args.lang, model_ref)
    except Exception as e:
        die(f"model warm-up failed: {e}")
    print(f"model warm in {time.time() - t0:.2f}s")

    audio_q = queue.Queue()
    levels = np.zeros(n_channels)  # latest 0.5s-block rms per channel
    last_speech = [0.0] * n_channels  # wall time of last block over threshold

    def callback(indata, frames, time_info, status):
        if status:
            print(f"stream status: {status}", file=sys.stderr)
        audio_q.put(indata.copy())
        now = time.time()
        for ch in range(n_channels):
            l = rms(indata[:, ch])
            levels[ch] = l
            if l >= args.threshold:
                last_speech[ch] = now

    # once a second, tell the game server what the mics are hearing (drives the UI meters)
    def report_levels():
        while True:
            time.sleep(1.0)
            if requests is None:
                continue
            now = time.time()
            try:
                requests.post(
                    f"{args.server}/api/miclevels",
                    json={
                        "device": dev["name"],
                        "channels": n_channels,
                        "levels": [round(float(x), 4) for x in levels],
                        "speech_ago": [round(now - t, 1) if t else None for t in last_speech],
                    },
                    timeout=1,
                )
            except requests.exceptions.RequestException:
                pass

    threading.Thread(target=report_levels, daemon=True).start()

    executor = ThreadPoolExecutor(max_workers=max(1, n_channels))

    def handle_chunk(chunk, chunk_idx):
        t_start = time.time()
        active = []
        for ch in range(n_channels):
            level = rms(chunk[:, ch])
            if level >= args.threshold:
                active.append((ch, level))

        if not active:
            print(f"chunk {chunk_idx}: no active channels (all below threshold {args.threshold})")
            return

        futures = {}
        for ch, level in active:
            mono_16k = resample_to_16k(chunk[:, ch], samplerate)
            futures[executor.submit(transcribe_channel, mono_16k, args.lang, model_ref)] = (ch, level)

        results = []
        for fut in as_completed(futures):
            ch, level = futures[fut]
            try:
                text = fut.result()
            except Exception as e:
                print(f"  channel {ch + 1}: transcription error: {e}", file=sys.stderr)
                continue
            results.append((ch, level, text))

        latency = time.time() - t_start
        active_str = ",".join(f"ch{ch + 1}(rms={level:.3f})" for ch, level in active)
        print(f"chunk {chunk_idx}: active=[{active_str}] latency={latency:.2f}s")

        for ch, level, text in sorted(results):
            if is_hallucination(text):
                print(f"  channel {ch + 1}: [filtered hallucination] '{text}'")
                continue
            preview = text if len(text) <= 90 else text[:87] + "..."
            print(f"  channel {ch + 1}: \"{preview}\"")
            post_or_print(args.server, args.dry_run, ch + 1, text)

    print(f"listening on '{dev['name']}' ({n_channels} channel(s))... Ctrl-C to stop")
    buffer = np.zeros((0, n_channels), dtype=np.float32)
    chunk_idx = 0
    run_start = time.time()

    try:
        with sd.InputStream(
            device=idx,
            channels=n_channels,
            samplerate=samplerate,
            dtype="float32",
            callback=callback,
            blocksize=int(samplerate * 0.5),
        ):
            while True:
                if args.duration is not None and (time.time() - run_start) >= args.duration:
                    print(f"reached --duration {args.duration}s, stopping")
                    break
                try:
                    block = audio_q.get(timeout=0.5)
                except queue.Empty:
                    continue
                buffer = np.vstack([buffer, block])
                while buffer.shape[0] >= chunk_frames:
                    chunk, buffer = buffer[:chunk_frames], buffer[chunk_frames:]
                    chunk_idx += 1
                    handle_chunk(chunk, chunk_idx)
    except KeyboardInterrupt:
        print("\nstopping (Ctrl-C)")
    except Exception as e:
        die(f"audio stream failed: {e}")
    finally:
        executor.shutdown(wait=True)


if __name__ == "__main__":
    main()
