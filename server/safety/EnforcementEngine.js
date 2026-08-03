import { EventEmitter } from 'node:events';
import { blinkLevels } from '../devices/DeviceBus.js';
import { ZoneLock } from '../engine/ZoneLock.js';
import { driveZone } from '../engine/driveZone.js';

// The override "window" is the maximum gap allowed BETWEEN two consecutive
// presses for the second to keep counting toward the manual-hold threshold.
// It's rolling — measured from the LAST press — so it only has to cover one
// "flip, wait for the restore, flip again" cycle, never the whole sequence. So
// we DERIVE it from the grace delay plus this reaction buffer instead of a
// fixed number: gaps longer than this (a press today and another tomorrow)
// reset the count, so presses spread across a day/Yom Tov never accumulate.
const OVERRIDE_GAP_BUFFER_SEC = 25;

/**
 * Child-safety enforcement: reacts to manual wall-switch deviations reported
 * by ZoneStateTracker while a Shabbos/YT cluster is active.
 *
 * Per-zone FSM: IN_SYNC -> DEVIATED (grace timer) -> corrected back, with an
 * override counter implementing the non-Jew's escape hatch: N manual presses
 * inside the override window latch the zone to its manual state until the
 * cluster ends, confirmed by two blinks. Latches persist to state.json
 * immediately (must survive a crash mid-Shabbos).
 *
 * TEST MODE is a dry run: the override is still DEMONSTRATED (the zone holds at
 * its manual level for the rehearsal, plus the two-blink confirm), but the latch
 * is ephemeral — never written to state.json, so it can never pause the REAL
 * schedule or survive test-mode exit / a restart. The notification is a clearly
 * marked mock (see index.js / buildMessage). Everything else runs unchanged so
 * the rehearsal is faithful.
 *
 * The whole feature is opt-in: enforcement.enabled AND per-zone enforce flag.
 *
 * Events: 'corrected' {zone,to}, 'latched' {zone,level,until,test}, 'latch-cleared' {zone}
 */
export class EnforcementEngine extends EventEmitter {
  #graceTimers = new Map();   // zone -> timeout
  #overrides = new Map();     // zone -> { count, lastAt }
  #testLatches = new Map();   // zone -> { level, until } — ephemeral, test-mode only, never persisted
  #activeCluster = null;
  #enforceFromMs = null;      // early-Shabbos boundary (defaults to cluster start)

  constructor({
    configStore, stateStore, tracker, lutron, logger = null, now = () => Date.now(), canAct = () => true, isTestMode = () => false,
    // The per-zone write lock (see ZoneLock.js) — corrections here must never
    // race a concurrent reconcile/catch-up/fired-action write to the SAME
    // zone, or whichever wrote last would win even if stale. This instance is
    // the ORIGIN of the shared lock: the Scheduler ADOPTS it from the
    // enforcement object it's constructed with, so the sharing needs no
    // separate wiring and cannot be forgotten. Explicit injection remains for
    // tests that stage cross-class races.
    zoneLock = new ZoneLock(),
  }) {
    super();
    this.config = configStore;
    this.state = stateStore;
    this.tracker = tracker;
    this.lutron = lutron;
    this.log = logger;
    this.now = now;
    this.zoneLock = zoneLock;
    // Drive-authority: false on an inactive standby. Belt-and-suspenders — the
    // device layer is already dormant there (no bridge, so no deviations), but
    // this guarantees enforcement never corrects/latches/notifies unless in
    // control, no matter how a deviation might arrive.
    this.canAct = canAct;
    // True while the scheduler runs on a virtual (test-mode) clock. When set,
    // overrides are demonstrated but never persisted (see #latch).
    this.isTestMode = isTestMode;
    tracker.on('deviation', (d) => this.onDeviation(d));
  }

  /**
   * Enforcement must judge "are we inside the cluster?" on the same clock the
   * scheduler runs on — in test mode that's the virtual clock, otherwise
   * Child Lock is dead during test mode (cluster start is real-future).
   */
  setClock(now) {
    this.now = now;
  }

