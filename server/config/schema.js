import { nanoid } from 'nanoid';
import crypto from 'node:crypto';

export const CURRENT_SCHEMA_VERSION = 1;

export function defaultConfig() {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    configVersion: 0,
    instance: { id: nanoid(), role: 'primary', name: '' },
    location: {
      zip: '', lat: null, lng: null, city: '', state: '',
      tzid: 'America/New_York', il: false, elevation: 0,
    },
    times: { candleLightingMins: 18, havdalahMins: 45, tzeitAngle: 8.5 },
    display: { locale: 'ashkenazi' }, // holiday-name style: ashkenazi | en (Sephardic) | he | he-x-NoNikud
    auth: { email: '', passwordHash: '', sessionSecret: crypto.randomBytes(32).toString('hex') },
    lutron: { enabled: false, host: '', port: 23, username: 'lutron', password: 'integration', mock: false },
    // Hubitat Maker API (optional; local LAN). Bridges Zigbee/Z-Wave/Ecobee devices.
    hubitat: { enabled: false, host: '', appId: '', accessToken: '', pollSeconds: 30 },
    // Home Assistant (optional; local REST + websocket push — full Child Lock parity)
    homeassistant: { enabled: false, host: '', token: '', pollSeconds: 60 },
    // Homebridge config-ui-x (optional; POLLED — Child Lock corrections lag pollSeconds)
    homebridge: { enabled: false, host: '', username: '', password: '', pollSeconds: 5 },
    // Matter-over-IP controller (optional; EXPERIMENTAL, untested on hardware)
    matter: { enabled: false },
    // Native Ecobee cloud API (optional). Hubitat pairing is recommended instead —
    // it stays local; this depends on internet + Ecobee's cloud during Shabbos.
    ecobee: { enabled: false, apiKey: '', pendingCode: '', accessToken: '', refreshToken: '', tokenExpiresAt: 0, pollSeconds: 120 },
    // EnvisaLink alarm bridge (EVL-3/4/4EZR over the local TPI on port 4025).
    // Exposes the partition (arm/disarm) and per-zone bypass as on/off devices.
    envisalink: { enabled: false, host: '', port: 4025, password: '', code: '', partition: 1, armMode: 'stay', mock: false },
    zones: [],
    // display-only ordering of rooms on the Devices page (room names, in order);
    // rooms not listed fall to the end alphabetically. Device order within a
    // room follows the order of entries in `zones`.
    roomOrder: [],
    scenes: [],
    schedules: {},
    // begins: null = Child Lock starts at candle lighting; {kind:'firstRule'}
    // starts it at the cluster's earliest scheduled rule (erev prep included).
    // ({kind:'fixed',time,onlyIfSunsetAfter} kept for legacy configs.)
    enforcement: { enabled: false, graceSeconds: 5, overridePresses: 4, begins: null },
    // Guest mode: when on, guest rules override the regular schedule for the
    // specific devices they name. `until` is the havdalah of the cluster it was
    // enabled for; after that it auto-expires. null until = no active window.
    guestMode: { enabled: false, until: null },
    // Away mode: presence simulation over a date window [from,to] (inclusive,
    // local dates). Layers seeded, deterministic randomness on the user's own
    // schedule — jittered times, shorter lit periods, quiet hours, some nights
    // dark — so the house looks lived-in with lights on for less time. Mutually
    // exclusive with guest mode. Auto-expires after `to`.
    awayMode: {
      enabled: false, from: null, to: null, label: null,
      jitterMin: 15, shortenPct: 25, quietFrom: '23:00', quietTo: '06:00', varyPct: 18,
      seed: nanoid(10),
    },
    failover: {
      primaryUrl: '', syncToken: nanoid(32),
      pollSeconds: 10, failThreshold: 3, recoverThreshold: 6,
    },
    // Software update checking. autoCheck=false stops ALL automatic outbound
    // requests (the once-a-day GET to smartoneg.com/version.json); the manual
    // "Check now" button still works because that's a deliberate user action.
    updates: { autoCheck: true },
    notifications: {
      email: { enabled: false, host: 'smtp.gmail.com', port: 465, user: '', appPassword: '', to: '' },
      ntfy: { enabled: false, server: 'https://ntfy.sh', topic: '' },
      push: { vapidPublicKey: '', vapidPrivateKey: '', subscriptions: [] },
      preYomTovSummaryDays: 7,
      // Per-category, per-channel opt-out. Everything on by default; the user
      // can silence a category on email and/or ntfy from Settings. A missing
      // value is treated as ON, so this stays backward-compatible.
      categories: {
        bridge: { email: true, ntfy: true, push: true },
        failover: { email: true, ntfy: true, push: true },
        childlock: { email: true, ntfy: true, push: true },
        summary: { email: true, ntfy: true, push: true },
        modes: { email: true, ntfy: true, push: true },
        updates: { email: true, ntfy: true, push: true },
        system: { email: true, ntfy: true, push: true },
      },
    },
    setupComplete: false,
  };
}

/**
 * Deep-merge `partial` over `base`. Arrays and null replace wholesale;
 * plain objects merge recursively. Used both for defaults-filling on load
 * and for PATCH-style settings updates.
 */
