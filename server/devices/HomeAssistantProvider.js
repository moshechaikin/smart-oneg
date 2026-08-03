import { EventEmitter } from 'node:events';

/**
 * Home Assistant integration: local REST for import/control + the websocket
 * event stream for INSTANT state pushes — a wall press on any device paired
 * to HA reaches the enforcement pipeline in milliseconds, so Child Lock has
 * full parity with Lutron.
 *
 * Setup on HA: user profile → Security → "Create long-lived access token".
 * Config: homeassistant { enabled, host ("192.168.0.20:8123" or full URL),
 * token, pollSeconds } — the slow REST poll is belt-and-suspenders for a
 * dropped websocket.
 *
 * Devices map by entity_id (what users actually know): light.* (dimmable),
 * switch.* (on/off), climate.* (kind "thermostat", level = target °F).
 *
 * automation.* / script.* / scene.* import as MOMENTARY "Run" devices
 * (kind 'automation'): a rule or scene setting them "on" fires the HA action
 * (automation.trigger / script.turn_on / scene.turn_on) and they rest at
 * idle — "off" is a deliberate no-op (automation.turn_off would DISABLE the
 * automation in HA, never what a schedule means).
 */
const MOMENTARY_DOMAINS = new Set(['automation', 'script', 'scene']);
// HA color modes that mean "can take an RGB color" (vs. only white/brightness)
const RGB_MODES = new Set(['rgb', 'rgbw', 'rgbww', 'hs', 'xy']);
export class HomeAssistantProvider extends EventEmitter {
  #poll = null;
  #ws = null;
  #wsSeq = 1;
  #reconnectDelay = 1000;
  #closed = false;
  #celsius; // undefined until /api/config is read once; true if HA reports °C
  connected = false;

  constructor({ host, token, pollSeconds = 60, logger = null, fetchImpl = fetch, WebSocketImpl = globalThis.WebSocket }) {
    super();
    const base = /^https?:\/\//.test(host ?? '') ? host : `http://${host}`;
    this.base = base.replace(/\/+$/, '');
    this.token = token;
    this.pollSeconds = pollSeconds;
    this.log = logger;
    this.fetch = fetchImpl;
    this.WebSocket = WebSocketImpl;
  }

