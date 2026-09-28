import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { ConfigStore } from '../../server/config/ConfigStore.js';
import { StateStore } from '../../server/config/StateStore.js';
import { DeviceBus } from '../../server/devices/DeviceBus.js';
import { WebhookProvider } from '../../server/devices/WebhookProvider.js';
import { VirtualProvider } from '../../server/devices/VirtualProvider.js';
import { ZoneStateTracker } from '../../server/safety/ZoneStateTracker.js';
import { EnforcementEngine } from '../../server/safety/EnforcementEngine.js';
import { Scheduler } from '../../server/engine/Scheduler.js';
import { TimelineCompiler } from '../../server/engine/TimelineCompiler.js';
import { SceneRepository } from '../../server/engine/SceneRepository.js';
import { CalendarService } from '../../server/calendar/CalendarService.js';
import { createApp } from '../../server/app.js';
import { LogRing } from '../../server/logging/logger.js';
import { isMomentary } from '../../server/engine/zoneKinds.js';

/**
 * Webhook devices: an outbound HTTP call modelled as a device holding NAMED
 * CALLS, picked by a rule or scene member the way a thermostat preset is.
 *
 * The properties that matter, and why:
 *  - AT MOST ONCE. The app cannot read the remote system, so it can never know
 *    whether a resync is warranted. A reconcile, boot catch-up, takeover,
 *    config save, test-mode exit or scene preview must NEVER fire one.
 *  - Never enforced. Child Lock holds levels; a webhook has none.
 *  - Fails loudly and locally. A bad URL or a deleted call must be rejected on
 *    save or surface as a failed action — never silently hit a different
 *    endpoint.
 */

/** Recording HTTP target: every request it receives, plus scripted responses. */
function mockTarget() {
  const hits = [];
  let status = 200;
  let delayMs = 0;
  let body = '{"ok":true}';
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      hits.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString(),
      });
      const send = () => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(body); };
      if (delayMs) setTimeout(send, delayMs); else send();
    });
  });
  return {
    hits, server,
    setStatus: (s) => { status = s; },
    setDelay: (ms) => { delayMs = ms; },
    setBody: (b) => { body = b; },
    async listen() { await new Promise((r) => server.listen(0, '127.0.0.1', r)); return server.address().port; },
    close: () => new Promise((r) => server.close(r)),
  };
}

let dir; let target; let port; let configStore; let stateStore; let bus; let provider;

const webhookZone = (over = {}) => ({
  id: 500, source: 'webhook', externalId: 500, kind: 'webhook',
  name: 'Sukkah Heater', friendlyName: 'Sukkah Heater', area: 'Webhooks',
  dimmable: false, enforce: false,
  webhook: {
    timeoutMs: 3000,
    auth: { kind: 'none' },
    headers: [],
    calls: [
      { id: 'start', name: 'Start heater', method: 'POST', url: `http://127.0.0.1:${port}/start`, contentType: 'application/json', body: '{"on":true}', headers: [] },
      { id: 'stop', name: 'Stop heater', method: 'POST', url: `http://127.0.0.1:${port}/stop`, contentType: 'application/json', body: '{"on":false}', headers: [] },
    ],
    ...over,
  },
});

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webhook-'));
  target = mockTarget();
  port = await target.listen();
  configStore = new ConfigStore({ dataDir: dir });
  configStore.load();
  stateStore = new StateStore({ dataDir: dir, debounceMs: 10 });
  stateStore.load();
  provider = new WebhookProvider({ configStore });
  bus = new DeviceBus({ configStore });
  bus.register('webhook', provider);
  bus.register('virtual', new VirtualProvider());
});

