import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigStore } from '../../server/config/ConfigStore.js';
import { StateStore } from '../../server/config/StateStore.js';
import { FailoverManager } from '../../server/failover/FailoverManager.js';

// While an active standby waits out recoverThreshold before formally
// releasing, it used to keep DRIVING every zone alongside the recovered
// primary (~60s at the defaults, on every single recovery). That window is not
// merely redundant: the instance that did NOT issue a command has no pending
// echo for it, so a faded action's intermediate ~OUTPUT levels read as genuine
// wall-switch deviations, and enough of those inside the rolling override
// window falsely latch the zone — which then stops following the schedule for
// the rest of the cluster.
//
// FailoverManager.drivesLights() now separates "taken over" from "driving": an
// active standby stands down from driving on POSITIVE proof the primary is
// back (answering AND reporting its own bridge connected), and resumes the
// instant a poll fails. The tests below pin both halves — especially that
// deferral can never leave nobody driving.
let dir;

afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = null;
});

function makeStandby({ pollSeconds = 0.02, recoverThreshold = 50 } = {}) {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fo-defer-'));
  const configStore = new ConfigStore({ dataDir: dir });
  configStore.load();
  configStore.update({
    instance: { role: 'standby', name: 'standby' },
    zones: [{ id: 3, name: 'Main', area: 'Dining Room', friendlyName: 'Dining', dimmable: true, enforce: false }],
    // recoverThreshold deliberately huge: we're testing the pre-release
    // deferral, so the formal release must not fire and end the test early.
    failover: { primaryUrl: 'http://primary.invalid', syncToken: 'tok', pollSeconds, failThreshold: 1, recoverThreshold },
    setupComplete: true,
  });
  const stateStore = new StateStore({ dataDir: dir, debounceMs: 10 });
  stateStore.load();

  // Health payload the fake primary answers with; tests mutate `reply`.
  // Mirror the real primary, which sends the current `devicesConnected` field
  // plus the legacy `lutronConnected` alias — so we exercise the field the
  // FailoverManager actually reads today, not only the back-compat fallback.
  const reply = { mode: 'down', connected: true };
  const fetchImpl = async () => {
    if (reply.mode === 'down') throw new Error('unreachable');
    return { ok: true, json: async () => ({ status: 'ok', configVersion: 1, devicesConnected: reply.connected, lutronConnected: reply.connected }) };
  };

  const scheduler = { recompile() {}, reconcile: async () => {} };
  const lutron = { connected: false, async connect() { this.connected = true; }, close() { this.connected = false; } };
  const failover = new FailoverManager({
    configStore, stateStore, scheduler, devices: lutron, notifier: { send: async () => ({}) }, fetchImpl,
  });
  // state.failover must exist for #maybeSync's lastSyncedVersion read
  stateStore.get().failover = { ...stateStore.get().failover, lastSyncedVersion: 1 };
  return { failover, reply, lutron, configStore };
}

const tick = (ms = 120) => new Promise((r) => setTimeout(r, ms));

