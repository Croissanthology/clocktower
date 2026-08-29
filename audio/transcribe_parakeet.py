#!/usr/bin/env python3
"""
transcribe_parakeet.py — live multichannel transcription daemon for a Blood on
the Clocktower table. Alternative implementation of transcribe.py.

Differences from transcribe.py:

  * ASR engine is **Parakeet TDT 0.6B v2** (`mlx-community/parakeet-tdt-0.6b-v2`)
    on Apple-Silicon GPU via MLX, instead of whisper. English only.
  * Activity detection is **Silero-VAD**, not an RMS threshold and not the
    loudest-channel dominance gate. One batched Silero model scores all
    channels on every 32ms frame, so each channel gets a real speech/no-speech
    decision that does not depend on level.
  * Audio is cut on **speech boundaries**, not fixed 5s windows. A channel
    emits one utterance when its speaker stops talking, so Parakeet always
    sees a whole phrase and the daemon never transcribes silence, and no phrase
    is ever split across two windows mid-word.
  * The GPU is driven by **one worker thread with opportunistic batching**.
    MLX serialises Metal work, so extra threads only add contention; instead,
    utterances that finish together are padded to a common length and go
    through the Conformer encoder as one batch.

Crosstalk, and why level has not disappeared entirely
-----------------------------------------------------
Silero is level-invariant by design, which is exactly what makes it a good
speech detector: measured here, a line attenuated to -34dBFS still scores 0.85.
On eight open lavalieres round one table that also means every microphone
"hears" every player, so Silero alone cannot say whose microphone a phrase
belongs to. Level answers that question well, because the player wearing the
lavaliere sits 20-30dB above anyone else's bleed into it.

So the two questions are kept apart:

  * *Is this frame speech?*  Silero, on its own, level-invariant. (--vad-*)
  * *Whose microphone is it?*  The channel must be within --own-margin dB of
    the loudest channel to own the frame. Two people genuinely talking at once
    are both near the top and both own their frames; the channels carrying only
    bleed sit far below and own nothing. Frames a channel does not own are not
    speech *for that channel*, so bleed never becomes an utterance and never
    reaches the GPU. Use --no-arbitrate to switch this off.
  * Anything that still slips through is caught after transcription, by
    dropping near-identical text from a quieter channel that overlaps in time
    (--dedupe-hold).

Each surviving line is POSTed to <server>/api/hear as
{"mic": <1-based channel>, "text": "...", "source": "table"}. Levels go to
<server>/api/miclevels once a second, in the same shape transcribe.py sends.
With --source storyteller the daemon listens on a private device (airpods, a
headset) and the server files every line under the Storyteller instead of the
mic roster.

Examples:
    venv/bin/python transcribe_parakeet.py --list
    venv/bin/python transcribe_parakeet.py --device "MacBook Pro Microphone" --channels 1 --dry-run
    venv/bin/python transcribe_parakeet.py --device "UMC1820" --channels 8 --server http://localhost:4141
"""
import argparse
import difflib
import os
import queue
import sys
import threading
import time
from collections import Counter
from dataclasses import dataclass
from math import gcd

import numpy as np
import sounddevice as sd

try:
    import requests
except ImportError:
    requests = None

VAD_SR = 16000        # both Silero-VAD and Parakeet want 16kHz mono
VAD_FRAME = 512       # Silero's only supported 16kHz frame size (32ms)
MAX_AUTO_CHANNELS = 8    # one per seat; the UMC1820 also reports ADAT/SPDIF inputs
SILENT_CHANNEL_DB = -15.0  # this far under the loudest input means "no usable signal"
OWN_HYSTERESIS_DB = 6.0  # extra slack a channel keeps once it already owns a frame
DEFAULT_MODEL = "mlx-community/parakeet-tdt-0.6b-v2"


def die(msg):
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(1)


# ---------------------------------------------------------------------------
# device selection (same semantics as transcribe.py)
# ---------------------------------------------------------------------------
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


