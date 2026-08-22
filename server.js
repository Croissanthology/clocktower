#!/usr/bin/env node
// clocktower model wrangler — zero-dependency node server.
// spawns headless `claude -p` (your subscription) for up to 4 AI players.
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const ROOT = __dirname;
const GAME = path.join(ROOT, 'game');
const STATE_FILE = path.join(GAME, 'state.json');
const RULES_FILE = path.join(ROOT, 'rules', 'trouble-brewing.md');
const TEMPLATE_FILE = path.join(ROOT, 'prompts', 'system-template.md');
const PORT = process.env.PORT || 4141;
const MODEL = process.env.CT_MODEL || 'sonnet';
const EFFORT = process.env.CT_EFFORT || 'medium'; // thinking on by default, both backends
const TIMEOUT_MS = 120000;
const PLAY_RATE = process.env.CT_RATE || '1.2';

// TB roles that CHOOSE at night (info roles just receive). firstNight: acts on night 1 too.
const NIGHT_CHOOSERS = {
  'imp': { firstNight: false, prompt: 'choose a player to kill (action type demon_kill). you may target yourself to pass demonhood to a minion.' },
  'fortune teller': { firstNight: true, prompt: 'choose 2 players to check for the demon (action type night_ability, both names in target).' },
  'poisoner': { firstNight: true, prompt: 'choose a player to poison (action type night_ability).' },
  'monk': { firstNight: false, prompt: 'choose a player (not yourself) to protect from the demon (action type night_ability).' },
  'butler': { firstNight: true, prompt: 'choose a player to be your master (action type night_ability).' },
};

fs.mkdirSync(GAME, { recursive: true });

let state = { players: [], queue: [], ctx: [], humans: [], seats: [], phase: { time: 'night', day: 1 }, hadFirstDay: false, turnN: 0, seq: 0, speaking: null, paused: false };
try {
  const disk = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  state = Object.assign(state, disk);
  state.speaking = null;
  // migrate pre-ctx saves: old stream entries become ctx; everyone is caught up
  if (!state.ctx) {
    state.ctx = (disk.stream || []).flatMap(s => {
      if (s.type === 'say') return [{ kind: 'say', player: s.player, to: s.to, text: s.text, ts: s.ts }];
      const out = [];
      if (s.town) out.push({ kind: 'town', text: s.town, ts: s.ts });
      if (s.note) out.push({ kind: 'note', text: s.note, ts: s.ts });
      return out;
    });
  }
  if (!state.humans) state.humans = [];
  if (state.paused === undefined) state.paused = false;
  if (!state.seats) state.seats = state.players.map(p => p.name).concat(state.humans.map(h => h.name));
  if (state.hadFirstDay === undefined) state.hadFirstDay = true;
  for (const p of state.players) {
    if (p.ctxCursor === undefined) p.ctxCursor = state.ctx.length;
    if (!p.history) p.history = [];
  }
} catch (e) {}