describe('standby stands down from driving before the formal release', () => {
  it('drives while the primary is down, stops driving once it is provably back', async () => {
    const { failover, reply } = makeStandby();
    failover.start();
    await tick(); // failThreshold: 1 -> takes over on the first failed poll

    expect(failover.active).toBe(true);
    expect(failover.drivesLights()).toBe(true); // nobody else is driving — we must

    reply.mode = 'up'; // primary is back, bridge connected
    await tick();

    expect(failover.active).toBe(true); // still armed, release not yet confirmed
    expect(failover.drivesLights()).toBe(false); // ...but no longer driving
    expect(failover.status().deferring).toBe(true);
    failover.stop();
  }, 15_000);

  it('SAFETY: keeps driving if the recovered primary reports its bridge DOWN', async () => {
    const { failover, reply } = makeStandby();
    failover.start();
    await tick();
    expect(failover.drivesLights()).toBe(true);

    // Primary answers HTTP but has no bridge — it cannot actually drive lights,
    // so standing down here would leave the house unattended.
    reply.mode = 'up';
    reply.connected = false;
    await tick();

    expect(failover.drivesLights()).toBe(true);
    expect(failover.status().deferring).toBe(false);
    failover.stop();
  }, 15_000);

  it('SAFETY: takes over when the primary is HTTP-ok but its bridge is DOWN', async () => {
    // The real outage this fixes: a container restart (e.g. a Watchtower auto-
    // update) brings the primary's HTTP back within seconds while it still
    // cannot reach the Lutron bridge. Watching only HTTP liveness, the standby
    // saw status:ok and sat idle forever — house unattended. A primary that
    // reports lutronConnected:false must count toward takeover just like an
    // unreachable one.
    const { failover, reply, lutron } = makeStandby(); // failThreshold: 1
    reply.mode = 'up';
    reply.connected = false; // HTTP up, bridge down from the start
    failover.start();
    await tick();

    expect(failover.active).toBe(true); // stepped in
    expect(failover.drivesLights()).toBe(true);
    expect(lutron.connected).toBe(true); // connected its own bridge
    failover.stop();
  }, 15_000);

  it('SAFETY: a bridge-less primary that recovers its bridge gets a clean release', async () => {
    // Full round trip of the restart case: standby takes over from a bridge-
    // down primary, then hands back cleanly once the primary's bridge returns.
    const { failover, reply, lutron } = makeStandby({ recoverThreshold: 2 });
    reply.mode = 'up';
    reply.connected = false;
    failover.start();
    await tick();
    expect(failover.active).toBe(true);
    expect(lutron.connected).toBe(true);

    reply.connected = true; // primary's bridge comes back
    const released = new Promise((r) => failover.once('release', r));
    await released;
    expect(failover.active).toBe(false);
    expect(lutron.connected).toBe(false); // released our bridge
    failover.stop();
  }, 15_000);

  it('SAFETY: resumes driving the moment contact is lost again mid-stand-down', async () => {
    const { failover, reply } = makeStandby();
    failover.start();
    await tick();
    reply.mode = 'up';
    await tick();
    expect(failover.drivesLights()).toBe(false); // stood down

    reply.mode = 'down'; // primary drops again before the release confirmed
    await tick();

    expect(failover.active).toBe(true);
    expect(failover.drivesLights()).toBe(true); // driving again — no unattended gap
    expect(failover.status().deferring).toBe(false);
    failover.stop();
  }, 15_000);

  it('SAFETY: resumes driving when a still-REACHABLE primary loses its bridge mid-stand-down', async () => {
    // The reachable variant of the recovery exit: the primary keeps answering
    // HTTP ok but reports lutronConnected:false. The failure branch never runs,
    // so if only a failed poll cleared deferral, deferring would stick forever
    // while neither instance drives — the "nobody driving" gap.
    const { failover, reply } = makeStandby();
    failover.start();
    await tick();
    reply.mode = 'up'; // bridge up -> defer
    await tick();
    expect(failover.drivesLights()).toBe(false); // stood down

    reply.connected = false; // primary's bridge drops; HTTP stays up
    await tick();

    expect(failover.active).toBe(true);
    expect(failover.drivesLights()).toBe(true); // resumed — primary can't drive
    expect(failover.status().deferring).toBe(false);

    reply.connected = true; // bridge back -> defer again
    await tick();
    expect(failover.drivesLights()).toBe(false);
    failover.stop();
  }, 15_000);

  it('SAFETY: does not release while the HTTP-ok primary is bridge-less', async () => {
    // Release closes OUR bridge — it must require recoverThreshold consecutive
    // polls of a FULLY capable primary (HTTP ok AND lutronConnected), not just
    // HTTP-ok polls, or the standby drops its working bridge while the primary
    // provably cannot drive.
    const { failover, reply } = makeStandby({ recoverThreshold: 2 });
    failover.start();
    await tick();
    expect(failover.active).toBe(true);

    reply.mode = 'up';
    reply.connected = false; // HTTP ok, bridge down — far past the threshold count
    await tick(400); // many polls at 20ms

    expect(failover.active).toBe(true); // never released
    expect(failover.drivesLights()).toBe(true); // and still driving

    reply.connected = true; // primary fully capable again
    const released = new Promise((r) => failover.once('release', r));
    await released; // releases only once CAPABLE polls reach the threshold
    expect(failover.active).toBe(false);
    failover.stop();
  }, 15_000);

  it('a stood-down standby still holding its bridge does not drive on reconcile', async () => {
    // The hole this guards: standing down keeps the Lutron connection open (so
    // takeover can resume instantly), which breaks the old accidental coupling
    // "no drive authority => no bridge connection". A config mirror from the
    // recovered primary emits 'change' -> recompile -> reconcile, and without
    // an explicit canAct() guard in reconcile()/#childLockCatchup() that would
    // drive every zone right alongside the primary.
    const { Scheduler } = await import('../../server/engine/Scheduler.js');
    const { ZoneStateTracker } = await import('../../server/safety/ZoneStateTracker.js');
    const { EnforcementEngine } = await import('../../server/safety/EnforcementEngine.js');

    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fo-defer-reconcile-'));
    const configStore = new ConfigStore({ dataDir: dir });
    configStore.load();
    configStore.update({
      location: { zip: '10952', lat: 41.1126, lng: -74.0736, city: 'Monsey', state: 'NY', tzid: 'America/New_York', il: false, elevation: 0 },
      zones: [{ id: 3, name: 'Main', area: 'Dining Room', friendlyName: 'Dining', dimmable: true, enforce: true }],
      setupComplete: true,
    });
    const stateStore = new StateStore({ dataDir: dir, debounceMs: 10 });
    stateStore.load();
    const tracker = new ZoneStateTracker({ stateStore });

    const driven = [];
    // connected: true — the stood-down standby still holds its bridge
    const lutron = { connected: true, coerceLevel: (_i, l) => l, async setLevelVerified(id, level) { driven.push({ id, level }); } };

    let driving = true; // stand-in for failover.drivesLights()
    const canAct = () => driving;
    const enforcement = new EnforcementEngine({ configStore, stateStore, tracker, devices: lutron, canAct });
    const scheduler = new Scheduler({ configStore, stateStore, tracker, enforcement, devices: lutron, canAct });
    scheduler.compiled = {
      actions: [],
      allActions: [{ zone: 3, type: 'setLevel', level: 100, at: Date.now() - 60_000 }],
      report: null, conflicts: [], clusters: [],
    };

    await scheduler.reconcile();
    expect(driven).toHaveLength(1); // while driving: reconcile drives, as always

    driving = false; // primary came back; we stood down (but stay connected)
    await scheduler.reconcile();
    expect(driven).toHaveLength(1); // still 1 — no second, competing write

    scheduler.stop();
  }, 15_000);

  it('a full release leaves drivesLights() false and deferring cleared', async () => {
    const { failover, reply } = makeStandby({ recoverThreshold: 2 });
    failover.start();
    await tick();
    expect(failover.active).toBe(true);

    reply.mode = 'up';
    const released = new Promise((r) => failover.once('release', r));
    await released;

    expect(failover.active).toBe(false);
    expect(failover.drivesLights()).toBe(false);
    expect(failover.status().deferring).toBe(false);
    failover.stop();
  }, 15_000);

  it('standbyGuard blocks CONTROL writes on a deferring standby (active but not driving)', async () => {
    // The CONTROL gate must key on DRIVE AUTHORITY, not `active`: a deferring
    // standby still has its bridge connected, so gating on `active` alone lets
    // manual commands / scene preview / test-mode drive the same zones as the
    // recovered primary.
    const { standbyGuard } = await import('../../server/app.js');
    const configStore = { get: () => ({ instance: { role: 'standby' } }) };
    const call = (failover, method, pathName) => new Promise((resolve) => {
      const req = { method, path: pathName, body: {} };
      const res = { status(code) { return { json: (body) => resolve({ code, body }) }; } };
      standbyGuard({ configStore, failover })(req, res, () => resolve({ next: true }));
    });

    // deferring: active, not driving -> 409 with the "primary is back" hint
    const deferring = { active: true, drivesLights: () => false };
    for (const p of ['/test-mode', '/zones/8/command', '/zones/8/flash', '/scenes/abc/preview']) {
      const r = await call(deferring, 'POST', p);
      expect(r.code).toBe(409);
      expect(r.body.standby).toBe('deferring');
    }
    // actively driving -> allowed
    expect(await call({ active: true, drivesLights: () => true }, 'POST', '/test-mode')).toEqual({ next: true });
    // inactive -> still the original inactive message
    const inactive = await call({ active: false, drivesLights: () => false }, 'POST', '/test-mode');
    expect(inactive.code).toBe(409);
    expect(inactive.body.standby).toBe('inactive');
    // DELETE (exit/clear) stays allowed even while deferring
    expect(await call(deferring, 'DELETE', '/test-mode')).toEqual({ next: true });
  }, 15_000);

  it('authority lost MID-flight is honored: reconcile stops mid-loop, a queued action does not fire', async () => {
    // canAct() is re-checked inside every locked per-zone turn, not just up
    // front: a deferral can land while a slow device stalls the loop or while
    // an armed action waits out a same-zone lock — the write must then be
    // withheld, or the standby double-drives alongside the recovered primary.
    const { Scheduler } = await import('../../server/engine/Scheduler.js');
    const { ZoneStateTracker } = await import('../../server/safety/ZoneStateTracker.js');
    const { EnforcementEngine } = await import('../../server/safety/EnforcementEngine.js');

    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fo-defer-midflight-'));
    const configStore = new ConfigStore({ dataDir: dir });
    configStore.load();
    configStore.update({
      location: { zip: '10952', lat: 41.1126, lng: -74.0736, city: 'Monsey', state: 'NY', tzid: 'America/New_York', il: false, elevation: 0 },
      zones: [
        { id: 2, name: 'Slow', area: 'Test', friendlyName: 'Slow', dimmable: true, enforce: false },
        { id: 8, name: 'Basement', area: 'Test', friendlyName: 'Basement', dimmable: true, enforce: false },
      ],
      setupComplete: true,
    });
    const stateStore = new StateStore({ dataDir: dir, debounceMs: 10 });
    stateStore.load();
    const tracker = new ZoneStateTracker({ stateStore });

    let driving = true;
    const driven = [];
    const lutron = {
      connected: true,
      coerceLevel: (_i, l) => l,
      async setLevelVerified(id, level) {
        driven.push({ id, level });
        if (id === 2) {
          driving = false; // deferral lands DURING the slow zone's write
          await new Promise((r) => setTimeout(r, 60));
        }
      },
    };
    const canAct = () => driving;
    const enforcement = new EnforcementEngine({ configStore, stateStore, tracker, devices: lutron, canAct });
    const scheduler = new Scheduler({ configStore, stateStore, tracker, enforcement, devices: lutron, canAct });
    scheduler.compiled = {
      actions: [],
      allActions: [
        { zone: 2, type: 'setLevel', level: 50, at: Date.now() - 60_000 },
        { zone: 8, type: 'setLevel', level: 100, at: Date.now() - 60_000 },
      ],
      report: null, conflicts: [], clusters: [],
    };

    await scheduler.reconcile();
    // zone 2's write started while authority held; zone 8's turn came AFTER
    // the mid-loop deferral and must have been withheld
    expect(driven).toEqual([{ id: 2, level: 50 }]);

    // queued-action variant: an action waits out a held zone lock; authority
    // flips while it waits; the queued turn must not drive
    driving = true;
    let releaseHold;
    const holdDone = scheduler.zoneLock.run(8, () => new Promise((r) => { releaseHold = r; }));
    const fireDone = scheduler.executeAction({ zone: 8, type: 'setLevel', level: 100, fadeSec: 0, source: { ruleId: 't' } });
    await new Promise((r) => setTimeout(r, 20)); // action is now queued behind the hold
    driving = false; // deferral lands while it waits
    releaseHold();
    await Promise.all([holdDone, fireDone]);
    expect(driven).toEqual([{ id: 2, level: 50 }]); // still just the one write

    scheduler.stop();
  }, 15_000);
});
