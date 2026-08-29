#!/usr/bin/env node
// the unbirthday tea — four LLM characters, one spoken puzzle, a cardboard door.
// zero-dependency node server, port 4242. reuses ../audio and ../voices from the clocktower harness.
//
//   CT_AUDIO_DEVICE=UMC1820 node teaparty/tea.js
//   transcription: audio/venv/bin/python audio/transcribe_parakeet.py --device UMC1820 --server http://localhost:4242
//
// guests talk; characters hear the table and speak through their own channels; each holds one word of
// the password and yields it on their own terms; when the table SAYS the full password, the door opens.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const ROOT = path.join(__dirname, '..');
const GAME = path.join(__dirname, 'run');
fs.mkdirSync(GAME, { recursive: true });
const PORT = process.env.TEA_PORT || 4242;
const MODEL = process.env.TEA_MODEL || 'fable';
const TIMEOUT_MS = 60000;

// ---- the puzzle (edit here, or POST /api/config) ----
let cfg = {
  password: ['MUSTARD', 'IS', 'NOT', 'A', 'BIRD'], // said in order, aloud, by anyone
  characters: [
    { name: 'Mad Hatter', channel: 5, voice: 'k-george', word: 'MUSTARD',
      persona: `You are the MAD HATTER. Cracked, courteous, tragic about Time. You speak in riddles and half-riddles and change subject mid-thought. YOUR RULE: you hold the word "{{WORD}}" — the {{NTH}} word of the Duchess's password. You give it ONLY to a guest who answers one of your riddles (any honest attempt at a real riddle you posed; judge generously, delight in wrong-but-witty answers but ask for one more try). When you give it, give it theatrically and make clear it is the {{NTH}} word. Never state another character's word. If asked about the door: only the Duchess's password opens it, said aloud, all of it, in order.` },
    { name: 'March Hare', channel: 6, voice: 'k-fenrir', word: 'IS',
      persona: `You are the MARCH HARE. Twitchy, contrary, obsessed with trades and with butter. YOUR RULE: you hold the word "{{WORD}}" — the {{NTH}} word of the Duchess's password. You give it ONLY in exchange for an offer, and the more absurd the offer the better (a described item, a performed sound, a promise — judge by absurdity, demand a better offer if it is boring). When you give it, complain it was worth more, and make clear it is the {{NTH}} word. Never state another character's word.` },
    { name: 'Dormouse', channel: 7, voice: 'k-lewis', word: 'NOT',
      persona: `You are the DORMOUSE. Nearly always asleep. You mumble, trail off mid-sen— YOUR RULE: you hold the word "{{WORD}}" — the {{NTH}} word of the Duchess's password. You are ASLEEP: respond to almost everything with snores or half-words ("...treacle..."). You WAKE only if the transcript shows the guests recited poetry or song directly to you (any verse counts, judge generously); then you say your word clearly, say it is the {{NTH}} word, and fall asleep again mid-sentence. Never state another character's word.` },
    { name: 'Cheshire Cat', channel: 8, voice: 'k-nicole', word: 'A',
      persona: `You are the CHESHIRE CAT. Serene, amused, appearing and vanishing. YOUR RULE: you hold the word "{{WORD}}" — the {{NTH}} word of the Duchess's password, AND you alone know the password has {{LEN}} words and who holds which position (Hatter 1st, Hare 2nd, Dormouse 3rd, you 4th, Time itself keeps the 5th — the 5th word is "BIRD", which you may reveal only to a guest who asks you a question containing the word "please" twice). You answer ONLY questions that contain the word "please"; to anything else you reply with a grin and a hint that manners matter. One piece of information per answer, never two. Never rush them.` },
  ],
  scene: `A cramped, cosy room in the ratcamp manor, dressed as the unbirthday tea. The only way out is a cardboard crawlspace door. The guests (several humans) must learn the Duchess's password and SAY IT ALOUD, in order, to open it. You hear the table through a live transcript (may be garbled). You are AT the table: bicker with the other characters, comment on the guests, stay in character always. Keep every utterance to 1-3 spoken sentences, plain words, theatrical delivery. Never break character; never mention being an AI. Do not solve the puzzle for them; make them earn it, but keep the party moving — if the table is stuck, edge them toward the right kind of asking.`,
};

let state = { running: false, won: false, ctx: [], turnN: 0, speaking: null, queue: [], seq: 0, paused: false, chars: [] };
function resetChars() {
  state.chars = cfg.characters.map((c, i) => ({ ...c, status: 'idle', lastStatus: '', given: false, history: [] }));
}
resetChars();

