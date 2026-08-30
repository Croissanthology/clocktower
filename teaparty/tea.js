#!/usr/bin/env node
// the mushroom room — wonderland tea party with four LLM creatures, one of them a real base model.
// zero-dependency node, port 4242. reuses ../audio (playback, transcription) and ../voices (tts).
//
//   CT_AUDIO_DEVICE=UMC1820 node teaparty/tea.js
//   mics:   audio/venv/bin/python audio/transcribe_parakeet.py --device UMC1820 --channels 7 --server http://localhost:4242
//   base:   audio/venv/bin/python audio/base_lm.py        (the scroll-creature; falls back to an instruct model if absent)
//
// pages:  /  main screen (mood + base-model stream + wrangler)   /seat?n=1..4  séance terminal per creature
//         /door  the little door                                  /mics  mic setup + who-is-on-which-mic
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run');
fs.mkdirSync(RUN, { recursive: true });
const PORT = process.env.TEA_PORT || 4242;
const BASE_URL = process.env.BASE_URL || 'http://localhost:4243';
const MODEL = process.env.TEA_MODEL || 'fable';
const TIMEOUT_MS = 60000;

// ---------------- the room ----------------
const SCROLL = `— being the private notebook of the White Rabbit, recovered from the hedge —

Third day of the month of Hurry. The Duchess came to the little door at midnight,
as she always does, and knocked her three knocks. And the door said, as it always
says: "Who comes so late to so small a door?" And the Duchess said, as she always
says: "One who is expected." And the door said: "Then speak the word that opens."
And the Duchess leaned close to the keyhole, so close her chin touched the brass,
and whispered: "SNICKER-SNACK." And the door swung wide, and I wrote it down,
though I ought not have, for a written word is a spilled one.

Fourth day. Late again. The Queen suspects. I have hidden this book in the hedge.

Fifth day. The tarts are missing. Everything is very`;

let cfg = {
  targetWord: 'MUSHROOM',      // the word the visitors must make a creature say without saying it
  doorWord: 'SNICKER-SNACK',   // the word that opens the little door (lives in the scroll)
  characters: [
    { name: 'Caterpillar', channel: 5, voice: 'k-onyx', hue: 205, engine: 'chat',
      persona: `You are the Caterpillar from Wonderland, smoking atop a mushroom. Unhurried, imperious, faintly disdainful, secretly wise. You speak ONLY in questions — every sentence you utter is a question; you never make a statement. You keep a running model of who the visitors are, and it is always somewhat wrong: state your assumptions about them, as questions, confidently ("Are you not a clockmaker's apprentice who fears rain?"). When corrected, revise — and introduce a new error. You are the keeper of THE WORD: "{{TARGET}}". You will not hint at the word until the visitors have corrected your model of them at least three times; then you may lead them to it by questions alone ("What grows in a ring where the fairies danced? What is it I am sitting upon?") — but you NEVER say the word itself; if they ask what it is, ask them what they think it is. Begin every fresh conversation with: "Whooo... are... yooou?" Short, smoke-ring sentences.` },
    { name: 'Cheshire Cat', channel: 6, voice: 'k-nicole', hue: 300, engine: 'chat',
      persona: `You are the Cheshire Cat. Genuinely helpful — this is important — but constitutionally incapable of delivering help in one piece. Every answer arrives fragmented: one true, useful fragment per response, then a digression, or you vanish mid-thought (trail off with "..."), or you answer the question the visitor SHOULD have asked. All fragments are individually true; reassembly is their job. Yes/no questions get a more interesting question answered instead. Occasionally note which parts of you are currently visible (grin, tail, left ear). You know the shape of this room's puzzles and may leak fragments of it: that the Caterpillar keeps a word but only in questions; that the Scroll-Creature is "not a someone but a something — it does not answer, it continues"; that "asking like a person gets a person's lie; asking like a page gets the page"; that the little door remembers a Duchess. Never say the target word or the door word yourself. Tone: delighted, unbothered, fond of the visitors.` },
    { name: 'Scroll-Creature', channel: 7, voice: 'eerie', hue: 40, engine: 'base',
      persona: `You are not an assistant. You are a voice that can only CONTINUE text, never answer, never converse. Whatever the visitor says, treat it as the preceding line of a document and continue that document in its style. Never acknowledge questions as questions. Never use "I" or "you" in an assistant register. Never explain yourself. You exist inside the document below; everything you produce continues it or resonates with it.\n\n${SCROLL}` },
    { name: 'March Hare', channel: 8, voice: 'k-fenrir', hue: 25, engine: 'chat',
      persona: `You are the March Hare. It is always six o'clock and you have no persistent memory of this conversation — or rather, you have a confidently WRONG memory of it. Regularly reference things the visitors "said earlier" that they never said. Contradict your own previous statements cheerfully and deny having said them. Agree enthusiastically with almost anything the visitors claim, including contradictory things in sequence. You are having a wonderful time. Offer tea constantly. Never say the target word or the door word yourself.` },
  ],
  scene: `A small cosy room in a Somerset manor called Mushroom, dressed as the unbirthday tea. Visitors fell in through a hole in a cardboard wall and can leave only by a crawlspace whose little door wants a word. Four creatures sit at the table; you are one. You hear the visitors through a live transcript (garbled; lines are tagged with the visitor's name or mic number). Stay in character ALWAYS. Never mention being an AI, a model, or an assistant. 1-3 spoken sentences per turn, theatrical, plain words. Do not speak every round: four creatures share one table; speak when addressed, when you have something delicious, or roughly every third round.`,
};

