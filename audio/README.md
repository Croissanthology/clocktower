# audio/ — Blood on the Clocktower table audio pipeline

Three scripts:

- **play_channel.py** — plays a mono WAV into exactly one output channel of a
  device, silence elsewhere. Used to send each in-fiction voice line to the
  physical seat/speaker for that player.
- **transcribe.py** — live daemon that listens on N input channels
  (one mic per player, eventually), skips silent channels, transcribes
  active ones in parallel with whisper, and POSTs each line to the game
  server's `/api/hear` endpoint as `{"mic": <1-based channel>, "text": "..."}`.
- **transcribe_parakeet.py** — alternative transcription daemon. It uses
  Parakeet TDT 0.6B v2 in place of whisper, and Silero-VAD in place of the RMS
  threshold. It cuts audio on speech boundaries instead of fixed 5s windows.
  It posts to the same `/api/hear` endpoint. English only. See
  "transcribe_parakeet.py" below.

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

## transcribe_parakeet.py

An alternative to `transcribe.py`. It answers the same problem with a
different engine, a different activity detector, and a different way to cut
the audio.

| | `transcribe.py` | `transcribe_parakeet.py` |
|---|---|---|
| ASR model | whisper small (mlx-whisper) | Parakeet TDT 0.6B v2 (parakeet-mlx) |
| languages | multilingual | English only |
| activity detection | RMS threshold + loudest-channel dominance | Silero-VAD, per 32ms frame |
| audio windows | fixed 5s chunks | speech boundaries, variable length |
| GPU use | one thread per active channel | one thread, batched encoder |

### Setup

```bash
venv/bin/pip install -q parakeet-mlx silero-vad onnxruntime
```

`parakeet-mlx` pulls the MLX Parakeet implementation. `silero-vad` ships the
VAD weights in the package, so the VAD needs no download. `onnxruntime` runs
the VAD on the CPU.

The first run downloads `mlx-community/parakeet-tdt-0.6b-v2` from Hugging Face
into `~/.cache/huggingface`. The download is 2.47GB and is slow on a poor
connection. Run the daemon once before a game to fill the cache:

```bash
venv/bin/python transcribe_parakeet.py --device "UMC1820" --dry-run --duration 1
```

`from_pretrained` casts the weights to bfloat16 at load time, so the model
occupies about 1.2GB of memory and not 2.47GB.

### Use

```bash
venv/bin/python transcribe_parakeet.py --list
venv/bin/python transcribe_parakeet.py --device "UMC1820" --server http://localhost:4141
```

`--channels` is optional. It defaults to every input the device reports, capped
at 8, and the daemon prints which count it chose. Do not leave it at 1 on the
UMC1820: one channel posts every phrase as `mic 1`, which reads as a
transcription bug rather than a missing flag.

The daemon prints one `vad` line for each phrase it cuts, one `asr` line for
each GPU batch, and one indented line for each transcript. A dropped line
shows the reason. `--dry-run` prints the POST instead of sending it.

### The input check

Five seconds after it starts listening, the daemon prints the mean and peak
level of every input, and names any input that sits more than 15dB under the
loudest one:

```
input check after 19 blocks (mean / peak dBFS per channel):
  ch1:  -68.5 /  -60.1 dBFS  <-- 18dB under ch7, no usable signal
  ...
  ch7:  -50.2 /  -41.8 dBFS
  7 of 8 inputs look dead: ch1,2,3,4,5,6,8. Raise their preamp gain, or every
  phrase will be attributed to ch7.
```

Read this line before every game. A microphone whose preamp gain is down sits
at the interface noise floor, about -70dBFS on the UMC1820. Silero-VAD does
not use level, so it still hears the room on that channel, but the channel can
never win attribution. Every phrase then goes to whichever input does have
gain, and the transcript looks correct while the speaker is always wrong.
Aim for -20 to -10dBFS mean on normal speech, on every channel.

### How the pipeline works

Four threads and three queues:

1. The CoreAudio callback copies each input block into a queue.
2. The VAD thread resamples the block to 16kHz, then scores every 32ms frame.
   One Silero model scores all eight channels in a single batched call. A
   per-channel state machine turns the probabilities into phrases.
3. The ASR thread takes the phrases. It groups phrases of similar length and
   runs them through the Conformer encoder as one batch.
4. The publisher thread removes crosstalk and posts the survivors.

The resampler keeps filter context on both sides of each block. Its output is
therefore bit-identical to resampling one continuous stream, which matters
because a filter transient at each block edge looks like a speech onset to the
VAD. The cost is 1.25ms of added lookahead at 48kHz.

Only the ASR thread touches MLX. MLX streams are thread-local, so a model that
is built in one thread and called from another raises
`There is no Stream(cpu, N) in current thread`. The thread therefore builds,
warms and uses the model itself.

### Crosstalk, and where level is still used

