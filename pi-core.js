// clocktower agent core, on @earendil-works/pi-agent-core.
//
// Each AI turn runs through a Pi `Agent` authenticated against your Claude
// subscription via OAuth (see pi-auth.js) — no claude -p CLI, no API tokens.
//
// The model acts by calling DECOMPOSED NATIVE TOOLS (say / set_action /
// edit_sheet / ask_storyteller / whisper / set_status), each schema-validated by
// the framework. Rather than mutate game state from inside the tools (which would
// couple this module to the whole server), every tool records its intent into a
// per-turn `collected` accumulator; the server then applies those intents with
// its existing side-effect logic (queueing speech, night-hold, whisper routing,
// sheet edits, history, fate). Every tool result sets `terminate: true` so the
// agent stops after one tool batch — one decision per tick, no follow-up call.
import { Agent } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import fs from 'node:fs';
import { getModels, resolveModel } from './pi-auth.js';

// NOTE: no `terminate` flag. The model calls its tools across one or more turns
// (set_status, then say/ask, etc.) and the agent loop ends naturally when it
// stops calling tools — forcing termination after the first batch would drop the
// later calls. The per-turn timeout in runPlayerTurn is the backstop.
const done = (text) => ({ content: [{ type: 'text', text }], details: {} });
const str = (v) => String(v == null ? '' : v);

// The full per-tick toolset. Each execute() appends to `c` (the accumulator).
function fullTools(c) {
  return [
    {
      name: 'set_status', label: 'Status',
      description: 'Record one short PRIVATE line for Margot about what you are doing this tick. Call once per tick.',
      parameters: Type.Object({ status: Type.String({ description: 'one short line, private to Margot' }) }),
      execute: async (id, p) => { c.status = str(p.status); return done('noted'); },
    },
    {
      name: 'say', label: 'Say',
      description: 'Say ONE line ALOUD to the table — everyone hears it through the speaker. Call again for more lines. Do NOT call at night; night speech is held and not spoken.',
      parameters: Type.Object({
        to: Type.Optional(Type.String({ description: '"town" (default) or a player name for a directed remark (still heard by all)' })),
        text: Type.String({ description: 'spoken-word line: 2-4 short sentences, said in a breath' }),
      }),
      execute: async (id, p) => { if (str(p.text).trim()) c.say.push({ to: str(p.to) || 'town', text: str(p.text) }); return done('queued'); },
    },
    {
      name: 'set_action', label: 'Action',
      description: 'Submit a game action — ONLY when Margot asked you to act (vote / nominate / night ability / demon kill / slayer shot). Never invent one unprompted.',
      parameters: Type.Object({
        type: Type.Union([
          Type.Literal('vote'), Type.Literal('nominate'), Type.Literal('night_ability'),
          Type.Literal('demon_kill'), Type.Literal('slayer_shot'), Type.Literal('other'),
        ]),
        target: Type.Optional(Type.String({ description: 'target player name (or names)' })),
      }),
      execute: async (id, p) => { c.action = { type: str(p.type), target: str(p.target) }; return done('flashed to storyteller'); },
    },
    {
      name: 'edit_sheet', label: 'Edit sheet',
      description: 'Update your private sheet (your ONLY memory between ticks). Use `append` for event-log lines (never fails); use `find`+`replace` to update dossiers/plans (find must match character-for-character). Call multiple times.',
      parameters: Type.Object({
        find: Type.Optional(Type.String({ description: 'exact text currently in your sheet' })),
        replace: Type.Optional(Type.String({ description: 'its replacement' })),
        append: Type.Optional(Type.String({ description: 'new line(s) added to the end' })),
      }),
      execute: async (id, p) => {
        if (typeof p.append === 'string' && p.append.trim()) c.edits.push({ append: p.append });
        else if (typeof p.replace === 'string') c.edits.push({ find: str(p.find), replace: p.replace });
        return done('sheet updated');
      },
    },
    {
      name: 'ask_storyteller', label: 'Ask',
      description: 'Ask Margot a short question (rules clarification, garbled transcript, seating). The answer arrives a later tick. Use sparingly.',
      parameters: Type.Object({ text: Type.String() }),
      execute: async (id, p) => { if (str(p.text).trim()) c.ask = str(p.text).trim(); return done('sent to Margot'); },
    },
    {
      name: 'whisper', label: 'Whisper',
      description: 'Send a PRIVATE text reply to a player who whispered you, or a private machine-to-machine note to another AI player (budgeted). Never spoken aloud.',
      parameters: Type.Object({
        to: Type.String({ description: 'the whisperer, or another AI player name' }),
        text: Type.String(),
      }),
      execute: async (id, p) => { if (str(p.text).trim() && str(p.to).trim()) c.whisper.push({ to: str(p.to), text: str(p.text) }); return done('whispered'); },
    },
  ];
}