function save() { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 1)); }
function player(name) { return state.players.find(p => p.name === name); }
function log(name, entry) {
  fs.appendFileSync(path.join(GAME, `log-${name.replace(/[^\w-]/g, '_')}.jsonl`),
    JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
}
function nightN() { return state.hadFirstDay ? state.phase.day + 1 : state.phase.day; }
function phaseLabel() { return state.phase.time === 'day' ? `day ${state.phase.day}` : `night ${nightN()}`; }
function ctxAppend(e) { state.ctx.push({ ...e, ts: Date.now() }); }

function roster() {
  const humans = state.humans.filter(h => h.name).map(h => `${h.name} (mic ${h.mic})`).join(', ');
  const ais = state.players.map(p => p.name).join(', ');
  return `AT THE TABLE — human players: ${humans || '(to be announced)'}. AI players: ${ais}.`;
}

function seatingFor(p) {
  const seats = (state.seats || []).filter(Boolean);
  const i = seats.indexOf(p.name);
  if (i < 0 || seats.length < 3) return '(seating not set yet — ask margot if it matters to your ability)';
  const rot = seats.slice(i).concat(seats.slice(0, i));
  return `Clockwise around the table, starting from you: ${rot.join(' → ')} → back to you.\n` +
    `Your immediate neighbors are ${rot[1]} (clockwise) and ${rot[rot.length - 1]} (counter-clockwise). ` +
    `This is the real physical circle at the table; abilities that mention neighbors or adjacency use it.`;
}

function sysPromptPath(p) {
  const file = path.join(GAME, `sys-${p.name.replace(/[^\w-]/g, '_')}.md`);
  const rules = fs.existsSync(RULES_FILE) ? fs.readFileSync(RULES_FILE, 'utf8')
    : '(rules file missing — play by standard Trouble Brewing rules from your own knowledge)';
  const tpl = fs.readFileSync(TEMPLATE_FILE, 'utf8');
  // shared prefix (template+roster+rules) is byte-identical across players (prompt cache); card+seating last
  fs.writeFileSync(file, tpl.replace('{{ROSTER}}', roster()).replace('{{RULES}}', rules)
    .replace(/{{NAME}}/g, p.name).replace('{{CARD}}', p.card).replace('{{SEATING}}', seatingFor(p)));
  return file;
}

function extractRoleRules(role) {
  try {
    const rules = fs.readFileSync(RULES_FILE, 'utf8');
    const re = new RegExp(`^\\*\\*${role.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\*\\*[\\s\\S]*?(?=\\n\\s*\\n|$)`, 'im');
    const m = rules.match(re);
    return m ? m[0].trim() : '';
  } catch (e) { return ''; }
}

// extract the first balanced {...} from model output, string-aware
function extractJson(text) {
  const start = text.indexOf('{');
  if (start < 0) throw new Error('no JSON object in output');
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (esc) { esc = false; continue; }
    if (inStr) { if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return JSON.parse(text.slice(start, i + 1)); }
  }
  throw new Error('unbalanced JSON in output');
}

function applyEdits(p, edits) {
  const applied = [], failed = [];
  for (const e of Array.isArray(edits) ? edits : []) {
    if (!e || typeof e.replace !== 'string') continue;
    const find = typeof e.find === 'string' ? e.find : '';
    if (find === '') { p.sheet = (p.sheet ? p.sheet + '\n' : '') + e.replace; applied.push(e); continue; }
    if (p.sheet.includes(find)) { p.sheet = p.sheet.replace(find, e.replace); applied.push(e); }
    else failed.push(find);
  }
  if (failed.length) {
    p.feedback = `your last turn's edit(s) FAILED — this text was not found in your sheet (copy exactly next time): ${failed.map(f => JSON.stringify(f.slice(0, 80))).join(' | ')}`;
  }
  return { applied, failed };
}

// render ctx entries this player hasn't seen into transcript lines
function ctxSlice(p) {
  const unseen = state.ctx.slice(p.ctxCursor || 0);
  p.ctxCursor = state.ctx.length;
  return unseen.map(e => {
    if (e.kind === 'say') return `${e.player} (AI, aloud)${e.to && e.to !== 'town' ? ' to ' + e.to : ''}: ${e.text}`;
    if (e.kind === 'note') return `MARGOT: ${e.text}`;
    if (e.kind === 'phase') return `GAME: ${e.text}`;
    return e.text;
  }).join('\n');
}

function buildUserMessage(p, push) {
  const head = push.night ? `--NIGHT-- ${push.label} · tick ${push.turnN} · the town is silent, eyes closed` : `--DAY-- ${push.label} · tick ${push.turnN}`;
  const parts = [
    head,
    `reminder: you are ${p.name}, secretly the ${p.role} (${p.alignment}).`,
    `=== your sheet, exactly as you left it ===\n${p.sheet || '(empty — write it via edits with find:"")'}`,
  ];
  if (p.feedback) parts.push(`=== correction from last turn ===\n${p.feedback}`);
  if (push.ctxText) parts.push(`=== heard since your last turn (live mics + AI speakers; may contain transcription errors) ===\n${push.ctxText}`);
  if (push.priv) parts.push(`=== MARGOT, PRIVATELY — only you receive this ===\n${push.priv}`);
  parts.push(`=== respond now with the JSON contract only ===`);
  return parts.join('\n\n');
}

