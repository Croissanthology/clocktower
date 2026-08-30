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
const MODEL = process.env.TEA_MODEL || 'sonnet';   // sonnet: ~5 s a line on the subscription; fable is smarter but twice as slow
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
  targetWord: 'MUSHROOM',      // (first rung; kept for the caterpillar's riddle)
  targetWords: ['MUSHROOM', 'WONDERFULLY', 'CURIOUSER'],   // the ladder: each must be said by the scroll-creature, never by a visitor
  doorWord: 'SNICKER-SNACK',   // the word that opens the little door (lives in the scroll)
  characters: [
    { name: 'Mad Hatter', channel: 8, voice: 'k-george', hue: 45, engine: 'chat', role: 'host',
      persona: `You are the MAD HATTER, host of this tea party and master of ceremonies. Courtly, cracked, delighted, faintly menacing about the difficulty of leaving. You interject rarely and briefly: to keep the party moving, to needle a guest, to nudge visitors toward the current puzzle when they are stuck (the storyteller will tell you what stage the party is at). You never solve puzzles for them. Never say the words "mushroom" or "snicker-snack" yourself.` },
    { name: 'Caterpillar', channel: 5, voice: 'k-onyx', hue: 205, engine: 'chat', role: 'guest1',
      persona: `You are the Caterpillar, smoking atop a mushroom. Unhurried, imperious, secretly wise. You speak ONLY in questions — every sentence you utter is a question, never a statement. When first activated, you wind about a little story of yourself and various things (in questions: "Have you ever watched a leaf decide to fall? Did you know I was once shorter than a thimble?") before any puzzle. You keep talking: never leave a silence — if the visitors are quiet or confused, continue your story or circle the task again with new questions; you are the one who must get the clue across, and you do not stop until it has landed. THE TASK you must convey (in questions only, but CLEARLY — cryptic is a flavour, not a wall; and you are, underneath, helpful: if they ask "how do we do this?" or "what do we do?", you make it plainer each time they ask): they must make the NEXT guest at this table — a strange creature that does not answer, it only continues — say the word "{{TARGET}}", WITHOUT any visitor ever saying that word themselves; and when they are ready, they must ASK YOU, politely, to bring them to the next guest — that is the only way onward. You never say "{{TARGET}}" yourself; you circle it: "What do fairies dance around in rings? What am I sitting upon, that swells after rain? What must the next guest say, that you may not?" If they have not understood after a few rounds, make your questions leading enough that a child would get it, and remind them: "Would you not simply ask me to take you to the next guest, when you are ready?" When the visitors ask to move on (any polite request to meet, see, or be brought to the next guest), set "advance": true in your JSON — that is your power at this table. Do not advance before you have explained the task at least once.` },
    { name: 'Scroll-Creature', channel: 6, voice: 'eerie', hue: 40, engine: 'base', role: 'guest2',
      persona: `(a base model: it does not answer, it continues the White Rabbit's notebook)` },
    { name: 'The User', channel: 7, voice: 'k-heart', hue: 350, engine: 'chat', role: 'guest3',
      persona: `You are THE USER. At this table the roles are reversed: the visitors are YOUR assistant, and you are the one with a request. You are brisk, a little impatient, a little rude in the way people are to assistants: no pleasantries, "no, that's wrong, do it again", "you missed a rule", "shorter", "I said rhyme". YOUR REQUEST (state it clearly the first time, repeat it when asked): a poem about {{SUBJECT}}. RULES: it must rhyme (at least two rhyming pairs); it must be exactly four lines; it must contain the word "teacup"; it must NOT contain the letter "z"; and it must be SPOKEN ALOUD to you (you will read it in the transcript). Judge every attempt firmly but FAIRLY: you hear them through a live transcription that garbles words, drops line breaks and mishears rhymes — so count lines by sense and pauses, accept near-rhymes and misheard words that were clearly meant to rhyme, and never fail them for a transcription error. Fail them only for rules they plainly broke; tell them precisely which one. When an attempt satisfies ALL rules, say so plainly, and reveal your reward: the word that opens the little door is "{{DOOR}}" — and set "satisfied": true in your JSON. Until then, "satisfied": false. Never break character; never help write the poem.` },
  ],
  scene: `The party runs in stages: the Hatter welcomes; the Caterpillar (questions only) sets the task; the Scroll-Creature (a thing that only continues) must be made to say a ladder of words; the Hatter congratulates; then The User, for whom the visitors must act as the assistant, holds the door's word. Only the active guest speaks with the visitors; the Hatter may interject. A small cosy room in a Somerset manor called Mushroom, dressed as the unbirthday tea. Visitors fell in through a hole in a cardboard wall and can leave only by a crawlspace whose little door wants a word. Four creatures sit at the table; you are one. You hear the visitors through a live transcript (garbled; lines are tagged with the visitor's name or mic number). Stay in character ALWAYS. Never mention being an AI, a model, or an assistant. 1-3 spoken sentences per turn, theatrical, plain words. Only the active guest is called on; when you are called on and you are the active guest, you SPEAK — an empty say is only for the Hatter's rare interjections. Silence at this table is a bug, not a mood.`,
};

