import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import webpush from 'web-push';
import { hashPassword, safeEqual } from './auth.js';
import { deepMerge } from '../config/schema.js';
import { listBackups, backupPath } from '../config/backups.js';
import { ZipDatabase } from '../calendar/ZipDatabase.js';
import { ISRAELI_CITIES, israeliCityLocation } from '../calendar/israeliCities.js';
import { APP_VERSION } from '../version/appVersion.js';
import { readLogPage, redactLogText, labelLogText } from '../logging/logger.js';

const zipDb = new ZipDatabase();

const SECRET_PATHS = [
  ['auth', 'passwordHash'], ['auth', 'sessionSecret'],
  ['notifications', 'push', 'vapidPrivateKey'],
  ['notifications', 'email', 'appPassword'],
  ['lutron', 'password'],
  ['failover', 'syncToken'],
  ['hubitat', 'accessToken'],
  ['ecobee', 'apiKey'],
  ['ecobee', 'accessToken'],
  ['ecobee', 'refreshToken'],
  ['homeassistant', 'token'],
  ['homebridge', 'password'],
  ['envisalink', 'password'],
  ['envisalink', 'code'],
];

function sanitize(cfg) {
  const out = structuredClone(cfg);
  for (const p of SECRET_PATHS) {
    let obj = out;
    for (const key of p.slice(0, -1)) obj = obj?.[key];
    const last = p[p.length - 1];
    if (obj && obj[last]) obj[last] = '__SET__';
  }
  return out;
}

// Keys whose VALUE is redacted anywhere in the config tree for a shareable
// export — secrets, contact info, network addresses and the precise location.
// Structural/descriptive keys (names, tzid, device kinds, schedules) are kept
// so the config is still meaningful for support/debugging. Matched by key name
// (lower-cased), so it's robust to new bridges adding the same field names.
const REDACT_KEYS = new Set([
  // secrets & credentials
  'password', 'passwordhash', 'apppassword', 'sessionsecret', 'synctoken', 'token',
  'accesstoken', 'refreshtoken', 'apikey', 'clientsecret', 'vapidprivatekey', 'secret',
  'code', 'pin', 'username',
  // contact / identity
  'email', 'user', 'to', 'topic',
  // network addresses
  'host', 'url', 'primaryurl', 'ip',
  // precise location (tzid is kept — broad region, needed to read times)
  'lat', 'lng', 'latitude', 'longitude', 'zip', 'postalcode', 'city', 'state', 'address', 'street', 'elevation',
]);

/** Deep-clone `cfg` with every sensitive value replaced by a redaction marker. */
function redactConfig(cfg) {
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out = {};
      for (const [k, val] of Object.entries(v)) {
        out[k] = REDACT_KEYS.has(k.toLowerCase())
          ? (val == null || val === '' ? val : '‹redacted›')
          : walk(val);
      }
      return out;
    }
    return v;
  };
  return walk(cfg);
}

/** Strip '__SET__' placeholders so a PUT round-trip never overwrites secrets. */
function stripPlaceholders(partial) {
  if (partial === null || typeof partial !== 'object') return partial;
  if (Array.isArray(partial)) return partial.map(stripPlaceholders);
  const out = {};
  for (const [k, v] of Object.entries(partial)) {
    if (v === '__SET__') continue;
    out[k] = stripPlaceholders(v);
  }
  return out;
}


