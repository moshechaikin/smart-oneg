import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';

const attempts = new Map(); // tcp peer -> { count, resetAt }
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 60_000;

/** Peer-keyed failure bucket shared by login and claim-session. */
const rateLimit = {
  blocked(peer) {
    const now = Date.now();
    for (const [k, v] of attempts) if (now > v.resetAt) attempts.delete(k);
    const a = attempts.get(peer);
    return Boolean(a && a.count >= MAX_ATTEMPTS && now < a.resetAt);
  },
  recordFailure(peer) {
    const now = Date.now();
    const cur = attempts.get(peer) ?? { count: 0, resetAt: now + WINDOW_MS };
    if (now > cur.resetAt) { cur.count = 0; cur.resetAt = now + WINDOW_MS; }
    cur.count += 1;
    attempts.set(peer, cur);
  },
  clear(peer) { attempts.delete(peer); },
};

// Burned on every wrong-email attempt so the response takes the same time as
// a wrong-password attempt — no account enumeration via timing.
const DUMMY_HASH = bcrypt.hashSync('smartoneg-timing-pad', 10);

/** Constant-time string comparison (length is not secret). */
export function safeEqual(a, b) {
  const ab = Buffer.from(String(a ?? ''));
  const bb = Buffer.from(String(b ?? ''));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

export function authRouter({ configStore, logger }) {
  const router = Router();

  router.post('/login', (req, res) => {
    // Rate-limit on the real TCP peer, NOT req.ip: trust proxy is enabled
    // (Cloudflare Tunnel / Tailscale front the app), so req.ip honors
    // X-Forwarded-For — which a direct LAN client can spoof to mint a fresh
    // bucket per attempt and brute-force without limit.
    const peer = req.socket.remoteAddress ?? 'unknown';
    if (rateLimit.blocked(peer)) {
      return res.status(429).json({ error: 'Too many attempts, wait a minute' });
    }
    const { email, password } = req.body ?? {};
    const auth = configStore.get().auth;
    const passOk = bcrypt.compareSync(password ?? '', auth.passwordHash || DUMMY_HASH);
    const ok = Boolean(auth.passwordHash)
      && email?.toLowerCase() === auth.email.toLowerCase()
      && passOk;
    if (!ok) {
      rateLimit.recordFailure(peer);
      logger?.warn({ ip: req.ip, peer, email }, 'failed login');
      return res.status(401).json({ error: 'Username and/or password incorrect' });
    }
    rateLimit.clear(peer);
    // Rotate the session id on privilege change (session fixation defense).
    req.session.regenerate((err) => {
      if (err) {
        logger?.error({ err: err.message }, 'session regenerate failed');
        return res.status(500).json({ error: 'session error' });
      }
      req.session.authed = true;
      req.session.email = auth.email;
      res.json({ ok: true, email: auth.email });
    });
  });

  router.post('/logout', (req, res) => {
    req.session.destroy(() => res.json({ ok: true }));
  });

  // Standby setup only: mint a browser session using the sync token (a secret
  // the standby already holds). Lets the setup wizard finish straight into the
  // dashboard instead of a re-login — the standby has the primary's mirrored
  // credentials but no plaintext password to log in with.
  router.post('/claim-session', (req, res) => {
    // same peer-keyed limiter as login — the token is a 32-char nanoid so
    // brute force is infeasible anyway, but a limiter costs nothing
    const peer = req.socket.remoteAddress ?? 'unknown';
    if (rateLimit.blocked(peer)) {
      return res.status(429).json({ error: 'Too many attempts, wait a minute' });
    }
    const cfg = configStore.get();
    const auth = (req.headers.authorization ?? '');
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (cfg.instance.role !== 'standby' || !cfg.failover.syncToken || !safeEqual(token, cfg.failover.syncToken)) {
      rateLimit.recordFailure(peer);
      return res.status(401).json({ error: 'not authorized' });
    }
    rateLimit.clear(peer);
    req.session.regenerate((err) => {
      if (err) { logger?.error({ err: err.message }, 'claim-session regenerate failed'); return res.status(500).json({ error: 'session error' }); }
      req.session.authed = true;
      req.session.email = cfg.auth.email;
      res.json({ ok: true });
    });
  });

  router.get('/me', (req, res) => {
    const auth = configStore.get().auth;
    res.json({
      authed: Boolean(req.session?.authed),
      setupComplete: configStore.get().setupComplete,
      authConfigured: Boolean(auth.passwordHash),
      email: req.session?.authed ? auth.email : null,
    });
  });

  return router;
}

/**
 * Gate for all /api routes except /api/auth/* and /api/health.
 * - Session cookie (browser)
 * - Bearer sync token (standby instance / automation)
 * - Open only while setup is incomplete AND no password exists yet (wizard).
 */
export function requireAuth(configStore) {
  return (req, res, next) => {
    if (req.session?.authed) return next();
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    const syncToken = configStore.get().failover.syncToken;
    if (token && syncToken && safeEqual(token, syncToken)) return next();
    const { setupComplete, auth } = configStore.get();
    if (!setupComplete && !auth.passwordHash) return next();
    return res.status(401).json({ error: 'Authentication required' });
  };
}

export function hashPassword(plain) {
  return bcrypt.hashSync(plain, 10);
}
