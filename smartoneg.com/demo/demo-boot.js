// Static demo runtime. Patches fetch() so the real SmartOneg frontend runs
// with NO backend: config lives in localStorage, and zmanim / the timeline are
// computed in-browser by the app's real calendar + compiler engine (the same
// code the server runs). Nothing here talks to a server.
import { DEMO_SEED, DAY_TYPES } from './demo-seed.js';
import { CalendarService } from './engine/calendar/CalendarService.js';
import { VARIANTS_BY_DAY_TYPE, CHUL_ONLY_DAY_TYPES } from './engine/calendar/dayTypes.js';
import { TimelineCompiler } from './engine/engine/TimelineCompiler.js';
import { SceneRepository } from './engine/engine/SceneRepository.js';
import { ConflictDetector } from './engine/engine/ConflictDetector.js';
import { findZoneReferences } from './engine/engine/references.js';

// lets the shared frontend know it's running in the read-only static demo
window.__SMARTONEG_DEMO__ = true;

const CFG_KEY = 'smartoneg-demo-config-v1';
const LVL_KEY = 'smartoneg-demo-levels-v1';

const clone = (o) => JSON.parse(JSON.stringify(o));
function deepMerge(base, partial) {
  if (partial === undefined) return base;
  if (partial === null || Array.isArray(partial) || typeof partial !== 'object'
    || base === null || Array.isArray(base) || typeof base !== 'object') return partial;
  const out = { ...base };
  for (const [k, v] of Object.entries(partial)) out[k] = deepMerge(base[k], v);
  return out;
}

let config = (() => { try { return JSON.parse(localStorage.getItem(CFG_KEY)) || clone(DEMO_SEED); } catch { return clone(DEMO_SEED); } })();
const saveConfig = () => localStorage.setItem(CFG_KEY, JSON.stringify(config));

// device runtime levels (persisted). Seed a lively-looking weekday state.
const DEFAULT_LEVELS = {
  // core lights — a lively-looking weekday state
  2: 100, 3: 0, 4: 0, 5: 60, 6: 80, 7: 0, 8: 40, 9: 100, 10: 80, 12: 0,
  // multi-source extras: fridge/urn/vacuum/shades/alarm/bypass rest off/docked,
  // the thermostat holds a comfortable temperature, sconces on low
  20: 0, 21: 0, 22: 0, 23: 60, 24: 0, 25: 0, 26: 0, 27: 71, 28: 0, 29: 0, 30: 0,
};
let levels = (() => { try { return JSON.parse(localStorage.getItem(LVL_KEY)) || { ...DEFAULT_LEVELS }; } catch { return { ...DEFAULT_LEVELS }; } })();
const saveLevels = () => localStorage.setItem(LVL_KEY, JSON.stringify(levels));
let scenePreview = null; // { name, snapshot } while a scene preview is live

// ── live device-stream stub (EventSource) so the Devices page updates instantly ──
const streams = new Set();
const origES = window.EventSource;
window.EventSource = class DemoEventSource extends EventTarget {
  constructor(url) { super(); this.url = url; if (String(url).includes('/api/devices/stream')) streams.add(this); }
  close() { streams.delete(this); }
  set onmessage(fn) { this.addEventListener('message', fn); }
};
function pushLevel(id, level) {
  for (const s of streams) s.dispatchEvent(Object.assign(new Event('message'), { data: JSON.stringify({ id: Number(id), level }) }));
}

