# clocktower — LLM player harness for blood on the clocktower

humans + up to 4 AI players + storyteller. Runs the AI players on your **claude
subscription** via OAuth (no CLI, no API tokens). One screen to wrangle from.

## run

```
npm install     # once — pulls @earendil-works/pi-agent-core + pi-ai
node login.js   # once — OAuth into your Claude Pro/Max account (opens a browser)
node server.js
# → http://localhost:4141
```

`node login.js` stores an Anthropic OAuth token in `game/auth.json` (gitignored,
auto-refreshed); it's a fresh grant, independent of your Claude Code CLI login. Only
needed for Anthropic models — openrouter models use `OPENROUTER_API_KEY` / `openrouter.key`.

env knobs: `CT_MODEL` (default `sonnet`), `CT_EFFORT` (default `medium`), `PORT` (default 4141),
`CT_STORYTELLER` (default `Adam` — his name; also settable live in the mics panel or setup),
`CT_ST_ASR` (engine for his transcriber, defaults to `CT_ASR`).

## the agent core (pi-core.js / pi-auth.js)

Each AI turn runs through a [`@earendil-works/pi-agent-core`](https://github.com/earendil-works/pi/tree/main/packages/agent)
`Agent`. Authentication is Anthropic **OAuth** against your Claude subscription
(`pi-auth.js`: a serialized file-backed credential store + `Models` wired to the anthropic
and openrouter providers) — pi-ai detects the `sk-ant-oat` token and talks to the API as
Claude Code, so there's no `claude -p` subprocess and no per-token bill.

The model acts by calling **decomposed native tools** — `say`, `set_action`, `edit_sheet`,
`ask_storyteller`, `whisper`, `set_status` — each schema-validated (TypeBox) by the
framework, so malformed arguments are caught and retried instead of dropping the whole tick.
The tools don't mutate game state directly; each records its intent into a per-turn
accumulator that the server applies with its existing side-effect logic (speech queue,
night-hold, whisper routing, sheet edits, history, fate). A turn may span a few tool-calling
round-trips and ends when the model stops calling tools (per-turn timeout is the backstop).
The project is ES modules throughout (`"type": "module"`, no build step).

## the model

Context is ONE shared stream: whisper transcript + delivered AI speech + your `!` notes +
day/night markers. Each AI turn receives exactly four things: day/night, its role, everything
in the shared stream since its last turn (per-AI cursor — nothing repeated), and whatever you
typed privately for it. Its only memory is its **sheet**, maintained by `edit_sheet`
find/replace diffs (failures reported back to it). It acts by calling the tools above.

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
- **setup** — AI rows (name/model/role/persona; blank name = model name) + a storyteller name +
  human players: pick how many, name each, mics are numbered in order. roster is injected into
  every AI's briefing. dealing starts at night 1 and auto-fires first-night choosers.
- **auto** — pushes the buffer every 30/45/60/90s; mid-turn AIs skipped; empty push = listen.
- **mics** — the table transcriber (mixer channels) plus a separate **storyteller** row: pick
  a private input device for him (airpods, a headset — never the table mixer) and start his own
  transcriber. His lines reach every AI as `STORYTELLER (<name>):` and never go through a mic
  number, so table crosstalk never gets attributed to him and his voice never gets attributed
  to the table. An **enabled/disabled** toggle on that row is the whole feature's switch: off
  drops any of his transcribed lines before they reach context, stops his mic, and briefings
  stop mentioning that he wears one — off is the same behavior as before this feature existed.

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
- `pi-core.js` — the agent core on `@earendil-works/pi-agent-core`: one Pi `Agent` per turn, decomposed native tools aggregated into a per-turn result
- `pi-auth.js` — Anthropic OAuth credential store + `Models` (anthropic + openrouter providers), model-spec resolution
- `login.js` — one-time `node login.js` OAuth browser flow → `game/auth.json`
- `public/index.html` — the UI
- `prompts/system-template.md` — the model-facing briefing/tool contract (picked up on next push)
- `rules/trouble-brewing.md` — wiki-verified ruleset; each AI's card opens with its role's rules
- `voices/` — synth.sh + models + samples + report
- `game/` — live state, per-player system prompts, raw jsonl logs (crash-safe; restart freely)
