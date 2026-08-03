// Seed config for the static demo. The scenes + schedules are the author's REAL
// Shabbos / Yom Tov configuration (imported from demo-schedule.js) — a far more
// realistic timeline than a hand-written factory. This file layers on top of it:
//   • a device roster spanning FIVE bridges (Lutron, Hubitat, Home Assistant,
//     ecobee, Envisalink) so the demo shows what real devices from multiple
//     sources look like, and
//   • demo-only rules + scene colours that drive the multi-source devices the
//     real (Lutron-only) config doesn't — a Home Assistant fridge Sabbath switch,
//     RGB accent lighting, warm↔cool colour-temperature sconces, a robot vacuum,
//     shades, an urn, a thermostat hold, and a motion-sensor bypass.
// Location is the project's demo point (ZIP 21209). Nothing here is secret — the
// real instance's location, email, ntfy, and integration credentials are NOT
// copied; only the scenes and schedules are.

import { SCENES as REAL_SCENES, SCHEDULES as REAL_SCHEDULES } from './demo-schedule.js';

const clone = (o) => JSON.parse(JSON.stringify(o));

// ── device roster ───────────────────────────────────────────────────────────
// The real config's ten lights (ids 2–12), spread across Lutron / Hubitat /
// Home Assistant so the Devices page and timeline show source variety, plus the
// extra multi-source devices (ids 20+) the demo rules below drive.
const ZONES = [
  // core lights (referenced by the real scenes + schedules) ──────────────────
  { id: 2, source: 'lutron', externalId: 2, name: 'Main', area: 'Living Room', friendlyName: 'Living Room Main Lights', dimmable: true, enforce: true },
  { id: 3, source: 'lutron', externalId: 3, name: 'Main', area: 'Dining Room', friendlyName: 'Dining Room Main Lights', dimmable: true, enforce: true },
  { id: 7, source: 'lutron', externalId: 7, name: 'Chandelier', area: 'Dining Room', friendlyName: 'Dining Room Chandelier', dimmable: true, enforce: false },
  { id: 8, source: 'lutron', externalId: 8, name: 'Main', area: 'Basement Sitting Area', friendlyName: 'Basement Sitting Area Main Lights', dimmable: true, enforce: false },
  { id: 6, source: 'lutron', externalId: 6, name: 'Main', area: 'Front Foyer', friendlyName: 'Front Foyer Main Lights', dimmable: true, enforce: false },
  { id: 9, source: 'hubitat', externalId: '31', name: 'Main', area: 'Kitchen', friendlyName: 'Kitchen Main Lights', dimmable: true, enforce: true },
  { id: 10, source: 'hubitat', externalId: '32', name: 'Secondary', area: 'Kitchen', friendlyName: 'Kitchen Secondary Lights', dimmable: true, enforce: false, colorTemp: true, minKelvin: 2200, maxKelvin: 6500 },
  { id: 4, source: 'hubitat', externalId: '33', name: 'Table', area: 'Kitchen', friendlyName: 'Kitchen Table Lights', dimmable: true, enforce: false },
  { id: 5, source: 'homeassistant', externalId: 'light.den_main', name: 'Main', area: 'Den', friendlyName: 'Den Main Lights', dimmable: true, enforce: false },
  { id: 12, source: 'homeassistant', externalId: 'light.den_bathroom', name: 'Main', area: 'Den', friendlyName: 'Den Bathroom Main Lights', dimmable: true, enforce: false },
  // multi-source extras (driven by the demo rules + scene colours below) ──────
  { id: 20, source: 'homeassistant', externalId: 'switch.fridge_sabbath', name: 'Fridge', area: 'Kitchen', friendlyName: 'Refrigerator Sabbath Mode', dimmable: false, enforce: true, kind: 'fridge' },
  { id: 21, source: 'hubitat', externalId: '41', name: 'Lamp', area: 'Master Bedroom', friendlyName: 'Master Bedroom Lamp', dimmable: true, enforce: false, rgb: true },
  { id: 22, source: 'homeassistant', externalId: 'light.lr_accent', name: 'Accent', area: 'Living Room', friendlyName: 'Living Room Accent Strip', dimmable: true, enforce: false, rgb: true },
  { id: 23, source: 'hubitat', externalId: '42', name: 'Sconces', area: 'Front Foyer', friendlyName: 'Foyer Sconces', dimmable: true, enforce: false, colorTemp: true, minKelvin: 2200, maxKelvin: 6500 },
  { id: 24, source: 'homeassistant', externalId: 'switch.urn', name: 'Hot Water Urn', area: 'Kitchen', friendlyName: 'Hot Water Urn', dimmable: false, enforce: true, kind: 'outlet' },
  { id: 25, source: 'homeassistant', externalId: 'cover.living_room_shades', name: 'Shades', area: 'Living Room', friendlyName: 'Living Room Shades', dimmable: true, enforce: false, kind: 'shade' },
  { id: 26, source: 'homeassistant', externalId: 'vacuum.roborock', name: 'Vacuum', area: 'Living Room', friendlyName: 'Robot Vacuum', dimmable: false, enforce: false, kind: 'vacuum' },
  { id: 27, source: 'ecobee', externalId: 'demo-thermostat', name: 'Thermostat', area: 'Hallway', friendlyName: 'Hallway Thermostat', dimmable: true, enforce: false, kind: 'thermostat' },
  { id: 28, source: 'hubitat', externalId: '43', name: 'Porch', area: 'Front Foyer', friendlyName: 'Front Porch Light', dimmable: false, enforce: false },
  { id: 29, source: 'envisalink', externalId: 'partition:1', name: 'Alarm', area: 'Security', friendlyName: 'House Alarm', dimmable: false, enforce: false, kind: 'alarm' },
  { id: 30, source: 'envisalink', externalId: 'bypass:3', name: 'Motion', area: 'Security', friendlyName: 'Downstairs Motion (bypass)', dimmable: false, enforce: false, kind: 'bypass' },
];

