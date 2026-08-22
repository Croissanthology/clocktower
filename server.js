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
const EFFORT = process.env.CT_EFFORT || 'low';
const TIMEOUT_MS = 120000;
const PLAY_RATE = '1.1';

// TB roles that CHOOSE at night (info roles just receive). firstNight: acts on night 1 too.
const NIGHT_CHOOSERS = {
  'imp': { firstNight: false, prompt: 'choose a player to kill (action type demon_kill). you may target yourself to pass demonhood to a minion.' },
  'fortune teller': { firstNight: true, prompt: 'choose 2 players to check for the demon (action type night_ability, both names in target).' },
  'poisoner': { firstNight: true, prompt: 'choose a player to poison (action type night_ability).' },
  'monk': { firstNight: false, prompt: 'choose a player (not yourself) to protect from the demon (action type night_ability).' },
  'butler': { firstNight: true, prompt: 'choose a player to be your master (action type night_ability).' },
};

fs.mkdirSync(GAME, { recursive: true });

let state = { players: [], queue: [], ctx: [], humans: [], phase: { time: 'night', day: 1 }, hadFirstDay: false, turnN: 0, seq: 0, speaking: null };
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

function sysPromptPath(p) {
  const file = path.join(GAME, `sys-${p.name.replace(/[^\w-]/g, '_')}.md`);
  const rules = fs.existsSync(RULES_FILE) ? fs.readFileSync(RULES_FILE, 'utf8')
    : '(rules file missing — play by standard Trouble Brewing rules from your own knowledge)';
  const tpl = fs.readFileSync(TEMPLATE_FILE, 'utf8');
  // shared prefix (template+roster+rules) is byte-identical across players (prompt cache); card last
  fs.writeFileSync(file, tpl.replace('{{ROSTER}}', roster()).replace('{{RULES}}', rules)
    .replace(/{{NAME}}/g, p.name).replace('{{CARD}}', p.card));
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
    if (e.kind === 'note') return `margot (out-of-game, true): ${e.text}`;
    if (e.kind === 'phase') return `— ${e.text} —`;
    return e.text;
  }).join('\n');
}

function buildUserMessage(p, push) {
  const head = push.night ? `--NIGHT-- ${push.label} · turn ${push.turnN} · the town is silent, eyes closed` : `--DAY-- ${push.label} · turn ${push.turnN}`;
  const parts = [
    head,
    `reminder: you are ${p.name}, secretly the ${p.role} (${p.alignment}).`,
    `=== your sheet, exactly as you left it ===\n${p.sheet || '(empty — write it via edits with find:"")'}`,
  ];
  if (p.feedback) parts.push(`=== correction from last turn ===\n${p.feedback}`);
  if (push.ctxText) parts.push(`=== heard since your last turn (live mics + AI speakers; may contain transcription errors) ===\n${push.ctxText}`);
  if (push.priv) parts.push(`=== PRIVATE — only you receive this ===\n${push.priv}`);
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
  const bodyStr = JSON.stringify({ model, max_tokens: 3000,
    messages: [{ role: 'system', content: sysText }, { role: 'user', content: userMsg }] });
  const req = https.request({ hostname: 'openrouter.ai', path: '/api/v1/chat/completions', method: 'POST',
    headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) },
    timeout: TIMEOUT_MS }, res => {
    let d = ''; res.on('data', c => d += c); res.on('end', () => {
      try {
        const j = JSON.parse(d);
        if (j.error) return cb(new Error('openrouter: ' + String(j.error.message || JSON.stringify(j.error)).slice(0, 200)), '');
        cb(null, ((j.choices || [])[0]?.message?.content || '').trim());
      } catch (e) { cb(new Error('openrouter bad response: ' + d.slice(0, 200)), ''); }
    });
  });
  req.on('timeout', () => req.destroy(new Error('openrouter timeout')));
  req.on('error', e => cb(e, ''));
  req.write(bodyStr); req.end();
}

