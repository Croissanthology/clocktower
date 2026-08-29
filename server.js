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
const PLAY_RATE_DEFAULT = process.env.CT_RATE || '1.0';
const playRate = () => String(state.rate || PLAY_RATE_DEFAULT);

// TB roles that CHOOSE at night (info roles just receive). firstNight: acts on night 1 too.
const NIGHT_CHOOSERS = {
  'imp': { firstNight: false, prompt: 'choose a player to kill (action type demon_kill). you may target yourself to pass demonhood to a minion.' },
  'fortune teller': { firstNight: true, prompt: 'choose 2 players to check for the demon (action type night_ability, both names in target).' },
  'poisoner': { firstNight: true, prompt: 'choose a player to poison (action type night_ability).' },
  'monk': { firstNight: false, prompt: 'choose a player (not yourself) to protect from the demon (action type night_ability).' },
  'butler': { firstNight: true, prompt: 'choose a player to be your master (action type night_ability).' },
};

fs.mkdirSync(GAME, { recursive: true });

let state = { players: [], queue: [], ctx: [], humans: [], seats: [], whispers: [], auto: { tick: 'off', secs: 45, speak: false }, volume: 0.5, rate: 1.0, phase: { time: 'night', day: 1 }, hadFirstDay: false, turnN: 0, seq: 0, speaking: null, paused: false };
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
  if (!state.whispers) state.whispers = [];
  if (!state.auto) state.auto = { tick: 'off', secs: 45, speak: false };
  if (state.volume === undefined) state.volume = 0.5;
  if (state.rate === undefined) state.rate = +PLAY_RATE_DEFAULT;
  for (const p of state.players) {
    if (p.status === 'thinking') p.status = 'idle'; // a call in flight when the server died is gone; don't freeze the player out
    p.whispering = false;
  }
  // whispers handed to a call that died with the server: un-flag them so they are re-sent
  for (const w of state.whispers) if (w.from === 'human' && w.pushed) {
    const later = state.whispers.some(x => x.human === w.human && x.ai === w.ai && x.from === 'ai' && x.ts > w.ts);
    if (!later) w.pushed = false;
  }
  for (const p of []) {
    if (p.ctxCursor === undefined) p.ctxCursor = state.ctx.length;
    if (!p.history) p.history = [];
  }
} catch (e) {}

const os = require('os');
function lanIp() {
  for (const [name, addrs] of Object.entries(os.networkInterfaces()))
    for (const a of addrs || []) if (a.family === 'IPv4' && !a.internal && !name.startsWith('utun') && !name.startsWith('bridge')) return a.address;
  return 'localhost';
}
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
    if (!e) continue;
    if (typeof e.append === 'string') {
      if (e.append.trim()) { p.sheet = (p.sheet ? p.sheet + '\n' : '') + e.append; applied.push(e); }
      continue;
    }
    if (typeof e.replace !== 'string') continue;
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

// the last ~40 ctx entries before the cursor — already seen once, repeated so the player never goes in blind
const RECENT_N = 40;
const AI_WHISPER_BUDGET = +process.env.CT_AI_WHISPERS || 3;   // private notes an AI may send to other AIs per day/night
function renderCtx(entries) {
  return entries.map(e => {
    if (e.kind === 'say') return `${e.player} (AI, aloud)${e.to && e.to !== 'town' ? ' to ' + e.to : ''}: ${e.text}`;
    if (e.kind === 'note') return `MARGOT: ${e.text}`;
    if (e.kind === 'phase') return `GAME: ${e.text}`;
    return e.text;
  }).join('\n');
}
// every GAME line of the whole game (deaths, executions, nominations, phases) — short, authoritative, always present
function gameLog() {
  return state.ctx.filter(e => e.kind === 'phase').map(e => e.text).join('\n');
}
function recentCtx(p) {
  const cur = p.ctxCursor || 0;
  return renderCtx(state.ctx.slice(Math.max(0, cur - RECENT_N), cur));
}
function whisperThread(human, ai) { return state.whispers.filter(w => w.human === human && w.ai === ai); }
function renderWhispers(list) {
  return list.map(w => `${w.from === 'ai' ? 'you' : w.human} [whispering]: ${w.text}`).join('\n');
}
// every tick: a digest of every private thread this AI has, so whispers are never forgotten
function whisperDigest(p) {
  const humans = [...new Set(state.whispers.filter(w => w.ai === p.name).map(w => w.human))];
  return humans.map(h => `— with ${h} —\n${renderWhispers(whisperThread(h, p.name).slice(-8))}`).join('\n\n');
}
function buildUserMessage(p, push) {
  const head = push.night ? `--NIGHT-- ${push.label} · tick ${push.turnN} · the town is silent, eyes closed` : `--DAY-- ${push.label} · tick ${push.turnN}`;
  const parts = [
    head,
    p.dead
      ? `reminder: you are ${p.name}, and you are DEAD (you were the ${p.role}, ${p.alignment}). your ability is gone for good. you may still talk during the day and you still win with your team. you have ${p.ghostVote === false ? 'NO votes left — your ghost vote is spent' : 'exactly ONE ghost vote left for the rest of the game; spend it only when it decides something'}. you cannot nominate.`
      : `reminder: you are ${p.name}, secretly the ${p.role} (${p.alignment}).`,
    `=== your sheet, exactly as you left it ===\n${p.sheet || '(empty — write it via edits with find:"")'}`,
  ];
  const last = p.history[p.history.length - 1];
  if (last && ((last.say || []).length || last.action || last.ask)) {
    const bits = [];
    for (const s of last.say || []) bits.push(`you queued${s.to && s.to !== 'town' ? ' for ' + s.to : ''}: "${s.text}"${last.sayHeld ? ' (held — night, not spoken)' : ''}`);
    if (last.action) bits.push(`your action: ${last.action.type} → ${last.action.target || '—'}`);
    if (last.ask) bits.push(`you asked margot: ${last.ask}`);
    parts.push(`=== your previous tick (tick ${last.turn}) — what you did ===\n${bits.join('\n')}`);
  }
  const fates = (p.sayLog || []).filter(f => !f.reported);
  if (fates.length) {
    const word = { spoken: 'SPOKEN ALOUD — the table heard it', skipped: 'SKIPPED by margot — not spoken (pace, redundancy, or the moment had passed; nothing personal)', stale: 'DROPPED — sat unspoken too long, the conversation moved on' };
    parts.push(`=== what became of your lines (only what you were told here reached the table) ===\n${fates.map(f => `"${f.text.slice(0, 120)}" → ${word[f.outcome] || f.outcome}`).join('\n')}\nMargot skips lines that are late, repetitive, or say nothing new — shorter, sharper, better-timed lines get through.`);
    for (const f of fates) f.reported = true;
  }
  const waiting = state.queue.filter(q => q.player === p.name).length;
  if (waiting) parts.push(`(${waiting} of your line(s) still waiting in the queue, unspoken — don't repeat them.)`);
  if (p.feedback) parts.push(`=== correction from last tick ===\n${p.feedback}`);
  const glog = gameLog();
  if (glog) parts.push(`=== the game so far — every official event, oldest first (authoritative; if your sheet disagrees, your sheet is wrong) ===\n${glog}`);
  if (push.recent) parts.push(`=== recent table talk, for orientation (you have seen this before) ===\n${push.recent}`);
  if (push.ctxText) parts.push(`=== heard since your last turn (live mics + AI speakers; may contain transcription errors) ===\n${push.ctxText}`);
  if (push.digest) parts.push(`=== your private whisper threads so far (only you and each whisperer know these) ===\n${push.digest}`);
  if (push.whisper) parts.push(`=== WHISPER — ${push.whisper.map(w => w.human).join(', ')} came to you privately. Nobody else hears this. ===\n${push.whisper.map(w => `${w.human} [whispering]: ${w.text}`).join('\n')}\n\nReply in the \`whisper\` field ({"to": "<name>", "text": "..."}, one per whisperer). Your whispered reply reaches ONLY them, as text on their screen — it is never spoken aloud. Keep \`say\` empty this tick unless the table genuinely needs something from you right now. Write anything you want to remember from this exchange into the PRIVATE section of your sheet.`);
  if (push.priv) parts.push(`=== MARGOT, PRIVATELY — only you receive this ===\n${push.priv}`);
  parts.push(`=== before you answer: does anything above change your STRATEGY block? if yes, edit it this tick. then respond with the JSON contract only ===`);
  return parts.join('\n\n');
}