// ── demo rule helpers (same rule/trigger shape as the real config) ───────────
const zt = (zman, offsetMin, day) => ({ kind: 'zman', zman, offsetMin, day, clamp: {}, conditions: [] });
let __rid = 0;
const rule = (label, action, trigger) => ({ id: `demo-${++__rid}`, label, enabled: true, action, trigger });
const setLevel = (zone, level, extra = {}) => ({ type: 'setLevel', zone, level, fadeSec: 0, ...extra });

// Rules that fire the night a day begins (needs that day's own candle lighting):
// prep the house for Shabbos / Yom Tov. `fast` drops the urn (no meals on a fast).
const erevPrep = ({ fast = false } = {}) => [
  rule('Fridge Sabbath mode on', setLevel(20, 100), zt('candleLighting', -90, 'erev')),
  ...(!fast ? [rule('Hot water urn on', setLevel(24, 100), zt('candleLighting', -75, 'erev'))] : []),
  rule('Robot vacuum finishes and docks before Shabbos', setLevel(26, 0), zt('candleLighting', -60, 'erev')),
  rule('Hold the thermostat for Yom Tov', setLevel(27, 70), zt('candleLighting', -120, 'erev')),
  rule('Bypass downstairs motion sensor', setLevel(30, 100), zt('candleLighting', -5, 'erev')),
];

// Rules gated on havdalah — the zman only resolves on a cluster's LAST day, so
// these fire once, at the end, and undo the prep above.
const havdalahOff = () => [
  rule('Fridge Sabbath mode off', setLevel(20, 0), zt('havdalah', 80, 'day')),
  rule('Hot water urn off', setLevel(24, 0), zt('havdalah', 75, 'day')),
  rule('Resume the thermostat’s own program', setLevel(27, 0), zt('havdalah', 85, 'day')),
  rule('Restore downstairs motion sensor', setLevel(30, 0), zt('havdalah', 78, 'day')),
  // the night devices that would otherwise linger past havdalah
  rule('Master bedroom lamp off', setLevel(21, 0), zt('havdalah', 76, 'day')),
  rule('Front porch light off', setLevel(28, 0), zt('havdalah', 77, 'day')),
];

// Rules that recur every assur day (sunrise / sunset), so a multi-day Yom Tov
// stays lively day after day. Warm colour temperature by night, cool by day;
// shades and the porch light on their own arc; a soft RGB glow on the bedroom
// lamp at night. (The RGB accent strip is owned by the evening scene above.)
const dailyColour = () => [
  rule('Shades up for the day', setLevel(25, 100), zt('sunrise', 30, 'day')),
  rule('Foyer sconces cool + bright for the day', setLevel(23, 100, { kelvin: 5000 }), zt('sunrise', 45, 'day')),
  rule('Foyer sconces warm for the evening', setLevel(23, 70, { kelvin: 2700 }), zt('sunset', -60, 'day')),
  rule('Front porch light on at dark', setLevel(28, 100), zt('sunset', -10, 'day')),
  rule('Shades down for the night', setLevel(25, 0), zt('sunset', 60, 'day')),
  rule('Master bedroom lamp, soft night colour', setLevel(21, 50, { rgb: [255, 120, 40] }), zt('sunset', 60, 'day')),
];

// Day-types that begin with their OWN arrival candle lighting (get erevPrep),
// and those that end a cluster with havdalah (get havdalahOff). Mirrors which
// day-types carry a full "first day" vs "last day" rule set in the real config.
const EREV_DAYTYPES = { shabbos: {}, 'yom-kippur': { fast: true }, 'rosh-hashanah-1': {}, 'sukkos-1': {}, 'shmini-atzeres': {}, 'pesach-1': {}, 'pesach-7': {}, 'shavuos-1': {} };
const LAST_DAYTYPES = ['shabbos', 'yom-kippur', 'rosh-hashanah-2', 'sukkos-2', 'simchas-torah', 'pesach-2', 'pesach-8', 'shavuos-2'];

