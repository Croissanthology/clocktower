#!/usr/bin/env python3
"""
play_channel.py — play a mono WAV into a single channel of a named/indexed
output device, with all other channels silent.

Works unchanged on the built-in 2-channel speakers today and on the
Behringer UMC1820 (10 analog outputs) once it arrives: the zero matrix is
built from the device's actual max output channel count via
sounddevice.query_devices(), never hardcoded.

Examples:
    venv/bin/python play_channel.py --list
    venv/bin/python play_channel.py --device "MacBook Air Speakers" --channel 1 --rate 1.1 ../voices/samples/alba.wav
    venv/bin/python play_channel.py --device "UMC1820" --channel 5 test.wav
"""
import argparse
import sys

import numpy as np
import sounddevice as sd
import soundfile as sf


def list_devices():
    print(f"{'idx':>4}  {'out_ch':>6}  {'in_ch':>5}  name")
    for idx, dev in enumerate(sd.query_devices()):
        if dev["max_output_channels"] > 0:
            print(
                f"{idx:>4}  {dev['max_output_channels']:>6}  "
                f"{dev['max_input_channels']:>5}  {dev['name']}"
            )


def resolve_device(spec):
    """Accept a device index (int-like string) or a substring of the name."""
    devices = sd.query_devices()
    # Try exact index first.
    try:
        idx = int(spec)
        if 0 <= idx < len(devices):
            return idx, devices[idx]
        die(f"device index {idx} out of range (0..{len(devices) - 1})")
    except ValueError:
        pass
    # Substring match on name (case-insensitive), preferring devices with outputs.
    matches = [
        (i, d)
        for i, d in enumerate(devices)
        if spec.lower() in d["name"].lower() and d["max_output_channels"] > 0
    ]
    if not matches:
        # maybe it matched a name but with 0 output channels
        any_matches = [
            (i, d) for i, d in enumerate(devices) if spec.lower() in d["name"].lower()
        ]
        if any_matches:
            die(
                f"device matching '{spec}' found but has no output channels: "
                f"{[d['name'] for _, d in any_matches]}"
            )
        die(
            f"no output device matching '{spec}'. Run with --list to see "
            f"available devices."
        )
    if len(matches) > 1:
        names = ", ".join(f"{i}:{d['name']}" for i, d in matches)
        die(f"device spec '{spec}' is ambiguous, matches: {names}. Use an index instead.")
    return matches[0]


def die(msg):
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(1)


def resample_linear(data, rate_multiplier):
    """Speed up/slow down playback by resampling (changes pitch, like a
    turntable speed knob — simplest correct thing for a first pass and fine
    for table-talk speed-ups)."""
    if rate_multiplier == 1.0:
        return data
    n_in = data.shape[0]
    n_out = max(1, int(round(n_in / rate_multiplier)))
    x_old = np.linspace(0.0, 1.0, n_in, endpoint=False)
    x_new = np.linspace(0.0, 1.0, n_out, endpoint=False)
    if data.ndim == 1:
        return np.interp(x_new, x_old, data).astype(np.float32)
    out = np.empty((n_out, data.shape[1]), dtype=np.float32)
    for c in range(data.shape[1]):
        out[:, c] = np.interp(x_new, x_old, data[:, c])
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("wav", nargs="?", help="path to mono WAV file to play")
    ap.add_argument("--device", help="output device name (substring) or index")
    ap.add_argument("--channel", type=int, help="1-based output channel to play into")
    ap.add_argument("--rate", type=float, default=1.0, help="playback speed multiplier (default 1.0)")
    ap.add_argument("--list", action="store_true", help="list output devices and exit")
    ap.add_argument("--head", type=float, default=0, help="play only the first N seconds, with a short fade-out")
    ap.add_argument("--gain", type=float, default=1.0, help="linear output gain (0-1 to attenuate)")
    args = ap.parse_args()

    if args.list:
        list_devices()
        return

    if not args.wav or not args.device or not args.channel:
        ap.error("wav, --device and --channel are required unless --list is given")

    if args.channel < 1:
        die(f"--channel must be 1-based (got {args.channel})")

    idx, dev = resolve_device(args.device)
    max_out = dev["max_output_channels"]
    if max_out == 0:
        die(f"device '{dev['name']}' has no output channels")
    if args.channel > max_out:
        die(
            f"--channel {args.channel} requested but device '{dev['name']}' "
            f"only has {max_out} output channel(s)"
        )

    try:
        data, samplerate = sf.read(args.wav, dtype="float32", always_2d=False)
    except Exception as e:
        die(f"could not read wav file '{args.wav}': {e}")

    if data.ndim > 1:
        print(
            f"warning: '{args.wav}' has {data.shape[1]} channels, "
            f"using channel 0 only (mono expected)",
            file=sys.stderr,
        )
        data = data[:, 0]
    if args.head and args.head > 0:
        n = int(samplerate * args.head)
        if len(data) > n:
            fade = min(n, int(samplerate * 0.4))
            data = data[:n].copy()
            data[-fade:] *= np.linspace(1.0, 0.0, fade, dtype="float32")

    if args.rate <= 0:
        die(f"--rate must be positive (got {args.rate})")
    if args.rate != 1.0:
        data = resample_linear(data, args.rate)
    if args.gain != 1.0:
        data = (data * args.gain).astype("float32")

    # Build the zero matrix: N output channels, one carries the signal.
    n_frames = data.shape[0]
    out = np.zeros((n_frames, max_out), dtype=np.float32)
    out[:, args.channel - 1] = data

    print(
        f"playing '{args.wav}' on device #{idx} '{dev['name']}' "
        f"channel {args.channel}/{max_out} at rate {args.rate}x "
        f"({n_frames / samplerate:.2f}s @ {samplerate}Hz)"
    )

    try:
        sd.play(out, samplerate=samplerate, device=idx)
        sd.wait()
    except Exception as e:
        die(f"playback failed: {e}")


if __name__ == "__main__":
    main()
