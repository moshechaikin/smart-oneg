import { EventEmitter } from 'node:events';

/**
 * Provider for manually-added ("virtual") devices — no hub required.
 * Levels live in memory; commands succeed instantly and emit the same
 * zoneLevel events real hardware would. Useful for planning schedules before
 * buying hardware, dry-running a setup, and demos.
 */
export class VirtualProvider extends EventEmitter {
  levels = new Map();
  connected = true;

  async connect() {
    this.connected = true;
    this.emit('connected');
    this.emit('ready');
  }

  close() { /* nothing to release; stays "connected" */ }

  async setLevel(externalId, level, _fadeSec = 0) {
    this.levels.set(Number(externalId), level);
    this.emit('zoneLevel', { id: Number(externalId), level });
  }

  async queryLevel(externalId) {
    return this.levels.get(Number(externalId)) ?? 0;
  }
}
