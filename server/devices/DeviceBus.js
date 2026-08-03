import { EventEmitter } from 'node:events';

const BLINK_STEP_MS = 700;

/**
 * The ordered levels a flash will set: opposite-of-restore / restore pairs,
 * one pair per blink, always ending at the restore level. Callers that do
 * echo suppression (tracker.expectCommand) must pre-register exactly these
 * levels so the toggles aren't mistaken for wall-switch deviations.
 */
export function blinkLevels(restoreLevel, times) {
  const opposite = restoreLevel > 0 ? 0 : 100;
  const seq = [];
  for (let i = 0; i < times; i++) seq.push(opposite, restoreLevel);
  return seq;
}

/**
 * Routes zone commands to the right device provider and normalizes provider
 * events back to app-level zone ids.
 *
 * Zones carry `source` ('lutron' default, 'hubitat', ...) and `externalId`
 * (defaults to the zone id — the Lutron LIP integration id). Everything above
 * this layer (scheduler, enforcement, tracker, routes) keeps speaking plain
 * zone ids and the LutronClient-shaped surface: connect/close/connected/
 * setLevel/flash + zoneLevel events — so the bus is a drop-in replacement
 * wherever a bare LutronClient was used.
 *
 * Hubitat is the pragmatic gateway to other ecosystems: Zigbee/Z-Wave devices
 * and even Ecobee thermostats paired to a Hubitat hub show up as Maker API
 * devices, so they ride this same path with zero extra protocol work here.
 */
export class DeviceBus extends EventEmitter {
  #providers = new Map();
  #modes = new Map(); // zoneId -> { preset, hvacMode, kelvin, rgbColor } (thermostat mode / light color)

  constructor({ configStore, logger = null }) {
    super();
    this.config = configStore;
    this.log = logger;
  }

  register(name, provider) {
    this.#providers.set(name, provider);
    provider.on('zoneLevel', ({ id, level }) => {
      const zone = this.#zoneByExternal(name, id);
      if (zone) this.emit('zoneLevel', { id: zone.id, level });
    });
    // extra device state beyond a 0-100 level (thermostat preset/hvac, a light's
    // color temperature): cache the latest merged so the device row can show +
    // change it, and forward it live over SSE
    provider.on('zoneMode', ({ id, ...fields }) => {
      const zone = this.#zoneByExternal(name, id);
      if (!zone) return;
      this.#modes.set(zone.id, { ...this.#modes.get(zone.id), ...fields });
      this.emit('zoneMode', { id: zone.id, ...fields });
    });
    for (const ev of ['connected', 'disconnected', 'ready']) {
      provider.on(ev, () => this.emit(ev, { provider: name }));
    }
  }

  /** Latest known preset/hvac mode for a thermostat zone (or {}). */
  getMode(zoneId) {
    return this.#modes.get(zoneId) ?? {};
  }

  provider(name) {
    return this.#providers.get(name) ?? null;
  }