# ---------------------------------------------------------------------------
# streaming resampler
#
# The device runs at its native rate (48kHz on the UMC1820); Silero and
# Parakeet both need 16kHz. Resampling each callback block independently would
# put a filter transient at every block edge, which VAD sees as onsets. So keep
# the tail of the previous block as filter context, resample context+block
# together, then discard the outputs that belong to the context. Output sample
# positions are therefore identical to resampling one infinite stream.
# ---------------------------------------------------------------------------
class StreamResampler:
    def __init__(self, orig_sr, target_sr, n_channels):
        from scipy.signal import resample_poly

        self._resample_poly = resample_poly
        g = gcd(int(orig_sr), int(target_sr))
        self.up = int(target_sr) // g
        self.down = int(orig_sr) // g
        # resample_poly's default FIR spans 10*max(up, down) taps either side of
        # centre in the upsampled domain; convert that to input samples, double
        # it for margin, and round up to a whole number of decimation phases so
        # the output grid never shifts between calls.
        support = -(-(10 * max(self.up, self.down)) // self.up)
        self.ctx = max(self.down, -(-(2 * support) // self.down) * self.down)
        self.n_channels = n_channels
        self.buf = np.zeros((self.ctx, n_channels), dtype=np.float32)
        self.pre = self.ctx      # samples of buf that are left context only

    def __call__(self, block):
        if self.up == 1 and self.down == 1:
            return block.astype(np.float32, copy=False)
        self.buf = np.concatenate([self.buf, block], axis=0)
        # emit only what has a full filter's worth of audio on both sides, in
        # whole decimation phases, so self.pre stays a multiple of self.down
        usable = self.buf.shape[0] - self.pre - self.ctx
        n = (usable // self.down) * self.down
        if n <= 0:
            return np.zeros((0, self.n_channels), dtype=np.float32)
        y = self._resample_poly(self.buf, self.up, self.down, axis=0)
        o0 = self.pre * self.up // self.down
        out = y[o0:o0 + n * self.up // self.down]
        self.pre += n
        if self.pre > self.ctx:
            self.buf = self.buf[self.pre - self.ctx:]
            self.pre = self.ctx
        return out.astype(np.float32, copy=False)


# ---------------------------------------------------------------------------
# per-channel Silero-VAD state machine
#
# Thresholds are on Silero's speech probability, not on level. Hysteresis
# (start at --vad-threshold, keep going down to threshold-0.15) plus a silence
# hangover stops a normal mid-sentence breath from splitting a phrase.
# ---------------------------------------------------------------------------
@dataclass(eq=False)   # identity equality: the audio field is a numpy array
class Utterance:
    channel: int          # 0-based
    audio: np.ndarray     # mono float32 @16kHz
    start_s: float        # seconds since daemon start
    end_s: float
    level: float          # rms of the utterance, for bleed arbitration
    reason: str = "silence"
    text: str = ""
    cut_at: float = 0.0        # wall clock when the VAD closed the phrase
    asr_at: float = 0.0        # wall clock when transcription finished


class ChannelVAD:
    def __init__(self, channel, cfg):
        self.channel = channel
        self.cfg = cfg
        self.triggered = False
        self.start = 0          # absolute 16k sample index of speech onset
        self.silence_from = 0   # absolute index where the current silence run began, 0 = none
        self.last_speech = 0.0  # wall clock, for the /api/miclevels display

    def step(self, prob, owns, frame_start, now):
        """Feed one frame's speech probability and whether this channel owns the
        frame. Returns (a, b, reason) sample range to cut, or None. frame_start
        is the absolute 16k index of the frame."""
        c = self.cfg
        frame_end = frame_start + VAD_FRAME
        if prob >= c.threshold:
            self.last_speech = now
        speech = prob >= c.threshold and owns
        holding = prob >= c.threshold - c.hysteresis and owns

        if not self.triggered:
            if speech:
                self.triggered = True
                self.start = frame_start
                self.silence_from = 0
            return None

        if holding:
            self.silence_from = 0
        elif self.silence_from == 0:
            self.silence_from = frame_end

        # speaker stopped: cut the phrase at the start of the silence run
        if self.silence_from and frame_end - self.silence_from >= c.min_silence:
            self.triggered = False
            return self._cut(self.start, self.silence_from, "silence")

        # someone is monologuing: cut anyway so the table does not wait forever,
        # and stay triggered so the rest of the sentence becomes the next phrase
        if frame_end - self.start >= c.max_speech:
            self.start = frame_end
            self.silence_from = 0
            return self._cut(frame_end - c.max_speech, frame_end, "max-length")

        return None

    def _cut(self, a, b, reason):
        if b - a < self.cfg.min_speech:
            return None
        return (max(0, a - self.cfg.pad), b + self.cfg.pad, reason)


@dataclass
class VADConfig:
    threshold: float = 0.5
    hysteresis: float = 0.15
    min_silence: int = int(0.45 * VAD_SR)
    min_speech: int = int(0.25 * VAD_SR)
    pad: int = int(0.20 * VAD_SR)
    max_speech: int = int(15.0 * VAD_SR)


# ---------------------------------------------------------------------------
# text hygiene
#
# Parakeet TDT does not carry whisper's "thanks for watching" failure mode (no
# autoregressive LM decoding over silence), so this is deliberately much
# lighter than transcribe.py's filter: only degenerate output is dropped.
# ---------------------------------------------------------------------------
def is_junk(text):
    t = text.strip().lower().strip(".,!?").strip()
    if not t:
        return True
    words = t.split()
    if len(words) >= 4 and len(set(words)) == 1:
        return True                      # "you you you you"
    letters = [ch for ch in t if ch.isalpha()]
    # "one glyph repeated" has to be measured as the share of the commonest
    # letter, not as distinct/total: English only has 26 letters, so any real
    # sentence over ~130 letters has under 20% distinct ones and a ratio test
    # silently eats exactly the long arguments this table cares about.
    if len(letters) >= 8 and Counter(letters).most_common(1)[0][1] / len(letters) > 0.6:
        return True
    return False


def text_key(text):
    return "".join(ch for ch in text.lower() if ch.isalnum())


def similar(a, b):
    if not a or not b:
        return False
    if a == b:
        return True
    if len(a) > 12 and (a in b or b in a):
        return True
    return difflib.SequenceMatcher(None, a, b).ratio() >= 0.75


def normalize_peak(x, target_peak=0.9, max_gain=200.0):
    # Parakeet normalises its mel per feature, so at a healthy level this makes
    # no measurable difference — but the mel takes log(x + 1e-5), and a very
    # quiet channel sits close enough to that floor to lose detail. Measured on
    # the eight test lines: neutral at -20 and -40dBFS, and WER 8.3% -> 4.2% at
    # -54dBFS, which is roughly what an ungained lavaliere on the UMC1820 gives.
    peak = float(np.abs(x).max()) if x.size else 0.0
    if peak <= 1e-9:
        return x
    return (x * min(target_peak / peak, max_gain)).astype(np.float32)


# ---------------------------------------------------------------------------
# Parakeet TDT engine: one GPU worker, batched Conformer encoder
# ---------------------------------------------------------------------------
class ParakeetEngine:
    def __init__(self, model_repo, batch_pad_ratio=1.6, max_batch=8):
        import mlx.core as mx
        from parakeet_mlx import from_pretrained
        from parakeet_mlx.alignment import sentences_to_result, tokens_to_sentences
        from parakeet_mlx.audio import get_logmel
        from parakeet_mlx.parakeet import DecodingConfig

        self.mx = mx
        self.get_logmel = get_logmel
        self._tokens_to_sentences = tokens_to_sentences
        self._sentences_to_result = sentences_to_result
        self.decoding_config = DecodingConfig()
        self.model = from_pretrained(model_repo)
        self.batch_pad_ratio = batch_pad_ratio
        self.max_batch = max_batch
        self.batched_ok = True

    def _mel(self, audio):
        return self.get_logmel(
            self.mx.array(normalize_peak(audio)), self.model.preprocessor_config
        )

    def transcribe(self, audios):
        """Transcribe a list of mono 16kHz float32 arrays. Returns list[str]."""
        if not audios:
            return []
        if len(audios) == 1 or not self.batched_ok:
            return [self._one(a) for a in audios]
        try:
            return self._batch(audios)
        except Exception as e:
            print(f"  batched encode failed ({e}); falling back to one at a time",
                  file=sys.stderr)
            self.batched_ok = False
            return [self._one(a) for a in audios]

    def _one(self, audio):
        return self.model.generate(
            self._mel(audio), decoding_config=self.decoding_config
        )[0].text.strip()

    def _batch(self, audios):
        mx = self.mx
        mels = [self._mel(a) for a in audios]           # each [1, T_i, features]
        lengths = [m.shape[1] for m in mels]
        target = max(lengths)
        # Mel is normalised per feature *before* padding, so 0 is that channel's
        # own mean and is the right pad value.
        padded = mx.concatenate(
            [mx.pad(m, ((0, 0), (0, target - m.shape[1]), (0, 0))) for m in mels],
            axis=0,
        )
        # Real lengths must be passed explicitly: the encoder would otherwise
        # assume every item runs the full padded width and the TDT decoder would
        # emit tokens for the padding.
        features, out_lengths = self.model.encoder(
            padded, mx.array(lengths, dtype=mx.int64)
        )
        mx.eval(features, out_lengths)
        hyps, _ = self.model.decode(
            features, out_lengths, config=self.decoding_config
        )
        return [
            self._sentences_to_result(
                self._tokens_to_sentences(h, self.decoding_config.sentence)
            ).text.strip()
            for h in hyps
        ]

    def plan_batches(self, utterances):
        """Group utterances into batches of similar length. Padding is not
        attention-masked in the Conformer, so a short phrase batched next to a
        long one loses accuracy; bucket by length instead of padding blindly."""
        order = sorted(utterances, key=lambda u: len(u.audio))
        batches = []
        cur = []
        for u in order:
            if cur and (
                len(cur) >= self.max_batch
                or len(u.audio) > len(cur[0].audio) * self.batch_pad_ratio
            ):
                batches.append(cur)
                cur = []
            cur.append(u)
        if cur:
            batches.append(cur)
        return batches


# ---------------------------------------------------------------------------
class Daemon:
    def __init__(self, args, dev_idx, dev, n_channels):
        self.args = args
        self.dev_idx = dev_idx
        self.dev = dev
        self.n = n_channels
        self.samplerate = int(dev["default_samplerate"])
        self.stop = threading.Event()

        self.raw_q = queue.Queue()
        self.utt_q = queue.Queue()
        self.pub_q = queue.Queue()

        self.levels = np.zeros(self.n)        # latest block rms, per channel
        self.vad_probs = np.zeros(self.n)     # latest Silero probability
        # Smoothed per-frame level, used only to decide which microphone owns a
        # frame of speech — never whether the frame is speech. ~150ms time
        # constant, so it does not flap between syllables.
        self.frame_level = np.zeros(self.n)
        self.level_alpha = 1.0 - np.exp(-VAD_FRAME / (0.15 * VAD_SR))
        # Ownership is a Schmitt trigger, not a bare threshold. A channel whose
        # bleed sits right at the margin would otherwise flicker in and out of
        # ownership every few frames and chop one phrase into fragments, which
        # measured worse than having no arbitration at all. Gaining ownership
        # needs --own-margin; keeping it is allowed OWN_HYSTERESIS_DB looser.
        self.own_gain = 10.0 ** (-abs(args.own_margin) / 20.0)
        self.own_keep = 10.0 ** (-(abs(args.own_margin) + OWN_HYSTERESIS_DB) / 20.0)
        self.owning = np.ones(self.n, dtype=bool)
        self.vad_cfg = VADConfig(
            threshold=args.vad_threshold,
            min_silence=int(args.min_silence * VAD_SR),
            min_speech=int(args.min_speech * VAD_SR),
            pad=int(args.speech_pad * VAD_SR),
            max_speech=int(args.max_utterance * VAD_SR),
        )
        self.vads = [ChannelVAD(ch, self.vad_cfg) for ch in range(self.n)]

        # 16kHz history for every channel, so an utterance can be cut with
        # pre-roll after its onset is already in the past
        self.hist = np.zeros((0, self.n), dtype=np.float32)
        self.hist_start = 0    # absolute 16k index of hist[0]
        self.consumed = 0      # absolute 16k index of the next unscored frame
        self.keep = int((args.max_utterance + args.speech_pad + 1.0) * VAD_SR)

        # running level accumulator for the one-shot input check
        self.level_sum = np.zeros(self.n)
        self.level_max = np.zeros(self.n)
        self.level_n = 0
        self.checked_inputs = False
        # Phrases held inside a thread rather than in a queue. Shutdown has to
        # wait for these too: a queue-only check calls the pipeline idle while
        # the ASR thread is still mid-batch, and the results are then lost.
        self.inflight_asr = 0
        self.inflight_pub = 0
        self.engine_ready = threading.Event()
        self.engine_error = None
        self.published = []    # recent (key, start_s, end_s, channel) for bleed checks
        self.stats = dict(utterances=0, posted=0, dropped_bleed=0, dropped_junk=0,
                          asr_calls=0, batched=0, asr_time=0.0)

    # -- audio in -----------------------------------------------------------
    def _callback(self, indata, frames, time_info, status):
        if status:
            print(f"stream status: {status}", file=sys.stderr)
        self.raw_q.put(indata.copy())

    # -- VAD thread ---------------------------------------------------------
    def _vad_loop(self):
        import torch
        from silero_vad import load_silero_vad

        torch.set_num_threads(1)
        vad = load_silero_vad(onnx=True)
        vad.reset_states(self.n)
        resampler = StreamResampler(self.samplerate, VAD_SR, self.n)

        while not self.stop.is_set():
            try:
                block = self.raw_q.get(timeout=0.2)
            except queue.Empty:
                continue
            for ch in range(self.n):
                self.levels[ch] = rms(block[:, ch])
            self.level_sum += self.levels
            self.level_max = np.maximum(self.level_max, self.levels)
            self.level_n += 1

            y = resampler(block)
            self.hist = np.concatenate([self.hist, y], axis=0)

            # score every whole 512-frame that has arrived, all channels at once
            while self.hist_start + self.hist.shape[0] - self.consumed >= VAD_FRAME:
                off = self.consumed - self.hist_start
                frame = self.hist[off:off + VAD_FRAME, :]           # (512, n)
                x = torch.from_numpy(np.ascontiguousarray(frame.T))  # (n, 512)
                probs = vad(x, VAD_SR).numpy().reshape(-1)
                now = time.time()
                owns = self._arbitrate(frame)
                for ch in range(self.n):
                    self.vad_probs[ch] = probs[ch]
                    cut = self.vads[ch].step(probs[ch], owns[ch], self.consumed, now)
                    if cut:
                        self._emit(ch, *cut)
                self.consumed += VAD_FRAME

            self._trim()

    def _arbitrate(self, frame):
        """Decide which microphones own this frame.

        Silero is level-invariant by design, which is what makes it a good
        speech detector — but it also means lavaliere bleed at -25dB scores the
        same as the speaker who is actually talking, so all eight channels
        "hear" everyone and would each produce a transcript of the whole table.
        Level cannot answer "is this speech" but it does answer "whose
        microphone is this": the player wearing the lavaliere is 20-30dB above
        everyone else's bleed into it. So a channel owns the frame while it is
        within --own-margin dB of the loudest channel. Two people genuinely
        talking at once are both near the top and both own their frames; the six
        channels carrying only bleed are far below and own nothing.
        """
        lvl = np.sqrt(np.mean(np.square(frame, dtype=np.float64), axis=0))
        self.frame_level += self.level_alpha * (lvl - self.frame_level)
        if not self.args.arbitrate or self.n == 1:
            return np.ones(self.n, dtype=bool)
        loudest = self.frame_level.max()
        if loudest <= 0:
            return np.ones(self.n, dtype=bool)
        self.owning = np.where(
            self.owning,
            self.frame_level >= loudest * self.own_keep,
            self.frame_level >= loudest * self.own_gain,
        )
        return self.owning

    def _emit(self, ch, a, b, reason):
        a = max(a, self.hist_start)
        b = min(b, self.hist_start + self.hist.shape[0])
        if b - a < self.vad_cfg.min_speech:
            return
        window = self.hist[a - self.hist_start:b - self.hist_start, :]
        audio = window[:, ch].copy()
        # Measured isolation over this phrase: how far the owning channel sits
        # above the loudest other channel. This is the number --own-margin has
        # to stay comfortably below, so it is logged rather than guessed at.
        iso_db = None
        if self.n > 1:
            lv = np.sqrt(np.mean(np.square(window, dtype=np.float64), axis=0))
            others = np.delete(lv, ch).max()
            if others > 0 and lv[ch] > 0:
                iso_db = 20.0 * np.log10(lv[ch] / others)
        u = Utterance(
            channel=ch,
            audio=audio,
            start_s=a / VAD_SR,
            end_s=b / VAD_SR,
            level=rms(audio),
            reason=reason,
            cut_at=time.time(),
        )
        self.stats["utterances"] += 1
        iso = f" iso={iso_db:+5.1f}dB" if iso_db is not None else ""
        print(f"vad ch{ch + 1}: {u.start_s:7.2f}s +{u.end_s - u.start_s:5.2f}s "
              f"rms={u.level:.4f}{iso} ({reason})")
        self.utt_q.put(u)

    def _trim(self):
        """Drop history nothing can still need: the oldest in-progress onset,
        or self.keep samples, whichever is further back."""
        floor = self.consumed - self.keep
        for v in self.vads:
            if v.triggered:
                floor = min(floor, v.start - self.vad_cfg.pad)
        floor = max(0, floor)
        if floor > self.hist_start:
            self.hist = self.hist[floor - self.hist_start:]
            self.hist_start = floor

    # -- ASR thread ---------------------------------------------------------
    def _asr_loop(self, engine=None):
        # MLX streams are thread-local: an array evaluated on a stream created
        # in another thread raises "There is no Stream(cpu, N) in current
        # thread". So the model is built, warmed and used entirely in here, and
        # this is the only thread that touches MLX.
        if engine is None:
            try:
                t0 = time.time()
                engine = ParakeetEngine(self.args.model, self.args.batch_pad_ratio,
                                        self.args.max_batch)
                print(f"loaded in {time.time() - t0:.2f}s; warming...")
                t0 = time.time()
                engine.transcribe([np.zeros(VAD_SR, dtype=np.float32)])
                print(f"model warm in {time.time() - t0:.2f}s")
            except Exception as e:
                self.engine_error = e
                self.engine_ready.set()
                return
        self.engine_ready.set()

        while not self.stop.is_set():
            try:
                first = self.utt_q.get(timeout=0.2)
            except queue.Empty:
                continue
            pending = [first]
            self.inflight_asr = len(pending)
            # Every channel's VAD runs off the same frame tick, so utterances
            # that belong to the same moment of table talk land together. A
            # short grace period collects them into one encoder batch.
            deadline = time.time() + self.args.batch_wait
            while len(pending) < self.args.max_batch:
                remaining = deadline - time.time()
                if remaining <= 0:
                    break
                try:
                    pending.append(self.utt_q.get(timeout=remaining))
                    self.inflight_asr = len(pending)
                except queue.Empty:
                    break

            try:
                self._run_batches(engine, pending)
            finally:
                self.inflight_asr = 0

    def _run_batches(self, engine, pending):
        for batch in engine.plan_batches(pending):
            t_asr = time.time()
            try:
                texts = engine.transcribe([u.audio for u in batch])
            except Exception as e:
                print(f"  asr error: {e}", file=sys.stderr)
                continue
            dt = time.time() - t_asr
            self.stats["asr_calls"] += 1
            self.stats["asr_time"] += dt
            if len(batch) > 1:
                self.stats["batched"] += 1
            audio_s = sum(len(u.audio) for u in batch) / VAD_SR
            chans = ",".join(f"ch{u.channel + 1}" for u in batch)
            print(f"asr [{chans}] {audio_s:.1f}s audio in {dt:.2f}s "
                  f"({audio_s / max(dt, 1e-6):.0f}x realtime, batch={len(batch)})")
            done = time.time()
            for u, text in zip(batch, texts):
                u.text = text
                u.asr_at = done
                self.pub_q.put(u)

    # -- publisher thread ---------------------------------------------------
    def _publish_loop(self):
        """Hold each result briefly, then publish the loudest of any set of
        near-identical overlapping phrases. This is where lavaliere crosstalk is
        removed: Silero cannot tell a speaker from their bleed into the seven
        other microphones, but only one channel has the phrase at full level."""
        hold = []
        while not self.stop.is_set():
            timeout = 0.05 if hold else 0.2
            try:
                hold.append(self.pub_q.get(timeout=timeout))
                self.inflight_pub = len(hold)
            except queue.Empty:
                pass
            now = time.time()
            ripe = [u for u in hold if now - u.asr_at >= self.args.dedupe_hold]
            if not ripe:
                continue
            hold = [u for u in hold if u not in ripe]
            self.inflight_pub = len(hold)
            for u in sorted(ripe, key=lambda u: -u.level):
                self._publish(u)

    def _publish(self, u):
        if is_junk(u.text):
            self.stats["dropped_junk"] += 1
            print(f"  ch{u.channel + 1}: [junk] '{u.text}'")
            return
        key = text_key(u.text)
        cutoff = u.start_s - 2.0
        self.published = [p for p in self.published if p[2] >= cutoff]
        for pkey, pstart, pend, pch in self.published:
            overlaps = u.start_s < pend and pstart < u.end_s
            if pch != u.channel and overlaps and similar(key, pkey):
                self.stats["dropped_bleed"] += 1
                print(f"  ch{u.channel + 1}: [bleed of ch{pch + 1}] '{u.text[:60]}'")
                return
        self.published.append((key, u.start_s, u.end_s, u.channel))
        preview = u.text if len(u.text) <= 90 else u.text[:87] + "..."
        latency = time.time() - u.cut_at
        print(f'  ch{u.channel + 1}: "{preview}"  (+{latency:.2f}s after speech end)')
        self._post(u.channel + 1, u.text)
        self.stats["posted"] += 1

    def _post(self, mic, text):
        payload = {"mic": mic, "text": text, "source": self.args.source}
        if self.args.dry_run or requests is None:
            print(f"  [dry-run] would POST {self.args.server}/api/hear  {payload}")
            return
        try:
            requests.post(f"{self.args.server}/api/hear", json=payload, timeout=2)
        except requests.exceptions.RequestException as e:
            print(f"  [server unreachable: {e}] {payload}")

    # -- levels thread ------------------------------------------------------
    def _check_inputs(self):
        """Report what each input is actually hearing, once, a few seconds in.

        A microphone with its preamp gain down sits at the noise floor, roughly
        -70dBFS on the UMC1820. Every phrase then goes to whichever channel does
        have gain, which looks like the daemon ignoring seven of eight mics.
        Printing the levels once makes that obvious instead of mysterious."""
        self.checked_inputs = True
        if self.level_n == 0:
            return
        mean = self.level_sum / self.level_n
        db = lambda x: 20.0 * np.log10(x + 1e-12)
        loudest = mean.max()
        print(f"input check after {self.level_n} blocks "
              f"(mean / peak dBFS per channel):")
        dead = []
        for ch in range(self.n):
            gap = db(mean[ch]) - db(loudest)
            flag = ""
            if self.n > 1 and gap <= SILENT_CHANNEL_DB:
                flag = f"  <-- {abs(gap):.0f}dB under ch{int(np.argmax(mean)) + 1}, no usable signal"
                dead.append(ch + 1)
            print(f"  ch{ch + 1}: {db(mean[ch]):6.1f} / {db(self.level_max[ch]):6.1f} dBFS{flag}")
        if dead:
            print(f"  {len(dead)} of {self.n} inputs look dead: ch{','.join(map(str, dead))}. "
                  f"Raise their preamp gain, or every phrase will be attributed to "
                  f"ch{int(np.argmax(mean)) + 1}.")

    def _levels_loop(self):
        ticks = 0
        while not self.stop.wait(1.0):
            ticks += 1
            if ticks >= 5 and not self.checked_inputs:
                self._check_inputs()
            if requests is None:
                continue
            now = time.time()
            try:
                requests.post(
                    f"{self.args.server}/api/miclevels",
                    json={
                        "device": self.dev["name"],
                        "channels": self.n,
                        "levels": [round(float(x), 4) for x in self.levels],
                        "speech_ago": [
                            round(now - v.last_speech, 1) if v.last_speech else None
                            for v in self.vads
                        ],
                        "vad": [round(float(p), 3) for p in self.vad_probs],
                        "source": self.args.source,
                    },
                    timeout=1,
                )
            except requests.exceptions.RequestException:
                pass

    # -- audio sources ------------------------------------------------------
    def _listen(self):
        print(f"listening on '{self.dev['name']}' ({self.n} channel(s))... Ctrl-C to stop")
        run_start = time.time()
        try:
            with sd.InputStream(
                device=self.dev_idx,
                channels=self.n,
                samplerate=self.samplerate,
                dtype="float32",
                callback=self._callback,
                blocksize=int(self.samplerate * 0.25),
            ):
                while True:
                    if self.args.duration is not None and \
                            time.time() - run_start >= self.args.duration:
                        print(f"reached --duration {self.args.duration}s, stopping")
                        break
                    time.sleep(0.2)
        except KeyboardInterrupt:
            raise
        except Exception as e:
            die(f"audio stream failed: {e}")

    def _replay_wav(self):
        """Feed a multichannel WAV through the real pipeline instead of the
        sound card, for tuning thresholds and for regression tests. --speed 0
        replays as fast as the pipeline drains."""
        import soundfile as sf

        data, sr = sf.read(self.args.from_wav, dtype="float32", always_2d=True)
        if sr != self.samplerate:
            print(f"note: '{self.args.from_wav}' is {sr}Hz; resampling to the "
                  f"device rate {self.samplerate}Hz")
            data = StreamResampler(sr, self.samplerate, data.shape[1])(data)
        if data.shape[1] < self.n:
            die(f"'{self.args.from_wav}' has {data.shape[1]} channel(s), need {self.n}")
        data = data[:, :self.n]
        block = int(self.samplerate * 0.25)
        print(f"replaying '{self.args.from_wav}': {data.shape[0] / self.samplerate:.1f}s "
              f"x {self.n} channel(s) at {self.args.speed or 'max'} speed")
        for i in range(0, data.shape[0], block):
            self.raw_q.put(data[i:i + block].copy())
            if self.args.speed:
                # keep the queue shallow so the VAD thread stays in step
                while self.raw_q.qsize() > 4:
                    time.sleep(0.01)
                time.sleep(block / self.samplerate / self.args.speed)
            else:
                while self.raw_q.qsize() > 8:
                    time.sleep(0.005)

    def _idle(self):
        """True when no phrase is anywhere in the pipeline."""
        return (
            self.raw_q.empty()
            and self.utt_q.empty()
            and self.pub_q.empty()
            and self.inflight_asr == 0
            and self.inflight_pub == 0
        )

    # -- run ----------------------------------------------------------------
    def run(self, engine=None):
        # the ASR thread owns the model, so start it first and let it finish
        # loading before any audio is captured
        asr = threading.Thread(target=self._asr_loop, args=(engine,), daemon=True)
        asr.start()
        if not self.engine_ready.wait(timeout=900):
            die("model load timed out")
        if self.engine_error is not None:
            die(f"could not load {self.args.model}: {self.engine_error}")

        threads = [
            asr,
            threading.Thread(target=self._vad_loop, daemon=True),
            threading.Thread(target=self._publish_loop, daemon=True),
            threading.Thread(target=self._levels_loop, daemon=True),
        ]
        for t in threads[1:]:
            t.start()

        try:
            if self.args.from_wav:
                self._replay_wav()
            else:
                self._listen()
        except KeyboardInterrupt:
            print("\nstopping (Ctrl-C)")
        finally:
            # Let anything already captured finish its way through the
            # pipeline. This exits as soon as everything is idle, so a live
            # Ctrl-C with nothing pending returns at once. Idle has to hold for
            # a few consecutive samples: a phrase in transit between a queue and
            # a thread's own list is briefly invisible to both counters.
            deadline = time.time() + 30.0
            idle = 0
            while time.time() < deadline and idle < 3:
                idle = idle + 1 if self._idle() else 0
                time.sleep(0.1)
            self.stop.set()
            for t in threads:
                t.join(timeout=2.0)
            s = self.stats
            print(f"\nutterances={s['utterances']} posted={s['posted']} "
                  f"bleed={s['dropped_bleed']} junk={s['dropped_junk']} "
                  f"asr_calls={s['asr_calls']} (batched {s['batched']}) "
                  f"asr_time={s['asr_time']:.1f}s")


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--device", help="input device name (substring) or index")
    ap.add_argument("--channels", type=int, default=None,
                    help="channel count (clamped to device max). Default: every input "
                         f"the device reports, capped at {MAX_AUTO_CHANNELS}")
    ap.add_argument("--server", default="http://localhost:4141", help="game server base URL")
    ap.add_argument("--source", default="table",
                    help="who this daemon listens to: 'table' (the mic roster) or "
                         "'storyteller' (a private device, e.g. airpods)")
    ap.add_argument("--model", default=os.environ.get("CT_PARAKEET_MODEL", DEFAULT_MODEL),
                    help="parakeet MLX repo (default: %(default)s)")
    ap.add_argument("--vad-threshold", type=float, default=0.5,
                    help="Silero speech probability to start a phrase, 0..1 (default 0.5)")
    ap.add_argument("--min-silence", type=float, default=0.45,
                    help="seconds of non-speech that end a phrase (default 0.45)")
    ap.add_argument("--min-speech", type=float, default=0.25,
                    help="drop phrases shorter than this many seconds (default 0.25)")
    ap.add_argument("--speech-pad", type=float, default=0.20,
                    help="seconds of audio kept either side of a phrase (default 0.20)")
    ap.add_argument("--max-utterance", type=float, default=15.0,
                    help="force a cut in continuous speech after this long (default 15)")
    ap.add_argument("--batch-wait", type=float, default=0.05,
                    help="seconds to collect co-occurring phrases into one GPU batch")
    ap.add_argument("--max-batch", type=int, default=8, help="largest encoder batch")
    ap.add_argument("--batch-pad-ratio", type=float, default=1.6,
                    help="longest/shortest length allowed in one batch (default 1.6)")
    ap.add_argument("--own-margin", type=float, default=9.0,
                    help="dB below the loudest channel a channel may still be and own a "
                         "frame of speech. This is microphone attribution, not activity "
                         "detection: Silero decides whether a frame is speech, this "
                         "decides whose lavaliere it is (default 9)")
    ap.add_argument("--no-arbitrate", dest="arbitrate", action="store_false",
                    help="disable microphone attribution; every channel Silero hears "
                         "speech on produces its own transcript, and duplicates are only "
                         "removed afterwards by text comparison")
    ap.add_argument("--dedupe-hold", type=float, default=0.35,
                    help="seconds to hold a line while checking louder channels for "
                         "the same phrase (crosstalk removal; 0 = off)")
    ap.add_argument("--from-wav", help="replay a multichannel WAV through the pipeline "
                    "instead of opening the sound card (offline testing)")
    ap.add_argument("--speed", type=float, default=1.0,
                    help="--from-wav replay speed; 0 = as fast as the pipeline drains")
    ap.add_argument("--dry-run", action="store_true", help="never POST, just print")
    ap.add_argument("--duration", type=float, default=None,
                    help="stop after this many seconds (default: run forever)")
    ap.add_argument("--list", action="store_true", help="list input devices and exit")
    args = ap.parse_args()

    if args.list:
        list_devices()
        return
    if not args.device and not args.from_wav:
        ap.error("--device is required unless --list or --from-wav is given")

    if args.device:
        dev_idx, dev = resolve_input_device(args.device)
    else:
        # --from-wav with no --device: the file itself is the "device"
        import soundfile as sf

        info = sf.info(args.from_wav)
        dev_idx, dev = -1, {"name": f"file:{os.path.basename(args.from_wav)}",
                            "max_input_channels": info.channels,
                            "default_samplerate": float(info.samplerate)}
        if args.channels is None:
            args.channels = info.channels
    max_in = dev["max_input_channels"]
    if args.channels is None:
        # Defaulting to one channel on an eight-microphone interface silently
        # posts every phrase as mic 1, which looks exactly like a transcription
        # bug. Take what the device offers instead.
        args.channels = min(max_in, MAX_AUTO_CHANNELS)
        print(f"note: --channels not given; using {args.channels} of "
              f"{max_in} input(s) on '{dev['name']}'")
    n = args.channels
    if n > max_in:
        print(f"warning: requested {n} channels but device '{dev['name']}' only "
              f"supports {max_in}; clamping to {max_in}", file=sys.stderr)
        n = max_in
    if n < 1:
        die(f"device '{dev['name']}' reports 0 input channels")

    print(f"engine=parakeet-tdt-mlx model={args.model}  device=#{dev_idx} "
          f"'{dev['name']}'  channels={n}  rate={int(dev['default_samplerate'])}Hz  "
          f"vad=silero(threshold={args.vad_threshold}, min_silence={args.min_silence}s)  "
          f"arbitration={('%.0fdB' % args.own_margin) if args.arbitrate else 'off'}  "
          f"server={args.server}  dry_run={args.dry_run}")

    print("loading parakeet...")
    Daemon(args, dev_idx, dev, n).run()


if __name__ == "__main__":
    main()
