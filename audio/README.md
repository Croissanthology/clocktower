# audio/ — Blood on the Clocktower table audio pipeline

Two scripts:

- **play_channel.py** — plays a mono WAV into exactly one output channel of a
  device, silence elsewhere. Used to send each in-fiction voice line to the
  physical seat/speaker for that player.
- **transcribe.py** — live daemon that listens on N input channels
  (one mic per player, eventually), skips silent channels, transcribes
  active ones in parallel with whisper, and POSTs each line to the game
  server's `/api/hear` endpoint as `{"mic": <1-based channel>, "text": "..."}`.

Everything below is testable today on the MacBook's built-in mic (1 channel)
and speakers (2 channels). Nothing changes in the code when the Behringer
UMC1820 (8 in / 10 out) arrives — channel counts are read from the device at
runtime and clamped/zero-padded accordingly.

## Setup

```bash
cd /Users/margot/code/clocktower/audio
python3.12 -m venv venv
venv/bin/pip install -q sounddevice soundfile numpy requests scipy mlx-whisper
```

Engine: **mlx-whisper** (Apple-Silicon GPU via Metal — confirmed running on
`Device(gpu, 0)` on this machine). `transcribe.py` falls back to
`faster-whisper` automatically if `mlx_whisper` isn't importable (e.g. if
this ever runs on non-Apple-Silicon hardware); install it with
`venv/bin/pip install faster-whisper` in that case. The faster-whisper path
is implemented but not exercised in testing on this machine, since mlx
installed and ran cleanly.

Model: multilingual **small** (`mlx-community/whisper-small-mlx`, ~500MB,
downloaded once to `~/.cache/huggingface` on first run — not vendored into
the repo). Multilingual because table speech may be French or English.
Other sizes available via `--model {tiny,base,small,medium,large-v3}` on
`transcribe.py` — bigger = more accurate, slower; `tiny`/`base` if latency
ever becomes a problem with many simultaneous mics on real hardware.

## play_channel.py

List output devices:

```bash
venv/bin/python play_channel.py --list
```

```
 idx  out_ch  in_ch  name
   1       2      0  MacBook Air Speakers
```

Play into channel 1 (of 2) at normal speed:

```bash
venv/bin/python play_channel.py --device "MacBook Air Speakers" --channel 1 \
  ../voices/samples/alba.wav
```

Play into channel 2, 10% faster:

```bash
venv/bin/python play_channel.py --device "MacBook Air Speakers" --channel 2 --rate 1.1 \
  ../voices/samples/cori.wav
```

`--device` matches by index or by case-insensitive substring of the device
name. Bad channel / bad device both exit non-zero with a clear message,
e.g. `--channel 3` on a 2-channel device: `error: --channel 3 requested but
device 'MacBook Air Speakers' only has 2 output channel(s)`.

**On the UMC1820** (device name will contain `UMC1820` or `U-Phoria` once
plugged in): same commands, just point `--device` at it and use channels
1-10, e.g.:

```bash
venv/bin/python play_channel.py --list   # confirm it shows 10 out_ch
venv/bin/python play_channel.py --device "UMC1820" --channel 5 line.wav
```

No code changes needed — the zero matrix is sized from
`sd.query_devices()[idx]['max_output_channels']` at runtime.

### Verification performed (no UMC1820 yet, so verified two ways)

1. Real playback through the built-in speakers on channel 1 and channel 2
   independently (both exited 0, audible per device is not something this
   agent can hear, so also verified mechanically — see next point).
2. Programmatic channel-isolation check: built the same zero-matrix the
   script builds, confirmed channel 1 carries the real signal (RMS ≈ 0.12)
   and channel 2 is exactly silent (RMS = 0.0). Also confirmed
   `--rate 1.1` resamples frame count correctly (69632 → 63302 frames,
   expected ≈63301).

## transcribe.py

List input devices:

```bash
venv/bin/python transcribe.py --list
```

```
 idx  in_ch     rate  name
   0      1    48000  MacBook Air Microphone
```

**Loopback self-test today** (built-in mic, dry-run so nothing hits the
real game server):

```bash
venv/bin/python transcribe.py --device "MacBook Air Microphone" --channels 1 \
  --server http://localhost:9 --dry-run --duration 20 --threshold 0.01
```

`--duration 20` stops the daemon after 20s (handy for tests; omit it to run
forever). `--server http://localhost:9` points at a closed port so a real
game server on 4141 is never spammed during testing — swap in
`http://localhost:4141` for real use, or use `--dry-run` to never POST at
all regardless of `--server`.

To hear it pick up speech, play one of the character voice samples out loud
in another terminal while it's listening:

```bash
afplay ../voices/samples/obadiah.wav
```

**Mic permission (macOS):** the *first* time any process opens the input
stream, macOS needs to have already granted Microphone access to the
responsible app (Terminal.app, iTerm, Ghostty, etc. — whatever is hosting
the shell). If it's not yet granted, `sounddevice`'s stream-open call
**blocks silently forever** rather than erroring or timing out — no
exception, no crash, just a hang. There's no way to grant this
programmatically (no sudo/tccutil write access to TCC.db by design). Fix:
System Settings → Privacy & Security → Microphone → enable it for your
terminal app, then re-run. Once granted it's remembered for that app going
forward.

