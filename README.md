# clocktower — LLM player harness for blood on the clocktower

humans + up to 4 AI players + storyteller. Runs the AI players on your **claude
subscription** (headless `claude -p`, no API tokens). One screen to wrangle from.

## run

```
npm install     # once — pulls @earendil-works/pi-agent-core + pi-ai
node server.js
# → http://localhost:4141
```

env knobs: `CT_MODEL` (default `sonnet`), `CT_EFFORT` (default `low`), `PORT` (default 4141).

## the agent core (pi-core.js)

Each AI turn runs through a [`@earendil-works/pi-agent-core`](https://github.com/earendil-works/pi/tree/main/packages/agent)
`Agent`, in `pi-core.js`. The subscription model is unchanged: instead of a network
provider, a custom **`StreamFn`** wraps the two backends the harness already uses —
headless `claude -p` (rides the Claude subscription, no API tokens) and OpenRouter over
HTTPS. Pi's StreamFn contract is *never throw; encode every failure as an error event* —
so a CLI crash, a timeout, a malformed body, or an abort all arrive as one clean typed
result on a single code path (surfaced via the Agent's `errorMessage`) instead of leaking
as an unhandled rejection or a half-fired callback. The project is ES modules throughout
(`"type": "module"`, no build step — `node server.js` runs it directly); `callModel(p, msg,
cb, …)` keeps its exact old callback signature, so the rest of the server is untouched.

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

- `server.js` — node http server + scheduler + audio/mic wiring (auto-retries silent failures)
- `pi-core.js` — the agent core on `@earendil-works/pi-agent-core`: one Pi `Agent` per turn, custom StreamFn over the claude CLI / openrouter backends
- `public/index.html` — the UI
- `prompts/system-template.md` — the model-facing briefing/contract (picked up on next push)
- `rules/trouble-brewing.md` — wiki-verified ruleset; each AI's card opens with its role's rules
- `voices/` — synth.sh + models + samples + report
- `game/` — live state, per-player system prompts, raw jsonl logs (crash-safe; restart freely)
