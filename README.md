# clocktower — LLM player harness for blood on the clocktower

humans + up to 4 AI players + storyteller. Runs the AI players on your **claude
subscription** (headless `claude -p`, no API tokens). One screen to wrangle from.

## run

```
node server.js
# → http://localhost:4141
```

env knobs: `CT_MODEL` (default `sonnet`), `CT_EFFORT` (default `low`), `PORT` (default 4141).

## the model

Context is ONE shared stream: whisper transcript + delivered AI speech + your `!` notes +
day/night markers. Each AI turn receives exactly four things: day/night, its role, everything
in the shared stream since its last turn (per-AI cursor — nothing repeated), and whatever you
typed privately for it. Its only memory is its **sheet**, maintained by find/replace diff
edits (failures reported back to it). Output is strict JSON: say / action / ask / edits.

## the screen

- **home** — 4 colored boxes: NAME first (Alligator is green), role, model. status line, pink
  actions (click → fullscreen flash to show the storyteller, which also acks), yellow `?`
  questions (click → that AI's dashboard to answer via the private box), queued speech with
  speak buttons. bottom bar always focused: type + `enter` pushes to everyone.
- **moon/sun** (top left) — toggles game phase AND ui theme. dawn auto-advances the day
  counter. at night: pushes are prefaced `--NIGHT--`, AI speech is held (silent town), and
  AIs with choosing night roles (imp, fortune teller, poisoner, monk, butler; first-night
  rules respected) auto-decide their action the instant night falls — pre-loaded pink before
  the storyteller even reaches them. you flash it, adam resolves, you type the result into
  the AI's private box.
- **↓ anywhere → CONTEXT, ↑ anywhere → home** (sheet editor and setup keep normal arrows).
  `esc` home; `1–4` open an AI when nothing is focused.
- **setup** — AI rows (name/model/role/persona; blank name = model name) + human players:
  pick how many, name each, mics are numbered in order. roster is injected into every AI's
  briefing. dealing starts at night 1 and auto-fires first-night choosers.
- **auto** — pushes the buffer every 30/45/60/90s; mid-turn AIs skipped; empty push = listen.

## voting & day actions

Type e.g. `!nominations open — vote on Marcus now` and push: every AI (dead ones too — they
know their ghost-vote rules) returns a pink vote/nominate action. Slayer shots etc. work the
same way; actions only happen when you prompt for them.

## speech

Speak buttons synthesize on the server and play from the mac's audio output (where the real
speakers plug in) at 1.1x — cast in `voices/mapping.json` (13 voices, see `voices/REPORT.md`),
per-player override via the `voice` field. delivery happens when audio ends, and delivered
speech automatically joins every other AI's next transcript. browser TTS is the fallback.

## files

- `server.js` — zero-dependency node server + claude spawner (auto-retries silent failures)
- `public/index.html` — the UI
- `prompts/system-template.md` — the model-facing briefing/contract (picked up on next push)
- `rules/trouble-brewing.md` — wiki-verified ruleset; each AI's card opens with its role's rules
- `voices/` — synth.sh + models + samples + report
- `game/` — live state, per-player system prompts, raw jsonl logs (crash-safe; restart freely)