// ── build the augmented scenes + schedules ───────────────────────────────────
const scenes = clone(REAL_SCENES);
// The flagship "Erev Shabbos (Friday night)" scene also lights the RGB accent
// strip (warm) — so scene blocks in the timeline show a colour chip. Its child
// "Erev Yom Tov" scene inherits it. (The colour-temp sconces are driven by the
// standalone warm-evening / cool-morning rules below, not the scene, so the two
// never fight over the same device.)
const evening = scenes.find((s) => s.id === '6o-F8q8q');
if (evening) {
  evening.actions.push({ zone: 22, level: 70, rgb: [255, 150, 60] });
  (evening.endActions ||= []).push({ zone: 22, level: 0 });
}

const schedules = clone(REAL_SCHEDULES);
const injectInto = (dayType, rules) => {
  const situation = (schedules[dayType] ||= {});
  const def = (situation.default ||= { rules: [] });
  def.rules = [...(def.rules ?? []), ...rules];
};
for (const dt of Object.keys(schedules)) injectInto(dt, dailyColour());
for (const [dt, opts] of Object.entries(EREV_DAYTYPES)) injectInto(dt, erevPrep(opts));
for (const dt of LAST_DAYTYPES) injectInto(dt, havdalahOff());

export const DEMO_SEED = {
  schemaVersion: 1,
  configVersion: 1,
  instance: { id: 'demo', role: 'primary', name: 'Demo' },
  location: {
    zip: '21209', lat: 39.38172440803908, lng: -76.69650757889433,
    city: 'Pikesville', state: 'MD', tzid: 'America/New_York', il: false, elevation: 0,
  },
  times: { candleLightingMins: 18, havdalahMins: 45, tzeitAngle: 8.5 },
  display: { locale: 'ashkenazi' },
  auth: { email: 'demo@smartoneg.com', passwordHash: '__SET__', sessionSecret: '__SET__' },
  lutron: { enabled: true, host: '192.168.1.50', port: 23, username: 'lutron', password: '__SET__', mock: true },
  hubitat: { enabled: true, host: '192.168.1.52', appId: '27', accessToken: '__SET__', pollSeconds: 30 },
  homeassistant: { enabled: true, host: 'http://192.168.1.10:8123', token: '__SET__', pollSeconds: 60 },
  homebridge: { enabled: false, host: '', username: '', password: '', pollSeconds: 5 },
  matter: { enabled: false },
  ecobee: { enabled: true, apiKey: '__SET__', pendingCode: '', accessToken: '__SET__', refreshToken: '__SET__', tokenExpiresAt: 0, pollSeconds: 120 },
  envisalink: { enabled: true, host: '192.168.1.40', port: 4025, password: '__SET__', code: '__SET__', partition: 1, armMode: 'stay', mock: true },
  zones: ZONES,
  roomOrder: ['Kitchen', 'Dining Room', 'Living Room', 'Den', 'Basement Sitting Area', 'Front Foyer', 'Master Bedroom', 'Hallway', 'Security'],
  scenes,
  schedules,
  enforcement: { enabled: true, graceSeconds: 20, overridePresses: 4, overrideWindowSeconds: 300, begins: null },
  guestMode: { enabled: false, until: null },
  awayMode: { enabled: false, from: null, to: null, label: null, jitterMin: 15, shortenPct: 25, quietFrom: '23:00', quietTo: '06:00', varyPct: 18, seed: 'demo-away' },
  failover: { primaryUrl: '', syncToken: 'demo', pollSeconds: 10, failThreshold: 3, recoverThreshold: 6 },
  notifications: {
    email: { enabled: false, host: 'smtp.gmail.com', port: 465, user: '', appPassword: '', to: '' },
    ntfy: { enabled: false, server: 'https://ntfy.sh', topic: '' },
    push: { vapidPublicKey: '', vapidPrivateKey: '', subscriptions: [] },
    preYomTovSummaryDays: 7,
    categories: {
      bridge: { email: true, ntfy: true, push: true }, failover: { email: true, ntfy: true, push: true },
      childlock: { email: true, ntfy: true, push: true }, summary: { email: true, ntfy: true, push: true },
      modes: { email: true, ntfy: true, push: true },
    },
  },
  setupComplete: true,
};

// day-types the demo advertises (mirrors server dayTypes.js / the real schedules)
export const DAY_TYPES = [
  'shabbos', 'rosh-hashanah-1', 'rosh-hashanah-2', 'yom-kippur', 'sukkos-1', 'sukkos-2',
  'shmini-atzeres', 'simchas-torah', 'pesach-1', 'pesach-2', 'pesach-7', 'pesach-8', 'shavuos-1', 'shavuos-2',
];
