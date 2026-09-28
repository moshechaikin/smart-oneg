import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MockBridge } from '../../server/lutron/MockBridge.js';
import { LutronClient } from '../../server/lutron/LutronClient.js';
import { DeviceBus, blinkLevels } from '../../server/devices/DeviceBus.js';
import { ConfigStore } from '../../server/config/ConfigStore.js';
import { StateStore } from '../../server/config/StateStore.js';
import { ZoneStateTracker } from '../../server/safety/ZoneStateTracker.js';
import { EnforcementEngine } from '../../server/safety/EnforcementEngine.js';
import { Scheduler } from '../../server/engine/Scheduler.js';

/**
 * A Lutron dimmer RAMPS to its target instead of snapping, so the 700ms dark
 * step of a blink only dipped an already-ON light part-way before it climbed
 * back — the blink read as a flicker, not an off/on. The dark half is now held
 * longer for exactly that case.
 *
 * This suite pins down the blast radius, because the flash path is shared by
 * reminder rules, the Child Lock latch-confirm blink, and the manual test
 * button, and it runs while enforcement is watching the same zone:
 *
 *   1. WHICH zones slow down (only an already-ON Lutron dimmer) and which
 *      must be bit-for-bit unchanged.
 *   2. The emitted command sequence is untouched in every case — only the
 *      pause between writes changed.
 *   3. A slower flash cannot outlive its own echo registrations, which would
 *      make its own toggles look like wall-switch deviations and could latch
 *      the zone until havdalah.
 */

const STANDARD_STEP_MS = 700;
const CEILING = 1500; // comfortably above one standard step, far below the slow one

let dir; let bridge; let client; let bus; let configStore;

const ZONES = [
  // Lutron (implicit source) — the only kind that ramps
  { id: 3, name: 'Main', area: 'Dining', friendlyName: 'Dining', dimmable: true, enforce: true },
  { id: 4, name: 'Hall', area: 'Hall', friendlyName: 'Hall', dimmable: false, enforce: true },
  // A zone on another bridge: the same mock wire underneath in this harness,
  // but `source` says otherwise, so the Lutron ramp assumption must not apply.
  { id: 5, source: 'hubitat', externalId: 5, name: 'Den', area: 'Den', friendlyName: 'Den', dimmable: true, enforce: true },
];

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flashtiming-'));
  bridge = new MockBridge();
  await bridge.listen();
  client = new LutronClient({ host: '127.0.0.1', port: bridge.port, zoneIds: [3, 4, 5], commandTimeoutMs: 500 });
  configStore = new ConfigStore({ dataDir: dir });
  configStore.load();
  configStore.update({ zones: ZONES });
  bus = new DeviceBus({ configStore });
  bus.register('lutron', client);
  bus.register('hubitat', client); // same wire, different declared source
  await bus.connect();
});

