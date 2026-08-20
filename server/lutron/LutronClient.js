import net from 'node:net';
import { EventEmitter } from 'node:events';
import { buildSetLevel, buildQueryLevel, parseLine } from './protocol.js';

const PROMPT_RE = /GNET>\s*$/;

/**
 * GNET/LIP telnet client for the Caséta Smart Bridge Pro.
 *
 * - Serialized command queue (one in-flight command; the bridge interleaves
 *   responses otherwise).
 * - Emits 'zoneLevel' {id, level} for every ~OUTPUT line — both command echoes
 *   and wall-switch monitor events; ZoneStateTracker does the echo-dedup.
 * - Reconnects forever with jittered exponential backoff; after reconnect the
 *   caller re-primes zones (the bridge only reports zones touched this session).
 * - No flash here: the bridge rejects action 5 (verified on hardware), so
 *   blinking lives in DeviceBus.flash as plain setLevel toggles.
 *
 * Events: connected, ready(after prime), disconnected, zoneLevel, commandError
 */
export class LutronClient extends EventEmitter {
  #socket = null;
  #buf = '';
  #phase = 'idle'; // idle | connecting | auth | ready | closed
  #queue = [];
  #inflight = null;
  #backoffMs = 1000;
  #reconnectTimer = null;
  #keepaliveTimer = null;
  #lastTraffic = 0;
  #missedKeepalives = 0;
  #authResolve = null;
  #authReject = null;

  constructor({ host, port = 23, username = 'lutron', password = 'integration',
    zoneIds = [], logger = null,
    // keepaliveMs: probe an idle link this often; a silent drop is caught after
    // ~2 missed probes (~40s). maxBackoffMs: retry at least this often, so the
    // link comes back quickly after the network returns.
    commandTimeoutMs = 5000, keepaliveMs = 20_000, maxBackoffMs = 20_000, errorGraceMs = 60,
    primeDelayMs = 0 }) {
    super();
    this.host = host;
    this.port = port;
    this.username = username;
    this.password = password;
    this.zoneIds = zoneIds;
    this.log = logger;
    this.commandTimeoutMs = commandTimeoutMs;
    this.keepaliveMs = keepaliveMs;
    this.maxBackoffMs = maxBackoffMs;
    this.errorGraceMs = errorGraceMs;
    this.primeDelayMs = primeDelayMs;
  }

  get connected() {
    return this.#phase === 'ready';
  }