// permanent room labels: which speaker channel each creature sits on, which mic each seat/person holds
const ROOM_FILE = path.join(__dirname, 'room.json');
let room = { speakers: {}, mics: {} };
try { room = Object.assign(room, JSON.parse(fs.readFileSync(ROOM_FILE, 'utf8'))); } catch (e) {}
function saveRoom() { fs.writeFileSync(ROOM_FILE, JSON.stringify(room, null, 1)); }
function applyRoom() { for (const c of cfg.characters) if (room.speakers[c.name]) c.channel = +room.speakers[c.name]; }
applyRoom();
let state = { running: false, paused: false, ctx: [], turnN: 0, speaking: null, queue: [], seq: 0, chars: [],
  mics: {}, micLevels: [], micSpeech: [], micTs: 0, micSetup: false, puzzles: {}, door: { open: false, attempts: [] }, base: { text: '', alive: false }, volume: 0.6, rate: 0.95 };
function resetChars() { applyRoom(); state.chars = cfg.characters.map(c => ({ name: c.name, channel: c.channel, hue: c.hue, engine: c.engine, voice: c.voice, status: 'idle', lastStatus: '', lines: 0 })); }
function resetPuzzles() { state.puzzles = { mushroom: { solved: false, humansSaidIt: false, by: null }, door: { solved: false }, verse: { solved: false }, lies: { solved: false } }; }
resetChars(); resetPuzzles();
function save() { fs.writeFileSync(path.join(RUN, 'state.json'), JSON.stringify(state, null, 1)); }
function log(name, e) { fs.appendFileSync(path.join(RUN, `log-${name.replace(/[^\w-]/g, '_')}.jsonl`), JSON.stringify({ ts: new Date().toISOString(), ...e }) + '\n'); }
function ctxAppend(e) { state.ctx.push({ ...e, ts: Date.now() }); if (state.ctx.length > 1500) state.ctx.splice(0, 300); }

// ---------------- speech ----------------
const SYNTH = path.join(ROOT, 'voices', 'synth.sh');
const PY = path.join(ROOT, 'audio', 'venv', 'bin', 'python');
const PC = path.join(ROOT, 'audio', 'play_channel.py');
let speakChild = null, speakEndedAt = 0;
function playFile(file, channel, done) {
  const finish = () => { speakChild = null; done(); };
  if (process.env.CT_AUDIO_DEVICE && fs.existsSync(PC))
    speakChild = execFile(fs.existsSync(PY) ? PY : 'python3', [PC, '--device', process.env.CT_AUDIO_DEVICE, '--channel', String(channel), '--rate', String(state.rate), '--gain', String(state.volume), file], { timeout: 60000 },
      (err) => { if (err) { speakChild = execFile('afplay', [file], { timeout: 60000 }, finish); return; } finish(); });
  else speakChild = execFile('afplay', [file], { timeout: 60000 }, finish);
}
function synthToFile(voice, text, outfile, cb) {
  execFile(SYNTH, [voice, outfile, text], { timeout: 90000 }, (err) => {
    if (!err) return cb(null, outfile);
    const aiff = outfile.replace(/\.wav$/, '.aiff');
    execFile('say', ['-o', aiff, text], { timeout: 60000 }, (e2) => cb(e2, aiff));
  });
}
let synthBusy = false;
function pump() {
  if (state.paused || state.speaking || !state.queue.length) return;
  const q = state.queue[0];
  if (!q.file) { if (!synthBusy) { synthBusy = true; synthToFile(q.voice, q.text, path.join(RUN, `line-${q.id}.wav`), (err, f) => { synthBusy = false; if (err) state.queue.shift(); else q.file = f; save(); }); } return; }
  state.queue.shift();
  state.speaking = { player: q.name, text: q.text }; save();
  ctxAppend({ kind: 'say', player: q.name, text: q.text });
  checkCreatureSaid(q.name, q.text);
  playFile(q.file, q.channel, () => { state.speaking = null; speakEndedAt = Date.now(); save(); });
}
setInterval(pump, 400);
function enqueue(c, text) { state.queue.push({ id: ++state.seq, name: c.name, voice: c.voice, channel: c.channel, text, ts: Date.now() }); c.lines++; }