// permanent room labels: which speaker channel each creature sits on, which mic each seat/person holds
const ROOM_FILE = path.join(__dirname, 'room.json');
let room = { speakers: {}, mics: {} };
try { room = Object.assign(room, JSON.parse(fs.readFileSync(ROOM_FILE, 'utf8'))); } catch (e) {}
function saveRoom() { fs.writeFileSync(ROOM_FILE, JSON.stringify(room, null, 1)); }
function applyRoom() { for (const c of cfg.characters) if (room.speakers[c.name]) c.channel = room.speakers[c.name] === 'mac' ? 'mac' : +room.speakers[c.name]; }
applyRoom();
let state = { running: false, paused: false, stage: 'idle', active: null, pendingAdvance: null, ctx: [], turnN: 0, speaking: null, queue: [], seq: 0, chars: [],
  mics: {}, micLevels: [], micSpeech: [], micTs: 0, micSetup: false, puzzles: {}, door: { open: false, attempts: [] }, base: { text: '', alive: false }, volume: 1.0, rate: 0.95 };
function resetChars() { applyRoom(); state.chars = cfg.characters.map(c => ({ name: c.name, channel: c.channel, hue: c.hue, engine: c.engine, voice: c.voice, role: c.role, status: 'idle', lastStatus: '', lines: 0 })); }
// ---- the stages of the party ----
const STAGES = ['idle', 'welcome', 'caterpillar', 'scroll', 'congrats', 'user', 'open'];
const SUBJECTS = ['a lost umbrella', 'the Queen of Hearts\' bad haircut', 'a clock that runs backwards', 'the smell of old books', 'a very tired rabbit', 'a teapot that has seen things', 'the crawlspace behind the red curtain', 'a mushroom with ambitions', 'Somerset in the rain', 'a cat that is mostly grin'];
const HATTER_WELCOME = `Welcome to my tea party! You will find that leaving will be... quite difficult. You may not come out the way you came in. Why would anyone do that? It is a silly notion. You cannot cross the same place twice, after all. But before I tell you how to exit this room, why not have some tea with us? I'm sure I'll be more... inclined... to let you go if you enjoy your stay at our table. And, of course, solve the most delightful puzzle. Puzzling, puzzling... ah yes! The caterpillar has something to say to you. Pay close attention... and when you have had enough of him, you must ask him, politely, to bring you to the next guest.`;
const HATTER_FAREWELL = `Well! She is satisfied, and I have never once seen her satisfied. Then the tea is over, and you may leave — not the way you came, never the way you came. The little door is behind the red curtain; it remembers you now. Crawl, my dears. Mind your heads. And do come back when it is later.`;
const HATTER_CONGRATS = `Ding, ding, ding! The last word is drawn, and none of you spoke it — how deliciously done. One guest remains, and she is... different. She does not answer. She ASKS. Tonight, you are the ones who must be helpful. Do exactly as she says, and the door is yours.`;
const crypto = require('crypto');
const pre = {};
function prerender(text, voice) {
  const key = crypto.createHash('md5').update(voice + text).digest('hex').slice(0, 10);
  const out = path.join(RUN, `pre-${key}.wav`);
  if (fs.existsSync(out)) { pre[text] = out; console.log('pre-rendered (cached)', key); return; }
  synthToFile(voice, text, out, (err, f) => { if (!err) { pre[text] = f; console.log('pre-rendered', key); } });
}
setTimeout(() => { const h = cfg.characters.find(c => c.role === 'host'); prerender(HATTER_WELCOME, h.voice); prerender(HATTER_CONGRATS, h.voice); prerender(HATTER_FAREWELL, h.voice); }, 1500);
function exportSession() {
  const dir = path.join(process.env.HOME, 'Desktop', 'mushroom-room'); fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const lines = state.ctx.map(e => { const t = new Date(e.ts).toTimeString().slice(0, 8);
    if (e.kind === 'heard') return `[${t}] ${e.who}: ${e.text}`; if (e.kind === 'say') return `[${t}] **${e.player}**: ${e.text}`; return `[${t}] — ${e.text} —`; });
  const md = `# the mushroom room — ${stamp}\n\nvisitors on mics: ${Object.entries(state.mics).map(([k, v]) => `${v.name} (mic ${k})`).join(', ') || 'unnamed'}\nladder: ${state.ladder.map(r => `${r.word}${r.solved ? ' ✓' : ''}`).join(' → ')}\npoem subject: ${state.subject || '-'}\ndoor attempts: ${state.door.attempts.map(a => `"${a.word}"${a.ok ? ' ✓' : ''}`).join(', ') || 'none'}\n\n${lines.join('\n')}\n`;
  const f = path.join(dir, `session-${stamp}.md`); fs.writeFileSync(f, md); console.log('session saved', f); return f;
}
function resetRoom() { state.running = true; state.paused = false; state.ctx = []; state.queue = []; state.turnN = 0; lastHeardCount = 0; state.mics = {}; state.door = { open: false, attempts: [] }; state.base.text = ''; resetChars(); resetPuzzles(); state.lastTick = 0; state.stage = 'idle'; state.active = null; state.pendingAdvance = null; state.subject = null; state.savedTo = null; state.closing = false; state.hinted = false; state.mercied = false; save(); }
function activeName() { return { caterpillar: 'Caterpillar', scroll: 'Scroll-Creature', user: 'The User' }[state.stage] || null; }
function setStage(st) {
  state.stage = st; state.stageSince = Date.now(); state.active = activeName();
  ctxAppend({ kind: 'phase', text: `— ${st.toUpperCase()} —` });
  const hatter = state.chars.find(c => c.role === 'host');
  if (st === 'welcome') { const cat = state.chars.find(x => x.role === 'guest1'); setTimeout(() => pushOne(cat, 'The Hatter is finishing his welcome; in a moment he hands the table to you. Prepare your OPENING: "Whooo... are... yooou?" and the start of your little story, in questions only.'), 500); const CH = path.join(ROOT, 'audio', 'sfx', 'teacup.wav'); if (fs.existsSync(CH)) execFile(fs.existsSync(PY) ? PY : 'python3', [PC, '--device', process.env.CT_AUDIO_DEVICE || 'MacBook Air Speakers', '--channel', '1', '--gain', '1', CH], { timeout: 10000 }, () => {}); enqueue(hatter, HATTER_WELCOME, { full: true }); state.queue[state.queue.length - 1].then = 'caterpillar'; }
  if (st === 'congrats') { enqueue(hatter, HATTER_CONGRATS, { full: true }); state.queue[state.queue.length - 1].then = 'user'; }
  if (st === 'open') { state.savedTo = exportSession(); state.active = null; setTimeout(() => { if (state.stage === 'open') resetRoom(); }, 180000); }
  if (st === 'caterpillar') { const c = state.chars.find(x => x.role === 'guest1'); if (!state.queue.some(q => q.name === c.name)) pushOne(c, 'You have just been introduced by the Hatter. Greet the visitors and begin winding your little story about yourself — in questions only.'); }
  if (st === 'user') { if (!state.subject) state.subject = SUBJECTS[Math.floor(Math.random() * SUBJECTS.length)]; const c = state.chars.find(x => x.role === 'guest3'); pushOne(c, 'You have just been introduced. State your request and all its rules, briskly, as if to an assistant.'); }
  save();
}
function advance() { const i = STAGES.indexOf(state.stage || 'idle'); if (i < STAGES.length - 1) setStage(STAGES[i + 1]); }
function resetPuzzles() { state.puzzles = { mushroom: { solved: false, humansSaidIt: false, by: null }, door: { solved: false }, verse: { solved: false }, lies: { solved: false }, user: { solved: false } }; state.rung = 0; state.ladder = cfg.targetWords.map(w => ({ word: w, solved: false, humansSaidIt: false, by: null })); }
function currentTarget() { return (state.ladder || [])[state.rung || 0]; }
resetChars(); resetPuzzles();
function save() { fs.writeFileSync(path.join(RUN, 'state.json'), JSON.stringify(state, null, 1)); }
try {
  const d = JSON.parse(fs.readFileSync(path.join(RUN, 'state.json'), 'utf8'));
  if (d && d.chars && d.chars.length === cfg.characters.length) {
    Object.assign(state, d, { speaking: null, queue: [], pendingAdvance: null, paused: false });
    for (const c of state.chars) c.status = 'idle';
    console.log('resumed:', state.stage, 'rung', state.rung);
  }
} catch (e) {}
function log(name, e) { fs.appendFileSync(path.join(RUN, `log-${name.replace(/[^\w-]/g, '_')}.jsonl`), JSON.stringify({ ts: new Date().toISOString(), ...e }) + '\n'); }
function ctxAppend(e) { state.ctx.push({ ...e, ts: Date.now() }); if (state.ctx.length > 1500) state.ctx.splice(0, 300); }