  /** Connected when every provider that owns at least one zone is connected. */
  get connected() {
    const used = this.#usedProviders();
    if (used.length === 0) return this.#providers.get('lutron')?.connected ?? false;
    return used.every((name) => this.#providers.get(name)?.connected);
  }

  /** Per-provider connection status for every provider that owns ≥1 zone —
   *  powers the dashboard's per-bridge breakdown. */
  bridgeStatus() {
    return this.#usedProviders().map((name) => ({
      source: name,
      connected: Boolean(this.#providers.get(name)?.connected),
    }));
  }

  async connect() {
    const used = this.#usedProviders();
    const names = used.length ? used : [...this.#providers.keys()];
    await Promise.all(names.map(async (name) => {
      try {
        await this.#providers.get(name).connect();
      } catch (err) {
        this.log?.error({ provider: name, err: err.message }, 'provider connect failed');
        throw err;
      }
    }));
  }

  close() {
    for (const p of this.#providers.values()) p.close();
  }

  /**
   * Close and drop every provider so callers can rebuild the set from a changed
   * config (e.g. a standby that just mirrored new bridge/zone config from the
   * primary). The bus's own event listeners are kept — only the providers and
   * their per-provider wiring are replaced.
   */
  clearProviders() {
    for (const p of this.#providers.values()) {
      try { p.close(); } catch { /* ignore */ }
      p.removeAllListeners?.();
    }
    this.#providers.clear();
  }

  /**
   * Non-dimmable devices only understand on/off. Callers that record an
   * expected level (tracker) MUST coerce through this first, or a rule that
   * sets 50% on a switch would create a phantom deviation when the switch
   * reports back 100%.
   */
  coerceLevel(zoneId, level) {
    const zone = this.config.get().zones.find((z) => z.id === zoneId);
    // a thermostat's "level" is a temperature (°F), not a 0–100 brightness —
    // snapping it to 100 would drive it to ~37.8°C and corrupt every setpoint
    if (zone?.kind === 'thermostat') return level;
    if (zone && !zone.dimmable && level > 0) return 100;
    return level;
  }

  async setLevel(zoneId, level, fadeSec = 0) {
    const { provider, externalId } = this.#route(zoneId);
    return provider.setLevel(externalId, this.coerceLevel(zoneId, level), fadeSec);
  }

  /** Enable/disable an automation (HA only); no-op for providers without it. */
  async setAutomationEnabled(zoneId, enabled) {
    const { provider, externalId } = this.#route(zoneId);
    return provider.setAutomationEnabled?.(externalId, enabled);
  }

  /** Set a thermostat preset (Home/Away/…) or hvac mode (heat/cool/off). */
  async setPreset(zoneId, preset) {
    const { provider, externalId } = this.#route(zoneId);
    return provider.setPreset?.(externalId, preset);
  }

  async setHvacMode(zoneId, hvacMode) {
    const { provider, externalId } = this.#route(zoneId);
    return provider.setHvacMode?.(externalId, hvacMode);
  }

  /** Set a light's white color temperature in Kelvin (HA only). */
  async setColorTemp(zoneId, kelvin) {
    const { provider, externalId } = this.#route(zoneId);
    return provider.setColorTemp?.(externalId, kelvin);
  }

  /** Set a light's RGB color ([r,g,b], 0–255) (HA only). */
  async setColor(zoneId, rgb) {
    const { provider, externalId } = this.#route(zoneId);
    return provider.setColor?.(externalId, rgb);
  }

  /** Live-read a zone's level from its provider. Returns undefined for
   *  providers that can't answer a query (one-way bridges). */
  async queryLevel(zoneId) {
    const { provider, externalId } = this.#route(zoneId);
    return provider.queryLevel?.(externalId);
  }

  /**
   * setLevel with retries and verify-before-fail: a timed-out command is not
   * necessarily a failed one (the bridge may not echo a no-op set, or the
   * echo can arrive late), so before each retry we ask the device for its
   * actual level and succeed silently if it already matches. Callers should
   * only alert the user when this throws.
   */
  async setLevelVerified(zoneId, level, fadeSec = 0, { attempts = 3 } = {}) {
    const { provider, externalId } = this.#route(zoneId);
    const target = this.coerceLevel(zoneId, level);
    let lastErr;
    for (let i = 0; i < attempts; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, 500 * i));
      try {
        await provider.setLevel(externalId, target, fadeSec);
        return;
      } catch (err) {
        lastErr = err;
        try {
          const actual = await provider.queryLevel?.(externalId);
          if (actual !== undefined && Math.abs(actual - target) <= 1) {
            this.log?.info({ zone: zoneId, to: target, err: err.message }, 'set reported failure but device is at target — treating as success');
            return;
          }
        } catch { /* device also unreachable for the query — retry the set */ }
        this.log?.warn({ zone: zoneId, to: target, attempt: i + 1, err: err.message }, 'set failed, retrying');
      }
    }
    throw lastErr;
  }

  /**
   * Blink a zone `times` times, then leave it at `restoreLevel` (the actual
   * pre-flash state — pass tracker.reported, not a stale expected level).
   * Software blinking only: the Smart Bridge Pro rejects the native flash
   * action 5 (verified on hardware 2026-07-06, docs/ARCHITECTURE.md).
   */
  async flash(zoneId, times, restoreLevel) {
    const { provider, externalId } = this.#route(zoneId);
    const restore = this.coerceLevel(zoneId, restoreLevel ?? 0);
    const seq = blinkLevels(restore, Math.max(1, times ?? 1));
    for (let i = 0; i < seq.length; i++) {
      if (i === seq.length - 1) {
        await provider.setLevel(externalId, seq[i], 0); // final restore must not be swallowed
      } else {
        await provider.setLevel(externalId, seq[i], 0).catch(() => {});
        await new Promise((r) => setTimeout(r, BLINK_STEP_MS));
      }
    }
  }

  #route(zoneId) {
    const zone = this.config.get().zones.find((z) => z.id === zoneId);
    if (!zone) throw new Error(`unknown zone ${zoneId}`);
    const source = zone.source ?? 'lutron';
    const provider = this.#providers.get(source);
    if (!provider) throw new Error(`no provider registered for source "${source}" (zone ${zoneId})`);
    return { provider, externalId: zone.externalId ?? zone.id };
  }

  #zoneByExternal(source, externalId) {
    return this.config.get().zones.find(
      (z) => (z.source ?? 'lutron') === source && (z.externalId ?? z.id) === externalId,
    ) ?? null;
  }

  #usedProviders() {
    const names = new Set(this.config.get().zones.map((z) => z.source ?? 'lutron'));
    return [...names].filter((n) => this.#providers.has(n));
  }
}
