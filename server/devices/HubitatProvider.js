import { EventEmitter } from 'node:events';

/**
 * Hubitat Elevation integration via the built-in Maker API app (local LAN
 * HTTP, no cloud). This is also the practical bridge to Zigbee / Z-Wave
 * devices and Ecobee thermostats: pair them to the Hubitat hub, expose them
 * in Maker API, and they appear here as dimmers/switches.
 *
 * Setup on the hub: Apps -> add built-in "Maker API" -> select devices ->
 * note the app id + access token from the example URLs. Optionally set the
 * Maker API "URL to send device events to by POST" to
 *   http://<this-app>:1836/api/hubitat/events?token=<accessToken>
 * for instant wall-switch detection; otherwise polling (pollSeconds) covers it.
 *
 * Commands used: /devices (list), /devices/all (attributes),
 * /devices/{id}/setLevel/{n}, /devices/{id}/on, /devices/{id}/off.
 */
export class HubitatProvider extends EventEmitter {
  #poll = null;
  #caps = new Map(); // deviceId -> Set(capabilities)
  connected = false;

  constructor({ host, appId, accessToken, pollSeconds = 30, logger = null, fetchImpl = fetch }) {
    super();
    this.base = `http://${host}/apps/api/${appId}`;
    this.token = accessToken;
    this.pollSeconds = pollSeconds;
    this.log = logger;
    this.fetch = fetchImpl;
  }

  async #get(pathname) {
    this.log?.debug({ path: pathname.replace(/access_token=[^&]+/, 'access_token=***') }, 'hubitat request');
    const sep = pathname.includes('?') ? '&' : '?';
    const res = await this.fetch(`${this.base}${pathname}${sep}access_token=${this.token}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`hubitat ${res.status} for ${pathname}`);
    return res.json();
  }

  /** List devices (id, label, capabilities) — used by discovery UI and connect(). */
  async listDevices() {
    const all = await this.#get('/devices/all');
    return all.map((d) => ({
      id: Number(d.id),
      label: d.label ?? d.name,
      capabilities: d.capabilities ?? [],
      dimmable: (d.capabilities ?? []).includes('SwitchLevel'),
      switchable: (d.capabilities ?? []).includes('Switch'),
      level: attr(d, 'level'),
      switch: attr(d, 'switch'),
    }));
  }

  async connect() {
    const devices = await this.listDevices();
    this.#caps = new Map(devices.map((d) => [d.id, new Set(d.capabilities)]));
    this.connected = true;
    this.emit('connected');
    this.#emitLevels(devices);
    clearInterval(this.#poll);
    this.#poll = setInterval(async () => {
      try {
        this.#emitLevels(await this.listDevices());
        if (!this.connected) { this.connected = true; this.emit('connected'); }
      } catch (err) {
        this.log?.warn({ err: err.message }, 'hubitat poll failed');
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

  async setLevel(deviceId, level, _fadeSec = 0) {
    const caps = this.#caps.get(Number(deviceId)) ?? new Set();
    if (caps.has('SwitchLevel') && level > 0 && level < 100) {
      await this.#get(`/devices/${deviceId}/setLevel/${Math.round(level)}`);
    } else {
      await this.#get(`/devices/${deviceId}/${level > 0 ? 'on' : 'off'}`);
    }
    this.emit('zoneLevel', { id: Number(deviceId), level });
  }

  /** Maker API event webhook payload: { content: { deviceId, name, value } } */
  handleEvent(body) {
    const c = body?.content;
    if (!c) return;
    const id = Number(c.deviceId);
    if (c.name === 'level') this.emit('zoneLevel', { id, level: Number(c.value) });
    else if (c.name === 'switch') this.emit('zoneLevel', { id, level: c.value === 'on' ? 100 : 0 });
  }

  #emitLevels(devices) {
    for (const d of devices) {
      const level = d.switch === 'off' ? 0 : (d.level ?? (d.switch === 'on' ? 100 : null));
      if (level !== null && level !== undefined) this.emit('zoneLevel', { id: d.id, level: Number(level) });
    }
  }
}

function attr(device, name) {
  const a = (device.attributes ?? []).find((x) => x.name === name);
  return a?.currentValue ?? null;
}
