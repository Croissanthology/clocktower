#!/usr/bin/env node
// One-time Anthropic OAuth login for the clocktower agent core.
//
//   node login.js
//
// Opens your browser to claude.ai to authorize (your Claude Pro/Max
// subscription). The token is stored in game/auth.json and auto-refreshed from
// there — you only do this once. This is a fresh, independent grant; it does not
// touch your Claude Code CLI login.
import path from 'node:path';
import readline from 'node:readline';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getModels } from './pi-auth.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const AUTH_FILE = path.join(ROOT, 'game', 'auth.json');

const models = getModels(AUTH_FILE);

const interaction = {
  notify(event) {
    if (event.type === 'auth_url') {
      console.log('\nOpen this URL in your browser and approve:\n');
      console.log('  ' + event.url + '\n');
      if (event.instructions) console.log(event.instructions + '\n');
      execFile('open', [event.url], () => {}); // best-effort auto-open on macOS
    } else if (event.type === 'progress' || event.type === 'info') {
      console.log('· ' + event.message);
    }
  },
  // manual paste fallback; the local callback server usually resolves first
  prompt(prompt) {
    return new Promise((resolve, reject) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const onAbort = () => { rl.close(); reject(new Error('cancelled (callback received)')); };
      if (prompt.signal) {
        if (prompt.signal.aborted) return onAbort();
        prompt.signal.addEventListener('abort', onAbort, { once: true });
      }
      rl.question((prompt.message || 'paste code/URL') + '\n> ', (answer) => {
        rl.close();
        resolve(answer.trim());
      });
    });
  },
};

try {
  const cred = await models.login('anthropic', 'oauth', interaction);
  console.log('\n✓ logged in — token stored in game/auth.json');
  console.log('  expires in', Math.round((cred.expires - Date.now()) / 60000), 'min (auto-refreshed after that)');
  process.exit(0);
} catch (e) {
  console.error('\n✗ login failed:', e && e.message || e);
  process.exit(1);
}
