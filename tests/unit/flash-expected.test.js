import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Scheduler } from '../../server/engine/Scheduler.js';
import { ZoneStateTracker } from '../../server/safety/ZoneStateTracker.js';
import { StateStore } from '../../server/config/StateStore.js';

// Regression: the Aug 8 2026 incident where a Mincha-reminder flash landed on
// zone 3 (Dining Room Main) the instant a manual off had dropped its reported
// level to 0. The flash pre-registered its blink toggles with expectCommand,
// which left expectedLevel at the final blink (0) — silently inverting what the
// schedule wanted (100). Every subsequent "light is back on" then read as a
// deviation, the fight hit the override threshold, the zone latched until
// havdalah, and the 4 PM scene-end that turns the lights off was skipped.
//
// Invariant: a reminder blink must NEVER change a zone's expected level.
describe('flash never rewrites expected level', () => {
  const noop = () => {};
  let dir; let state; let tracker; let scheduler; let flashes;

  function makeScheduler() {
    flashes = [];
    return new Scheduler({
      configStore: { get: () => ({ zones: [{ id: 3, enforce: true }] }), on: noop },
      stateStore: state,
      tracker,
      enforcement: { isLatched: () => false, scheduledActionExecuted: noop },
      devices: {
        connected: true,
        coerceLevel: (_z, l) => l,
        flash: (zone, times, level) => { flashes.push({ zone, times, level }); return Promise.resolve(); },
      },
      canAct: () => true,
    });
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flash-'));
    state = new StateStore({ dataDir: dir, debounceMs: 10 });
    state.load();
    tracker = new ZoneStateTracker({ stateStore: state });
    scheduler = makeScheduler();
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('preserves expected when a flash lands during a manual deviation', async () => {
    tracker.setExpected(3, 100);           // Mealtime scene: lights on
    tracker.onZoneLevel({ id: 3, level: 0 }); // someone flips the switch off

    await scheduler.executeAction({ type: 'flash', zone: 3, times: 2, source: { ruleId: 'mincha' } });

    // physical restore rides the reported level (0); expected must stay 100
    expect(flashes).toEqual([{ zone: 3, times: 2, level: 0 }]);
    expect(tracker.expected(3)).toBe(100);
  });

  it('a light returning to its scheduled level after a flash is not a deviation', async () => {
    tracker.setExpected(3, 100);
    tracker.onZoneLevel({ id: 3, level: 0 });
    await scheduler.executeAction({ type: 'flash', zone: 3, times: 2, source: { ruleId: 'mincha' } });

    // let the flash's echo registrations expire so this reads as a real report
    tracker.pendingEchoes.clear();

    let deviated = false;
    tracker.on('deviation', () => { deviated = true; });
    tracker.onZoneLevel({ id: 3, level: 100 }); // back to the scheduled level
    expect(deviated).toBe(false);
  });
});
