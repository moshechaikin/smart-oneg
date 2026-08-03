import { EventEmitter } from 'node:events';
import path from 'node:path';

/**
 * Matter (Matter-over-IP) support — EXPERIMENTAL, untested on real hardware.
 *
 * Acts as a Matter controller/commissioner via @project-chip/matter.js: pair a
 * device with its manual pairing code (or QR-code payload), then control its
 * OnOff / LevelControl clusters. Attribute-change subscriptions give push
 * updates, so Child Lock can watch a Matter switch like a Lutron one.
 *
 * Design choices for fault isolation (this is the least battle-tested provider):
 *  - The heavy Matter stack is lazy-loaded (dynamic import) only when Matter is
 *    actually enabled, so a base install never pays for it and a load failure
 *    can't crash boot — it surfaces as a clear provider error instead.
 *  - Fabric credentials persist under <dataDir>/matter so paired devices
 *    survive restarts.
 *  - The controller is created through an injectable factory so tests can drive
 *    the provider with a fake controller (the real one needs mDNS + hardware).
 *
 * Config: matter { enabled }. Devices map one Matter node → one zone
 * (externalId = the node id as a string), first OnOff endpoint.
 */
export class MatterProvider extends EventEmitter {
  #controller = null;
  #clients = null;         // { OnOffClient, LevelControlClient }
  #nodes = new Map();      // nodeIdStr -> { node, endpoint }
  connected = false;

  constructor({ dataDir, logger = null, controllerFactory = null } = {}) {
    super();
    this.storageDir = dataDir ? path.join(dataDir, 'matter') : undefined;
    this.log = logger;
    this._controllerFactory = controllerFactory; // tests inject a fake controller
  }

  /** Lazily build (or reuse) the Matter controller + cluster client classes. */
  async #ensureController() {
    if (this.#controller) return this.#controller;
    if (this._controllerFactory) {
      const { controller, clients } = await this._controllerFactory();
      this.#controller = controller;
      this.#clients = clients ?? {};
      return controller;
    }
    // real stack — only reached when Matter is enabled on real hardware
    const { Environment } = await import('@matter/main');
    const { CommissioningController } = await import('@project-chip/matter.js');
    const { OnOffClient } = await import('@matter/main/behaviors/on-off');
    const { LevelControlClient } = await import('@matter/main/behaviors/level-control');
    this.#clients = { OnOffClient, LevelControlClient };
    const environment = Environment.default;
    if (this.storageDir) environment.vars.set('storage.path', this.storageDir);
    const controller = new CommissioningController({
      environment: { environment, id: 'smartoneg' },
      autoConnect: true,
      adminFabricLabel: 'SmartOneg',
    });
    await controller.start();
    this.#controller = controller;
    this.log?.info('matter controller started');
    return controller;
  }

  async connect() {
    const controller = await this.#ensureController();
    this.connected = true;
    this.emit('connected');
    for (const nodeId of controller.getCommissionedNodes()) {
      await this.#trackNode(nodeId).catch((err) => this.log?.warn({ nodeId: String(nodeId), err: err.message }, 'matter node track failed'));
    }
    this.emit('ready');
  }

  /** Commission a new device by its manual pairing code (11-digit) or QR payload. */
  async commission(pairingCode) {
    const controller = await this.#ensureController();
    const { ManualPairingCodeCodec } = await import('@matter/main/types');
    const code = String(pairingCode ?? '').replace(/\D/g, '');
    if (code.length < 11) throw new Error('a Matter manual pairing code is at least 11 digits');
    const { shortDiscriminator, passcode } = ManualPairingCodeCodec.decode(code);
    const nodeId = await controller.commissionNode({
      commissioning: { regulatoryLocation: 0, regulatoryCountryCode: 'XX' },
      discovery: { identifierData: { shortDiscriminator }, discoveryCapabilities: { onIpNetwork: true } },
      passcode,
    });
    this.log?.warn({ nodeId: String(nodeId) }, 'matter device commissioned');
    await this.#trackNode(nodeId);
    const idStr = String(nodeId);
    return { id: idStr, ...this.#describe(idStr) };
  }

  async #trackNode(nodeId) {
    const controller = await this.#ensureController();
    const node = await controller.getNode(nodeId);
    const idStr = String(nodeId);
    // push: any OnOff/LevelControl attribute change re-emits the level
    node.events?.attributeChanged?.on(({ path: p }) => {
      if (p?.attributeName === 'onOff' || p?.attributeName === 'currentLevel') {
        const level = this.#readLevel(idStr);
        if (level != null) this.emit('zoneLevel', { id: idStr, level });
      }
    });
    try { node.connect?.(); } catch { /* already connecting */ }
    this.#nodes.set(idStr, { node, endpoint: this.#primaryEndpoint(node) });
    const level = this.#readLevel(idStr);
    if (level != null) this.emit('zoneLevel', { id: idStr, level });
  }