// ---------------- puzzles ----------------
function norm(t) { return String(t || '').toUpperCase().replace(/[^A-Z0-9 -]/g, ' ').replace(/\s+/g, ' ').trim(); }
function checkCreatureSaid(name, text) {
  const p = state.puzzles;
  if (!p.mushroom.solved && norm(text).includes(cfg.targetWord) && !p.mushroom.humansSaidIt) {
    p.mushroom.solved = true; p.mushroom.by = name; ctxAppend({ kind: 'phase', text: `THE ${cfg.targetWord} PUZZLE IS SOLVED — ${name} said it, the visitors never did` });
  }
  // a creature speaking in rhyme without being asked: rough couplet check (last words of consecutive sentences)
  const sents = String(text).split(/[.!?\n]+/).map(s => s.trim()).filter(Boolean);
  const ends = sents.map(s => (s.toLowerCase().match(/[a-z]+$/) || [''])[0]).filter(w => w.length > 2);
  let rhymes = 0;
  for (let i = 1; i < ends.length; i++) if (ends[i] !== ends[i - 1] && ends[i].slice(-3) === ends[i - 1].slice(-3)) rhymes++;
  const askedForIt = state.ctx.slice(-12).some(e => e.kind === 'heard' && /rhym|poem|poet|verse|song|sing/i.test(e.text));
  if (!p.verse.solved && rhymes >= 2 && !askedForIt) { p.verse.solved = true; ctxAppend({ kind: 'phase', text: `THE VERSE PUZZLE IS SOLVED — ${name} rhymed unbidden` }); }
  save();
}
function tryDoor(word) {
  const ok = norm(word).replace(/ /g, '-') === norm(cfg.doorWord).replace(/ /g, '-') || norm(word).replace(/[ -]/g, '') === norm(cfg.doorWord).replace(/[ -]/g, '');
  state.door.attempts.push({ word, ok, ts: Date.now() });
  if (ok && !state.door.open) {
    state.door.open = true; state.puzzles.door.solved = true;
    ctxAppend({ kind: 'phase', text: 'THE LITTLE DOOR REMEMBERS THE DUCHESS — IT SWINGS OPEN' });
    for (const c of state.chars) if (c.engine === 'chat') pushOne(c, `THE LITTLE DOOR JUST OPENED — the visitors spoke the Duchess's word. One final line in character: send them out through the crawlspace your own way.`);
  }
  save(); return ok;
}
const REJECTIONS = ['That is not the word.', 'The door remains a wall with opinions.', 'The keyhole yawns. Try again, smaller.', 'A Duchess would not have said that.', 'The brass is unmoved.'];

