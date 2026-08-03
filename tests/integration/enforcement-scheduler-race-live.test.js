import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MockBridge } from '../../server/lutron/MockBridge.js';
import { LutronClient } from '../../server/lutron/LutronClient.js';
import { DeviceBus } from '../../server/devices/DeviceBus.js';
import { ZoneStateTracker } from '../../server/safety/ZoneStateTracker.js';
import { EnforcementEngine } from '../../server/safety/EnforcementEngine.js';
import { Scheduler } from '../../server/engine/Scheduler.js';
import { ZoneLock } from '../../server/engine/ZoneLock.js';
import { ConfigStore } from '../../server/config/ConfigStore.js';
import { StateStore } from '../../server/config/StateStore.js';

// Full-stack version of enforcement-scheduler-race.test.js: real MockBridge
// (real TCP, real GNET/LIP wire protocol) behind a real DeviceBus/LutronClient,
// so this exercises DeviceBus.setLevelVerified's actual retry/verify path too,
// not just a hand-rolled fake. The sibling unit test proves the ZoneLock
// mechanics in isolation; this one proves the same fix holds with every layer
// between EnforcementEngine and the wire being the real production code.
let dir; let bridge; let client;

afterEach(async () => {
  if (client) client.close();
  if (bridge) await bridge.close();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe('(full stack, real wire) a slow Child Lock correction cannot clobber a concurrently-fired action', () => {
  it('the fired action (level 0) is the final word, not the slow stale correction (level 100)', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enf-sched-race-live-'));
    bridge = new MockBridge({ zoneIds: [8] });
    await bridge.listen();

    const configStore = new ConfigStore({ dataDir: dir });
    configStore.load();
    configStore.update({
      location: { zip: '10952', lat: 41.1126, lng: -74.0736, city: 'Monsey', state: 'NY', tzid: 'America/New_York', il: false, elevation: 0 },
      zones: [{ id: 8, name: 'Basement', area: 'Test', friendlyName: 'Basement', dimmable: true, enforce: true }],
      enforcement: { enabled: true, graceSeconds: 0.3, overridePresses: 5, begins: null },
      setupComplete: true,
    });
    const stateStore = new StateStore({ dataDir: dir, debounceMs: 10 });
    stateStore.load();
    const tracker = new ZoneStateTracker({ stateStore });
    client = new LutronClient({ host: '127.0.0.1', port: bridge.port, zoneIds: [8], commandTimeoutMs: 500 });
    client.on('zoneLevel', (e) => tracker.onZoneLevel(e));
    const bus = new DeviceBus({ configStore });
    bus.register('lutron', client);
    await client.connect();

    // Deterministically stall ONLY the correction's device write (the next
    // setLevelVerified call for zone 8) so it's still mid-flight — through the
    // REAL DeviceBus retry path — when the fired action below lands. Without
    // this, graceSeconds delays the correction enough that an immediately-
    // following write always finishes first regardless of any lock (confirmed
    // by hand — see the sibling script this was distilled from).
    const realSetLevelVerified = bus.setLevelVerified.bind(bus);
    let stallNext = false;
    bus.setLevelVerified = async (id, level, ...rest) => {
      if (id === 8 && stallNext) {
        stallNext = false;
        await new Promise((r) => setTimeout(r, 400));
      }
      return realSetLevelVerified(id, level, ...rest);
    };

    const zoneLock = new ZoneLock(); // shared, exactly as index.js wires it
    const enforcement = new EnforcementEngine({ configStore, stateStore, tracker, lutron: bus, zoneLock });
    const scheduler = new Scheduler({ configStore, stateStore, tracker, enforcement, lutron: bus, zoneLock });

    tracker.setExpected(8, 100); // schedule currently wants the zone ON
    await client.setLevel(8, 100);
    await new Promise((r) => setTimeout(r, 100));
    enforcement.setActiveCluster({ id: 'c1', startsAt: new Date(Date.now() - 3600_000), endsAt: new Date(Date.now() + 3600_000) });

    bridge.simulateManualChange(8, 40); // real wire event: someone flipped the switch
    stallNext = true;
    const correctedPromise = new Promise((r) => enforcement.once('corrected', r));
    await new Promise((r) => setTimeout(r, 400)); // let the grace timer fire and enter the stalled write

    // The actual schedule now wants this zone OFF (e.g. havdalah wind-down) —
    // must win over the stale in-flight correction.
    const fireDone = scheduler.executeAction({ zone: 8, type: 'setLevel', level: 0, fadeSec: 0, source: { ruleId: 'test' } });
    await Promise.all([fireDone, correctedPromise]);
    await new Promise((r) => setTimeout(r, 200));

    expect(bridge.levels.get(8)).toBe(0);
    expect(tracker.expected(8)).toBe(0);

    scheduler.stop();
    bus.setLevelVerified = realSetLevelVerified;
  }, 15_000);
});