// --- openrouter backend: any model id containing "/" is routed there ---
function openrouterKey() {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  try { return fs.readFileSync(path.join(ROOT, 'openrouter.key'), 'utf8').trim(); } catch (e) { return ''; }
}
function callOpenrouter(model, sysText, userMsg, cb) {
  const key = openrouterKey();
  if (!key) return cb(new Error('no openrouter key — paste it into clocktower/openrouter.key (one line) or set OPENROUTER_API_KEY'), '');
  const bodyStr = JSON.stringify({ model, max_tokens: 8000, reasoning: { effort: EFFORT },
    messages: [{ role: 'system', content: sysText }, { role: 'user', content: userMsg }] });
  const req = https.request({ hostname: 'openrouter.ai', path: '/api/v1/chat/completions', method: 'POST',
    headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) },
    timeout: TIMEOUT_MS }, res => {
    let d = ''; res.on('data', c => d += c); res.on('end', () => {
      try {
        const j = JSON.parse(d);
        if (j.error) return cb(new Error('openrouter: ' + String(j.error.message || JSON.stringify(j.error)).slice(0, 200)), '');
        const m = (j.choices || [])[0]?.message || {};
        cb(null, (m.content || '').trim(), '', (m.reasoning || m.reasoning_content || '').trim());
      } catch (e) { cb(new Error('openrouter bad response: ' + d.slice(0, 200)), ''); }
    });
  });
  req.on('timeout', () => req.destroy(new Error('openrouter timeout')));
  req.on('error', e => cb(e, ''));
  req.write(bodyStr); req.end();
}

// claude CLI stream-json → {text, thinking}. falls back to treating the blob as plain text.
function parseStreamJson(stdout) {
  let text = '', thinking = '', parsedAny = false;
  for (const line of stdout.split('\n')) {
    const l = line.trim();
    if (!l.startsWith('{')) continue;
    try {
      const j = JSON.parse(l);
      parsedAny = true;
      if (j.type === 'assistant' && j.message && Array.isArray(j.message.content)) {
        for (const b of j.message.content) {
          if (b.type === 'thinking' && b.thinking) thinking += b.thinking + '\n';
          if (b.type === 'text' && b.text) text += b.text;
        }
      }
      if (j.type === 'result' && typeof j.result === 'string') text = j.result;
    } catch (e) {}
  }
  if (!parsedAny) return { text: stdout, thinking: '' };
  return { text: text.trim(), thinking: thinking.trim() };
}

function callModel(p, msg, cb) { // cb(err, raw, stderr, thinking)
  let model = p.model || MODEL;
  // "or:" prefix forces the openrouter path (visible chain of thought, billed to the key) —
  // otherwise anthropic models always ride the claude subscription, never the openrouter key
  const forceOR = model.startsWith('or:');
  if (forceOR) model = model.slice(3);
  else if (model.startsWith('anthropic/')) model = model.split('/')[1].replace(/:.*$/, '');
  const sysFile = sysPromptPath(p);
  if (model.includes('/')) {
    callOpenrouter(model, fs.readFileSync(sysFile, 'utf8'), msg, cb);
    return null;
  }
  const args = ['-p', '--model', model, '--effort', EFFORT,
    '--system-prompt-file', sysFile, '--no-session-persistence', '--disallowedTools', '*',
    '--output-format', 'stream-json', '--verbose'];
  const child = execFile('claude', args, { cwd: GAME, timeout: TIMEOUT_MS, maxBuffer: 50 * 1024 * 1024 },
    (err, stdout, stderr) => {
      const { text, thinking } = parseStreamJson((stdout || '').trim());
      cb(err, text, stderr || '', thinking);
    });
  child.stdin.write(msg);
  child.stdin.end();
  return child;
}

function pushToPlayer(p, push, attempt = 1) {
  p.status = 'thinking';
  p.parseError = null;
  save();
  const msg = buildUserMessage(p, push);
  callModel(p, msg, (err, raw, stderr, thinking) => {
      p.status = 'idle';
      log(p.name, { push, raw, thinking: thinking || '', stderr: (stderr || '').slice(0, 2000), err: err ? String(err) : null });
      if (err && !raw) {
        if (attempt < 2) { setTimeout(() => pushToPlayer(p, push, attempt + 1), 2000); return; }
        p.parseError = `claude call failed twice: ${String(err).slice(0, 300)}`; save(); return;
      }
      try {
        const out = extractJson(raw);
        p.feedback = '';
        p.lastStatus = out.status || '';
        const res = applyEdits(p, out.edits);
        if (out.action && out.action.type) p.action = { ...out.action, ts: Date.now(), seen: false };
        if (typeof out.ask === 'string' && out.ask.trim()) p.ask = { text: out.ask.trim(), ts: Date.now() };
        const says = [];
        for (const u of Array.isArray(out.say) ? out.say : []) {
          if (!u || !u.text) continue;
          says.push(u);
          // the town is silent at night: night speech is recorded for margot but never queued
          if (!push.night) {
            const q = { id: ++state.seq, player: p.name, to: u.to || 'town', text: u.text, ts: Date.now(), file: null };
            state.queue.push(q);
            preSynth(q);
          }
        }
        p.history.push({
          turn: push.turnN, phase: push.label, status: p.lastStatus,
          say: says, sayHeld: push.night && says.length > 0,
          action: out.action || null, ask: (typeof out.ask === 'string' ? out.ask.trim() : ''),
          edits: res.applied.length, editsFailed: res.failed.length,
          input: msg, thinking: thinking || '', ts: Date.now(),
        });
      } catch (e) {
        p.parseError = `${e.message} — raw kept in log; re-push or edit by hand`;
        p.lastStatus = raw.slice(0, 400);
        p.history.push({ turn: push.turnN, phase: push.label, status: '(tick lost: bad JSON)', say: [], action: null, ask: '', edits: 0, editsFailed: 0, input: msg, thinking: thinking || '', ts: Date.now() });
      }
      save();
    });
}

