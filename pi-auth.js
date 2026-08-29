// Anthropic auth + model wiring for the Pi agent core.
//
// AI turns authenticate against your Claude Pro/Max subscription via OAuth
// (pi-ai's sanctioned PKCE flow) — no claude -p CLI, no per-token API bill, and
// no reaching into another app's credential store. The OAuth token is obtained
// once via `node login.js` and persisted to game/auth.json; pi auto-refreshes it
// from there. pi-ai's Anthropic API detects the `sk-ant-oat` access token and
// switches to OAuth Bearer + Claude Code identity headers automatically.
import { createModels } from '@earendil-works/pi-ai';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter';
import fs from 'node:fs';

// map the app's model shorthands to concrete Anthropic ids for the OAuth path
const MODEL_ALIAS = {
  sonnet: 'claude-sonnet-4-6',
  opus: 'claude-opus-4-6',
  haiku: 'claude-haiku-4-5',
};
export function anthropicModelId(model) {
  const m = String(model || 'sonnet');
  if (MODEL_ALIAS[m]) return MODEL_ALIAS[m];
  if (m.startsWith('claude-')) return m;
  return MODEL_ALIAS.sonnet;
}

// A serialized, file-backed CredentialStore (read / list / modify).
// modify() is the only write path and MUST be serialized so concurrent player
// ticks can't double-refresh a rotated OAuth token (pi runs refresh inside it).
export class FileCredentialStore {
  constructor(file) { this.file = file; this._chain = Promise.resolve(); }
  _readAll() { try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (e) { return {}; } }
  _writeAll(obj) {
    fs.mkdirSync(this.file.replace(/\/[^/]*$/, ''), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(obj, null, 1), { mode: 0o600 });
  }
  async read(providerId) { return this._readAll()[providerId]; }
  async list() { return Object.entries(this._readAll()).map(([providerId, c]) => ({ providerId, type: c.type })); }
  modify(providerId, fn) {
    // chain onto the previous modify so read-modify-write never interleaves
    const run = this._chain.then(async () => {
      const all = this._readAll();
      const next = await fn(all[providerId]);
      if (next === undefined) delete all[providerId]; else all[providerId] = next;
      this._writeAll(all);
      return next;
    });
    this._chain = run.catch(() => {}); // keep the chain alive on error
    return run;
  }
}

// Lazily build one Models instance for the process. Anthropic authenticates via
// the OAuth credential in the store; OpenRouter (optional second backend) via
// the OPENROUTER_API_KEY env var, seeded from openrouter.key if present.
let _models = null;
export function getModels(authFile, openrouterKeyFile) {
  if (_models) return _models;
  if (!process.env.OPENROUTER_API_KEY && openrouterKeyFile) {
    try { process.env.OPENROUTER_API_KEY = fs.readFileSync(openrouterKeyFile, 'utf8').trim(); } catch (e) {}
  }
  const store = new FileCredentialStore(authFile);
  const models = createModels({ credentials: store });
  models.setProvider(anthropicProvider());
  models.setProvider(openrouterProvider());
  _models = models;
  return models;
}

// Resolve one of the app's model specs to a concrete pi Model object.
//   "or:<id>" / "<vendor>/<id>"  -> OpenRouter
//   "anthropic/<id>"             -> Anthropic (subscription), id after the slash
//   "sonnet" | "claude-..."      -> Anthropic (subscription)
export function resolveModel(models, spec) {
  let m = String(spec || 'sonnet');
  if (m.startsWith('or:')) m = m.slice(3);
  else if (m.startsWith('anthropic/')) m = m.split('/')[1].replace(/:.*$/, '');
  if (m.includes('/')) {
    const model = models.getModel('openrouter', m);
    if (!model) throw new Error(`openrouter model not in catalog: ${m}`);
    return model;
  }
  const id = anthropicModelId(m);
  const model = models.getModel('anthropic', id);
  if (!model) throw new Error(`anthropic model not found: ${id}`);
  return model;
}

// Whether an Anthropic OAuth credential is present (does not refresh / validate).
export function haveAnthropicAuth(authFile) {
  try { return !!JSON.parse(fs.readFileSync(authFile, 'utf8')).anthropic; } catch (e) { return false; }
}