// ── engine helpers (same as the server routes) ──
const calendarFor = () => new CalendarService({ location: config.location, times: config.times, locale: config.display?.locale });
function timelineFor(date, forceGuest) {
  const cal = calendarFor();
  const clusters = cal.clusters(date, date);
  const compiler = new TimelineCompiler({
    calendar: cal, sceneRepo: new SceneRepository(config.scenes), schedules: config.schedules,
    guestMode: forceGuest || (config.guestMode?.enabled ?? false),
    guestUntil: forceGuest ? null : (config.guestMode?.until ? new Date(config.guestMode.until).getTime() : null),
    awayMode: config.awayMode?.enabled ? config.awayMode : null,
    zones: config.zones,
  });
  const from = Date.parse(`${date}T00:00:00Z`) - 2 * 86400_000;
  const { allActions, report } = compiler.compile(clusters, from, from + 7 * 86400_000);
  const conflicts = new ConflictDetector({ tzid: config.location.tzid }).detect(allActions, clusters);
  // Whether a guest overlay is possible here — mirrors the real server route so
  // the "show guest overlay" toggle appears only when a day-type has guest rules.
  const guestAvailable = clusters.some((c) => c.days.some((d) => config.schedules?.[d.dayType]?.guest?.rules?.length > 0));
  return { date, clusters, actions: allActions, report, conflicts, guestAvailable };
}
let nextOccCache = null;
function nextOccurrences() {
  if (nextOccCache) return nextOccCache;
  const cal = calendarFor();
  const iso = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: config.location.tzid });
  const want = new Set();
  for (const [dt, vs] of Object.entries(VARIANTS_BY_DAY_TYPE)) for (const v of vs) if (v !== 'guest') want.add(`${dt}|${v}`);
  const data = {}; const start = Date.now();
  outer: for (let y = 0; y < 30; y++) {
    const f = start + y * 365.25 * 86400_000;
    for (const c of cal.clusters(iso(f), iso(f + 366 * 86400_000))) {
      for (const d of c.days) { const k = `${d.dayType}|${d.variant}`; if (want.has(k)) { want.delete(k); data[k] = d.date; } }
      if (!want.size) break outer;
    }
  }
  nextOccCache = data; return data;
}

// in-memory color state for rgb / colorTemp lights (no need to persist for a demo)
const colors = {};
const kelvins = {};
const zonesWithState = () => config.zones.map((z) => ({
  ...z, expectedLevel: levels[z.id] ?? 0, reportedLevel: levels[z.id] ?? 0, latch: null,
  ...(z.rgb ? { reportedRgb: colors[z.id] ?? null } : {}),
  ...(z.colorTemp ? { reportedKelvin: kelvins[z.id] ?? null } : {}),
}));
const demoError = (msg) => ({ __status: 409, error: msg });

// a small slice of the real curated Israeli-city table (Israel mode dropdown)
const IL_CITIES = [
  { name: 'Jerusalem', he: 'ירושלים', lat: 31.76904, lng: 35.21633, elevation: 754 },
  { name: 'Tel Aviv', he: 'תל אביב', lat: 32.08088, lng: 34.78057, elevation: 5 },
  { name: 'Haifa', he: 'חיפה', lat: 32.81841, lng: 34.98850, elevation: 300 },
  { name: 'Bnei Brak', he: 'בני ברק', lat: 32.08074, lng: 34.83380, elevation: 20 },
  { name: 'Beit Shemesh', he: 'בית שמש', lat: 31.74875, lng: 34.98836, elevation: 300 },
  { name: 'Beer Sheva', he: 'באר שבע', lat: 31.25181, lng: 34.79130, elevation: 260 },
  { name: 'Ashdod', he: 'אשדוד', lat: 31.80400, lng: 34.65517, elevation: 15 },
  { name: 'Netanya', he: 'נתניה', lat: 32.32833, lng: 34.85992, elevation: 30 },
  { name: 'Tzfat (Safed)', he: 'צפת', lat: 32.96465, lng: 35.49600, elevation: 850 },
  { name: 'Modiin Illit', he: 'מודיעין עילית', lat: 31.93250, lng: 35.04130, elevation: 300 },
];

