import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MockBridge } from '../../server/lutron/MockBridge.js';
import { LutronClient } from '../../server/lutron/LutronClient.js';
import { ZoneStateTracker } from '../../server/safety/ZoneStateTracker.js';
import { EnforcementEngine } from '../../server/safety/EnforcementEngine.js';
import { Scheduler } from '../../server/engine/Scheduler.js';
import { ConfigStore } from '../../server/config/ConfigStore.js';
import { StateStore } from '../../server/config/StateStore.js';
import { FailoverManager } from '../../server/failover/FailoverManager.js';
import { createApp } from '../../server/app.js';
import { LogRing } from '../../server/logging/logger.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SHARED_TOKEN = 'test-sync-token-1234';

const cleanups = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

async function makeInstance({ role, bridge, primaryUrl = '', pollSeconds = 0.05 }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `fo-${role}-`));
  const configStore = new ConfigStore({ dataDir: dir });
  configStore.load();
  configStore.update({
    instance: { role, name: role },
    zones: [{ id: 3, name: 'Main', area: 'Dining Room', friendlyName: 'Dining', dimmable: true, enforce: false }],
    failover: { primaryUrl, syncToken: SHARED_TOKEN, pollSeconds, failThreshold: 2, recoverThreshold: 2 },
    auth: { passwordHash: 'locked' }, // gate closed: sync must ride the token
    setupComplete: true,
  });
  const stateStore = new StateStore({ dataDir: dir, debounceMs: 10 });
  stateStore.load();
  const lutron = new LutronClient({ host: '127.0.0.1', port: bridge.port, zoneIds: [3], commandTimeoutMs: 500 });
  const tracker = new ZoneStateTracker({ stateStore });
  lutron.on('zoneLevel', (e) => tracker.onZoneLevel(e));
  const enforcement = new EnforcementEngine({ configStore, stateStore, tracker, devices: lutron });
  const scheduler = new Scheduler({ configStore, stateStore, tracker, enforcement, devices: lutron });
  const notifications = [];
  const notifier = { send: async (event, p) => { notifications.push({ event, p }); return {}; } };
  const failover = new FailoverManager({ configStore, stateStore, scheduler, devices: lutron, notifier });
  const app = createApp({
    configStore, stateStore, scheduler, tracker, enforcement, devices: lutron, failover, notifier,
    ring: new LogRing(), logDir: null, logger: null,
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  const inst = { dir, configStore, stateStore, lutron, scheduler, failover, notifier, notifications, app, server, url };
  cleanups.push(async () => {
    failover.stop();
    scheduler.stop();
    lutron.close();
    await new Promise((r) => server.close(r));
    server.closeAllConnections?.();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return inst;
}

describe('failover', () => {
  it('standby mirrors config, takes over when primary dies, releases on recovery', async () => {
    const bridge = new MockBridge();
    await bridge.listen();
    cleanups.push(() => bridge.close());

    const primary = await makeInstance({ role: 'primary', bridge });
    await primary.lutron.connect();
    const standby = await makeInstance({ role: 'standby', bridge, primaryUrl: primary.url });

    // ── config mirroring ────────────────────────────────────────────────
    primary.configStore.update({ times: { havdalahMins: 72 } });
    const synced = new Promise((r) => standby.failover.once('synced', r));
    standby.failover.start();
    await synced;
    expect(standby.configStore.get().times.havdalahMins).toBe(72);
    expect(standby.configStore.get().instance.role).toBe('standby'); // identity preserved
    expect(standby.lutron.connected).toBe(false); // standby stays off the bridge

    // ── primary dies -> takeover ────────────────────────────────────────
    const takeover = new Promise((r) => standby.failover.once('takeover', r));
    await new Promise((r) => primary.server.close(r));
    primary.server.closeAllConnections?.();
    await takeover;
    expect(standby.failover.active).toBe(true);
    expect(standby.lutron.connected).toBe(true);
    expect(standby.notifications.some((n) => n.event === 'takeover')).toBe(true);
    expect(standby.notifications.some((n) => n.event === 'primary-down')).toBe(true);

    // ── primary returns -> release ──────────────────────────────────────
    const server2 = await new Promise((resolve) => {
      const s = primary.app.listen(new URL(primary.url).port, '127.0.0.1', () => resolve(s));
    });
    cleanups.push(async () => { await new Promise((r) => server2.close(r)); server2.closeAllConnections?.(); });
    const release = new Promise((r) => standby.failover.once('release', r));
    await release;
    expect(standby.failover.active).toBe(false);
    expect(standby.lutron.connected).toBe(false);
    expect(standby.notifications.some((n) => n.event === 'release')).toBe(true);
  }, 20000);

  it('primary role never starts the poll loop', async () => {
    const bridge = new MockBridge();
    await bridge.listen();
    cleanups.push(() => bridge.close());
    const primary = await makeInstance({ role: 'primary', bridge });
    primary.failover.start(); // should be a no-op
    await sleep(200);
    expect(primary.failover.active).toBe(false);
    expect(primary.notifications).toHaveLength(0);
  });
});
