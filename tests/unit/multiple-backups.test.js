import { describe, it, expect } from 'vitest';
import { FailoverManager } from '../../server/failover/FailoverManager.js';

// Primary-side guard: the primary counts DISTINCT backups checking in (by
// instance id) so the UI can warn when more than one standby is running — they
// have no coordination and would fight over the bridge.
function primaryFO({ pollSeconds = 10 } = {}) {
  const configStore = { get: () => ({ instance: { role: 'primary', id: 'p1' }, failover: { pollSeconds } }) };
  return new FailoverManager({ configStore, stateStore: {}, scheduler: {}, devices: {}, notifier: {} });
}

describe('multiple-backups guard', () => {
  it('none / one backup is fine, two distinct is flagged', () => {
    const fo = primaryFO();
    expect(fo.status()).toMatchObject({ role: 'primary', backupCount: 0, multipleBackups: false });
    fo.noteBackupContact('backup-a');
    expect(fo.status()).toMatchObject({ backupCount: 1, multipleBackups: false });
    fo.noteBackupContact('backup-b');
    expect(fo.status()).toMatchObject({ backupCount: 2, multipleBackups: true });
  });

  it('the same backup polling repeatedly counts once', () => {
    const fo = primaryFO();
    fo.noteBackupContact('backup-a');
    fo.noteBackupContact('backup-a');
    fo.noteBackupContact('backup-a');
    expect(fo.status()).toMatchObject({ backupCount: 1, multipleBackups: false });
  });

  it('still feeds the silent-backup alert (backupSeen / backupLastSeenAt)', () => {
    const fo = primaryFO();
    expect(fo.backupSeen).toBe(false);
    expect(fo.backupLastSeenAt).toBe(null);
    const before = Date.now();
    fo.noteBackupContact('backup-a');
    expect(fo.backupSeen).toBe(true);
    expect(fo.backupLastSeenAt).toBeGreaterThanOrEqual(before);
  });
});
