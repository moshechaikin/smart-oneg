import { describe, it, expect } from 'vitest';
import { MatterProvider, matterLevelToPct, pctToMatterLevel } from '../../server/devices/MatterProvider.js';

// The real controller needs mDNS + hardware, so we drive the provider with a
// fake controller injected via controllerFactory — exactly the seam the
// provider exposes for testing. This exercises mapping, commissioning, import
// shaping and setLevel command routing without any Matter stack.

// A fake endpoint that records commands and exposes OnOff/LevelControl state.
function fakeEndpoint({ on = true, level = 254, dimmable = true } = {}) {
  const cmds = [];
  const ep = {
    _state: { on, level },
    _cmds: cmds,
    stateOf(client) {
      if (client === CLIENTS.OnOffClient) return { onOff: this._state.on };
      if (client === CLIENTS.LevelControlClient) return dimmable ? { currentLevel: this._state.level } : undefined;
      return undefined;
    },
    commandsOf(client) {
      if (client === CLIENTS.OnOffClient) {
        return { on: async () => { cmds.push('on'); ep._state.on = true; }, off: async () => { cmds.push('off'); ep._state.on = false; } };
      }
      if (client === CLIENTS.LevelControlClient) {
        return { moveToLevelWithOnOff: async ({ level: l }) => { cmds.push(`level:${l}`); ep._state.on = true; ep._state.level = l; } };
      }
      throw new Error('no such cluster');
    },
  };
  return ep;
}

const CLIENTS = { OnOffClient: Symbol('OnOff'), LevelControlClient: Symbol('Level') };

function fakeController(nodes) {
  return {
    getCommissionedNodes: () => [...nodes.keys()],
    getNode: async (id) => nodes.get(id),
    commissionNode: async () => {
      const id = 100n;
      nodes.set(id, { events: { attributeChanged: { on() {} } }, connect() {}, getDevices: () => [fakeEndpoint()] });
      return id;
    },
    close() {},
  };
}

const providerWith = (nodes) => new MatterProvider({
  controllerFactory: async () => ({ controller: fakeController(nodes), clients: CLIENTS }),
});

describe('MatterProvider level mapping', () => {
  it('maps Matter 1-254 <-> 0-100 percent', () => {
    expect(matterLevelToPct(254)).toBe(100);
    expect(matterLevelToPct(127)).toBe(50);
    expect(matterLevelToPct(1)).toBe(1);
    expect(matterLevelToPct(null)).toBeNull();
    expect(pctToMatterLevel(100)).toBe(254);
    expect(pctToMatterLevel(50)).toBe(127);
    expect(pctToMatterLevel(1)).toBeGreaterThanOrEqual(1);
  });
});

describe('MatterProvider (fake controller)', () => {
  it('lists commissioned nodes with mapped level + dimmable flag', async () => {
    const nodes = new Map([[5n, { events: { attributeChanged: { on() {} } }, connect() {}, getDevices: () => [fakeEndpoint({ on: true, level: 127 })] }]]);
    const p = providerWith(nodes);
    const devices = await p.listDevices();
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({ id: '5', dimmable: true, level: 50 });
  });

  it('reads off state as level 0', async () => {
    const nodes = new Map([[7n, { events: { attributeChanged: { on() {} } }, connect() {}, getDevices: () => [fakeEndpoint({ on: false })] }]]);
    const p = providerWith(nodes);
    expect((await p.listDevices())[0].level).toBe(0);
  });

  it('setLevel routes to OnOff for 0/100 and LevelControl for partial', async () => {
    const ep = fakeEndpoint({ on: false, level: 1 });
    const nodes = new Map([[9n, { events: { attributeChanged: { on() {} } }, connect() {}, getDevices: () => [ep] }]]);
    const p = providerWith(nodes);
    await p.listDevices();           // tracks the node
    await p.setLevel('9', 100);
    await p.setLevel('9', 0);
    await p.setLevel('9', 40);
    expect(ep._cmds).toEqual(['on', 'off', `level:${pctToMatterLevel(40)}`]);
  });

  it('commissions a device and returns its descriptor', async () => {
    const nodes = new Map();
    const p = providerWith(nodes);
    const dev = await p.commission('34970112332'); // 11 digits
    expect(dev.id).toBe('100');
    expect(nodes.has(100n)).toBe(true);
  });

  it('rejects a too-short pairing code', async () => {
    const p = providerWith(new Map());
    await expect(p.commission('123')).rejects.toThrow(/pairing code/i);
  });

  it('emits zoneLevel on an attribute change', async () => {
    let handler;
    const ep = fakeEndpoint({ on: true, level: 254 });
    const nodes = new Map([[3n, { events: { attributeChanged: { on(fn) { handler = fn; } } }, connect() {}, getDevices: () => [ep] }]]);
    const p = providerWith(nodes);
    const events = [];
    p.on('zoneLevel', (e) => events.push(e));
    await p.connect();
    ep._state.level = 127; // device dimmed at the wall
    handler({ path: { attributeName: 'currentLevel' } });
    expect(events.at(-1)).toEqual({ id: '3', level: 50 });
    p.close();
  });
});
