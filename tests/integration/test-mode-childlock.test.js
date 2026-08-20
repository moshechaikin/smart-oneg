import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MockBridge } from '../../server/lutron/MockBridge.js';
import { LutronClient } from '../../server/lutron/LutronClient.js';
import { ZoneStateTracker } from '../../server/safety/ZoneStateTracker.js';
import { EnforcementEngine } from '../../server/safety/EnforcementEngine.js';
import { Scheduler } from '../../server/engine/Scheduler.js';
import { ConfigStore } from '../../server/config/ConfigStore.js';
import { StateStore } from '../../server/config/StateStore.js';
import { CalendarService } from '../../server/calendar/CalendarService.js';

// Child Lock inside TEST MODE, full stack: real Scheduler.setTestMode virtual
// clock, real MockBridge, and the production wiring (enforcement runs on the
// scheduler's clock — the exact wiring index.js does). Regression suite for
// "Child Lock was dead during test mode".

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let dir; let bridge; let client; let scheduler; let stack;

async function boot({ enforce = true } = {}) {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmcl-'));
  bridge = new MockBridge();
  await bridge.listen();
  client = new LutronClient({ host: '127.0.0.1', port: bridge.port, zoneIds: [2], commandTimeoutMs: 500 });
  await client.connect();

  const configStore = new ConfigStore({ dataDir: dir });
  configStore.load();
  configStore.update({
    location: { zip: '10952', lat: 41.1126, lng: -74.0736, city: 'Monsey', state: 'NY', tzid: 'America/New_York', il: false, elevation: 0 },
    enforcement: { enabled: true, graceSeconds: 0.05, overridePresses: 3, overrideWindowSeconds: 10 },
    zones: [{ id: 2, name: 'Main', area: 'Living Room', friendlyName: 'Living Room', dimmable: true, enforce }],
    schedules: {
      'pesach-1': { default: { rules: [
        { id: 'erev-on', label: 'on for the seder prep', enabled: true,
          action: { type: 'setLevel', zone: 2, level: 80, fadeSec: 0 },
          trigger: { kind: 'fixed', time: '15:00', day: 'erev' } },
      ] } },
    },
    setupComplete: true,
  });
  const stateStore = new StateStore({ dataDir: dir, debounceMs: 10 });
  stateStore.load();
  const tracker = new ZoneStateTracker({ stateStore });
  client.on('zoneLevel', (e) => tracker.onZoneLevel(e));
  const enforcement = new EnforcementEngine({
    configStore, stateStore, tracker, devices: client,
    isTestMode: () => scheduler.isTestMode(), // production wiring (index.js)
  });
  scheduler = new Scheduler({ configStore, stateStore, tracker, enforcement, devices: client });
  enforcement.setClock(() => scheduler.now()); // production wiring (index.js)
  stack = { configStore, stateStore, tracker, enforcement };
  return stack;
}

