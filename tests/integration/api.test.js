import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { MockBridge } from '../../server/lutron/MockBridge.js';
import { LutronClient } from '../../server/lutron/LutronClient.js';
import { ZoneStateTracker } from '../../server/safety/ZoneStateTracker.js';
import { EnforcementEngine } from '../../server/safety/EnforcementEngine.js';
import { Scheduler } from '../../server/engine/Scheduler.js';
import { ConfigStore } from '../../server/config/ConfigStore.js';
import { StateStore } from '../../server/config/StateStore.js';
import { createApp } from '../../server/app.js';
import { LogRing } from '../../server/logging/logger.js';

let dir; let bridge; let client; let scheduler; let app; let configStore; let stateStore;

async function boot() {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-'));
  bridge = new MockBridge();
  await bridge.listen();
  configStore = new ConfigStore({ dataDir: dir });
  configStore.load();
  stateStore = new StateStore({ dataDir: dir, debounceMs: 10 });
  stateStore.load();
  client = new LutronClient({ host: '127.0.0.1', port: bridge.port, zoneIds: [3, 9], commandTimeoutMs: 500 });
  const tracker = new ZoneStateTracker({ stateStore });
  client.on('zoneLevel', (e) => tracker.onZoneLevel(e));
  const enforcement = new EnforcementEngine({ configStore, stateStore, tracker, lutron: client });
  scheduler = new Scheduler({ configStore, stateStore, tracker, enforcement, lutron: client });
  app = createApp({
    configStore, stateStore, scheduler, tracker, enforcement,
    lutron: client, failover: null, notifier: { send: async () => ({}) },
    ring: new LogRing(), logDir: null, logger: null,
  });
  await client.connect();
}

afterEach(async () => {
  scheduler?.stop();
  client?.close();
  await bridge?.close();
  fs.rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
});

