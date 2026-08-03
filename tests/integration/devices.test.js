import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MockBridge } from '../../server/lutron/MockBridge.js';
import { LutronClient } from '../../server/lutron/LutronClient.js';
import { DeviceBus, blinkLevels } from '../../server/devices/DeviceBus.js';
import { HubitatProvider } from '../../server/devices/HubitatProvider.js';
import { ConfigStore } from '../../server/config/ConfigStore.js';

/** Minimal Maker API simulator. */
function mockHubitat() {
  const devices = new Map([
    [42, { id: '42', label: 'Sukkah Lights', capabilities: ['Switch', 'SwitchLevel'], attributes: [{ name: 'level', currentValue: 0 }, { name: 'switch', currentValue: 'off' }] }],
    [77, { id: '77', label: 'Porch Plug', capabilities: ['Switch'], attributes: [{ name: 'switch', currentValue: 'off' }] }],
  ]);
  const commands = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.searchParams.get('access_token') !== 'tok123') { res.writeHead(401).end('{}'); return; }
    const parts = url.pathname.split('/').filter(Boolean); // apps api <appId> devices ...
    const rest = parts.slice(3);
    res.setHeader('content-type', 'application/json');
    if (rest.join('/') === 'devices/all' || rest.join('/') === 'devices') {
      res.end(JSON.stringify([...devices.values()]));
    } else if (rest[0] === 'devices' && rest.length >= 3) {
      const d = devices.get(Number(rest[1]));
      const [cmd, value] = [rest[2], rest[3]];
      commands.push(`${rest[1]}/${cmd}${value !== undefined ? `/${value}` : ''}`);
      if (cmd === 'setLevel') {
        d.attributes.find((a) => a.name === 'level').currentValue = Number(value);
        d.attributes.find((a) => a.name === 'switch').currentValue = Number(value) > 0 ? 'on' : 'off';
      } else if (cmd === 'on' || cmd === 'off') {
        d.attributes.find((a) => a.name === 'switch').currentValue = cmd;
      }
      res.end('{}');
    } else {
      res.writeHead(404).end('{}');
    }
  });
  return {
    server, commands, devices,
    async listen() {
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      return server.address().port;
    },
    close: () => new Promise((r) => server.close(r)),
  };
}

let dir; let bridge; let hub; let bus; let lutronClient;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devices-'));
  bridge = new MockBridge();
  await bridge.listen();
  hub = mockHubitat();
  const hubPort = await hub.listen();

  const configStore = new ConfigStore({ dataDir: dir });
  configStore.load();
  configStore.update({
    zones: [
      { id: 3, name: 'Main', area: 'Dining Room', friendlyName: 'Dining', dimmable: true, enforce: false }, // lutron implicit
      { id: 100, source: 'hubitat', externalId: 42, name: 'Sukkah Lights', area: 'Hubitat', friendlyName: 'Sukkah', dimmable: true, enforce: false },
      { id: 101, source: 'hubitat', externalId: 77, name: 'Porch Plug', area: 'Hubitat', friendlyName: 'Porch', dimmable: false, enforce: false },
    ],
    hubitat: { enabled: true, host: `127.0.0.1:${hubPort}`, appId: '5', accessToken: 'tok123', pollSeconds: 600 },
  });

  lutronClient = new LutronClient({ host: '127.0.0.1', port: bridge.port, zoneIds: [3], commandTimeoutMs: 500 });
  bus = new DeviceBus({ configStore });
  bus.register('lutron', lutronClient);
  bus.register('hubitat', new HubitatProvider({ ...configStore.get().hubitat }));
  await bus.connect();
});