  async #rest(pathname, body = undefined) {
    this.log?.debug({ path: pathname, method: body ? 'POST' : 'GET' }, 'home assistant request');
    const res = await this.fetch(`${this.base}${pathname}`, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      // HA's response body carries the real reason a call failed (e.g.
      // "Provided temperature 9.0 is not valid. Accepted range is 15 to 30").
      // Without it every failure collapses into a bare status code, so pull it
      // in — trimmed, and unwrapping HA's {"message": …} envelope when present.
      let detail = await res.text().catch(() => '');
      try { detail = JSON.parse(detail).message ?? detail; } catch { /* not JSON, use raw text */ }
      detail = detail.replace(/\s+/g, ' ').trim().slice(0, 300);
      this.log?.warn({ path: pathname, status: res.status, body, detail }, 'home assistant request failed');
      throw new Error(`home assistant ${res.status} for ${pathname}${detail ? `: ${detail}` : ''}`);
    }
    return res.json();
  }

  /** All importable entities (lights, switches, plugs, climate, covers, fans,
   *  plus automations/scripts/HA-scenes as momentary "Run" devices). */
  async listDevices() {
    await this.#ensureUnit();
    const states = await this.#rest('/api/states');
    return states
      .filter((s) => {
        const domain = s.entity_id.split('.')[0];
        return ['light', 'switch', 'climate', 'cover', 'fan', 'lock', 'vacuum'].includes(domain) || MOMENTARY_DOMAINS.has(domain);
      })
      .map((s) => {
        const f = Number(s.attributes?.supported_features ?? 0);
        // a cover only gets a level slider if it can take a position (or tilt
        // position); open/close-only covers (and garage doors) are on/off
        const coverDimmable = s.entity_id.startsWith('cover.') && ((f & 4) === 4 || (f & 128) === 128);
        let level = entityLevel(s);
        if (s.entity_id.startsWith('climate.') && typeof level === 'number' && this.#climateCelsius(s.attributes)) level = Math.round((level * 9) / 5 + 32);
        return {
          id: s.entity_id,
          label: s.attributes?.friendly_name ?? s.entity_id,
          // dimmable = has a continuous level: bright lights, cover position, fan speed
          dimmable: (s.entity_id.startsWith('light.') && (s.attributes?.supported_color_modes ?? []).some((m) => m !== 'onoff'))
            || coverDimmable || s.entity_id.startsWith('fan.'),
          kind: entityKind(s),
          level,
          // thermostats carry the unit HA uses for them, so the imported device
          // displays/edits in °C or °F to match HA rather than a fixed default,
          // plus the preset (Home/Away/…) and hvac (heat/cool/off) modes HA
          // exposes, so rules and the device row can offer them
          ...(s.entity_id.startsWith('climate.') ? {
            displayUnit: this.#climateCelsius(s.attributes) ? 'C' : 'F',
            presetModes: (s.attributes?.preset_modes ?? []).filter(Boolean),
            hvacModes: (s.attributes?.hvac_modes ?? []).filter(Boolean),
            preset: s.attributes?.preset_mode ?? null, // current mode (for the device row)
            hvacMode: s.state ?? null,
          } : {}),
          // white color-temperature control for lights that support it
          ...(s.entity_id.startsWith('light.') && (s.attributes?.supported_color_modes ?? []).includes('color_temp') ? {
            colorTemp: true,
            minKelvin: s.attributes?.min_color_temp_kelvin ?? 2200,
            maxKelvin: s.attributes?.max_color_temp_kelvin ?? 6500,
            kelvin: s.attributes?.color_temp_kelvin ?? null,
          } : {}),
          // full RGB color control for lights that support a color mode
          ...(s.entity_id.startsWith('light.') && (s.attributes?.supported_color_modes ?? []).some((m) => RGB_MODES.has(m)) ? {
            rgb: true,
            rgbColor: Array.isArray(s.attributes?.rgb_color) ? s.attributes.rgb_color : null,
          } : {}),
          // can this vacuum actually be started AND docked/stopped remotely? Some
          // (demo/edge) vacuums advertise none of these services — driving them
          // just no-ops and HA logs a warning — so the UI disables the action
          // rather than firing a service the device rejects.
          ...(s.entity_id.startsWith('vacuum.') ? {
            controllable: (f & 8192) === 8192 && ((f & 16) === 16 || (f & 8) === 8),
          } : {}),
        };
      });
  }

  /** Push a device's live level + capability/mode state onto the buses. Runs on
   *  connect and every poll, so things like a vacuum's controllability come from
   *  HA live — no re-import needed to pick up capabilities. */
  #emitDeviceModes(d) {
    if (d.level != null) this.emit('zoneLevel', { id: d.id, level: d.level });
    if (d.kind === 'thermostat') this.emit('zoneMode', { id: d.id, preset: d.preset, hvacMode: d.hvacMode });
    if (d.colorTemp && d.kelvin != null) this.emit('zoneMode', { id: d.id, kelvin: d.kelvin });
    if (d.rgb && d.rgbColor != null) this.emit('zoneMode', { id: d.id, rgbColor: d.rgbColor });
    if (d.kind === 'vacuum') this.emit('zoneMode', { id: d.id, controllable: d.controllable });
  }

  async connect() {
    const devices = await this.listDevices();
    this.connected = true;
    this.emit('connected');
    for (const d of devices) this.#emitDeviceModes(d);
    this.#openWebSocket();
    clearInterval(this.#poll);
    this.#poll = setInterval(async () => {
      try {
        for (const d of await this.listDevices()) this.#emitDeviceModes(d);
        if (!this.connected) { this.connected = true; this.emit('connected'); }
      } catch (err) {
        this.log?.warn({ err: err.message }, 'home assistant poll failed');
        if (this.connected) { this.connected = false; this.emit('disconnected'); }
      }
    }, this.pollSeconds * 1000);
    this.#poll.unref?.();
    this.emit('ready');
  }

  /** state_changed push stream — the Child Lock fast path. */
  #openWebSocket() {
    if (this.#closed || !this.WebSocket) return;
    const url = `${this.base.replace(/^http/, 'ws')}/api/websocket`;
    let ws;
    try {
      ws = new this.WebSocket(url);
    } catch (err) {
      this.log?.warn({ err: err.message }, 'home assistant websocket open failed');
      this.#scheduleReconnect();
      return;
    }
    this.#ws = ws;
    ws.addEventListener('message', (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type === 'auth_required') {
        ws.send(JSON.stringify({ type: 'auth', access_token: this.token }));
      } else if (msg.type === 'auth_ok') {
        this.#reconnectDelay = 1000;
        ws.send(JSON.stringify({ id: this.#wsSeq++, type: 'subscribe_events', event_type: 'state_changed' }));
        this.log?.info('home assistant websocket subscribed (state_changed)');
      } else if (msg.type === 'auth_invalid') {
        this.log?.error('home assistant websocket auth rejected — check the token');
        ws.close?.();
      } else if (msg.type === 'event' && msg.event?.data?.new_state) {
        const s = msg.event.data.new_state;
        if (!['light', 'switch', 'climate'].includes(s.entity_id.split('.')[0])) return;
        let level = entityLevel(s);
        // climate levels are read in HA's unit; the app is canonically °F, and
        // the REST paths convert — this push must too or the readout flips units
        if (s.entity_id.startsWith('climate.') && typeof level === 'number' && this.#climateCelsius(s.attributes)) {
          level = Math.round((level * 9) / 5 + 32);
        }
        if (level != null) this.emit('zoneLevel', { id: s.entity_id, level });
        // a thermostat's preset/hvac mode can change without its setpoint
        if (s.entity_id.startsWith('climate.')) this.emit('zoneMode', { id: s.entity_id, preset: s.attributes?.preset_mode ?? null, hvacMode: s.state ?? null });
        if (s.entity_id.startsWith('light.') && s.attributes?.color_temp_kelvin != null) this.emit('zoneMode', { id: s.entity_id, kelvin: s.attributes.color_temp_kelvin });
        if (s.entity_id.startsWith('light.') && Array.isArray(s.attributes?.rgb_color)) this.emit('zoneMode', { id: s.entity_id, rgbColor: s.attributes.rgb_color });
      }
    });
    ws.addEventListener('close', () => {
      this.#ws = null;
      if (!this.#closed) {
        this.log?.warn('home assistant websocket closed — reconnecting');
        this.#scheduleReconnect();
      }
    });
    ws.addEventListener('error', () => { /* close follows; logged there */ });
  }

  #scheduleReconnect() {
    if (this.#closed) return;
    const delay = this.#reconnectDelay;
    this.#reconnectDelay = Math.min(this.#reconnectDelay * 2, 60_000);
    const t = setTimeout(() => this.#openWebSocket(), delay);
    t.unref?.();
  }

  close() {
    this.#closed = true;
    clearInterval(this.#poll);
    try { this.#ws?.close?.(); } catch { /* already gone */ }
    this.connected = false;
  }

  async setLevel(entityId, level, _fadeSec = 0) {
    const domain = entityId.split('.')[0];
    if (MOMENTARY_DOMAINS.has(domain)) {
      // fire-and-return: these have no level to hold. "off" (level 0) is a
      // deliberate no-op — automation/turn_off would disable the automation.
      if (level > 0) {
        const service = domain === 'automation' ? 'automation/trigger' : `${domain}/turn_on`;
        await this.#rest(`/api/services/${service}`, { entity_id: entityId });
        this.log?.info({ entityId }, 'home assistant action triggered');
      }
      this.emit('zoneLevel', { id: entityId, level: 0 }); // always rests at idle
      return;
    }
    if (domain === 'climate') {
      await this.#setClimate(entityId, level);
    } else if (domain === 'cover') {
      await this.#setCover(entityId, level);
    } else if (domain === 'fan') {
      if (level <= 0) await this.#rest('/api/services/fan/turn_off', { entity_id: entityId });
      else await this.#rest('/api/services/fan/turn_on', { entity_id: entityId, ...(level < 100 ? { percentage: Math.round(level) } : {}) });
    } else if (domain === 'lock') {
      // "on" = secured/locked
      await this.#rest(`/api/services/lock/${level > 0 ? 'lock' : 'unlock'}`, { entity_id: entityId });
    } else if (domain === 'vacuum') {
      await this.#setVacuum(entityId, level);
    } else if (level > 0) {
      const body = { entity_id: entityId };
      if (domain === 'light' && level < 100) body.brightness_pct = Math.round(level);
      await this.#rest(`/api/services/${domain}/turn_on`, body);
    } else {
      await this.#rest(`/api/services/${domain}/turn_off`, { entity_id: entityId });
    }
    this.emit('zoneLevel', { id: entityId, level });
  }

  /** Enable or disable an automation/script (persistent state, not a trigger).
   *  Used to neutralize sensor-driven automations for Shabbos and restore them. */
  async setAutomationEnabled(entityId, enabled) {
    const domain = entityId.split('.')[0]; // automation or script
    await this.#rest(`/api/services/${domain}/${enabled ? 'turn_on' : 'turn_off'}`, { entity_id: entityId });
    this.emit('zoneLevel', { id: entityId, level: 0 }); // still idle in the UI
  }

  /** Set a thermostat's preset (Home/Away/Sleep/…) — an HA comfort mode. */
  async setPreset(entityId, preset) {
    await this.#rest('/api/services/climate/set_preset_mode', { entity_id: entityId, preset_mode: preset });
  }

  /** Set a thermostat's hvac mode (heat / cool / heat_cool / auto / off). */
  async setHvacMode(entityId, hvacMode) {
    await this.#rest('/api/services/climate/set_hvac_mode', { entity_id: entityId, hvac_mode: hvacMode });
  }

  /** Set a light's white color temperature (Kelvin). Keeps it on at its level. */
  async setColorTemp(entityId, kelvin) {
    await this.#rest('/api/services/light/turn_on', { entity_id: entityId, color_temp_kelvin: Math.round(kelvin) });
  }

  /** Set a light's RGB color ([r,g,b], 0–255). Keeps it on at its level. */
  async setColor(entityId, rgb) {
    const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
    await this.#rest('/api/services/light/turn_on', { entity_id: entityId, rgb_color: rgb.map(clamp) });
  }

  async queryLevel(entityId) {
    // momentary triggers always read idle: their HA state means enabled/last-
    // activated, never "running at a level" (also keeps test-mode snapshots
    // from ever "restoring" — i.e. re-firing — an automation)
    if (MOMENTARY_DOMAINS.has(entityId.split('.')[0])) return 0;
    const s = await this.#rest(`/api/states/${entityId}`);
    let level = entityLevel(s) ?? undefined;
    if (entityId.startsWith('climate.') && typeof level === 'number') {
      await this.#ensureUnit();
      if (this.#climateCelsius(s.attributes)) level = Math.round((level * 9) / 5 + 32);
    }
    return level;
  }

  /** Learn whether HA reports temperatures in °C (the app works in °F). A failed
   *  read is NOT cached as false — that would poison every future setpoint; it
   *  simply retries next time, and the per-thermostat range check below is the
   *  real safety net. */
  async #ensureUnit() {
    if (this.#celsius !== undefined) return;
    try {
      const cfg = await this.#rest('/api/config');
      this.#celsius = (cfg?.unit_system?.temperature ?? '°F') === '°C';
    } catch { /* leave undefined and retry; #climateCelsius covers the meantime */ }
  }

  /** °C for THIS thermostat — its own range is the surest signal and can't be
   *  poisoned by a config-read hiccup: a °C unit tops out around 35, a °F one
   *  around 90. Falls back to HA's configured unit when no range is exposed. */
  #climateCelsius(attrs) {
    if (typeof attrs?.max_temp === 'number') return attrs.max_temp <= 45;
    return Boolean(this.#celsius);
  }

  /**
   * Drive a vacuum honoring its supported_features. Vacuums vary a lot: newer
   * ones use start / return_to_base, older ones only turn_on / turn_off, some
   * only stop — calling the wrong one is what raises ServiceNotSupported (500).
   * "on" = clean; "off" = send home / stop.
   */
  async #setVacuum(entityId, level) {
    const s = await this.#rest(`/api/states/${entityId}`).catch(() => null);
    const f = Number(s?.attributes?.supported_features ?? 0);
    const has = (bit) => (f & bit) === bit;
    const call = (svc) => this.#rest(`/api/services/vacuum/${svc}`, { entity_id: entityId });
    const STOP = 8, RETURN_HOME = 16, START = 8192;
    // A vacuum that advertises none of these can't be driven by any service
    // (homeassistant.turn_on just no-ops and warns) — the UI disables its action
    // via the `controllable` flag, so this throw is only a safety net (e.g. a
    // rule targeting such a vacuum, where it's caught best-effort).
    if (level > 0) {
      if (has(START)) return call('start');
      throw new Error(`${entityId} can't be started remotely`);
    }
    if (has(RETURN_HOME)) return call('return_to_base');
    if (has(STOP)) return call('stop');
    throw new Error(`${entityId} can't be docked or stopped remotely`);
  }

  /**
   * Drive a cover honoring its supported_features: position covers get
   * set_cover_position (open/close at the extremes), open/close-only covers
   * toggle open/close, and tilt-only covers (e.g. an awning/pergola) use the
   * tilt services. Guessing open_cover on a tilt-only cover is what 500s.
   */
  async #setCover(entityId, level) {
    const s = await this.#rest(`/api/states/${entityId}`).catch(() => null);
    const f = Number(s?.attributes?.supported_features ?? 0);
    const has = (bit) => (f & bit) === bit;
    const call = (svc, extra = {}) => this.#rest(`/api/services/cover/${svc}`, { entity_id: entityId, ...extra });
    const OPEN = 1, CLOSE = 2, SET_POS = 4, TILT_OPEN = 16, TILT_CLOSE = 32, SET_TILT = 128;
    if (has(SET_POS)) {
      if (level >= 100 && has(OPEN)) return call('open_cover');
      if (level <= 0 && has(CLOSE)) return call('close_cover');
      return call('set_cover_position', { position: Math.round(level) });
    }
    if (has(OPEN) || has(CLOSE)) return call(level > 0 ? 'open_cover' : 'close_cover');
    if (has(SET_TILT)) {
      if (level >= 100 && has(TILT_OPEN)) return call('open_cover_tilt');
      if (level <= 0 && has(TILT_CLOSE)) return call('close_cover_tilt');
      return call('set_cover_tilt_position', { tilt_position: Math.round(level) });
    }
    if (has(TILT_OPEN) || has(TILT_CLOSE)) return call(level > 0 ? 'open_cover_tilt' : 'close_cover_tilt');
    return call(level > 0 ? 'open_cover' : 'close_cover'); // last resort
  }

  /**
   * Hold a thermostat at a target: wake it if it's off (a setpoint is refused
   * while hvac_mode is off), send a target RANGE for heat_cool/auto thermostats
   * (a single `temperature` 500s on those, e.g. an Ecobee) and a single setpoint
   * otherwise, converting to °C if that's HA's unit.
   */
  async #setClimate(entityId, level) {
    // "Resume program" (level 0): release the manual hold instead of treating 0
    // as a temperature — which converted to -17.8°C and clamped to the min, so
    // Resume was really "hold at the minimum temp" (e.g. 7°C).
    if (level <= 0) return this.#resumeClimate(entityId);
    await this.#ensureUnit();
    const s = await this.#rest(`/api/states/${entityId}`).catch(() => null);
    const a = s?.attributes ?? {};
    const f = Number(a.supported_features ?? 0);
    const singleOk = (f & 1) === 1, rangeOk = (f & 2) === 2;
    let mode = s?.state;
    if (mode === 'off' || mode == null) {
      const avail = (a.hvac_modes ?? []).filter((m) => m !== 'off');
      mode = (singleOk ? ['heat', 'cool', 'heat_cool', 'auto'] : ['heat_cool', 'auto', 'heat', 'cool']).find((m) => avail.includes(m)) ?? avail[0];
      if (mode) await this.#rest('/api/services/climate/set_hvac_mode', { entity_id: entityId, hvac_mode: mode });
    }
    const celsius = this.#climateCelsius(a);
    let t = celsius ? (level - 32) * 5 / 9 : level; // HA-unit target
    // never send outside the thermostat's own limits: a mis-detected unit would
    // otherwise 500 the whole call (e.g. 68 sent as °C when the max is 35)
    if (typeof a.min_temp === 'number') t = Math.max(a.min_temp, t);
    if (typeof a.max_temp === 'number') t = Math.min(a.max_temp, t);
    if ((mode === 'heat_cool' || mode === 'auto') && rangeOk) {
      // center a small band (keep the thermostat's existing deadband) on target
      const band = (typeof a.target_temp_high === 'number' && typeof a.target_temp_low === 'number')
        ? Math.max(1, a.target_temp_high - a.target_temp_low) : (celsius ? 1 : 2);
      const r1 = (x) => Math.round(x * 10) / 10;
      // Clamp t on both sides was only the CENTER; the band edges can still
      // overshoot the thermostat's limits (e.g. target 35 + band 4 → high 37,
      // which HA rejects: "Accepted range is 7 to 35"). Clamp each edge too,
      // then keep low < high so a fully-clamped band isn't a zero-width range.
      const lo = clamp(r1(t - band / 2), a.min_temp, a.max_temp);
      let hi = clamp(r1(t + band / 2), a.min_temp, a.max_temp);
      if (hi <= lo) hi = clamp(r1(lo + Math.min(band, 1)), a.min_temp, a.max_temp);
      await this.#rest('/api/services/climate/set_temperature', { entity_id: entityId, target_temp_low: lo, target_temp_high: Math.max(hi, lo) });
    } else {
      await this.#rest('/api/services/climate/set_temperature', { entity_id: entityId, temperature: Math.round(t) });
    }
  }

  /**
   * Release a manual hold so the thermostat follows its own schedule again.
   * There's no single standard HA call: prefer the generic "none" preset
   * (clears a hold on Nest/generic climate), and fall back to Ecobee's
   * dedicated resume_program service. Never send a temperature here.
   */
  async #resumeClimate(entityId) {
    const s = await this.#rest(`/api/states/${entityId}`).catch(() => null);
    const a = s?.attributes ?? {};
    const presets = a.preset_modes ?? [];
    // No single HA call means "resume schedule" everywhere, and the wrong one
    // 400s/500s (e.g. ecobee.resume_program is missing on some builds, and
    // preset "none" is invalid on an Ecobee whose presets are home/eco/away).
    // Try each in order and stop at the first HA accepts; a resume must never
    // surface an error (worst case the manual hold simply stays).
    const attempts = [];
    if (presets.includes('none')) attempts.push(['climate/set_preset_mode', { entity_id: entityId, preset_mode: 'none' }]);
    attempts.push(['ecobee/resume_program', { entity_id: entityId, resume_all: true }]);
    // fall back to a real "comfort"/schedule preset so the manual hold is cleared
    const comfort = ['home', 'comfort', 'schedule', 'auto'].find((p) => presets.includes(p))
      ?? presets.find((p) => p !== a.preset_mode && !['away', 'eco', 'sleep'].includes(p));
    if (comfort) attempts.push(['climate/set_preset_mode', { entity_id: entityId, preset_mode: comfort }]);

    for (const [svc, body] of attempts) {
      try { await this.#rest(`/api/services/${svc}`, body); return; }
      catch (err) { this.log?.warn({ svc, err: err.message }, 'thermostat resume attempt failed, trying next'); }
    }
    this.log?.warn({ entityId, presets }, 'no working resume path for this thermostat; hold left in place');
  }
}

/** Keep a value within [lo, hi]; either bound may be missing (no clamp). */
function clamp(v, lo, hi) {
  if (typeof lo === 'number') v = Math.max(lo, v);
  if (typeof hi === 'number') v = Math.min(hi, v);
  return v;
}

/** Map an HA entity to a SmartOneg device kind (for icon + wording). */
function entityKind(s) {
  const domain = s.entity_id.split('.')[0];
  if (MOMENTARY_DOMAINS.has(domain)) return 'automation';
  if (domain === 'climate') return 'thermostat';
  if (domain === 'cover') return 'shade';
  if (domain === 'fan') return 'fan';
  if (domain === 'lock') return 'lock';
  if (domain === 'vacuum') return 'vacuum';
  if (domain === 'switch') {
    // a fridge's Sabbath/Shabbos mode is exposed as a plain switch entity
    // (e.g. the LG SmartThinQ custom integration) — recognize it by name
    const hay = `${s.entity_id} ${s.attributes?.friendly_name ?? ''}`.toLowerCase();
    if (/sabbath|shabbat|shabbos/.test(hay)) return 'fridge';
    if (s.attributes?.device_class === 'outlet') return 'outlet';
  }
  return undefined; // light / generic switch
}

/** Normalize an HA state object to the app's 0-100 level (°F for climate). */
function entityLevel(s) {
  const domain = s.entity_id.split('.')[0];
  // momentary triggers: HA state 'on' means "enabled", not "running" — they
  // always read idle so the poll/connect streams never paint them lit
  if (MOMENTARY_DOMAINS.has(domain)) return 0;
  if (domain === 'climate') {
    const a = s.attributes ?? {};
    // range thermostats have no single `temperature`; use the band midpoint
    let t = a.temperature;
    if (typeof t !== 'number' && typeof a.target_temp_high === 'number' && typeof a.target_temp_low === 'number') {
      t = (a.target_temp_high + a.target_temp_low) / 2;
    }
    if (typeof t !== 'number') t = a.current_temperature;
    return typeof t === 'number' ? Math.round(t) : null;
  }
  if (domain === 'cover') {
    // tilt-only covers report current_tilt_position instead of current_position
    const pos = s.attributes?.current_position ?? s.attributes?.current_tilt_position;
    if (typeof pos === 'number') return Math.round(pos);
    return s.state === 'open' ? 100 : (s.state === 'closed' ? 0 : null);
  }
  if (domain === 'fan') {
    if (s.state === 'off') return 0;
    const pct = s.attributes?.percentage;
    return typeof pct === 'number' ? Math.max(1, Math.round(pct)) : (s.state === 'on' ? 100 : null);
  }
  // "on" = secured (lock) / actively cleaning (vacuum); mid-states (locking,
  // returning, paused) read as their nearest settled level
  if (domain === 'lock') return s.state === 'locked' || s.state === 'locking' ? 100 : 0;
  // "returning" is on its way to the dock — treat as off so Child Lock doesn't
  // keep re-sending it home while it's already heading there
  if (domain === 'vacuum') return s.state === 'cleaning' ? 100 : 0;
  if (s.state === 'off') return 0;
  if (s.state !== 'on') return null; // unavailable/unknown — don't guess
  const b = s.attributes?.brightness;
  return typeof b === 'number' ? Math.max(1, Math.round((b / 255) * 100)) : 100;
}
