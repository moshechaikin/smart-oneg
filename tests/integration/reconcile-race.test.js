import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ZoneStateTracker } from '../../server/safety/ZoneStateTracker.js';
import { EnforcementEngine } from '../../server/safety/EnforcementEngine.js';
import { Scheduler } from '../../server/engine/Scheduler.js';
import { ConfigStore } from '../../server/config/ConfigStore.js';
import { StateStore } from '../../server/config/StateStore.js';

// Regression: a zone's reconcile turn can start seconds after reconcile() was
// called (queued behind a slow same-zone write) while the clock keeps
// advancing — in test mode the virtual clock is a fixed offset off real time,
// so this.now() marches on and an armed timer can fire a scheduled action in
// between. If the turn used a `now` captured at reconcile() entry it would
// write the PRE-boundary expected level and clobber the action that just fired
// (observed live: basement snapped back off at 9:00, dining room stayed on at
// 16:00 — back then via the sequential loop's head-of-line stall; the loop is
// now parallel per zone, so the delay is staged on the zone's own lock).
// Each turn must re-read the clock when IT runs.
let dir;

afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe('reconcile does not overwrite an action the clock crossed mid-run', () => {
  it('a reconcile turn delayed past the boundary drives the POST-boundary level', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-race-'));
    const configStore = new ConfigStore({ dataDir: dir });
    configStore.load();
    configStore.update({
      location: { zip: '10952', lat: 41.1126, lng: -74.0736, city: 'Monsey', state: 'NY', tzid: 'America/New_York', il: false, elevation: 0 },
      // held zone FIRST in config order: a sequential loop would head-of-line
      // block zone 2 behind zone 8's hold — the parallel loop must not
      zones: [
        { id: 8, name: 'Basement', area: 'Test', friendlyName: 'Basement', dimmable: true, enforce: false },
        { id: 2, name: 'Other', area: 'Test', friendlyName: 'Other', dimmable: true, enforce: false },
      ],
      setupComplete: true,
    });
    const stateStore = new StateStore({ dataDir: dir, debounceMs: 10 });
    stateStore.load();
    const tracker = new ZoneStateTracker({ stateStore });

    const driven = [];
    const fakeLutron = {
      connected: true,
      coerceLevel: (_id, lvl) => lvl,
      async setLevelVerified(id, level) { driven.push({ id, level }); },
    };
    const enforcement = new EnforcementEngine({ configStore, stateStore, tracker, lutron: fakeLutron });
    // Build the scheduler AFTER config is set so the change listener never fires
    // a recompile that would overwrite our hand-built timeline below.
    const scheduler = new Scheduler({ configStore, stateStore, tracker, enforcement, lutron: fakeLutron });

    // Boundary B is 30 ms in the (virtual) future when reconcile() is called;
    // zone 8's turn is delayed 120 ms behind a held same-zone write (the same
    // shape as a slow device retry or an in-flight flash), so the clock
    // crosses B before its turn runs. Its write must use the level as of ITS
    // turn (100), never the 0 that was correct back when reconcile() started.
    const realNow = Date.now();
    const B = realNow + 100_000; // absolute action time (arbitrary future)
    scheduler.testOffsetMs = (B - 30) - realNow; // now() ≈ B - 30 at reconcile start
    scheduler.compiled = {
      actions: [],
      allActions: [
        { zone: 2, type: 'setLevel', level: 50, at: B - 10_000 },
        { zone: 8, type: 'setLevel', level: 0, at: B - 10_000 }, // overnight: off
        { zone: 8, type: 'setLevel', level: 100, at: B },        // 9:00 scene: on
      ],
      report: null, conflicts: [], clusters: [],
    };

    let releaseHold;
    const holdDone = scheduler.zoneLock.run(8, () => new Promise((r) => { releaseHold = r; }));
    const reconcileDone = scheduler.reconcile();

    // While zone 8 is still held: zone 2 must already have its write (per-zone
    // queues are independent — a sequential loop would have zone 2 stuck
    // behind zone 8's hold), and zone 8 must not have been driven yet.
    await new Promise((r) => setTimeout(r, 40));
    expect(driven).toEqual([{ id: 2, level: 50 }]);

    await new Promise((r) => setTimeout(r, 90)); // clock is now well past B
    releaseHold();
    await Promise.all([reconcileDone, holdDone]);

    const zone8 = driven.filter((d) => d.id === 8);
    expect(zone8).toHaveLength(1);
    // The clock crossed B while zone 8's turn waited, so it must be driven ON
    // (100), never the stale pre-boundary 0 that would clobber the fired action.
    expect(zone8[0].level).toBe(100);

    scheduler.stop();
  }, 15_000);
});
