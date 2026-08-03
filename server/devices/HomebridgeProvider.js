import { EventEmitter } from 'node:events';

/**
 * Homebridge integration via the config-ui-x admin API (the web UI virtually
 * every Homebridge install runs, default port 8581). Requires Homebridge in
 * insecure mode (-I) for accessory control — the standard setup for any
 * programmatic control.
 *
 * IMPORTANT LIMITATION: config-ui-x has no push event stream, so wall-press
 * detection is POLLED (pollSeconds, default 5). Child Lock corrections on
 * Homebridge zones therefore lag a few seconds — for enforced zones, prefer
 * pairing devices to Home Assistant or Hubitat. Scheduling is unaffected.
 *
 * Config: homebridge { enabled, host ("192.168.0.30:8581" or full URL),
 * username, password, pollSeconds }. Empty username = the UI's no-auth mode.
 */
export class HomebridgeProvider extends EventEmitter {
  #poll = null;
  #token = null;
  #dimmable = new Map(); // uniqueId -> has Brightness
  #lastLevels = new Map();
  connected = false;

  constructor({ host, username = '', password = '', pollSeconds = 5, logger = null, fetchImpl = fetch }) {
    super();
    const base = /^https?:\/\//.test(host ?? '') ? host : `http://${host}`;
    this.base = base.replace(/\/+$/, '');
    this.username = username;
    this.password = password;
    this.pollSeconds = pollSeconds;
    this.log = logger;
    this.fetch = fetchImpl;
  }

  async #login() {
    const res = this.username
      ? await this.fetch(`${this.base}/api/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: this.username, password: this.password }),
        signal: AbortSignal.timeout(8000),
      })
      : await this.fetch(`${this.base}/api/auth/noauth`, { method: 'POST', signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`homebridge login ${res.status}`);
    const data = await res.json();
    this.#token = data.access_token;
  }

  async #req(pathname, { method = 'GET', body } = {}, retry = true) {
    if (!this.#token) await this.#login();
    this.log?.debug({ path: pathname, method }, 'homebridge request');
    const res = await this.fetch(`${this.base}${pathname}`, {
      method,
      headers: { Authorization: `Bearer ${this.#token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 401 && retry) {
      this.#token = null; // token expired — re-login once
      return this.#req(pathname, { method, body }, false);
    }
    if (!res.ok) throw new Error(`homebridge ${res.status} for ${pathname}`);
    return res.json();
  }

  /** Controllable accessories (anything with an On characteristic). */
  async listDevices() {
    const all = await this.#req('/api/accessories');
    return all
      .filter((a) => characteristic(a, 'On') !== undefined)
      .map((a) => ({
        id: a.uniqueId,
        label: a.serviceName ?? a.accessoryInformation?.Name ?? a.uniqueId,
        dimmable: characteristic(a, 'Brightness') !== undefined,
        level: accessoryLevel(a),
      }));
  }

  async connect() {
    const devices = await this.listDevices();
    this.#dimmable = new Map(devices.map((d) => [d.id, d.dimmable]));
    this.connected = true;
    this.emit('connected');
    this.#emitDiff(devices, { all: true });
    clearInterval(this.#poll);
    this.#poll = setInterval(async () => {
      try {
        this.#emitDiff(await this.listDevices());
        if (!this.connected) { this.connected = true; this.emit('connected'); }
      } catch (err) {
        this.log?.warn({ err: err.message }, 'homebridge poll failed');
        if (this.connected) { this.connected = false; this.emit('disconnected'); }
      }
    }, this.pollSeconds * 1000);
    this.#poll.unref?.();
    this.emit('ready');
  }

  close() {
    clearInterval(this.#poll);
    this.connected = false;
  }

  async setLevel(uniqueId, level, _fadeSec = 0) {
    if (level > 0 && (this.#dimmable.get(uniqueId) ?? false) && level < 100) {
      // Brightness implies On on HomeKit accessories
      await this.#req(`/api/accessories/${uniqueId}`, {
        method: 'PUT', body: { characteristicType: 'Brightness', value: Math.round(level) },
      });
    } else {
      await this.#req(`/api/accessories/${uniqueId}`, {
        method: 'PUT', body: { characteristicType: 'On', value: level > 0 },
      });
    }
    this.#lastLevels.set(uniqueId, level);
    this.emit('zoneLevel', { id: uniqueId, level });
  }

  async queryLevel(uniqueId) {
    const a = await this.#req(`/api/accessories/${uniqueId}`);
    return accessoryLevel(a) ?? undefined;
  }

  /** Poll diffing: only emit when a level changed (keeps the tracker quiet). */
  #emitDiff(devices, { all = false } = {}) {
    for (const d of devices) {
      if (d.level == null) continue;
      if (all || this.#lastLevels.get(d.id) !== d.level) {
        this.#lastLevels.set(d.id, d.level);
        this.emit('zoneLevel', { id: d.id, level: d.level });
      }
    }
  }
}

function characteristic(accessory, type) {
  return (accessory.serviceCharacteristics ?? []).find((c) => c.type === type)?.value;
}

function accessoryLevel(a) {
  const on = characteristic(a, 'On');
  if (on === undefined) return null;
  if (!on) return 0;
  const b = characteristic(a, 'Brightness');
  return typeof b === 'number' ? Math.max(1, Math.round(b)) : 100;
}
