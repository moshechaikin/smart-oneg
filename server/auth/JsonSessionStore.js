import fs from 'node:fs';
import path from 'node:path';
import session from 'express-session';

/**
 * Tiny file-backed session store: sessions survive restarts and redeploys
 * (the in-memory default logged everyone out on every docker rebuild —
 * that was the "logged out often" complaint). Writes are debounced;
 * expired sessions are pruned on load and on read.
 */
export class JsonSessionStore extends session.Store {
  #file; #sessions = {}; #timer = null;

  constructor({ dataDir, filename = 'sessions.json', saveDelayMs = 500 }) {
    super();
    this.#file = path.join(dataDir, filename);
    this.saveDelayMs = saveDelayMs;
    try {
      this.#sessions = JSON.parse(fs.readFileSync(this.#file, 'utf8'));
      const now = Date.now();
      for (const [sid, sess] of Object.entries(this.#sessions)) {
        if (sess?.cookie?.expires && new Date(sess.cookie.expires).getTime() < now) delete this.#sessions[sid];
      }
    } catch { this.#sessions = {}; }
  }

  #persist() {
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      try {
        fs.writeFileSync(this.#file, JSON.stringify(this.#sessions), { mode: 0o600 });
      } catch { /* disk hiccup — sessions stay usable in memory */ }
    }, this.saveDelayMs);
    this.#timer.unref?.();
  }

  get(sid, cb) {
    const sess = this.#sessions[sid];
    if (sess?.cookie?.expires && new Date(sess.cookie.expires).getTime() < Date.now()) {
      delete this.#sessions[sid];
      this.#persist();
      return cb(null, null);
    }
    cb(null, sess ?? null);
  }

  set(sid, sess, cb) {
    this.#sessions[sid] = sess;
    this.#persist();
    cb?.();
  }

  destroy(sid, cb) {
    delete this.#sessions[sid];
    this.#persist();
    cb?.();
  }

  touch(sid, sess, cb) {
    if (this.#sessions[sid]) this.#sessions[sid] = sess;
    this.#persist();
    cb?.();
  }
}
