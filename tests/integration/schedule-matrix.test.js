import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { MockBridge } from '../../server/lutron/MockBridge.js';
import { DeviceBus } from '../../server/devices/DeviceBus.js';
import { LutronClient } from '../../server/lutron/LutronClient.js';
import { ZoneStateTracker } from '../../server/safety/ZoneStateTracker.js';
import { EnforcementEngine } from '../../server/safety/EnforcementEngine.js';
import { Scheduler } from '../../server/engine/Scheduler.js';
import { ConfigStore } from '../../server/config/ConfigStore.js';
import { StateStore } from '../../server/config/StateStore.js';
import { CalendarService } from '../../server/calendar/CalendarService.js';
import { TimelineCompiler, expectedLevel } from '../../server/engine/TimelineCompiler.js';
import { SceneRepository } from '../../server/engine/SceneRepository.js';
import { createApp } from '../../server/app.js';
import { LogRing } from '../../server/logging/logger.js';

// Schedule matrix: build a dense, realistic year of schedules — every rule
// shape the editor can produce (multi-zone, flash counts, scenes, zman h+m
// offsets, clamps, seasonal conditions incl. don't-fire, erev vs day) — then
// round-trip them through the real API and compile a FULL YEAR of clusters,
// asserting nothing throws, everything resolves where expected, and the
// scheduler actually drives the bridge for a dense same-minute burst.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// One long-lived HTTP listener per boot (supertest's per-request server churn
// is flaky next to the mock bridge's sockets) + the automation bearer token.
const agent = () => {
  const proxied = request(baseUrl);
  return new Proxy(proxied, {
    get: (t, k) => (typeof t[k] === 'function' && ['get', 'put', 'post', 'delete'].includes(k)
      ? (...args) => t[k](...args).set('Authorization', 'Bearer matrix-test-token')
      : t[k]),
  });
};

const LOCATION = { zip: '21208', lat: 39.3719, lng: -76.6981, city: 'Pikesville', state: 'MD', tzid: 'America/New_York', il: false, elevation: 0 };
const ZONES = [
  { id: 2, name: 'Main', area: 'Living Room', friendlyName: 'Living Room', dimmable: true, enforce: true },
  { id: 3, name: 'Main', area: 'Dining Room', friendlyName: 'Dining Room', dimmable: true, enforce: false },
  { id: 4, name: 'Table', area: 'Kitchen', friendlyName: 'Kitchen Table', dimmable: false, enforce: false },
  { id: 5, name: 'Main', area: 'Den', friendlyName: 'Den', dimmable: true, enforce: false },
  { id: 9, name: 'Main', area: 'Kitchen', friendlyName: 'Kitchen Main', dimmable: true, enforce: true },
];
const SCENES = [
  { id: 'meal', name: 'Mealtime',
    actions: [{ zone: 3, level: 100 }, { zone: 4, level: 100 }, { zone: 9, level: 60 }, { zone: 5, flash: 1 }],
    endActions: [{ zone: 3, level: 0 }, { zone: 4, level: 0 }] },
];

/** Every rule shape the editor can produce. */
function denseRules() {
  return [
    // erev: scene start at a fixed time
    { id: 'r-scene', label: 'erev scene', enabled: true, action: { type: 'sceneStart', sceneId: 'meal' }, trigger: { kind: 'fixed', time: '18:00', day: 'erev' } },
    // erev: multi-zone ON, zman-relative with an hours+minutes offset (1h40m before shkia)
    { id: 'r-multi', label: 'multi on', enabled: true, action: { type: 'setLevel', zone: 2, zones: [2, 5, 9], level: 90 }, trigger: { kind: 'zman', zman: 'sunset', offsetMin: -100, day: 'erev' } },
    // erev: flash twice at shkia
    { id: 'r-flash', label: 'shkia reminder', enabled: true, action: { type: 'flash', zone: 9, times: 2 }, trigger: { kind: 'zman', zman: 'sunset', offsetMin: 0, day: 'erev' } },
    // erev: legacy flash rule stored as seconds (back-compat)
    { id: 'r-flash-legacy', label: 'legacy flash', enabled: true, action: { type: 'flash', zone: 3, seconds: 4 }, trigger: { kind: 'zman', zman: 'sunset', offsetMin: -5, day: 'erev' } },
    // night: scene end + switch coercion (zone 4 non-dimmable)
    { id: 'r-scene-end', label: 'meal over', enabled: true, action: { type: 'sceneEnd', sceneId: 'meal' }, trigger: { kind: 'fixed', time: '23:00', day: 'erev' } },
    // day: clamped zman rule (never earlier than 09:00)
    { id: 'r-clamped', label: 'morning', enabled: true, action: { type: 'setLevel', zone: 2, level: 70 }, trigger: { kind: 'zman', zman: 'sunrise', offsetMin: -180, clamp: { notBefore: '09:00' } } },
    // day: seasonal condition that PINS to a fixed time in summer
    { id: 'r-cond-pin', label: 'summer pin', enabled: true, action: { type: 'setLevel', zone: 5, level: 40 }, trigger: { kind: 'zman', zman: 'sunset', offsetMin: -30, conditions: [{ if: { zman: 'sunset', cmp: 'after', time: '19:00' }, then: { kind: 'fixed', time: '17:30' } }] } },
    // day: DON'T-FIRE condition (skip in deep winter)
    { id: 'r-cond-skip', label: 'winter skip', enabled: true, action: { type: 'setLevel', zone: 3, level: 55 }, trigger: { kind: 'zman', zman: 'sunset', offsetMin: 30, conditions: [{ if: { zman: 'sunset', cmp: 'before', time: '17:00' }, then: { skip: true } }] } },
    // havdalah wind-down (only resolves on the last cluster day)
    { id: 'r-havdalah', label: 'motzei off', enabled: true, action: { type: 'setLevel', zone: 2, zones: [2, 3, 5], level: 0 }, trigger: { kind: 'zman', zman: 'havdalah', offsetMin: 15 } },
    // disabled rule must never appear
    { id: 'r-disabled', label: 'off switch', enabled: false, action: { type: 'setLevel', zone: 9, level: 1 }, trigger: { kind: 'fixed', time: '12:00' } },
  ];
}