  /** First endpoint exposing an OnOff cluster (what we treat as the light). */
  #primaryEndpoint(node) {
    const endpoints = node.getDevices?.() ?? [];
    for (const ep of endpoints) {
      try { if (ep.stateOf(this.#clients.OnOffClient)) return ep; } catch { /* no OnOff here */ }
    }
    return endpoints[0] ?? null;
  }

  #describe(idStr) {
    const entry = this.#nodes.get(idStr);
    const ep = entry?.endpoint;
    let dimmable = false;
    try { dimmable = Boolean(ep?.stateOf(this.#clients.LevelControlClient)); } catch { dimmable = false; }
    const label = entry?.node?.basicInformation?.nodeLabel
      || entry?.node?.getRootClusterClient?.()?.name
      || `Matter device ${idStr}`;
    return { label, dimmable, level: this.#readLevel(idStr) };
  }

  #readLevel(idStr) {
    const ep = this.#nodes.get(idStr)?.endpoint;
    if (!ep) return null;
    let on;
    try { on = ep.stateOf(this.#clients.OnOffClient)?.onOff; } catch { return null; }
    if (on === false) return 0;
    if (on == null) return null;
    let cur;
    try { cur = ep.stateOf(this.#clients.LevelControlClient)?.currentLevel; } catch { cur = null; }
    return matterLevelToPct(cur) ?? 100;
  }

  async listDevices() {
    const controller = await this.#ensureController();
    const out = [];
    for (const nodeId of controller.getCommissionedNodes()) {
      const idStr = String(nodeId);
      if (!this.#nodes.has(idStr)) await this.#trackNode(nodeId).catch(() => {});
      out.push({ id: idStr, ...this.#describe(idStr) });
    }
    return out;
  }

  async setLevel(externalId, level, _fadeSec = 0) {
    const idStr = String(externalId);
    const ep = this.#nodes.get(idStr)?.endpoint;
    if (!ep) throw new Error(`matter node ${idStr} not connected`);
    if (level <= 0) {
      await ep.commandsOf(this.#clients.OnOffClient).off();
    } else if (level >= 100) {
      await ep.commandsOf(this.#clients.OnOffClient).on();
    } else {
      // dimmable path: moveToLevelWithOnOff turns it on and sets brightness
      let lc;
      try { lc = ep.commandsOf(this.#clients.LevelControlClient); } catch { lc = null; }
      if (lc) await lc.moveToLevelWithOnOff({ level: pctToMatterLevel(level), transitionTime: 0, optionsMask: {}, optionsOverride: {} });
      else await ep.commandsOf(this.#clients.OnOffClient).on();
    }
    this.emit('zoneLevel', { id: idStr, level });
  }

  async queryLevel(externalId) {
    const lvl = this.#readLevel(String(externalId));
    return lvl == null ? undefined : lvl;
  }

  close() {
    this.connected = false;
    try { this.#controller?.close?.(); } catch { /* ignore */ }
  }
}

// Matter LevelControl uses 1-254 (254 = 100%). Pure + exported for tests.
export const matterLevelToPct = (lvl) => (typeof lvl === 'number' ? Math.max(1, Math.round((lvl / 254) * 100)) : null);
export const pctToMatterLevel = (pct) => Math.max(1, Math.min(254, Math.round((pct / 100) * 254)));