function doPushTargets(targets, priv, force) {
  if ((state.paused && !force) || !targets.length) return [];
  state.turnN++;
  const base = { turnN: state.turnN, night: state.phase.time === 'night', label: phaseLabel() };
  for (const p of targets) pushToPlayer(p, { ...base, ctxText: ctxSlice(p), priv: priv[p.name] || '' });
  save();
  return targets.map(p => p.name);
}

function deliverQueued(id) {
  const i = state.queue.findIndex(q => q.id === id);
  if (i < 0) return;
  const q = state.queue[i];
  ctxAppend({ kind: 'say', player: q.player, to: q.to, text: q.text });
  state.queue.splice(i, 1);
  save();
}

// server-side speech: voices/synth.sh + afplay at 1.1x, else macOS `say`
const SYNTH = path.join(ROOT, 'voices', 'synth.sh');
let speakChild = null;
let modelsCache = { ts: 0, list: [] };

// --- mic monitoring: the server owns the transcriber process ---
const AUDIO_PY = path.join(ROOT, 'audio', 'venv', 'bin', 'python');
let micProc = null;
let mics = { running: false, device: '', channels: 0, levels: [], speech_ago: [], ts: 0, err: '' };
let inputsCache = { ts: 0, list: [] };

function micStart(device, channels) {
  if (micProc) return;
  mics = { running: true, device, channels, levels: [], speech_ago: [], ts: 0, err: '' };
  let errTail = '';
  micProc = execFile(AUDIO_PY, [path.join(ROOT, 'audio', 'transcribe.py'),
    '--device', device, '--channels', String(channels), '--server', `http://localhost:${PORT}`],
    { maxBuffer: 50 * 1024 * 1024 }, (err) => {
      micProc = null;
      mics.running = false;
      if (err && !err.killed) mics.err = (errTail.trim().split('\n').pop() || String(err)).slice(0, 200);
    });
  micProc.stderr.on('data', d => { errTail = (errTail + d).slice(-2000); });
  micProc.stdout.on('data', () => {});
}
function micStop() {
  if (micProc) try { micProc.kill('SIGTERM'); } catch (e) {}
  // also catch transcribers this server process doesn't own (orphans from a restart, terminal runs)
  execFile('pkill', ['-f', 'audio/transcribe.py'], () => {});
  mics.running = false;
}
function voiceFor(idx, p) {
  if (p.voice) return p.voice;
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'voices', 'mapping.json'), 'utf8'))[idx] || ''; }
  catch (e) { return ''; }
}
// synthesize text to a file (kokoro/piper/say via synth.sh, macOS say as fallback). cb(err, file)
function synthToFile(voice, text, outfile, cb) {
  const sayTo = (useVoice) => {
    const aiff = outfile.replace(/\.wav$/, '.aiff');
    const args = useVoice ? ['-v', useVoice, '-o', aiff, text] : ['-o', aiff, text];
    execFile('say', args, { timeout: 60000 }, (err) => {
      if (err && useVoice) return sayTo('');
      cb(err, aiff);
    });
  };
  if (fs.existsSync(SYNTH) && voice) {
    execFile(SYNTH, [voice, outfile, text], { timeout: 90000 }, (err) => {
      if (err) return sayTo(voice);
      cb(null, outfile);
    });
  } else sayTo(voice);
}