afterEach(async () => {
  await target.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── config validation ──────────────────────────────────────────────────────

describe('webhook device config validation', () => {
  const save = (zone) => configStore.update({ zones: [zone] });

  it('accepts a well-formed webhook device', () => {
    expect(() => save(webhookZone())).not.toThrow();
    expect(configStore.get().zones[0].webhook.calls).toHaveLength(2);
  });

  it('rejects a call with no URL', () => {
    const z = webhookZone();
    z.webhook.calls[0].url = '';
    expect(() => save(z)).toThrow(/valid http\(s\) URL/);
  });

  it('rejects a non-http scheme (no file:// reads)', () => {
    for (const url of ['file:///etc/passwd', 'ftp://x/y', 'javascript:alert(1)']) {
      const z = webhookZone();
      z.webhook.calls[0].url = url;
      expect(() => save(z)).toThrow(/valid http\(s\) URL/);
    }
  });

  it('rejects an unsupported method', () => {
    const z = webhookZone();
    z.webhook.calls[0].method = 'TRACE';
    expect(() => save(z)).toThrow(/unsupported method/);
  });

  it('rejects duplicate call ids', () => {
    const z = webhookZone();
    z.webhook.calls[1].id = 'start';
    expect(() => save(z)).toThrow(/duplicate webhook call id/);
  });

  it('rejects a call with no name', () => {
    const z = webhookZone();
    z.webhook.calls[0].name = '  ';
    expect(() => save(z)).toThrow(/needs a name/);
  });

  it('rejects a device with no calls at all', () => {
    const z = webhookZone();
    z.webhook.calls = [];
    expect(() => save(z)).toThrow(/at least one webhook call/);
  });

  it('rejects an out-of-range timeout', () => {
    for (const t of [10, 999, 60001]) {
      const z = webhookZone({ timeoutMs: t });
      expect(() => save(z)).toThrow(/timeoutMs must be 1000-60000/);
    }
  });

  it('requires the credential each auth kind actually uses', () => {
    expect(() => save(webhookZone({ auth: { kind: 'bearer' } }))).toThrow(/bearer auth needs a token/);
    expect(() => save(webhookZone({ auth: { kind: 'basic' } }))).toThrow(/basic auth needs a username/);
    expect(() => save(webhookZone({ auth: { kind: 'header' } }))).toThrow(/header auth needs a header name/);
    expect(() => save(webhookZone({ auth: { kind: 'nonsense' } }))).toThrow(/auth.kind must be/);
  });

  it('rejects source/kind that disagree', () => {
    const z = { ...webhookZone(), kind: undefined };
    expect(() => save(z)).toThrow(/source "webhook" and kind "webhook"/);
  });
});

// ── request building ───────────────────────────────────────────────────────

describe('webhook request building', () => {
  it('sends method, body and content type as configured', async () => {
    configStore.update({ zones: [webhookZone()] });
    await bus.callWebhook(500, 'start');
    expect(target.hits).toHaveLength(1);
    expect(target.hits[0].method).toBe('POST');
    expect(target.hits[0].url).toBe('/start');
    expect(target.hits[0].body).toBe('{"on":true}');
    expect(target.hits[0].headers['content-type']).toBe('application/json');
  });

  it('picks the right call — never a default or the first one', async () => {
    configStore.update({ zones: [webhookZone()] });
    await bus.callWebhook(500, 'stop');
    expect(target.hits[0].url).toBe('/stop');
    expect(target.hits[0].body).toBe('{"on":false}');
  });

  it('a GET carries no body', async () => {
    const z = webhookZone();
    z.webhook.calls[0].method = 'GET';
    configStore.update({ zones: [z] });
    await bus.callWebhook(500, 'start');
    expect(target.hits[0].method).toBe('GET');
    expect(target.hits[0].body).toBe('');
    expect(target.hits[0].headers['content-type']).toBeUndefined();
  });

  it('applies bearer auth', async () => {
    configStore.update({ zones: [webhookZone({ auth: { kind: 'bearer', token: 'sekret' } })] });
    await bus.callWebhook(500, 'start');
    expect(target.hits[0].headers.authorization).toBe('Bearer sekret');
  });

  it('applies basic auth', async () => {
    configStore.update({ zones: [webhookZone({ auth: { kind: 'basic', username: 'u', password: 'p' } })] });
    await bus.callWebhook(500, 'start');
    expect(target.hits[0].headers.authorization).toBe(`Basic ${Buffer.from('u:p').toString('base64')}`);
  });

  it('applies a custom auth header', async () => {
    configStore.update({ zones: [webhookZone({ auth: { kind: 'header', headerName: 'X-Api-Key', headerValue: 'abc123' } })] });
    await bus.callWebhook(500, 'start');
    expect(target.hits[0].headers['x-api-key']).toBe('abc123');
  });

  it('merges device headers with per-call headers, call wins', async () => {
    const z = webhookZone({ headers: [{ name: 'X-Shared', value: 'device' }, { name: 'X-Both', value: 'device' }] });
    z.webhook.calls[0].headers = [{ name: 'X-Both', value: 'call' }];
    configStore.update({ zones: [z] });
    await bus.callWebhook(500, 'start');
    expect(target.hits[0].headers['x-shared']).toBe('device');
    expect(target.hits[0].headers['x-both']).toBe('call');
  });
});

// ── failure behavior ───────────────────────────────────────────────────────

describe('webhook failures are loud and local', () => {
  it('a non-2xx response rejects with the status', async () => {
    configStore.update({ zones: [webhookZone()] });
    target.setStatus(500);
    await expect(bus.callWebhook(500, 'start')).rejects.toThrow(/HTTP 500/);
  });

  it('a hung request times out rather than holding the zone lock forever', async () => {
    configStore.update({ zones: [webhookZone({ timeoutMs: 1000 })] });
    target.setDelay(5000);
    const t0 = Date.now();
    await expect(bus.callWebhook(500, 'start')).rejects.toThrow(/timed out/);
    expect(Date.now() - t0).toBeLessThan(3000);
  }, 20_000);

  it('an unknown call id rejects instead of firing something else', async () => {
    configStore.update({ zones: [webhookZone()] });
    await expect(bus.callWebhook(500, 'deleted-call')).rejects.toThrow(/not found/);
    expect(target.hits).toHaveLength(0);
  });

  it('driving a webhook by level is refused', async () => {
    configStore.update({ zones: [webhookZone()] });
    await expect(bus.setLevel(500, 100)).rejects.toThrow(/named calls, not levels/);
    expect(target.hits).toHaveLength(0);
  });

  it('callWebhook on a non-webhook zone is refused', async () => {
    configStore.update({
      zones: [webhookZone(), { id: 7, source: 'virtual', externalId: 7, name: 'L', area: 'A', friendlyName: 'L', dimmable: true, enforce: false }],
    });
    await expect(bus.callWebhook(7, 'start')).rejects.toThrow(/not a webhook device/);
  });
});

// ── momentary semantics: the safety core ───────────────────────────────────

describe('webhooks are momentary — never fired twice', () => {
  let tracker; let enforcement; let scheduler;

  const boot = () => {
    configStore.update({
      location: { zip: '10952', lat: 41.1126, lng: -74.0736, city: 'Monsey', state: 'NY', tzid: 'America/New_York', il: false, elevation: 0 },
      enforcement: { enabled: true, graceSeconds: 0.05, overridePresses: 2, overrideWindowSeconds: 30 },
      zones: [webhookZone(), { id: 7, source: 'virtual', externalId: 7, name: 'L', area: 'A', friendlyName: 'L', dimmable: true, enforce: true }],
      setupComplete: true,
    });
    tracker = new ZoneStateTracker({ stateStore });
    enforcement = new EnforcementEngine({ configStore, stateStore, tracker, devices: bus });
    scheduler = new Scheduler({ configStore, stateStore, tracker, enforcement, devices: bus });
    return scheduler;
  };

  afterEach(() => scheduler?.stop());

  it('the zone kind is classified momentary', () => {
    expect(isMomentary(webhookZone())).toBe(true);
    expect(isMomentary({ kind: 'automation' })).toBe(true);
    expect(isMomentary({ kind: undefined })).toBe(false);
    expect(isMomentary({ kind: 'thermostat' })).toBe(false);
  });

  it('executing the action fires exactly one request', async () => {
    boot();
    await scheduler.executeAction({ type: 'callWebhook', zone: 500, callId: 'start', source: { ruleId: 'r1' } });
    expect(target.hits).toHaveLength(1);
  });

  it('reconcile never fires it', async () => {
    boot();
    await scheduler.executeAction({ type: 'callWebhook', zone: 500, callId: 'start', source: { ruleId: 'r1' } });
    target.hits.length = 0;
    await scheduler.reconcile();
    await scheduler.reconcile();
    expect(target.hits).toHaveLength(0);
  });

  it('it never gets an expected level, so Child Lock can never chase it', async () => {
    boot();
    await scheduler.executeAction({ type: 'callWebhook', zone: 500, callId: 'start', source: { ruleId: 'r1' } });
    scheduler.recompile();
    expect(tracker.expected(500)).toBeUndefined();
  });

  it('enforcement refuses to act on it even when flagged enforce', async () => {
    boot();
    const z = webhookZone();
    z.enforce = true; // user ticked the box somehow
    configStore.update({ zones: [z] });
    enforcement.setActiveCluster(
      { id: 'c', startsAt: new Date(Date.now() - 3600_000), endsAt: new Date(Date.now() + 3600_000) },
      Date.now() - 3600_000,
    );
    const corrected = [];
    enforcement.on('corrected', (e) => corrected.push(e));
    enforcement.onDeviation({ zone: 500, reported: 100, expected: 0 });
    await new Promise((r) => setTimeout(r, 300));
    expect(corrected).toEqual([]);
    expect(target.hits).toHaveLength(0);
  });

  it('a failed call raises actionFailed and does not retry', async () => {
    boot();
    target.setStatus(503);
    const failures = [];
    scheduler.on('actionFailed', (f) => failures.push(f));
    await scheduler.executeAction({ type: 'callWebhook', zone: 500, callId: 'start', source: { ruleId: 'r1' } });
    await new Promise((r) => setTimeout(r, 100));
    expect(target.hits).toHaveLength(1); // exactly one attempt — no retry loop
    expect(failures).toHaveLength(1);
    expect(failures[0].error.message).toMatch(/HTTP 503/);
  });

  it('a latched-looking state cannot suppress or duplicate the call', async () => {
    boot();
    // latches are per-zone level holds; a webhook has no level, so the action
    // must still run exactly once
    await scheduler.executeAction({ type: 'callWebhook', zone: 500, callId: 'start', source: { ruleId: 'r1' } });
    expect(target.hits).toHaveLength(1);
  });
});

// ── compiling rules and scenes ─────────────────────────────────────────────

describe('webhooks in rules and scenes', () => {
  const cal = () => new CalendarService({
    location: { zip: '10952', lat: 41.1126, lng: -74.0736, city: 'Monsey', state: 'NY', tzid: 'America/New_York', il: false, elevation: 0 },
    times: { candleLightingMins: 18, havdalahMins: 45, tzeitAngle: 8.5 },
    locale: 'ashkenazi',
  });

  const compile = (schedules, scenes = []) => {
    const calendar = cal();
    const clusters = calendar.clusters('2027-04-20', '2027-04-24');
    const compiler = new TimelineCompiler({
      calendar, sceneRepo: new SceneRepository(scenes), schedules, guestMode: false, guestUntil: null,
    });
    return compiler.compile(clusters, Date.parse('2027-04-20'), Date.parse('2027-04-24'));
  };

  it('a rule compiles to a callWebhook action carrying the call id', () => {
    const { allActions } = compile({
      'pesach-1': { default: { rules: [
        { id: 'w1', label: 'heater on', enabled: true,
          action: { type: 'callWebhook', zone: 500, callId: 'start' },
          trigger: { kind: 'fixed', time: '15:00', day: 'erev' } },
      ] } },
    });
    const hit = allActions.find((a) => a.type === 'callWebhook');
    expect(hit).toBeTruthy();
    expect(hit).toMatchObject({ zone: 500, callId: 'start' });
  });

  it('one rule can fire several webhook devices (multi-zone)', () => {
    const { allActions } = compile({
      'pesach-1': { default: { rules: [
        { id: 'w1', label: 'all on', enabled: true,
          action: { type: 'callWebhook', zone: 500, zones: [500, 501], callId: 'start' },
          trigger: { kind: 'fixed', time: '15:00', day: 'erev' } },
      ] } },
    });
    const hits = allActions.filter((a) => a.type === 'callWebhook');
    expect(hits.map((h) => h.zone).sort()).toEqual([500, 501]);
  });

  it('scene start and end each pick their own call', () => {
    const scenes = [{
      id: 'meal', name: 'Mealtime',
      actions: [{ zone: 500, callId: 'start' }],
      endActions: [{ zone: 500, callId: 'stop' }],
    }];
    const { allActions } = compile({
      'pesach-1': { default: { rules: [
        { id: 's1', label: 'start', enabled: true, action: { type: 'sceneStart', sceneId: 'meal' }, trigger: { kind: 'fixed', time: '18:00', day: 'erev' } },
        { id: 's2', label: 'end', enabled: true, action: { type: 'sceneEnd', sceneId: 'meal' }, trigger: { kind: 'fixed', time: '22:00', day: 'erev' } },
      ] } },
    }, scenes);
    const hits = allActions.filter((a) => a.type === 'callWebhook').sort((a, b) => a.at - b.at);
    expect(hits).toHaveLength(2);
    expect(hits[0]).toMatchObject({ callId: 'start', source: { scenePhase: 'sceneStart' } });
    expect(hits[1]).toMatchObject({ callId: 'stop', source: { scenePhase: 'sceneEnd' } });
  });

  it('two different calls on the same device at the same instant both survive dedupe', () => {
    const { allActions } = compile({
      'pesach-1': { default: { rules: [
        { id: 'a', label: 'a', enabled: true, action: { type: 'callWebhook', zone: 500, callId: 'start' }, trigger: { kind: 'fixed', time: '15:00', day: 'erev' } },
        { id: 'b', label: 'b', enabled: true, action: { type: 'callWebhook', zone: 500, callId: 'stop' }, trigger: { kind: 'fixed', time: '15:00', day: 'erev' } },
      ] } },
    });
    expect(allActions.filter((a) => a.type === 'callWebhook')).toHaveLength(2);
  });

  it('the SAME call twice at the same instant is deduped to one', () => {
    const { allActions } = compile({
      'pesach-1': { default: { rules: [
        { id: 'a', label: 'a', enabled: true, action: { type: 'callWebhook', zone: 500, callId: 'start' }, trigger: { kind: 'fixed', time: '15:00', day: 'erev' } },
        { id: 'b', label: 'b', enabled: true, action: { type: 'callWebhook', zone: 500, callId: 'start' }, trigger: { kind: 'fixed', time: '15:00', day: 'erev' } },
      ] } },
    });
    expect(allActions.filter((a) => a.type === 'callWebhook')).toHaveLength(1);
  });

  it('a scene PREVIEW never fires a webhook member', async () => {
    configStore.update({
      location: { zip: '10952', lat: 41.1126, lng: -74.0736, city: 'Monsey', state: 'NY', tzid: 'America/New_York', il: false, elevation: 0 },
      zones: [webhookZone(), { id: 7, source: 'virtual', externalId: 7, name: 'L', area: 'A', friendlyName: 'L', dimmable: true, enforce: false }],
      scenes: [{ id: 'meal', name: 'Mealtime', actions: [{ zone: 500, callId: 'start' }, { zone: 7, level: 80 }] }],
      setupComplete: true,
    });
    const tracker = new ZoneStateTracker({ stateStore });
    const enforcement = new EnforcementEngine({ configStore, stateStore, tracker, devices: bus });
    const scheduler = new Scheduler({ configStore, stateStore, tracker, enforcement, devices: bus });
    try {
      await scheduler.startScenePreview('meal');
      expect(target.hits).toHaveLength(0); // the light previewed; the webhook did NOT fire
    } finally { scheduler.stop(); }
  });
});

// ── HTTP API ───────────────────────────────────────────────────────────────

describe('webhook device API', () => {
  let app; let api;

  beforeEach(() => {
    const tracker = new ZoneStateTracker({ stateStore });
    const enforcement = new EnforcementEngine({ configStore, stateStore, tracker, devices: bus });
    const scheduler = new Scheduler({ configStore, stateStore, tracker, enforcement, devices: bus });
    app = createApp({
      configStore, stateStore, scheduler, tracker, enforcement,
      devices: bus, failover: null, notifier: { send: async () => ({}) },
      ring: new LogRing(), logDir: null, logger: null,
    });
    configStore.update({ setupComplete: true });
    const tok = configStore.get().failover.syncToken;
    api = {
      post: (u) => request(app).post(u).set('Authorization', `Bearer ${tok}`),
      put: (u) => request(app).put(u).set('Authorization', `Bearer ${tok}`),
    };
  });

  const payload = () => ({
    name: 'Sukkah Heater',
    webhook: {
      calls: [
        { name: 'Start heater', method: 'POST', url: `http://127.0.0.1:${port}/start`, body: '{"on":true}' },
        { name: 'Stop heater', method: 'POST', url: `http://127.0.0.1:${port}/stop` },
      ],
    },
  });

  it('creates a webhook device and assigns call ids', async () => {
    const res = await api.post('/api/zones/webhook').send(payload()).expect(201);
    expect(res.body).toMatchObject({ source: 'webhook', kind: 'webhook', dimmable: false, enforce: false });
    expect(res.body.webhook.calls).toHaveLength(2);
    for (const c of res.body.webhook.calls) expect(c.id).toBeTruthy();
  });

  it('rejects a bad URL at save time with a readable error', async () => {
    const bad = payload();
    bad.webhook.calls[0].url = 'not-a-url';
    const res = await api.post('/api/zones/webhook').send(bad).expect(400);
    expect(res.body.error).toMatch(/valid http\(s\) URL/);
    expect(configStore.get().zones).toHaveLength(0); // nothing persisted
  });

  it('requires a name', async () => {
    await api.post('/api/zones/webhook').send({ webhook: payload().webhook }).expect(400);
  });

  it('updates an existing device', async () => {
    const created = await api.post('/api/zones/webhook').send(payload()).expect(201);
    const id = created.body.id;
    const next = { name: 'Renamed', webhook: { ...created.body.webhook, calls: [created.body.webhook.calls[0]] } };
    const res = await api.put(`/api/zones/${id}/webhook`).send(next).expect(200);
    expect(res.body.friendlyName).toBe('Renamed');
    expect(res.body.webhook.calls).toHaveLength(1);
  });

  it('refuses to update a non-webhook device through the webhook route', async () => {
    const manual = await api.post('/api/zones/manual').send({ name: 'Lamp' }).expect(201);
    await api.put(`/api/zones/${manual.body.id}/webhook`).send(payload()).expect(400);
  });

  it('the Test button fires a saved call and reports the status', async () => {
    const created = await api.post('/api/zones/webhook').send(payload()).expect(201);
    const callId = created.body.webhook.calls[0].id;
    const res = await api.post(`/api/zones/${created.body.id}/webhook/test`).send({ callId }).expect(200);
    expect(res.body).toMatchObject({ ok: true, status: 200 });
    expect(target.hits).toHaveLength(1);
    expect(target.hits[0].url).toBe('/start');
  });

  it('the Test button works on an UNSAVED draft, before anything is stored', async () => {
    const res = await api.post('/api/zones/999/webhook/test').send({
      name: 'Draft',
      webhook: payload().webhook,
      call: { name: 'Start heater', method: 'POST', url: `http://127.0.0.1:${port}/draft`, body: '{}' },
    }).expect(200);
    expect(res.body.ok).toBe(true);
    expect(target.hits[0].url).toBe('/draft');
    expect(configStore.get().zones).toHaveLength(0); // still nothing saved
  });

  it('a failing Test reports the error rather than throwing', async () => {
    const created = await api.post('/api/zones/webhook').send(payload()).expect(201);
    target.setStatus(404);
    const res = await api.post(`/api/zones/${created.body.id}/webhook/test`)
      .send({ callId: created.body.webhook.calls[0].id }).expect(502);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/HTTP 404/);
  });
});