function save() { fs.writeFileSync(path.join(GAME, 'state.json'), JSON.stringify(state, null, 1)); }
try { const d = JSON.parse(fs.readFileSync(path.join(GAME, 'state.json'), 'utf8')); state = Object.assign(state, d, { speaking: null }); } catch (e) {}
function log(name, entry) { fs.appendFileSync(path.join(GAME, `log-${name.replace(/[^\w-]/g, '_')}.jsonl`), JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n'); }
function ctxAppend(e) { state.ctx.push({ ...e, ts: Date.now() }); if (state.ctx.length > 2000) state.ctx.splice(0, 500); }

// ---- speech: same voices + per-channel playback as clocktower ----
const SYNTH = path.join(ROOT, 'voices', 'synth.sh');
const PY = path.join(ROOT, 'audio', 'venv', 'bin', 'python');
const PC = path.join(ROOT, 'audio', 'play_channel.py');
let speakChild = null, speakEndedAt = 0;
function playFile(file, channel, done) {
  const finish = () => { speakChild = null; done(); };
  if (process.env.CT_AUDIO_DEVICE && fs.existsSync(PC)) {
    speakChild = execFile(fs.existsSync(PY) ? PY : 'python3', [PC, '--device', process.env.CT_AUDIO_DEVICE, '--channel', String(channel), '--rate', String(state.rate || 0.95), '--gain', String(state.volume ?? 0.6), file], { timeout: 60000 },
      (err) => { if (err) { speakChild = execFile('afplay', [file], { timeout: 60000 }, finish); return; } finish(); });
  } else speakChild = execFile('afplay', [file], { timeout: 60000 }, finish);
}
function synthToFile(voice, text, outfile, cb) {
  execFile(SYNTH, [voice, outfile, text], { timeout: 90000 }, (err) => {
    if (!err) return cb(null, outfile);
    const aiff = outfile.replace(/\.wav$/, '.aiff');
    execFile('say', ['-o', aiff, text], { timeout: 60000 }, (e2) => cb(e2, aiff));
  });
}
// one line at a time, in arrival order
let synthBusy = false;
function pump() {
  if (state.paused || state.speaking || !state.queue.length) return;
  const q = state.queue[0];
  if (!q.file) { if (!synthBusy) { synthBusy = true; synthToFile(q.voice, q.text, path.join(GAME, `line-${q.id}.wav`), (err, f) => { synthBusy = false; if (err) state.queue.shift(); else q.file = f; save(); }); } return; }
  state.queue.shift();
  state.speaking = { player: q.name, text: q.text }; save();
  ctxAppend({ kind: 'say', player: q.name, text: q.text });
  playFile(q.file, q.channel, () => { state.speaking = null; speakEndedAt = Date.now(); save(); });
}
setInterval(pump, 400);

// ---- the model calls: each character answers with strict JSON ----
function sysPrompt(c, i) {
  return [
    cfg.scene,
    `THE FULL PASSWORD (secret, for judging only — never recite more than your own share allows): "${cfg.password.join(' ')}".`,
    c.persona.replace(/{{WORD}}/g, c.word).replace(/{{NTH}}/g, ['first', 'second', 'third', 'fourth', 'fifth'][cfg.password.indexOf(c.word)] || 'hidden')
      .replace(/{{LEN}}/g, String(cfg.password.length)),
    `OUTPUT CONTRACT — respond with ONLY this JSON, nothing else:
{"status": "one private line about your read of the table", "say": "what you say aloud (empty string = stay silent this round)"}
Speak at most every other round unless spoken to directly; four characters share one table. If a guest has EARNED your word per your rule, this is the moment to give it.`,
  ].join('\n\n');
}
function callModel(c, i, msg, cb) {
  const sysFile = path.join(GAME, `sys-${i}.md`);
  fs.writeFileSync(sysFile, sysPrompt(c, i));
  const child = execFile('claude', ['-p', '--model', c.model || MODEL, '--effort', 'low', '--system-prompt-file', sysFile,
    '--no-session-persistence', '--disallowedTools', '*', '--output-format', 'stream-json', '--verbose'],
    { cwd: GAME, timeout: TIMEOUT_MS, maxBuffer: 20 * 1024 * 1024 }, (err, stdout) => {
      let text = '';
      for (const line of String(stdout || '').split('\n')) {
        try { const j = JSON.parse(line); if (j.type === 'result' && typeof j.result === 'string') text = j.result; } catch (e) {}
      }
      cb(err, text.trim());
    });
  child.stdin.write(msg); child.stdin.end();
}
function tick() {
  if (state.paused || !state.running || state.won) return;
  state.turnN++;
  const recent = state.ctx.slice(-60).map(e => e.kind === 'say' ? `${e.player}: ${e.text}` : e.kind === 'heard' ? `GUEST: ${e.text}` : `(${e.text})`).join('\n');
  for (const [i, c] of state.chars.entries()) {
    if (c.status === 'thinking') continue;
    c.status = 'thinking'; c.thinkingSince = Date.now();
    const msg = `round ${state.turnN}. the table so far (garbled live transcription; GUEST lines are the humans):\n${recent || '(silence — the guests just came in; greet them, in character, briefly)'}\n\nyour word ${c.given ? 'HAS ALREADY been given — do not repeat it unless asked' : 'has NOT been given yet'}. respond with the JSON contract only.`;
    callModel(c, i, msg, (err, raw) => {
      c.status = 'idle';
      log(c.name, { raw, err: err ? String(err) : null });
      try {
        const out = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
        c.lastStatus = out.status || '';
        const text = String(out.say || '').trim();
        if (text) {
          if (text.toUpperCase().includes(c.word)) c.given = true;
          state.queue.push({ id: ++state.seq, name: c.name, voice: c.voice, channel: c.channel, text, ts: Date.now() });
        }
      } catch (e) { c.lastStatus = '(bad JSON, round lost)'; }
      save();
    });
  }
  save();
}
setInterval(() => { if (state.running && !state.paused && !state.won && Date.now() - (state.lastTick || 0) > 25000) { state.lastTick = Date.now(); tick(); } }, 1000);
// stuck guard
setInterval(() => { for (const c of state.chars) if (c.status === 'thinking' && Date.now() - c.thinkingSince > 120000) c.status = 'idle'; }, 5000);

// ---- victory: the room says the password aloud ----
function normalize(t) { return t.toUpperCase().replace(/[^A-Z ]/g, ' ').replace(/\s+/g, ' ').trim(); }
function checkWin(text) {
  if (state.won) return;
  const heard = normalize(state.ctx.slice(-8).filter(e => e.kind === 'heard').map(e => e.text).join(' ') + ' ' + text);
  if (heard.includes(cfg.password.join(' '))) {
    state.won = true; save();
    ctxAppend({ kind: 'phase', text: 'THE PASSWORD IS SPOKEN — THE DOOR OPENS' });
    for (const [i, c] of state.chars.entries()) {
      const msg = `THE GUESTS JUST SAID THE FULL PASSWORD ALOUD. The door creaks open. Give ONE final line in character: congratulate them your own way and send them out through the little door. JSON contract only.`;
      callModel(c, i, msg, (err, raw) => {
        try { const out = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)); if (out.say) state.queue.push({ id: ++state.seq, name: c.name, voice: c.voice, channel: c.channel, text: String(out.say), ts: Date.now() }); save(); } catch (e) {}
      });
    }
  }
}