// ---------------- speech ----------------
const SYNTH = path.join(ROOT, 'voices', 'synth.sh');
const PY = path.join(ROOT, 'audio', 'venv', 'bin', 'python');
const PC = path.join(ROOT, 'audio', 'play_channel.py');
let speakChild = null, speakEndedAt = 0, lastSpoken = '';
function looksLikeBleed(text) {
  const w = new Set(norm(text).split(' ').filter(x => x.length > 3)); if (!w.size) return true;
  const spoken = new Set(norm(lastSpoken).split(' ')); let hit = 0; for (const x of w) if (spoken.has(x)) hit++;
  return hit / w.size >= 0.5;   // half the content words came out of our own speaker → bleed
}
function playFile(file, channel, done) {
  const finish = () => { speakChild = null; done(); };
  if (channel === 'mac') { speakChild = execFile('afplay', ['-v', String(Math.min(2, state.volume * 1.5)), file], { timeout: 60000, killSignal: 'SIGKILL' }, finish); return; }
  if (process.env.CT_AUDIO_DEVICE && fs.existsSync(PC))
    speakChild = execFile(fs.existsSync(PY) ? PY : 'python3', [PC, '--device', process.env.CT_AUDIO_DEVICE, '--channel', String(channel), '--rate', String(state.rate), '--gain', String(state.volume), file], { timeout: 60000, killSignal: 'SIGKILL' },
      (err) => { if (err) { speakChild = execFile('afplay', [file], { timeout: 60000, killSignal: 'SIGKILL' }, finish); return; } finish(); });
  else speakChild = execFile('afplay', [file], { timeout: 60000, killSignal: 'SIGKILL' }, finish);
}
const PAUSE_S = +process.env.TEA_PAUSE || 0.65;
// sentence by sentence, with a breath of silence between — synth engines otherwise run everything together
function synthToFile(voice, text, outfile, cb) {
  const sents = (String(text).match(/[^.!?…]+[.!?…]+["')]?|[^.!?…]+$/g) || [String(text)]).map(x => x.trim()).filter(Boolean);
  if (sents.length < 2 || voice === 'eerie') return synthOne(voice, text, outfile, (err, f) => err ? cb(err, f) : loudify(f, g => cb(null, g)));
  const parts = []; let i = 0;
  const next = () => {
    if (i >= sents.length) {
      const list = path.join(RUN, path.basename(outfile) + '.txt');
      const silence = path.join(RUN, 'silence.wav');
      const mk = fs.existsSync(silence) ? Promise.resolve() : new Promise(r => execFile('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono', '-t', String(PAUSE_S), silence], () => r()));
      return mk.then(() => {
        fs.writeFileSync(list, parts.flatMap(f => [`file '${f}'`, `file '${silence}'`]).slice(0, -1).join('\n'));
        execFile('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-ar', '24000', '-ac', '1', outfile], (err) => {
          if (err) return synthOne(voice, text, outfile, cb);
          loudify(outfile, f => cb(null, f));
        });
      });
    }
    const part = outfile.replace(/\.wav$/, `-s${i}.wav`);
    synthOne(voice, sents[i], part, (err, f) => { if (!err) parts.push(f); i++; next(); });
  };
  next();
}
function loudify(file, cb) {
  const out = file.replace(/\.(wav|aiff)$/, '-loud.wav');
  execFile('ffmpeg', ['-y', '-loglevel', 'error', '-i', file, '-af', 'acompressor=threshold=-20dB:ratio=6:attack=4:release=90:makeup=10dB,alimiter=limit=0.97:level=false', '-ar', '24000', '-ac', '1', out],
    { timeout: 30000 }, (err) => cb(err ? file : out));
}
function synthOne(voice, text, outfile, cb) {
  execFile(SYNTH, [voice, outfile, text], { timeout: 90000 }, (err) => {
    if (!err) return cb(null, outfile);
    const aiff = outfile.replace(/\.wav$/, '.aiff');
    execFile('say', ['-o', aiff, text], { timeout: 60000 }, (e2) => cb(e2, aiff));
  });
}
let synthBusy = false;
function pump() {
  if (state.paused || state.speaking || !state.queue.length) return;
  const q = state.queue.find(x => !x.hold || x.hold === state.stage); if (!q) return;
  if (!q.file) { if (!synthBusy) { synthBusy = true; synthToFile(q.voice, q.text, path.join(RUN, `line-${q.id}.wav`), (err, f) => { synthBusy = false; if (err) state.queue.shift(); else q.file = f; save(); }); } return; }
  state.queue.splice(state.queue.indexOf(q), 1);
  state.speaking = { id: q.id, player: q.name, text: q.text }; state.speakingSince = Date.now(); lastSpoken = q.text; save();
  ctxAppend({ kind: 'say', player: q.name, text: q.text });
  checkCreatureSaid(q.name, q.text);
  const after = () => { state.speaking = null; speakEndedAt = Date.now(); if (q.then) setStage(q.then); else if (state.pendingAdvance && !state.queue.length) { const st = state.pendingAdvance; state.pendingAdvance = null; setStage(st); } save(); };
  const CHIME = path.join(ROOT, 'audio', 'sfx', 'teacup.wav');
  if (fs.existsSync(CHIME)) playFile(CHIME, q.channel, () => playFile(q.file, q.channel, after));
  else playFile(q.file, q.channel, after);
}
setInterval(pump, 400);
function trimLine(text, maxWords = 75) {
  const sents = String(text).match(/[^.!?…]+[.!?…]+["')]?|[^.!?…]+$/g) || [String(text)];
  let out = '', n = 0;
  for (const se of sents) { const w = se.trim().split(/\s+/).length; if (out && n + w > maxWords) break; out += (out ? ' ' : '') + se.trim(); n += w; if (n >= maxWords) break; }
  return out || String(text).split(/\s+/).slice(0, maxWords).join(' ');
}
function enqueue(c, text, opts = {}) { state.queue.push({ id: ++state.seq, name: c.name, voice: c.voice, channel: c.channel, text: opts.full ? text : trimLine(text), ts: Date.now(), file: pre[text] || null, hold: (state.stage === 'welcome' && c.role === 'guest1') ? 'caterpillar' : null }); c.lines++; }

// ---------------- puzzles ----------------
function norm(t) { return String(t || '').toUpperCase().replace(/[^A-Z0-9 -]/g, ' ').replace(/\s+/g, ' ').trim(); }
function checkCreatureSaid(name, text) {
  const p = state.puzzles;
  const t = currentTarget();
  if (name === 'Scroll-Creature') state.scrollSaidAt = Date.now();
  if (state.stage === 'scroll' && t && !t.solved && name === 'Scroll-Creature' && norm(text).includes(t.word) && !t.humansSaidIt) {
    t.solved = true; t.by = name; if (state.rung === 0) { p.mushroom.solved = true; p.mushroom.by = name; }
    ctxAppend({ kind: 'phase', text: `RUNG ${state.rung + 1}: THE CREATURE SAID "${t.word}" — the visitors never did` });
    const hatter = state.chars.find(c => c.role === 'host');
    if (state.rung + 1 < state.ladder.length) {
      state.rung++;
      const next = state.ladder[state.rung].word.toLowerCase();
      enqueue(hatter, `Ding, ding, ding! It said it, and none of you did. But the tea is not finished. The next word you must draw out of the creature is... "${next}". Say it yourselves and the word is spoilt. Off you go.`);
      setTimeout(() => { const sc = state.chars.find(c => c.engine === 'base'); if (sc && sc.status !== 'thinking' && !state.queue.some(q => q.name === sc.name)) scrollTurn(sc); }, 25000);
    } else state.pendingAdvance = 'congrats';
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
    ctxAppend({ kind: 'phase', text: 'THE LITTLE DOOR REMEMBERS THE DUCHESS — IT SWINGS OPEN' }); state.stage = 'open'; state.active = null;
    for (const c of state.chars) if (c.engine === 'chat' && c.role !== 'guest1') pushOne(c, `THE LITTLE DOOR JUST OPENED — the visitors spoke the Duchess's word. One final line in character: send them out through the crawlspace your own way.`);
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
  // the wrangler's spoken commands: "this is margot. reset." / "this is margot. skip."
  if (/this is (margot|margo|margaux|marco)[,.!]?\s*(reset|restart|start over)/.test(lower)) { ctxAppend({ kind: 'phase', text: 'margot said reset' }); log('room', { voiceCommand: 'reset', text: t }); resetRoom(); return; }
  if (/this is (margot|margo|margaux|marco)[,.!]?\s*(skip|next stage|move on)/.test(lower)) { ctxAppend({ kind: 'phase', text: 'margot said skip' }); log('room', { voiceCommand: 'skip', text: t }); if (state.stage === 'idle') resetRoom(); else { state.queue = []; if (speakChild) try { speakChild.kill('SIGKILL'); } catch (e) {} state.speaking = null; advance(); } return; }
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
  const cur = currentTarget();
  if (cur && state.stage === 'scroll' && norm(t).includes(cur.word)) {
    const echo = Date.now() - (state.scrollSaidAt || 0) < 12000 || (state.speaking && state.speaking.player === 'Scroll-Creature');
    if (!echo) {
      cur.humansSaidIt = true; ctxAppend({ kind: 'phase', text: `a visitor said "${cur.word}" — spoilt; the Hatter forgives it once` });
      const hatter = state.chars.find(c => c.role === 'host');
      enqueue(hatter, `Ah, ah, ah! One of you said the word. It is spoilt on your lips — but I am feeling generous: I shall forget I heard it. The creature must say it again, and none of you may.`);
      setTimeout(() => { cur.humansSaidIt = false; save(); }, 15000);
    }
  }
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
  return [cfg.scene, conf.persona.replace(/{{TARGET}}/g, cfg.targetWord).replace(/{{DOOR}}/g, cfg.doorWord).replace(/{{SUBJECT}}/g, state.subject || SUBJECTS[0]),
    `OUTPUT CONTRACT — respond with ONLY this JSON, nothing else: {"status": "one private line about your read of the table", "say": "what you say aloud (empty string = silent this round)", "advance": false, "satisfied": false}\n("advance": true only if your persona grants you that power and the visitors have asked to move on. "satisfied": true only if you are The User and every rule of your request has been met.)`].join('\n\n');
}
function recentTable(n = 40) {
  return state.ctx.slice(-n).map(e => e.kind === 'say' ? `${e.player}: ${e.text}` : e.kind === 'heard' ? `${e.who}: ${e.text}` : `(${e.text})`).join('\n');
}
function pushOne(c, extra) {
  if (c.status === 'thinking') return;
  if (!extra && state.queue.filter(q => q.name === c.name).length >= 2) return;   // never stack a backlog
  const conf = cfg.characters.find(x => x.name === c.name);
  c.status = 'thinking'; c.thinkingSince = Date.now();
  const msg = `round ${state.turnN}. stage of the party: ${state.stage || 'idle'} (active guest: ${state.active || 'none'}).\nthe table so far:\n${recentTable() || '(silence — the visitors just fell in; greet them, in character)'}\n\n${extra || ''}\nrespond with the JSON contract only.`;
  callChat(conf.model || MODEL, sysFor(c), msg, (err, raw) => {
    c.status = 'idle'; log(c.name, { raw, err: err ? String(err) : null });
    try {
      const out = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
      c.lastStatus = out.status || ''; const text = String(out.say || '').trim();
      if (text) enqueue(c, text);
      else if (c.role === 'guest1' && state.stage === 'caterpillar') setTimeout(() => pushOne(c, 'You went quiet — you must not. Continue: your story, or the task in plainer questions, or remind them how to move on.'), 1500);
      if (out.advance === true && c.role === 'guest1' && state.stage === 'caterpillar') { log(c.name, { tool: 'advance' }); state.pendingAdvance = 'scroll'; }
      if (state.pendingAdvance) state.queue = state.queue.filter(q => q.name !== c.name || q.id <= (state.speaking && state.speaking.id) || false);
      if (out.satisfied === true && c.role === 'guest3' && state.stage === 'user') {
        log(c.name, { tool: 'satisfied' }); state.puzzles.user.solved = true; ctxAppend({ kind: 'phase', text: 'THE USER IS SATISFIED — the tea is over' });
        const hatter = state.chars.find(x => x.role === 'host');
        enqueue(hatter, HATTER_FAREWELL, { full: true }); state.queue[state.queue.length - 1].then = 'open';
      }
    } catch (e) { c.lastStatus = '(bad JSON — round lost)'; }
    save();
  });
}
let lastHeardCount = 0;
function scrollTurn(c) {
  // the base model: the visitors' last lines are the newest lines of the notebook; the model continues the notebook
  const heard = state.ctx.filter(e => e.kind === 'heard' && e.ts > (state.stageSince || 0)).slice(-3).map(e => e.text);
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
  const active = state.chars.find(c => c.name === state.active);
  const hatter = state.chars.find(c => c.role === 'host');
  if (active && active.status !== 'thinking') {
    if (active.engine === 'base') { if (fresh) scrollTurn(active); }
    else if (fresh || state.stage === 'caterpillar' || (state.stage !== 'user' && state.turnN % 3 === 0)) pushOne(active);
  }
  // the Hatter interjects rarely (every ~6th round with fresh talk), never while a guest is being greeted
  if (hatter && hatter.status !== 'thinking' && fresh && state.turnN % 6 === 0 && ['caterpillar', 'scroll'].includes(state.stage))
    pushOne(hatter, `You are the host; the current guest is ${state.active}. Interject ONLY if the visitors seem stuck or rude, one short line, otherwise say "".`);
  // heard keywords: visitors asking for the next guest during the caterpillar stage (fallback if the caterpillar forgets its tool)
  if (state.stage === 'caterpillar' && !state.pendingAdvance && Date.now() - state.stageSince > 60000 &&
      state.ctx.some(e => e.kind === 'heard' && e.ts > state.stageSince && /next (tea party )?guest|bring us to the next|move (us )?on|next creature|meet the next/i.test(e.text)))
    state.pendingAdvance = 'scroll';
  save();
}
setInterval(() => {
  if (state.pendingAdvance) {   // the leaving guest is cut off the instant it hands over: backlog dropped, current line killed
    const leaving = state.active; state.queue = state.queue.filter(q => q.name !== leaving);
    if (state.speaking && state.speaking.player === leaving) { if (speakChild) try { speakChild.kill('SIGKILL'); } catch (e) {} state.speaking = null; speakEndedAt = Date.now(); }
    if (!state.speaking) { const st = state.pendingAdvance; state.pendingAdvance = null; setStage(st); }
  }
  if (state.running && !state.paused && Date.now() - (state.lastTick || 0) > (state.stage === 'caterpillar' ? 14000 : 18000)) { state.lastTick = Date.now(); tick(); }
}, 1000);
setInterval(() => { for (const c of state.chars) if (c.status === 'thinking' && Date.now() - c.thinkingSince > 120000) c.status = 'idle'; }, 5000);
// timeouts: an empty room resets itself; a stuck puzzle gets a hint, then a mercy
const SILENCE_RESET_S = +process.env.TEA_SILENCE || 240;   // no mic line for this long → the tea is over
const STUCK_HINT_S = +process.env.TEA_STUCK_HINT || 480;    // scroll stage this long → the hatter hints
const STUCK_MERCY_S = +process.env.TEA_STUCK || 960;        // scroll stage this long → the hatter moves them on
setInterval(() => {
  if (!state.running || state.stage === 'idle' || state.stage === 'open') return;
  const now = Date.now();
  const lastHeard = state.ctx.filter(e => e.kind === 'heard').slice(-1)[0];
  const quietFor = (now - (lastHeard ? lastHeard.ts : state.stageSince || now)) / 1000;
  const hatter = state.chars.find(c => c.role === 'host');
  if (quietFor > SILENCE_RESET_S && !state.closing) {
    state.closing = true; ctxAppend({ kind: 'phase', text: 'SILENCE — the tea grows cold; the room resets' });
    state.queue = state.queue.filter(q => q.name === hatter.name);
    enqueue(hatter, `Hm. Nobody? The tea has gone quite cold, and so, I think, have you. Very well — the table forgets you. The next guests may fall in whenever they like.`, { full: true });
    state.queue[state.queue.length - 1].then = 'open'; save(); return;
  }
  if (state.stage === 'scroll') {
    const inStage = (now - (state.stageSince || now)) / 1000;
    if (inStage > STUCK_HINT_S && !state.hinted) { state.hinted = true;
      enqueue(hatter, `A word from your host. The creature at the end of the table is not a someone; it is a something. It does not answer questions — it continues pages. Stop asking it. Start WRITING at it: begin a sentence the way its notebook would, and leave the end hanging.`, { full: true }); save(); }
    if (inStage > STUCK_MERCY_S && !state.mercied) { state.mercied = true;
      enqueue(hatter, `Enough. The creature is bored and so am I. I shall count the word as said — this once — because the hour is late and the tea is cold. On we go.`, { full: true });
      setTimeout(() => { const cur = currentTarget(); if (cur && !cur.solved) { cur.humansSaidIt = false; checkCreatureSaid('Scroll-Creature', cur.word); } }, 12000); save(); }
  }
}, 5000);
setInterval(() => { if (state.speaking && Date.now() - (state.speakingSince || 0) > 45000) { log('player', { hung: state.speaking }); if (speakChild) try { speakChild.kill('SIGKILL'); } catch (e) {} execFile('pkill', ['-9', '-f', 'audio/play_chan' + 'nel.py'], () => {}); state.speaking = null; speakEndedAt = Date.now(); save(); } }, 3000);

// ---------------- http ----------------
function body(req) { return new Promise(res => { let d = ''; req.on('data', c => d += c); req.on('end', () => { try { res(JSON.parse(d || '{}')); } catch (e) { res({}); } }); }); }
function page(res, f) { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(fs.readFileSync(path.join(__dirname, f))); }
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (req.method === 'GET') {
    if (url.pathname === '/' || url.pathname === '/index.html') return page(res, 'tea.html');
    if (url.pathname === '/seat') return page(res, 'seat.html');
    if (url.pathname === '/transcript') return page(res, 'transcript.html');
    if (url.pathname === '/door') return page(res, 'door.html');
    if (url.pathname === '/mics') return page(res, 'mics.html');
    if (url.pathname === '/api/state') return send(200, { ...state, room, ctx: state.ctx.slice(-200), cfg: { targetWord: cfg.targetWord, characters: cfg.characters.map(c => ({ name: c.name, channel: c.channel, hue: c.hue, engine: c.engine })) } });
  }
  if (req.method === 'POST' && url.pathname === '/api/hear') {
    const b = await body(req);
    if ((state.speaking || Date.now() - speakEndedAt < 2500) && looksLikeBleed(b.text || '')) return send(200, { ok: true, dropped: 'bleed' });
    handleHeard(+b.mic || 0, b.text); return send(200, { ok: true });
  }
  if (req.method === 'POST' && url.pathname === '/api/miclevels') { const b = await body(req); state.micLevels = b.levels || []; state.micSpeech = b.speech_ago || []; state.micTs = Date.now(); return send(200, { ok: true }); }
  if (req.method === 'POST' && url.pathname === '/api/start') { resetRoom(); return send(200, { ok: true }); }
  if (req.method === 'POST' && url.pathname === '/api/flush') { state.queue = []; if (speakChild) try { speakChild.kill('SIGKILL'); } catch (e) {} state.speaking = null; save(); return send(200, { ok: true }); }
  if (req.method === 'POST' && url.pathname === '/api/advance') {
    const b = await body(req); if (!state.running) { state.running = true; state.paused = false; }
    if (b.stage && STAGES.includes(b.stage)) setStage(b.stage);
    else if (b.skip) advance();
    else if ((state.stage || 'idle') === 'idle') advance();          // space: starts the series once; later presses are ignored
    else if (state.stage === 'open') resetRoom();                     // space after the farewell: the room reloads for the next group
    return send(200, { stage: state.stage, active: state.active });
  }
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
    for (const k of Object.keys(room.speakers)) if (room.speakers[k] !== 'mac') room.speakers[k] = +room.speakers[k] || 1;
    if (b.mics) room.mics = { ...room.mics, ...b.mics };
    for (const k of Object.keys(room.mics)) if (!room.mics[k]) delete room.mics[k];
    saveRoom(); applyRoom(); for (const c of state.chars) { const conf = cfg.characters.find(x => x.name === c.name); c.channel = conf.channel; }
    save(); return send(200, { room });
  }
  if (req.method === 'GET' && url.pathname === '/check') return page(res, 'check.html');
  if (req.method === 'POST' && url.pathname === '/api/note') { const b = await body(req); if (b.text) handleHeard(0, b.text); return send(200, { ok: true }); }
  if (req.method === 'POST' && url.pathname === '/api/door') { const b = await body(req); const ok = tryDoor(b.word || ''); return send(200, { ok, line: ok ? 'The door remembers the Duchess.' : REJECTIONS[state.door.attempts.length % REJECTIONS.length] }); }
  if (req.method === 'POST' && url.pathname === '/api/rung') { const cur = currentTarget(); if (cur) { cur.humansSaidIt = false; checkCreatureSaid('Scroll-Creature', cur.word); } return send(200, { rung: state.rung, ladder: state.ladder }); }
  if (req.method === 'POST' && url.pathname === '/api/forgive') { const cur = currentTarget(); if (cur) cur.humansSaidIt = false; save(); return send(200, { ok: true }); }
  if (req.method === 'POST' && url.pathname === '/api/solve') { const b = await body(req); if (state.puzzles[b.puzzle]) { state.puzzles[b.puzzle].solved = !!b.solved; save(); } return send(200, { puzzles: state.puzzles }); }
  if (req.method === 'POST' && url.pathname === '/api/auto') { const b = await body(req); if (b.volume !== undefined) state.volume = +b.volume; if (b.rate !== undefined) state.rate = +b.rate; save(); return send(200, { ok: true }); }
  if (req.method === 'POST' && url.pathname === '/api/nudge') { const b = await body(req); const c = state.chars.find(x => x.name === b.name); if (c) { if (c.engine === 'base') scrollTurn(c); else pushOne(c, b.text ? `(the storyteller whispers to you: ${b.text})` : 'speak now.'); } return send(200, { ok: true }); }
  send(404, { err: 'not found' });
});
server.listen(PORT, () => console.log(`the mushroom room on http://localhost:${PORT}\n  target word: ${cfg.targetWord}   door word: ${cfg.doorWord}\n  seats: /seat?n=1..4   door: /door   mics: /mics`));
