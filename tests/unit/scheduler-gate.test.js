import { describe, it, expect } from 'vitest';
import { Scheduler } from '../../server/engine/Scheduler.js';

// An inactive standby's scheduler must OBSERVE only — never drive a light nor
// send a notification. This locks the drive-authority gate (canAct).
const noop = () => {};
function makeScheduler(canAct) {
  const driven = [];
  const sent = [];
  const scheduler = new Scheduler({
    configStore: { get: () => ({ zones: [] }), on: noop },
    stateStore: { get: () => ({}) },
    tracker: { reported: () => 0, expected: () => 0, expectCommand: noop, setExpected: noop },
    enforcement: { isLatched: () => false, scheduledActionExecuted: noop, setActiveCluster: noop },
    lutron: {
      connected: false,
      coerceLevel: (_z, l) => l,
      setLevelVerified: async (z, l) => { driven.push({ z, l }); },
    },
    notifier: { send: async (event, p) => { sent.push({ event, p }); } },
    canAct,
  });
  return { scheduler, driven, sent };
}

describe('scheduler drive-authority gate (canAct)', () => {
  const action = { zone: 3, level: 100, type: 'setLevel', source: { ruleId: 'r1' } };

  it('an inactive standby neither drives nor notifies', async () => {
    const { scheduler, driven, sent } = makeScheduler(() => false);
    await scheduler.executeAction(action);
    expect(driven).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it('a primary / active instance drives normally', async () => {
    const { scheduler, driven } = makeScheduler(() => true);
    await scheduler.executeAction(action);
    expect(driven).toEqual([{ z: 3, l: 100 }]);
  });

  it('a drive failure notifies only when in control', async () => {
    const failing = { get: () => ({ zones: [] }), on: noop };
    const mk = (canAct) => {
      const sent = [];
      const s = new Scheduler({
        configStore: failing,
        stateStore: { get: () => ({}) },
        tracker: { reported: () => 0, expected: () => 0, expectCommand: noop, setExpected: noop },
        enforcement: { isLatched: () => false, scheduledActionExecuted: noop },
        lutron: { connected: true, coerceLevel: (_z, l) => l, setLevelVerified: async () => { throw new Error('bridge down'); } },
        notifier: { send: async (event, p) => { sent.push({ event, p }); } },
        canAct,
      });
      return { s, sent };
    };
    const active = mk(() => true);
    await active.s.executeAction(action);
    expect(active.sent.map((x) => x.event)).toContain('action-failed');

    const standby = mk(() => false);
    await standby.s.executeAction(action);
    expect(standby.sent).toHaveLength(0);
  });
});
