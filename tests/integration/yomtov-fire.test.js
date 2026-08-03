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

// The user's exact scenario: pretend it IS a Yom Tov day, seconds before a
// scheduled rule — and watch the scheduler actually fire it on the bridge.
// Date is faked; timers and sockets are real, so this exercises the true
// arm-timer -> fire -> executeAction path end to end.
//
// Pesach I 5787 = Thursday, April 22, 2027. Rule: living room -> 80% at 15:00.
// Clock starts at 14:59:52 — the timer must fire ~8s later.

let dir; let bridge; let client; let scheduler; let stateStore;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2027-04-22T14:59:52-04:00'));
});

afterEach(async () => {
  scheduler?.stop();
  client?.close();
  await bridge?.close();
  fs.rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
});

describe('Yom Tov scheduling fires for real', () => {
  it('arms and executes a Pesach I rule seconds after boot', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytfire-'));
    bridge = new MockBridge();
    await bridge.listen();

    const configStore = new ConfigStore({ dataDir: dir });
    configStore.load();
    configStore.update({
      location: { zip: '10952', lat: 41.1126, lng: -74.0736, city: 'Monsey', state: 'NY', tzid: 'America/New_York', il: false, elevation: 0 },
      zones: [{ id: 2, name: 'Main Lights', area: 'Living Room', friendlyName: 'Living Room', dimmable: true, enforce: false }],
      schedules: {
        'pesach-1': { default: { rules: [
          { id: 'yt-fire', label: 'living room for YT afternoon', enabled: true,
            action: { type: 'setLevel', zone: 2, level: 80, fadeSec: 0 },
            trigger: { kind: 'fixed', time: '15:00' } },
        ] } },
      },
      setupComplete: true,
    });
    stateStore = new StateStore({ dataDir: dir, debounceMs: 10 });
    stateStore.load();
    client = new LutronClient({ host: '127.0.0.1', port: bridge.port, zoneIds: [2], commandTimeoutMs: 500 });
    const tracker = new ZoneStateTracker({ stateStore });
    client.on('zoneLevel', (e) => tracker.onZoneLevel(e));
    const enforcement = new EnforcementEngine({ configStore, stateStore, tracker, lutron: client });
    scheduler = new Scheduler({ configStore, stateStore, tracker, enforcement, lutron: client });
    await client.connect();

    // "boot" mid-Yom-Tov: compile + catch-up + arm timers
    scheduler.recompile();
    await scheduler.reconcile();

    // sanity: the engine knows it's Pesach I and we're inside the cluster
    const active = scheduler.activeCluster();
    expect(active).not.toBeNull();
    expect(active.days.map((d) => d.dayType)).toContain('pesach-1');
    expect(active.days.find((d) => d.date === '2027-04-22').dayType).toBe('pesach-1');
    expect(stateStore.get().activeClusterId).toBe(active.id);

    // the rule resolved for today at 15:00 local
    const resolved = scheduler.compiled.report.days
      .find((d) => d.date === '2027-04-22')?.resolved.find((r) => r.ruleId === 'yt-fire');
    expect(resolved).toBeDefined();

    // nothing yet — it's 14:59:52
    expect(bridge.levels.get(2)).toBe(0);

    // wait through the real timer (fires ~8s in) with the fake date advancing
    const fired = new Promise((resolve) => scheduler.once('actionExecuted', resolve));
    const advance = setInterval(() => vi.setSystemTime(new Date(Date.now() + 1000)), 1000);
    const action = await fired;
    clearInterval(advance);

    expect(action.source.ruleId).toBe('yt-fire');
    expect(action.source.dayType).toBe('pesach-1');
    await new Promise((r) => setTimeout(r, 300));
    expect(bridge.levels.get(2)).toBe(80); // the light actually changed
    expect(tracker.expected(2)).toBe(80);
  }, 30_000);
});
