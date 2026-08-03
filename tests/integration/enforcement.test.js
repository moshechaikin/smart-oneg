import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MockBridge } from '../../server/lutron/MockBridge.js';
import { LutronClient } from '../../server/lutron/LutronClient.js';
import { ZoneStateTracker } from '../../server/safety/ZoneStateTracker.js';
import { EnforcementEngine } from '../../server/safety/EnforcementEngine.js';
import { StateStore } from '../../server/config/StateStore.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let dir; let bridge; let client; let state; let tracker; let engine; let cfg;

function stubConfig(overrides = {}) {
  cfg = {
    enforcement: { enabled: true, graceSeconds: 0.05, overridePresses: 3, overrideWindowSeconds: 10, ...overrides.enforcement },
    zones: overrides.zones ?? [{ id: 9, enforce: true }, { id: 3, enforce: false }],
  };
  return { get: () => cfg, on: () => {} };
}

async function setup(configOverrides = {}) {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enforce-'));
  bridge = new MockBridge();
  await bridge.listen();
  client = new LutronClient({ host: '127.0.0.1', port: bridge.port, zoneIds: [3, 9], commandTimeoutMs: 500 });
  state = new StateStore({ dataDir: dir, debounceMs: 10 });
  state.load();
  tracker = new ZoneStateTracker({ stateStore: state });
  engine = new EnforcementEngine({ configStore: stubConfig(configOverrides), stateStore: state, tracker, lutron: client });
  client.on('zoneLevel', (e) => tracker.onZoneLevel(e));
  await client.connect();
  engine.setActiveCluster({ startsAt: new Date(Date.now() - 1000), endsAt: new Date(Date.now() + 3600_000) });
}

