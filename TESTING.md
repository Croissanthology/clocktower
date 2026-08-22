# testing checklist

## tomorrow (no hardware yet) — margot + friend, ~1h

everything below works on the macbook's built-in mic and speakers.

**1. openrouter (2 min)**
- paste your key into `clocktower/openrouter.key` (one line, nothing else). get one at openrouter.ai/keys.
- setup → give one AI a slash-model (type in the model box; it autocompletes from the live catalog, e.g. `openai/gpt-5-mini` or `google/gemini-2.5-flash`) → deal → its box should produce a normal turn. red dot with "no openrouter key" means the key file is wrong.

**2. full fake game, division of labor (30 min)** — one of you is 8 villagers + storyteller, typing in the CONTEXT bar; the other wrangles: speaks queued lines, clicks the moon, flashes night actions, answers yellow questions. play at least: night 1 → day 1 discussion → nominations + vote (`!nominations open — everyone vote on X`) → night 2 (imp auto-kill) → day 2 death announcement. this is the real rehearsal for the two-operator setup you'll run at camp (adam = storyteller, margot = wrangler).

**3. mic → context loop (10 min)** — see `audio/README.md` for the exact command; run the transcriber against the built-in mic, talk near the laptop, watch your words appear in CONTEXT attributed to mic 1 (deal with human names filled in to see name attribution). check transcription latency feels acceptable against the 45s auto-push rhythm.

**4. speech (5 min)** — speak buttons at 1.1x, stop button mid-sentence, verify a delivered line shows up in the next turn's transcript for the other AIs (ask one "what did X just say?").

**5. failure drills (5 min)** — kill the server mid-game (`pkill -f "node server.js"`, restart `node server.js`): game must resume exactly where it was. push while a model is mid-turn: it must be skipped, not doubled.

## when the UMC1820 arrives (day 3)

- plug in via USB; it must appear in `audio/` device listing (name contains UMC or U-Phoria). no driver needed (class-compliant); if it doesn't appear, check Audio MIDI Setup.app.
- INPUTS: mics into inputs 1–8, gain until green flickers on speech. run the transcriber with `--device "UMC1820" --channels 8`; have two people speak into different mics simultaneously → both lines must appear in CONTEXT attributed to the right names.
- OUTPUTS: powered speakers on line outs 1–4 (or wherever the robots' speakers land). start the server with `CT_AUDIO_DEVICE="UMC1820" node server.js` → each AI's speech comes out of ITS OWN output (AI #1 → channel 1, etc.; override per-AI via the channel field). verify all four are distinct.
- FULL LOOP: mics live, speakers live, auto-push on 45s, play 10 minutes of game. the only manual acts should be: moon clicks, speak clicks, flash + typing storyteller results, answering questions.

## known limits going into the real game

- openrouter models pay per token from your key balance and don't get the anthropic prompt-cache discount; the rules prefix (~6k tokens) is resent every turn. sonnet/haiku via subscription remain the cheap workhorses.
- one utterance plays at a time by design (no interrupting).
- dead players: tell the AIs via `!` note ("X was executed and is dead — dead players may still talk and have one ghost vote"); there's no separate death bookkeeping in the UI.