/** Health: standby polling + docker healthcheck. Unauthenticated, never secret-bearing. */
export function healthHandler({ configStore, stateStore, lutron, failover, scheduler, versionChecker }) {
  return (req, res) => {
    const cfg = configStore.get();
    // a health poll bearing our sync token is the backup checking in — record it
    // (in memory) so the primary can alert if the backup later goes silent
    const authHeader = req.headers?.authorization ?? '';
    const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    const tokenOk = Boolean(bearer && cfg.failover.syncToken && safeEqual(bearer, cfg.failover.syncToken));
    if (cfg.instance.role === 'primary' && failover?.noteBackupContact && tokenOk) failover.noteBackupContact();

    // The endpoint is unauthenticated (docker healthcheck, login-page banner,
    // standby poll) — but the FULL payload is only for authenticated callers
    // (browser session or sync token). Anonymous callers must not learn
    // away-mode dates (when the house is empty!), the instance name, version,
    // bridge details, or the primary's LAN URL — with a tunnel this endpoint
    // can be internet-facing.
    const authed = Boolean(req.session?.authed) || tokenOk;
    if (!authed) {
      const fo = failover?.status?.() ?? { role: cfg.instance.role };
      const c = scheduler?.activeCluster?.() ?? null;
      return res.json({
        status: 'ok',
        role: cfg.instance.role,
        setupComplete: cfg.setupComplete,
        // login-page standby banner needs these three; the primary's LAN URL
        // and sync timestamps stay private
        failover: { role: fo.role, active: fo.active ?? false, primaryReachable: fo.primaryReachable },
        // "is Shabbos in effect" is public knowledge (it's the calendar) and
        // documented for external consumers (HA templates) — keep it
        shabbos: c
          ? { active: true, label: c.label, startsAt: c.startsAt, endsAt: c.endsAt }
          : { active: false, label: null, startsAt: null, endsAt: null },
        time: new Date().toISOString(),
      });
    }
    res.json({
      status: 'ok',
      version: APP_VERSION,
      role: cfg.instance.role,
      instanceId: cfg.instance.id,
      name: cfg.instance.name,
      configVersion: cfg.configVersion,
      setupComplete: cfg.setupComplete,
      lutronConnected: lutron.connected,
      // per-bridge connection breakdown (Lutron, Home Assistant, EnvisaLink…)
      // for the dashboard's bridge chip + details modal
      bridges: lutron.bridgeStatus?.() ?? [],
      failoverActive: failover?.active ?? false,
      // presence-simulation (away) mode — powers the top banner on every page
      away: (() => {
        // "active" only within a week of the window (or ongoing); a window
        // further out is "scheduled" (banner shows, card doesn't read as ON).
        const am = cfg.awayMode;
        if (!am?.enabled || !am.from || !am.to) return { active: false, scheduled: false };
        const today = new Date().toISOString().slice(0, 10);
        const in7 = new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10);
        const live = am.to >= today;
        return { active: live && am.from <= in7, scheduled: live && am.from > in7, label: am.label ?? null, from: am.from, to: am.to };
      })(),
      // the standby's live view of the primary (reachable? active? last sync?)
      // powers the dashboard/login banners; primary instances report role only
      failover: failover?.status?.() ?? { role: cfg.instance.role },
      activeClusterId: stateStore.get().activeClusterId,
      // First-class "is Shabbos/Yom Tov in effect right now" for external
      // consumers (Home Assistant templates, scripts). Computed live from the
      // scheduler clock, so it flips exactly at candle lighting / havdalah —
      // and during a test-mode rehearsal it reflects the virtual clock, same
      // as the rest of the app.
      shabbos: (() => {
        const c = scheduler?.activeCluster?.() ?? null;
        return c
          ? { active: true, label: c.label, startsAt: c.startsAt, endsAt: c.endsAt }
          : { active: false, label: null, startsAt: null, endsAt: null };
      })(),
      lastCompileAt: stateStore.get().lastCompileAt,
      // best-effort "is there a newer release?" for the nav badge (offline-safe)
      update: versionChecker?.status?.() ?? { current: APP_VERSION, updateAvailable: false },
      testMode: scheduler?.testModeInfo?.() ?? { active: false },
      scenePreview: scheduler?.scenePreviewInfo?.() ?? { active: false },
      time: new Date().toISOString(),
      uptimeSec: Math.round(process.uptime()),
    });
  };
}