describe('API', () => {
  beforeEach(boot);

  it('health is public but redacted for anonymous callers; full when authed', async () => {
    // anonymous: alive/role/shabbos only — no away dates, name, version,
    // bridges, or internal URLs (with a tunnel this can be internet-facing)
    configStore.update({ awayMode: { enabled: true, from: '2030-01-01', to: '2030-01-05', label: 'Trip' } });
    const anon = await request(app).get('/api/health').expect(200);
    expect(anon.body).toMatchObject({ status: 'ok', role: 'primary' });
    expect(anon.body.away).toBeUndefined();
    expect(anon.body.version).toBeUndefined();
    expect(anon.body.bridges).toBeUndefined();
    expect(anon.body.instanceId).toBeUndefined();
    expect(JSON.stringify(anon.body)).not.toMatch(/token|password|secret|2030-01/i);

    // authed (session): the full payload
    configStore.update({
      auth: { email: 'h@example.com', passwordHash: (await import('../../server/routes/auth.js')).hashPassword('shabbos-lights!') },
      setupComplete: true,
    });
    const agent = request.agent(app);
    await agent.post('/api/auth/login').send({ email: 'h@example.com', password: 'shabbos-lights!' }).expect(200);
    const full = await agent.get('/api/health').expect(200);
    expect(full.body).toMatchObject({ status: 'ok', role: 'primary', lutronConnected: true });
    expect(full.body.away).toMatchObject({ from: '2030-01-01', to: '2030-01-05' });
    expect(JSON.stringify(full.body)).not.toMatch(/password|secret/i);

    // sync token also unlocks the full payload (the standby's poll)
    const tok = configStore.get().failover.syncToken;
    const viaToken = await request(app).get('/api/health').set('Authorization', `Bearer ${tok}`).expect(200);
    expect(viaToken.body.away).toMatchObject({ from: '2030-01-01' });
  });

  it('oneg status endpoint: unauthenticated boolean for guarding automations', async () => {
    // no active cluster right now -> active:false, plenty of nulls, live clock
    const off = await request(app).get('/api/oneg').expect(200);
    expect(off.body.active).toBe(false);
    expect(off.body).toMatchObject({ label: null, startsAt: null, endsAt: null });
    expect(off.body.now).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(off.headers['cache-control']).toBe('no-store');

    // stub an active cluster (as the scheduler would report mid-Shabbos)
    const cluster = { id: 'cluster-x', label: 'Shabbos', startsAt: new Date('2030-01-04T22:00:00Z'), endsAt: new Date('2030-01-05T23:00:00Z') };
    const orig = scheduler.activeCluster;
    scheduler.activeCluster = () => cluster;
    try {
      const on = await request(app).get('/api/oneg').expect(200);
      expect(on.body).toMatchObject({ active: true, label: 'Shabbos' });
      expect(on.body.startsAt).toBe(cluster.startsAt.toISOString());
    } finally {
      scheduler.activeCluster = orig;
    }
  });

  it('wizard flow: open during setup, locked down after password is set', async () => {
    // during setup: settings accessible without auth
    await request(app).get('/api/settings').expect(200);

    await request(app).put('/api/settings').send({
      location: { zip: '10952', lat: 41.1126, lng: -74.0176, city: 'Monsey', state: 'NY', tzid: 'America/New_York' },
      auth: { email: 'me@example.com', password: 'shabbos-lights!' },
      setupComplete: true,
    }).expect(200);

    // gate is now closed
    await request(app).get('/api/settings').expect(401);

    // login works and grants a session
    const agent = request.agent(app);
    await agent.post('/api/auth/login').send({ email: 'wrong@x.com', password: 'nope' }).expect(401);
    await agent.post('/api/auth/login').send({ email: 'me@example.com', password: 'shabbos-lights!' }).expect(200);
    const settings = await agent.get('/api/settings').expect(200);
    // secrets are masked, never round-tripped
    expect(settings.body.auth.passwordHash).toBe('__SET__');
    expect(settings.body.failover.syncToken).toBe('__SET__');

    // PUTting the sanitized object back must not clobber secrets
    await agent.put('/api/settings').send(settings.body).expect(200);
    const auth2 = configStore.get().auth;
    expect(auth2.passwordHash).not.toBe('__SET__');
    await agent.post('/api/auth/logout').expect(200);
    await agent.get('/api/settings').expect(401);
  });

  it('login rate limit holds even when X-Forwarded-For is spoofed per request', async () => {
    await request(app).put('/api/settings').send({
      location: { zip: '10952', lat: 41.1126, lng: -74.0176, city: 'Monsey', state: 'NY', tzid: 'America/New_York' },
      auth: { email: 'me@example.com', password: 'shabbos-lights!' },
      setupComplete: true,
    }).expect(200);

    // 5 failures, each pretending to be a different client via XFF — the
    // limiter must key on the real TCP peer, not the spoofable header
    for (let i = 0; i < 5; i++) {
      await request(app).post('/api/auth/login')
        .set('X-Forwarded-For', `10.0.0.${i + 1}`)
        .send({ email: 'me@example.com', password: 'wrong' }).expect(401);
    }
    await request(app).post('/api/auth/login')
      .set('X-Forwarded-For', '10.0.0.99')
      .send({ email: 'me@example.com', password: 'wrong' }).expect(429);

    // even the RIGHT password is throttled while the window is hot...
    await request(app).post('/api/auth/login')
      .send({ email: 'me@example.com', password: 'shabbos-lights!' }).expect(429);
  });

  it('sync token grants API access for the standby instance', async () => {
    configStore.update({ auth: { passwordHash: 'x' }, setupComplete: true });
    const token = configStore.get().failover.syncToken;
    await request(app).get('/api/sync/export').expect(401);
    const res = await request(app).get('/api/sync/export')
      .set('Authorization', `Bearer ${token}`).expect(200);
    expect(res.body.failover.syncToken).toBe(token); // full config, this IS the mirror
  });

  it('imports the real Lutron integration report and merges user fields', async () => {
    const report = JSON.parse(fs.readFileSync(new URL('../../resources/lutron-integration-report.json', import.meta.url), 'utf8'));
    const res = await request(app).post('/api/zones/import').send(report).expect(200);
    expect(res.body).toHaveLength(9);

    await request(app).patch('/api/zones/3').send({ friendlyName: 'Dining Main', enforce: true, dimmable: false }).expect(200);
    // a non-Lutron device must survive a re-import (it's never in the report)
    await request(app).post('/api/zones/manual')
      .send({ name: 'House alarm', source: 'envisalink', externalId: 'partition:1', kind: 'alarm' }).expect(201);
    // re-import: user fields preserved (dimmable + Child Lock were once clobbered)
    const res2 = await request(app).post('/api/zones/import').send(report).expect(200);
    expect(res2.body.find((z) => z.id === 3)).toMatchObject({ friendlyName: 'Dining Main', enforce: true, dimmable: false });
    expect(res2.body.some((z) => z.source === 'envisalink')).toBe(true);
  });

  it('re-import remaps a renumbered zone and rewrites the rules/scenes that used it', async () => {
    const report = JSON.parse(fs.readFileSync(new URL('../../resources/lutron-integration-report.json', import.meta.url), 'utf8'));
    await request(app).post('/api/zones/import').send(report).expect(200);
    await request(app).patch('/api/zones/3').send({ friendlyName: 'Dining Main', enforce: true, dimmable: false }).expect(200);
    await request(app).post('/api/scenes').send({ id: 'meal', name: 'Meal', actions: [{ zone: 3, level: 100 }] }).expect(201);
    await request(app).put('/api/schedules/shabbos/default').send({
      rules: [{ label: 'on', action: { type: 'setLevel', zone: 3, level: 100 }, trigger: { kind: 'fixed', time: '12:00' } }],
    }).expect(200);

    // the bridge renumbered zone 3 -> 33 (same name + area)
    const renumbered = structuredClone(report);
    renumbered.LIPIdList.Zones.find((z) => z.ID === 3).ID = 33;
    const res = await request(app).post('/api/zones/import').send(renumbered).expect(200);

    expect(res.body.find((z) => z.id === 33)).toMatchObject({ friendlyName: 'Dining Main', enforce: true, dimmable: false });
    expect(res.body.some((z) => z.id === 3)).toBe(false);
    const cfg = configStore.get();
    expect(cfg.schedules.shabbos.default.rules[0].action.zone).toBe(33);
    expect(cfg.scenes.find((s) => s.id === 'meal').actions[0].zone).toBe(33);
  });

  it('validates scenes (rejects broken extends) and schedules (rejects impossible variants)', async () => {
    await request(app).post('/api/scenes').send({ id: 'meal', name: 'Meal', actions: [{ zone: 3, level: 100 }] }).expect(201);
    await request(app).post('/api/scenes').send({ id: 'bad', extends: 'nope', actions: [] }).expect(400);

    await request(app).put('/api/schedules/shabbos/default').send({
      rules: [{ label: 'on', action: { type: 'setLevel', zone: 3, level: 100 }, trigger: { kind: 'fixed', time: '12:00' } }],
    }).expect(200);
    await request(app).put('/api/schedules/yom-kippur/erev-is-shabbos').send({ rules: [] }).expect(400); // impossible per calendar
    await request(app).put('/api/schedules/nonsense/default').send({ rules: [] }).expect(400);

    const meta = await request(app).get('/api/schedules/meta').expect(200);
    expect(meta.body.variants['pesach-1']).toContain('erev-is-shabbos');
  });

  it('timeline dry-run answers "what would happen on Pesach 2025"', async () => {
    await request(app).put('/api/settings').send({
      location: { zip: '10952', lat: 41.1126, lng: -74.0176, city: 'Monsey', state: 'NY', tzid: 'America/New_York' },
    }).expect(200);
    await request(app).put('/api/schedules/shabbos/erev-pesach').send({
      rules: [{ label: 'dining on', action: { type: 'setLevel', zone: 3, level: 100 }, trigger: { kind: 'fixed', time: '12:00' } }],
    }).expect(200);

    const res = await request(app).get('/api/timeline?date=2025-04-12').expect(200);
    expect(res.body.clusters[0].days.map((d) => d.variant)).toEqual(['erev-pesach', 'erev-is-shabbos', 'default']);
    expect(res.body.actions.some((a) => a.zone === 3 && a.level === 100)).toBe(true);
    const cal = await request(app).get('/api/calendar?from=2025-04-01&to=2025-04-30').expect(200);
    expect(cal.body.length).toBeGreaterThanOrEqual(4); // shabbosim + 2 YT clusters
  });

  it('manual command during an active cluster demands explicit confirmation', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2025-04-12T18:00:00Z')); // mid-Shabbos-Erev-Pesach
    configStore.update({
      location: { zip: '10952', lat: 41.1126, lng: -74.0176, city: 'Monsey', state: 'NY', tzid: 'America/New_York' },
      zones: [{ id: 3, name: 'Main', area: 'Dining Room', friendlyName: 'Dining', dimmable: true, enforce: false }],
      schedules: { shabbos: { 'erev-pesach': { rules: [
        { id: 'r1', action: { type: 'setLevel', zone: 3, level: 100 }, trigger: { kind: 'fixed', time: '12:00' } },
      ] } } },
    });
    scheduler.recompile();

    const denied = await request(app).post('/api/zones/3/command').send({ level: 0 }).expect(409);
    expect(denied.body.activeCluster.id).toBe('cluster-2025-04-12');
    await request(app).post('/api/zones/3/command').send({ level: 0, confirm: true }).expect(200);
    expect(bridge.levels.get(3)).toBe(0);
  });

  it('serves logs search endpoint', async () => {
    await request(app).get('/api/logs?q=nothing').expect(200);
  });

  it('detaching a variant from Regular clears inheritsRegular and removedIds (deep-merge regression)', async () => {
    // set up a special variant that starts from Regular and disables one rule
    await request(app).put('/api/schedules/shabbos/chol-hamoed-pesach').send({
      rules: [{ id: 'own1', action: { type: 'setLevel', zone: 3, level: 50 }, trigger: { kind: 'fixed', time: '19:00' } }],
      inheritsRegular: true,
      removedIds: ['reg-a', 'reg-b'],
    }).expect(200);
    let cfg = configStore.get();
    expect(cfg.schedules.shabbos['chol-hamoed-pesach']).toMatchObject({ inheritsRegular: true, removedIds: ['reg-a', 'reg-b'] });

    // "Start empty": no rules, not inheriting, no removedIds. Before the fix the
    // deep-merge kept the old inheritsRegular:true + removedIds, reviving the setup.
    const res = await request(app).put('/api/schedules/shabbos/chol-hamoed-pesach').send({
      rules: [], inheritsRegular: false, removedIds: [],
    }).expect(200);
    expect(res.body).toMatchObject({ rules: [], inheritsRegular: false, removedIds: [] });
    cfg = configStore.get();
    expect(cfg.schedules.shabbos['chol-hamoed-pesach'].inheritsRegular).toBe(false);
    expect(cfg.schedules.shabbos['chol-hamoed-pesach'].removedIds).toEqual([]);
    expect(cfg.schedules.shabbos['chol-hamoed-pesach'].rules).toEqual([]);
  });

  it('draft timeline preview compiles unsaved rules without persisting', async () => {
    await request(app).put('/api/settings').send({
      location: { zip: '10952', lat: 41.1126, lng: -74.0176, city: 'Monsey', state: 'NY', tzid: 'America/New_York' },
      zones: [{ id: 7, name: 'Main', area: 'Dining', friendlyName: 'Dining', dimmable: true, enforce: false }],
    }).expect(200);

    // a draft rule that isn't saved anywhere should still appear in the preview
    const preview = await request(app).post('/api/timeline/preview').send({
      date: '2025-04-12', // Erev Pesach Shabbos cluster
      draft: {
        dayType: 'shabbos', variant: 'erev-pesach',
        rules: [{ id: 'draft1', action: { type: 'setLevel', zone: 7, level: 100 }, trigger: { kind: 'fixed', time: '12:00' } }],
        inheritsRegular: false, removedIds: [],
      },
    }).expect(200);
    expect(preview.body.actions.some((a) => a.zone === 7 && a.level === 100)).toBe(true);

    // the draft was NOT written to config, and the saved-config GET doesn't see it
    expect(configStore.get().schedules.shabbos?.['erev-pesach']?.rules ?? []).toEqual([]);
    const saved = await request(app).get('/api/timeline?date=2025-04-12').expect(200);
    expect(saved.body.actions.some((a) => a.zone === 7 && a.level === 100)).toBe(false);

    // an EMPTY, non-inheriting special variant cascades to Regular: the report
    // flags it (drives the editor's "runs the Regular schedule" note) and the
    // Regular rules show in the compiled actions.
    await request(app).put('/api/schedules/shabbos/default').send({
      rules: [{ id: 'reg1', action: { type: 'setLevel', zone: 7, level: 42 }, trigger: { kind: 'fixed', time: '12:00' } }],
    }).expect(200);
    const cascade = await request(app).post('/api/timeline/preview').send({
      date: '2025-04-12',
      draft: { dayType: 'shabbos', variant: 'erev-pesach', rules: [], inheritsRegular: false, removedIds: [] },
    }).expect(200);
    expect(cascade.body.report.unconfiguredVariants.some((u) => u.dayType === 'shabbos' && u.variant === 'erev-pesach')).toBe(true);
    expect(cascade.body.actions.some((a) => a.zone === 7 && a.level === 42)).toBe(true);
  });
});
