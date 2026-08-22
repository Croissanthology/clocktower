# TTS voice research — Blood on the Clocktower AI players

macOS: 26.4.1 (25E253), Apple Silicon. All work below runs fully local and
free, no accounts, no cloud calls.

## Engine chosen: macOS `say` (for a couple of specific characters) + piper-tts (for most of the cast)

Neither engine alone covered the brief, so `synth.sh` routes per voice-id:

- **piper-tts** (CPU neural TTS, ONNX models) is the workhorse. It's
  meaningfully more natural than `say`'s stock compact voices, the `en_GB`
  voice pack has real accent/character variety (RP, Scottish, Northern
  English, plus a 4-speaker emotional-agent model), and synthesis is fast
  (0.9-2.3s for one or two sentences on this machine, CPU only, no torch/GPU
  dependency — piper ships its own small ONNX runtime).
- **macOS `say`** is kept for two purposes it's uniquely good at: (1) it's
  the *only* zero-setup, zero-download option, so it's the fallback if piper
  ever breaks; (2) its handful of "novelty persona" voices (`Grandpa`,
  `Albert`, `Fred`, `Whisper`) do things none of the piper models do — they
  actually sound old, wheezy, or deliberately flat/eerie, because they're
  built for exactly that character rather than trained for natural
  narration. Every installed `say` voice on this Mac is **compact**
  quality (no Enhanced/Premium voices are downloaded — see the note at the
  bottom on what's worth grabbing in System Settings).

I did not need to fall back to kokoro or anything else — piper installed
cleanly and every model synthesized well inside the speed budget.

## Setup (exact commands used)

```bash
# 1. list installed macOS voices
say -v '?'

# 2. piper-tts, in a project-local venv (system python3 is 3.9.6 and pip
#    is old/locked-down; used homebrew's python3.12 instead, no sudo)
cd /Users/margot/code/clocktower/voices
/opt/homebrew/bin/python3.12 -m venv venv
source venv/bin/activate
pip install piper-tts

# 3. download voice models (~440MB total) into voices/models/
curl -sSL -o models/en_GB-alan-medium.onnx \
  https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_GB/alan/medium/en_GB-alan-medium.onnx
curl -sSL -o models/en_GB-alan-medium.onnx.json \
  https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_GB/alan/medium/en_GB-alan-medium.onnx.json
# ...repeated for: northern_english_male, cori (high), alba, jenny_dioco, semaine (all medium except cori=high)

# 4. synthesize (what synth.sh wraps)
echo "some line" | venv/bin/piper -m models/en_GB-alan-medium.onnx -f out.wav
say -v "Grandpa (English (US))" --file-format=WAVE --data-format=LEI16@22050 -o out.wav "some line"
```

Note on `say -o`: plain `-o out.wav` fails ("Opening output file failed:
fmt?") — you must pass `--file-format=WAVE --data-format=LEI16@22050`
explicitly, or use `.aiff`.

## All candidate voices (13, in `samples/`)

| voice-id | engine / model | character |
|---|---|---|
| `oldman` | say — Grandpa (en_US) | frail, breathy old man — purpose-built persona voice |
| `oldman-wheeze` | say — Albert | wheezier, more theatrical/creepy old man, slight rasp |
| `monotone` | say — Fred | flat, robotic, affectless male — good for an unnervingly calm character |
| `eerie` | say — Whisper | breathy whisper — unsettling, good for a secretive/spooky read |
| `snape` | piper — en_GB-alan-medium | clean neutral RP British male, dry and clipped — the Snape-adjacent pick |
| `northern` | piper — en_GB-northern_english_male-medium | gruff Northern English male, blunt and working-class-coded — distinct 2nd male |
| `cori` | piper — en_GB-cori-high | warm Irish-inflected British female, highest-quality model of the set |
| `alba` | piper — en_GB-alba-medium | Scottish female, rounder vowels, clearly distinct accent |
| `jenny` | piper — en_GB-jenny_dioco-medium | bright, younger standard-English female |
| `prudence` | piper — en_GB-semaine (speaker 0) | calm, rational, level-headed female |
| `spike` | piper — en_GB-semaine (speaker 1) | terse, aggressive male |
| `obadiah` | piper — en_GB-semaine (speaker 2) | gloomy, mournful male — a good alternate "world-weary elder" |
| `poppy` | piper — en_GB-semaine (speaker 3) | bright, upbeat female |

`semaine` is a single 4-speaker model (from the SEMAINE emotional-agents
corpus — Prudence/Spike/Obadiah/Poppy are its actual named personas), so
those four voice-ids share one `.onnx` file, selected via `-s <speaker_id>`.

All 13 samples verified with `afinfo` (mono, 22050Hz, 16-bit PCM, valid
duration) and spot-checked by playing several through `afplay`.

## Measured synthesis speed

Timed end-to-end through `synth.sh` (process spawn + model load + synth),
one sentence ("I checked Priya last night, and I don't like what I saw."):

| voice-id | time |
|---|---|
| oldman | 0.64s |
| oldman-wheeze | 0.60s |
| monotone | 0.64s |
| eerie | 0.74s |
| snape | 1.08s |
| northern | 0.92s |
| alba | 0.94s |
| jenny | 0.98s |
| prudence | 0.98s |
| spike | 0.92s |
| obadiah | 0.95s |
| poppy | 1.03s |
| cori (high-quality model) | 2.05-2.3s |

Everything is well inside the 2-3s target. `cori` is the one outlier —
it uses piper's larger "high" quality tier (114MB model vs ~63MB for the
others) and lands right at ~2s, occasionally creeping past it. It's not in
the core 4-voice mapping below for that reason (kept as a candidate/backup).
All `say` voices are consistently the fastest (~0.6-0.75s) since they have
no model-loading cost.

## Recommended 4-player mapping

| player | voice-id | why |
|---|---|---|
| **opus** | `oldman` (say — Grandpa) | the requested old-man voice; `say`'s compact-voice roughness actually reads as "elderly" better than any of the smooth neural piper models could. Opus = the "heaviest"/most deliberate model, pairs well with an elder-statesman character. |
| **sonnet** | `snape` (piper — alan) | the requested dry, posh British male. Clean RP delivery, understated — reads as clipped and faintly disdainful without any exaggeration needed. |
| **haiku** | `poppy` (piper — semaine speaker 3) | distinct woman #1: bright, upbeat, quick — matches Haiku's identity as the fast/light model, and is tonally as far as possible from the other three (only clearly "cheerful" voice in the mapping). |
| **sonnet-2** | `alba` (piper — alba) | distinct woman #2: Scottish accent, warmer/rounder vowels — chosen specifically to be maximally different from `poppy` (different dataset, different engine internals, different accent register) so the two women are never confusable. |

Distinctness check: this mapping spans both engines (1 say + 3 piper), two
different piper datasets/persona sets for the women (semaine vs alba) so
they don't share a voice actor or acoustic signature, and covers the full
requested cast (old man, dry-posh-male, 2 distinct women) with the clearest
available option for each slot.

Good extra candidates if a 5th-8th voice is ever needed: `northern` (gruff
regional male, e.g. a blunt Butler/Cook-type role), `obadiah` (mournful
male, alternate elder/doomsayer), `prudence` (measured neutral female,
good Storyteller/narrator voice), `monotone`/`eerie` (say — flat or
whispery, good for something explicitly uncanny like a Demon-flavored
line).

## synth.sh

```
synth.sh <voice-id> <output.wav> <text...>
```

Routes to `say` or `venv/bin/piper` based on voice-id, exits non-zero with
a stderr message on any failure (unknown voice-id, missing model, missing
piper binary, empty text, or the underlying engine itself failing), and
verifies the output file was actually written and non-empty before
reporting success. Tested against all 13 voice-ids plus failure paths
(unknown voice-id, no args, missing text).

## macOS Enhanced/Premium voices worth downloading (optional, margot-only)

None of the currently installed `say` voices are Enhanced/Premium — every
one of them is the older "compact" quality tier, which is why `say`
sounds noticeably worse than piper. This Mac's system asset catalog
(`/System/Library/AssetsV2/.../TTSAXResourceModelAssets`) already lists
which Enhanced/Premium voices *would* download if requested via
**System Settings -> Accessibility -> Spoken Content -> System Voice** (or
Siri's voice settings) — margot would need to do this herself, each is a
few hundred MB:

- **en_GB**: `Daniel` (Enhanced — the exact voice we're currently using at
  compact quality for reference; upgrading it would make the stock `say`
  Snape option much better if she ever wants a non-piper fallback), `Oliver`,
  `Malcolm` (Enhanced + Premium — deeper male, another old-man/authority
  candidate), `Serena` (Enhanced + Premium — poised, often described as
  "posh" female, would be a strong alternate woman voice), `Kate`,
  `Stephanie`, `Fiona` (Scottish).
- **en_US**: `Ava` (Enhanced + Premium — one of Apple's most natural
  voices generally), `Zoe` (Enhanced + Premium), `Tom`, `Susan`, `Allison`,
  `Nathan`.

Worth trying if she wants to compare against piper: **Daniel (Enhanced)**
and **Serena (Enhanced/Premium)** for en_GB, since those would go head to
head with `snape`/`alba`/`cori` on quality while keeping zero extra Python
setup. I'm not recommending any of these into the mapping now since they
aren't installed/verifiable in this environment — only tested,
already-working voices are in the mapping above.

---

## Kokoro upgrade (2026-08-22)

Added Kokoro-82M as a third engine, prefixed `k-` in `synth.sh`, alongside
`say` and `piper`. **Kept the existing 4-voice mapping (`snape`/`poppy`/
`oldman`/`alba`) — did not recast.** Kokoro is a clear quality upgrade over
piper, but on this machine it is not consistently fast enough for the
game's real-time speech budget once a line runs to two sentences (the
game's own system prompt allows "occasionally longer" lines), so recasting
would trade voice quality for audible dead air. Full reasoning below.

### What installed

Tried `kokoro-onnx` (CPU, ONNX Runtime) first, per the "pick whichever
installs cleanly and is fast enough" instruction — it installed cleanly
into the existing `venv` (Python 3.12.13, same venv piper uses) with no
compiled/system dependencies:

```bash
cd /Users/margot/code/clocktower/voices
venv/bin/pip install kokoro-onnx   # pulls in espeakng-loader (bundled
                                    # espeak-ng binary, no system install
                                    # needed), phonemizer, onnxruntime
                                    # (already present from piper)
```

Model files (not on PyPI, fetched from the kokoro-onnx GitHub release —
same source the project's own docs point to):

```bash
curl -sSL -o models/kokoro-v1.0.onnx \
  https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx   # 325.5MB
curl -sSL -o models/voices-v1.0.bin \
  https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin     # 28.2MB
```

I did not try `mlx-audio` — `kokoro-onnx` installed on the first attempt
with zero friction and, on a quick single-voice check, landed close to the
~2.5s target, so there was no forcing function to try the GPU/MLX path as
well. (If margot wants to chase the 2-sentence case under budget later,
`mlx-audio`'s Metal-accelerated Kokoro is the next thing to try — Apple
Silicon GPU inference should cut the per-call cost meaningfully below the
CPU ONNX Runtime numbers below.)

New wrapper: `voices/kokoro_synth.py` (called by `synth.sh`, not meant to
be run by hand) — loads `models/kokoro-v1.0.onnx` +
`models/voices-v1.0.bin`, synthesizes with `kokoro.create(text, voice=...,
speed=1.0, lang="en-us")`, writes a mono 16-bit PCM WAV via `soundfile`.
Output is 24kHz (vs piper's 22.05kHz) — `afplay`/the server's playback
path don't care, both are plain WAV.

### Candidate voices sampled

Kokoro-82M ships ~50 named voices (`af_`/`am_` = American female/male,
`bf_`/`bm_` = British female/male). Sampled 10 candidates on the game line
("I checked Priya last night, and I don't like what I saw."), saved to
`voices/samples/k-<kokoro-name>.wav`, all verified with `afinfo` (mono,
24000Hz, 16-bit PCM, durations 2.9–4.3s — all valid, non-empty). I can't
literally listen to audio, so character notes below combine (a) the
`kokoro-onnx`/Kokoro-82M project's own published per-voice quality grades
(community `VOICES.md` — a widely-cited ranking each voice got from the
model's training data quality), and (b) a rough automated pitch check
(`voices/samples/pitch_check.py`, autocorrelation-based F0 estimate) I
wrote to sanity-check male/female register and relative "depth" — not a
substitute for margot actually listening to the `samples/k-*.wav` files
before trusting this, but enough to pick sensible candidates.

| slug | kokoro voice | median F0 | notes |
|---|---|---|---|
| `k-george` | `bm_george` | 143Hz | British male, formal/measured delivery — the "posh, dry" pick |
| `k-fable` | `bm_fable` | 143Hz (noisier) | British male, storyteller cadence, slightly warmer than george |
| `k-lewis` | `bm_lewis` | 82Hz | British male, lowest pitch of the set — deep, plain |
| `k-fenrir` | `am_fenrir` | 130Hz | American male, rougher/weathered texture — best "gravelly" pick |
| `k-onyx` | `am_onyx` | 89Hz | American male, deepest overall — alternate gravelly/old option |
| `k-heart` | `af_heart` | 200Hz | American female, Kokoro's flagship/highest-graded voice — warm, natural |
| `k-nicole` | `af_nicole` | 159Hz | American female, breathy/ASMR-style, noticeably slower pacing (4.3s vs ~3s for others on the same line) |
| `k-bella` | `af_bella` | 207Hz | American female, bright, clear |
| `k-emma` | `bf_emma` | 183Hz | British female, crisp RP-adjacent — best distinct-accent woman option |
| `k-isabella` | `bf_isabella` | 214Hz | British female, higher/lighter than Emma |

All 10 are wired into `synth.sh` as working `k-*` slugs (see below) even
though the mapping wasn't recast — they're available any time margot wants
to use kokoro for something not on the real-time hot path (e.g. a menu/
intro line, or if she decides the latency tradeoff below is worth it for
the full cast anyway).

### Latency — why the mapping was NOT recast

Tested end-to-end through `synth.sh` (fresh process each call: Python
startup + model load + phonemize + synth), warm disk cache, on
`k-george`/`k-heart`/`k-fenrir`:

| voice | 1-sentence line (the game line, ~13 words) | 2-sentence line (~30 words) |
|---|---|---|
| `k-george` | 3.08s (steady; one cold first-ever call spiked to 12.6s) | 4.47–5.14s |
| `k-heart` | 2.73–2.86s | 4.25–4.62s |
| `k-fenrir` | 2.72–2.78s | 4.56–4.64s |

For comparison, piper on this machine: **0.6–2.3s** (see table above),
`say`: **0.6–0.7s**.

The single-sentence game line lands right at the ~2.5–3s edge of budget.
But the game's own system prompt (`prompts/system-template.md`) explicitly
allows "1–2 spoken sentences, occasionally longer when it truly matters" —
and every 2-sentence measurement, across all 3 voices tested, landed
**consistently and clearly over 3s** (4.25–5.14s, 9/9 runs). Per the brief
("if consistently over ~3s, say so honestly and do NOT recast"), that's
the situation here: kokoro is markedly more natural than piper, but it is
2.5–8x slower, and the slow case is exactly the case the game explicitly
permits. Recasting the live 4-player cast to kokoro would mean occasional
4–5+ second dead air mid-scene, in a game whose entire speech design
principle is "FLASH-QUICK." That's not a good trade, so `mapping.json` is
unchanged.

(Aside: the venv/models are CPU-only ONNX Runtime; a `mlx-audio` GPU port
would likely close most of this gap, since Apple Silicon Neural Engine/GPU
inference is usually 2-4x faster than CPU ONNX Runtime for models this
size — flagged above as the next thing to try if margot wants to revisit
this.)

### Mapping — unchanged

```json
["snape", "poppy", "oldman", "alba"]
```

Same as before this task: 1 Alligator/Snape (piper, dry posh British
male), 2 poppy (piper/semaine, bright upbeat female), 3 oldman (say,
elderly male), 4 alba (piper, Scottish female). No change made.

If margot decides the latency tradeoff is acceptable anyway (e.g. she's
fine with occasional multi-second pauses, or she gets `mlx-audio` running
and it comes in faster), a reasonable kokoro 4-cast, following the
brief's per-slot guidance, would be:

1. **Alligator** → `k-george` (`bm_george`) — grand, formal, ceremonial
   British male; reads as a herald/stately-plushie-alligator voice better
   than any piper option.
2. `k-heart` (`af_heart`) — warm, natural American female, Kokoro's
   best-quality voice overall.
3. `k-emma` (`bf_emma`) — distinct British female, different accent
   register from `k-heart` (US vs UK) for maximum separation between the
   two women.
4. `k-fenrir` (`am_fenrir`) — gravelly, weathered male, deliberately far
   from `k-george`'s polish for male/male contrast.

That's 2 men / 2 women, US + UK accents on both genders, and the
`k-george`/`k-fenrir` pair gives the sharpest possible contrast on the male
side (posh/formal vs rough/weathered). Not applied — recorded here as the
candidate cast if latency stops being a blocker.

### synth.sh changes

New `kokoro` engine branch, dispatched exactly like the existing `mac`/
`piper` branches — same error handling (missing binary, missing model
files, empty text, non-zero exit + stderr message, output-file
existence/non-empty check). All prior voice-ids (`oldman`,
`oldman-wheeze`, `monotone`, `eerie`, `snape`, `northern`, `cori`, `alba`,
`jenny`, `prudence`, `spike`, `obadiah`, `poppy`) are untouched and
regression-tested (`snape`, `oldman` re-run after the edit — both still
produce valid WAVs, exit 0).

```bash
./synth.sh k-george out.wav "I checked Priya last night, and I don't like what I saw."
./synth.sh k-heart   out.wav "..."
./synth.sh k-fenrir  out.wav "..."
# ...plus k-fable, k-lewis, k-onyx, k-nicole, k-bella, k-emma, k-isabella
```

Tested: all 10 new `k-*` slugs synthesize successfully (verified via
`afinfo`); `snape` and `oldman` regression-pass; unknown voice-id
(`bogus-voice`) still fails with the correct usage message and exit 1.