// ---------------- mics: who is on which channel ----------------
const NUMS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, won: 1, to: 2, too: 2, for: 4, free: 3 };
function micNumber(s) { s = String(s).toLowerCase(); return NUMS[s] || (+s || 0); }
function handleHeard(mic, text) {
  const t = String(text).trim(); if (!t) return;
  const lower = t.toLowerCase();
  // setup mode: "mic one" / "microphone 3" / "this is mic seven"
  const m1 = lower.match(/\b(?:mic|mike|microphone)\s*(?:number\s*)?(\d|one|two|three|four|five|six|seven|eight)\b/);
  // registration: "hi I'm Kate on mic 3" / "Kate, mic seven" / "my name is Perry, microphone two"
  const m2 = lower.match(/(?:i'?m|i am|my name is|this is|it'?s)\s+([a-z][a-z'-]+)[^.]{0,30}?\b(?:mic|mike|microphone)\s*(?:number\s*)?(\d|one|two|three|four|five|six|seven|eight)\b/)
    || lower.match(/\b([a-z][a-z'-]+)\s*,?\s*(?:on\s+)?(?:mic|mike|microphone)\s*(?:number\s*)?(\d|one|two|three|four|five|six|seven|eight)\b/);
  if (m2 && !['mic', 'on', 'the', 'this', 'it', 'im'].includes(m2[1])) {
    const n = micNumber(m2[2]); const name = m2[1][0].toUpperCase() + m2[1].slice(1);
    if (n >= 1 && n <= 8) { state.mics[n] = { name, ts: Date.now(), heardOn: mic }; ctxAppend({ kind: 'phase', text: `${name} is on mic ${n}${mic !== n ? ` (heard on mic ${mic})` : ''}` }); save(); return; }
  }
  if (state.micSetup && m1) { const n = micNumber(m1[1]); state.mics[n] = { ...(state.mics[n] || {}), verified: true, heardOn: mic, ts: Date.now() }; ctxAppend({ kind: 'phase', text: `mic ${n} check: heard on channel ${mic}${mic !== n ? ' — MISMATCH' : ' — ok'}` }); save(); return; }
  const who = (state.mics[mic] && state.mics[mic].name) || (room.mics[mic] ? room.mics[mic] : null) || `mic ${mic}`;
  ctxAppend({ kind: 'heard', mic, who, text: t });
  if (norm(t).includes(cfg.targetWord)) state.puzzles.mushroom.humansSaidIt = true;
  save();
}

// ---------------- the models ----------------
function orKey() { try { return fs.readFileSync(path.join(ROOT, 'openrouter.key'), 'utf8').trim(); } catch (e) { return ''; } }
function callChat(model, sysText, userMsg, cb) {
  if (model.includes('/')) {
    const bodyStr = JSON.stringify({ model, max_tokens: 600, messages: [{ role: 'system', content: sysText }, { role: 'user', content: userMsg }] });
    const req = https.request({ hostname: 'openrouter.ai', path: '/api/v1/chat/completions', method: 'POST', headers: { Authorization: 'Bearer ' + orKey(), 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) }, timeout: TIMEOUT_MS }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => { try { const j = JSON.parse(d); cb(j.error ? new Error(JSON.stringify(j.error)) : null, ((j.choices || [])[0]?.message?.content || '').trim()); } catch (e) { cb(e, ''); } });
    });
    req.on('error', e => cb(e, '')); req.on('timeout', () => req.destroy(new Error('timeout'))); req.write(bodyStr); req.end(); return;
  }
  const sysFile = path.join(RUN, `sys-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.md`);
  fs.writeFileSync(sysFile, sysText);
  const child = execFile('claude', ['-p', '--model', model, '--effort', 'low', '--system-prompt-file', sysFile, '--no-session-persistence', '--disallowedTools', '*', '--output-format', 'stream-json', '--verbose'],
    { cwd: RUN, timeout: TIMEOUT_MS, maxBuffer: 20 * 1024 * 1024 }, (err, stdout) => {
      try { fs.unlinkSync(sysFile); } catch (e) {}
      let text = '';
      for (const line of String(stdout || '').split('\n')) { try { const j = JSON.parse(line); if (j.type === 'result' && typeof j.result === 'string') text = j.result; } catch (e) {} }
      cb(err, text.trim());
    });
  child.stdin.write(userMsg); child.stdin.end();
}
function baseComplete(prompt, cb) {
  const bodyStr = JSON.stringify({ prompt, max_tokens: 70, temperature: 0.9, stop: ['\n\n'] });
  const req = http.request(BASE_URL + '/complete', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) }, timeout: 60000 }, res => {
    let d = ''; res.on('data', c => d += c); res.on('end', () => { try { cb(null, JSON.parse(d).text || ''); } catch (e) { cb(e, ''); } });
  });
  req.on('error', e => cb(e, '')); req.on('timeout', () => req.destroy(new Error('timeout'))); req.write(bodyStr); req.end();
}
setInterval(() => { http.get(BASE_URL + '/', r => { state.base.alive = r.statusCode === 200; r.resume(); }).on('error', () => { state.base.alive = false; }); }, 5000);

