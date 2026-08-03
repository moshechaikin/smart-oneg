import { EventEmitter } from 'node:events';

/**
 * Native Ecobee thermostat provider (official cloud REST API, OAuth PIN flow).
 *
 * ⚠ Reliability note, surfaced in the UI too: this rides Ecobee's CLOUD — it
 * needs working internet and Ecobee's servers up during Shabbos/Yom Tov.
 * Pairing the Ecobee to a Hubitat hub and using the (local) Hubitat provider
 * is the recommended, more robust path. This provider exists for households
 * without a Hubitat.
 *
 * Device semantics: a thermostat is a zone with kind "thermostat" whose
 * "level" is the hold temperature in °F. setLevel(t>0) places an indefinite
 * hold at t°F (heat; cool = t+4 as the API requires both); setLevel(0) means
 * "resume the thermostat's own program".
 *
 * Tokens: access tokens live ~1h; the refresh token is persisted back into
 * config.ecobee via configStore so restarts stay authorized.
 */
export class EcobeeProvider extends EventEmitter {
  #poll = null;
  connected = false;

  constructor({ configStore, logger = null, fetchImpl = fetch, baseUrl = 'https://api.ecobee.com' }) {
    super();
    this.config = configStore;
    this.log = logger;
    this.fetch = fetchImpl;
    this.baseUrl = baseUrl;
  }

  get #cfg() {
    return this.config.get().ecobee;
  }

  /** Valid access token, refreshing (and persisting) when needed. */
  async #token() {
    const c = this.#cfg;
    if (!c.refreshToken) throw new Error('Ecobee is not authorized yet — run the PIN flow in Settings');
    if (c.accessToken && Date.now() < (c.tokenExpiresAt ?? 0) - 60_000) return c.accessToken;
    const res = await this.fetch(`${this.baseUrl}/token?grant_type=refresh_token&refresh_token=${encodeURIComponent(c.refreshToken)}&client_id=${encodeURIComponent(c.apiKey)}`, {
      method: 'POST', signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`ecobee token refresh failed (${res.status})`);
    const tok = await res.json();
    this.config.update({ ecobee: {
      accessToken: tok.access_token,
      refreshToken: tok.refresh_token ?? c.refreshToken,
      tokenExpiresAt: Date.now() + (tok.expires_in ?? 3600) * 1000,
    } });
    return tok.access_token;
  }

  async #api(pathname, { method = 'GET', body } = {}) {
    const token = await this.#token();
    const res = await this.fetch(`${this.baseUrl}${pathname}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) throw new Error(`ecobee ${res.status} for ${pathname.split('?')[0]}`);
    return res.json();
  }

  async listDevices() {
    const selection = { selectionType: 'registered', selectionMatch: '', includeRuntime: true, includeSettings: true };
    const data = await this.#api(`/1/thermostat?format=json&body=${encodeURIComponent(JSON.stringify({ selection }))}`);
    return (data.thermostatList ?? []).map((t) => ({
      id: t.identifier,
      label: t.name || `Thermostat ${t.identifier}`,
      holdTempF: Math.round((t.runtime?.desiredHeat ?? 700) / 10),
      actualTempF: Math.round((t.runtime?.actualTemperature ?? 0) / 10),
      hvacMode: t.settings?.hvacMode,
    }));
  }

  async connect() {
    const devices = await this.listDevices();
    this.connected = true;
    this.emit('connected');
    this.#emitLevels(devices);
    clearInterval(this.#poll);
    this.#poll = setInterval(async () => {
      try {
        this.#emitLevels(await this.listDevices());
        if (!this.connected) { this.connected = true; this.emit('connected'); }
      } catch (err) {
        this.log?.warn({ err: err.message }, 'ecobee poll failed');
        if (this.connected) { this.connected = false; this.emit('disconnected'); }
      }
    }, (this.#cfg.pollSeconds ?? 120) * 1000);
    this.#poll.unref?.();
    this.emit('ready');
  }

  close() {
    clearInterval(this.#poll);
    this.connected = false;
  }

  /** level 0 = resume the thermostat's program; level>0 = hold at level °F. */
  async setLevel(identifier, level, _fadeSec = 0) {
    const selection = { selectionType: 'thermostats', selectionMatch: String(identifier) };
    const functions = level > 0
      ? [{ type: 'setHold', params: {
        holdType: 'indefinite',
        heatHoldTemp: Math.round(level * 10),
        coolHoldTemp: Math.round((level + 4) * 10),
      } }]
      : [{ type: 'resumeProgram', params: { resumeAll: false } }];
    await this.#api('/1/thermostat?format=json', { method: 'POST', body: { selection, functions } });
    this.emit('zoneLevel', { id: String(identifier), level });
  }

  #emitLevels(devices) {
    for (const d of devices) this.emit('zoneLevel', { id: String(d.id), level: d.holdTempF });
  }
}

/** OAuth PIN flow helpers (used by the /api/ecobee routes). */
export async function requestPin({ apiKey, fetchImpl = fetch, baseUrl = 'https://api.ecobee.com' }) {
  const res = await fetchImpl(`${baseUrl}/authorize?response_type=ecobeePin&client_id=${encodeURIComponent(apiKey)}&scope=smartWrite`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`ecobee authorize failed (${res.status}) — check the API key`);
  const data = await res.json();
  return { pin: data.ecobeePin, code: data.code, expiresInMin: data.expires_in };
}

export async function exchangePin({ apiKey, code, fetchImpl = fetch, baseUrl = 'https://api.ecobee.com' }) {
  const res = await fetchImpl(`${baseUrl}/token?grant_type=ecobeePin&code=${encodeURIComponent(code)}&client_id=${encodeURIComponent(apiKey)}`, {
    method: 'POST', signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error === 'authorization_pending'
      ? 'Not authorized yet — enter the PIN at ecobee.com (My Apps → Add Application) first'
      : `ecobee token exchange failed (${res.status})`);
  }
  const tok = await res.json();
  return {
    accessToken: tok.access_token,
    refreshToken: tok.refresh_token,
    tokenExpiresAt: Date.now() + (tok.expires_in ?? 3600) * 1000,
  };
}