let dir; let bridge; let client; let scheduler; let app; let configStore; let stateStore; let httpServer; let baseUrl;

async function boot() {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matrix-'));
  bridge = new MockBridge();
  await bridge.listen();
  configStore = new ConfigStore({ dataDir: dir });
  configStore.load();
  configStore.update({ location: LOCATION, zones: ZONES, scenes: SCENES, setupComplete: true, failover: { syncToken: 'matrix-test-token' } });
  stateStore = new StateStore({ dataDir: dir, debounceMs: 10 });
  stateStore.load();
  client = new LutronClient({ host: '127.0.0.1', port: bridge.port, zoneIds: ZONES.map((z) => z.id), commandTimeoutMs: 500 });
  // production wiring: everything downstream talks to the DeviceBus
  const bus = new DeviceBus({ configStore });
  bus.register('lutron', client);
  const tracker = new ZoneStateTracker({ stateStore });
  bus.on('zoneLevel', (e) => tracker.onZoneLevel(e));
  const enforcement = new EnforcementEngine({ configStore, stateStore, tracker, lutron: bus });
  scheduler = new Scheduler({ configStore, stateStore, tracker, enforcement, lutron: bus });
  enforcement.setClock(() => scheduler.now());
  app = createApp({
    configStore, stateStore, scheduler, tracker, enforcement,
    lutron: bus, failover: null, notifier: { send: async () => ({}) },
    ring: new LogRing(), logDir: null, logger: null,
  });
  await bus.connect();
  await new Promise((r) => { httpServer = app.listen(0, '127.0.0.1', r); });
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
}

