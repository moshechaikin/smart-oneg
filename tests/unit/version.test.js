import { describe, it, expect } from 'vitest';
import { isNewer, VersionChecker } from '../../server/version/VersionChecker.js';

describe('isNewer (semver precedence)', () => {
  it('compares numeric parts', () => {
    expect(isNewer('v1.0.1', 'v1.0.0')).toBe(true);
    expect(isNewer('v1.0.0', 'v1.0.1')).toBe(false);
    expect(isNewer('v1.1.0', 'v1.0.9')).toBe(true);
    expect(isNewer('v2.0.0', 'v1.9.9')).toBe(true);
    expect(isNewer('1.0.0', '1.0.0')).toBe(false);
  });
  it('treats a release as newer than a pre-release, and orders pre-releases', () => {
    expect(isNewer('v1.0.0', 'v1.0.0-rc.1')).toBe(true);
    expect(isNewer('v1.0.0-rc.1', 'v1.0.0')).toBe(false);
    expect(isNewer('v1.0.0-rc.2', 'v1.0.0-rc.1')).toBe(true);
    expect(isNewer('v1.0.0-rc.1', 'v1.0.0-rc.2')).toBe(false);
  });
  it('is safe on garbage input', () => {
    expect(isNewer('garbage', 'v1.0.0')).toBe(false);
    expect(isNewer('v1.0.0', '')).toBe(false);
    expect(isNewer(undefined, null)).toBe(false);
  });
});

describe('VersionChecker', () => {
  const makeState = () => {
    let s = { versionCheck: null };
    return { get: () => s, save: () => {} };
  };

  it('records a newer version from version.json and reports updateAvailable', async () => {
    const vc = new VersionChecker({
      stateStore: makeState(),
      current: 'v1.0.0',
      fetchImpl: async () => ({ ok: true, json: async () => ({ version: '1.2.0', url: 'https://x', notes: 'stuff' }) }),
    });
    const st = await vc.check();
    expect(st.latest).toBe('v1.2.0');
    expect(st.updateAvailable).toBe(true);
    expect(st.url).toBe('https://x');
  });

  it('is offline-safe: a failed fetch just stamps checkedAt and reports no update', async () => {
    const vc = new VersionChecker({
      stateStore: makeState(),
      current: 'v1.0.0',
      fetchImpl: async () => { throw new Error('offline'); },
    });
    const st = await vc.check();
    expect(st.updateAvailable).toBe(false);
    expect(st.checkedAt).toBeTruthy();
  });

  it('does not flag an update when already current or ahead', async () => {
    const vc = new VersionChecker({
      stateStore: makeState(),
      current: 'v1.2.0',
      fetchImpl: async () => ({ ok: true, json: async () => ({ version: '1.2.0' }) }),
    });
    expect((await vc.check()).updateAvailable).toBe(false);
  });

  it('notifies once per new version, not every check', async () => {
    const sent = [];
    const vc = new VersionChecker({
      stateStore: makeState(),
      current: 'v1.0.0',
      notifier: { send: async (event, p) => { sent.push({ event, p }); } },
      fetchImpl: async () => ({ ok: true, json: async () => ({ version: '1.3.0', notes: 'hi', url: 'https://r' }) }),
    });
    await vc.check();
    await vc.check(); // same latest — must NOT re-notify
    expect(sent).toHaveLength(1);
    expect(sent[0].event).toBe('update-available');
    expect(sent[0].p).toMatchObject({ current: 'v1.0.0', latest: 'v1.3.0', notes: 'hi', url: 'https://r' });
  });
});