afterEach(async () => {
  client?.close();
  await bridge?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('echo suppression', () => {
  it('the app’s own commands are never treated as deviations', async () => {
    await setup();
    let deviations = 0;
    tracker.on('deviation', () => deviations++);
    tracker.expectCommand(9, 100);
    await client.setLevel(9, 100);
    tracker.expectCommand(9, 0);
    await client.setLevel(9, 0);
    await sleep(50);
    expect(deviations).toBe(0);
  });
});

describe('deviation -> grace -> correction', () => {
  it('corrects a manual change after the grace period', async () => {
    await setup();
    tracker.expectCommand(9, 100);
    await client.setLevel(9, 100);
    await sleep(20);

    const corrected = new Promise((r) => engine.once('corrected', r));
    bridge.simulateManualChange(9, 0); // child hits the switch
    await corrected;
    await sleep(30);
    expect(bridge.levels.get(9)).toBe(100);
  });

  it('leaves unenforced zones and disabled mode alone', async () => {
    await setup();
    tracker.expectCommand(3, 100);
    await client.setLevel(3, 100);
    await sleep(20);
    bridge.simulateManualChange(3, 0); // zone 3 has enforce:false
    await sleep(150);
    expect(bridge.levels.get(3)).toBe(0);

    cfg.enforcement.enabled = false;   // global kill switch
    bridge.simulateManualChange(9, 42);
    await sleep(150);
    expect(bridge.levels.get(9)).toBe(42);
  });

  it('a scheduled action cancels a pending grace correction', async () => {
    await setup();
    tracker.expectCommand(9, 100);
    await client.setLevel(9, 100);
    await sleep(20);
    bridge.simulateManualChange(9, 0);
    engine.scheduledActionExecuted(9); // schedule takes over before grace expiry
    tracker.expectCommand(9, 0);       // and the schedule now wants 0
    await sleep(150);
    expect(bridge.levels.get(9)).toBe(0); // no correction fired
  });
});

describe('test-mode virtual clock', () => {
  // Regression: Child Lock was dead during test mode because #enabledFor
  // judged the cluster window on real time while the simulated cluster is
  // real-future. Enforcement must run on the scheduler's (virtual) clock.
  it('enforces inside a cluster that is only active on the virtual clock', async () => {
    await setup();
    const offset = 26 * 3600_000; // "tomorrow evening" — real clock is outside the window
    engine.setClock(() => Date.now() + offset);
    engine.setActiveCluster({
      startsAt: new Date(Date.now() + offset - 1000),
      endsAt: new Date(Date.now() + offset + 3600_000),
    });
    tracker.expectCommand(9, 100);
    await client.setLevel(9, 100);
    await sleep(20);
    const corrected = new Promise((r) => engine.once('corrected', r));
    bridge.simulateManualChange(9, 0);
    await corrected;
    await sleep(30);
    expect(bridge.levels.get(9)).toBe(100);
  });

  it('does not enforce while the virtual clock is still erev (before candle lighting)', async () => {
    await setup();
    const offset = 26 * 3600_000;
    engine.setClock(() => Date.now() + offset);
    engine.setActiveCluster({
      startsAt: new Date(Date.now() + offset + 3600_000), // candle lighting is an hour of virtual time away
      endsAt: new Date(Date.now() + offset + 7200_000),
    });
    tracker.expectCommand(9, 100);
    await client.setLevel(9, 100);
    await sleep(20);
    let corrected = 0;
    engine.on('corrected', () => corrected++);
    bridge.simulateManualChange(9, 0);
    await sleep(150);
    expect(corrected).toBe(0);
    expect(bridge.levels.get(9)).toBe(0);
  });
});

describe('enforcement stays dormant outside Shabbos/Yom Tov', () => {
  it('never corrects when no cluster is active (regular weekday)', async () => {
    await setup();
    engine.setActiveCluster(null); // weekday: scheduler found no active cluster
    tracker.expectCommand(9, 100);
    await client.setLevel(9, 100);
    await sleep(20);
    bridge.simulateManualChange(9, 0);
    await sleep(200); // well past grace
    expect(bridge.levels.get(9)).toBe(0); // untouched
    expect(engine.isLatched(9)).toBe(false);
  });

  it('never corrects when the cluster has already ended', async () => {
    await setup();
    engine.setActiveCluster({ startsAt: new Date(Date.now() - 7200_000), endsAt: new Date(Date.now() - 3600_000) });
    tracker.expectCommand(9, 100);
    await client.setLevel(9, 100);
    await sleep(20);
    bridge.simulateManualChange(9, 0);
    await sleep(200);
    expect(bridge.levels.get(9)).toBe(0);
  });
});

describe("non-Jew's override latch", () => {
  it('latches after N presses, stops enforcement, persists across restart', async () => {
    await setup();
    tracker.expectCommand(9, 100);
    await client.setLevel(9, 100);
    await sleep(20);

    // press 1 & 2: corrected each time; press 3: latch (overridePresses = 3)
    for (let press = 1; press <= 2; press++) {
      const corrected = new Promise((r) => engine.once('corrected', r));
      bridge.simulateManualChange(9, 0);
      await corrected;
      await sleep(30);
      expect(bridge.levels.get(9)).toBe(100);
    }
    const latched = new Promise((r) => engine.once('latched', r));
    bridge.simulateManualChange(9, 0);
    const latchEvent = await latched;
    expect(latchEvent).toMatchObject({ zone: 9, level: 0 });
    expect(engine.isLatched(9)).toBe(true);

    // no more corrections
    await sleep(150);
    expect(bridge.levels.get(9)).toBe(0);

    // survives a crash: fresh StateStore from the same data dir
    const state2 = new StateStore({ dataDir: dir });
    state2.load();
    expect(state2.zone(9).latch).toMatchObject({ active: true, level: 0 });
  });

  it('blinks twice to confirm the override, ending at the level the helper set', async () => {
    await setup();
    // production passes a DeviceBus (which has .flash); the test client does not,
    // so stub a flash spy to stand in for it
    const flashes = [];
    engine.lutron.flash = (zone, times, level) => { flashes.push({ zone, times, level }); return Promise.resolve(); };
    tracker.expectCommand(9, 100);
    await client.setLevel(9, 100);
    await sleep(20);
    for (let press = 1; press <= 2; press++) {
      const corrected = new Promise((r) => engine.once('corrected', r));
      bridge.simulateManualChange(9, 0);
      await corrected;
      await sleep(30);
    }
    const latched = new Promise((r) => engine.once('latched', r));
    bridge.simulateManualChange(9, 0); // 3rd press -> latch at level 0
    await latched;
    await sleep(20);
    expect(flashes).toEqual([{ zone: 9, times: 2, level: 0 }]);
  });

  it('latch expires at cluster end', async () => {
    await setup();
    state.zone(9).latch = { active: true, level: 0, until: new Date(Date.now() - 1000).toISOString() };
    expect(engine.isLatched(9)).toBe(false); // expired -> auto-cleared
    expect(state.zone(9).latch).toBeNull();
  });

  it('presses far apart (outside override window) do not accumulate', async () => {
    await setup({ enforcement: { enabled: true, graceSeconds: 0.03, overridePresses: 2, overrideWindowSeconds: 0.1 } });
    tracker.expectCommand(9, 100);
    await client.setLevel(9, 100);
    await sleep(20);

    const corrected1 = new Promise((r) => engine.once('corrected', r));
    bridge.simulateManualChange(9, 0);
    await corrected1;
    await sleep(150); // exceed the 100ms override window

    const corrected2 = new Promise((r) => engine.once('corrected', r));
    bridge.simulateManualChange(9, 0); // would latch if window persisted
    await corrected2;                  // instead: corrected again
    expect(engine.isLatched(9)).toBe(false);
  });

  it('derives the override window from the grace delay when none is set', async () => {
    // no overrideWindowSeconds → window = graceSeconds + 25s (~25s here), so
    // presses in quick succession still accumulate and latch. Guards against a
    // regression where an undefined window made the comparison NaN (never
    // counts → could never latch).
    await setup({ enforcement: { enabled: true, graceSeconds: 0.03, overridePresses: 2 } });
    tracker.expectCommand(9, 100);
    await client.setLevel(9, 100);
    await sleep(20);

    const corrected = new Promise((r) => engine.once('corrected', r));
    bridge.simulateManualChange(9, 0); // press 1 → corrected
    await corrected;
    await sleep(30);
    const latched = new Promise((r) => engine.once('latched', r));
    bridge.simulateManualChange(9, 0); // press 2 (well within derived window) → latch
    await latched;
    expect(engine.isLatched(9)).toBe(true);
  });
});