afterEach(async () => {
  bus.close();
  await bridge.close();
  await hub.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('DeviceBus', () => {
  it('routes commands to the owning provider', async () => {
    await bus.setLevel(3, 80);            // -> Lutron
    expect(bridge.levels.get(3)).toBe(80);
    await bus.setLevel(100, 55);          // -> Hubitat dimmer
    expect(hub.commands).toContain('42/setLevel/55');
    await bus.setLevel(101, 100);         // -> Hubitat plain switch: on/off
    expect(hub.commands).toContain('77/on');
    await bus.setLevel(101, 0);
    expect(hub.commands).toContain('77/off');
    await expect(bus.setLevel(999, 10)).rejects.toThrow(/unknown zone/);
  });

  it('normalizes provider events to app zone ids', async () => {
    const seen = [];
    bus.on('zoneLevel', (e) => seen.push(e));
    bridge.simulateManualChange(3, 25);                           // lutron external 3 -> zone 3
    bus.provider('hubitat').handleEvent({ content: { deviceId: '42', name: 'level', value: '60' } }); // -> zone 100
    bus.provider('hubitat').handleEvent({ content: { deviceId: '77', name: 'switch', value: 'on' } }); // -> zone 101
    await new Promise((r) => setTimeout(r, 50));
    expect(seen).toContainEqual({ id: 3, level: 25 });
    expect(seen).toContainEqual({ id: 100, level: 60 });
    expect(seen).toContainEqual({ id: 101, level: 100 });
  });

  it('reports connected only when all zone-owning providers are up', async () => {
    expect(bus.connected).toBe(true);
    bus.provider('hubitat').close();
    expect(bus.connected).toBe(false);
  });

  it('flash blinks and always ends at the restore level (the pre-flash state)', async () => {
    await bus.setLevel(3, 80);
    const before = bridge.commandLog.length;
    await bus.flash(3, 1, 80); // light is ON at 80 — must end ON at 80
    expect(bridge.levels.get(3)).toBe(80);
    const sets = bridge.commandLog.slice(before).filter((l) => l.startsWith('#OUTPUT,3,1'));
    // exactly one blink: opposite (0) then restore (80) — no extra toggles
    expect(sets).toEqual(['#OUTPUT,3,1,0', '#OUTPUT,3,1,80']);
  });

  it('flash twice on an OFF zone blinks to 100 twice and ends OFF', async () => {
    await bus.setLevel(3, 0);
    const before = bridge.commandLog.length;
    await bus.flash(3, 2, 0);
    expect(bridge.levels.get(3)).toBe(0);
    const sets = bridge.commandLog.slice(before).filter((l) => l.startsWith('#OUTPUT,3,1'));
    expect(sets).toEqual(['#OUTPUT,3,1,100', '#OUTPUT,3,1,0', '#OUTPUT,3,1,100', '#OUTPUT,3,1,0']);
  });

  it('blinkLevels pairs opposite/restore and ends at restore', () => {
    expect(blinkLevels(80, 1)).toEqual([0, 80]);
    expect(blinkLevels(0, 2)).toEqual([100, 0, 100, 0]);
  });
});

describe('setLevelVerified', () => {
  // A timed-out command is not necessarily a failed one — the bridge may not
  // echo a no-op set. These use a stub provider to script failure modes.
  function stubBus({ setLevel, queryLevel }) {
    const provider = Object.assign(new (class extends (Object) {})(), {
      on: () => {}, close: () => {}, setLevel, queryLevel,
    });
    const configStore = { get: () => ({ zones: [{ id: 5, dimmable: true, enforce: false }] }) };
    const b = new DeviceBus({ configStore });
    b.register('lutron', provider);
    return b;
  }

  it('treats a timed-out set as success when the device is already at target', async () => {
    let sets = 0;
    const b = stubBus({
      setLevel: async () => { sets++; throw new Error('command timed out: #OUTPUT,5,1,100'); },
      queryLevel: async () => 100,
    });
    await expect(b.setLevelVerified(5, 100)).resolves.toBeUndefined();
    expect(sets).toBe(1); // verified on the first failure — no blind retries
  });

  it('retries after a transient failure and succeeds', async () => {
    let sets = 0;
    const b = stubBus({
      setLevel: async () => { sets++; if (sets < 3) throw new Error('command timed out'); },
      queryLevel: async () => 0, // device really isn't at target yet
    });
    await expect(b.setLevelVerified(5, 100)).resolves.toBeUndefined();
    expect(sets).toBe(3);
  });

  it('throws only after all attempts fail and the device is not at target', async () => {
    let sets = 0;
    const b = stubBus({
      setLevel: async () => { sets++; throw new Error('command timed out'); },
      queryLevel: async () => { throw new Error('not connected'); },
    });
    await expect(b.setLevelVerified(5, 100)).rejects.toThrow(/timed out/);
    expect(sets).toBe(3);
  });
});