**On the UMC1820**: same command, larger channel count, request whatever
you actually want to listen on (clamped automatically if it exceeds what
the device reports):

```bash
venv/bin/python transcribe.py --device "UMC1820" --channels 8 \
  --server http://localhost:4141 --lang auto
```

### Tuning `--threshold`

`--threshold` is compared against each channel's RMS (root-mean-square)
level per chunk, computed on float32 samples in [-1, 1]. Default `0.02`.
Measured on the built-in mic in a quiet-ish room: silence/room-tone sits
around 0.0005–0.001 RMS, normal speaking voice at ~30cm sits around
0.03–0.06 RMS. `0.01–0.02` cleanly separates the two on this hardware.
Once the UMC1820 is in and gain-staged, re-check with a few seconds of
`--threshold 0` (transcribes everything) and read the printed `rms=`
values per channel to pick a real threshold — mic preamp gain will change
these numbers a lot.

### Choosing whisper model size

```bash
venv/bin/python transcribe.py --device "..." --channels 8 --model tiny   # fastest, least accurate
venv/bin/python transcribe.py --device "..." --channels 8 --model small  # default
venv/bin/python transcribe.py --device "..." --channels 8 --model medium # slower, more accurate
```

### Measured latency (this machine, MacBook Air, mlx-whisper small, warm model)

Model warm-up (first inference after model load, pays for JIT/graph setup):
**~1.5–1.9s**, paid once at daemon startup (the daemon explicitly warms the
model before opening the audio stream so the first real chunk isn't slow).

Per-chunk transcription latency, 5s of audio, one active channel, warm
model, measured three separate ways (offline file-based harness and two
live-mic runs):

| run | latency |
|---|---|
| offline harness (obadiah.wav, 5s padded) | 0.45s |
| live mic, chunk 1 | 0.56–0.66s |
| live mic, chunk 2 | 0.42–0.68s |
| live mic, chunk 3 | 0.46s |

So **~0.4–0.7s to transcribe a 5s chunk** on this hardware — well within
real-time (chunk arrives every 5s, processing takes under 1s), leaving
plenty of headroom for 8 simultaneous channels once the UMC1820 arrives,
though 8 channels transcribing in parallel will contend for the same
GPU/Metal queue (mlx-whisper doesn't truly parallelize compute across
threads — the thread pool overlaps Python/IO overhead, not GPU time — so
expect per-chunk latency to grow with the number of simultaneously-active
mics; re-measure once the interface is in).

### What was actually verified live

- Live mic capture → 5s chunking → RMS-based silence skip → mlx-whisper
  transcription → hallucination filter → dry-run POST print, running
  end-to-end for 20s against the built-in mic, picking up real ambient
  speech in the room correctly.
- Silence-skip logic verified both live (silent stretches produce
  `chunk N: no active channels` with no wasted transcription call) and
  offline (synthetic 2-channel buffer: real speech on channel 1 correctly
  flagged active at RMS 0.136, injected room-tone noise on channel 2
  correctly skipped at RMS 0.0005).
- Hallucination filter unit-checked against `"thank you."`,
  `"you you you you"`, empty string, whitespace-only, and an Amara.org
  subtitle-credit string (all correctly filtered), against a real
  transcribed sentence (correctly passed through).
- Server-down fallback verified: POSTing to a closed port prints
  `[server unreachable: ...] {...}` and the daemon keeps running rather
  than crashing.
- `/api/hear` payload shape (`{"mic": <int>, "text": <str>}`) confirmed
  against `server.js`'s actual handler (line ~339).

### Caveats

- **Mic permission dialog / hang**: see above — this is a one-time,
  interactive, un-automatable step on a fresh machine or fresh terminal
  app. If `transcribe.py` (or even a bare `sounddevice.rec()` call) seems
  to hang with no output and no error, this is almost certainly why.
- **mlx-whisper model download**: first run of a given `--model` size
  downloads it from Hugging Face Hub (small ≈ 500MB) and can take tens of
  seconds; subsequent runs are instant (cached in `~/.cache/huggingface`).
  Consider running `transcribe.py --dry-run --duration 1` once per model
  size ahead of the live game to pre-warm the cache.
- **GPU is shared, not parallel**: the "thread pool" parallelizes
  Python-level orchestration across channels, but mlx's Metal compute
  queue serializes actual matrix math. With 8 real mics all talking at
  once, expect chunk latency to be additive-ish rather than flat — budget
  for it once the UMC1820 lets us test real multi-channel load.
- **Resampling**: `play_channel.py --rate` is a naive linear-interpolation
  speed change (pitch shifts with speed, like a turntable) — good enough
  for nudging table-read pacing, not a time-stretch algorithm.
  `transcribe.py` always resamples device-native audio (e.g. 48kHz) down
  to whisper's required 16kHz using `scipy.signal.resample_poly`
  (anti-aliased), independent of `play_channel.py`'s simpler method.