// ── the route table ──
const routes = [
  ['GET', /^\/api\/auth\/me$/, () => ({ authed: true, setupComplete: true, authConfigured: true, email: config.auth.email })],
  ['POST', /^\/api\/auth\/login$/, () => ({ ok: true })],
  ['POST', /^\/api\/auth\/logout$/, () => ({ ok: true })],
  ['GET', /^\/api\/health$/, () => ({
    status: 'ok', version: 'demo', role: 'primary', instanceId: 'demo', name: 'Demo',
    setupComplete: true, lutronConnected: true, failoverActive: false,
    failover: { role: 'primary' },
    away: (() => { // same active-vs-scheduled split as the real server
      const am = config.awayMode;
      if (!am?.enabled || !am.from || !am.to) return { active: false, scheduled: false };
      const today = todayISO(); const in7 = plusDaysISO(7); const live = am.to >= today;
      return { active: live && am.from <= in7, scheduled: live && am.from > in7, label: am.label ?? null, from: am.from, to: am.to };
    })(),
    update: { current: 'demo', latest: 'demo', updateAvailable: false, canSelfUpdate: false },
    // per-bridge breakdown from the demo's device sources (all connected here)
    bridges: [...new Set((config.zones || []).map((z) => z.source || 'lutron'))]
      .filter((s) => s !== 'virtual')
      .map((source) => ({ source, connected: true })),
    testMode: { active: false },
    scenePreview: scenePreview ? { active: true, name: scenePreview.name } : { active: false },
    time: new Date().toISOString(), uptimeSec: 0,
  })],
  ['GET', /^\/api\/settings$/, () => config],
  ['PUT', /^\/api\/settings$/, (m, body) => { config = deepMerge(config, strip(body)); saveConfig(); return config; }],

  ['GET', /^\/api\/zones$/, () => zonesWithState()],
  ['PATCH', /^\/api\/zones\/(\d+)$/, (m, body) => {
    const id = Number(m[1]);
    config.zones = config.zones.map((z) => {
      if (z.id !== id) return z;
      const next = { ...z, friendlyName: body.friendlyName ?? z.friendlyName, enforce: body.enforce ?? z.enforce, dimmable: body.dimmable ?? z.dimmable, area: body.area ?? z.area };
      if ('kind' in body) { if (body.kind) next.kind = body.kind; else delete next.kind; }
      if ('displayUnit' in body) { if (body.displayUnit === 'C') next.displayUnit = 'C'; else delete next.displayUnit; }
      return next;
    });
    saveConfig(); return config.zones.find((z) => z.id === id);
  }],
  ['POST', /^\/api\/zones\/(\d+)\/command$/, (m, body) => {
    const id = Number(m[1]); let lvl = Number(body.level);
    const z = config.zones.find((x) => x.id === id);
    if (z && !z.dimmable) lvl = lvl > 0 ? 100 : 0;
    levels[id] = lvl; saveLevels(); pushLevel(id, lvl); return { ok: true };
  }],
  ['POST', /^\/api\/zones\/(\d+)\/color$/, (m, body) => { colors[Number(m[1])] = body.rgb; return { ok: true }; }],
  ['POST', /^\/api\/zones\/(\d+)\/color-temp$/, (m, body) => { kelvins[Number(m[1])] = Number(body.kelvin); return { ok: true }; }],
  ['POST', /^\/api\/zones\/(\d+)\/flash$/, (m) => {
    const id = Number(m[1]); const restore = levels[id] ?? 0; const opp = restore > 0 ? 0 : 100;
    let i = 0; const seq = [opp, restore, opp, restore];
    const tick = () => { if (i < seq.length) { pushLevel(id, seq[i++]); setTimeout(tick, 350); } };
    tick(); return { ok: true };
  }],
  ['POST', /^\/api\/zones\/manual$/, (m, body) => {
    const id = Math.max(99, ...config.zones.map((z) => z.id)) + 1;
    const zone = { id, source: 'virtual', externalId: id, name: body.name, area: body.area || 'Manual', friendlyName: body.name, dimmable: Boolean(body.dimmable), enforce: false };
    config.zones.push(zone); levels[id] = 0; saveConfig(); saveLevels(); return zone;
  }],
  ['DELETE', /^\/api\/zones\/(\d+)$/, (m, body, url) => {
    const id = Number(m[1]);
    if (url.searchParams.get('force') !== 'true') return { __status: 409, error: 'confirmation required', references: findZoneReferences(config, [id]) };
    config.zones = config.zones.filter((z) => z.id !== id); saveConfig();
    return { ok: true, rulesRemoved: 0, rulesUpdated: 0, scenesUpdated: 0 };
  }],
  ['POST', /^\/api\/zones\/import$/, () => demoError('Importing a Lutron report is disabled in the demo.')],
  ['POST', /^\/api\/zones\/lutron\/diff$/, () => demoError('Importing a Lutron report is disabled in the demo.')],
  ['POST', /^\/api\/rooms\/rename$/, (m, body) => { config.zones = config.zones.map((z) => (z.area === body.from ? { ...z, area: body.to.trim() } : z)); saveConfig(); return { ok: true }; }],

  ['GET', /^\/api\/scenes$/, () => config.scenes],
  ['POST', /^\/api\/scenes$/, (m, body) => { const scene = { id: body.id || `s${Date.now()}`, ...body }; config.scenes.push(scene); saveConfig(); return scene; }],
  ['PUT', /^\/api\/scenes\/([^/]+)$/, (m, body) => { config.scenes = config.scenes.map((s) => (s.id === m[1] ? { ...body, id: s.id } : s)); saveConfig(); return config.scenes.find((s) => s.id === m[1]); }],
  ['DELETE', /^\/api\/scenes\/([^/]+)$/, (m) => { config.scenes = config.scenes.filter((s) => s.id !== m[1]); saveConfig(); return { ok: true, deleted: [m[1]], references: [] }; }],
  ['GET', /^\/api\/scenes\/([^/]+)\/resolved$/, (m) => new SceneRepository(config.scenes).resolve(m[1])],
  ['POST', /^\/api\/scenes\/([^/]+)\/preview$/, () =>
    demoError('Scene preview drives real lights, available in the installed app, not the demo.')],
  ['DELETE', /^\/api\/scene-preview$/, () => {
    if (scenePreview) {
      for (const [id, lvl] of Object.entries(scenePreview.snapshot)) { levels[id] = lvl; pushLevel(Number(id), lvl); }
      saveLevels(); scenePreview = null;
    }
    return { ok: true };
  }],

  ['GET', /^\/api\/schedules$/, () => config.schedules],
  ['GET', /^\/api\/schedules\/meta$/, () => ({ dayTypes: DAY_TYPES.filter((dt) => !config.location.il || !CHUL_ONLY_DAY_TYPES.has(dt)), variants: VARIANTS_BY_DAY_TYPE })],
  ['GET', /^\/api\/schedules\/next-occurrences$/, () => nextOccurrences()],
  ['GET', /^\/api\/schedules\/([^/]+)\/([^/]+)$/, (m) => config.schedules[m[1]]?.[m[2]] ?? { rules: [] }],
  ['PUT', /^\/api\/schedules\/([^/]+)\/([^/]+)$/, (m, body) => {
    config.schedules[m[1]] = config.schedules[m[1]] || {};
    config.schedules[m[1]][m[2]] = { rules: (body.rules || []).map((r) => ({ ...r, id: r.id || `r${Math.random().toString(36).slice(2, 8)}` })), inheritsRegular: body.inheritsRegular, removedIds: body.removedIds };
    saveConfig(); return { ok: true };
  }],

  ['GET', /^\/api\/timeline$/, (m, body, url) => timelineFor(url.searchParams.get('date') || todayISO(), url.searchParams.get('guest') === '1')],
  ['GET', /^\/api\/calendar$/, (m, body, url) => {
    const cal = calendarFor();
    return cal.clusters(url.searchParams.get('from') || todayISO(), url.searchParams.get('to') || plusDaysISO(400)).map((c) => ({
      ...c,
      // Match the server exactly: only warn when the day-type HAS a schedule but
      // the specific situation occurring this year is the empty one. A day-type
      // with no schedule at all (falls back to Regular) is intentional, not a gap.
      hasUnconfiguredVariants: c.days.some(
        (d) => d.variant !== 'default' && !config.schedules[d.dayType]?.[d.variant]?.rules?.length
          && Object.values(config.schedules[d.dayType] ?? {}).some((s) => s?.rules?.length),
      ),
    }));
  }],
  ['GET', /^\/api\/zmanim$/, (m, body, url) => calendarFor().zmanim(url.searchParams.get('date') || todayISO())],
  ['GET', /^\/api\/hebrew-dates$/, (m, body, url) => calendarFor().hebrewDates(url.searchParams.get('from') || todayISO(), url.searchParams.get('to') || plusDaysISO(40))],
  ['POST', /^\/api\/compile$/, () => { const tl = timelineFor(todayISO()); return { report: tl.report, conflicts: tl.conflicts }; }],
  ['POST', /^\/api\/guest-mode$/, (m, body) => {
    const enabled = Boolean(body.enabled); let until = null, cluster = null;
    if (enabled) { const c = calendarFor().clusters(todayISO(), plusDaysISO(400)).find((x) => new Date(x.endsAt).getTime() > Date.now()); cluster = c; until = c ? new Date(c.endsAt).toISOString() : null; }
    config.guestMode = { enabled, until };
    if (enabled) config.awayMode = { ...config.awayMode, enabled: false, from: null, to: null, label: null }; // mutually exclusive
    saveConfig();
    return { enabled, until, cluster: cluster ? { label: cluster.label, endsAt: cluster.endsAt } : null };
  }],
  ['GET', /^\/api\/away-presets$/, () => {
    const now = Date.now();
    const clusters = calendarFor().clusters(todayISO(), plusDaysISO(380)).filter((c) => new Date(c.endsAt).getTime() > now);
    const short = (iso) => new Date(`${iso}T12:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const FEST = { 'pesach-1': 'Pesach', 'pesach-2': 'Pesach', 'pesach-7': 'Pesach', 'pesach-8': 'Pesach', 'sukkos-1': 'Sukkos', 'sukkos-2': 'Sukkos', 'shmini-atzeres': 'Sukkos', 'simchas-torah': 'Sukkos', 'shavuos-1': 'Shavuos', 'shavuos-2': 'Shavuos', 'rosh-hashanah-1': 'Rosh Hashanah', 'rosh-hashanah-2': 'Rosh Hashanah' };
    const festOf = (c) => { for (const d of c.days) if (FEST[d.dayType]) return FEST[d.dayType]; return null; };
    const shabbosos = clusters.filter((c) => c.days.every((d) => d.dayType === 'shabbos')).slice(0, 8)
      .map((c) => ({ label: `Shabbos · ${short(c.days[0].date)}`, from: c.days[0].date, to: c.days[c.days.length - 1].date }));
    const festivals = []; const grouped = new Set();
    for (let i = 0; i < clusters.length; i++) {
      const fest = festOf(clusters[i]); if (!fest || grouped.has(clusters[i])) continue;
      const group = [clusters[i]];
      for (let j = i + 1; j < clusters.length; j++) { const gap = (new Date(clusters[j].startsAt).getTime() - new Date(group[group.length - 1].endsAt).getTime()) / 86400000; if (gap >= 0 && gap < 20 && festOf(clusters[j]) === fest) group.push(clusters[j]); }
      group.forEach((g) => grouped.add(g));
      const from = group[0].days[0].date; const to = group[group.length - 1].days.at(-1).date;
      const range = (f, t) => `${short(f)}${t !== f ? `–${short(t)}` : ''}`;
      if (group.length > 1) {
        const first = group[0]; const last = group[group.length - 1];
        festivals.push({ label: `${fest}: entire · ${range(from, to)}`, from, to });
        festivals.push({ label: `${fest}: first days · ${range(first.days[0].date, first.days.at(-1).date)}`, from: first.days[0].date, to: first.days.at(-1).date });
        festivals.push({ label: `${fest}: last days · ${range(last.days[0].date, last.days.at(-1).date)}`, from: last.days[0].date, to: last.days.at(-1).date });
      } else {
        festivals.push({ label: `${fest} · ${range(from, to)}`, from, to });
      }
    }
    return { shabbosos, festivals };
  }],
  ['POST', /^\/api\/away-mode$/, (m, body) => {
    const enabled = Boolean(body.enabled);
    if (!enabled) { config.awayMode = { ...config.awayMode, enabled: false, from: null, to: null, label: null }; saveConfig(); return { enabled: false }; }
    const { from, to, label } = body;
    if (!from || !to || from > to) return demoError('A valid from/to date range is required');
    config.awayMode = { ...config.awayMode, enabled: true, from, to, label: label ?? null };
    config.guestMode = { enabled: false, until: null }; // mutually exclusive
    saveConfig();
    return { enabled: true, from, to, label: label ?? null };
  }],

  ['GET', /^\/api\/latches$/, () => []],
  ['DELETE', /^\/api\/latches\/(\d+)$/, () => ({ ok: true })],
  ['POST', /^\/api\/notify\/test$/, () => ({ ok: true, message: { channels: { email: 'off', ntfy: 'off', push: 'off' } } })],
  ['GET', /^\/api\/logs$/, () => demoLogs()],
  ['GET', /^\/api\/backups$/, () => []],
  ['GET', /^\/api\/push\/vapid-public-key$/, () => ({ key: 'demo' })],
  ['POST', /^\/api\/push\/subscribe$/, () => ({ ok: true })],
  ['GET', /^\/api\/zip\/(\d+)$/, () => ({ city: config.location.city, state: config.location.state, lat: config.location.lat, lng: config.location.lng, tzid: config.location.tzid })],
  // Israel-mode city list (a subset of the real curated table is plenty for the demo)
  ['GET', /^\/api\/il-cities$/, () => IL_CITIES.map(({ name, he }) => ({ name, he }))],
  ['GET', /^\/api\/il-city\/(.+)$/, (m) => {
    const c = IL_CITIES.find((x) => x.name === decodeURIComponent(m[1]));
    return c ? { zip: '', city: c.name, state: 'Israel', lat: c.lat, lng: c.lng, elevation: c.elevation ?? 0, tzid: 'Asia/Jerusalem', il: true } : demoError('city not found');
  }],
  // software updates: the demo is always "up to date" and can't self-update
  ['GET', /^\/api\/version$/, () => ({ current: 'demo', latest: 'demo', updateAvailable: false, url: null, notes: null, checkedAt: new Date().toISOString(), canSelfUpdate: false })],
  ['POST', /^\/api\/version\/check$/, () => ({ current: 'demo', latest: 'demo', updateAvailable: false, checkedAt: new Date().toISOString(), canSelfUpdate: false })],
  ['POST', /^\/api\/system\/update$/, () => demoError('Updating is available in the installed app, not the demo.')],

  // backend-only actions are visibly present but explained as demo-disabled
  ['POST', /^\/api\/test-mode$/, () => demoError('Test mode drives real lights, available in the installed app, not the demo.')],
  ['DELETE', /^\/api\/test-mode$/, () => ({ ok: true })],
  ['POST', /^\/api\/config\/import$/, () => demoError('Import is disabled in the demo.')],
  ['POST', /^\/api\/config\/reset$/, () => demoError('Reset is disabled in the demo.')],
  ['POST', /^\/api\/system\/restart$/, () => demoError('Restart is disabled in the demo.')],
  ['POST', /^\/api\/settings\/lutron\/test$/, () => demoError('No bridge in the demo.')],
  ['POST', /^\/api\/(hubitat|homeassistant|homebridge|matter|ecobee)\/(discover|commission|authorize|token)$/, () => demoError('Device discovery needs the real bridge, try it in the installed app.')],
];

function strip(o) { // drop __SET__ placeholders so secrets aren't overwritten
  if (o === null || typeof o !== 'object') return o;
  if (Array.isArray(o)) return o.map(strip);
  const out = {}; for (const [k, v] of Object.entries(o)) if (v !== '__SET__') out[k] = strip(v); return out;
}
const todayISO = () => new Date().toLocaleDateString('en-CA', { timeZone: config.location.tzid });
const plusDaysISO = (n) => new Date(Date.now() + n * 86400_000).toLocaleDateString('en-CA', { timeZone: config.location.tzid });
function demoLogs() {
  const now = Date.now();
  return [
    { level: 30, time: now - 5000, msg: 'demo mode, running entirely in your browser, no server' },
    { level: 30, time: now - 4000, mod: 'scheduler', msg: 'timeline compiled', actions: 7, clusters: 1 },
    { level: 30, time: now - 3000, mod: 'devices', msg: 'zmanim computed locally (no internet needed)' },
  ];
}

// ── install the fetch interceptor ──
const realFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input.url, location.href);
  if (!url.pathname.startsWith('/api/')) return realFetch(input, init);
  const method = (init?.method || (typeof input !== 'string' && input.method) || 'GET').toUpperCase();
  let body = {};
  try { const raw = init?.body ?? (typeof input !== 'string' ? undefined : undefined); if (raw) body = JSON.parse(raw); } catch { /* non-json */ }
  for (const [mth, re, fn] of routes) {
    if (mth !== method) continue;
    const match = re.exec(url.pathname);
    if (!match) continue;
    try {
      const out = fn(match, body, url);
      const status = out && out.__status ? out.__status : 200;
      if (out && out.__status) delete out.__status;
      return new Response(JSON.stringify(out ?? { ok: true }), { status, headers: { 'content-type': 'application/json' } });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { 'content-type': 'application/json' } });
    }
  }
  // unknown /api route: PDFs and streams land here, return a friendly stub
  if (url.pathname.startsWith('/api/pdf/')) return new Response(JSON.stringify({ error: 'PDF export runs on the server, available in the installed app.' }), { status: 501, headers: { 'content-type': 'application/json' } });
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
};

// flag read by the frontend (e.g. pdf-buttons.js disables server-rendered PDFs)
window.__SMARTONEG_DEMO__ = true;
// mark ready so index.html can boot the app after the shim is installed
window.__DEMO_READY__ = true;
window.dispatchEvent(new Event('demo-ready'));
