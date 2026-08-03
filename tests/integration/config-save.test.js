import { describe, it, expect, afterEach, vi } from 'vitest';
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

// Regression suite for "Save timing turned the lights on" (real clock, NO test
// mode): saving a setting recompiles the schedule but must never actuate
// lights outside an active Shabbos/Yom Tov window. The reported bug: on erev,
// switching Child Lock `begins` to "first rule" moved the enforce boundary
// into the past, the cluster flipped active, and the retroactive catch-up
// drove the lights — from a settings save on a plain afternoon.
//
// Same calendar anchor as test-mode-childlock: Pesach I 5787, seder night
// Wed 2027-04-21, erev rule at 15:00 EDT, candle lighting ~19:2x EDT.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const setCommands = () => bridge.commandLog.filter((l) => l.startsWith('#OUTPUT'));

let dir; let bridge; let client; let scheduler; let stack;

async function boot() {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfgsave-'));
  bridge = new MockBridge();
  await bridge.listen();
  client = new LutronClient({ host: '127.0.0.1', port: bridge.port, zoneIds: [2], commandTimeoutMs: 500 });
  await client.connect();

  const configStore = new ConfigStore({ dataDir: dir });
  configStore.load();
  configStore.update({
    location: { zip: '10952', lat: 41.1126, lng: -74.0736, city: 'Monsey', state: 'NY', tzid: 'America/New_York', il: false, elevation: 0 },
    enforcement: { enabled: true, graceSeconds: 0.05, overridePresses: 3, overrideWindowSeconds: 10 },
    zones: [{ id: 2, name: 'Main', area: 'Living Room', friendlyName: 'Living Room', dimmable: true, enforce: true }],
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
  const enforcement = new EnforcementEngine({ configStore, stateStore, tracker, lutron: client });
  scheduler = new Scheduler({ configStore, stateStore, tracker, enforcement, lutron: client });
  enforcement.setClock(() => scheduler.now()); // production wiring (index.js)
  scheduler.recompile(); // boot compile on the (faked) real clock
  stack = { configStore, stateStore, tracker, enforcement };
  return stack;
}

afterEach(async () => {
  scheduler?.stop();
  client?.close();
  await bridge?.close();
  fs.rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
});

describe('config saves on the REAL clock (no test mode)', () => {
  it('plain weekday: saving Child Lock timing sends zero light commands', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); // fake the clock, keep real timers/sockets
    vi.setSystemTime(new Date('2027-04-12T16:00:00Z')); // Monday noon ET, nothing near
    const { configStore } = await boot();
    await sleep(200);
    const before = setCommands().length;

    configStore.update({ enforcement: { begins: { kind: 'firstRule' } } });
    await sleep(400);
    configStore.update({ enforcement: { begins: null } }); // and back
    await sleep(400);

    expect(setCommands().length).toBe(before); // no actuation, either save
    expect(bridge.levels.get(2)).toBe(0);
    expect(scheduler.activeCluster()).toBeNull();
  }, 15_000);

  it('erev + begins -> firstRule (the reported bug): save arms Child Lock but does not drive lights', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // 15:30 EDT erev Pesach — AFTER the 15:00 first rule, BEFORE candle lighting
    vi.setSystemTime(new Date('2027-04-21T19:30:00Z'));
    const { configStore, enforcement } = await boot();
    await sleep(200);
    expect(bridge.levels.get(2)).toBe(0); // erev afternoon, light off, nothing driven
    const before = setCommands().length;

    // The save that used to turn the lights on: the firstRule boundary (15:00)
    // is already in the past, so the cluster flips enforcement-active here.
    configStore.update({ enforcement: { begins: { kind: 'firstRule' } } });
    await sleep(400);
    expect(setCommands().length).toBe(before); // THE regression: no catch-up fired
    expect(bridge.levels.get(2)).toBe(0);      // lights untouched by the save
    expect(scheduler.activeCluster()).toBeNull(); // candle lighting still hours away

    // ...but Child Lock IS armed from the boundary on: a wall flip after the
    // save gets corrected to the scheduled level (suppressing the retroactive
    // catch-up must not disable live enforcement).
    const corrected = new Promise((r) => enforcement.once('corrected', r));
    bridge.simulateManualChange(2, 10);
    await corrected;
    await sleep(150);
    expect(bridge.levels.get(2)).toBe(80);
  }, 15_000);

  it('suppressed erev save: the cluster-entry catch-up still runs at candle lighting', async () => {
    // Candle lighting (cluster start) computed the same way the app does.
    const start = new CalendarService({
      location: { zip: '10952', lat: 41.1126, lng: -74.0736, city: 'Monsey', state: 'NY', tzid: 'America/New_York', il: false, elevation: 0 },
      times: { candleLightingMins: 18, havdalahMins: 45, tzeitAngle: 8.5 }, // schema defaults
      locale: 'ashkenazi',
    }).clusters('2027-04-20', '2027-04-24').find((c) => c.days.some((d) => d.dayType === 'pesach-1')).startsAt.getTime();

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(start - 2000)); // 2s before candles; 15:00 rule long past
    const { configStore } = await boot();
    await sleep(200);

    // The save flips the boundary into the past — catch-up suppressed, debt kept
    configStore.update({ enforcement: { begins: { kind: 'firstRule' } } });
    await sleep(400);
    expect(bridge.levels.get(2)).toBe(0); // the save itself actuated nothing

    // ...then candle lighting genuinely arrives: the deferred snap must fire
    vi.setSystemTime(new Date(start + 1000));
    await sleep(2600); // the real 2s start-timer fires with the clock now past candles
    expect(bridge.levels.get(2)).toBe(80); // entering Shabbos with zones on schedule
  }, 15_000);

  it('reconcile never re-fires momentary automation devices', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2027-04-22T02:00:00Z')); // mid-cluster (seder night)
    const { configStore } = await boot();
    configStore.update({
      zones: [
        { id: 2, name: 'Main', area: 'Living Room', friendlyName: 'Living Room', dimmable: true, enforce: true },
        // an imported HA automation, modeled on the Lutron mock for the test
        { id: 3, name: 'Shabbos Prep', area: 'Automations', friendlyName: 'Shabbos Prep', dimmable: false, enforce: false, kind: 'automation' },
      ],
      schedules: {
        'pesach-1': { default: { rules: [
          { id: 'erev-on', label: 'on for the seder prep', enabled: true,
            action: { type: 'setLevel', zone: 2, level: 80, fadeSec: 0 },
            trigger: { kind: 'fixed', time: '15:00', day: 'erev' } },
          { id: 'run-prep', label: 'run the prep automation', enabled: true,
            action: { type: 'setLevel', zone: 3, level: 100, fadeSec: 0 },
            trigger: { kind: 'fixed', time: '15:30', day: 'erev' } },
        ] } },
      },
    });
    scheduler.recompile();
    await scheduler.reconcile(); // boot catch-up mid-cluster
    await sleep(300);

    expect(bridge.levels.get(2)).toBe(80); // the light IS reconciled
    // ...but the automation's past "run" action is never replayed by
    // reconcile or the cluster-entry catch-up — triggers fire once, at their time
    expect(bridge.commandLog.filter((l) => l.startsWith('#OUTPUT,3'))).toEqual([]);
  }, 15_000);

  it('mid-cluster: a save still reconciles zones back to the schedule', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // 22:00 EDT seder night — inside the pesach-1 cluster, 15:00 rule governs
    vi.setSystemTime(new Date('2027-04-22T02:00:00Z'));
    const { configStore } = await boot();
    await scheduler.reconcile();
    await sleep(200);
    expect(bridge.levels.get(2)).toBe(80);

    stack.enforcement.setActiveCluster(null, null); // isolate the reconcile path
    bridge.simulateManualChange(2, 10);
    await sleep(200);

    configStore.update({ enforcement: { graceSeconds: 0.05 } }); // benign save
    await sleep(400);
    expect(bridge.levels.get(2)).toBe(80); // reconcile re-drove it — schedule is in force
  }, 15_000);
});
