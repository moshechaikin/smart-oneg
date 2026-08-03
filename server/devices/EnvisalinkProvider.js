import { EventEmitter } from 'node:events';
import { EnvisalinkClient } from '../envisalink/EnvisalinkClient.js';

// Bridges an EnvisaLink alarm board into the DeviceBus as on/off "devices", so
// arm/disarm and per-zone bypass ride the normal setLevel path (schedules,
// scenes, Child Lock all work unchanged). External IDs:
//   partition:<n>  — on = arm (stay), off = disarm
//   bypass:<zone>  — on = bypass that zone, off = restore it
//
// The Shabbos use case is scheduling bypass on interior/motion zones at candle
// lighting and restoring them after havdalah.
export class EnvisalinkProvider extends EventEmitter {
  constructor({ host, port, password, code, partition, mock = false, armMode = 'stay', logger } = {}) {
    super();
    this.armMode = armMode; // 'stay' | 'away' | 'night'
    this.client = new EnvisalinkClient({ host, port, password, code, partition, mock, logger });
    this.client.on('partition', ({ partition: p, state }) => {
      this.emit('zoneLevel', { id: `partition:${p}`, level: state === 'armed' ? 100 : 0 });
    });
    this.client.on('bypass', ({ zone, bypassed }) => {
      this.emit('zoneLevel', { id: `bypass:${zone}`, level: bypassed ? 100 : 0 });
    });
    this.client.on('disconnected', () => this.emit('disconnected'));
  }

  get connected() { return this.client.connected; }

  async connect() {
    await this.client.connect();
    this.emit('connected');
    this.emit('ready');
  }

  close() { this.client.close(); }

  #arm(part) {
    if (this.armMode === 'away') this.client.armAway(part);
    else if (this.armMode === 'night') this.client.armNight(part);
    else this.client.armStay(part);
  }

  async setLevel(externalId, level, _fadeSec = 0) {
    const [kind, id] = String(externalId).split(':');
    const on = Number(level) > 0;
    if (kind === 'partition') {
      if (on) this.#arm(id || this.client.partition); else this.client.disarm(id || this.client.partition);
      this.emit('zoneLevel', { id: externalId, level: on ? 100 : 0 });
    } else if (kind === 'bypass') {
      this.client.setBypass(id, on);
      this.emit('zoneLevel', { id: externalId, level: on ? 100 : 0 });
    }
  }

  async queryLevel(externalId) {
    const [kind, id] = String(externalId).split(':');
    if (kind === 'partition') return this.client.partitionState(id || this.client.partition) === 'armed' ? 100 : 0;
    if (kind === 'bypass') return this.client.isBypassed(id) ? 100 : 0;
    return 0;
  }
}
