import { EventEmitter } from 'node:events';

const ECHO_WINDOW_MS = 5000;
const LEVEL_TOLERANCE = 1; // dimmer reports 74.99 for a commanded 75

/**
 * Tracks expected vs reported level per zone and separates the app's own
 * command echoes from genuine manual (wall-switch) changes.
 *
 * Echo suppression: before every app-issued command, expectCommand() records
 * a pending echo {level, until}. Incoming ~OUTPUT events matching a pending
 * echo (level within tolerance, inside the window) are absorbed; anything
 * else is emitted as 'deviation' for the EnforcementEngine. Fades produce
 * intermediate ~OUTPUT levels on some devices, so while a pending echo is
 * open, non-matching levels are held rather than flagged.
 *
 * Events: 'deviation' { zone, reported, expected }
 */
export class ZoneStateTracker extends EventEmitter {
  constructor({ stateStore, logger = null }) {
    super();
    this.state = stateStore;
    this.log = logger;
    this.pendingEchoes = new Map(); // zoneId -> [{ level, until }]
    // zoneId -> "reported:expected" last logged, so an unchanged standing
    // deviation (the bridge re-reports the same ~OUTPUT every ~20-30s) is
    // logged once, not on every repeat. In-memory only: a restart logs afresh.
    this.loggedDeviation = new Map();
  }

  /** Call immediately before sending any app-originated setLevel. */
  expectCommand(zone, level) {
    const z = this.state.zone(zone);
    z.expectedLevel = level;
    this.state.save();
    const list = this.pendingEchoes.get(zone) ?? [];
    list.push({ level, until: Date.now() + ECHO_WINDOW_MS });
    this.pendingEchoes.set(zone, list);
  }

  /** Update the expected level without a command (recompile refresh). */
  setExpected(zone, level) {
    const z = this.state.zone(zone);
    z.expectedLevel = level;
    this.state.save();
  }

  /**
   * Register an echo to absorb WITHOUT touching expectedLevel. For momentary
   * blinks (flash reminders, latch-confirm) whose toggles must be suppressed
   * but which must never redefine what level the zone is supposed to hold — the
   * final blink level is a transient, not the schedule's intent.
   */
  expectEcho(zone, level) {
    const list = this.pendingEchoes.get(zone) ?? [];
    list.push({ level, until: Date.now() + ECHO_WINDOW_MS });
    this.pendingEchoes.set(zone, list);
  }

  expected(zone) {
    return this.state.zone(zone).expectedLevel;
  }

  reported(zone) {
    return this.state.zone(zone).lastReportedLevel;
  }

  /** Feed every 'zoneLevel' event from LutronClient here. */
  onZoneLevel({ id, level }) {
    const z = this.state.zone(id);
    z.lastReportedLevel = level;
    this.state.save();

    const list = this.pendingEchoes.get(id) ?? [];
    const now = Date.now();
    const fresh = list.filter((e) => e.until > now);
    const matchIdx = fresh.findIndex((e) => Math.abs(e.level - level) <= LEVEL_TOLERANCE);
    if (matchIdx >= 0) {
      // our own command's echo — absorb it and everything queued before it
      this.pendingEchoes.set(id, fresh.slice(matchIdx + 1));
      return;
    }
    if (fresh.length > 0) {
      // a command is in flight (fade intermediate levels etc.) — hold judgment
      this.pendingEchoes.set(id, fresh);
      return;
    }
    this.pendingEchoes.delete(id);

    const expected = z.expectedLevel;
    if (expected !== undefined && Math.abs(level - expected) > LEVEL_TOLERANCE) {
      // Log once per distinct deviation; the emit stays unconditional so
      // enforcement sees every report (its counting/correction is unchanged).
      const sig = `${level}:${expected}`;
      if (this.loggedDeviation.get(id) !== sig) {
        this.log?.warn({ zone: id, reported: level, expected }, 'manual deviation detected');
        this.loggedDeviation.set(id, sig);
      }
      this.emit('deviation', { zone: id, reported: level, expected });
    } else {
      this.loggedDeviation.delete(id); // back in spec — a later deviation logs afresh
    }
  }
}
