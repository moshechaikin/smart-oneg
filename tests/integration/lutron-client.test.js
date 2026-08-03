import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { MockBridge } from '../../server/lutron/MockBridge.js';
import { LutronClient } from '../../server/lutron/LutronClient.js';
import { parseLine, buildSetLevel, formatFade, parseIntegrationReport } from '../../server/lutron/protocol.js';

let bridge;
let client;

beforeEach(async () => {
  bridge = new MockBridge();
  await bridge.listen();
});

afterEach(async () => {
  client?.close();
  await bridge.close();
});

function makeClient(overrides = {}) {
  client = new LutronClient({
    host: '127.0.0.1', port: bridge.port,
    zoneIds: [2, 3, 9],
    commandTimeoutMs: 500, keepaliveMs: 200,
    ...overrides,
  });
  return client;
}

describe('protocol helpers', () => {
  it('builds and parses OUTPUT lines', () => {
    expect(buildSetLevel(9, 75, 90)).toBe('#OUTPUT,9,1,75,1:30');
    expect(buildSetLevel(9, 0)).toBe('#OUTPUT,9,1,0');
    expect(formatFade(5)).toBe('5');
    expect(parseLine('~OUTPUT,3,1,90.00')).toEqual({ type: 'output', id: 3, action: 1, level: 90 });
    expect(parseLine('~ERROR,6')).toMatchObject({ type: 'error', code: 6 });
    expect(parseLine('~ERROR,6').message).toMatch(/Unsupported command/);
    // real Caseta bridges emit non-numeric error payloads for some rejects
    expect(parseLine('~ERROR,Enum Parse Error')).toMatchObject({ type: 'error', code: null });
    expect(parseLine('GNET> ~OUTPUT,3,1,0.00')).toMatchObject({ type: 'output', id: 3 });
  });

  it('parses the real integration report', () => {
    const json = JSON.parse(fs.readFileSync(new URL('../../resources/lutron-integration-report.json', import.meta.url), 'utf8'));
    const zones = parseIntegrationReport(json);
    expect(zones).toHaveLength(9);
    expect(zones.find((z) => z.id === 3)).toMatchObject({ area: 'Dining Room', name: 'Main Lights' });
    expect(() => parseIntegrationReport({})).toThrow(/integration report/);
  });
});

describe('LutronClient', () => {
  it('logs in, primes zones, sets and queries levels', async () => {
    const c = makeClient();
    const ready = new Promise((r) => c.once('ready', r));
    await c.connect();
    await ready;
    // priming queried every configured zone
    expect(bridge.commandLog.filter((l) => l.startsWith('?OUTPUT'))).toHaveLength(3);

    await c.setLevel(9, 100);
    expect(bridge.levels.get(9)).toBe(100);
    expect(await c.queryLevel(9)).toBe(100);
  });

  it('serializes concurrent commands', async () => {
    const c = makeClient();
    await c.connect();
    bridge.commandLog.length = 0;
    await Promise.all([c.setLevel(2, 10), c.setLevel(3, 20), c.queryLevel(2), c.setLevel(9, 30)]);
    expect(bridge.commandLog).toEqual(['#OUTPUT,2,1,10', '#OUTPUT,3,1,20', '?OUTPUT,2,1', '#OUTPUT,9,1,30']);
  });

  it('emits zoneLevel for wall-switch (monitor) changes', async () => {
    const c = makeClient();
    await c.connect();
    const seen = new Promise((r) => c.on('zoneLevel', (e) => { if (e.id === 7 || e.id === 3) r(e); }));
    bridge.simulateManualChange(3, 55);
    expect(await seen).toEqual({ id: 3, level: 55 });
  });

  it('rejects on ~ERROR from the bridge', async () => {
    const c = makeClient();
    await c.connect();
    await expect(c.setLevel(99, 50)).rejects.toThrow(/Object does not exist/);
    // queue keeps flowing afterward
    await c.setLevel(2, 40);
    expect(bridge.levels.get(2)).toBe(40);
  });

  it('reconnects with backoff and re-primes after the socket drops', async () => {
    const c = makeClient();
    await c.connect();
    const reconnected = new Promise((r) => c.once('ready', r));
    const disconnected = new Promise((r) => c.once('disconnected', r));
    bridge.dropConnections();
    await disconnected;
    await reconnected;
    expect(c.connected).toBe(true);
    await c.setLevel(3, 65);
    expect(bridge.levels.get(3)).toBe(65);
  });

  it('rejects commands cleanly when not connected', async () => {
    const c = makeClient();
    await expect(c.setLevel(2, 10)).rejects.toThrow(/not connected/);
  });

  // Regression: a silently dead link (Wi-Fi off, cable pulled — socket stays
  // open, nothing answers) used to leave `connected` true indefinitely; the
  // dashboard showed green while commands went nowhere. The app keepalive must
  // notice within ~2 missed probes and force a reconnect.
  it('detects a silently dead link via keepalive probes and reconnects', async () => {
    const c = makeClient({ commandTimeoutMs: 200, keepaliveMs: 300, maxBackoffMs: 500 });
    await c.connect();
    expect(c.connected).toBe(true);

    const disconnected = new Promise((r) => c.once('disconnected', r));
    bridge.mute = true; // link goes silently dead
    await disconnected; // keepalive caught it (2 missed probes -> destroy)
    expect(c.connected).toBe(false);

    const ready = new Promise((r) => c.once('ready', r));
    bridge.mute = false; // network comes back
    await ready;
    expect(c.connected).toBe(true);
    await c.setLevel(3, 65); // and the link actually works again
    expect(bridge.levels.get(3)).toBe(65);
  }, 15_000);
});

describe('LutronClient against REAL bridge ordering (prompt before response)', () => {
  // Verified on hardware 2026-07-06: the Smart Bridge Pro sends GNET>
  // immediately and the ~OUTPUT response a few ms later. This suite guards
  // the exact bug that produced off-by-one query results on the real bridge.
  beforeEach(() => { bridge.promptFirst = true; });

  it('queries return correct values, not the previous command’s', async () => {
    bridge.levels.set(2, 20);
    bridge.levels.set(3, 30);
    bridge.levels.set(9, 90);
    const c = makeClient();
    await c.connect();
    expect(await c.queryLevel(2)).toBe(20);
    expect(await c.queryLevel(3)).toBe(30);
    expect(await c.queryLevel(9)).toBe(90);
  });

  it('interleaved sets and queries stay paired', async () => {
    const c = makeClient();
    await c.connect();
    await c.setLevel(2, 15);
    expect(await c.queryLevel(2)).toBe(15);
    await c.setLevel(3, 45);
    const [q2, q3] = await Promise.all([c.queryLevel(2), c.queryLevel(3)]);
    expect([q2, q3]).toEqual([15, 45]);
  });

  it('errors reject the right command', async () => {
    const c = makeClient();
    await c.connect();
    await expect(c.setLevel(99, 50)).rejects.toThrow(/Object does not exist/);
    expect(await c.queryLevel(2)).toBe(0);
  });
});
