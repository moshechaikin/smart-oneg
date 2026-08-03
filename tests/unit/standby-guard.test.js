import { describe, it, expect } from 'vitest';
import { standbyGuard } from '../../server/app.js';

// Minimal req/res/next doubles so we can assert the policy without a live app.
function run(mw, { method, path, body }) {
  const req = { method, path, body };
  let sent = null;
  const res = {
    statusCode: 200,
    status(c) { this.statusCode = c; return this; },
    json(obj) { sent = { status: this.statusCode, body: obj }; return this; },
  };
  let passed = false;
  mw(req, res, () => { passed = true; });
  return { passed, sent };
}

const mkGuard = (role, active) => standbyGuard({
  configStore: { get: () => ({ instance: { role } }) },
  failover: { active },
});

describe('standbyGuard', () => {
  it('lets a primary do anything', () => {
    const g = mkGuard('primary', false);
    expect(run(g, { method: 'PUT', path: '/schedules/shabbos/default', body: {} }).passed).toBe(true);
    expect(run(g, { method: 'POST', path: '/zones/5/command', body: {} }).passed).toBe(true);
  });

  it('lets a standby read (GET) freely', () => {
    const g = mkGuard('standby', false);
    expect(run(g, { method: 'GET', path: '/schedules/shabbos/default' }).passed).toBe(true);
    expect(run(g, { method: 'GET', path: '/settings' }).passed).toBe(true);
  });

  it('blocks content edits on a standby with a readonly 409', () => {
    const g = mkGuard('standby', false);
    for (const path of ['/schedules/shabbos/default', '/scenes', '/scenes/abc', '/zones/5', '/zones/manual', '/rooms/rename', '/guest-mode']) {
      const r = run(g, { method: 'PUT', path, body: {} });
      expect(r.passed, path).toBe(false);
      expect(r.sent.status, path).toBe(409);
      expect(r.sent.body.standby, path).toBe('readonly');
    }
  });

  it('allows editing the standby\'s OWN instance/failover settings only', () => {
    const g = mkGuard('standby', false);
    expect(run(g, { method: 'PUT', path: '/settings', body: { instance: { role: 'primary' }, failover: { primaryUrl: 'x' } } }).passed).toBe(true);
    // a settings edit that touches synced content is rejected
    const r = run(g, { method: 'PUT', path: '/settings', body: { enforcement: { enabled: true } } });
    expect(r.passed).toBe(false);
    expect(r.sent.status).toBe(409);
  });

  it('blocks live control on an INACTIVE standby but allows exiting', () => {
    const g = mkGuard('standby', false);
    expect(run(g, { method: 'POST', path: '/scenes/evening/preview', body: {} }).sent.body.standby).toBe('inactive');
    expect(run(g, { method: 'POST', path: '/test-mode', body: {} }).sent.status).toBe(409);
    expect(run(g, { method: 'POST', path: '/zones/5/command', body: {} }).sent.status).toBe(409);
    // exiting test mode / clearing a latch is always allowed
    expect(run(g, { method: 'DELETE', path: '/test-mode' }).passed).toBe(true);
    expect(run(g, { method: 'DELETE', path: '/latches/5' }).passed).toBe(true);
  });

  it('allows live control on an ACTIVE standby (it took over)', () => {
    const g = mkGuard('standby', true);
    expect(run(g, { method: 'POST', path: '/scenes/evening/preview', body: {} }).passed).toBe(true);
    expect(run(g, { method: 'POST', path: '/zones/5/command', body: {} }).passed).toBe(true);
    // ...but content edits are still frozen even when active (primary owns them)
    expect(run(g, { method: 'PUT', path: '/schedules/shabbos/default', body: {} }).sent.status).toBe(409);
  });

  it('leaves recovery escape-hatches open on a standby', () => {
    const g = mkGuard('standby', false);
    for (const path of ['/system/restart', '/config/import', '/config/reset', '/backups/x/restore', '/push/subscribe']) {
      expect(run(g, { method: 'POST', path, body: {} }).passed, path).toBe(true);
    }
  });
});