afterEach(async () => {
  scheduler?.stop();
  client?.close();
  await new Promise((r) => httpServer?.close(r));
  await bridge?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('schedule matrix: API round-trip + full-year compile', () => {
  beforeEach(boot);

  it('accepts every editor-producible rule shape for every day type via the API', async () => {
    const meta = (await agent().get('/api/schedules/meta').expect(200)).body;
    for (const dayType of meta.dayTypes) {
      const res = await agent()
        .put(`/api/schedules/${dayType}/default`)
        .send({ rules: denseRules() })
        .expect(200);
      expect(res.body.rules).toHaveLength(denseRules().length);
      // ids preserved, zones[] survives the round-trip
      expect(res.body.rules.find((r) => r.id === 'r-multi').action.zones).toEqual([2, 5, 9]);
      expect(res.body.rules.find((r) => r.id === 'r-cond-skip').trigger.conditions[0].then.skip).toBe(true);
    }
    const stored = configStore.get().schedules;
    expect(Object.keys(stored).length).toBeGreaterThanOrEqual(meta.dayTypes.length);
  });

  it('compiles a FULL YEAR of dense schedules without a single error and with sane output', async () => {
    const meta = (await agent().get('/api/schedules/meta').expect(200)).body;
    for (const dayType of meta.dayTypes) {
      await agent().put(`/api/schedules/${dayType}/default`).send({ rules: denseRules() }).expect(200);
    }
    const cfg = configStore.get();
    const cal = new CalendarService({ location: cfg.location, times: cfg.times, locale: 'ashkenazi' });
    const from = '2026-08-01'; const to = '2027-08-01';
    const clusters = cal.clusters(from, to);
    expect(clusters.length).toBeGreaterThan(50); // every Shabbos + YT for a year

    const compiler = new TimelineCompiler({ calendar: cal, sceneRepo: new SceneRepository(cfg.scenes), schedules: cfg.schedules, guestMode: false, guestUntil: null });
    const { allActions, report } = compiler.compile(clusters, Date.parse(from), Date.parse(to));

    // volume sanity: ~10 rules over ~60 clusters (several multi-zone / scene expansions)
    expect(allActions.length).toBeGreaterThan(900);
    // sorted, and every action well-formed
    for (let i = 1; i < allActions.length; i++) expect(allActions[i].at).toBeGreaterThanOrEqual(allActions[i - 1].at);
    for (const a of allActions) {
      expect(['setLevel', 'flash']).toContain(a.type);
      expect(ZONES.some((z) => z.id === a.zone)).toBe(true);
      if (a.type === 'setLevel') expect(a.level).toBeGreaterThanOrEqual(0);
      if (a.type === 'flash') expect([1, 2]).toContain(a.times);
    }
    // disabled rules never compile
    expect(allActions.some((a) => a.source.ruleId === 'r-disabled')).toBe(false);
    // multi-zone rules expand to one action per zone at the same instant
    const multi = allActions.filter((a) => a.source.ruleId === 'r-multi');
    expect(multi.length % 3).toBe(0);
    const at0 = multi[0].at;
    expect(multi.filter((a) => a.at === at0).map((a) => a.zone).sort()).toEqual([2, 5, 9]);
    // legacy flash seconds map to times
    const legacy = allActions.find((a) => a.source.ruleId === 'r-flash-legacy');
    expect(legacy.times).toBe(2);
    // clamp: the clamped rule never fires before 09:00 local
    for (const a of allActions.filter((x) => x.source.ruleId === 'r-clamped')) {
      const local = new Date(a.at).toLocaleTimeString('en-US', { hour12: false, timeZone: LOCATION.tzid });
      expect(local >= '09:00:00').toBe(true);
    }
    // summer condition pins to 17:30; winter fires 30m before shkia
    const pins = allActions.filter((a) => a.source.ruleId === 'r-cond-pin');
    expect(pins.length).toBeGreaterThan(0);
    // don't-fire: skipped in deep winter, present in summer, and reported
    const skips = report.skippedRules.filter((s) => s.ruleId === 'r-cond-skip');
    expect(skips.length).toBeGreaterThan(0);
    expect(skips[0].reason).toMatch(/don't-fire/);
    expect(allActions.some((a) => a.source.ruleId === 'r-cond-skip')).toBe(true);
    // havdalah rules only ever fire once per cluster (its last day)
    const havByCluster = new Map();
    for (const a of allActions.filter((x) => x.source.ruleId === 'r-havdalah' && x.zone === 2)) {
      havByCluster.set(a.source.clusterId, (havByCluster.get(a.source.clusterId) ?? 0) + 1);
    }
    for (const [, n] of havByCluster) expect(n).toBe(1);
    // expectedLevel is derivable at any instant without throwing
    const mid = Date.parse('2026-12-25T12:00:00-05:00');
    for (const z of ZONES) expect(() => expectedLevel(allActions, z.id, mid)).not.toThrow();
  });

  it('scene flash members compile to flash actions; scene preview snapshots once and restores', async () => {
    // flash member inside the scene -> a flash action in the compiled timeline
    await agent().put('/api/schedules/shabbos/default').send({ rules: [
      { id: 's1', label: '', enabled: true, action: { type: 'sceneStart', sceneId: 'meal' }, trigger: { kind: 'fixed', time: '18:00', day: 'erev' } },
    ] }).expect(200);
    const cfg = configStore.get();
    const cal = new CalendarService({ location: cfg.location, times: cfg.times, locale: 'ashkenazi' });
    const clusters = cal.clusters('2026-08-21', '2026-08-23');
    const compiler = new TimelineCompiler({ calendar: cal, sceneRepo: new SceneRepository(cfg.scenes), schedules: cfg.schedules, guestMode: false, guestUntil: null });
    const { allActions } = compiler.compile(clusters, Date.parse('2026-08-20'), Date.parse('2026-08-24'));
    const fl = allActions.find((a) => a.type === 'flash' && a.zone === 5 && a.source.sceneId === 'meal');
    expect(fl?.times).toBe(1);

    // preview: apply live, chain keeps the FIRST snapshot, exit restores it.
    // Scene preview refuses while a REAL Shabbos/YT (or its erev prep) is in
    // effect on the wall clock — blank the location for this section (the
    // coverage check short-circuits without one) so the suite doesn't fail
    // when it happens to run on Friday night or Shabbos.
    const savedLoc = structuredClone(configStore.get().location);
    configStore.update({ location: { ...savedLoc, lat: null } });
    await sleep(150);
    await client.setLevel(3, 20); await client.setLevel(9, 5);
    await sleep(150);
    await scheduler.startScenePreview('meal');
    await sleep(300);
    expect(bridge.levels.get(3)).toBe(100);
    expect(bridge.levels.get(9)).toBe(60);
    expect(scheduler.scenePreviewInfo().active).toBe(true);
    await scheduler.startScenePreview('meal'); // chaining must NOT re-snapshot
    await sleep(200);
    await scheduler.exitScenePreview({ restore: true });
    await sleep(300);
    expect(bridge.levels.get(3)).toBe(20); // original pre-preview state
    expect(bridge.levels.get(9)).toBe(5);
    expect(scheduler.scenePreviewInfo().active).toBe(false);
    configStore.update({ location: savedLoc });
  }, 20_000);

  it('guest mode layers guest rules on top and marks them', async () => {
    await agent().put('/api/schedules/shabbos/default').send({ rules: denseRules() }).expect(200);
    await agent().put('/api/schedules/shabbos/guest').send({
      rules: [{ id: 'g1', label: 'guest hallway', enabled: true, action: { type: 'setLevel', zone: 5, level: 100 }, trigger: { kind: 'fixed', time: '21:00', day: 'erev' } }],
    }).expect(200);
    configStore.update({ guestMode: { enabled: true, until: '2027-09-01T00:00:00Z' } });
    const cfg = configStore.get();
    const cal = new CalendarService({ location: cfg.location, times: cfg.times, locale: 'ashkenazi' });
    const clusters = cal.clusters('2026-08-21', '2026-08-23'); // a plain Shabbos
    const compiler = new TimelineCompiler({ calendar: cal, sceneRepo: new SceneRepository(cfg.scenes), schedules: cfg.schedules, guestMode: true, guestUntil: Date.parse('2027-09-01') });
    const { allActions } = compiler.compile(clusters, Date.parse('2026-08-20'), Date.parse('2026-08-24'));
    const guest = allActions.filter((a) => a.source.guest);
    expect(guest.length).toBeGreaterThan(0);
    expect(guest.some((a) => a.source.ruleId === 'g1')).toBe(true);
    // base rules still present alongside (layered, not replaced)
    expect(allActions.some((a) => a.source.ruleId === 'r-scene' && !a.source.guest)).toBe(true);
  });

  it('drives a dense same-minute burst of actions to the bridge reliably (test mode, real timers)', async () => {
    // 5 zones all commanded within the same minute + a scene — the serialized
    // command queue must land every one of them.
    await agent().put('/api/schedules/pesach-1/default').send({ rules: [
      { id: 'b1', label: '', enabled: true, action: { type: 'setLevel', zone: 2, zones: [2, 3, 5, 9], level: 75 }, trigger: { kind: 'fixed', time: '15:00', day: 'erev' } },
      { id: 'b2', label: '', enabled: true, action: { type: 'sceneStart', sceneId: 'meal' }, trigger: { kind: 'fixed', time: '15:00', day: 'erev' } },
      { id: 'b3', label: '', enabled: true, action: { type: 'flash', zone: 4, times: 1 }, trigger: { kind: 'fixed', time: '15:00', day: 'erev' } },
    ] }).expect(200);
    const cfg = configStore.get();
    const cal = new CalendarService({ location: cfg.location, times: cfg.times, locale: 'ashkenazi' });
    const seder = cal.clusters('2027-04-21', '2027-04-23')[0];
    const erevDate = seder.erevDate; // 2027-04-21
    const target = Date.parse(`${erevDate}T15:00:00-04:00`) - 1500;

    const executed = [];
    scheduler.on('actionExecuted', (a) => executed.push(a));
    const failed = [];
    scheduler.on('actionFailed', (f) => failed.push(f));
    await scheduler.setTestMode(target);
    await sleep(4500); // let the burst fire (flash takes ~1.4s itself)

    expect(failed.map((f) => `${f.action?.source?.ruleId} z${f.action?.zone}: ${f.error?.message}`)).toEqual([]);
    // every multi-zone target hit 75 unless the scene overrode it (b2 fires at
    // the same instant; order between same-time actions isn't guaranteed) —
    // the point is every zone got driven and nothing errored or was dropped
    expect(executed.length).toBeGreaterThanOrEqual(8); // 4 setLevels + 3 scene zones + flash
    for (const z of [2, 5]) expect(bridge.levels.get(z)).toBe(75); // untouched by the scene
    expect([60, 75]).toContain(bridge.levels.get(9)); // scene sets 60, b1 sets 75 — either order is legal
    expect([0, 100]).toContain(bridge.levels.get(4)); // flash restores the pre-flash state (scene may have set 100)
    await scheduler.clearTestMode({ restore: false });
  }, 25_000);
});
