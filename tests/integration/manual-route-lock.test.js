import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { lightingRouter } from '../../server/routes/lighting.js';
import { ZoneLock } from '../../server/engine/ZoneLock.js';
import { ZoneStateTracker } from '../../server/safety/ZoneStateTracker.js';
import { ConfigStore } from '../../server/config/ConfigStore.js';
import { StateStore } from '../../server/config/StateStore.js';

// The manual-control routes (/zones/:id/command, /zones/:id/flash) are zone
// writers like any scheduler/enforcement path, so they must serialize on the
// SAME shared per-zone lock (scheduler.zoneLock). Unserialized, a manual
// command races an in-flight reconcile/fired-action/correction for the same
// zone and whichever device write settles last wins — even if stale.
let dir;

afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = null;
});

function build() {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-lock-'));
  const configStore = new ConfigStore({ dataDir: dir });
  configStore.load();
  configStore.update({
    location: { zip: '10952', lat: 41.1126, lng: -74.0736, city: 'Monsey', state: 'NY', tzid: 'America/New_York', il: false, elevation: 0 },
    zones: [{ id: 8, name: 'Basement', area: 'Test', friendlyName: 'Basement', dimmable: true, enforce: false }],
    setupComplete: true,
  });
  const stateStore = new StateStore({ dataDir: dir, debounceMs: 10 });
  stateStore.load();
  const tracker = new ZoneStateTracker({ stateStore });

  const order = [];
  const lutron = {
    connected: true,
    coerceLevel: (_id, lvl) => lvl,
    async setLevelVerified(id, level) { order.push({ kind: 'set', id, level }); },
    async flash(id, times, restore) { order.push({ kind: 'flash', id, times, restore }); },
  };
  const zoneLock = new ZoneLock();
  // scheduler stub carrying the shared lock, exactly the surface the router uses
  const scheduler = { zoneLock, activeCluster: () => null };

  const app = express();
  app.use(express.json());
  app.use('/api', lightingRouter({ configStore, stateStore, scheduler, tracker, enforcement: {}, devices: lutron, logger: null }));
  return { app, zoneLock, order, tracker };
}

describe('manual control routes serialize on the shared zone lock', () => {
  it('a manual command queues behind a lock-held same-zone write instead of racing it', async () => {
    const { app, zoneLock, order } = build();

    // A scheduler-side write holds zone 8's lock (e.g. a slow reconcile turn).
    let releaseHold;
    const holdDone = zoneLock.run(8, async () => {
      await new Promise((r) => { releaseHold = r; });
      order.push({ kind: 'held-write-settled' });
    });

    const post = request(app).post('/api/zones/8/command').send({ level: 100 });
    const responseArrived = post.then((res) => res); // start the request
    await new Promise((r) => setTimeout(r, 40)); // manual write is now queued
    expect(order.some((e) => e.kind === 'set')).toBe(false); // ...not racing

    releaseHold();
    const res = await responseArrived;
    await holdDone;

    expect(res.status).toBe(200);
    const settledIdx = order.findIndex((e) => e.kind === 'held-write-settled');
    const setIdx = order.findIndex((e) => e.kind === 'set');
    expect(setIdx).toBeGreaterThan(settledIdx); // manual write ran only after the held turn
    expect(order[setIdx]).toEqual({ kind: 'set', id: 8, level: 100 });
  }, 15_000);

  it('a manual flash reads its restore level inside its lock turn (after the queued write)', async () => {
    const { app, zoneLock, order, tracker } = build();

    // Queue order on zone 8: [slow write that changes the level] -> [flash].
    // The flash must restore to the level as of ITS turn (60), not the level
    // captured when the request arrived (0).
    let releaseHold;
    const holdDone = zoneLock.run(8, async () => {
      await new Promise((r) => { releaseHold = r; });
      tracker.onZoneLevel({ id: 8, level: 60 }); // the held write's echo lands
      order.push({ kind: 'held-write-settled' });
    });

    const post = request(app).post('/api/zones/8/flash').send({ times: 1 });
    const responseArrived = post.then((res) => res);
    await new Promise((r) => setTimeout(r, 40));
    expect(order.some((e) => e.kind === 'flash')).toBe(false); // queued, not racing

    releaseHold();
    const res = await responseArrived;
    await holdDone;

    expect(res.status).toBe(200);
    const flash = order.find((e) => e.kind === 'flash');
    expect(flash).toBeDefined();
    expect(flash.restore).toBe(60); // read at its turn, not at request arrival
  }, 15_000);
});
