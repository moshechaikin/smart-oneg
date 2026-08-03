import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigStore } from '../../server/config/ConfigStore.js';
import { StateStore } from '../../server/config/StateStore.js';
import { defaultConfig, deepMerge, validateConfig } from '../../server/config/schema.js';

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shabbos-test-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('deepMerge', () => {
  it('merges nested objects and replaces arrays wholesale', () => {
    const base = { a: { b: 1, c: 2 }, list: [1, 2, 3] };
    const out = deepMerge(base, { a: { c: 9 }, list: [4] });
    expect(out).toEqual({ a: { b: 1, c: 9 }, list: [4] });
  });

  it('null replaces, undefined keeps base', () => {
    expect(deepMerge({ a: 1 }, { a: null })).toEqual({ a: null });
    expect(deepMerge({ a: 1 }, {})).toEqual({ a: 1 });
  });
});

describe('validateConfig', () => {
  it('accepts the default config', () => {
    const { valid, errors } = validateConfig(defaultConfig());
    expect(errors).toEqual([]);
    expect(valid).toBe(true);
  });

  it('rejects bad role, missing tz, bad zone ids', () => {
    const cfg = defaultConfig();
    cfg.instance.role = 'boss';
    cfg.location.tzid = '';
    cfg.zones = [{ id: 'three' }];
    const { valid, errors } = validateConfig(cfg);
    expect(valid).toBe(false);
    expect(errors.length).toBeGreaterThanOrEqual(3);
  });

  it('rejects a schemaVersion from the future', () => {
    const cfg = { ...defaultConfig(), schemaVersion: 99 };
    expect(validateConfig(cfg).valid).toBe(false);
  });
});

describe('ConfigStore', () => {
  it('creates defaults when no file exists and persists them', () => {
    const store = new ConfigStore({ dataDir: dir });
    const cfg = store.load();
    expect(cfg.setupComplete).toBe(false);
    expect(fs.existsSync(path.join(dir, 'config.json'))).toBe(true);
    // fresh load returns the same instance id
    const store2 = new ConfigStore({ dataDir: dir });
    expect(store2.load().instance.id).toBe(cfg.instance.id);
  });

  it('update() merges, bumps configVersion, persists atomically', () => {
    const store = new ConfigStore({ dataDir: dir });
    store.load();
    const v0 = store.get().configVersion;
    store.update({ times: { havdalahMins: 72 } });
    expect(store.get().times.havdalahMins).toBe(72);
    expect(store.get().times.candleLightingMins).toBe(18); // untouched sibling
    expect(store.get().configVersion).toBe(v0 + 1);
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    expect(onDisk.times.havdalahMins).toBe(72);
    expect(fs.existsSync(path.join(dir, 'config.json.tmp'))).toBe(false);
  });

  it('rejects structurally invalid updates without mutating current config', () => {
    const store = new ConfigStore({ dataDir: dir });
    store.load();
    expect(() => store.update({ zones: 'not-an-array' })).toThrow();
    expect(Array.isArray(store.get().zones)).toBe(true);
  });

  it('clamps Child Lock bounds instead of rejecting them', () => {
    const store = new ConfigStore({ dataDir: dir });
    store.load();
    store.update({ enforcement: { overridePresses: 1 } });
    expect(store.get().enforcement.overridePresses).toBe(2); // 1 → floor 2
    store.update({ enforcement: { overridePresses: 50 } });
    expect(store.get().enforcement.overridePresses).toBe(10); // 50 → cap 10
    store.update({ enforcement: { graceSeconds: 99 } });
    expect(store.get().enforcement.graceSeconds).toBe(15); // 99 → cap 15s
  });

  it('recovers from a corrupt config.json via the .bak copy', () => {
    const store = new ConfigStore({ dataDir: dir });
    store.load();
    store.update({ instance: { name: 'main-nas' } }); // creates .bak of prior good file
    fs.writeFileSync(path.join(dir, 'config.json'), '{"broken');
    const store2 = new ConfigStore({ dataDir: dir });
    const cfg = store2.load();
    expect(cfg.instance.id).toBeTruthy();
    // recovered file rewritten as good JSON
    expect(() => JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'))).not.toThrow();
  });

  it('import() replaces config but preserves instance identity/role and primaryUrl', () => {
    const store = new ConfigStore({ dataDir: dir });
    store.load();
    store.update({ instance: { role: 'standby' }, failover: { primaryUrl: 'http://nas:8080' } });
    const myId = store.get().instance.id;

    const incoming = defaultConfig();
    incoming.instance = { id: 'other-instance', role: 'primary', name: 'NAS' };
    incoming.times.havdalahMins = 72;
    incoming.zones = [{ id: 3, name: 'Main', area: 'Dining Room', friendlyName: '', dimmable: true, enforce: false }];

    store.import(incoming);
    expect(store.get().times.havdalahMins).toBe(72);
    expect(store.get().zones).toHaveLength(1);
    expect(store.get().instance.id).toBe(myId);
    expect(store.get().instance.role).toBe('standby');
    expect(store.get().failover.primaryUrl).toBe('http://nas:8080');
  });

  it('emits change events on commit', () => {
    const store = new ConfigStore({ dataDir: dir });
    store.load();
    let seen = null;
    store.on('change', (cfg) => { seen = cfg; });
    store.update({ location: { zip: '10952' } });
    expect(seen.location.zip).toBe('10952');
  });
});

describe('StateStore', () => {
  it('persists latches immediately with flush and survives reload', () => {
    const store = new StateStore({ dataDir: dir });
    store.load();
    const z = store.zone(3);
    z.latch = { active: true, level: 0, until: '2025-04-14T20:32:00-04:00' };
    store.save({ flush: true });

    const store2 = new StateStore({ dataDir: dir });
    store2.load();
    expect(store2.zone(3).latch.active).toBe(true);
  });

  it('debounces non-flush saves', async () => {
    const store = new StateStore({ dataDir: dir, debounceMs: 30 });
    store.load();
    store.zone(5).expectedLevel = 100;
    store.save();
    expect(fs.existsSync(path.join(dir, 'state.json'))).toBe(false);
    await new Promise((r) => setTimeout(r, 80));
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).zones['5'].expectedLevel).toBe(100);
  });
});
