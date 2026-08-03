import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { EnforcementEngine } from '../../server/safety/EnforcementEngine.js';

// Child Lock must never act on an INACTIVE standby — even if a deviation somehow
// reached it — so it can't fight the primary while the primary is in control.
function makeEnforcement(canAct) {
  const cfg = { enforcement: { enabled: true, graceSeconds: 5, overridePresses: 4, overrideWindowSeconds: 300 }, zones: [{ id: 3, enforce: true }] };
  const zoneState = {};
  const stateStore = {
    zone: (z) => (zoneState[z] ??= { latch: null }),
    get: () => ({ zones: zoneState }),
    save: () => {},
  };
  const tracker = new EventEmitter();
  tracker.expected = () => 100; tracker.reported = () => 0; tracker.expectCommand = () => {};
  const driven = [];
  const lutron = { setLevel: async () => { driven.push(1); }, setLevelVerified: async () => { driven.push(1); } };
  const eng = new EnforcementEngine({ configStore: { get: () => cfg }, stateStore, tracker, lutron, canAct });
  const events = [];
  eng.on('latched', (e) => events.push({ type: 'latched', ...e }));
  eng.on('corrected', (e) => events.push({ type: 'corrected', ...e }));
  eng.setActiveCluster({ id: 'c1',
    startsAt: new Date(Date.now() - 3600e3).toISOString(),
    endsAt: new Date(Date.now() + 3600e3).toISOString() });
  return { tracker, events, driven };
}

describe('Child Lock drive-authority gate', () => {
  it('an inactive standby never corrects, latches, or drives — even on repeated deviations', () => {
    const { tracker, events, driven } = makeEnforcement(() => false);
    for (let i = 0; i < 5; i++) tracker.emit('deviation', { zone: 3, reported: 0, expected: 100 });
    expect(events).toHaveLength(0);
    expect(driven).toHaveLength(0);
  });

  it('the instance in control still enforces (latches after the override presses)', () => {
    const { tracker, events } = makeEnforcement(() => true);
    for (let i = 0; i < 4; i++) tracker.emit('deviation', { zone: 3, reported: 0, expected: 100 });
    expect(events.some((e) => e.type === 'latched')).toBe(true);
  });
});