  async connect() {
    if (this.#phase === 'ready' || this.#phase === 'connecting' || this.#phase === 'auth') return;
    this.#phase = 'connecting';
    await new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port });
      this.#socket = socket;
      // Detect a silently-dropped connection (Wi-Fi off, bridge unplugged) far
      // sooner: OS TCP keepalive probes after 15s idle as a backstop, and
      // TCP_NODELAY sends commands immediately (no Nagle buffering).
      socket.setKeepAlive(true, 15_000);
      socket.setNoDelay(true);
      const fail = (err) => { socket.destroy(); reject(err); };
      socket.once('error', fail);
      socket.once('connect', () => {
        this.#phase = 'auth';
        this.#authResolve = resolve;
        this.#authReject = reject;
      });
      socket.on('data', (chunk) => this.#onData(chunk));
      socket.on('close', () => this.#onClose());
      socket.setTimeout(10_000, () => {
        if (this.#phase === 'connecting' || this.#phase === 'auth') fail(new Error('connect timeout'));
      });
    });
    this.#backoffMs = 1000;
    this.#missedKeepalives = 0;
    this.#startKeepalive();
    this.log?.info({ host: this.host }, 'lutron connected');
    this.emit('connected');
    // The real bridge dumps every zone's state right after login; querying
    // during that burst can time out (seen on hardware). Let it settle first.
    if (this.primeDelayMs > 0) await sleep(this.primeDelayMs);
    await this.primeAllZones();
    // the link can drop during the settle/prime — only announce ready if it
    // is still up (reconnect is already scheduled by #onClose in that case)
    if (this.#phase === 'ready') this.emit('ready');
  }

  /** Graceful shutdown / standby release. No auto-reconnect afterward. */
  close() {
    this.#phase = 'closed';
    clearTimeout(this.#reconnectTimer);
    clearInterval(this.#keepaliveTimer);
    this.#socket?.destroy();
    this.#flushQueue(new Error('client closed'));
  }

  async setLevel(id, level, fadeSec = 0) {
    await this.#exec({ kind: 'set', line: buildSetLevel(id, level, fadeSec), zoneId: id });
  }

  async queryLevel(id) {
    return this.#exec({ kind: 'query', line: buildQueryLevel(id), zoneId: id });
  }

  async primeAllZones() {
    const levels = new Map();
    for (const id of this.zoneIds) {
      try {
        levels.set(id, await this.queryLevel(id));
      } catch (err) {
        this.log?.warn({ id, err: err.message }, 'zone prime failed');
      }
    }
    return levels;
  }

  // ── internals ────────────────────────────────────────────────────────────

  #exec(cmd) {
    if (this.#phase !== 'ready') return Promise.reject(new Error('not connected'));
    return new Promise((resolve, reject) => {
      this.#queue.push({ ...cmd, resolve, reject, result: undefined, error: null, gotPrompt: false, gotResponse: false });
      this.#pump();
    });
  }

  #pump() {
    if (this.#inflight || this.#queue.length === 0 || this.#phase !== 'ready') return;
    const cmd = this.#queue.shift();
    this.#inflight = cmd;
    this.log?.debug({ tx: cmd.line }, 'lutron tx');
    this.#socket.write(`${cmd.line}\r\n`);
    cmd.timer = setTimeout(() => this.#onTimeout(cmd), this.commandTimeoutMs);
  }

  // No in-client retry: a resend after a merely-slow prompt would leave a
  // second prompt in the stream and desynchronize the one-prompt-per-command
  // pairing that #settle relies on. Higher layers reconcile state instead.
  #onTimeout(cmd) {
    if (this.#inflight !== cmd) return;
    this.#inflight = null;
    cmd.reject(new Error(`command timed out: ${cmd.line}`));
    this.emit('commandError', { line: cmd.line, error: 'timeout' });
    this.#pump();
  }

  /**
   * The bridge answers every submitted line with exactly one GNET> prompt
   * plus, for queries/errors, a response line — but the ORDER varies: the
   * real Smart Bridge Pro sends the prompt immediately and the ~OUTPUT/~ERROR
   * a few ms later (verified on hardware 2026-07-06), while classic stacks
   * respond then prompt. So:
   *  - queries settle once they have BOTH prompt and response/error;
   *  - sets settle on prompt+error immediately, or prompt + a short grace
   *    window (errorGraceMs) in which a late ~ERROR can still reject them.
   * One-prompt-per-command consumption keeps pairing exact; a response that
   * arrives after timeout simply becomes a monitor event.
   */
  #maybeSettle(cmd) {
    if (this.#inflight !== cmd || !cmd.gotPrompt) return;
    if (cmd.error) return this.#finish(cmd);
    if (cmd.kind === 'query') {
      if (!cmd.gotResponse) return;
      return this.#finish(cmd);
    }
    if (!cmd.graceTimer) {
      cmd.graceTimer = setTimeout(() => this.#finish(cmd), this.errorGraceMs);
    }
  }

  #finish(cmd) {
    if (this.#inflight !== cmd) return;
    clearTimeout(cmd.timer);
    clearTimeout(cmd.graceTimer);
    this.#inflight = null;
    if (cmd.error) cmd.reject(cmd.error); else cmd.resolve(cmd.result);
    this.#pump();
  }

  #onData(chunk) {
    this.#lastTraffic = Date.now();
    this.#missedKeepalives = 0;
    this.#buf += chunk.toString();

    if (this.#phase === 'auth') {
      if (/login:\s*$/i.test(this.#buf)) {
        this.#buf = '';
        this.#socket.write(`${this.username}\r\n`);
      } else if (/password:\s*$/i.test(this.#buf)) {
        this.#buf = '';
        this.#socket.write(`${this.password}\r\n`);
      } else if (this.#buf.includes('GNET>')) {
        this.#buf = '';
        this.#phase = 'ready';
        this.#authResolve?.();
      } else if (/bad login/i.test(this.#buf)) {
        this.#authReject?.(new Error('lutron authentication failed'));
        this.#socket.destroy();
      }
      return;
    }

    let idx;
    while ((idx = this.#buf.search(/\r\n|\n|\r/)) >= 0) {
      const raw = this.#buf.slice(0, idx);
      this.#buf = this.#buf.slice(idx + (this.#buf[idx] === '\r' && this.#buf[idx + 1] === '\n' ? 2 : 1));
      this.#onLine(raw);
    }
    if (PROMPT_RE.test(this.#buf)) {
      this.#buf = this.#buf.replace(PROMPT_RE, '');
      this.#onPrompt();
    }
  }

  #onLine(raw) {
    const msg = parseLine(raw);
    if (!msg) return;
    this.log?.debug({ rx: raw }, 'lutron rx');

    if (msg.type === 'output' && msg.action === 1 && msg.level !== null) {
      this.emit('zoneLevel', { id: msg.id, level: msg.level });
      const cmd = this.#inflight;
      if (cmd?.kind === 'query' && cmd.zoneId === msg.id) {
        cmd.result = msg.level;
        cmd.gotResponse = true;
        this.#maybeSettle(cmd);
      }
    } else if (msg.type === 'error') {
      const cmd = this.#inflight;
      if (cmd) {
        cmd.error = new Error(`${msg.message} for: ${cmd.line}`);
        this.#maybeSettle(cmd);
      } else this.emit('commandError', { error: msg.message });
    }
  }

  #onPrompt() {
    const cmd = this.#inflight;
    if (cmd && !cmd.gotPrompt) {
      cmd.gotPrompt = true;
      this.#maybeSettle(cmd);
    }
  }

  #onClose() {
    const wasReady = this.#phase === 'ready';
    clearInterval(this.#keepaliveTimer);
    if (this.#phase === 'closed') return;
    this.#phase = 'idle';
    this.#flushQueue(new Error('connection lost'));
    if (wasReady) {
      this.log?.warn('lutron disconnected');
      this.emit('disconnected');
    }
    this.#scheduleReconnect();
  }

  #flushQueue(err) {
    if (this.#inflight) {
      clearTimeout(this.#inflight.timer);
      this.#inflight.reject(err);
      this.#inflight = null;
    }
    for (const cmd of this.#queue.splice(0)) cmd.reject(err);
  }

  #scheduleReconnect() {
    clearTimeout(this.#reconnectTimer);
    const delay = this.#backoffMs + Math.random() * this.#backoffMs * 0.3;
    this.#backoffMs = Math.min(this.#backoffMs * 2, this.maxBackoffMs);
    this.#reconnectTimer = setTimeout(async () => {
      if (this.#phase !== 'idle') return;
      try {
        await this.connect();
      } catch (err) {
        this.log?.warn({ err: err.message }, 'lutron reconnect failed');
        this.#phase = 'idle';
        this.#scheduleReconnect();
      }
    }, delay);
    this.#reconnectTimer.unref?.();
  }

  #startKeepalive() {
    clearInterval(this.#keepaliveTimer);
    this.#keepaliveTimer = setInterval(async () => {
      if (this.#phase !== 'ready') return;
      if (Date.now() - this.#lastTraffic < this.keepaliveMs) return;
      const probe = this.zoneIds[0];
      if (probe === undefined) return;
      try {
        await this.queryLevel(probe);
      } catch {
        this.#missedKeepalives += 1;
        if (this.#missedKeepalives >= 2) {
          this.log?.warn('keepalive failed twice, forcing reconnect');
          this.#socket?.destroy();
        }
      }
    }, Math.max(1000, this.keepaliveMs / 2));
    this.#keepaliveTimer.unref?.();
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