afterEach(async () => {
  scheduler?.stop();
  client?.close();
  await bridge?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// Pesach I 5787: seder night Wed Apr 21 2027; candle lighting ~19:2x ET.
// (Computed via the calendar directly — the scheduler's compile window is
// anchored to "now" and doesn't reach that far.)
function clusterStart() {
  const cfg = stack.configStore.get();
  const cal = new CalendarService({ location: cfg.location, times: cfg.times, locale: 'ashkenazi' });
  const c = cal.clusters('2027-04-20', '2027-04-24').find((cc) => cc.days.some((d) => d.dayType === 'pesach-1'));
  return c.startsAt.getTime();
}

describe('Child Lock inside test mode (full stack)', () => {
  it('erev flips are left alone; cluster entry snaps the zone back; live enforcement corrects after that', async () => {
    const { enforcement } = await boot();
    const start = clusterStart();
    // virtual clock: erev afternoon (after the 15:00 rule, before candle lighting)
    await scheduler.setTestMode(start - 2000);
    await sleep(300);
    expect(bridge.levels.get(2)).toBe(80); // reconcile drove the erev rule's level

    // 1) erev: manual change is allowed — no correction
    bridge.simulateManualChange(2, 10);
    await sleep(250);
    expect(bridge.levels.get(2)).toBe(10);

    // 2) candle lighting arrives on the virtual clock: catch-up snaps it back
    await sleep(2400);
    expect(scheduler.activeCluster()).not.toBeNull();
    expect(bridge.levels.get(2)).toBe(80);

    // 3) now inside the cluster: a wall flip is corrected after the grace delay
    const corrected = new Promise((r) => enforcement.once('corrected', r));
    bridge.simulateManualChange(2, 0);
    await corrected;
    await sleep(150);
    expect(bridge.levels.get(2)).toBe(80);
  }, 20_000);

  it("non-Jew's override in test mode is a mock (never persisted) yet holds the zone, and clears on exit", async () => {
    const { enforcement, stateStore } = await boot();
    const start = clusterStart();
    await scheduler.setTestMode(start + 60_000); // straight into the cluster
    await sleep(400);
    expect(bridge.levels.get(2)).toBe(80);

    const latched = new Promise((r) => enforcement.once('latched', r));
    for (let i = 0; i < 3; i++) {
      bridge.simulateManualChange(2, 25);
      await sleep(200); // let each deviation land (and corrections echo)
    }
    const info = await latched;
    expect(info.zone).toBe(2);
    expect(info.test).toBe(true);          // the event is flagged as a dry run
    expect(enforcement.isLatched(2)).toBe(true); // ephemeral latch holds during the rehearsal
    expect(stateStore.zone(2).latch).toBeNull(); // but NOTHING is persisted to state.json

    // the (mock-)latched zone is still left at its manual state for the rehearsal
    bridge.simulateManualChange(2, 25);
    await sleep(250);
    expect(bridge.levels.get(2)).toBe(25);

    await scheduler.clearTestMode({ restore: false });
    expect(enforcement.isLatched(2)).toBe(false);
    expect(stateStore.zone(2).latch).toBeNull();
  }, 20_000);

  it('a config save during test mode keeps the virtual clock and re-syncs zones (the "Save timing" case)', async () => {
    const { configStore } = await boot();
    const start = clusterStart();
    await scheduler.setTestMode(start - 2000);
    await sleep(300);
    expect(scheduler.testModeInfo().active).toBe(true);

    bridge.simulateManualChange(2, 10); // erev flip
    await sleep(200);
    // saving settings triggers recompile + reconcile (index wiring is the
    // configStore 'change' listener registered by the Scheduler itself)
    configStore.update({ enforcement: { graceSeconds: 0.05 } });
    await sleep(400);
    expect(scheduler.testModeInfo().active).toBe(true); // test mode survives saves
    expect(bridge.levels.get(2)).toBe(80); // reconcile re-synced the zone
  }, 20_000);

  it('zones without enforce are never corrected, even mid-cluster in test mode', async () => {
    await boot({ enforce: false });
    const start = clusterStart();
    await scheduler.setTestMode(start + 60_000);
    await sleep(400);
    bridge.simulateManualChange(2, 5);
    await sleep(300);
    expect(bridge.levels.get(2)).toBe(5); // untouched
  }, 20_000);

  // Configurable early boundary: households that accept Shabbos/YT early can
  // start Child Lock at a fixed erev time instead of candle lighting.
  // Erev Pesach I 5787 is Wed 2027-04-21 (EDT): 18:00 local = 22:00Z, sunset
  // in Monsey that day ~19:44 EDT, candle lighting ~19:2x.
  const EREV_6PM = Date.parse('2027-04-21T22:00:00Z');

  it('early boundary: enforcement corrects before candle lighting once the fixed time passes (summer gate met)', async () => {
    const { configStore, enforcement } = await boot();
    configStore.update({ enforcement: { begins: { kind: 'fixed', time: '18:00', onlyIfSunsetAfter: '18:30' } } });
    await scheduler.setTestMode(EREV_6PM + 5000);
    await sleep(400);
    expect(bridge.levels.get(2)).toBe(80);          // 15:00 erev rule reconciled
    expect(scheduler.activeCluster()).toBeNull();   // candle lighting is still ~1.5h away

    const corrected = new Promise((r) => enforcement.once('corrected', r));
    bridge.simulateManualChange(2, 10);             // a kid flips the switch at 18:00
    await corrected;
    await sleep(150);
    expect(bridge.levels.get(2)).toBe(80);          // Child Lock already watching
  }, 20_000);

  it('early boundary: sunset gate not met leaves the standard candle-lighting boundary', async () => {
    const { configStore } = await boot();
    // require sunset after 20:30 — April sunset (~19:44) fails the gate
    configStore.update({ enforcement: { begins: { kind: 'fixed', time: '18:00', onlyIfSunsetAfter: '20:30' } } });
    await scheduler.setTestMode(EREV_6PM + 5000);
    await sleep(400);
    expect(bridge.levels.get(2)).toBe(80);

    bridge.simulateManualChange(2, 10);
    await sleep(300);
    expect(bridge.levels.get(2)).toBe(10);          // erev flip left alone, as normal
  }, 20_000);

  // "begins: first rule" — the boot() schedule's earliest rule fires 15:00 EDT
  // on the erev (well before candle lighting ~19:2x). Child Lock should watch
  // from that rule on, but NOT before it (and the cluster is not yet active).
  const AT_1430 = Date.parse('2027-04-21T18:30:00Z'); // 14:30 EDT — before the 15:00 rule
  const AT_1530 = Date.parse('2027-04-21T19:30:00Z'); // 15:30 EDT — after it, before candles

  it('first-rule boundary: watches from the earliest rule, and it is not active yet', async () => {
    const { configStore, enforcement } = await boot();
    configStore.update({ enforcement: { begins: { kind: 'firstRule' } } });
    await scheduler.setTestMode(AT_1530);
    await sleep(400);
    expect(scheduler.activeCluster()).toBeNull(); // candle lighting hours away — cluster NOT active
    expect(bridge.levels.get(2)).toBe(80);        // the 15:00 rule reconciled

    const corrected = new Promise((r) => enforcement.once('corrected', r));
    bridge.simulateManualChange(2, 10);
    await corrected;
    await sleep(150);
    expect(bridge.levels.get(2)).toBe(80);        // corrected from the first rule onward
  }, 20_000);

  it('first-rule boundary: before that first rule, switches are still free', async () => {
    const { configStore } = await boot();
    configStore.update({ enforcement: { begins: { kind: 'firstRule' } } });
    await scheduler.setTestMode(AT_1430);
    await sleep(400);
    expect(scheduler.activeCluster()).toBeNull();
    bridge.simulateManualChange(2, 5);
    await sleep(300);
    expect(bridge.levels.get(2)).toBe(5);         // before the first rule: left alone
  }, 20_000);
});
