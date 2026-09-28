import { EventEmitter } from 'node:events';

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 60_000;
const MAX_BODY_LOG = 300;

/**
 * Outbound HTTP calls as a "device".
 *
 * A webhook zone holds a list of NAMED CALLS (see schema.js `zone.webhook`),
 * and a rule or scene member picks one by id — the same shape as a thermostat
 * preset, not an on/off level. There is no such thing as a webhook being "on":
 * a call either fires or it doesn't.
 *
 * Deliberately momentary (see engine/zoneKinds.js): never reconciled, never
 * re-fired on boot/reconnect/takeover, never retried. The app cannot read the
 * remote system's state, so it can never know whether a resync is warranted —
 * and calling a non-idempotent endpoint a second time is the worse failure.
 * At most once, at its scheduled time, or not at all.
 *
 * Holds no connection, so `connected` is always true: there is nothing to be
 * disconnected FROM, and reporting false would make the whole bus look down.
 */
export class WebhookProvider extends EventEmitter {
  constructor({ configStore, logger = null, fetchImpl = null } = {}) {
    super();
    this.config = configStore;
    this.log = logger;
    // injectable for tests; falls back to global fetch at call time so a test
    // can stub globalThis.fetch after construction
    this.fetchImpl = fetchImpl;
  }

  get connected() {
    return true;
  }

  async connect() { /* nothing to open */ }

  close() { /* nothing to close */ }

  /** Webhooks hold no level; nothing to query. */
  async queryLevel() {
    return undefined;
  }

  /** The zone config for an external id (which for webhooks is the zone id). */
  #zone(externalId) {
    const zone = this.config.get().zones.find(
      (z) => (z.source ?? 'lutron') === 'webhook' && (z.externalId ?? z.id) === externalId,
    );
    if (!zone) throw new Error(`no webhook device for ${externalId}`);
    return zone;
  }

  /** Look up one named call on a webhook zone. */
  static findCall(zone, callId) {
    const calls = zone?.webhook?.calls ?? [];
    if (!calls.length) throw new Error(`webhook "${zone?.friendlyName ?? zone?.id}" has no calls configured`);
    // No implicit "first call" fallback: a rule whose call was deleted must
    // fail loudly rather than silently fire a DIFFERENT endpoint.
    const call = calls.find((c) => c.id === callId);
    if (!call) throw new Error(`webhook call "${callId}" not found on "${zone.friendlyName ?? zone.id}"`);
    return call;
  }

  /**
   * Build the request for a call. Split out so the "Test" button and the
   * scheduler send byte-identical requests.
   */
  static buildRequest(zone, call) {
    const wh = zone.webhook ?? {};
    const method = (call.method ?? 'POST').toUpperCase();
    const headers = {};
    for (const h of wh.headers ?? []) if (h?.name) headers[h.name] = String(h.value ?? '');
    for (const h of call.headers ?? []) if (h?.name) headers[h.name] = String(h.value ?? '');
    const auth = wh.auth ?? { kind: 'none' };
    if (auth.kind === 'bearer' && auth.token) headers.Authorization = `Bearer ${auth.token}`;
    else if (auth.kind === 'basic' && auth.username) {
      headers.Authorization = `Basic ${Buffer.from(`${auth.username}:${auth.password ?? ''}`).toString('base64')}`;
    } else if (auth.kind === 'header' && auth.headerName) headers[auth.headerName] = String(auth.headerValue ?? '');
    // GET/HEAD carry no body; anything else sends one only if configured
    const hasBody = !['GET', 'HEAD'].includes(method) && call.body != null && call.body !== '';
    if (hasBody && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
      headers['Content-Type'] = call.contentType ?? 'application/json';
    }
    return { method, url: call.url, headers, body: hasBody ? String(call.body) : undefined };
  }

  /**
   * Fire a named call. Resolves with a small result summary; rejects with a
   * readable message so the scheduler's action-failed notification is useful.
   */
  async callWebhook(externalId, callId) {
    const zone = this.#zone(externalId);
    const call = WebhookProvider.findCall(zone, callId);
    return this.#send(zone, call);
  }

  /** Fire an arbitrary call object against a zone's auth/headers (Test button). */
  async testCall(zone, call) {
    return this.#send(zone, call);
  }

  async #send(zone, call) {
    const req = WebhookProvider.buildRequest(zone, call);
    if (!req.url) throw new Error(`webhook call "${call.name ?? call.id}" has no URL`);
    const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(1000, zone.webhook?.timeoutMs ?? DEFAULT_TIMEOUT_MS));
    const doFetch = this.fetchImpl ?? globalThis.fetch;
    // A hung request would hold this zone's write lock for as long as the
    // remote takes, so the timeout is not optional.
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    const startedAt = Date.now();
    try {
      const res = await doFetch(req.url, {
        method: req.method, headers: req.headers, body: req.body, signal: ac.signal, redirect: 'follow',
      });
      const ms = Date.now() - startedAt;
      let text = '';
      try { text = (await res.text()).slice(0, MAX_BODY_LOG); } catch { /* body is optional */ }
      if (!res.ok) {
        const err = new Error(`${req.method} ${req.url} → HTTP ${res.status}${text ? `: ${text.slice(0, 120)}` : ''}`);
        err.status = res.status;
        err.responseBody = text;
        throw err;
      }
      this.log?.info({ zone: zone.id, call: call.name ?? call.id, status: res.status, ms }, 'webhook called');
      return { ok: true, status: res.status, ms, body: text };
    } catch (err) {
      if (err.name === 'AbortError') {
        throw new Error(`${req.method} ${req.url} timed out after ${timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Momentary guard. Nothing in the app should drive a webhook by level, but
   * the DeviceBus surface requires setLevel — so make a mistaken call loud
   * instead of silently firing an arbitrary endpoint.
   */
  async setLevel(externalId) {
    throw new Error(`webhook device ${externalId} is driven by named calls, not levels`);
  }
}
