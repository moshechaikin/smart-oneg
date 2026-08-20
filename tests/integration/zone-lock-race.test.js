import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ZoneStateTracker } from '../../server/safety/ZoneStateTracker.js';
import { EnforcementEngine } from '../../server/safety/EnforcementEngine.js';
import { Scheduler } from '../../server/engine/Scheduler.js';
import { ConfigStore } from '../../server/config/ConfigStore.js';
import { StateStore } from '../../server/config/StateStore.js';

// Regression: reconcile(), #childLockCatchup(), and executeAction() (a fired
// action) each independently compute "the expected level" for a zone and can
// be triggered concurrently in ordinary use — a config save, a cluster
// boundary catch-up, and an armed timer landing within the same second is not
// exotic. Before the per-zone lock, whichever one's device write happened to
// SETTLE last won, even if it started first and its computed level was stale
// by the time it finished (a slow device retry is exactly this shape — see
// the sibling reconcile-race.test.js for the single-loop version of this
// bug). This test proves the cross-CALLER version: a slow reconcile() must
// not clobber a real, correctly-timed action that fires while it's mid-flight.
let dir;

afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe('a slow reconcile() cannot clobber a concurrently-fired action on the same zone', () => {
  it('the fired action (level 100) is the final word, not the slow stale reconcile (level 0)', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zonelock-'));
    const configStore = new ConfigStore({ dataDir: dir });
    configStore.load();
    configStore.update({
      location: { zip: '10952', lat: 41.1126, lng: -74.0736, city: 'Monsey', state: 'NY', tzid: 'America/New_York', il: false, elevation: 0 },
      zones: [{ id: 8, name: 'Basement', area: 'Test', friendlyName: 'Basement', dimmable: true, enforce: false }],
      setupComplete: true,
    });
    const stateStore = new StateStore({ dataDir: dir, debounceMs: 10 });
    stateStore.load();
    const tracker = new ZoneStateTracker({ stateStore });

    // reconcile's write (level 0) is held up 100ms — simulating the device
    // timeout+retry stall seen live — and only recorded into `order` once it
    // SETTLES (not when it's called): what matters for correctness is which
    // write actually lands on the device last, not which one was issued
    // first. The action fired concurrently (level 100) must win: either it's
    // queued behind reconcile's turn and settles after, or — if unlocked —
    // it settles first and reconcile's stale, still-in-flight write settles
    // OVER it a moment later, which is exactly the bug.
    const order = [];
    const fakeLutron = {
      connected: true,
      coerceLevel: (_id, lvl) => lvl,
      async setLevelVerified(id, level) {
        if (level === 0) await new Promise((r) => setTimeout(r, 100)); // reconcile's stale write
        order.push({ id, level });
      },
    };
    const enforcement = new EnforcementEngine({ configStore, stateStore, tracker, devices: fakeLutron });
    const scheduler = new Scheduler({ configStore, stateStore, tracker, enforcement, devices: fakeLutron });
    // Stale timeline: reconcile will compute level 0 for zone 8 for as long as
    // this stands, regardless of how much real time passes mid-test.
    scheduler.compiled = {
      actions: [],
      allActions: [{ zone: 8, type: 'setLevel', level: 0, at: Date.now() - 60_000 }],
      report: null, conflicts: [], clusters: [],
    };

    const reconcileDone = scheduler.reconcile(); // computes 0, then stalls 100ms mid-write
    const fireDone = scheduler.executeAction({
      zone: 8, type: 'setLevel', level: 100, fadeSec: 0, source: { ruleId: 'test' },
    }); // the "real" scheduled action — must be queued behind reconcile, not race it

    await Promise.all([reconcileDone, fireDone]);

    expect(order.at(-1)).toEqual({ id: 8, level: 100 });
    expect(tracker.expected(8)).toBe(100);

    scheduler.stop();
  }, 15_000);
});