// The lean toolset for quick-whisper replies.
function whisperTools(c) {
  return [
    {
      name: 'whisper', label: 'Whisper',
      description: 'Your private reply to a whisperer — one call per person. Read on their screen, never spoken.',
      parameters: Type.Object({ to: Type.String(), text: Type.String() }),
      execute: async (id, p) => { if (str(p.text).trim() && str(p.to).trim()) c.whisper.push({ to: str(p.to), text: str(p.text) }); return done('whispered'); },
    },
    {
      name: 'record_note', label: 'Note',
      description: 'One line for the PRIVATE section of your sheet recording what they told you and what you answered.',
      parameters: Type.Object({ note: Type.String() }),
      execute: async (id, p) => { c.note = str(p.note); return done('noted'); },
    },
  ];
}

function readFileSafe(f) { try { return fs.readFileSync(f, 'utf8'); } catch (e) { return ''; } }

/**
 * Run one clocktower turn through a Pi Agent with native tools.
 *
 * @param {object} o
 * @param {string} o.name
 * @param {string} o.model      app model spec (e.g. "sonnet", "or:...", "anthropic/...")
 * @param {string} o.sysFile    path to the player's system-prompt file
 * @param {string} o.userMsg    the built user message for this tick
 * @param {string} o.effort     thinking level
 * @param {string} o.authFile   path to game/auth.json (Anthropic OAuth)
 * @param {string} [o.openrouterKeyFile]
 * @param {number} [o.timeoutMs]
 * @param {"full"|"whisper"} [o.toolset]
 * @param {AbortSignal} [o.signal]
 * @returns {Promise<{text,thinking,error,aborted,collected}>}  always resolves.
 */
export async function runPlayerTurn(o) {
  const models = getModels(o.authFile, o.openrouterKeyFile);
  let model;
  try { model = resolveModel(models, o.model); }
  catch (e) { return { text: '', thinking: '', error: str(e.message || e), aborted: false, collected: null }; }

  const collected = o.toolset === 'whisper'
    ? { whisper: [], note: '' }
    : { status: '', say: [], action: null, ask: '', edits: [], whisper: [] };
  const tools = o.toolset === 'whisper' ? whisperTools(collected) : fullTools(collected);
  const thinkingLevel = o.effort === 'off' ? 'off' : (o.effort || 'medium');

  const agent = new Agent({
    initialState: { systemPrompt: readFileSafe(o.sysFile), model, thinkingLevel, tools },
    streamFn: models.streamSimple.bind(models),
  });

  // hard timeout + optional external abort, both routed to the Agent's abort
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), o.timeoutMs || 120000);
  if (o.signal) { if (o.signal.aborted) ac.abort(); else o.signal.addEventListener('abort', () => ac.abort(), { once: true }); }
  ac.signal.addEventListener('abort', () => agent.abort(), { once: true });

  try {
    await agent.prompt(o.userMsg);
    await agent.waitForIdle();
  } catch (e) {
    clearTimeout(timer);
    return { text: '', thinking: '', error: str(e.message || e).slice(0, 500), aborted: ac.signal.aborted, collected };
  }
  clearTimeout(timer);

  // the turn may span several assistant messages (tool call → results → more
  // calls → stop); this Agent is fresh per turn, so every assistant message here
  // belongs to this tick. Aggregate their text/thinking; use the last for status.
  const assistants = agent.state.messages.filter((m) => m.role === 'assistant');
  const last = assistants[assistants.length - 1];
  const pick = (kind, key) => assistants.flatMap((m) => (m.content || []).filter((c) => c.type === kind).map((c) => c[key]));
  const text = pick('text', 'text').join('');
  const thinking = pick('thinking', 'thinking').join('\n').trim();
  const aborted = ac.signal.aborted;
  let error = last && (last.stopReason === 'error' || last.stopReason === 'aborted') ? (last.errorMessage || 'stream error') : (agent.state.errorMessage || null);
  if (aborted && !error) error = 'aborted';
  return { text, thinking, error, aborted, collected };
}
