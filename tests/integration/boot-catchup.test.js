import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

// Boot in the middle of Shabbos Erev Pesach 2025 (Sat Apr 12, 2pm ET) with
// every zone dark and assert the engine drives them to where the schedule
// says they should already be — the "NAS rebooted mid-Shabbos" scenario.

let dir; let bridge; let client; let stack;

async function bootStack({ latchZone9 = false, childLock = false } = {}) {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catchup-'));
  bridge = new MockBridge();
  await bridge.listen();

  const configStore = new ConfigStore({ dataDir: dir });
  configStore.load();
  configStore.update({
    location: { zip: '10952', lat: 41.1126, lng: -74.0176, city: 'Monsey', state: 'NY', tzid: 'America/New_York', il: false, elevation: 0 },
    ...(childLock ? { enforcement: { enabled: true } } : {}),
    zones: [
      { id: 3, name: 'Main Lights', area: 'Dining Room', friendlyName: 'Dining Room', dimmable: true, enforce: childLock },
      { id: 9, name: 'Main Lights', area: 'Kitchen', friendlyName: 'Kitchen', dimmable: true, enforce: false },
    ],
    schedules: {
      shabbos: {
        // Apr 12 2025 resolves to the erev-pesach variant
        'erev-pesach': { rules: [
          { id: 'dining-on', label: 'dining on for lunch', enabled: true,
            action: { type: 'setLevel', zone: 3, level: 100 },
            trigger: { kind: 'fixed', time: '12:00' } },
          { id: 'kitchen-on', label: 'kitchen on', enabled: true,
            action: { type: 'setLevel', zone: 9, level: 75 },
            trigger: { kind: 'fixed', time: '13:00' } },
          { id: 'dining-off', label: 'dining off', enabled: true,
            action: { type: 'setLevel', zone: 3, level: 0 },
            trigger: { kind: 'fixed', time: '16:00' } },
        ] },
      },
    },
    setupComplete: true,
  });

  const stateStore = new StateStore({ dataDir: dir, debounceMs: 10 });
  stateStore.load();
  if (latchZone9) {
    stateStore.zone(9).latch = { active: true, level: 0, until: '2025-04-14T20:25:00-04:00' };
    stateStore.save({ flush: true });
  }

  client = new LutronClient({ host: '127.0.0.1', port: bridge.port, zoneIds: [3, 9], commandTimeoutMs: 500 });
  const tracker = new ZoneStateTracker({ stateStore });
  const enforcement = new EnforcementEngine({ configStore, stateStore, tracker, devices: client });
  client.on('zoneLevel', (e) => tracker.onZoneLevel(e));
  const scheduler = new Scheduler({ configStore, stateStore, tracker, enforcement, devices: client });
  await client.connect();
  stack = { configStore, stateStore, tracker, enforcement, scheduler };
  return stack;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); // fake the clock, keep real timers/sockets
  vi.setSystemTime(new Date('2025-04-12T18:00:00Z')); // 2:00pm ET Shabbos Erev Pesach
});

afterEach(async () => {
  stack?.scheduler.stop();
  client?.close();
  await bridge?.close();
  fs.rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
});

describe('boot catch-up mid-Shabbos', () => {
  it('drives zones to their expected levels and detects the active cluster', async () => {
    const { scheduler, stateStore } = await bootStack();
    expect(bridge.levels.get(3)).toBe(0); // dark before boot completes

    scheduler.recompile();
    await scheduler.reconcile();

    expect(bridge.levels.get(3)).toBe(100); // 12:00 rule governs at 2pm
    expect(bridge.levels.get(9)).toBe(75);  // 13:00 rule governs at 2pm
    expect(stateStore.get().activeClusterId).toBe('cluster-2025-04-12');
    expect(scheduler.activeCluster().days.map((d) => d.variant))
      .toEqual(['erev-pesach', 'erev-is-shabbos', 'default']);
  });

  it("respects a persisted non-Jew's override latch during catch-up", async () => {
    const { scheduler } = await bootStack({ latchZone9: true });
    scheduler.recompile();
    await scheduler.reconcile();
    expect(bridge.levels.get(3)).toBe(100); // unlatched zone reconciled
    expect(bridge.levels.get(9)).toBe(0);   // latched zone left at manual state
  });

  it('child lock catch-up snaps enforce-flagged zones on cluster entry (no reconcile needed)', async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const { scheduler } = await bootStack({ childLock: true });
    scheduler.recompile(); // enters the active cluster -> becameActive -> catch-up
    await sleep(250);      // catch-up is async fire-and-forget
    expect(bridge.levels.get(3)).toBe(100); // enforce:true — snapped to schedule
    expect(bridge.levels.get(9)).toBe(0);   // enforce:false — untouched (reconcile never ran)

    // mid-cluster recompiles must NOT re-fire the catch-up
    bridge.simulateManualChange(3, 30);
    await sleep(50);
    scheduler.recompile();
    await sleep(250);
    expect(bridge.levels.get(3)).toBe(30);
  });

  it('reports the unconfigured YT variants for the upcoming days', async () => {
    const { scheduler } = await bootStack();
    scheduler.recompile();
    // pesach-1/pesach-2 have no schedules at all -> flagged for the dashboard
    const dates = scheduler.compiled.report.unscheduledDays.map((d) => d.dayType);
    expect(dates).toContain('pesach-1');
    expect(dates).toContain('pesach-2');
  });
});
