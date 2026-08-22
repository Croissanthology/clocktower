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