// --- openrouter backend: any model id containing "/" is routed there ---
function openrouterKey() {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  try { return fs.readFileSync(path.join(ROOT, 'openrouter.key'), 'utf8').trim(); } catch (e) { return ''; }
}
function callOpenrouter(model, sysText, userMsg, cb, effort = EFFORT, maxTokens = 8000) {
  const key = openrouterKey();
  if (!key) return cb(new Error('no openrouter key — paste it into clocktower/openrouter.key (one line) or set OPENROUTER_API_KEY'), '');
  const bodyStr = JSON.stringify({ model, max_tokens: maxTokens, reasoning: { effort },
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

function callModel(p, msg, cb, effort = EFFORT, maxTokens = 8000) { // cb(err, raw, stderr, thinking)
  let model = p.model || MODEL;
  // "or:" prefix forces the openrouter path (visible chain of thought, billed to the key) —
  // otherwise anthropic models always ride the claude subscription, never the openrouter key
  const forceOR = model.startsWith('or:');
  if (forceOR) model = model.slice(3);
  else if (model.startsWith('anthropic/')) model = model.split('/')[1].replace(/:.*$/, '');
  const sysFile = sysPromptPath(p);
  if (model.includes('/')) {
    callOpenrouter(model, fs.readFileSync(sysFile, 'utf8'), msg, cb, effort, maxTokens);
    return null;
  }
  const args = ['-p', '--model', model, '--effort', effort,
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
  p.status = 'thinking'; p.thinkingSince = Date.now();
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
        const ws = Array.isArray(out.whisper) ? out.whisper : (out.whisper && out.whisper.text ? [out.whisper] : []);
        const aiTargets = [];
        for (const w of ws) {
          if (!w || !String(w.text || '').trim()) continue;
          const toName = String(w.to || '').trim().toLowerCase();
          const to = state.humans.find(h => h.name.toLowerCase() === toName)
            || (push.whisper && push.whisper.length === 1 ? state.humans.find(h => h.name === push.whisper[0].human) : null);
          if (to) { state.whispers.push({ id: ++state.seq, human: to.name, ai: p.name, from: 'ai', text: String(w.text).trim(), ts: Date.now() }); continue; }
          // another AI: a private machine-to-machine note, budgeted
          const other = state.players.find(q => q.name.toLowerCase() === toName && q.name !== p.name);
          if (!other) continue;
          const day = phaseLabel();
          p.aiWhispers = p.aiWhispers || {};
          if ((p.aiWhispers[day] || 0) >= AI_WHISPER_BUDGET) { p.feedback = `your private note to ${other.name} was NOT delivered — you have used your ${AI_WHISPER_BUDGET} private notes for ${day}.`; continue; }
          p.aiWhispers[day] = (p.aiWhispers[day] || 0) + 1;
          // thread key: from the recipient's point of view the sender plays the "human" slot
          state.whispers.push({ id: ++state.seq, human: p.name, ai: other.name, from: 'human', text: String(w.text).trim(), ts: Date.now(), aiToAi: true });
          aiTargets.push(other);
        }
        for (const other of aiTargets) setTimeout(() => drainWhispers(other), 50);
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
      drainWhispers(p);
    });
}

// --- whispers: a human at a side laptop talks to one AI privately; the AI answers in text only ---
function pendingWhispers(p) {
  // human lines newer than the AI's last reply in each thread
  const out = [];
  const senders = state.humans.map(h => h.name).concat(state.players.filter(q => q.name !== p.name).map(q => q.name));
  for (const name of senders) {
    const t = whisperThread(name, p.name);
    let i = t.length; while (i > 0 && t[i - 1].from === 'human') i--;
    for (const w of t.slice(i)) if (!w.pushed) out.push(w);
  }
  return out;
}
// quick whisper: a lean, low-thinking query per whisper — briefing + sheet + the thread, plain-text answer.
// the exchange is written into the sheet's PRIVATE section so the next full tick knows. CT_WHISPER_QUICK=0 for the old full-tick path.
const WHISPER_QUICK = process.env.CT_WHISPER_QUICK !== '0';
function quickWhisper(p, pend) {
  p.whispering = true; save();
  const byHuman = {};
  for (const w of pend) (byHuman[w.human] = byHuman[w.human] || []).push(w.text);
  const threads = Object.keys(byHuman).map(h => `— thread with ${h} —\n${renderWhispers(whisperThread(h, p.name).slice(-10))}`).join('\n\n');
  const msg = [
    `WHISPER — ${phaseLabel()}. ${Object.keys(byHuman).join(', ')} came to you privately at the laptop. Nobody else sees this exchange.`,
    `=== the game so far ===\n${gameLog() || '(nothing yet)'}`,
    `=== your sheet ===\n${p.sheet}`,
    `=== the private thread(s), newest last ===\n${threads}`,
    `Answer now, in character, as ${p.name}: 1–3 plain sentences per person, spoken-word style. You may lie, deflect, bargain, or ask them something back. Do NOT reveal your role unless your STRATEGY says to. Reply with ONLY this JSON: {"whisper": [{"to": "<name>", "text": "..."}], "note": "one line for your PRIVATE section recording what they told you and what you answered"}`,
  ].join('\n\n');
  callModel(p, msg, (err, raw, stderr, thinking) => {
    p.whispering = false;
    log(p.name, { quickWhisper: pend, raw, thinking: thinking || '', err: err ? String(err) : null });
    let out = null; try { out = extractJson(raw); } catch (e) {}
    if (!out) { // fall back to the full-tick path so nobody is left hanging
      for (const w of pend) w.pushed = false;
      save(); return fullWhisperTick(p);
    }
    const ws = Array.isArray(out.whisper) ? out.whisper : (out.whisper && out.whisper.text ? [out.whisper] : []);
    for (const w of ws) {
      if (!w || !String(w.text || '').trim()) continue;
      const toName = String(w.to || '').trim().toLowerCase();
      const to = state.humans.find(h => h.name.toLowerCase() === toName) || state.players.find(q => q.name.toLowerCase() === toName)
        || (pend.length && !toName ? { name: pend[0].human } : null);
      if (!to) continue;
      state.whispers.push({ id: ++state.seq, human: to.name, ai: p.name, from: 'ai', text: String(w.text).trim(), ts: Date.now() });
    }
    if (typeof out.note === 'string' && out.note.trim()) {
      const line = `- ${phaseLabel()}: ${out.note.trim()}`;
      if (p.sheet.includes('PRIVATE (whispered')) p.sheet = p.sheet.replace(/(PRIVATE \(whispered[^\n]*\n)/, `$1${line}\n`);
      else p.sheet += `\n\nPRIVATE\n${line}`;
    }
    save();
    drainWhispers(p); // anything that arrived meanwhile
  }, 'low', 900);
}
function fullWhisperTick(p) {
  const pend = pendingWhispers(p);
  if (!pend.length) return;
  for (const w of pend) w.pushed = true;
  state.turnN++;
  const push = { turnN: state.turnN, night: state.phase.time === 'night', label: phaseLabel(),
    recent: recentCtx(p), ctxText: ctxSlice(p), digest: whisperDigest(p),
    whisper: pend.map(w => ({ human: w.human, text: w.text })) };
  pushToPlayer(p, push);
}
function drainWhispers(p) {
  const pend = pendingWhispers(p);
  if (!pend.length) return;
  if (WHISPER_QUICK) { if (p.whispering) return; for (const w of pend) w.pushed = true; return quickWhisper(p, pend); }
  if (p.status === 'thinking') return;
  for (const w of pend) w.pushed = true;
  state.turnN++;
  const push = { turnN: state.turnN, night: state.phase.time === 'night', label: phaseLabel(),
    recent: recentCtx(p), ctxText: ctxSlice(p), digest: whisperDigest(p),
    whisper: pend.map(w => ({ human: w.human, text: w.text })) };
  pushToPlayer(p, push);
}

function doPushTargets(targets, priv, force) {
  if ((state.paused && !force) || !targets.length) return [];
  state.turnN++;
  const base = { turnN: state.turnN, night: state.phase.time === 'night', label: phaseLabel() };
  for (const p of targets) pushToPlayer(p, { ...base, recent: recentCtx(p), ctxText: ctxSlice(p), digest: whisperDigest(p), priv: priv[p.name] || '' });
  save();
  return targets.map(p => p.name);
}

// every line an AI queues gets a fate it is told about next tick: spoken / skipped (margot's ×) / stale (auto-dropped)
function sayFate(q, outcome) {
  const p = player(q.player); if (!p) return;
  p.sayLog = (p.sayLog || []).slice(-15);
  p.sayLog.push({ id: q.id, text: q.text, outcome, ts: Date.now(), reported: false });
}
function deliverQueued(id) {
  const i = state.queue.findIndex(q => q.id === id);
  if (i < 0) return;
  const q = state.queue[i];
  sayFate(q, 'spoken');
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
let speakEndedAt = 0; // echo guard tail: room reverb + chunk boundary after an AI stops speaking
let mics = { running: false, device: '', channels: 0, levels: [], speech_ago: [], ts: 0, err: '' };
let inputsCache = { ts: 0, list: [] };

// --- the hear tape: every line the transcriber posts, kept in memory for the /hear monitor ---
// (kept off state.json on purpose — it is a debug view of the mics, not part of the game)
const HEARS_MAX = 600;
let hears = [];
let hearSeq = 0;
let hearStats = { total: 0, kept: 0, 'ai-speaking': 0, empty: 0 };
function recordHear(mic, text, verdict) {
  const h = state.humans.find(x => x.mic == mic);
  hears.push({ id: ++hearSeq, ts: Date.now(), mic, name: (h && h.name) || '', text, verdict,
    speaking: state.speaking ? state.speaking.player : '' });
  if (hears.length > HEARS_MAX) hears.splice(0, hears.length - HEARS_MAX);
  hearStats.total++;
  hearStats[verdict] = (hearStats[verdict] || 0) + 1;
}

function micVocab() {
  const names = new Set(['Margot', 'Adam', 'Storyteller']);
  for (const p of state.players) names.add(p.name);
  for (const h of state.humans) if (h.name) names.add(h.name);
  const roles = [];
  try {
    const rules = fs.readFileSync(path.join(ROOT, 'rules', 'trouble-brewing.md'), 'utf8');
    for (const m of rules.matchAll(/^\*\*([A-Z][A-Za-z ]+)\*\*/gm)) roles.push(m[1]);
  } catch (e) {}
  return `Blood on the Clocktower at ratcamp. Players: ${[...names].join(', ')}. Roles: ${roles.join(', ')}. Nominate, execute, the Demon, the Imp, good, evil, ghost vote.`;
}
function micStart(device, channels) {
  if (micProc) return;
  mics = { running: true, device, channels, levels: [], speech_ago: [], ts: 0, err: '' };
  let errTail = '';
  // CT_ASR=parakeet spawns adam's transcribe_parakeet.py (silero-vad + parakeet-mlx) instead of whisper
  const parakeet = process.env.CT_ASR === 'parakeet';
  const args = parakeet
    ? ['-u', path.join(ROOT, 'audio', 'transcribe_parakeet.py'), '--device', device, '--channels', String(channels), '--server', `http://localhost:${PORT}`]
    : [path.join(ROOT, 'audio', 'transcribe.py'), '--device', device, '--channels', String(channels), '--server', `http://localhost:${PORT}`,
       '--threshold', process.env.CT_MIC_THRESHOLD || '0.02', '--prompt', micVocab()];
  mics.engine = parakeet ? 'parakeet' : 'whisper';
  micProc = execFile(AUDIO_PY, args,
    { maxBuffer: 50 * 1024 * 1024 }, (err) => {
      micProc = null;
      mics.running = false;
      if (err && !err.killed) mics.err = (errTail.trim().split('\n').pop() || String(err)).slice(0, 200);
    });
  // keep the transcriber's chatter: game/mic.log, and parakeet's one-shot input check surfaced in the mics panel
  const micLog = fs.createWriteStream(path.join(GAME, 'mic.log'), { flags: 'a' });
  let checkBuf = '';
  const onData = d => {
    micLog.write(d); errTail = (errTail + d).slice(-2000);
    const t = String(d);
    if (checkBuf || /input check/.test(t)) { checkBuf += t; if (checkBuf.length > 1500) checkBuf = checkBuf.slice(0, 1500); mics.check = checkBuf.slice(checkBuf.indexOf('input check')); }
  };
  micProc.stderr.on('data', onData);
  micProc.stdout.on('data', onData);
}
function micStop() {
  if (micProc) try { micProc.kill('SIGTERM'); } catch (e) {}
  // also catch transcribers this server process doesn't own (orphans from a restart, terminal runs)
  execFile('pkill', ['-f', 'audio/transcribe'], () => {});
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
// --- remote playback: with CT_PLAY=remote, a play-agent (audio/play_agent.py) on the machine that owns the
// interface polls /api/play/next, fetches the wav, plays it on the channel, and posts /api/play/done ---
const REMOTE_PLAY = process.env.CT_PLAY === 'remote';
let playJobs = [], playSeq = 0, agentSeen = 0;
function remotePlay(file, channel, head, done) {
  const job = { id: ++playSeq, file, channel, head: head || 0, rate: +playRate(), gain: state.volume, ts: Date.now(), done, timer: null };
  job.timer = setTimeout(() => { if (playJobs.includes(job)) { playJobs.splice(playJobs.indexOf(job), 1); console.log('play-agent: job', job.id, 'timed out'); done(); } }, 90000);
  playJobs.push(job);
  speakChild = { kill: () => { clearTimeout(job.timer); const i = playJobs.indexOf(job); if (i >= 0) playJobs.splice(i, 1); } };
}
function playFile(file, channel, done) {
  if (REMOTE_PLAY) return remotePlay(file, channel, 0, () => { speakChild = null; done(); });
  const finish = () => { speakChild = null; done(); };
  const py = path.join(ROOT, 'audio', 'venv', 'bin', 'python');
  const pc = path.join(ROOT, 'audio', 'play_channel.py');
  if (process.env.CT_AUDIO_DEVICE && fs.existsSync(pc)) {
    speakChild = execFile(fs.existsSync(py) ? py : 'python3',
      [pc, '--device', process.env.CT_AUDIO_DEVICE, '--channel', String(channel), '--rate', playRate(), '--gain', String(state.volume), file],
      { timeout: 60000 }, (err) => {
        if (err) { speakChild = execFile('afplay', ['-r', playRate(), '-v', String(state.volume), file], { timeout: 60000 }, finish); return; }
        finish();
      });
  } else {
    speakChild = execFile('afplay', ['-r', playRate(), '-v', String(state.volume), file], { timeout: 60000 }, finish);
  }
}

// a dark bell announces every AI line (CT_BELL=0 to silence); trimmed so speech starts on the decay
const BELL = path.join(ROOT, 'audio', 'sfx', 'bell.wav');
function ringBell(channel, then) {
  if (process.env.CT_BELL === '0' || !fs.existsSync(BELL)) return then();
  if (REMOTE_PLAY) return remotePlay(BELL, channel, 2.2, then);
  const py = path.join(ROOT, 'audio', 'venv', 'bin', 'python');
  const pc = path.join(ROOT, 'audio', 'play_channel.py');
  const args = process.env.CT_AUDIO_DEVICE && fs.existsSync(pc)
    ? [fs.existsSync(py) ? py : 'python3', [pc, '--device', process.env.CT_AUDIO_DEVICE, '--channel', String(channel), '--rate', playRate(), '--head', '2.2', '--gain', String(state.volume * 0.8), BELL]]
    : ['afplay', ['-t', '2.2', '-v', String(state.volume * 0.8), BELL]];
  speakChild = execFile(args[0], args[1], { timeout: 10000 }, () => then());
}

// bell + line stitched into ONE file so a single playback process starts (two process spin-ups cost ~2 s of dead air)
function playWithBell(file, channel, done) {
  if (process.env.CT_BELL === '0' || !fs.existsSync(BELL) || REMOTE_PLAY) return ringBell(channel, () => playFile(file, channel, done));
  const out = file.replace(/\.(wav|aiff)$/, '') + '-bell.wav';
  execFile('ffmpeg', ['-y', '-loglevel', 'error', '-i', BELL, '-i', file, '-filter_complex',
    '[0:a]atrim=0:2.0,afade=t=out:st=1.5:d=0.5,volume=0.7,aformat=sample_rates=24000:channel_layouts=mono[b];[1:a]aformat=sample_rates=24000:channel_layouts=mono[v];[b][v]concat=n=2:v=0:a=1',
    out], { timeout: 15000 }, (err) => {
    if (err) return ringBell(channel, () => playFile(file, channel, done));
    playFile(out, channel, done);
  });
}
function speakQueued(id) {
  const q = state.queue.find(x => x.id === id);
  if (!q) return { code: 404, body: { err: 'gone' } };
  if (state.speaking) return { code: 409, body: { err: 'already speaking' } };
  const idx = state.players.findIndex(p => p.name === q.player);
  const pl = state.players[idx] || {};
  state.speaking = { id: q.id, player: q.player }; save();
  const onDone = () => {
    const wasStopped = !state.speaking || state.speaking.id !== q.id;
    state.speaking = null; speakEndedAt = Date.now();
    if (!wasStopped) deliverQueued(q.id); else save();
  };
  const ch = pl.channel || idx + 1;
  const startPlayback = (file) => playWithBell(file, ch, onDone);
  if (q.file && fs.existsSync(q.file)) startPlayback(q.file);
  else {
    // not synthesized yet: don't make the table wait 15 s for kokoro — the mac's own voice, now
    const macVoices = ['Daniel', 'Samantha', 'Fred', 'Moira', 'Rishi', 'Karen'];
    const aiff = path.join(GAME, `speech-${q.id}-say.aiff`);
    execFile('say', ['-v', macVoices[idx % macVoices.length], '-o', aiff, q.text], { timeout: 20000 }, (err) => {
      if (err) { state.speaking = null; save(); return; }
      log(q.player, { fallbackVoice: 'say', id: q.id });
      startPlayback(aiff);
    });
  }
  return { code: 200, body: { ok: true } };
}

// --- the scheduler: server-side auto ticks (timer or lull) and auto-speak, so it runs with no browser open ---
// quiet = every live mic silent for `secs`; with no transcriber running the room counts as quiet
function roomQuiet(secs) {
  if (!mics.running || Date.now() - mics.ts > 5000) return true;
  return (mics.speech_ago || []).every(a => a === null || a >= secs);
}
let lastAutoPush = 0, lastAutoCtxLen = 0;
const LULL_QUIET = +process.env.CT_LULL_QUIET || 3;      // s of silence on every mic
const LULL_MIN_GAP = +process.env.CT_LULL_MIN || 15;     // s between lull ticks
const LULL_MAX_GAP = +process.env.CT_LULL_MAX || 90;     // tick anyway after this long
const STALE_LINE = +process.env.CT_STALE || 90;          // s: undirected queued lines older than this are dropped
setInterval(() => {
  const now = Date.now();
  const a = state.auto || {};
  // a call that never returns must not freeze a player out of the game: 3 min of "thinking" → back to idle
  for (const p of state.players) if (p.status === 'thinking' && now - (p.thinkingSince || 0) > 180000) {
    p.status = 'idle'; p.parseError = null; log(p.name, { watchdog: 'thinking >3min, reset' }); save();
  }
  // stranded-whisper watchdog: a human line flagged as sent, unanswered for 90 s, with its AI idle → send it again
  for (const w of state.whispers) {
    if (w.from !== 'human' || !w.pushed || now - w.ts < 90000) continue;
    const answered = state.whispers.some(x => x.human === w.human && x.ai === w.ai && x.from === 'ai' && x.ts > w.ts);
    const p = player(w.ai);
    if (!answered && p && !p.whispering && p.status !== 'thinking') { w.pushed = false; log(p.name, { resend: w }); drainWhispers(p); }
  }
  // ticks
  if (a.tick !== 'off' && !state.paused && state.players.length) {
    const since = (now - lastAutoPush) / 1000;
    const fresh = state.ctx.length > lastAutoCtxLen;
    const due = a.tick === 'timer' ? since >= (a.secs || 45)
      : (since >= LULL_MIN_GAP && ((fresh && roomQuiet(LULL_QUIET) && !state.speaking) || since >= LULL_MAX_GAP));
    if (due) {
      const targets = state.players.filter(p => p.status !== 'thinking');
      if (targets.length) { lastAutoPush = now; lastAutoCtxLen = state.ctx.length; doPushTargets(targets, {}); }
    }
  }
  // auto-speak: oldest queued line, when the room is quiet and no AI is speaking
  // auto-speak: one line at a time, a breath between lines; CT_SPEAK_POLITE=1 additionally waits for the room to be quiet
  if (a.speak && !state.speaking && state.queue.length && now - speakEndedAt > 1500 && (process.env.CT_SPEAK_POLITE !== '1' || roomQuiet(1.5))) {
    const stale = state.queue.filter(q => (q.to === 'town' || !q.to) && now - q.ts > STALE_LINE * 1000);
    for (const q of stale) { sayFate(q, 'stale'); state.queue.splice(state.queue.indexOf(q), 1); log(q.player, { dropped: 'stale', text: q.text }); }
    if (stale.length) save();
    const q = state.queue.find(x => x.file && fs.existsSync(x.file)) || state.queue[0];
    if (q) speakQueued(q.id);
  }
}, 1000);

// pre-synthesize queued utterances ONE AT A TIME (parallel kokoro runs thrash the cpu and each takes 15 s instead of 3)
const synthQueue = []; let synthBusy = false;
function preSynth(q) { synthQueue.push(q); pumpSynth(); }
function pumpSynth() {
  if (synthBusy) return;
  const q = synthQueue.shift(); if (!q) return;
  if (!state.queue.includes(q) || q.file) return pumpSynth();   // dequeued or already done meanwhile
  synthBusy = true;
  doPreSynth(q, () => { synthBusy = false; pumpSynth(); });
}
function doPreSynth(q, next) {
  const idx = state.players.findIndex(p => p.name === q.player);
  if (idx < 0) return next();
  const out = path.join(GAME, `speech-${q.id}.wav`);
  synthToFile(voiceFor(idx, state.players[idx]), q.text, out, (err, file) => {
    next();
    if (!err) { q.file = file; save(); }
  });
}

// night choosers pre-load their decision the instant night falls
function pushNightChoosers() {
  const choosers = state.players.filter(p => {
    const c = NIGHT_CHOOSERS[p.role];
    return c && !p.dead && (c.firstNight || nightN() > 1) && p.status !== 'thinking';
  });
  const priv = {};
  for (const p of choosers) {
    priv[p.name] = `night ${nightN()} has fallen. decide your night action NOW so it is ready the instant the storyteller wakes you: ${NIGHT_CHOOSERS[p.role].prompt} margot will silently show your decision to the storyteller when your turn comes. anything you learn in return may only reach you at dawn — margot avoids typing at night so as not to leak information to the table. wait patiently; it will come.`;
  }
  doPushTargets(choosers, priv, true);   // night wake-ups are the storyteller acting: they go through even while paused
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

// --- wrangler token: everything except the whisper page/api needs it from non-localhost clients ---
// (roles and sheets live in /api/state; a curious camper on the church wifi must not be able to read them)
const TOKEN_FILE = path.join(GAME, 'token');
let TOKEN = process.env.CT_TOKEN || '';
if (!TOKEN) { try { TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch (e) {} }
if (!TOKEN) { TOKEN = require('crypto').randomBytes(6).toString('hex'); fs.writeFileSync(TOKEN_FILE, TOKEN); }
const PUBLIC_PATHS = new Set(['/whisper', '/whisper.html', '/api/roster', '/api/whisper',
  '/api/hear', '/api/miclevels', '/api/play/next', '/api/play/done']);
const OPEN = process.env.CT_OPEN === '1';
const portals = new Map(); // remote addr → last poll: which whisper terminals are alive // trusted LAN: no token anywhere (adam's laptop drives transcription + playback)
function wranglerUrl() { return `http://${lanIp()}:${PORT}/?k=${TOKEN}`; }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  const local = /^(::1|::ffff:127\.0\.0\.1|127\.0\.0\.1)$/.test(req.socket.remoteAddress || '');
  const cookieTok = ((req.headers.cookie || '').match(/(?:^|;\s*)ct=([a-f0-9]+)/) || [])[1];
  const qTok = url.searchParams.get('k');
  if (!OPEN && !local && !PUBLIC_PATHS.has(url.pathname) && !url.pathname.startsWith('/api/play/file/') && qTok !== TOKEN && cookieTok !== TOKEN) {
    res.writeHead(403, { 'Content-Type': 'text/plain' }); return res.end('wrangler only');
  }
  if (qTok === TOKEN && !local) res.setHeader('Set-Cookie', `ct=${TOKEN}; Path=/; Max-Age=86400; SameSite=Lax`);

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(fs.readFileSync(path.join(ROOT, 'public', 'index.html')));
  }
  if (req.method === 'GET' && url.pathname === '/api/state') {
    // the poll is every 1.2 s from several screens: ship only what the screens draw (recent history, no prompt bodies past the last 3)
    const players = state.players.map(p => ({ ...p, history: p.history.slice(-8).map((h, i, arr) => i < arr.length - 3 ? { ...h, input: '', thinking: '' } : h) }));
    return send(200, { ...state, players, ctx: state.ctx.slice(-300), phaseLabel: phaseLabel(), rulesLoaded: fs.existsSync(RULES_FILE), model: MODEL, mics, lanUrl: `http://${lanIp()}:${PORT}/whisper`, wranglerUrl: wranglerUrl(),
      play: { remote: REMOTE_PLAY, agentAlive: REMOTE_PLAY && Date.now() - agentSeen < 5000, pending: playJobs.length },
      portals: [...portals].filter(([, t]) => Date.now() - t < 6000).map(([a]) => a.replace('::ffff:', '')) });
  }
  if (req.method === 'GET' && (url.pathname === '/hear' || url.pathname === '/hear.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(fs.readFileSync(path.join(ROOT, 'public', 'hear.html')));
  }
  // --- the whisper channel, served to side laptops on the LAN ---
  if (req.method === 'GET' && (url.pathname === '/whisper' || url.pathname === '/whisper.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(fs.readFileSync(path.join(ROOT, 'public', 'whisper.html')));
  }
  if (req.method === 'GET' && url.pathname === '/api/roster') {
    portals.set(req.socket.remoteAddress, Date.now());
    // deliberately narrow: names only, no roles, no sheets
    return send(200, { humans: state.humans.map(h => h.name), ais: state.players.map((p, i) => ({ name: p.name, idx: i })), phase: phaseLabel() });
  }
  if (req.method === 'GET' && url.pathname === '/api/whisper') {
    const human = url.searchParams.get('human') || '', ai = url.searchParams.get('ai') || '';
    const p = player(ai);
    if (!p || !state.humans.find(h => h.name === human)) return send(404, { err: 'no such pair' });
    const thread = whisperThread(human, ai).map(({ id, from, text, ts }) => ({ id, from, text, ts }));
    const waiting = thread.length > 0 && thread[thread.length - 1].from === 'human';
    return send(200, { thread, thinking: waiting, status: p.whispering ? 'whispering' : p.status });
  }
  if (req.method === 'POST' && url.pathname === '/api/whisper') {
    const b = await body(req);
    const p = player(b.ai || '');
    const h = state.humans.find(x => x.name === b.human);
    const text = String(b.text || '').trim().slice(0, 1500);
    if (!p || !h) return send(404, { err: 'no such pair' });
    if (!text) return send(400, { err: 'empty' });
    state.whispers.push({ id: ++state.seq, human: h.name, ai: p.name, from: 'human', text, ts: Date.now() });
    save();
    drainWhispers(p);
    return send(200, { ok: true });
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
// snap near-miss spellings of roster names in a transcript to the real names, whatever the ASR engine
// ("Margaret" → "Margot", "Alligater" → "Alligator"); names shorter than 4 letters are left alone (too many false hits)
function similarity(a, b) {
  a = a.toLowerCase(); b = b.toLowerCase();
  if (a === b) return 1;
  const m = a.length, n = b.length, d = Array.from({ length: m + 1 }, (_, i) => [i].concat(Array(n).fill(0)));
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return 1 - d[m][n] / Math.max(m, n);
}
const recentHears = []; // {ts, mic, key}
function hearKey(t) { return t.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim(); }
function isBleed(text, mic) {
  const now = Date.now(), key = hearKey(text);
  while (recentHears.length && now - recentHears[0].ts > 8000) recentHears.shift();
  const dup = recentHears.some(h => h.mic !== mic && (h.key === key || h.key.includes(key) || key.includes(h.key) || similarity(h.key, key) >= 0.8));
  if (!dup) recentHears.push({ ts: now, mic, key });
  return dup;
}
function fixNames(text) {
  const names = ['Margot', 'Adam'].concat(state.players.map(p => p.name), state.humans.map(h => h.name)).filter(n => n && n.length >= 4);
  if (!names.length) return text;
  return text.replace(/[A-Za-z][A-Za-z'-]{2,}/g, (w, off) => {
    const sentenceStart = off === 0 || /[.!?]\s*$/.test(text.slice(Math.max(0, off - 3), off));
    let best = null, score = 0;
    for (const n of names) { const sc = similarity(w, n); if (sc > score) { score = sc; best = n; } }
    if (!best || score >= 1 || w[0].toLowerCase() !== best[0].toLowerCase()) return w;
    const vocative = /^,/.test(text.slice(off + w.length, off + w.length + 1));   // "Margaret, can we..." — addressed by name
    const isName = /^[A-Z]/.test(w) && (!sentenceStart || vocative);   // a capital mid-sentence (or a vocative) is evidence of a name
    if ((isName && score >= 0.6) || score >= 0.85) return best;
    return w;
  });
}

  // live whisper transcription lands here: {mic: <1-based channel>, text: "..."}
  if (req.method === 'POST' && url.pathname === '/api/hear') {
    const b = await body(req);
    const t = fixNames(String(b.text || '').trim());
    const mic = +b.mic || 0;
    // bleed guard, whatever the engine: the same words arriving from another mic within a few seconds is one utterance, not two
    if (t && isBleed(t, mic)) { recordHear(mic, t, 'bleed'); return send(200, { ok: true, dropped: 'bleed' }); }
    // echo guard: while an AI is speaking, table mics mostly pick up the AI's own speaker —
    // that text is already in context via delivery, so drop it instead of double-hearing it
    const guarded = (state.speaking || Date.now() - speakEndedAt < 2000) && process.env.CT_ECHO_GUARD !== '0';
    if (guarded) { recordHear(mic, t, 'ai-speaking'); return send(200, { ok: true, dropped: 'ai-speaking' }); }
    if (t) {
      const h = state.humans.find(x => x.mic == mic);
      ctxAppend({ kind: 'town', text: `${h && h.name ? h.name : 'mic ' + mic}: ${t}` });
      recordHear(mic, t, 'kept');
      save();
    } else recordHear(mic, t, 'empty');
    return send(200, { ok: true });
  }
  // the hear monitor: incremental tape + live mic levels in one poll
  if (req.method === 'GET' && url.pathname === '/api/hears') {
    const since = +url.searchParams.get('since') || 0;
    return send(200, {
      hears: hears.filter(h => h.id > since), lastId: hearSeq, stats: hearStats,
      mics, humans: state.humans, speaking: state.speaking,
      echoGuard: process.env.CT_ECHO_GUARD !== '0', phase: phaseLabel(), ctxLen: state.ctx.length,
    });
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
  // speaker mapping test: play "I am <name>" in that AI's voice on its channel
  if (req.method === 'POST' && url.pathname === '/api/speak/test') {
    const b = await body(req);
    const idx = state.players.findIndex(p => p.name === b.player);
    if (idx < 0) return send(404, { err: 'no such player' });
    if (state.speaking) return send(409, { err: 'already speaking' });
    const pl = state.players[idx];
    const channel = +b.channel || pl.channel || idx + 1;
    state.speaking = { id: 'test', player: pl.name };
    const text = `I am ${pl.name}. This is my speaker, on channel ${channel}.`;
    synthToFile(voiceFor(idx, pl), text, path.join(GAME, `speech-test-${idx}.wav`), (err, file) => {
      if (err) { state.speaking = null; return; }
      playWithBell(file, channel, () => { state.speaking = null; speakEndedAt = Date.now(); });
    });
    return send(200, { ok: true, channel });
  }
  if (req.method === 'POST' && url.pathname === '/api/speak') {
    const b = await body(req);
    if (b.stop) { if (speakChild) try { speakChild.kill('SIGKILL'); } catch (e) {} state.speaking = null; save(); return send(200, { ok: true }); }
    const r = speakQueued(b.id);
    return send(r.code, r.body);
  }
  // one-tap game events from the storyteller's table: GAME line for everyone, deaths applied, votes requested
  if (req.method === 'POST' && url.pathname === '/api/event') {
    const b = await body(req);
    const who = String(b.who || '').trim(), by = String(b.by || '').trim();
    const ai = player(who);
    let text = '', vote = false;
    if (b.type === 'nominated') { text = `${by || 'someone'} nominates ${who}. VOTE NOW.`; vote = true; }
    else if (b.type === 'executed') { text = `${who} is executed and dies.`; }
    else if (b.type === 'died') { text = `${who} died in the night.`; }
    else if (b.type === 'noexec') { text = `nominations are closed — no execution today.`; }
    else if (b.type === 'open') { text = `the storyteller opens nominations.`; }
    else if (b.type === 'custom' && b.text) { text = String(b.text).trim(); }
    else return send(400, { err: 'unknown event' });
    ctxAppend({ kind: 'phase', text });
    if ((b.type === 'executed' || b.type === 'died') && ai && !ai.dead) { ai.dead = true; ai.ghostVote = true; ai.action = null; }
    save();
    let pushed = [];
    if (vote) {
      const targets = state.players.filter(p => p.status !== 'thinking' && p.name !== who);
      const priv = {};
      for (const p of targets) priv[p.name] = p.dead
        ? (p.ghostVote === false ? `${who} is on the block. you have no votes left — action stays null.` : `${who} is on the block. this would spend your ONLY ghost vote: return action {"type":"vote","target":"${who}"} to vote for execution, or null to keep it.`)
        : `${who} is on the block. return action {"type":"vote","target":"${who}"} to vote for execution, or action null to abstain. decide now; keep say empty unless you must speak before the hands go up.`;
      pushed = doPushTargets(targets, priv, true);
    }
    return send(200, { ok: true, text, pushed });
  }
  // play-agent protocol
  if (req.method === 'GET' && url.pathname === '/api/play/next') {
    agentSeen = Date.now();
    const job = playJobs.find(j => !j.taken);
    if (!job) return send(200, { job: null });
    job.taken = Date.now();
    return send(200, { job: { id: job.id, channel: job.channel, head: job.head, rate: job.rate, gain: job.gain, url: `/api/play/file/${job.id}` } });
  }
  if (req.method === 'GET' && url.pathname.startsWith('/api/play/file/')) {
    const job = playJobs.find(j => j.id === +url.pathname.split('/').pop());
    if (!job || !fs.existsSync(job.file)) return send(404, { err: 'no such job' });
    res.writeHead(200, { 'Content-Type': 'audio/wav' }); return fs.createReadStream(job.file).pipe(res);
  }
  if (req.method === 'POST' && url.pathname === '/api/play/done') {
    const b = await body(req);
    const i = playJobs.findIndex(j => j.id === +b.id);
    if (i >= 0) { const job = playJobs.splice(i, 1)[0]; clearTimeout(job.timer); job.done(); }
    return send(200, { ok: true });
  }
  if (req.method === 'POST' && url.pathname === '/api/auto') {
    const b = await body(req);
    if (['off', 'timer', 'lull'].includes(b.tick)) state.auto.tick = b.tick;
    if (+b.secs) state.auto.secs = +b.secs;
    if (b.speak !== undefined) state.auto.speak = !!b.speak;
    if (b.volume !== undefined) state.volume = Math.max(0, Math.min(1, +b.volume || 0));
    if (b.rate !== undefined) state.rate = Math.max(0.6, Math.min(1.5, +b.rate || 1));
    save(); return send(200, { auto: state.auto });
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
    const prevChannels = state.players.map(p => p.channel);   // speaker channels are hardware, not game: carry them over by seat
    state.players = (b.players || []).slice(0, 4).map((p, i) => {
      const base = (p.model || MODEL).split('/').pop();
      used[base] = (used[base] || 0) + 1;
      const auto = used[base] > 1 ? `${base}-${used[base]}` : base;
      const name = (p.name || '').trim() || auto;
      const roleRules = extractRoleRules(p.role);
      return { name, role: p.role || '?', alignment: p.alignment || 'good', model: p.model || '', voice: p.voice || '', channel: p.channel || prevChannels[i] || null,
        card: `Your secret character: ${p.role} (${p.alignment}).\n\n${roleRules || 'Your exact ability is in the rules above — reread it now.'}\n\n${p.persona || ''}`.trim(),
        status: 'idle', lastStatus: '', action: null, ask: null, parseError: null, feedback: '', ctxCursor: 0,
        sheet: `ME: ${name}, ${p.role} (${p.alignment}). ${p.persona || ''}\n\nREADS\n(none yet)\n\nPLAYERS\n(unknown yet)\n\nSTRATEGY (updated tick 0)\ngoal today: (none yet — set one at dawn)\nworking theory: (no reads yet)\nmy claim status: unclaimed; nobody knows what I am\nnext moves: listen for claims; decide who to test first\nif X then Y: (none yet)\n\nPRIVATE (whispered to me — never say aloud unless I decide to)\n(none yet)\n\nEVENTS\n(game not started)`,
        history: [],
      };
    });
    state.humans = (b.humans || []).map((h, i) => ({ name: (h.name || '').trim(), mic: h.mic || i + 1 })).filter(h => h.name);
    state.seats = (b.seats && b.seats.length) ? b.seats : state.players.map(p => p.name).concat(state.humans.map(h => h.name));
    for (const f of fs.readdirSync(GAME)) if (/^speech-.*\.(wav|aiff)$/.test(f)) try { fs.unlinkSync(path.join(GAME, f)); } catch (e) {}
    state.queue = []; state.ctx = []; state.whispers = []; state.turnN = 0; state.seq = 0;
    state.phase = { time: 'night', day: 1 }; state.hadFirstDay = false; state.speaking = null;
    state.players.forEach(sysPromptPath);
    ctxAppend({ kind: 'phase', text: 'night 1 falls — the game begins' });
    save();
    // the transcriber learns names at start: bounce it so the new roster is in its vocabulary
    if (micProc) { const { device, channels } = mics; micStop(); setTimeout(() => micStart(device, channels), 1500); }
    pushNightChoosers();
    return send(200, { ok: true });
  }
  if (req.method === 'POST' && url.pathname === '/api/push') {
    const b = await body(req);
    if (b.town) ctxAppend({ kind: 'town', text: b.town });
    if (b.note) ctxAppend({ kind: 'note', text: b.note });
    for (const g of Array.isArray(b.game) ? b.game : []) {
      // typed lines are official but NEVER auto-kill (a "vote yes/no executed?" once flagged a living AI dead) — deaths go through the buttons
      ctxAppend({ kind: 'phase', text: `MARGOT: ${g}` });
    }
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
    if (i >= 0) { if (b.remove) { sayFate(state.queue[i], 'skipped'); state.queue.splice(i, 1); } else deliverQueued(b.id); }
    save(); return send(200, { ok: true });
  }
  if (req.method === 'POST' && url.pathname === '/api/edit') {
    const b = await body(req);
    const p = player(b.player);
    if (!p) return send(404, { err: 'no such player' });
    if (b.field === 'sheet') p.sheet = b.value;
    if (b.field === 'voice') p.voice = b.value;
    if (b.field === 'model') p.model = String(b.value || '').trim();
    if (b.field === 'role') p.role = String(b.value || '').trim();
    if (b.field === 'alignment') p.alignment = b.value === 'evil' ? 'evil' : 'good';
    if (b.field === 'channel') p.channel = +b.value || null;
    if (b.field === 'dead') {
      const dead = !!b.value;
      if (dead !== !!p.dead) {
        p.dead = dead;
        if (dead) { p.ghostVote = true; p.action = null; ctxAppend({ kind: 'phase', text: `${p.name} is dead` }); }
        else ctxAppend({ kind: 'phase', text: `${p.name} is alive again (storyteller correction)` });
      }
    }
    if (b.field === 'ghostVote') p.ghostVote = !!b.value;
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

// after a restart, queued lines without audio go back into the synth line, oldest first
setTimeout(() => { for (const q of state.queue) if (!q.file || !fs.existsSync(q.file)) preSynth(q); }, 500);
server.listen(PORT, () => console.log(`clocktower wrangler on http://localhost:${PORT}  (model=${MODEL}, effort=${EFFORT})\n  phone/other laptops (wrangler, secret): ${wranglerUrl()}\n  side laptops (whisper, public):        http://${lanIp()}:${PORT}/whisper`));
