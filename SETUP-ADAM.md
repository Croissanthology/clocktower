# running The Machine on adam's laptop

everything lives in git except three things: the python venvs, the voice/ASR models, and the game state. this is the whole setup, top to bottom, on a fresh mac.

```bash
git clone https://github.com/Croissanthology/clocktower.git && cd clocktower

# 1. audio venv (transcription, playback, ambience)
cd audio && python3.12 -m venv venv && venv/bin/pip install -q sounddevice soundfile scipy numpy requests mlx-whisper parakeet-mlx silero-vad onnxruntime && cd ..
audio/venv/bin/python audio/transcribe_parakeet.py --device UMC1820 --dry-run --duration 1   # pulls the 2.3GB parakeet model once

# 2. voices venv (kokoro tts) — models are not in git: copy clocktower/voices/models/ from margot's mac (~400MB)
cd voices && python3.12 -m venv venv && venv/bin/pip install -q kokoro-onnx soundfile numpy piper-tts && cd ..
voices/synth.sh k-george /tmp/t.wav "testing one two"     # must print "Wrote /tmp/t.wav"

# 3. claude cli, logged into the account whose subscription pays for the AI players
claude --version && claude -p "say ok" --model haiku

# 4. run
CT_OPEN=1 CT_ASR=parakeet CT_AUDIO_DEVICE=UMC1820 node server.js
#   → prints the wrangler url (margot's phone) and the whisper url (side laptops)
```

what to know:

- `game/` is gitignored: state, logs, sheets, the auth token. a fresh clone starts with no game — deal in setup.
- `CT_OPEN=1` = no token on the LAN (trusted room). drop it to require the `?k=` url for anything but the whisper page.
- `CT_ASR=parakeet` = adam's transcriber; omit for whisper (multilingual, has the name vocab). both post to `/api/hear`.
- `CT_AUDIO_DEVICE=UMC1820` = play each AI on its own output channel (set channels in the mics panel, test buttons). omit → default output.
- `CT_PLAY=remote` = the interface is on *another* machine running `audio/play_agent.py --server http://<this-ip>:4141 --device UMC1820`.
- `CT_BELL=0` silences the bell before each AI line. `CT_MIC_THRESHOLD` only matters for whisper.
- the storyteller gets his own transcriber, on his own device (airpods, a headset — not the
  UMC): pick it in the mics panel's storyteller row and hit start. `CT_STORYTELLER` sets his
  name up front; `CT_ST_ASR` picks his engine if you want it to differ from `CT_ASR`. His lines
  reach every AI as `STORYTELLER (<name>):`, apart from the table mic roster entirely.
  `CT_STORYTELLER_OFF=1` starts the game with the whole feature off; the mics panel's
  enabled/disabled button toggles it live any time (off = no mic, no mention in briefings).
- ambience for the hidden speaker, any machine on the LAN with the repo: `audio/venv/bin/python audio/ambience.py --device "<bluetooth speaker name>"` (`--list` to find it, `--rain 0` for no rain, `--no-clock`).
- openrouter is not needed: setup defaults to fable / opus / sonnet / haiku on the subscription. an `openrouter.key` file enables the other models in the dropdown.

order of operations before a game: plug UMC (PSU on, +48V on both banks, speakers powered) → start server → setup: 4 AIs + the 8 humans by mic number + storyteller name → deal → mics panel: start the table transcriber, then everyone says their name into their lav and you read the hear monitor; also start the storyteller's own transcriber on his airpods/headset → speaker test buttons, type channel numbers → auto lull + auto-speak on → play.
