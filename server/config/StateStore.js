import path from 'node:path';
import { JsonFileStore } from './JsonFileStore.js';

function defaultState() {
  return {
    zones: {},          // zoneId -> { expectedLevel, lastReportedLevel, latch }
    activeClusterId: null,
    lastCompileAt: null,
    failover: { active: false, activeSince: null },
    versionCheck: null, // { latest, url, notes, checkedAt } from the daily update check
    lastHeartbeat: null, // ISO; refreshed periodically so a boot can detect an outage
  };
}

/**
 * Owns data/state.json — volatile-ish runtime state. Everything here is
 * reconstructible from config + calendar EXCEPT enforcement latches, which
 * must survive a crash mid-Shabbos; callers persist those with
 * { flush: true }. Other writes are debounced to spare the Pi's microSD.
 */
export class StateStore {
  #store;
  #state;
  #timer = null;
  #debounceMs;

  constructor({ dataDir, debounceMs = 1000 }) {
    this.#store = new JsonFileStore(path.join(dataDir, 'state.json'));
    this.#debounceMs = debounceMs;
  }

  load() {
    const { data } = this.#store.load();
    this.#state = { ...defaultState(), ...(data ?? {}) };
    return this.#state;
  }

  get() {
    return this.#state;
  }

  zone(id) {
    const key = String(id);
    if (!this.#state.zones[key]) {
      this.#state.zones[key] = { expectedLevel: undefined, lastReportedLevel: undefined, latch: null };
    }
    return this.#state.zones[key];
  }

  /** Apply a mutation and schedule (or force) persistence. */
  save({ flush = false } = {}) {
    if (flush) {
      this.#flushNow();
    } else if (!this.#timer) {
      this.#timer = setTimeout(() => this.#flushNow(), this.#debounceMs);
      this.#timer.unref?.();
    }
  }

  #flushNow() {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    this.#store.save(this.#state);
  }

  /** For clean shutdown. */
  close() {
    this.#flushNow();
  }
}
