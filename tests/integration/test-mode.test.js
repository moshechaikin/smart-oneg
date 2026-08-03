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

// Test mode with a REAL clock (no fake timers): setTestMode to ~2s before a
// Yom Tov rule and confirm the scheduler drives the mock bridge for real.
let dir; let bridge; let client; let scheduler;

afterEach(async () => {
  scheduler?.stop();
  client?.close();
  await bridge?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('test mode', () => {
  function build() {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmode-'));
    const configStore = new ConfigStore({ dataDir: dir });
    configStore.load();
    configStore.update({
      location: { zip: '10952', lat: 41.1126, lng: -74.0736, city: 'Monsey', state: 'NY', tzid: 'America/New_York', il: false, elevation: 0 },
      zones: [{ id: 2, name: 'Main', area: 'Living Room', friendlyName: 'Living Room', dimmable: true, enforce: false }],
      schedules: { 'pesach-1': { default: { rules: [
        { id: 'yt', label: 'living room on', enabled: true,
          action: { type: 'setLevel', zone: 2, level: 80, fadeSec: 0 },
          trigger: { kind: 'fixed', time: '15:00' } },
      ] } } },
      setupComplete: true,
    });
    const stateStore = new StateStore({ dataDir: dir, debounceMs: 10 });
    stateStore.load();
    const tracker = new ZoneStateTracker({ stateStore });
    client.on('zoneLevel', (e) => tracker.onZoneLevel(e));
    const enforcement = new EnforcementEngine({ configStore, stateStore, tracker, lutron: client });
    return new Scheduler({ configStore, stateStore, tracker, enforcement, lutron: client });
  }

  it('drives the real bridge when the virtual clock reaches a rule', async () => {
    bridge = new MockBridge();
    await bridge.listen();
    client = new LutronClient({ host: '127.0.0.1', port: bridge.port, zoneIds: [2], commandTimeoutMs: 500 });
    await client.connect();
    scheduler = build();

    // Pesach I 5787 = Thu Apr 22 2027; rule fires 15:00 local. Jump to 2s before.
    const target = Date.parse('2027-04-22T15:00:00-04:00') - 2000;
    const fired = new Promise((r) => scheduler.once('actionExecuted', r));
    await scheduler.setTestMode(target);

    expect(scheduler.testModeInfo().active).toBe(true);
    const action = await fired;
    expect(action.source.ruleId).toBe('yt');
    await new Promise((r) => setTimeout(r, 200));
    expect(bridge.levels.get(2)).toBe(80);
  }, 15_000);

  it('clearTestMode returns to real time', async () => {
    bridge = new MockBridge();
    await bridge.listen();
    client = new LutronClient({ host: '127.0.0.1', port: bridge.port, zoneIds: [2], commandTimeoutMs: 500 });
    await client.connect();
    scheduler = build();

    await scheduler.setTestMode(Date.parse('2027-04-22T14:59:00-04:00'));
    expect(scheduler.testModeInfo().active).toBe(true);
    await scheduler.clearTestMode();
    expect(scheduler.testModeInfo().active).toBe(false);
    expect(scheduler.testOffsetMs).toBe(0);
    // real now: not inside a cluster, so no active cluster
    expect(scheduler.activeCluster()).toBeNull();
  }, 15_000);

  it('refuses to start once the real erev schedule is in effect', async () => {
    // Friday Jan 8 2027, 2pm ET — an "erev 10:00" rule already fired this morning
    // and Shabbos hasn't ended, so the real schedule is in force.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2027-01-08T14:00:00-05:00'));
    bridge = new MockBridge();
    await bridge.listen();
    client = new LutronClient({ host: '127.0.0.1', port: bridge.port, zoneIds: [2], commandTimeoutMs: 500 });
    await client.connect();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmode-'));
    const configStore = new ConfigStore({ dataDir: dir });
    configStore.load();
    configStore.update({
      location: { zip: '10952', lat: 41.1126, lng: -74.0736, city: 'Monsey', state: 'NY', tzid: 'America/New_York', il: false, elevation: 0 },
      zones: [{ id: 2, name: 'Main', area: 'Living Room', friendlyName: 'Living Room', dimmable: true, enforce: false }],
      schedules: { shabbos: { default: { rules: [
        { id: 'erev', label: 'erev prep', enabled: true,
          action: { type: 'setLevel', zone: 2, level: 60, fadeSec: 0 },
          trigger: { kind: 'fixed', time: '10:00', day: 'erev' } },
      ] } } },
      setupComplete: true,
    });
    const stateStore = new StateStore({ dataDir: dir, debounceMs: 10 });
    stateStore.load();
    const tracker = new ZoneStateTracker({ stateStore });
    const enforcement = new EnforcementEngine({ configStore, stateStore, tracker, lutron: client });
    scheduler = new Scheduler({ configStore, stateStore, tracker, enforcement, lutron: client });

    await expect(scheduler.setTestMode(Date.now() + 3_600_000)).rejects.toThrow(/real Shabbos/);
    expect(scheduler.testModeInfo().active).toBe(false);
    vi.useRealTimers();
  }, 15_000);

  it('restores the pre-test snapshot on manual exit', async () => {
    bridge = new MockBridge();
    await bridge.listen();
    client = new LutronClient({ host: '127.0.0.1', port: bridge.port, zoneIds: [2], commandTimeoutMs: 500 });
    await client.connect();
    scheduler = build();

    // weekday state: living room manually at 35%
    await client.setLevel(2, 35);
    await new Promise((r) => setTimeout(r, 200));

    // jump to just before the rule so it fires and changes the light to 80
    const fired = new Promise((r) => scheduler.once('actionExecuted', r));
    await scheduler.setTestMode(Date.parse('2027-04-22T15:00:00-04:00') - 1500);
    await fired;
    await new Promise((r) => setTimeout(r, 200));
    expect(bridge.levels.get(2)).toBe(80); // demo drove it

    // manual exit restores the weekday snapshot (35%)
    await scheduler.clearTestMode();
    await new Promise((r) => setTimeout(r, 200));
    expect(bridge.levels.get(2)).toBe(35);
  }, 15_000);
});
