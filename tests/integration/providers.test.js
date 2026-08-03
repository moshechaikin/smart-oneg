import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { HomeAssistantProvider } from '../../server/devices/HomeAssistantProvider.js';
import { HomebridgeProvider } from '../../server/devices/HomebridgeProvider.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Minimal fake HTTP server: routes is a map of "METHOD /path" -> handler(body,url).
function fakeServer(routes) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const key = `${req.method} ${url.pathname}`;
      calls.push({ key, body: body ? JSON.parse(body) : null, path: url.pathname });
      const handler = routes[key] ?? routes[`${req.method} *`];
      if (!handler) { res.statusCode = 404; return res.end('{}'); }
      const out = handler(body ? JSON.parse(body) : null, url);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(out ?? { ok: true }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, calls, port: server.address().port }));
  });
}

let openServers = [];
const track = (s) => { openServers.push(s.server); return s; };
afterEach(() => { for (const s of openServers) s.close(); openServers = []; });

describe('HomeAssistantProvider', () => {
  const STATES = [
    { entity_id: 'light.kitchen', state: 'on', attributes: { friendly_name: 'Kitchen', brightness: 128, supported_color_modes: ['brightness'] } },
    { entity_id: 'switch.porch', state: 'off', attributes: { friendly_name: 'Porch' } },
    { entity_id: 'climate.den', state: 'heat', attributes: { friendly_name: 'Den', temperature: 70, current_temperature: 68 } },
    { entity_id: 'sensor.ignore', state: '5', attributes: {} }, // not importable
  ];

  it('lists and maps entities (dimmable / switch / thermostat)', async () => {
    const { port } = track(await fakeServer({ 'GET /api/states': () => STATES }));
    const p = new HomeAssistantProvider({ host: `127.0.0.1:${port}`, token: 't', WebSocketImpl: null });
    const devices = await p.listDevices();
    expect(devices.map((d) => d.id)).toEqual(['light.kitchen', 'switch.porch', 'climate.den']);
    expect(devices[0]).toMatchObject({ dimmable: true, level: 50 }); // 128/255 → 50
    expect(devices[1]).toMatchObject({ dimmable: false, level: 0 });
    expect(devices[2]).toMatchObject({ kind: 'thermostat', level: 70 });
  });

  it('sends the right service calls for each domain', async () => {
    const { calls, port } = track(await fakeServer({ 'POST *': () => ({ ok: true }) }));
    const p = new HomeAssistantProvider({ host: `127.0.0.1:${port}`, token: 't', WebSocketImpl: null });
    await p.setLevel('light.kitchen', 60);
    await p.setLevel('light.kitchen', 0);
    await p.setLevel('switch.porch', 100);
    await p.setLevel('climate.den', 72);
    // filter to actual service calls: the climate path also does GET /api/config
    // (unit probe) and GET /api/states before it sets a temperature
    const svc = calls.filter((c) => c.path.startsWith('/api/services/'));
    expect(svc[0].path).toContain('/api/services/light/turn_on');
    expect(svc[0].body).toMatchObject({ entity_id: 'light.kitchen', brightness_pct: 60 });
    expect(svc[1].path).toContain('/api/services/light/turn_off');
    expect(svc[2].path).toContain('/api/services/switch/turn_on');
    const climate = svc.find((c) => c.path.includes('/climate/set_temperature'));
    expect(climate).toBeTruthy();
    expect(climate.body).toMatchObject({ temperature: 72 });
  });

  it('imports automations/scripts/HA-scenes as momentary Run devices and triggers them correctly', async () => {
    const HA = [
      { entity_id: 'automation.shabbos_prep', state: 'on', attributes: { friendly_name: 'Shabbos Prep' } },
      { entity_id: 'script.goodnight', state: 'off', attributes: { friendly_name: 'Goodnight' } },
      { entity_id: 'scene.dinner', state: '2026-07-10T00:00:00+00:00', attributes: { friendly_name: 'Dinner' } },
      { entity_id: 'light.kitchen', state: 'on', attributes: { friendly_name: 'Kitchen', brightness: 255 } },
    ];
    const { calls, port } = track(await fakeServer({ 'GET /api/states': () => HA, 'POST *': () => ({ ok: true }) }));
    const p = new HomeAssistantProvider({ host: `127.0.0.1:${port}`, token: 't', WebSocketImpl: null });

    const devices = await p.listDevices();
    // all three momentary domains import, kind 'automation', ALWAYS idle
    // (state 'on' means "enabled" in HA, never "running")
    for (const id of ['automation.shabbos_prep', 'script.goodnight', 'scene.dinner']) {
      expect(devices.find((d) => d.id === id)).toMatchObject({ kind: 'automation', dimmable: false, level: 0 });
    }
    expect(devices.find((d) => d.id === 'light.kitchen').level).toBe(100); // regular devices unaffected

    // level > 0 fires the right service per domain
    await p.setLevel('automation.shabbos_prep', 100);
    await p.setLevel('script.goodnight', 100);
    await p.setLevel('scene.dinner', 100);
    const paths = calls.filter((c) => c.key.startsWith('POST')).map((c) => c.path);
    expect(paths).toContain('/api/services/automation/trigger'); // NOT turn_on (that only enables it)
    expect(paths).toContain('/api/services/script/turn_on');
    expect(paths).toContain('/api/services/scene/turn_on');

    // level 0 is a deliberate no-op (turn_off would DISABLE the automation)
    const before = calls.length;
    await p.setLevel('automation.shabbos_prep', 0);
    await p.setLevel('script.goodnight', 0);
    expect(calls.length).toBe(before);

    // queryLevel always reads idle — snapshots can never "restore" (re-fire) one
    expect(await p.queryLevel('automation.shabbos_prep')).toBe(0);
  });

  it('maps covers (shades) and fans, and controls them', async () => {
    const HA = [
      { entity_id: 'cover.blind', state: 'open', attributes: { friendly_name: 'Blind', current_position: 40, supported_features: 15 } },
      { entity_id: 'fan.ceiling', state: 'on', attributes: { friendly_name: 'Fan', percentage: 75 } },
      { entity_id: 'switch.plug', state: 'on', attributes: { friendly_name: 'Plug', device_class: 'outlet' } },
    ];
    const { calls, port } = track(await fakeServer({
      'GET /api/states': () => HA,
      'GET /api/states/cover.blind': () => HA[0], // #setCover reads the single entity for supported_features
      'POST *': () => ({ ok: true }),
    }));
    const p = new HomeAssistantProvider({ host: `127.0.0.1:${port}`, token: 't', WebSocketImpl: null });
    const devices = await p.listDevices();
    expect(devices.find((d) => d.id === 'cover.blind')).toMatchObject({ kind: 'shade', dimmable: true, level: 40 });
    expect(devices.find((d) => d.id === 'fan.ceiling')).toMatchObject({ kind: 'fan', dimmable: true, level: 75 });
    expect(devices.find((d) => d.id === 'switch.plug')).toMatchObject({ kind: 'outlet', dimmable: false });
    // a fridge Sabbath-mode switch is recognized by name
    const fridge = await (async () => {
      const HA2 = [{ entity_id: 'switch.kitchen_fridge_sabbath_mode', state: 'off', attributes: { friendly_name: 'Fridge Sabbath Mode' } }];
      const { port: p2 } = track(await fakeServer({ 'GET /api/states': () => HA2 }));
      const prov = new HomeAssistantProvider({ host: `127.0.0.1:${p2}`, token: 't', WebSocketImpl: null });
      return (await prov.listDevices())[0];
    })();
    expect(fridge).toMatchObject({ kind: 'fridge', dimmable: false, level: 0 });
    await p.setLevel('cover.blind', 30); // partial → set_cover_position
    await p.setLevel('cover.blind', 100); // fully → open_cover
    await p.setLevel('cover.blind', 0); // → close_cover
    await p.setLevel('fan.ceiling', 50); // → turn_on percentage
    const paths = calls.filter((c) => c.key.startsWith('POST')).map((c) => c.path);
    expect(paths).toContain('/api/services/cover/set_cover_position');
    expect(paths).toContain('/api/services/cover/open_cover');
    expect(paths).toContain('/api/services/cover/close_cover');
    expect(paths).toContain('/api/services/fan/turn_on');
    const fanCall = calls.find((c) => c.path === '/api/services/fan/turn_on');
    expect(fanCall.body).toMatchObject({ percentage: 50 });
  });

  it('pushes state_changed over the websocket → zoneLevel', async () => {
    const { port } = track(await fakeServer({ 'GET /api/states': () => STATES }));
    // fake browser-style WebSocket that drives the HA auth handshake
    class FakeWS extends EventEmitter {
      constructor() { super(); setTimeout(() => this.#emit('message', { data: JSON.stringify({ type: 'auth_required' }) }), 5); }
      addEventListener(type, fn) { this.on(type, fn); }
      #emit(type, ev) { this.emit(type, ev); }
      send(raw) {
        const msg = JSON.parse(raw);
        if (msg.type === 'auth') setTimeout(() => this.#emit('message', { data: JSON.stringify({ type: 'auth_ok' }) }), 5);
        else if (msg.type === 'subscribe_events') {
          setTimeout(() => this.#emit('message', {
            data: JSON.stringify({
              type: 'event',
              event: { data: { new_state: { entity_id: 'light.kitchen', state: 'on', attributes: { brightness: 255 } } } },
            }),
          }), 5);
        }
      }
      close() { this.emit('close', {}); }
    }
    const p = new HomeAssistantProvider({ host: `127.0.0.1:${port}`, token: 't', WebSocketImpl: FakeWS });
    const events = [];
    p.on('zoneLevel', (e) => events.push(e));
    await p.connect();
    // wait (up to 1s) for the pushed state to arrive — timing varies under load
    for (let i = 0; i < 50 && !events.some((e) => e.id === 'light.kitchen' && e.level === 100); i++) await sleep(20);
    expect(events).toContainEqual({ id: 'light.kitchen', level: 100 }); // 255/255
    p.close();
  });
});

describe('HomebridgeProvider', () => {
  const ACC = [
    { uniqueId: 'a1', serviceName: 'Lamp', serviceCharacteristics: [{ type: 'On', value: true }, { type: 'Brightness', value: 40 }] },
    { uniqueId: 'a2', serviceName: 'Fan', serviceCharacteristics: [{ type: 'On', value: false }] },
    { uniqueId: 'a3', serviceName: 'Sensor', serviceCharacteristics: [{ type: 'CurrentTemperature', value: 21 }] }, // no On → skipped
  ];
  const routes = () => ({
    'POST /api/auth/login': () => ({ access_token: 'tok' }),
    'GET /api/accessories': () => ACC,
    'PUT *': () => ({ ok: true }),
  });

  it('logs in and maps accessories with an On characteristic', async () => {
    const { port } = track(await fakeServer(routes()));
    const p = new HomebridgeProvider({ host: `127.0.0.1:${port}`, username: 'admin', password: 'pw' });
    const devices = await p.listDevices();
    expect(devices.map((d) => d.id)).toEqual(['a1', 'a2']);
    expect(devices[0]).toMatchObject({ dimmable: true, level: 40 });
    expect(devices[1]).toMatchObject({ dimmable: false, level: 0 });
  });

  it('sets Brightness for dimmers and On for switches', async () => {
    const { calls, port } = track(await fakeServer(routes()));
    const p = new HomebridgeProvider({ host: `127.0.0.1:${port}`, username: 'admin', password: 'pw' });
    await p.connect();
    await p.setLevel('a1', 55); // dimmer, partial → Brightness
    await p.setLevel('a2', 100); // switch → On true
    const puts = calls.filter((c) => c.key.startsWith('PUT'));
    expect(puts[0].body).toMatchObject({ characteristicType: 'Brightness', value: 55 });
    expect(puts[1].body).toMatchObject({ characteristicType: 'On', value: true });
    p.close();
  });

  it('emits zoneLevel only when a polled level actually changes', async () => {
    let level = 40;
    const { port } = track(await fakeServer({
      'POST /api/auth/noauth': () => ({ access_token: 'tok' }),
      'GET /api/accessories': () => [{ uniqueId: 'a1', serviceName: 'Lamp', serviceCharacteristics: [{ type: 'On', value: true }, { type: 'Brightness', value: level }] }],
    }));
    const p = new HomebridgeProvider({ host: `127.0.0.1:${port}`, username: '', password: '', pollSeconds: 0.1 });
    const events = [];
    p.on('zoneLevel', (e) => events.push(e));
    await p.connect();      // initial emit
    await sleep(150);       // a poll with no change → no new event
    const afterStable = events.length;
    level = 90;             // simulate a wall press
    await sleep(200);
    expect(events.length).toBeGreaterThan(afterStable);
    expect(events.at(-1)).toEqual({ id: 'a1', level: 90 });
    p.close();
  });
});