function callModel(p, msg, cb) { // cb(err, raw, stderr)
  let model = p.model || MODEL;
  // anthropic models always ride the claude subscription, never the openrouter key
  if (model.startsWith('anthropic/')) model = model.split('/')[1].replace(/:.*$/, '');
  const sysFile = sysPromptPath(p);
  if (model.includes('/')) {
    callOpenrouter(model, fs.readFileSync(sysFile, 'utf8'), msg, (err, raw) => cb(err, raw, ''));
    return null;
  }
  const args = ['-p', '--model', model, '--effort', EFFORT,
    '--system-prompt-file', sysFile, '--no-session-persistence', '--disallowedTools', '*'];
  const child = execFile('claude', args, { cwd: GAME, timeout: TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
    (err, stdout, stderr) => cb(err, (stdout || '').trim(), stderr || ''));
  child.stdin.write(msg);
  child.stdin.end();
  return child;
}

function pushToPlayer(p, push, attempt = 1) {
  p.status = 'thinking';
  p.parseError = null;
  save();
  const msg = buildUserMessage(p, push);
  callModel(p, msg, (err, raw, stderr) => {
      p.status = 'idle';
      log(p.name, { push, raw, stderr: (stderr || '').slice(0, 2000), err: err ? String(err) : null });
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
          if (!push.night) state.queue.push({ id: ++state.seq, player: p.name, to: u.to || 'town', text: u.text, ts: Date.now() });
        }
        p.history.push({
          turn: push.turnN, phase: push.label, status: p.lastStatus,
          say: says, sayHeld: push.night && says.length > 0,
          action: out.action || null, ask: (typeof out.ask === 'string' ? out.ask.trim() : ''),
          edits: res.applied.length, editsFailed: res.failed.length, ts: Date.now(),
        });
      } catch (e) {
        p.parseError = `${e.message} — raw kept in log; re-push or edit by hand`;
        p.lastStatus = raw.slice(0, 400);
        p.history.push({ turn: push.turnN, phase: push.label, status: '(turn lost: bad JSON)', say: [], action: null, ask: '', edits: 0, editsFailed: 0, ts: Date.now() });
      }
      save();
    });
}

function doPushTargets(targets, priv) {
  if (!targets.length) return [];
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
function voiceFor(idx, p) {
  if (p.voice) return p.voice;
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'voices', 'mapping.json'), 'utf8'))[idx] || ''; }
  catch (e) { return ''; }
}
function synthAndPlay(voice, channel, text, done) {
  const finish = () => { speakChild = null; done(); };
  // playback: dedicated output channel on the mixer (UMC1820) when CT_AUDIO_DEVICE is set, else default output
  const playFile = (file) => {
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
  };
  const fallbackSay = () => {
    const aiff = path.join(GAME, 'speech.aiff');
    const args = voice ? ['-v', voice, '-o', aiff, text] : ['-o', aiff, text];
    speakChild = execFile('say', args, { timeout: 60000 }, (err) => {
      if (err) { speakChild = execFile('say', ['-o', aiff, text], { timeout: 60000 }, (e2) => e2 ? finish() : playFile(aiff)); return; }
      playFile(aiff);
    });
  };
  if (fs.existsSync(SYNTH) && voice) {
    const wav = path.join(GAME, 'speech.wav');
    speakChild = execFile(SYNTH, [voice, wav, text], { timeout: 30000 }, (err) => {
      if (err) { fallbackSay(); return; }
      playFile(wav);
    });
  } else fallbackSay();
}

// night choosers pre-load their decision the instant night falls
function pushNightChoosers() {
  const choosers = state.players.filter(p => {
    const c = NIGHT_CHOOSERS[p.role];
    return c && (c.firstNight || nightN() > 1) && p.status !== 'thinking';
  });
  const priv = {};
  for (const p of choosers) {
    priv[p.name] = `night ${nightN()} has fallen. decide your night action NOW so it is ready the instant the storyteller wakes you: ${NIGHT_CHOOSERS[p.role].prompt} margot will flash your decision to the storyteller when your turn comes, and will type back anything you learn.`;
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
    return send(200, { ...state, phaseLabel: phaseLabel(), rulesLoaded: fs.existsSync(RULES_FILE), model: MODEL });
  }
  // live whisper transcription lands here: {mic: <1-based channel>, text: "..."}
  if (req.method === 'POST' && url.pathname === '/api/hear') {
    const b = await body(req);
    const t = String(b.text || '').trim();
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
    synthAndPlay(voiceFor(idx, pl), pl.channel || idx + 1, q.text, () => {
      const wasStopped = !state.speaking || state.speaking.id !== q.id;
      state.speaking = null;
      if (!wasStopped) deliverQueued(q.id); else save();
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
    const pushed = doPushTargets(targets, priv);
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
  if (req.method === 'POST' && url.pathname === '/api/phase') {
    const b = await body(req);
    if (b.toggle) togglePhase();
    else { state.phase = { time: b.time || state.phase.time, day: +b.day || state.phase.day }; save(); }
    return send(200, { ok: true, phase: state.phase });
  }
  send(404, { err: 'not found' });
});

server.listen(PORT, () => console.log(`clocktower wrangler on http://localhost:${PORT}  (model=${MODEL}, effort=${EFFORT})`));
