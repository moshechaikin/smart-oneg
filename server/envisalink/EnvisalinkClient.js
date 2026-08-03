import net from 'node:net';
import { EventEmitter } from 'node:events';

// EnvisaLink TPI (Third Party Interface) client for an EyezOn EnvisaLink board
// (EVL-3 / EVL-4 / EVL-4EZR) bridging a DSC PowerSeries panel. The board speaks
// a line-based TCP protocol on port 4025: each frame is a 3-digit command, its
// data, a 2-hex-digit checksum, and CRLF. We only need a small slice — log in,
// arm (stay/away), disarm, toggle a zone bypass, and track partition state.
//
// A `mock: true` client skips the socket entirely and just updates its own
// state, so schedules/scenes/tests run without hardware.

/** DSC TPI checksum: low byte of the summed ASCII, two upper-hex digits. */
export function tpiChecksum(body) {
  let sum = 0;
  for (let i = 0; i < body.length; i++) sum += body.charCodeAt(i);
  return (sum & 0xff).toString(16).toUpperCase().padStart(2, '0');
}

/** Build a full TPI frame (command + data + checksum + CRLF). */
export function tpiFrame(cmd, data = '') {
  const body = `${cmd}${data}`;
  return `${body}${tpiChecksum(body)}\r\n`;
}

export class EnvisalinkClient extends EventEmitter {
  #socket = null;
  #buf = '';
  #reconnectTimer = null;
  #closed = false;
  #partitionState = new Map(); // partition -> 'armed' | 'disarmed' | 'unknown'
  #bypassed = new Set();       // zone numbers we've toggled into bypass (TPI has no bypass read-back)

  connected = false;

  constructor({ host, port = 4025, password, code, partition = 1, mock = false, logger } = {}) {
    super();
    this.host = host;
    this.port = Number(port) || 4025;
    this.password = String(password ?? '');
    this.code = String(code ?? '');
    this.partition = String(partition || 1);
    this.mock = Boolean(mock);
    this.log = logger;
  }

  async connect() {
    if (this.mock) {
      this.connected = true;
      this.emit('connected');
      this.emit('ready');
      return;
    }
    this.#closed = false;
    await new Promise((resolve) => this.#open(resolve));
  }

  #open(resolve) {
    const sock = net.connect({ host: this.host, port: this.port });
    this.#socket = sock;
    sock.setEncoding('ascii');
    sock.on('connect', () => { this.log?.info?.({ host: this.host }, 'envisalink connected — awaiting login'); resolve?.(); });
    sock.on('data', (chunk) => this.receive(chunk));
    sock.on('error', (e) => this.log?.warn?.({ err: e.message }, 'envisalink socket error'));
    sock.on('close', () => {
      this.connected = false;
      this.emit('disconnected');
      if (!this.#closed) this.#scheduleReconnect();
    });
  }

  #scheduleReconnect() {
    clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = setTimeout(() => this.#open(), 5000);
    this.#reconnectTimer.unref?.();
  }

  close() {
    this.#closed = true;
    clearTimeout(this.#reconnectTimer);
    this.#socket?.destroy();
    this.#socket = null;
    this.connected = false;
  }

  /** Feed raw bytes from the board (public so tests can drive the parser). */
  receive(chunk) {
    this.#buf += chunk;
    let idx;
    while ((idx = this.#buf.indexOf('\r\n')) >= 0) {
      const line = this.#buf.slice(0, idx);
      this.#buf = this.#buf.slice(idx + 2);
      if (line) this.#handle(line);
    }
  }

  #handle(line) {
    const cmd = line.slice(0, 3);
    const data = line.slice(3, line.length - 2); // strip trailing checksum
    switch (cmd) {
      case '505': // login interaction: 0=fail, 1=success, 2=timeout, 3=password requested
        if (data[0] === '3') this.#write(tpiFrame('005', this.password));
        else if (data[0] === '1') {
          this.connected = true;
          this.emit('connected');
          this.emit('ready');
          this.#write(tpiFrame('001')); // ask for a full status dump
        } else if (data[0] === '0' || data[0] === '2') this.emit('login-failed');
        break;
      case '652': // partition armed (data: partition + arm-mode digit)
      case '654': // partition in alarm — still armed
        this.#setPartition(data[0], 'armed');
        break;
      case '655': // partition disarmed
        this.#setPartition(data[0], 'disarmed');
        this.#bypassed.clear(); // disarming clears any bypasses on the panel
        break;
      default:
        break;
    }
    this.emit('raw', line);
  }

  #setPartition(part, state) {
    part = String(part);
    if (this.#partitionState.get(part) === state) return;
    this.#partitionState.set(part, state);
    this.emit('partition', { partition: part, state });
  }

  #write(frame) { this.#socket?.write(frame); }

  /** Send a command; in mock mode, apply the optimistic effect immediately. */
  #command(frame, mockEffect) {
    if (this.mock) { mockEffect?.(); return; }
    this.#write(frame);
  }

  // ── state ──────────────────────────────────────────────────────────────
  partitionState(part = this.partition) { return this.#partitionState.get(String(part)) ?? 'unknown'; }
  isBypassed(zone) { return this.#bypassed.has(Number(zone)); }

  // ── control ────────────────────────────────────────────────────────────
  armStay(part = this.partition) { this.#command(tpiFrame('031', String(part)), () => this.#setPartition(part, 'armed')); }
  armAway(part = this.partition) { this.#command(tpiFrame('030', String(part)), () => this.#setPartition(part, 'armed')); }
  armNight(part = this.partition) { this.#command(tpiFrame('032', String(part)), () => this.#setPartition(part, 'armed')); }
  disarm(part = this.partition) {
    this.#command(tpiFrame('040', `${part}${this.code}`), () => { this.#setPartition(part, 'disarmed'); this.#bypassed.clear(); });
  }

  /** Toggle a zone into bypass. On DSC `*1<zone>#` is a toggle, so callers
   *  should only invoke this when the desired state differs from current. */
  setBypass(zone, bypassed, part = this.partition) {
    if (this.isBypassed(zone) === Boolean(bypassed)) return; // already there
    const zz = String(zone).padStart(2, '0');
    this.#command(tpiFrame('071', `${part}*1${zz}#`), () => {});
    if (bypassed) this.#bypassed.add(Number(zone)); else this.#bypassed.delete(Number(zone));
    this.emit('bypass', { zone: Number(zone), bypassed: Boolean(bypassed) });
  }
}