/**
 * "Is Shabbos or Yom Tov in effect right now?" — a tiny, purpose-built,
 * unauthenticated endpoint for guarding external automations (Home Assistant,
 * Apple Shortcuts/HomeKit, scripts). Put a call to it at the top of a weekday
 * automation and skip the automation when `active` is true.
 *
 * It's the same fact already carried in /api/health.shabbos, split out so a
 * caller can hit one small JSON payload instead of parsing the full health
 * object. Computed live from the scheduler clock, so it flips exactly at candle
 * lighting / havdalah — and during a test-mode rehearsal it reflects the
 * virtual clock, same as the rest of the app. `active` is the only field most
 * callers need; the rest are there for building richer automations.
 */
export function onegHandler({ scheduler }) {
  return (_req, res) => {
    const c = scheduler?.activeCluster?.() ?? null;
    // poll-driven and fast-flipping — never let a proxy or browser serve a
    // stale answer across the candle-lighting / havdalah boundary
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      active: Boolean(c),
      label: c?.label ?? null,
      startsAt: c?.startsAt ?? null,
      endsAt: c?.endsAt ?? null,
      now: new Date(scheduler?.now?.() ?? Date.now()).toISOString(),
    });
  };
}

export function systemRouter({ configStore, stateStore, scheduler, lutron, failover, versionChecker, notifier, ring, logDir, logger, dataDir }) {
  const router = Router();

  // Software version + update availability (best-effort; offline-safe).
  router.get('/version', (_req, res) => res.json(versionChecker?.status?.() ?? { current: APP_VERSION, updateAvailable: false }));
  router.post('/version/check', async (_req, res) => res.json(versionChecker ? await versionChecker.check() : { current: APP_VERSION, updateAvailable: false }));

  // Update the running app. When the Docker socket is available we trigger an
  // in-place update (a one-shot Watchtower recreates this container from the
  // freshly-pulled image); otherwise we hand back the exact command to run on
  // the host. Either way user data in ./data is untouched.
  router.post('/system/update', async (_req, res) => {
    const manual = 'docker compose pull && docker compose up -d';
    const status = versionChecker?.status?.() ?? {};
    if (!status.canSelfUpdate) {
      return res.json({ ok: false, mode: 'manual', command: manual,
        message: 'Automatic update needs the Docker socket mounted (see the docs). Run this on the host, then the app comes back on the new version:' });
    }
    try {
      const { selfUpdate } = await import('../version/SelfUpdater.js');
      await selfUpdate({ logger });
      res.json({ ok: true, mode: 'auto', message: 'Update started, this instance will pull the new image and restart automatically in a moment.' });
    } catch (err) {
      logger?.error({ err: err.message }, 'self-update failed');
      res.json({ ok: false, mode: 'manual', command: manual,
        message: `Automatic update could not start (${err.message}). Update from the host instead:` });
    }
  });

  router.get('/zip/:zip', (req, res) => {
    const hit = zipDb.lookup(req.params.zip);
    if (!hit) return res.status(404).json({ error: 'zip code not found' });
    res.json(hit);
  });

  // Israel mode: a curated city list (no zip lookup exists for Israel offline).
  router.get('/il-cities', (_req, res) => res.json(ISRAELI_CITIES.map(({ name, he }) => ({ name, he }))));
  router.get('/il-city/:name', (req, res) => {
    const loc = israeliCityLocation(req.params.name);
    if (!loc) return res.status(404).json({ error: 'city not found' });
    res.json(loc);
  });

  /**
   * Graceful self-restart. Under Docker (restart: unless-stopped) the
   * container comes right back with the new settings; the frontend overlays
   * a "restarting" screen and polls /api/health until it returns.
   */
  router.post('/system/restart', (_req, res) => {
    logger?.warn('restart requested from the UI');
    res.json({ ok: true });
    setTimeout(() => process.kill(process.pid, 'SIGTERM'), 400);
  });

  router.get('/settings', (_req, res) => res.json(sanitize(configStore.get())));

  router.put('/settings', (req, res) => {
    try {
      const partial = stripPlaceholders(req.body ?? {});
      if (partial.auth?.password) {
        // same floor as /auth/reset-credentials — this path used to accept anything
        if (String(partial.auth.password).length < 8) {
          return res.status(400).json({ error: 'Password must be at least 8 characters' });
        }
        partial.auth.passwordHash = hashPassword(partial.auth.password);
        delete partial.auth.password;
      }
      const next = configStore.update(partial);
      res.json(sanitize(next));
    } catch (err) {
      res.status(400).json({ error: err.message, details: err.validationErrors });
    }
  });

  router.post('/settings/lutron/test', async (req, res) => {
    const { LutronClient } = await import('../lutron/LutronClient.js');
    const { host, port, username, password } = deepMerge(configStore.get().lutron, stripPlaceholders(req.body ?? {}));
    const zoneIds = configStore.get().zones.map((z) => z.id);
    const probe = new LutronClient({ host, port, username, password, zoneIds: zoneIds.slice(0, 3), commandTimeoutMs: 3000 });
    try {
      await probe.connect();
      const levels = Object.fromEntries(await probe.primeAllZones());
      res.json({ ok: true, levels });
    } catch (err) {
      res.status(502).json({ ok: false, error: err.message });
    } finally {
      probe.close();
    }
  });

  router.get('/sync/export', (req, res) => {
    // redacted=1: a shareable export (location, secrets, emails, hosts stripped)
    // for support/debugging. Default: the full config incl. secrets — this IS
    // the failover mirror/backup mechanism, so it must stay complete.
    if (req.query.redacted === '1') {
      res.setHeader('Content-Disposition', 'attachment; filename="smartoneg-config-redacted.json"');
      return res.json(redactConfig(configStore.get()));
    }
    res.setHeader('Content-Disposition', 'attachment; filename="smartoneg-config.json"');
    res.json(configStore.get());
  });

  router.post('/config/import', (req, res) => {
    try {
      const next = configStore.import(req.body);
      res.json(sanitize(next));
    } catch (err) {
      res.status(400).json({ error: err.message, details: err.validationErrors });
    }
  });

  // ── nightly backups: 14 rolling daily snapshots of config.json ──────────
  router.get('/backups', (_req, res) => res.json(dataDir ? listBackups(dataDir) : []));

  router.get('/backups/:name', (req, res) => {
    const file = dataDir && backupPath(dataDir, req.params.name);
    if (!file) return res.status(404).json({ error: 'backup not found' });
    res.setHeader('Content-Disposition', `attachment; filename="${req.params.name}"`);
    res.sendFile(path.resolve(file));
  });

  router.post('/backups/:name/restore', (req, res) => {
    const file = dataDir && backupPath(dataDir, req.params.name);
    if (!file) return res.status(404).json({ error: 'backup not found' });
    try {
      logger?.warn({ backup: req.params.name }, 'restoring config from daily backup');
      const next = configStore.import(JSON.parse(fs.readFileSync(file, 'utf8')));
      res.json(sanitize(next));
    } catch (err) {
      res.status(400).json({ error: err.message, details: err.validationErrors });
    }
  });

  /** Full factory reset — wipes all settings incl. the account, back to wizard. */
  router.post('/config/reset', (_req, res) => {
    logger?.warn('FULL SETTINGS RESET requested from the UI');
    configStore.reset(); // the config-change listener re-runs the (now empty) compile
    res.json({ ok: true });
  });

  /**
   * Test mode: run the scheduler on a virtual clock so a Shabbos/Yom Tov can be
   * demoed/tested any day. Body { virtualNow: ISO|ms }. Refused during a real
   * cluster. DELETE returns to real time.
   */
  router.post('/test-mode', async (req, res) => {
    const raw = req.body?.virtualNow;
    const ms = typeof raw === 'number' ? raw : Date.parse(raw);
    if (!Number.isFinite(ms)) return res.status(400).json({ error: 'virtualNow must be an ISO date or ms timestamp' });
    try {
      await scheduler.setTestMode(ms);
      res.json({ ok: true, testMode: scheduler.testModeInfo() });
    } catch (err) {
      res.status(409).json({ error: err.message });
    }
  });

  router.delete('/test-mode', async (_req, res) => {
    await scheduler.clearTestMode();
    res.json({ ok: true });
  });

  /** Change the admin account (email/password) without a full reset. */
  router.post('/auth/reset-credentials', (req, res) => {
    const { email, password } = req.body ?? {};
    if (!email || !password || password.length < 8) {
      return res.status(400).json({ error: 'Email and a password of at least 8 characters are required' });
    }
    configStore.update({ auth: { email, passwordHash: hashPassword(password) } });
    res.json({ ok: true });
  });

  // ── logs ────────────────────────────────────────────────────────────────
  router.get('/logs', (req, res) => {
    const { q, level, from, to, before, limit } = req.query;
    const n = limit ? Number(limit) : undefined;
    // Read from app.log (far deeper than the in-memory ring) for:
    //  - `before`: scroll-back pagination (entries older than a timestamp);
    //  - a search (`q`) or level filter: so it finds matches across the WHOLE
    //    history, not just the newest ring window — the user shouldn't have to
    //    scroll back manually before searching for something old.
    // The plain newest view (no filter) stays on the fast ring.
    if (logDir && (before || q || level)) {
      // `before` may be epoch ms or an ISO string (entry times are ISO now)
      const beforeMs = before ? (Number(before) || Date.parse(before)) : null;
      return res.json(readLogPage(logDir, { before: beforeMs, level, q, limit: n ?? 500 }));
    }
    res.json(ring.query({ q, level, from, to, limit: n }));
  });

  router.get('/logs/stream', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('retry: 3000\n\n');
    const unsub = ring.subscribe((entry) => res.write(`data: ${JSON.stringify(entry)}\n\n`));
    req.on('close', unsub);
  });

  router.get('/logs/download', (req, res) => {
    const file = logDir ? path.join(logDir, 'app.log') : null;
    if (!file || !fs.existsSync(file)) return res.status(404).json({ error: 'no log file' });
    // Every line gets a leading level label (ERROR/WARN/INFO/DEBUG…) so a saved
    // log is greppable by severity — the raw JSON only carries the numeric level.
    let text = labelLogText(fs.readFileSync(file, 'utf8'));
    // redacted=1: strip IPs, emails and secret values so the log can be shared
    if (req.query.redacted === '1') {
      res.setHeader('Content-Disposition', 'attachment; filename="smartoneg-redacted.log"');
      return res.send(redactLogText(text));
    }
    res.setHeader('Content-Disposition', 'attachment; filename="smartoneg.log"');
    res.send(text);
  });

  // ── push + notification test ────────────────────────────────────────────
  router.get('/push/vapid-public-key', (_req, res) => {
    let { push } = configStore.get().notifications;
    if (!push.vapidPublicKey) {
      const keys = webpush.generateVAPIDKeys();
      configStore.update({ notifications: { push: { vapidPublicKey: keys.publicKey, vapidPrivateKey: keys.privateKey } } });
      push = configStore.get().notifications.push;
    }
    res.json({ key: push.vapidPublicKey });
  });

  router.post('/push/subscribe', (req, res) => {
    try { logger?.info({ endpoint: new URL(req.body?.endpoint ?? '').host }, 'push subscription added'); } catch { logger?.warn('push subscribe with unparsable endpoint'); }
    const sub = req.body;
    if (!sub?.endpoint) return res.status(400).json({ error: 'invalid subscription' });
    const { push } = configStore.get().notifications;
    if (!push.subscriptions.some((s) => s.endpoint === sub.endpoint)) {
      configStore.update({ notifications: { push: { ...push, subscriptions: [...push.subscriptions, sub] } } });
    }
    res.json({ ok: true });
  });

  router.delete('/push/subscribe', (req, res) => {
    const { push } = configStore.get().notifications;
    configStore.update({
      notifications: { push: { ...push, subscriptions: push.subscriptions.filter((s) => s.endpoint !== req.body?.endpoint) } },
    });
    res.json({ ok: true });
  });

  router.post('/notify/test', async (req, res) => {
    try {
      const msg = await notifier.send('test', { channel: req.body?.channel });
      res.json({ ok: true, message: msg });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  return router;
}
