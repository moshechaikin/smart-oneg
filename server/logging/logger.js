import fs from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import pino from 'pino';

const RING_SIZE = 5000;

// Fields worth scrubbing from a shared log file (values only — keys stay so the
// log is still readable). IPs and emails are matched by shape; a handful of
// secret-bearing JSON keys are matched by name (hostnames aren't IPs).
const SECRET_LOG_KEYS = 'host|url|password|passwordHash|syncToken|token|appPassword|sessionSecret|accessToken|refreshToken|apiKey|vapidPrivateKey|code|pin|topic|username';
/** Redact IPs, emails and secret values from raw log text for a shareable download. */
export function redactLogText(text) {
  return String(text)
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '‹email›')
    .replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, '‹ip›')
    .replace(/\b(?:[A-Fa-f0-9]{1,4}:){2,7}[A-Fa-f0-9]{1,4}\b/g, '‹ip›') // IPv6 / MAC
    .replace(new RegExp(`("(?:${SECRET_LOG_KEYS})"\\s*:\\s*)"[^"]*"`, 'gi'), '$1"‹redacted›"');
}

/**
 * Prefix each JSON log line with its human-readable level (ERROR, WARN, INFO,
 * DEBUG…) for a downloaded/saved log, so a person can grep by severity without
 * knowing pino's numeric levels (30 = info, 40 = warn…). The on-disk app.log
 * stays pure JSONL — the app parses it — so this only decorates the download.
 * Padded to a fixed width so the JSON stays column-aligned.
 */
export function labelLogText(text) {
  return String(text).split('\n').map((line) => {
    if (!line) return line;
    let level;
    try { level = JSON.parse(line).level; } catch { return line; } // leave non-JSON lines untouched
    return `${(pino.levels.labels[level] ?? 'log').toUpperCase().padEnd(5)} ${line}`;
  }).join('\n');
}

/**
 * Entry times are ISO strings in NEW log lines (human-readable when scrolling
 * the raw file / docker logs / a download) but epoch ms in files written
 * before the switch — normalize wherever we compare.
 */
export const logTimeMs = (t) => (typeof t === 'number' ? t : Date.parse(t));

/**
 * Fixed-size ring buffer of parsed log entries. Powers the /api/logs search
 * endpoint and the SSE live stream without touching disk.
 */
export class LogRing {
  #entries = [];
  #subscribers = new Set();

  push(entry) {
    this.#entries.push(entry);
    if (this.#entries.length > RING_SIZE) this.#entries.shift();
    for (const fn of this.#subscribers) {
      try { fn(entry); } catch { /* subscriber errors must never break logging */ }
    }
  }

  /** @returns {Array} newest-last entries matching the filters */
  query({ q, level, from, to, limit = 500 } = {}) {
    let out = this.#entries;
    if (level) out = out.filter((e) => e.level >= pino.levels.values[level]);
    if (from) out = out.filter((e) => logTimeMs(e.time) >= new Date(from).getTime());
    if (to) out = out.filter((e) => logTimeMs(e.time) <= new Date(to).getTime());
    if (q) {
      const needle = q.toLowerCase();
      out = out.filter((e) => JSON.stringify(e).toLowerCase().includes(needle));
    }
    return out.slice(-limit);
  }

  subscribe(fn) {
    this.#subscribers.add(fn);
    return () => this.#subscribers.delete(fn);
  }
}

class RingStream extends Writable {
  constructor(ring) {
    super({ decodeStrings: false });
    this.ring = ring;
  }

  _write(chunk, _enc, cb) {
    for (const line of chunk.toString().split('\n')) {
      if (!line) continue;
      try { this.ring.push(JSON.parse(line)); } catch { /* non-JSON line */ }
    }
    cb();
  }
}

/**
 * Create the application logger: pino writing to both a rolling file under
 * `dir` and an in-memory ring buffer.
 */
export function createLogger({ dir, level = 'debug', fileEnabled = true } = {}) {
  const ring = new LogRing();
  const streams = [
    { stream: new RingStream(ring), level: 'trace' },
    // stdout so `docker logs` / OrbStack show activity (info+ to keep it readable)
    { stream: process.stdout, level: 'info' },
  ];

  if (fileEnabled && dir) {
    fs.mkdirSync(dir, { recursive: true });
    // pino-roll is async-loaded via transport; use a plain append stream here so
    // the logger is usable synchronously at boot. Rotation is handled by size
    // check on boot + date suffix (see rotateOnBoot).
    rotateOnBoot(dir);
    // ./data/logs persists across container restarts — replay the recent tail
    // into the ring so the in-app Logs page shows history after a restart
    // (invaluable for debugging a crash/reboot), not an empty page.
    preloadRing(dir, ring);
    streams.push({ stream: fs.createWriteStream(path.join(dir, 'app.log'), { flags: 'a' }), level: 'debug' });
  }

  // ISO timestamps so every raw line is human-readable — in app.log, docker
  // logs, and downloads — not just in the app's log viewer (epoch ms told a
  // person nothing while scrolling a file). Consumers normalize via logTimeMs.
  const logger = pino({ level, timestamp: pino.stdTimeFunctions.isoTime }, pino.multistream(streams));
  return { logger, ring, logDir: dir };
}

/**
 * Read a page of log entries from app.log for scroll-back beyond the in-memory
 * ring. Scans lines from the END backward, collecting up to `limit` entries
 * older than `before` (ms) that match the level/text filters — so the cost is
 * bounded by how deep the user has scrolled, not the whole file. Returns them
 * oldest-first. app.log holds far more history than the 5000-entry ring.
 */
export function readLogPage(dir, { before = null, level = null, q = null, limit = 500 } = {}) {
  let lines;
  try {
    lines = fs.readFileSync(path.join(dir, 'app.log'), 'utf8').split('\n');
  } catch { return []; }
  const levelMin = level ? (pino.levels.values[level] ?? 0) : 0;
  const needle = q ? String(q).toLowerCase() : null;
  const out = [];
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    if (!lines[i]) continue;
    let e; try { e = JSON.parse(lines[i]); } catch { continue; }
    if (before != null && !(logTimeMs(e.time) < before)) continue;
    if (levelMin && e.level < levelMin) continue;
    if (needle && !JSON.stringify(e).toLowerCase().includes(needle)) continue;
    out.push(e);
  }
  return out.reverse();
}

/** Replay the tail of app.log into the ring so logs survive a restart in-app. */
function preloadRing(dir, ring, max = 3000) {
  try {
    const lines = fs.readFileSync(path.join(dir, 'app.log'), 'utf8').split('\n').filter(Boolean).slice(-max);
    for (const line of lines) { try { ring.push(JSON.parse(line)); } catch { /* skip non-JSON */ } }
  } catch { /* no existing log file */ }
}

const MAX_LOG_BYTES = 20 * 1024 * 1024;
const KEEP_ROTATED = 10;

function rotateOnBoot(dir) {
  const file = path.join(dir, 'app.log');
  try {
    const st = fs.statSync(file);
    if (st.size > MAX_LOG_BYTES) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      fs.renameSync(file, path.join(dir, `app-${stamp}.log`));
      const rotated = fs.readdirSync(dir).filter((f) => f.startsWith('app-')).sort();
      for (const old of rotated.slice(0, Math.max(0, rotated.length - KEEP_ROTATED))) {
        fs.unlinkSync(path.join(dir, old));
      }
    }
  } catch { /* no existing log */ }
}
