#!/usr/bin/env node
/**
 * Emergency password reset — for when the admin is locked out of the web UI.
 *
 * Host access is the root of trust: anyone who can run this can already read
 * data/config.json, so this adds no attack surface — it just replaces manual
 * file surgery with a safe, validated write (crash-safe rename + .bak, and a
 * configVersion bump so a standby instance mirrors the new credentials).
 *
 * Usage (Docker):
 *   docker compose exec smart-oneg npm run reset-password -- you@email.com 'new-password'
 *   docker compose restart smart-oneg        # REQUIRED — the running app holds config in memory
 *
 * Bare Node:  DATA_DIR=./data npm run reset-password -- you@email.com 'new-password'
 *
 * Add --clear-sessions to also log out every signed-in device (use this if
 * you're resetting because you suspect the old password was compromised).
 *
 * Lives under server/ (not scripts/) so it SHIPS IN THE DOCKER IMAGE — the
 * runtime stage only copies server/ + public/, and scripts/ is dockerignored.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ConfigStore } from '../config/ConfigStore.js';
import { hashPassword } from '../routes/auth.js';

const args = process.argv.slice(2).filter((a) => a !== '--clear-sessions');
const clearSessions = process.argv.includes('--clear-sessions');
const [email, password] = args;

if (!email || !email.includes('@') || !password) {
  console.error('Usage: node scripts/reset-password.mjs <email> <new-password> [--clear-sessions]');
  process.exit(1);
}
if (String(password).length < 8) { // same floor as the web UI
  console.error('Password must be at least 8 characters.');
  process.exit(1);
}

// same resolution order as server/index.js
const dataDir = process.env.DATA_DIR ?? (fs.existsSync('/data') ? '/data' : path.resolve('data'));
if (!fs.existsSync(path.join(dataDir, 'config.json'))) {
  console.error(`No config.json found in ${dataDir} — is this the right data directory? (set DATA_DIR)`);
  process.exit(1);
}

const store = new ConfigStore({ dataDir });
store.load();
store.update({ auth: { email, passwordHash: hashPassword(password) } });

if (clearSessions) {
  try { fs.rmSync(path.join(dataDir, 'sessions.json'), { force: true }); } catch { /* best effort */ }
}

console.log(`✔ Credentials updated for ${email}${clearSessions ? ' (all sessions cleared)' : ''}.`);
console.log('  Now RESTART the app so it picks up the change:');
console.log('    docker compose restart smart-oneg');
