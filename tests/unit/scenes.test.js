import { describe, it, expect } from 'vitest';
import { SceneRepository } from '../../server/engine/SceneRepository.js';

const scenes = [
  {
    id: 'mealtime', name: 'Mealtime', extends: null,
    actions: [
      { zone: 3, level: 100 }, { zone: 7, level: 80 },
      { zone: 9, level: 100 }, { zone: 4, level: 100 },
    ],
  },
  {
    id: 'seder', name: 'Seder', extends: 'mealtime',
    overrides: { 7: { level: 100 } },
    add: [{ zone: 2, level: 50 }],
    remove: [9],
  },
  {
    id: 'seder-late', name: 'Late Seder', extends: 'seder',
    overrides: { 2: { level: 30 } },
  },
];

describe('SceneRepository', () => {
  it('resolves a base scene; default end behavior leaves devices as they are', () => {
    const repo = new SceneRepository(scenes);
    const { actions, endActions, explicitEnd } = repo.resolve('mealtime');
    expect(actions).toHaveLength(4);
    expect(endActions).toEqual([]); // leave as is
    expect(explicitEnd).toBe(false);
  });

  it('applies overrides, add, remove through the extends chain', () => {
    const repo = new SceneRepository(scenes);
    const { actions } = repo.resolve('seder');
    expect(actions.find((a) => a.zone === 7).level).toBe(100); // overridden
    expect(actions.find((a) => a.zone === 3).level).toBe(100); // inherited
    expect(actions.find((a) => a.zone === 2).level).toBe(50);  // added
    expect(actions.find((a) => a.zone === 9)).toBeUndefined(); // removed
  });

  it('supports multi-level chains', () => {
    const repo = new SceneRepository(scenes);
    const { actions } = repo.resolve('seder-late');
    expect(actions.find((a) => a.zone === 2).level).toBe(30);
    expect(actions.find((a) => a.zone === 9)).toBeUndefined();
  });

  it('editing the base changes inherited zones but never overridden ones', () => {
    const edited = structuredClone(scenes);
    edited[0].actions.find((a) => a.zone === 3).level = 40; // base change: inherited
    edited[0].actions.find((a) => a.zone === 7).level = 10; // base change: overridden in child
    const repo = new SceneRepository(edited);
    const { actions } = repo.resolve('seder');
    expect(actions.find((a) => a.zone === 3).level).toBe(40);  // follows base
    expect(actions.find((a) => a.zone === 7).level).toBe(100); // immune (override)
  });

  it('respects explicit endActions', () => {
    const repo = new SceneRepository([
      { id: 's', actions: [{ zone: 3, level: 100 }, { zone: 7, level: 80 }], endActions: [{ zone: 3, level: 0 }] },
    ]);
    expect(repo.resolve('s').endActions).toEqual([{ zone: 3, level: 0 }]);
  });

  it('detects cycles and unknown scenes', () => {
    const repo = new SceneRepository([
      { id: 'a', extends: 'b', actions: [] },
      { id: 'b', extends: 'a', actions: [] },
      { id: 'self', extends: 'self', actions: [] },
    ]);
    expect(() => repo.resolve('a')).toThrow(/too deep|extends itself/);
    expect(() => repo.resolve('self')).toThrow(/extends itself/);
    expect(() => repo.resolve('nope')).toThrow(/not found/);
    expect(repo.validateAll().length).toBeGreaterThan(0);
  });
});