  setActiveCluster(cluster, enforceFromMs = null) {
    this.#activeCluster = cluster;
    this.#enforceFromMs = enforceFromMs;
    if (!cluster) this.clearExpiredLatches(this.now());
  }

  isLatched(zone) {
    // In test mode only the ephemeral latch applies — a real (persisted) latch
    // can't be active anyway (test mode refuses to start during real coverage),
    // and ignoring it keeps a stale one from bleeding into the rehearsal.
    if (this.isTestMode()) {
      const t = this.#testLatches.get(zone);
      if (!t) return false;
      if (t.until && this.now() > new Date(t.until).getTime()) {
        this.#testLatches.delete(zone);
        return false;
      }
      return true;
    }
    const latch = this.state.zone(zone).latch;
    if (!latch?.active) return false;
    if (latch.until && this.now() > new Date(latch.until).getTime()) {
      this.clearLatch(zone);
      return false;
    }
    return true;
  }

  clearLatch(zone) {
    // Ephemeral test latches are dropped unconditionally (never persisted, so no
    // save) — this also runs on test-mode exit, when isTestMode() is already off.
    this.#testLatches.delete(zone);
    const z = this.state.zone(zone);
    if (z.latch?.active) {
      z.latch = null;
      this.state.save({ flush: true });
      this.log?.info({ zone }, 'enforcement latch cleared');
      this.emit('latch-cleared', { zone });
    }
  }

  /** Drop every ephemeral test-mode latch. Called on any test-mode exit —
   *  manual (clearTestMode) or automatic (a real Shabbos/YT preempting a rehearsal). */
  clearTestLatches() {
    this.#testLatches.clear();
  }

  clearExpiredLatches(nowMs) {
    for (const [key, z] of Object.entries(this.state.get().zones)) {
      if (z.latch?.active && z.latch.until && nowMs > new Date(z.latch.until).getTime()) {
        this.clearLatch(Number(key));
      }
    }
  }

  /** Scheduler calls this when it executes a timeline action on a zone. */
  scheduledActionExecuted(zone) {
    this.#cancelGrace(zone);
    this.#overrides.delete(zone);
  }

