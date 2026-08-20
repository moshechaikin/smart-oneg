import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ZoneStateTracker } from '../../server/safety/ZoneStateTracker.js';
import { EnforcementEngine } from '../../server/safety/EnforcementEngine.js';
import { Scheduler } from '../../server/engine/Scheduler.js';
import { ZoneLock } from '../../server/engine/ZoneLock.js';
import { ConfigStore } from '../../server/config/ConfigStore.js';
import { StateStore } from '../../server/config/StateStore.js';

// Regression: EnforcementEngine.#correct() (Child Lock's grace-period
// correction, e.g. "the kids flipped the switch, put it back") and
// Scheduler's zone-driving ops live in DIFFERENT classes. #correct() always
// targets tracker.expected(zone) — never an independently-wrong value — but
// its WRITE can still be slow (a device timeout + retries). If a real,
// legitimately-later scheduled action fires for the SAME zone while the
// correction is mid-flight, the correction's stale write can settle AFTER
// the action's and silently revert it — a safety feature clobbering the
// actual schedule during a real Shabbos. A single ZoneLock instance shared
// between EnforcementEngine and Scheduler (wired in index.js) closes this by
// serializing both onto the same per-zone queue.
let dir;

afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe('a slow Child Lock correction cannot clobber a concurrently-fired action', () => {
  it('the Scheduler ADOPTS the EnforcementEngine\'s ZoneLock — sharing is correct-by-construction', async () => {
    // Cross-class serialization only works when both classes share ONE lock.
    // Rather than a separately-wired zoneLock key that a future construction
    // site could silently forget (running two independent locks with zero
    // error), the Scheduler adopts the lock of the enforcement instance it is
    // REQUIRED to be constructed with.
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-adopt-'));
    const configStore = new ConfigStore({ dataDir: dir });
    configStore.load();
    configStore.update({
      location: { zip: '10952', lat: 41.1126, lng: -74.0736, city: 'Monsey', state: 'NY', tzid: 'America/New_York', il: false, elevation: 0 },
      zones: [{ id: 8, name: 'Basement', area: 'Test', friendlyName: 'Basement', dimmable: true, enforce: true }],
      setupComplete: true,
    });
    const stateStore = new StateStore({ dataDir: dir, debounceMs: 10 });
    stateStore.load();
    const tracker = new ZoneStateTracker({ stateStore });
    const fakeLutron = { connected: true, coerceLevel: (_i, l) => l, async setLevelVerified() {} };

    // no zoneLock passed anywhere — the exact wiring mistake the adoption prevents
    const enforcement = new EnforcementEngine({ configStore, stateStore, tracker, devices: fakeLutron });
    const scheduler = new Scheduler({ configStore, stateStore, tracker, enforcement, devices: fakeLutron });
    expect(scheduler.zoneLock).toBe(enforcement.zoneLock); // one shared instance

    // an explicit lock still wins (tests that stage races inject their own)
    const explicit = new ZoneLock();
    const scheduler2 = new Scheduler({ configStore, stateStore, tracker, enforcement, devices: fakeLutron, zoneLock: explicit });
    expect(scheduler2.zoneLock).toBe(explicit);
    scheduler.stop();
    scheduler2.stop();
  }, 15_000);

  it('the fired action (level 0) is the final word, not the slow stale correction (level 100)', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enf-sched-race-'));
    const configStore = new ConfigStore({ dataDir: dir });
    configStore.load();
    configStore.update({
      location: { zip: '10952', lat: 41.1126, lng: -74.0736, city: 'Monsey', state: 'NY', tzid: 'America/New_York', il: false, elevation: 0 },
      zones: [{ id: 8, name: 'Basement', area: 'Test', friendlyName: 'Basement', dimmable: true, enforce: true }],
      enforcement: { enabled: true, graceSeconds: 0, overridePresses: 5, begins: null },
      setupComplete: true,
    });
    const stateStore = new StateStore({ dataDir: dir, debounceMs: 10 });
    stateStore.load();
    const tracker = new ZoneStateTracker({ stateStore });

    // The correction's write (level 100) is held up 100ms — simulating a
    // device timeout+retry stall — and only recorded into `order` once it
    // SETTLES (not when it's called): what matters for correctness is which
    // write actually lands on the device last, not which one was issued
    // first. `correctionStarted` is a separate, synchronous flag used only to
    // confirm the correction is mid-flight before the action below fires.
    const order = [];
    let correctionStarted = false;
    const fakeLutron = {
      connected: true,
      coerceLevel: (_id, lvl) => lvl,
      async setLevelVerified(id, level) {
        if (level === 100) { // the correction's target — stale by the time it settles
          correctionStarted = true;
          await new Promise((r) => setTimeout(r, 100));
        }
        order.push({ id, level });
      },
    };

    const zoneLock = new ZoneLock(); // shared, exactly as index.js wires it
    const enforcement = new EnforcementEngine({ configStore, stateStore, tracker, devices: fakeLutron, zoneLock });
    const scheduler = new Scheduler({ configStore, stateStore, tracker, enforcement, devices: fakeLutron, zoneLock });
    scheduler.compiled = { actions: [], allActions: [], report: null, conflicts: [], clusters: [] };

    // Zone 8 is scheduled ON (100); a real Shabbos cluster is active right now.
    tracker.setExpected(8, 100);
    enforcement.setActiveCluster({ id: 'c1', startsAt: new Date(Date.now() - 3600_000), endsAt: new Date(Date.now() + 3600_000) });

    // Capture completion of the correction itself (not just executeAction) —
    // with the lock UNSHARED, executeAction's write settles fast and returns
    // long before the correction wakes up from its 100ms sleep, so asserting
    // right after `await fireDone` would pass for the wrong reason (never
    // having observed the correction's later, clobbering write at all). Both
    // writes must be given the chance to fully settle before judging which
    // one "won".
    const correctedPromise = new Promise((resolve) => enforcement.once('corrected', resolve));

    // A manual deviation (someone flipped it to 50) — schedules the grace-period
    // correction back to 100 (graceSeconds: 0, so it fires on the next tick).
    tracker.onZoneLevel({ id: 8, level: 50 });
    // Let the grace timer fire and the correction start its (100ms-delayed)
    // write before the "real" action below fires.
    await new Promise((r) => setTimeout(r, 20));
    expect(correctionStarted).toBe(true); // correction is mid-flight (still sleeping)
    expect(order).toHaveLength(0); // ...and hasn't settled yet

    // Meanwhile the actual schedule now wants this zone OFF (e.g. havdalah
    // wind-down fired) — must win over the stale in-flight correction.
    const fireDone = scheduler.executeAction({
      zone: 8, type: 'setLevel', level: 0, fadeSec: 0, source: { ruleId: 'test' },
    });
    await Promise.all([fireDone, correctedPromise]); // wait for BOTH to fully settle

    expect(order.at(-1)).toEqual({ id: 8, level: 0 });
    expect(tracker.expected(8)).toBe(0);

    scheduler.stop();
  }, 15_000);

  it('the latch-confirm blink waits its zone-lock turn instead of racing a lock-held write', async () => {
    // #signalLatch's two-blink confirm is a real device write on the latched
    // zone. Unserialized, it races a lock-held write that passed its isLatched
    // check just before the latch was set — and if that stale scheduled write
    // settles last, the zone ends at the SCHEDULED level with nothing left to
    // re-assert the latch (all later writers skip latched zones). Inside the
    // lock, the blink runs AFTER the held write and its final restore
    // re-asserts the latched manual level.
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'latch-blink-'));
    const configStore = new ConfigStore({ dataDir: dir });
    configStore.load();
    configStore.update({
      location: { zip: '10952', lat: 41.1126, lng: -74.0736, city: 'Monsey', state: 'NY', tzid: 'America/New_York', il: false, elevation: 0 },
      zones: [{ id: 8, name: 'Basement', area: 'Test', friendlyName: 'Basement', dimmable: true, enforce: true }],
      enforcement: { enabled: true, graceSeconds: 5, overridePresses: 2, overrideWindowSeconds: 10, begins: null },
      setupComplete: true,
    });
    const stateStore = new StateStore({ dataDir: dir, debounceMs: 10 });
    stateStore.load();
    const tracker = new ZoneStateTracker({ stateStore });

    const order = [];
    const fakeLutron = {
      connected: true,
      coerceLevel: (_id, lvl) => lvl,
      async setLevelVerified(id, level) { order.push({ kind: 'set', id, level }); },
      async flash(id, times, restore) { order.push({ kind: 'flash', id, times, restore }); },
    };
    const zoneLock = new ZoneLock();
    // (the EnforcementEngine constructor subscribes to tracker 'deviation' itself)
    const enforcement = new EnforcementEngine({ configStore, stateStore, tracker, devices: fakeLutron, zoneLock });

    tracker.setExpected(8, 100); // schedule wants the zone ON
    enforcement.setActiveCluster({ id: 'c1', startsAt: new Date(Date.now() - 3600_000), endsAt: new Date(Date.now() + 3600_000) });

    // A lock-held write is mid-flight (it checked isLatched before the latch
    // landed) — e.g. a reconcile turn or armed action holding the zone lock.
    let releaseHold;
    const holdDone = zoneLock.run(8, async () => {
      await new Promise((r) => { releaseHold = r; });
      order.push({ kind: 'held-write-settled' });
    });

    // Two rapid manual presses cross the override threshold -> latch + blink.
    const latched = new Promise((r) => enforcement.once('latched', r));
    tracker.onZoneLevel({ id: 8, level: 40 });
    tracker.onZoneLevel({ id: 8, level: 60 });
    await latched;
    await new Promise((r) => setTimeout(r, 30)); // give an unserialized blink time to (wrongly) fire

    expect(order.some((e) => e.kind === 'flash')).toBe(false); // blink is queued, not racing

    releaseHold();
    await holdDone;
    await new Promise((r) => setTimeout(r, 30)); // let the queued blink turn run

    const settledIdx = order.findIndex((e) => e.kind === 'held-write-settled');
    const flashIdx = order.findIndex((e) => e.kind === 'flash');
    expect(flashIdx).toBeGreaterThan(settledIdx); // blink ran only after the held write
    expect(order[flashIdx].restore).toBe(60); // and restores the latched manual level
  }, 15_000);
});