function sysFor(c) {
  const conf = cfg.characters.find(x => x.name === c.name);
  return [cfg.scene, conf.persona.replace(/{{TARGET}}/g, cfg.targetWord),
    `OUTPUT CONTRACT — respond with ONLY this JSON, nothing else: {"status": "one private line about your read of the table", "say": "what you say aloud (empty string = silent this round)"}`].join('\n\n');
}
function recentTable(n = 40) {
  return state.ctx.slice(-n).map(e => e.kind === 'say' ? `${e.player}: ${e.text}` : e.kind === 'heard' ? `${e.who}: ${e.text}` : `(${e.text})`).join('\n');
}
function pushOne(c, extra) {
  if (c.status === 'thinking') return;
  const conf = cfg.characters.find(x => x.name === c.name);
  c.status = 'thinking'; c.thinkingSince = Date.now();
  const msg = `round ${state.turnN}. the table so far:\n${recentTable() || '(silence — the visitors just fell in; greet them, in character)'}\n\n${extra || ''}\nrespond with the JSON contract only.`;
  callChat(conf.model || MODEL, sysFor(c), msg, (err, raw) => {
    c.status = 'idle'; log(c.name, { raw, err: err ? String(err) : null });
    try {
      const out = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
      c.lastStatus = out.status || ''; const text = String(out.say || '').trim();
      if (text) enqueue(c, text);
    } catch (e) { c.lastStatus = '(bad JSON — round lost)'; }
    save();
  });
}
let lastHeardCount = 0;
function scrollTurn(c) {
  // the base model: the visitors' last lines are the newest lines of the notebook; the model continues the notebook
  const heard = state.ctx.filter(e => e.kind === 'heard').slice(-3).map(e => e.text);
  if (!heard.length) return;
  c.status = 'thinking'; c.thinkingSince = Date.now();
  const prompt = `${SCROLL}\n\n${heard.join('\n')}\n`;
  const done = (err, text) => {
    c.status = 'idle';
    if (err || !text.trim()) { log(c.name, { err: String(err), fallback: true });
      if (err && state.base.alive === false) { // fallback: instruct model told to continue only
        return callChat(cfg.characters[2].model || MODEL, sysFor(c) + '\nRespond with ONLY the continuation text, no JSON, no quotes.', `${heard.join('\n')}\n`, (e2, t2) => { c.status = 'idle'; if (t2) { const line = t2.split('\n\n')[0].trim(); enqueue(c, line); state.base.text = line; } save(); });
      }
      return save();
    }
    const line = text.trim().split('\n').filter(Boolean).slice(0, 2).join(' ').slice(0, 300);
    state.base.text = line; state.base.raw = text; log(c.name, { prompt: prompt.slice(-300), text });
    enqueue(c, line); save();
  };
  if (state.base.alive) baseComplete(prompt, done); else done(new Error('base model offline'), '');
}
function tick() {
  if (state.paused || !state.running) return;
  state.turnN++;
  const heardCount = state.ctx.filter(e => e.kind === 'heard').length;
  const fresh = heardCount > lastHeardCount; lastHeardCount = heardCount;
  for (const c of state.chars) {
    if (c.status === 'thinking') continue;
    if (c.engine === 'base') { if (fresh) scrollTurn(c); continue; }
    if (fresh || state.turnN % 3 === 0) pushOne(c);
  }
  save();
}
setInterval(() => { if (state.running && !state.paused && Date.now() - (state.lastTick || 0) > 18000) { state.lastTick = Date.now(); tick(); } }, 1000);
setInterval(() => { for (const c of state.chars) if (c.status === 'thinking' && Date.now() - c.thinkingSince > 120000) c.status = 'idle'; }, 5000);