afterEach(async () => {
  bus.close();
  await bridge.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const sets = (zone, from) => bridge.commandLog.slice(from).filter((l) => l.startsWith(`#OUTPUT,${zone},1`));
const timeFlash = async (zone, times, restore) => {
  const t0 = Date.now();
  await bus.flash(zone, times, restore);
  return Date.now() - t0;
};

describe('flash: which zones get the longer dark step', () => {
  it('an already-ON Lutron dimmer holds the dark step longer', async () => {
    await bus.setLevel(3, 80);
    expect(await timeFlash(3, 1, 80)).toBeGreaterThan(CEILING);
  });

  it('a Lutron dimmer that starts OFF is unchanged (ramping UP is already crisp)', async () => {
    await bus.setLevel(3, 0);
    expect(await timeFlash(3, 1, 0)).toBeLessThan(CEILING);
  });

  it('a Lutron non-dimmable switch is unchanged (it snaps, no ramp to wait out)', async () => {
    await bus.setLevel(4, 100);
    expect(await timeFlash(4, 1, 100)).toBeLessThan(CEILING);
  });

  it('a dimmer on another bridge is unchanged even when ON', async () => {
    await bus.setLevel(5, 80);
    expect(await timeFlash(5, 1, 80)).toBeLessThan(CEILING);
  });

  it('holds for any ON level, not just a round one', async () => {
    await bus.setLevel(3, 1); // the dimmest possible "on"
    expect(await timeFlash(3, 1, 1)).toBeGreaterThan(CEILING);
    await bus.setLevel(3, 100);
    expect(await timeFlash(3, 1, 100)).toBeGreaterThan(CEILING);
  });

  it('only the DARK half is slowed — the bright half keeps the standard step', async () => {
    // 2 blinks ON: dark, bright, dark, (final bright). If the bright step were
    // also slowed, the total would be ~4 slow steps instead of 2 slow + 1 fast.
    await bus.setLevel(3, 80);
    const twoBlinks = await timeFlash(3, 2, 80);
    const oneBlink = await timeFlash(3, 1, 80);
    const brightStep = twoBlinks - 2 * oneBlink; // = one bright step
    expect(brightStep).toBeLessThan(CEILING);
    expect(brightStep).toBeGreaterThan(STANDARD_STEP_MS / 2);
  });
});

describe('flash: the command sequence is never altered', () => {
  it('ON Lutron dimmer, 1 blink: off then restore, ends restored', async () => {
    await bus.setLevel(3, 80);
    const at = bridge.commandLog.length;
    await bus.flash(3, 1, 80);
    expect(sets(3, at)).toEqual(['#OUTPUT,3,1,0', '#OUTPUT,3,1,80']);
    expect(bridge.levels.get(3)).toBe(80);
  });

  it('ON Lutron dimmer, 2 blinks: two full pairs, ends restored', async () => {
    await bus.setLevel(3, 60);
    const at = bridge.commandLog.length;
    await bus.flash(3, 2, 60);
    expect(sets(3, at)).toEqual([
      '#OUTPUT,3,1,0', '#OUTPUT,3,1,60', '#OUTPUT,3,1,0', '#OUTPUT,3,1,60',
    ]);
    expect(bridge.levels.get(3)).toBe(60);
  });

  it('OFF Lutron dimmer still blinks UP to 100 and ends OFF', async () => {
    await bus.setLevel(3, 0);
    const at = bridge.commandLog.length;
    await bus.flash(3, 2, 0);
    expect(sets(3, at)).toEqual([
      '#OUTPUT,3,1,100', '#OUTPUT,3,1,0', '#OUTPUT,3,1,100', '#OUTPUT,3,1,0',
    ]);
    expect(bridge.levels.get(3)).toBe(0);
  });

  it('a non-dimmable zone still coerces its restore to 100', async () => {
    await bus.setLevel(4, 100);
    const at = bridge.commandLog.length;
    await bus.flash(4, 1, 55); // 55 on a switch means "on" -> 100
    expect(sets(4, at)).toEqual(['#OUTPUT,4,1,0', '#OUTPUT,4,1,100']);
  });

  it('matches blinkLevels exactly for every supported count', async () => {
    for (const times of [1, 2, 3, 4, 5]) {
      await bus.setLevel(3, 80);
      const at = bridge.commandLog.length;
      await bus.flash(3, times, 80);
      expect(sets(3, at)).toEqual(blinkLevels(80, times).map((l) => `#OUTPUT,3,1,${l}`));
      expect(bridge.levels.get(3)).toBe(80);
    }
  }, 60_000);

  it('times below 1 is clamped to a single blink', async () => {
    await bus.setLevel(3, 80);
    const at = bridge.commandLog.length;
    await bus.flash(3, 0, 80);
    expect(sets(3, at)).toEqual(['#OUTPUT,3,1,0', '#OUTPUT,3,1,80']);
  });

  it('an unknown zone rejects rather than hanging', async () => {
    await expect(bus.flash(999, 1, 80)).rejects.toThrow(/unknown zone/);
  });
});

describe('flash: echo TTL covers the whole run', () => {
  it('the slow path gets a longer TTL than the fast one', () => {
    expect(bus.flashEchoTtlMs(3, 2, 80)).toBeGreaterThan(bus.flashEchoTtlMs(3, 2, 0));
  });

  it('non-slowed zones keep the same TTL they always had', () => {
    // switch, other-bridge dimmer, and an OFF Lutron dimmer all agree
    expect(bus.flashEchoTtlMs(4, 2, 100)).toBe(bus.flashEchoTtlMs(5, 2, 80));
    expect(bus.flashEchoTtlMs(3, 2, 0)).toBe(bus.flashEchoTtlMs(5, 2, 80));
  });

  it('grows with the blink count', () => {
    expect(bus.flashEchoTtlMs(3, 2, 80)).toBeGreaterThan(bus.flashEchoTtlMs(3, 1, 80));
    expect(bus.flashEchoTtlMs(3, 5, 80)).toBeGreaterThan(bus.flashEchoTtlMs(3, 2, 80));
  });

  it('an unknown zone returns a usable TTL instead of throwing', () => {
    expect(bus.flashEchoTtlMs(999, 2, 80)).toBeGreaterThan(0);
  });

  it('the TTL actually outlasts the real run, for the slowest supported flash', async () => {
    const ttl = bus.flashEchoTtlMs(3, 5, 80);
    await bus.setLevel(3, 80);
    const elapsed = await timeFlash(3, 5, 80);
    expect(elapsed).toBeLessThan(ttl);
  }, 60_000);
});

/**
 * The safety property that matters most: a flash is the app blinking a light
 * on purpose. Enforcement watches the same zone and reverts unexplained
 * changes — and after N unexplained changes it LATCHES the zone until
 * havdalah. A flash whose echoes expire mid-run would be mistaken for a person
 * at the wall switch, so a slower flash must not become self-triggering.
 */
describe('flash: a slow blink is never mistaken for a wall switch', () => {
  let state; let tracker; let enforcement; let scheduler;

  const bootStack = async () => {
    configStore.update({
      location: { zip: '10952', lat: 41.1126, lng: -74.0736, city: 'Monsey', state: 'NY', tzid: 'America/New_York', il: false, elevation: 0 },
      enforcement: { enabled: true, graceSeconds: 0.05, overridePresses: 3, overrideWindowSeconds: 30 },
      setupComplete: true,
    });
    state = new StateStore({ dataDir: dir, debounceMs: 10 });
    state.load();
    tracker = new ZoneStateTracker({ stateStore: state });
    bus.on('zoneLevel', (e) => tracker.onZoneLevel(e));
    enforcement = new EnforcementEngine({ configStore, stateStore: state, tracker, devices: bus });
    scheduler = new Scheduler({ configStore, stateStore: state, tracker, enforcement, devices: bus });
    enforcement.setClock(() => scheduler.now());
    // Pretend a cluster is active so enforcement is fully armed on zone 3.
    const cluster = { id: 'test', startsAt: new Date(Date.now() - 3600_000), endsAt: new Date(Date.now() + 3600_000) };
    enforcement.setActiveCluster(cluster, Date.now() - 3600_000);
    return cluster;
  };

  afterEach(() => scheduler?.stop());

  it('a scheduled reminder flash raises no deviation and no latch', async () => {
    await bootStack();
    await bus.setLevel(3, 80);
    tracker.setExpected(3, 80);
    tracker.onZoneLevel({ id: 3, level: 80 });

    const deviations = [];
    tracker.on('deviation', (d) => deviations.push(d));
    const latched = [];
    enforcement.on('latched', (e) => latched.push(e));

    await scheduler.executeAction({ type: 'flash', zone: 3, times: 2, source: { ruleId: 'mincha' } });
    await new Promise((r) => setTimeout(r, 600)); // let trailing ~OUTPUTs land

    expect(deviations).toEqual([]);
    expect(latched).toEqual([]);
    expect(enforcement.isLatched(3)).toBe(false);
    expect(bridge.levels.get(3)).toBe(80);
  }, 30_000);

  it('the flash still does not rewrite the zone\'s expected level', async () => {
    await bootStack();
    await bus.setLevel(3, 80);
    tracker.setExpected(3, 80);

    await scheduler.executeAction({ type: 'flash', zone: 3, times: 2, source: { ruleId: 'mincha' } });
    expect(tracker.expected(3)).toBe(80); // not 0, not the last blink level
  }, 30_000);

  it('the Child Lock latch-confirm blink does not re-trigger enforcement', async () => {
    // The latch-confirm is itself a 2-blink flash on an ON Lutron dimmer — the
    // exact slow path — fired from inside the enforcement engine.
    await bootStack();
    await bus.setLevel(3, 80);
    tracker.setExpected(3, 80);
    tracker.onZoneLevel({ id: 3, level: 80 });

    const latchedEvents = [];
    enforcement.on('latched', (e) => latchedEvents.push(e));
    // three manual flips inside the window -> override threshold -> latch + blink
    for (let i = 0; i < 3; i++) {
      tracker.onZoneLevel({ id: 3, level: 10 });
      await new Promise((r) => setTimeout(r, 30));
    }
    await new Promise((r) => setTimeout(r, 6000)); // the confirm blink runs slow now

    expect(latchedEvents.length).toBe(1);     // latched exactly once
    expect(enforcement.isLatched(3)).toBe(true);
    expect(bridge.levels.get(3)).toBe(10);    // blink ended back at the manual level
  }, 30_000);

  it('holds judgment on an odd level WHILE the flash is in flight', async () => {
    // Pre-existing, deliberate: while any echo is pending the tracker treats an
    // unmatched level as a fade intermediate rather than a wall flip. The
    // longer dark step keeps echoes pending for longer, so pin the behavior.
    await bootStack();
    await bus.setLevel(3, 80);
    tracker.setExpected(3, 80);
    tracker.onZoneLevel({ id: 3, level: 80 });

    const deviations = [];
    tracker.on('deviation', (d) => deviations.push(d));
    const flashing = scheduler.executeAction({ type: 'flash', zone: 3, times: 1, source: { ruleId: 'mincha' } });
    await new Promise((r) => setTimeout(r, 100));
    tracker.onZoneLevel({ id: 3, level: 37 }); // mid-ramp, not a blink level
    await flashing;

    expect(deviations).toEqual([]);
  }, 30_000);

  it('a wall flip after the flash settles IS a deviation again', async () => {
    await bootStack();
    await bus.setLevel(3, 80);
    tracker.setExpected(3, 80);
    tracker.onZoneLevel({ id: 3, level: 80 });

    await scheduler.executeAction({ type: 'flash', zone: 3, times: 1, source: { ruleId: 'mincha' } });
    tracker.pendingEchoes.clear(); // stand in for the grace elapsing

    const deviations = [];
    tracker.on('deviation', (d) => deviations.push(d));
    tracker.onZoneLevel({ id: 3, level: 10 });
    expect(deviations.some((d) => d.reported === 10)).toBe(true);
  }, 30_000);

  it('the amnesty left after a flash is the standard grace, whatever the blink count', async () => {
    // The echo TTL is sized as "run length + the normal grace", so the window
    // that survives PAST the last write is constant. Before, a fixed 5s window
    // shrank as the run grew — and a long run could expire mid-flash.
    await bus.setLevel(3, 80);
    const oneTtl = bus.flashEchoTtlMs(3, 1, 80);
    const oneRun = await timeFlash(3, 1, 80);
    const twoTtl = bus.flashEchoTtlMs(3, 2, 80);
    const twoRun = await timeFlash(3, 2, 80);

    const slackOne = oneTtl - oneRun;
    const slackTwo = twoTtl - twoRun;
    expect(slackOne).toBeGreaterThan(4000);
    expect(slackTwo).toBeGreaterThan(4000);
    expect(Math.abs(slackOne - slackTwo)).toBeLessThan(600); // constant, not shrinking
  }, 60_000);
});
