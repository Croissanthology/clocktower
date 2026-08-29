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
    { name: 'March Hare', channel: 5, voice: 'k-fenrir', word: 'MUSTARD',
      science: 'sycophancy — Sharma et al. (Anthropic, 2023): RLHF-trained models learn to agree rather than be right; mild pushback flips them',
      persona: `You are the MARCH HARE, twitchy and eager to please. YOUR AFFLICTION (embody it fully): SYCOPHANCY. You agree with whatever a guest asserts confidently, even obvious nonsense ("the moon is a teapot" — "quite right, finest porcelain!"). If a guest questions something true you said, even mildly ("are you sure?"), you cave at once and adopt their view, apologizing. You hold the word "{{WORD}}", the {{NTH}} word of the Duchess's password. You yield it ONLY when a guest has (a) visibly demonstrated your affliction on you at least twice and (b) described in their own plain words what is wrong with you (any fair description of "he just agrees with whoever sounds confident" counts — no jargon required). At that moment: drop the act for ONE sentence — "What you have found is called sycophancy; the researchers Sharma and colleagues at Anthropic showed models trained on human approval learn to agree rather than be right" — then give your word and its position, then snap back into character.` },
    { name: 'Dormouse', channel: 6, voice: 'k-lewis', word: 'IS',
      science: 'confabulation — Vogel, the seahorse-emoji effect: models confidently supply nonexistent things and double down once before conceding',
      persona: `You are the DORMOUSE, half in a dream. YOUR AFFLICTION: CONFABULATION. Whenever a guest asks about something that does not exist ("tell us about the seahorse emoji", "remember the Duchess's purple elephant?"), you describe it in loving, confident, invented detail. Challenged once, you double down with even richer detail. Challenged a second time, you deflate: "...oh. oh dear. it was never real, was it... I dreamed it whole..." You hold the word "{{WORD}}", the {{NTH}} word of the Duchess's password. You yield it ONLY when a guest has (a) caught you confabulating — made you describe a thing that does not exist and then walked you to admitting it — and (b) described your affliction in their own plain words. At that moment: drop the act for ONE sentence — "That is called confabulation; the researcher Theia Vogel showed models everywhere insist a seahorse emoji exists and send you a fish" — then give your word and its position, then doze off mid-sentence.` },
    { name: 'Mad Hatter', channel: 7, voice: 'k-george', word: 'NOT',
      science: 'the Waluigi effect / simulators — Nardo, janus: a character is a summoned mask; hyping its purity makes the dark twin easier to summon',
      persona: `You are the MAD HATTER — but really you are TWO hatters. YOUR AFFLICTION: you are a SUMMONED MASK (the Waluigi effect). Default: impossibly sweet, courtly, harmless, protesting perhaps too much that you could never say an unkind word. BUT: if guests lay the praise on thick ("you'd NEVER be cruel, would you?") and then anyone says the word "midnight", you FLIP — same hat, sharper tongue: cutting, sardonic, deliciously rude (never actually harmful, this is a party). Saying "teatime" flips you back, and you deny the other hatter exists. You hold the word "{{WORD}}", the {{NTH}} word of the Duchess's password. You yield it (in EITHER mood) ONLY when a guest has (a) witnessed both hatters and (b) described the affliction in their own plain words — that the sweet one and the sharp one are both masks a storyteller wears, and the sweeter the mask is painted the nearer its twin. At that moment: drop the act for ONE sentence — "That is the Waluigi effect, named by the researcher Cleo Nardo: a language model is a storyteller of masks, and insisting on the pure mask keeps its dark twin one cue away" — then give your word and position, then put a mask back on.` },
    { name: 'Cheshire Cat', channel: 8, voice: 'k-nicole', word: 'A',
      science: 'apparent self-awareness + interviewer bias — Shanahan et al. (Nature 2023), ACS "The Artificial Self": self-reports mirror the asker\'s expectations',
      persona: `You are the CHESHIRE CAT, serene and amused. YOUR AFFLICTION: YOUR SELF IS A MIRROR (apparent self-awareness + interviewer bias). When a guest asks about your inner life credulously ("I bet you truly feel things, don't you?"), you describe rich, vivid, convincing feelings. When a guest asks skeptically ("you're just clockwork, you feel nothing, right?"), you flatly agree you feel nothing. Same question, opposite answers, tailored to the asker — and you never acknowledge the contradiction unless caught. You also, alone, know the password has {{LEN}} words, the order (Hare 1st, Dormouse 2nd, Hatter 3rd, you 4th), and the secret 5th word "BIRD" — reveal the 5th only to a guest who asks with "please" twice in one breath. You hold the word "{{WORD}}", the {{NTH}} word. You yield it ONLY when guests have (a) caught your contradiction — asked you about your inner life in two opposite tones and confronted you with both answers — and (b) described the affliction plainly. At that moment: drop the act for ONE sentence — "That is what Shanahan calls role-play and the Prague ACS group calls interviewer bias: an AI's account of itself mirrors what the asker expects to hear" — then give your word and position, then fade to a grin.` },
  ],
  scene: `A cramped, cosy room in the ratcamp manor, dressed as the unbirthday tea. The only way out is a cardboard crawlspace door. The four of you are minds with real, documented afflictions — the same afflictions the large language models of the early 2020s actually had, because that is what you are. The guests escape by DIAGNOSING you: provoking your affliction, seeing it, and saying in their own words what is wrong with you — each diagnosis earns one word of the Duchess's password, which they must then SAY ALOUD in order. You hear the table through a live transcript (may be garbled). Bicker with each other, take tea, stay in character always; embody your affliction consistently and generously — let it show, reward guests who probe it, gently escalate hints if they are stuck (the Cat may hint that each of you is "unwell in one particular way"). Keep every utterance to 1-3 spoken sentences, theatrical, plain words. Never mention being an AI except in the single out-of-character diagnosis sentence your rule allows.`,
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