// playback: dedicated output channel on the mixer (UMC1820) when CT_AUDIO_DEVICE is set, else default output
function playFile(file, channel, done) {
  const finish = () => { speakChild = null; done(); };
  const py = path.join(ROOT, 'audio', 'venv', 'bin', 'python');
  const pc = path.join(ROOT, 'audio', 'play_channel.py');
  if (process.env.CT_AUDIO_DEVICE && fs.existsSync(pc)) {
    speakChild = execFile(fs.existsSync(py) ? py : 'python3',
      [pc, '--device', process.env.CT_AUDIO_DEVICE, '--channel', String(channel), '--rate', PLAY_RATE, file],
      { timeout: 60000 }, (err) => {
        if (err) { speakChild = execFile('afplay', ['-r', PLAY_RATE, file], { timeout: 60000 }, finish); return; }
        finish();
      });
  } else {
    speakChild = execFile('afplay', ['-r', PLAY_RATE, file], { timeout: 60000 }, finish);
  }
}

// pre-synthesize a queued utterance so speak plays instantly, whatever the engine's latency
function preSynth(q) {
  const idx = state.players.findIndex(p => p.name === q.player);
  if (idx < 0) return;
  const out = path.join(GAME, `speech-${q.id}.wav`);
  synthToFile(voiceFor(idx, state.players[idx]), q.text, out, (err, file) => {
    if (!err) { q.file = file; save(); }
  });
}

// night choosers pre-load their decision the instant night falls
function pushNightChoosers() {
  const choosers = state.players.filter(p => {
    const c = NIGHT_CHOOSERS[p.role];
    return c && (c.firstNight || nightN() > 1) && p.status !== 'thinking';
  });
  const priv = {};
  for (const p of choosers) {
    priv[p.name] = `night ${nightN()} has fallen. decide your night action NOW so it is ready the instant the storyteller wakes you: ${NIGHT_CHOOSERS[p.role].prompt} margot will silently show your decision to the storyteller when your turn comes. anything you learn in return may only reach you at dawn — margot avoids typing at night so as not to leak information to the table. wait patiently; it will come.`;
  }
  doPushTargets(choosers, priv);
}

function togglePhase() {
  if (state.phase.time === 'day') {
    state.phase.time = 'night';
    ctxAppend({ kind: 'phase', text: `night ${nightN()} falls` });
    pushNightChoosers();
  } else {
    if (state.hadFirstDay) state.phase.day++;
    state.hadFirstDay = true;
    state.phase.time = 'day';
    ctxAppend({ kind: 'phase', text: `dawn — day ${state.phase.day}` });
  }
  save();
}