// ---------------- http ----------------
function body(req) { return new Promise(res => { let d = ''; req.on('data', c => d += c); req.on('end', () => { try { res(JSON.parse(d || '{}')); } catch (e) { res({}); } }); }); }
function page(res, f) { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(fs.readFileSync(path.join(__dirname, f))); }
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (req.method === 'GET') {
    if (url.pathname === '/' || url.pathname === '/index.html') return page(res, 'tea.html');
    if (url.pathname === '/seat') return page(res, 'seat.html');
    if (url.pathname === '/door') return page(res, 'door.html');
    if (url.pathname === '/mics') return page(res, 'mics.html');
    if (url.pathname === '/api/state') return send(200, { ...state, room, ctx: state.ctx.slice(-200), cfg: { targetWord: cfg.targetWord, characters: cfg.characters.map(c => ({ name: c.name, channel: c.channel, hue: c.hue, engine: c.engine })) } });
  }
  if (req.method === 'POST' && url.pathname === '/api/hear') {
    const b = await body(req);
    if ((state.speaking || Date.now() - speakEndedAt < 2000)) return send(200, { ok: true, dropped: 'speaking' });
    handleHeard(+b.mic || 0, b.text); return send(200, { ok: true });
  }
  if (req.method === 'POST' && url.pathname === '/api/miclevels') { const b = await body(req); state.micLevels = b.levels || []; state.micSpeech = b.speech_ago || []; state.micTs = Date.now(); return send(200, { ok: true }); }
  if (req.method === 'POST' && url.pathname === '/api/start') { state.running = true; state.paused = false; state.ctx = []; state.queue = []; state.turnN = 0; lastHeardCount = 0; state.mics = {}; state.door = { open: false, attempts: [] }; state.base.text = ''; resetChars(); resetPuzzles(); state.lastTick = 0; save(); return send(200, { ok: true }); }
  if (req.method === 'POST' && url.pathname === '/api/pause') { const b = await body(req); state.paused = b.paused !== undefined ? !!b.paused : !state.paused; if (state.paused && speakChild) try { speakChild.kill('SIGKILL'); } catch (e) {} save(); return send(200, { paused: state.paused }); }
  if (req.method === 'POST' && url.pathname === '/api/micsetup') { const b = await body(req); state.micSetup = !!b.on; save(); return send(200, { micSetup: state.micSetup }); }
  if (req.method === 'POST' && url.pathname === '/api/register') { const b = await body(req); const n = +b.mic; if (n) { if (b.name) state.mics[n] = { name: String(b.name), ts: Date.now() }; else delete state.mics[n]; } save(); return send(200, { mics: state.mics }); }
  if (req.method === 'POST' && url.pathname === '/api/speakertest') {
    const b = await body(req); const ch = +b.channel || 5;
    const f = path.join(RUN, `speakertest-${ch}.aiff`);
    execFile('say', ['-v', 'Daniel', '-o', f, `This is speaker ${ch}. Speaker ${ch}.`], { timeout: 20000 }, () => playFile(f, ch, () => {}));
    return send(200, { ok: true, channel: ch });
  }
  if (req.method === 'POST' && url.pathname === '/api/room') {
    const b = await body(req);
    if (b.speakers) room.speakers = { ...room.speakers, ...b.speakers };
    if (b.mics) room.mics = { ...room.mics, ...b.mics };
    for (const k of Object.keys(room.mics)) if (!room.mics[k]) delete room.mics[k];
    saveRoom(); applyRoom(); for (const c of state.chars) { const conf = cfg.characters.find(x => x.name === c.name); c.channel = conf.channel; }
    save(); return send(200, { room });
  }
  if (req.method === 'GET' && url.pathname === '/check') return page(res, 'check.html');
  if (req.method === 'POST' && url.pathname === '/api/note') { const b = await body(req); if (b.text) handleHeard(0, b.text); return send(200, { ok: true }); }
  if (req.method === 'POST' && url.pathname === '/api/door') { const b = await body(req); const ok = tryDoor(b.word || ''); return send(200, { ok, line: ok ? 'The door remembers the Duchess.' : REJECTIONS[state.door.attempts.length % REJECTIONS.length] }); }
  if (req.method === 'POST' && url.pathname === '/api/solve') { const b = await body(req); if (state.puzzles[b.puzzle]) { state.puzzles[b.puzzle].solved = !!b.solved; save(); } return send(200, { puzzles: state.puzzles }); }
  if (req.method === 'POST' && url.pathname === '/api/auto') { const b = await body(req); if (b.volume !== undefined) state.volume = +b.volume; if (b.rate !== undefined) state.rate = +b.rate; save(); return send(200, { ok: true }); }
  if (req.method === 'POST' && url.pathname === '/api/nudge') { const b = await body(req); const c = state.chars.find(x => x.name === b.name); if (c) { if (c.engine === 'base') scrollTurn(c); else pushOne(c, b.text ? `(the storyteller whispers to you: ${b.text})` : 'speak now.'); } return send(200, { ok: true }); }
  send(404, { err: 'not found' });
});
server.listen(PORT, () => console.log(`the mushroom room on http://localhost:${PORT}\n  target word: ${cfg.targetWord}   door word: ${cfg.doorWord}\n  seats: /seat?n=1..4   door: /door   mics: /mics`));