export function deepMerge(base, partial) {
  if (partial === undefined) return base;
  if (partial === null || Array.isArray(partial) || typeof partial !== 'object'
    || base === null || Array.isArray(base) || typeof base !== 'object') {
    return partial;
  }
  const out = { ...base };
  for (const [k, v] of Object.entries(partial)) {
    out[k] = deepMerge(base[k], v);
  }
  return out;
}

/**
 * Validate essential config shape. Returns { valid, errors }. Intentionally
 * lenient about unknown keys (forward compatibility for imports).
 */
export function validateConfig(cfg) {
  const errors = [];
  const check = (cond, msg) => { if (!cond) errors.push(msg); };

  check(cfg && typeof cfg === 'object', 'config must be an object');
  if (errors.length) return { valid: false, errors };

  check(Number.isInteger(cfg.schemaVersion), 'schemaVersion must be an integer');
  check(cfg.schemaVersion <= CURRENT_SCHEMA_VERSION, `schemaVersion ${cfg.schemaVersion} is newer than supported ${CURRENT_SCHEMA_VERSION}`);
  check(['primary', 'standby'].includes(cfg.instance?.role), 'instance.role must be primary|standby');
  check(typeof cfg.location?.tzid === 'string' && cfg.location.tzid.length > 0, 'location.tzid required');
  check(typeof cfg.times?.candleLightingMins === 'number' && cfg.times.candleLightingMins >= 0 && cfg.times.candleLightingMins <= 120,
    'times.candleLightingMins must be 0-120');
  check(typeof cfg.times?.havdalahMins === 'number' && cfg.times.havdalahMins >= 0 && cfg.times.havdalahMins <= 180,
    'times.havdalahMins must be 0-180');
  check(['ashkenazi', 'en', 'he', 'he-x-NoNikud'].includes(cfg.display?.locale),
    'display.locale must be one of ashkenazi|en|he|he-x-NoNikud');
  check(typeof cfg.lutron?.host === 'string', 'lutron.host required');
  check(Array.isArray(cfg.zones), 'zones must be an array');
  for (const z of cfg.zones ?? []) {
    check(Number.isInteger(z.id), `zone id must be integer (got ${JSON.stringify(z.id)})`);
    check(['lutron', 'hubitat', 'virtual', 'ecobee', 'homeassistant', 'homebridge', 'matter', 'envisalink', undefined].includes(z.source), `zone ${z.id}: unknown source ${z.source}`);
  }
  const ids = (cfg.zones ?? []).map((z) => z.id);
  check(new Set(ids).size === ids.length, 'zone ids must be unique');
  check(Array.isArray(cfg.scenes), 'scenes must be an array');
  check(cfg.schedules && typeof cfg.schedules === 'object', 'schedules must be an object');
  check(typeof cfg.enforcement?.graceSeconds === 'number' && cfg.enforcement.graceSeconds >= 0,
    'enforcement.graceSeconds must be >= 0');
  check(Number.isInteger(cfg.enforcement?.overridePresses) && cfg.enforcement.overridePresses >= 2,
    'enforcement.overridePresses must be an integer >= 2');
  check(cfg.enforcement?.begins == null
    || cfg.enforcement.begins.kind === 'firstRule'
    || cfg.enforcement.begins.kind === 'shkia'
    || (cfg.enforcement.begins.kind === 'fixed' && /^\d{2}:\d{2}$/.test(cfg.enforcement.begins.time ?? '')
      && (cfg.enforcement.begins.onlyIfSunsetAfter == null || /^\d{2}:\d{2}$/.test(cfg.enforcement.begins.onlyIfSunsetAfter))),
    'enforcement.begins must be null, { kind: "firstRule" }, { kind: "shkia" }, or a legacy { kind: "fixed", time, onlyIfSunsetAfter? }');

  return { valid: errors.length === 0, errors };
}

/**
 * Migrations: index N upgrades schemaVersion N to N+1. Currently empty;
 * append functions here when the schema changes so old exports stay importable.
 */
const migrations = [];

export function migrateConfig(cfg) {
  let out = cfg;
  while (out.schemaVersion < CURRENT_SCHEMA_VERSION) {
    const step = migrations[out.schemaVersion];
    if (!step) throw new Error(`No migration from schemaVersion ${out.schemaVersion}`);
    out = { ...step(out), schemaVersion: out.schemaVersion + 1 };
  }
  normalizeEnforcement(out);
  return out;
}

/**
 * Coerce Child Lock bounds into the supported range on EVERY write (load,
 * update, import, reset) so no stored or imported config can brick the app or
 * exceed the UI limits — clamping rather than rejecting keeps a self-hosted
 * box booting no matter what's on disk. Mutates and returns `cfg`.
 *  - grace delay clamped to 0–15s;
 *  - manual-hold presses clamped to 2–10 (1 would latch on the first touch,
 *    which just defeats the feature — disable enforce on the device instead);
 *  - the old fixed 300s override window (previous default) is dropped so the
 *    window derives from the grace delay (see EnforcementEngine).
 */
export function normalizeEnforcement(cfg) {
  const e = cfg?.enforcement;
  if (e) {
    if (e.overrideWindowSeconds === 300) delete e.overrideWindowSeconds;
    if (typeof e.graceSeconds === 'number') e.graceSeconds = Math.min(15, Math.max(0, e.graceSeconds));
    if (Number.isInteger(e.overridePresses)) e.overridePresses = Math.min(10, Math.max(2, e.overridePresses));
  }
  return cfg;
}