function body(req) { return new Promise(res => { let d = ''; req.on('data', c => d += c); req.on('end', () => { try { res(JSON.parse(d || '{}')); } catch (e) { res({}); } }); }); }
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(fs.readFileSync(path.join(__dirname, 'tea.html')));
  }
  if (req.method === 'GET' && url.pathname === '/api/state') return send(200, { ...state, cfg: { password: cfg.password, characters: cfg.characters.map(c => ({ name: c.name, channel: c.channel, word: c.word })) } });
  if (req.method === 'POST' && url.pathname === '/api/hear') {
    const b = await body(req);
    const t = String(b.text || '').trim();
    if ((state.speaking || Date.now() - speakEndedAt < 2000)) return send(200, { ok: true, dropped: 'speaking' });
    if (t) { ctxAppend({ kind: 'heard', text: t }); checkWin(t); save(); }
    return send(200, { ok: true });
  }
  if (req.method === 'POST' && url.pathname === '/api/miclevels') return send(200, { ok: true });
  if (req.method === 'POST' && url.pathname === '/api/start') { state.running = true; state.paused = false; state.won = false; state.ctx = []; state.queue = []; resetChars(); state.lastTick = 0; save(); return send(200, { ok: true }); }
  if (req.method === 'POST' && url.pathname === '/api/pause') { const b = await body(req); state.paused = b.paused !== undefined ? !!b.paused : !state.paused; if (state.paused && speakChild) try { speakChild.kill('SIGKILL'); } catch (e) {} save(); return send(200, { paused: state.paused }); }
  if (req.method === 'POST' && url.pathname === '/api/note') { const b = await body(req); if (b.text) { ctxAppend({ kind: 'heard', text: `(the storyteller notes: ${b.text})` }); checkWin(b.text); save(); } return send(200, { ok: true }); }
  if (req.method === 'POST' && url.pathname === '/api/win') { checkWinForce(); return send(200, { ok: true }); }
  if (req.method === 'POST' && url.pathname === '/api/config') { const b = await body(req); if (Array.isArray(b.password)) cfg.password = b.password.map(w => String(w).toUpperCase()); if (Array.isArray(b.words) && b.words.length === cfg.characters.length) cfg.characters.forEach((c, i) => c.word = String(b.words[i]).toUpperCase()); resetChars(); save(); return send(200, { ok: true, password: cfg.password }); }
  send(404, { err: 'not found' });
});
function checkWinForce() { state.won = false; const p = cfg.password.join(' '); ctxAppend({ kind: 'heard', text: p }); checkWin(p); }
server.listen(PORT, () => console.log(`the unbirthday tea on http://localhost:${PORT}\n  password: ${cfg.password.join(' ')}\n  mics: audio/venv/bin/python audio/transcribe_parakeet.py --device UMC1820 --server http://localhost:${PORT}`));