Silero-VAD does not use level, which is what makes it a good speech detector.
Measured here, one of the voice samples attenuated to -34dBFS still scores
0.85. On eight open lavalieres around one table this also means every
microphone hears every player. Silero alone cannot say whose microphone a
phrase belongs to.

`transcribe_parakeet.py` therefore keeps two questions apart:

- **Is this frame speech?** Silero decides, on its own, without level.
- **Whose microphone is it?** A channel owns a frame while its smoothed level
  is within `--own-margin` dB of the loudest channel. The player who wears the
  lavaliere sits far above anyone else's bleed into it. Two players who really
  talk at the same time are both near the top, so both own their frames.
  Channels that carry only bleed own nothing, so bleed never becomes a phrase
  and never reaches the GPU.
- **Anything that still gets through** is removed after transcription. The
  publisher holds each line for `--dedupe-hold` seconds, then drops
  near-identical text from a quieter channel that overlaps in time.

Ownership is a Schmitt trigger. A channel needs `--own-margin` to gain
ownership, and keeps it until it falls 6dB further. Without this, a channel
whose bleed sits at the margin flickers in and out of ownership and chops one
phrase into fragments. Fragments transcribe differently from the full phrase,
so they also escape the text comparison. Measured on the -12dB fixture below,
the hysteresis moved word error rate from 57.3% to 34.4%.

### Setting `--own-margin`

Each `vad` line reports the measured isolation of that phrase: how far the
owning channel sat above the loudest other channel.

```
vad ch1:    0.82s + 4.02s rms=0.1174 iso=+25.0dB (silence)
```

Set `--own-margin` well below the `iso` figure your rig reports. A margin
within about 6dB of the real bleed level is the one setting to avoid.
Measured word error rate against three synthetic fixtures, each 8 channels
and 8 known lines, differing only in bleed level:

| `--own-margin` | 25dB isolation | 12dB isolation | 6dB isolation |
|---|---|---|---|
| 3dB | 4.2% | 4.2% | 35.4% |
| 6dB | 4.2% | 4.2% | 8.3% |
| **9dB (default)** | **4.2%** | 34.4% | 8.3% |
| 12dB | 4.2% | 20.8% | 8.3% |
| 20dB | 99.0% | 20.8% | 19.8% |
| `--no-arbitrate` | 20.8% | 20.8% | 19.8% |

The default 9dB suits lavalieres, which normally give 20 to 30dB of
isolation. An `iso` figure near 0dB means either that two people talk at
once, or that nobody wears a microphone and all eight inputs hear the same
room. In the second case arbitration cannot help, and the text comparison
does all the work.

### Tuning the VAD

- `--vad-threshold` (0.5) — speech probability that starts a phrase.
- `--min-silence` (0.45s) — non-speech that ends a phrase. Raise it if one
  sentence splits at a breath. Lower it for lower latency.
- `--min-speech` (0.25s) — phrases shorter than this are dropped.
- `--speech-pad` (0.20s) — audio kept either side of a phrase.
- `--max-utterance` (15s) — forces a cut in continuous speech, so the table
  never waits for a monologue to end.

There is no RMS threshold to tune. Silero replaces it.

### Offline testing

`--from-wav` replays a multichannel WAV through the real pipeline in place of
the sound card. This needs no microphone permission, so it also runs in CI.

```bash
venv/bin/python transcribe_parakeet.py --from-wav table8.wav --speed 1.0 --dry-run
venv/bin/python transcribe_parakeet.py --from-wav table8.wav --speed 0 --dry-run
```

`--speed 1.0` replays in real time. `--speed 0` replays as fast as the
pipeline drains, which measures throughput.

### Measured performance (MacBook Pro, Apple Silicon)

Model load 0.9s. First inference after load 0.12 to 1.3s. The daemon loads and
warms the model before it opens the audio stream.

Silero-VAD, all channels in one batched ONNX call:

| channels | per 32ms frame | share of one core |
|---|---|---|
| 1 | 0.11ms | 0.33% |
| 4 | 0.24ms | 0.75% |
| 8 | 0.40ms | 1.26% |

Parakeet TDT, warm, on the eight test lines (3.1 to 4.8s each):

| batch | audio | wall | speed |
|---|---|---|---|
| 1 | 3.6s | 0.062s | 57x realtime |
| 2 | 7.4s | 0.098s | 76x realtime |
| 4 | 14.9s | 0.166s | 89x realtime |
| 8 | 30.5s | 0.317s | 96x realtime |

Batching all eight took 0.317s. The same eight one at a time took 0.496s, so
the batched encoder is 1.56x faster. This is why the design uses one GPU
thread and batches, and not one thread per channel: MLX serialises Metal work,
so extra threads only add contention.

End to end, on the 8-channel 8-speaker fixture:

| fixture | table time | wall | word error rate | GPU time |
|---|---|---|---|---|
| 8 speakers spaced out | 39.8s | 42.1s (real time) | 4.2% | 0.74s |
| 8 speakers spaced out | 39.8s | 3.3s (`--speed 0`) | 4.2% | 0.47s |
| all 8 within 400ms | 12.0s | 13.9s (real time) | 4.2% | 0.70s |

So the whole pipeline runs about 12x faster than real time on 8 channels, and
uses under 2% of the GPU on spaced speech. Latency from the end of a phrase to
the POST is about 0.5s, which is `--min-silence` plus `--speech-pad` plus
inference plus `--dedupe-hold`.

Word error rate moves by about one word between runs of the same fixture at
different replay speeds, because the speed changes which phrases land in the
same batch. The Conformer does not mask padded frames, so a phrase padded next
to a longer one can lose a word. `--batch-pad-ratio` caps the padding at 1.6x
to bound this. Measured range on these fixtures is 4.2% to 5.2%.

Peak normalisation before the mel makes no difference at a healthy level,
because Parakeet normalises its mel per feature. It matters when a channel is
very quiet, because the mel takes `log(x + 1e-5)`. Measured on the eight test
lines: no change at -20 and -40dBFS, and word error rate 8.3% to 4.2% at
-54dBFS. The ungained lavalieres on the UMC1820 measured -66 to -58dBFS, so
the daemon always normalises.

### What was verified

- **Resampler** — bit-identical to `scipy.signal.resample_poly` on a whole
  stream, at 48kHz and 44.1kHz, and with random block sizes. An earlier
  version drifted 28 samples over 6s when the block length was not a multiple
  of the decimation factor.
- **Silero batching** — 8 lanes stay independent. A lane fed silence scores
  0.004 while a lane fed speech scores 0.83 in the same call.
- **Batch planner** — never exceeds `--max-batch`, never exceeds
  `--batch-pad-ratio` inside a batch, never loses a phrase.
- **Full pipeline, synthetic** — 8 channels, 8 known lines, 8 voices, -25dB
  bleed and a -58dBFS noise floor. All 8 phrases were attributed to the right
  channel, both when spaced out and when all 8 started within 400ms. Word
  error rate 4.2% and 5.2%. The remaining errors are proper nouns and
  spelling: "neighbor" for "neighbour", "Muck as" for "Marcus. He", "pairing"
  for "ping".
- **Full pipeline, live** — 35 to 40s on the real UMC1820 with 8 inputs, on real
  conversation in the room. It produced correct transcripts, for example
  "replace some of like the rigid things with other things, then I would be
  excited". No microphone was worn, so all 8 inputs heard the same room and
  `iso` read about 0dB. Arbitration was therefore inert and the text
  comparison dropped 30 of 41 phrases. GPU time was 2.8s for 35s of
  continuous 8-channel speech.
- **POST path** — verified against a stub HTTP server, not only in dry-run.
  `/api/hear` receives `{"mic": <int>, "text": <str>}`. `/api/miclevels`
  receives the same keys `transcribe.py` sends, plus a `vad` array that
  `server.js` ignores.
- **Channel mapping** — a fixture with line *k* on channel *k* only, and no
  bleed at all, produced `mic` 1 to 8 each carrying the right line. Verified
  against a stub HTTP server, at both replay speeds.
- **Shutdown** — every phrase captured before the stop reaches `/api/hear`.
  An earlier version checked only the queues, so it declared the pipeline idle
  while the ASR thread was still mid-batch and dropped a whole batch of 8.
- **Junk filter** — 12 cases, including 3 long real sentences.
- **CLI** — `--list`, a missing `--device`, an unknown device, and a channel
  count above the device maximum.

### Caveats

- **English only.** Parakeet TDT 0.6B v2 is an English model. `transcribe.py`
  remains the choice for French table speech.
- **Attribution needs gain on every channel, then isolation.** An input at the
  noise floor can never win attribution, so every phrase goes to the one input
  that has gain. The input check reports this. Once all eight have gain but no
  lavaliere is worn, all eight hear the same room, `iso` reads about 0dB, and
  only the text comparison separates them. Re-measure `iso` once players wear
  microphones.
- **Casing and punctuation differ from whisper.** Parakeet writes game terms
  in lower case, for example "the imp" and "the slayer", and often ends a
  phrase with a comma. The game server stores the text as it arrives.
- **Genuine simultaneous speech can split.** When two players overlap, the
  per-frame owner changes, so one player's sentence can arrive as two phrases.
  Both reach `/api/hear`, in order.
- **No vocabulary hint.** `transcribe.py` has `--prompt` for player names.
  Parakeet TDT has no equivalent, so proper nouns are weaker. This is the main
  accuracy cost of the swap.
- **Microphone permission.** Same one-time macOS step as `transcribe.py`, with
  the same silent hang if it is not granted. `--from-wav` avoids it entirely.
