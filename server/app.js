import express from 'express';
import session from 'express-session';
import { JsonSessionStore } from './auth/JsonSessionStore.js';
import memorystoreFactory from 'memorystore';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { authRouter, requireAuth } from './routes/auth.js';
import { systemRouter, healthHandler, onegHandler } from './routes/system.js';
import { lightingRouter } from './routes/lighting.js';
import { schedulingRouter } from './routes/scheduling.js';
import { hubitatRouter, hubitatWebhook } from './routes/hubitat.js';
import { ecobeeRouter } from './routes/ecobee.js';
import { homeAssistantRouter } from './routes/homeassistant.js';
import { homebridgeRouter } from './routes/homebridge.js';
import { matterRouter } from './routes/matter.js';

const MemoryStore = memorystoreFactory(session);
const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

/**
 * A backup (standby) instance mirrors the primary's config and only drives
 * lights while the primary is down. So on a standby we reject two kinds of
 * authenticated writes with a clear 409 the UI turns into a toast:
 *   - content edits (devices, scenes, schedules, settings) — the primary owns
 *     them and they sync here automatically; editing here would be overwritten.
 *   - live hardware control (scene preview, test mode, device buttons) while
 *     the standby is INACTIVE — no bridges are connected until it takes over.
 * The standby's own identity (instance role / failover URL) and recovery
 * escape-hatches (restart, import, reset, backup restore, auth, push) stay open.
 */
export function standbyGuard({ configStore, failover }) {
  const isWrite = (m) => m === 'POST' || m === 'PUT' || m === 'PATCH' || m === 'DELETE';
  const EDIT = [
    /^\/scenes(\/[^/]+)?$/,        // create / update / delete a scene (preview handled below)
    /^\/schedules\//,             // edit a day's rules
    /^\/guest-mode$/, /^\/away-mode$/,
    /^\/zones\/manual$/, /^\/zones\/import$/, /^\/rooms\/rename$/,
    /^\/zones\/\d+$/,             // rename / delete a device
  ];
  const CONTROL = [
    /^\/scenes\/[^/]+\/preview$/,
    /^\/test-mode$/,
    /^\/zones\/\d+\/command$/, /^\/zones\/\d+\/flash$/,
    /^\/latches\//,
  ];
  const EDIT_MSG = 'This is the backup instance. Make changes on the primary — they mirror here automatically.';
  const INACTIVE_MSG = 'The backup is standing by, so no light bridges are connected. This only works when the primary is down and this instance is active.';
  const DEFERRING_MSG = 'The primary is back online and control is returning to it. Use the primary instead.';
  return (req, res, next) => {
    if (configStore.get().instance.role !== 'standby') return next();
    if (!isWrite(req.method)) return next();
    const p = req.path;
    if (p === '/settings' && req.method === 'PUT') {
      const keys = Object.keys(req.body ?? {});
      if (keys.length && keys.every((k) => k === 'instance' || k === 'failover')) return next();
      return res.status(409).json({ error: EDIT_MSG, standby: 'readonly' });
    }
    if (CONTROL.some((re) => re.test(p))) {
      if (req.method === 'DELETE') return next(); // exiting/clearing is always allowed
      // Gate on DRIVE AUTHORITY, not on `active`: a deferring standby (taken
      // over, but the primary is provably back and it has stood down from
      // driving) still has its bridge CONNECTED, so `active` alone would let a
      // manual command / scene preview / test-mode here drive the same zones
      // as the recovered primary — or worse, arm a virtual clock that starts
      // driving real lights if the primary drops again and deferral lifts.
      const driving = failover?.drivesLights ? failover.drivesLights() : failover?.active;
      if (!driving) {
        return failover?.active
          ? res.status(409).json({ error: DEFERRING_MSG, standby: 'deferring' })
          : res.status(409).json({ error: INACTIVE_MSG, standby: 'inactive' });
      }
      return next();
    }
    if (EDIT.some((re) => re.test(p))) return res.status(409).json({ error: EDIT_MSG, standby: 'readonly' });
    return next();
  };
}

/**
 * Express app factory — no listen() here so tests can drive it with supertest.
 */
export function createApp(deps) {
  const { configStore, logger } = deps;
  const app = express();
  app.set('trust proxy', 1); // Cloudflare Tunnel / Tailscale Funnel front the app
  app.disable('x-powered-by');
  // baseline security headers: never framed (clickjacking), no MIME sniffing,
  // and referrers stay within the app (URLs can carry a hash route)
  app.use((_req, res, next) => {
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });
  app.use(express.json({ limit: '4mb' }));
  app.use(session({
    secret: configStore.get().auth.sessionSecret,
    resave: false,
    saveUninitialized: false,
    rolling: true, // any activity extends the session — regulars never expire
    // sessions persist to the data dir so a redeploy doesn't log everyone out;
    // tests (no dataDir) keep the in-memory store
    store: deps.dataDir
      ? new JsonSessionStore({ dataDir: deps.dataDir })
      : new MemoryStore({ checkPeriod: 3600_000 }),
    // secure:'auto' — Secure is set when the request arrived over HTTPS
    // (Cloudflare Tunnel etc., via trust proxy); plain-HTTP LAN still works
    cookie: { httpOnly: true, sameSite: 'lax', secure: 'auto', maxAge: 180 * 86400_000 },
  }));

  app.use('/api/auth', authRouter(deps));
  app.get('/api/health', healthHandler(deps));
  // "Is Shabbos/Yom Tov active right now?" — unauthenticated (same public fact
  // as health.shabbos) so automations can guard on it without a token. Named
  // /oneg because a single Oneg covers both Shabbos and Yom Tov.
  app.get('/api/oneg', onegHandler(deps));
  app.post('/api/hubitat/events', hubitatWebhook(deps)); // token-in-query auth (Maker API can't send headers)

  const gate = requireAuth(configStore);
  app.use('/api', gate, standbyGuard(deps));
  app.use('/api', gate, systemRouter(deps));
  app.use('/api', gate, lightingRouter(deps));
  app.use('/api', gate, schedulingRouter(deps));
  app.use('/api', gate, hubitatRouter(deps));
  app.use('/api', gate, ecobeeRouter(deps));
  app.use('/api', gate, homeAssistantRouter(deps));
  app.use('/api', gate, homebridgeRouter(deps));
  app.use('/api', gate, matterRouter(deps));

  // no-cache (NOT no-store): browsers keep the file but must revalidate via
  // ETag before using it — a cheap 304 normally. iOS Safari otherwise reuses
  // cached module scripts on reload, so fixes "deploy" but never reach phones.
  app.use(express.static(publicDir, {
    setHeaders: (res, filePath) => {
      if (/\.(js|css|html|webmanifest)$/.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
    },
  }));
  // SPA fallback for hash-less deep links (PWA start_url etc.)
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));

  app.use((err, _req, res, _next) => {
    logger?.error({ err: err.message, stack: err.stack }, 'unhandled route error');
    res.status(500).json({ error: 'internal error' });
  });

  return app;
}