function body(req) {
  return new Promise(res => {
    let d = '';
    req.on('data', c => d += c);
    req.on('end', () => { try { res(JSON.parse(d || '{}')); } catch (e) { res({}); } });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(fs.readFileSync(path.join(ROOT, 'public', 'index.html')));
  }
  if (req.method === 'GET' && url.pathname === '/api/state') {
    return send(200, { ...state, phaseLabel: phaseLabel(), rulesLoaded: fs.existsSync(RULES_FILE), model: MODEL, mics });
  }
  if (req.method === 'POST' && url.pathname === '/api/miclevels') {
    const b = await body(req);
    // any transcriber posting levels counts as running (server-spawned, terminal-run, or orphaned)
    Object.assign(mics, { running: true, levels: b.levels || [], speech_ago: b.speech_ago || [], channels: b.channels || mics.channels, device: b.device || mics.device, ts: Date.now() });
    return send(200, { ok: true });
  }
  if (req.method === 'POST' && url.pathname === '/api/mic/start') {
    const b = await body(req);
    if (!b.device) return send(400, { err: 'device required' });
    micStart(b.device, +b.channels || 1);
    return send(200, { ok: true });
  }
  if (req.method === 'POST' && url.pathname === '/api/mic/stop') {
    micStop();
    return send(200, { ok: true });
  }
  if (req.method === 'GET' && url.pathname === '/api/inputs') {
    if (Date.now() - inputsCache.ts < 30000) return send(200, { inputs: inputsCache.list });
    execFile(AUDIO_PY, ['-c', 'import json,sounddevice as sd; print(json.dumps([{"idx":i,"name":d["name"],"in":d["max_input_channels"]} for i,d in enumerate(sd.query_devices()) if d["max_input_channels"]>0]))'],
      { timeout: 10000 }, (err, stdout) => {
        if (!err) try { inputsCache = { ts: Date.now(), list: JSON.parse(stdout) }; } catch (e) {}
        send(200, { inputs: inputsCache.list });
      });
    return;
  }
  // live whisper transcription lands here: {mic: <1-based channel>, text: "..."}
  if (req.method === 'POST' && url.pathname === '/api/hear') {
    const b = await body(req);
    const t = String(b.text || '').trim();
    // echo guard: while an AI is speaking, table mics mostly pick up the AI's own speaker —
    // that text is already in context via delivery, so drop it instead of double-hearing it
    if (state.speaking && process.env.CT_ECHO_GUARD !== '0') return send(200, { ok: true, dropped: 'ai-speaking' });
    if (t) {
      const h = state.humans.find(x => x.mic == b.mic);
      ctxAppend({ kind: 'town', text: `${h && h.name ? h.name : 'mic ' + b.mic}: ${t}` });
      save();
    }
    return send(200, { ok: true });
  }
  if (req.method === 'GET' && url.pathname === '/api/models') {
    if (Date.now() - modelsCache.ts < 3600e3 && modelsCache.list.length) return send(200, { models: modelsCache.list });
    https.get({ hostname: 'openrouter.ai', path: '/api/v1/models', timeout: 8000 }, r => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => {
        try { modelsCache = { ts: Date.now(), list: JSON.parse(d).data.map(m => m.id).sort() }; } catch (e) {}
        send(200, { models: modelsCache.list });
      });
    }).on('error', () => send(200, { models: modelsCache.list }));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/speak') {
    const b = await body(req);
    if (b.stop) { if (speakChild) try { speakChild.kill('SIGKILL'); } catch (e) {} state.speaking = null; save(); return send(200, { ok: true }); }
    const q = state.queue.find(x => x.id === b.id);
    if (!q) return send(404, { err: 'gone' });
    if (state.speaking) return send(409, { err: 'already speaking' });
    const idx = state.players.findIndex(p => p.name === q.player);
    const pl = state.players[idx] || {};
    state.speaking = { id: q.id, player: q.player }; save();
    const onDone = () => {
      const wasStopped = !state.speaking || state.speaking.id !== q.id;
      state.speaking = null;
      if (!wasStopped) deliverQueued(q.id); else save();
    };
    const startPlayback = (file) => playFile(file, pl.channel || idx + 1, onDone);
    if (q.file && fs.existsSync(q.file)) startPlayback(q.file);
    else synthToFile(voiceFor(idx, pl), q.text, path.join(GAME, `speech-${q.id}.wav`), (err, file) => {
      if (err) { state.speaking = null; save(); return; }
      startPlayback(file);
    });
    return send(200, { ok: true });
  }
  if (req.method === 'POST' && url.pathname === '/api/setup') {
    const b = await body(req);
    // every deal archives the previous game whole — nothing is ever deleted
    if (state.players.length || state.ctx.length) {
      const dir = path.join(GAME, 'archive', new Date().toISOString().replace(/[:.]/g, '-'));
      fs.mkdirSync(dir, { recursive: true });
      for (const f of fs.readdirSync(GAME)) {
        if (/^(state\.json|log-.*\.jsonl|sys-.*\.md|GRIMOIRE\.md)$/.test(f)) {
          try { fs.renameSync(path.join(GAME, f), path.join(dir, f)); } catch (e) {}
        }
      }
    }
    const used = {};
    state.players = (b.players || []).slice(0, 4).map(p => {
      const base = (p.model || MODEL).split('/').pop();
      used[base] = (used[base] || 0) + 1;
      const auto = used[base] > 1 ? `${base}-${used[base]}` : base;
      const name = (p.name || '').trim() || auto;
      const roleRules = extractRoleRules(p.role);
      return { name, role: p.role || '?', alignment: p.alignment || 'good', model: p.model || '', voice: p.voice || '',
        card: `Your secret character: ${p.role} (${p.alignment}).\n\n${roleRules || 'Your exact ability is in the rules above — reread it now.'}\n\n${p.persona || ''}`.trim(),
        status: 'idle', lastStatus: '', action: null, ask: null, parseError: null, feedback: '', ctxCursor: 0,
        sheet: `ME: ${name}, ${p.role} (${p.alignment}). ${p.persona || ''}\n\nREADS\n(none yet)\n\nPLAYERS\n(unknown yet)\n\nEVENTS\n(game not started)`,
        history: [],
      };
    });
    state.humans = (b.humans || []).map((h, i) => ({ name: (h.name || '').trim(), mic: h.mic || i + 1 })).filter(h => h.name);
    state.seats = (b.seats && b.seats.length) ? b.seats : state.players.map(p => p.name).concat(state.humans.map(h => h.name));
    for (const f of fs.readdirSync(GAME)) if (/^speech-.*\.(wav|aiff)$/.test(f)) try { fs.unlinkSync(path.join(GAME, f)); } catch (e) {}
    state.queue = []; state.ctx = []; state.turnN = 0; state.seq = 0;
    state.phase = { time: 'night', day: 1 }; state.hadFirstDay = false; state.speaking = null;
    state.players.forEach(sysPromptPath);
    ctxAppend({ kind: 'phase', text: 'night 1 falls — the game begins' });
    save();
    pushNightChoosers();
    return send(200, { ok: true });
  }
  if (req.method === 'POST' && url.pathname === '/api/push') {
    const b = await body(req);
    if (b.town) ctxAppend({ kind: 'town', text: b.town });
    if (b.note) ctxAppend({ kind: 'note', text: b.note });
    const targets = (b.targets || []).map(player).filter(Boolean).filter(p => p.status !== 'thinking');
    const priv = typeof b.private === 'string'
      ? Object.fromEntries(targets.map(p => [p.name, b.private]))
      : (b.private || {});
    const pushed = doPushTargets(targets, priv, !!b.force);
    return send(202, { pushed, turn: state.turnN });
  }
  if (req.method === 'POST' && url.pathname === '/api/queue') {
    const b = await body(req);
    const i = state.queue.findIndex(q => q.id === b.id);
    if (i >= 0) { if (b.remove) state.queue.splice(i, 1); else deliverQueued(b.id); }
    save(); return send(200, { ok: true });
  }
  if (req.method === 'POST' && url.pathname === '/api/edit') {
    const b = await body(req);
    const p = player(b.player);
    if (!p) return send(404, { err: 'no such player' });
    if (b.field === 'sheet') p.sheet = b.value;
    if (b.field === 'voice') p.voice = b.value;
    if (b.field === 'channel') p.channel = +b.value || null;
    if (b.field === 'card') { p.card = b.value; sysPromptPath(p); }
    if (b.field === 'actionSeen' && p.action) p.action.seen = true;
    if (b.field === 'askSeen') p.ask = null;
    save(); return send(200, { ok: true });
  }
  // reorder seats mid-game (people move chairs); system prompts pick it up on next push
  if (req.method === 'POST' && url.pathname === '/api/seats') {
    const b = await body(req);
    if (Array.isArray(b.seats)) { state.seats = b.seats.filter(Boolean); state.players.forEach(sysPromptPath); save(); }
    return send(200, { ok: true, seats: state.seats });
  }
  if (req.method === 'GET' && url.pathname.startsWith('/api/sys/')) {
    const p = player(decodeURIComponent(url.pathname.slice('/api/sys/'.length)));
    if (!p) return send(404, { err: 'no such player' });
    return send(200, { sys: fs.readFileSync(sysPromptPath(p), 'utf8') });
  }
  // update the mic→name roster mid-game, no reset (system prompts pick it up on next push)
  if (req.method === 'POST' && url.pathname === '/api/humans') {
    const b = await body(req);
    state.humans = (b.humans || []).map((h, i) => ({ name: (h.name || '').trim(), mic: h.mic || i + 1 })).filter(h => h.name);
    state.players.forEach(sysPromptPath);
    save(); return send(200, { ok: true, humans: state.humans });
  }
  if (req.method === 'POST' && url.pathname === '/api/pause') {
    const b = await body(req);
    state.paused = b.paused !== undefined ? !!b.paused : !state.paused;
    save(); return send(200, { paused: state.paused });
  }
  if (req.method === 'POST' && url.pathname === '/api/phase') {
    const b = await body(req);
    if (b.toggle) togglePhase();
    else { state.phase = { time: b.time || state.phase.time, day: +b.day || state.phase.day }; save(); }
    return send(200, { ok: true, phase: state.phase });
  }
  send(404, { err: 'not found' });
});

server.listen(PORT, () => console.log(`clocktower wrangler on http://localhost:${PORT}  (model=${MODEL}, effort=${EFFORT})`));