  #enabledFor(zone) {
    if (!this.canAct()) return false; // inactive standby: never correct/latch/notify
    const cfg = this.config.get();
    if (!cfg.enforcement.enabled) return false;
    const zoneCfg = cfg.zones.find((z) => z.id === zone);
    if (!zoneCfg?.enforce) return false;
    // momentary triggers (HA automations/scripts) hold no level to enforce —
    // "correcting" one would re-run it
    if (zoneCfg.kind === 'automation') return false;
    if (!this.#activeCluster) return false;
    const now = this.now();
    // users who accept Shabbos early can configure an earlier boundary
    const start = this.#enforceFromMs ?? new Date(this.#activeCluster.startsAt).getTime();
    const end = new Date(this.#activeCluster.endsAt).getTime();
    return now >= start && now <= end;
  }

  onDeviation({ zone, reported, expected }) {
    if (this.isLatched(zone)) return;
    if (!this.#enabledFor(zone)) {
      this.log?.debug({ zone, reported, expected }, 'deviation observed but enforcement inactive');
      return;
    }
    const cfg = this.config.get().enforcement;
    const now = this.now();
    // derived rolling window (see OVERRIDE_GAP_BUFFER_SEC); an explicit
    // overrideWindowSeconds still wins as an escape hatch / for tests
    const windowSec = cfg.overrideWindowSeconds ?? (cfg.graceSeconds + OVERRIDE_GAP_BUFFER_SEC);
    const o = this.#overrides.get(zone);
    const count = o && now - o.lastAt <= windowSec * 1000 ? o.count + 1 : 1;
    this.#overrides.set(zone, { count, lastAt: now });
    this.log?.warn({ zone, reported, expected, overrideCount: count }, 'enforcement: deviation');

    if (count >= cfg.overridePresses) {
      this.#latch(zone, reported);
      return;
    }
    this.#cancelGrace(zone);
    const timer = setTimeout(() => this.#correct(zone), cfg.graceSeconds * 1000);
    timer.unref?.();
    this.#graceTimers.set(zone, timer);
  }

  async #correct(zone) {
    this.#graceTimers.delete(zone);
    // Serialized against Scheduler's zone writes (same shared ZoneLock — see
    // its constructor param). A slow correction (device retries) must not be
    // able to settle AFTER a legitimately later scheduled action fires for
    // this zone and silently revert it — the queued turn always re-checks
    // fresh state below, so whichever runs last is correct by construction.
    await this.zoneLock.run(zone, async () => {
      if (this.isLatched(zone) || !this.#enabledFor(zone)) return;
      const expected = this.tracker.expected(zone);
      const reported = this.tracker.reported(zone);
      if (expected === undefined || reported === undefined || Math.abs(reported - expected) <= 1) return;
      try {
        await driveZone(this, zone, expected);
        this.log?.warn({ zone, to: expected }, 'enforcement: corrected manual change');
        this.emit('corrected', { zone, to: expected });
      } catch (err) {
        this.log?.error({ zone, err: err.message }, 'enforcement correction failed');
      }
    });
  }

  #latch(zone, level) {
    this.#cancelGrace(zone);
    this.#overrides.delete(zone);
    const until = this.#activeCluster ? new Date(this.#activeCluster.endsAt).toISOString() : null;
    if (this.isTestMode()) {
      // Dry run: hold the zone in-memory for the rest of the (virtual) cluster so
      // the rehearsal behaves realistically — but write NOTHING to state.json, so
      // this can never pause the real schedule or outlive test mode. The mock
      // notification (test:true) makes clear no real override happened.
      this.#testLatches.set(zone, { level, until });
      this.log?.warn({ zone, to: level, until }, 'enforcement: TEST-mode override — mock only, not latched');
      this.emit('latched', { zone, level, until, test: true });
      this.#signalLatch(zone, level);
      return;
    }
    this.state.zone(zone).latch = { active: true, level, until };
    this.state.save({ flush: true });
    this.log?.warn({ zone, to: level, until }, "enforcement: non-Jew's override latched");
    this.emit('latched', { zone, level, until, test: false });
    // Confirm the override took hold with two quick blinks, ending back at the
    // level the helper set. The zone is already latched, so these blinks won't
    // be read as new deviations. Fire-and-forget: the latch stands regardless.
    this.#signalLatch(zone, level);
  }

  async #signalLatch(zone, level) {
    if (typeof this.lutron.flash !== 'function') return;
    try {
      // Serialized on the shared ZoneLock like every other zone write. Without
      // it, a lock-held write that passed its isLatched check just before the
      // latch was set (an in-flight reconcile turn or armed action) races the
      // blink on the wire — and if the stale scheduled write settles last, the
      // zone ends at the SCHEDULED level with nothing to re-assert the latch
      // (every later writer skips latched zones). Inside the lock, our turn
      // runs after that write and the blink's final restore re-asserts the
      // latched manual level. No re-entrancy: #latch is never called from
      // inside a lock turn (onDeviation runs off tracker events).
      await this.zoneLock.run(zone, async () => {
        // register the blink levels so the toggles aren't mistaken for a
        // change — echo-only, so the confirm blink never rewrites
        // expectedLevel. Registered inside the lock turn so the 5s echo
        // window starts when the writes actually begin, not while queued.
        for (const l of blinkLevels(level, 2)) (this.tracker.expectEcho ?? this.tracker.expectCommand)?.call(this.tracker, zone, l);
        await this.lutron.flash(zone, 2, level);
      });
    } catch (err) {
      this.log?.warn({ zone, err: err.message }, 'enforcement: latch-confirm blink failed');
    }
  }

  #cancelGrace(zone) {
    const t = this.#graceTimers.get(zone);
    if (t) {
      clearTimeout(t);
      this.#graceTimers.delete(zone);
    }
  }
}
