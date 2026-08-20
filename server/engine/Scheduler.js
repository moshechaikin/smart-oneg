import { EventEmitter } from 'node:events';
import { DateTime } from 'luxon';
import { Cron } from 'croner';
import { CalendarService } from '../calendar/CalendarService.js';
import { SceneRepository } from './SceneRepository.js';
import { TimelineCompiler, expectedLevel } from './TimelineCompiler.js';
import { ConflictDetector } from './ConflictDetector.js';
import { blinkLevels } from '../devices/DeviceBus.js';
import { ZoneLock } from './ZoneLock.js';
import { driveZone } from './driveZone.js';

const HORIZON_PAST_MS = 24 * 3600_000;
const HORIZON_FUTURE_MS = 72 * 3600_000;
const ARM_WINDOW_MS = 6 * 3600_000;
const FIRE_TOLERANCE_MS = 90_000;
const WATCHDOG_INTERVAL_MS = 60_000;
const WATCHDOG_DRIFT_MS = 120_000;

/**
 * Orchestrates the runtime: recompiles the rolling timeline, arms one-shot
 * timers for upcoming actions, reconciles zones to their expected state on
 * boot/reconnect/takeover, and guards against wall-clock jumps.
 *
 * Everything executes through #executeAction so latches, echo-expectation,
 * logging and enforcement notification stay consistent.
 *
 * Events: 'compiled' {report, conflicts}, 'actionExecuted', 'actionFailed', 'clusterEnded'
 */
export class Scheduler extends EventEmitter {
  #timers = [];
  #cronJobs = [];
  #cronTz = null;
  #watchdog = null;
  #lastTick = 0;
  #clusterEndTimer = null;
  #clusterStartTimer = null;
  #lastActiveClusterId = null;
  #caughtUpClusterId = null; // cluster whose entry catch-up already ran (or was covered by a reconcile)

  constructor({
    configStore, stateStore, tracker, enforcement, devices, logger = null, notifier = null, canAct = () => true,
    // Optional override; see the adoption below.
    zoneLock = null,
  }) {
    super();
    // ADOPT the EnforcementEngine's ZoneLock (see ZoneLock.js) unless one was
    // passed explicitly. Cross-class serialization only works when BOTH
    // classes share one instance, and `enforcement` is already a required
    // collaborator here — deriving the shared lock from that existing edge
    // makes the sharing correct-by-construction: no wiring site can forget a
    // separate zoneLock key and silently run two independent locks.
    this.zoneLock = zoneLock ?? enforcement?.zoneLock ?? new ZoneLock();
    // Drive-authority: false on an INACTIVE standby, which must observe (compile
    // timelines for preview/health) but never drive lights, mutate config, or
    // notify — the primary owns all of that. Flips true the moment it takes over.
    this.canAct = canAct;
    this.config = configStore;
    this.state = stateStore;
    this.tracker = tracker;
    this.enforcement = enforcement;
    this.devices = devices;
    this.log = logger;
    this.notifier = notifier;
    this.compiled = { actions: [], allActions: [], report: null, conflicts: [], clusters: [] };
    // TEST MODE: a fixed offset between the real clock and the clock the
    // scheduler *thinks* it is (0 = off). Lets you demo/test a Shabbos or Yom
    // Tov on a random Tuesday — real timers, real lights. Never persisted, so a
    // restart always returns to real time. Guarded: never runs during a real
    // Shabbos/Yom Tov (see #realCoverageActive).
    this.testOffsetMs = 0;

    configStore.on('change', () => {
      // A config edit changes FUTURE behavior; it must not drive lights by itself
      // during the week or erev (e.g. saving Child Lock timing). Two paths could:
      //  - the recompile's cluster-entry catch-up, if the edit moves the enforce
      //    boundary into the past — suppress it here (catchup: false); a genuine
      //    clock crossing still catches up via the cluster-start timer.
      //  - reconcile re-driving every zone — only run it while the schedule is
      //    actually in force: a real active Shabbos/Yom Tov window, or any time in
      //    test mode (a rehearsal, where seeing the effect on the lights is the
      //    point). Boot/reconnect catch-up is separate (Lutron 'ready' -> reconcile).
      this.recompile({ catchup: false });
      if (this.testOffsetMs !== 0 || this.activeCluster()) {
        this.reconcile().catch((err) => this.log?.error({ err: err.message }, 'reconcile after config change failed'));
      }
      // a location change moves the cron timezone — rebuild the jobs so the
      // daily recompile keeps firing at LOCAL midnight, not the old zone's
      if (this.#cronJobs.length && configStore.get().location.tzid !== this.#cronTz) {
        this.log?.info({ tz: configStore.get().location.tzid }, 'timezone changed — restarting cron jobs');
        for (const j of this.#cronJobs) j.stop();
        this.#startCron();
      }
    });
  }

  /** The clock the scheduler runs on: real time plus any test-mode offset. */
  now() {
    return Date.now() + this.testOffsetMs;
  }

  /** True while a test-mode rehearsal is running (virtual clock active). */
  isTestMode() {
    return this.testOffsetMs !== 0;
  }

  /**
   * Enter test mode: pretend "now" is `virtualNowMs`. Recompiles and re-arms
   * against the virtual clock so real timers fire real actions. Refuses to
   * start while a real Shabbos/Yom Tov is in progress.
   */
  async setTestMode(virtualNowMs) {
    if (this.#realCoverageActive()) {
      throw new Error('Cannot start test mode — a real Shabbos/Yom Tov (or its erev schedule) is already in effect.');
    }
    // Snapshot the current (real-weekday) light levels so we can put everything
    // back exactly as it was when the demo/test ends. Only on the FIRST entry:
    // re-targeting the virtual clock (the "skip between rules" arrows call this
    // again) must not re-snapshot the now test-driven levels, or exit would
    // restore the wrong state.
    if (this.testOffsetMs === 0) {
      this.testSnapshot = new Map();
      for (const z of this.config.get().zones) {
        if (z.kind === 'automation') continue; // momentary: exit-restore must never re-fire a trigger
        let level = this.tracker.reported?.(z.id) ?? this.tracker.expected?.(z.id);
        if (this.devices.connected) {
          // Prefer a live read, but never let a failed/empty query drop a zone we
          // already know about — otherwise it won't be restored on exit.
          try {
            const live = await this.devices.queryLevel(z.id);
            if (live !== undefined && live !== null) level = live;
          } catch { /* keep tracker value */ }
        }
        if (level !== undefined && level !== null) this.testSnapshot.set(z.id, level);
      }
    }
    this.testOffsetMs = virtualNowMs - Date.now();
    this.log?.warn({ virtualNow: new Date(this.now()).toISOString(), snapshot: this.testSnapshot.size }, 'TEST MODE started');
    this.recompile();
    await this.reconcile().catch(() => {});
  }

  /**
   * Leave test mode: back to real time. On a manual exit, RESTORE the snapshot
   * taken at start (put the weekday lights back). On the auto-exit path (a real
   * Shabbos/Yom Tov actually began), do NOT restore — the lights must not be
   * touched during the real thing.
   */
  async clearTestMode({ restore = true } = {}) {
    if (this.testOffsetMs === 0) return;
    this.testOffsetMs = 0;
    for (const z of this.config.get().zones) this.enforcement.clearLatch?.(z.id);
    this.recompile(); // back on the real clock (weekday: nothing scheduled)
    if (restore && this.testSnapshot && this.devices.connected) {
      this.log?.warn({ zones: this.testSnapshot.size }, 'TEST MODE stopped — restoring weekday snapshot');
      for (const [id, snap] of this.testSnapshot) {
        // Same zone-lock as reconcile/childLockCatchup/executeAction — the
        // real-clock recompile() just above can itself arm/fire a real action
        // for this zone; without the lock the restore write and that action
        // could land in either order.
        await this.#withZoneLock(id, async () => {
          try {
            await driveZone(this, id, snap, { verified: false });
          } catch (err) { this.log?.error({ zone: id, err: err.message }, 'snapshot restore failed'); }
        });
      }
    } else {
      this.log?.warn('TEST MODE stopped — back to real time (no restore)');
    }
    this.testSnapshot = null;
  }

  /**
   * Scene preview: snapshot the CURRENT device states once, apply the scene
   * live, and let the user restore. Chaining previews keeps the ORIGINAL
   * snapshot (never re-snapshot a previewed state). Auto-exits (without
   * touching lights) the moment a real Shabbos/YT schedule takes effect.
   */
  async startScenePreview(sceneId) {
    if (this.#realCoverageActive()) throw new Error('A real Shabbos/Yom Tov schedule is in effect — scene preview is disabled.');
    const resolved = new SceneRepository(this.config.get().scenes).resolve(sceneId);
    if (!this.scenePreview) {
      const snapshot = [];
      for (const z of this.config.get().zones) {
        if (z.kind === 'automation') continue; // momentary: nothing to restore (and "restoring" could re-fire it)
        const lvl = this.tracker.reported?.(z.id);
        if (lvl !== undefined && lvl !== null) snapshot.push([z.id, lvl]);
      }
      this.scenePreview = { snapshot };
    }
    this.scenePreview.sceneId = sceneId;
    this.scenePreview.startedAt = Date.now();
    for (const a of resolved.actions) {
      if (a.flash) continue; // flash members are reminders, not preview state
      await this.#withZoneLock(a.zone, async () => {
        // thermostat mode members drive the preset / hvac mode, not a level
        if (a.preset != null) { await this.devices.setPreset?.(a.zone, a.preset).catch(() => {}); return; }
        if (a.hvacMode != null) { await this.devices.setHvacMode?.(a.zone, a.hvacMode).catch(() => {}); return; }
        const level = await driveZone(this, a.zone, a.level, { verified: false, fadeSec: a.fadeSec ?? 0 }).catch(() => null);
        if (level === null) return; // best-effort preview: a failed write skips the color ride-along too
        const zc = this.config.get().zones.find((z) => z.id === a.zone);
        if (level > 0 && a.rgb != null && zc?.rgb) {
          await this.devices.setColor?.(a.zone, a.rgb).catch(() => {});
        } else if (level > 0 && a.kelvin != null && zc?.colorTemp) {
          await this.devices.setColorTemp?.(a.zone, a.kelvin).catch(() => {});
        }
      });
    }
    return this.scenePreviewInfo();
  }

  async exitScenePreview({ restore = true } = {}) {
    const p = this.scenePreview;
    this.scenePreview = null;
    if (!p || !restore) return;
    for (const [zone, lvl] of p.snapshot) {
      await this.#withZoneLock(zone, () => driveZone(this, zone, lvl, { verified: false }).catch(() => {}));
    }
  }

  scenePreviewInfo() {
    if (!this.scenePreview) return { active: false };
    const scene = this.config.get().scenes.find((sc) => sc.id === this.scenePreview.sceneId);
    return { active: true, sceneId: this.scenePreview.sceneId, name: scene?.name ?? this.scenePreview.sceneId };
  }

  testModeInfo() {
    if (this.testOffsetMs === 0) return { active: false };
    const active = this.activeCluster();
    const upcoming = this.compiled.clusters.find((c) => c.startsAt.getTime() > this.now());
    return {
      active: true,
      virtualNow: new Date(this.now()).toISOString(),
      offsetMs: this.testOffsetMs,
      label: (active ?? upcoming)?.label ?? null,
    };
  }

  /**
   * True iff the REAL (not virtual) schedule is in force right now — either a
   * real assur cluster is active, OR a real erev-prep action's fire time has
   * already arrived for an upcoming cluster (so test mode must step aside and
   * let the real erev rules run, not just from candle-lighting onward).
   */
  #realCoverageActive() {
    const cfg = this.config.get();
    if (!cfg.location.lat) return false;
    const realNow = Date.now();
    const cal = new CalendarService({ location: cfg.location, times: cfg.times, locale: cfg.display?.locale });
    const from = new Date(realNow - 2 * 86400_000).toISOString().slice(0, 10);
    const to = new Date(realNow + 3 * 86400_000).toISOString().slice(0, 10);
    const clusters = cal.clusters(from, to);
    // inside a real cluster (candle lighting → havdalah)
    if (clusters.some((c) => realNow >= c.startsAt.getTime() && realNow <= c.endsAt.getTime())) return true;
    // erev-prep: has any real action's fire time already passed for a cluster
    // that hasn't ended yet? (e.g. "lights on 10am erev Shabbos")
    const clusterEnd = new Map(clusters.map((c) => [c.id, c.endsAt.getTime()]));
    const compiler = new TimelineCompiler({
      calendar: cal,
      sceneRepo: new SceneRepository(cfg.scenes),
      schedules: cfg.schedules,
      guestMode: cfg.guestMode?.enabled ?? false,
      guestUntil: cfg.guestMode?.until ? new Date(cfg.guestMode.until).getTime() : null,
    });
    const { allActions } = compiler.compile(clusters, realNow - 2 * 86400_000, realNow + 3 * 86400_000);
    return allActions.some((a) => {
      const end = clusterEnd.get(a.source?.clusterId);
      return end !== undefined && a.at <= realNow && realNow <= end;
    });
  }

  /** Boot / takeover entry point: compile, catch up zone states, arm everything. */
  async start() {
    this.recompile();
    await this.reconcile();
    this.#startCron();
    this.#startWatchdog();
  }

  stop() {
    this.#clearTimers();
    for (const j of this.#cronJobs) j.stop();
    this.#cronJobs = [];
    clearInterval(this.#watchdog);
    clearTimeout(this.#clusterEndTimer);
    clearTimeout(this.#clusterStartTimer);
  }

  /** Rebuild calendar + timeline for the rolling horizon. Synchronous & deterministic. */
  recompile({ catchup = true } = {}) {
    const cfg = this.config.get();
    if (!cfg.location.lat) return; // setup not complete yet
    // Safety: if a REAL Shabbos/Yom Tov has begun while in test mode, drop test
    // mode immediately — the app must not fake-drive lights during the real thing.
    if (this.testOffsetMs !== 0 && this.#realCoverageActive()) {
      this.log?.warn('real Shabbos/Yom Tov schedule now in force — auto-exiting test mode so the real schedule runs');
      if (this.canAct()) this.notifier?.send('test-mode-auto-exit', {});
      this.testOffsetMs = 0;
      this.testSnapshot = null; // never touch the lights during the real thing
      this.scenePreview = null; // a lingering preview must not restore over the real schedule
      this.enforcement?.clearTestLatches?.(); // drop any mock Child Lock hold from the rehearsal
    }
    const now = this.now();
    // Guest mode auto-expires once its cluster's havdalah has passed (real time).
    // The primary owns this; an inactive standby just mirrors the result, so it
    // must not notify or write config here (that would duplicate the alert).
    const realNow = Date.now();
    if (this.canAct() && cfg.guestMode?.enabled && cfg.guestMode.until && realNow > new Date(cfg.guestMode.until).getTime()) {
      this.log?.info('guest mode window elapsed — turning it off');
      this.notifier?.send('guest-mode-off', {});
      this.config.update({ guestMode: { enabled: false, until: null } }); // re-triggers recompile
      return;
    }
    // Away mode auto-expires once its date window has fully passed (real time).
    if (this.canAct() && cfg.awayMode?.enabled && cfg.awayMode.to
      && realNow > new Date(`${cfg.awayMode.to}T23:59:59`).getTime() + 6 * 3600_000) {
      this.log?.info('away mode window elapsed — turning it off');
      this.notifier?.send('away-mode-off', {});
      this.config.update({ awayMode: { enabled: false, from: null, to: null, label: null } });
      return;
    }
    const calendar = new CalendarService({ location: cfg.location, times: cfg.times, locale: cfg.display?.locale });
    const fromISO = new Date(now - HORIZON_PAST_MS).toISOString().slice(0, 10);
    const toISO = new Date(now + HORIZON_FUTURE_MS).toISOString().slice(0, 10);
    const clusters = calendar.clusters(fromISO, toISO);
    const compiler = new TimelineCompiler({
      calendar,
      sceneRepo: new SceneRepository(cfg.scenes),
      schedules: cfg.schedules,
      guestMode: cfg.guestMode?.enabled ?? false,
      guestUntil: cfg.guestMode?.until ? new Date(cfg.guestMode.until).getTime() : null,
      awayMode: cfg.awayMode?.enabled ? cfg.awayMode : null,
      zones: cfg.zones,
    });
    const { actions, allActions, report } = compiler.compile(clusters, now - HORIZON_PAST_MS, now + HORIZON_FUTURE_MS);
    const conflicts = new ConflictDetector({ tzid: cfg.location.tzid, zones: cfg.zones }).detect(allActions, clusters);
    this.compiled = { actions, allActions, report, conflicts, clusters };
    this.calendar = calendar;

    this.state.get().lastCompileAt = new Date(realNow).toISOString();
    this.#updateActiveCluster(now, { catchup });
    this.#refreshExpectedLevels(now);
    this.state.save();
    this.#armTimers(now);
    this.log?.info({
      actions: actions.length, clusters: clusters.length, conflicts: conflicts.length,
    }, 'timeline compiled');
    this.emit('compiled', { report, conflicts });
  }

  /**
   * Serialize a zone-driving operation on the SHARED per-zone lock (adopted
   * from EnforcementEngine — see the constructor and ZoneLock.js for the full
   * why). Rule for every callback: re-read authority/clock/expected state
   * INSIDE your turn, never before it — a turn can start seconds after it was
   * queued, and only fresh reads keep "whichever turn runs last is correct".
   */
  #withZoneLock(zone, fn) {
    return this.zoneLock.run(zone, fn);
  }

  /**
   * Boot catch-up: drive every governed, unlatched zone to its expected level.
   * Idempotent — safe on every reconnect/takeover, and the reason a reboot
   * at 3am on Shabbos is a non-event.
   */
  async reconcile() {
    // Drive-authority, explicitly. This used to be safe only by accident: an
    // instance without drive authority also had no bridge connection, so the
    // check below covered it. That coupling no longer holds — a standby that
    // has stood down from driving while it waits out the release confirmation
    // (FailoverManager.drivesLights) stays CONNECTED, and a config mirror from
    // the recovered primary emits 'change' -> recompile -> reconcile, which
    // would drive every zone right alongside the primary.
    if (!this.canAct()) return;
    if (!this.devices.connected) return;
    // Zones run CONCURRENTLY, each on its own per-zone lock queue: a stalled
    // zone (a device timeout, or an in-flight flash holding that zone's lock
    // for ~2s) must not head-of-line-block every later zone. The wire is still
    // serialized by the device client; only the waiting overlaps.
    await Promise.all(
      this.config.get().zones
        // momentary triggers (HA automations/scripts): re-syncing "expected
        // state" would RE-RUN the action — they fire once, at their rule's time
        .filter((z) => z.kind !== 'automation')
        .map((z) => this.#withZoneLock(z.id, () => this.#reconcileZone(z.id))),
    );
  }

  /** One zone's reconcile turn. Runs INSIDE that zone's lock. */
  async #reconcileZone(zone) {
    // Re-check drive authority now that this zone's turn arrived — the turn
    // may have waited out a slow same-zone write, and a standby can lose
    // authority (deferral/release) in that window; a stale up-front check
    // would keep driving alongside the recovered primary.
    if (!this.canAct()) return;
    // Re-read the clock per turn, never once up front. A turn can start
    // seconds after reconcile() was called (queued behind a slow write), and
    // the clock keeps advancing — in test mode it's a fixed offset off real
    // time, so this.now() marches on — while an armed timer can fire a
    // scheduled action (e.g. the 9:00 scene) in between. A stale `now` would
    // write the PRE-boundary expected level and clobber the action that just
    // fired (basement snapped back off, dining room stayed on). Fresh reads
    // keep every write aligned with the current expected state, so reconcile
    // can only ever agree with an armed action, never overwrite it.
    const expected = expectedLevel(this.compiled.allActions, zone, this.now());
    if (expected === undefined) return;
    if (this.enforcement.isLatched(zone)) {
      this.log?.info({ zone }, 'reconcile: skipping latched zone');
      return;
    }
    try {
      await driveZone(this, zone, expected);
    } catch (err) {
      this.log?.error({ zone, err: err.message }, 'reconcile setLevel failed');
    }
  }

  activeCluster() {
    const now = this.now();
    return this.compiled.clusters.find(
      (c) => now >= c.startsAt.getTime() && now <= c.endsAt.getTime(),
    ) ?? null;
  }

  // ── internals ──────────────────────────────────────────────────────────

  /**
   * When Child Lock should begin for a cluster. Default: candle lighting
   * (the cluster's startsAt). `cfg.enforcement.begins.kind === 'firstRule'`
   * moves it earlier — to this cluster's very first scheduled action (its
   * erev prep included), so a household whose Friday routine starts 90 min
   * before shkia is protected from that first rule onward.
   *
   * Usually returns a time <= startsAt (pulling enforcement EARLIER into the
   * erev window). The one exception is `kind:'shkia'`, which pushes the start
   * LATER — to actual sunset — so the minutes between candle lighting and
   * shkia stay free; #updateActiveCluster honors that delayed boundary.
   *
   * (Legacy: a stored { kind:'fixed', time, onlyIfSunsetAfter } is still
   * honored so old configs keep working.)
   */
  enforceFromFor(cluster) {
    const startMs = new Date(cluster.startsAt).getTime();
    const begins = this.config.get().enforcement?.begins;
    if (!begins) return startMs;
    try {
      if (begins.kind === 'firstRule') {
        let earliest = Infinity;
        for (const a of this.compiled.allActions) {
          if (a.source?.clusterId === cluster.id && a.at < earliest) earliest = a.at;
        }
        return Number.isFinite(earliest) ? Math.min(earliest, startMs) : startMs;
      }
      if (begins.kind === 'shkia' && this.calendar) {
        // Hold Child Lock off until actual sunset — the ~18 min between candle
        // lighting and shkia stay free. This is the one boundary that can be
        // LATER than the cluster start.
        const sunset = this.calendar.zmanim(cluster.erevDate).sunset?.getTime?.();
        return sunset ?? startMs;
      }
      if (begins.kind === 'fixed' && begins.time && this.calendar) {
        const erev = cluster.erevDate;
        const tzid = this.config.get().location.tzid;
        const ms = DateTime.fromISO(`${erev}T${begins.time}`, { zone: tzid }).toMillis();
        if (begins.onlyIfSunsetAfter) {
          const sunset = this.calendar.zmanim(erev).sunset?.getTime?.();
          const gate = DateTime.fromISO(`${erev}T${begins.onlyIfSunsetAfter}`, { zone: tzid }).toMillis();
          if (!sunset || sunset <= gate) return startMs; // winter: standard boundary
        }
        return Math.min(ms, startMs);
      }
      return startMs;
    } catch {
      return startMs;
    }
  }

  #updateActiveCluster(now, { catchup = true } = {}) {
    const timeActive = this.activeCluster();
    // enforcement may begin BEFORE the cluster window (early Shabbos) or AFTER
    // it opens ("at shkia") — the configured boundary governs Child Lock
    const next = this.compiled.clusters.find((c) => c.startsAt.getTime() > now);
    const candidate = timeActive ?? (next && now >= this.enforceFromFor(next) ? next : null);
    const enforceFrom = candidate ? this.enforceFromFor(candidate) : null;
    // Only enforce once the boundary passes: for "at shkia" the cluster window
    // (candle lighting) can be open while Child Lock is still holding off.
    const active = candidate && now >= enforceFrom ? candidate : null;
    const becameActive = active && active.id !== this.#lastActiveClusterId;
    this.#lastActiveClusterId = active?.id ?? null;
    this.state.get().activeClusterId = timeActive?.id ?? null;
    this.enforcement.setActiveCluster(active, active ? enforceFrom : null);

    // Child Lock catch-up: erev is enforcement-free by design, so a light
    // flipped at 6:05 PM would otherwise stay wrong all night. Once per
    // cluster, snap enforce-flagged zones back to their scheduled state; live
    // enforcement takes over from there. It runs on a genuine boundary
    // crossing (boot / boundary timer / cron: becameActive), or — if still
    // owed — once the cluster window itself opens. A config save passes
    // catchup:false and never triggers it (saving a setting must not actuate
    // lights — the "Save timing" bug), but the debt stays recorded so the
    // start timer below re-fires this method at candle lighting and the
    // entering-Shabbos snap still happens.
    if (active && active.id !== this.#caughtUpClusterId) {
      if (catchup && (becameActive || timeActive)) {
        this.#caughtUpClusterId = active.id;
        this.#childLockCatchup().catch(() => {});
      } else if (!catchup && timeActive) {
        // window already open: the config-change hook reconciles every zone
        // to schedule right after this — that IS the catch-up, don't redo it
        this.#caughtUpClusterId = active.id;
      }
    }
    if (!active) this.#caughtUpClusterId = null;

    clearTimeout(this.#clusterEndTimer);
    clearTimeout(this.#clusterStartTimer);
    if (active) {
      const delay = active.endsAt.getTime() - now + 5000;
      this.#clusterEndTimer = setTimeout(() => {
        this.log?.info({ cluster: active.id }, 'cluster ended — clearing latches');
        this.enforcement.clearExpiredLatches(this.now());
        this.#updateActiveCluster(this.now());
        this.emit('clusterEnded', active);
      }, Math.min(delay, ARM_WINDOW_MS));
      this.#clusterEndTimer.unref?.();
      if (!timeActive && active.id !== this.#caughtUpClusterId) {
        // enforcement began early (before candle lighting) with the catch-up
        // still owed (a config save moved the boundary into the past) —
        // re-evaluate when the window opens so the snap runs at candles
        const startDelay = active.startsAt.getTime() - now;
        if (startDelay > 0 && startDelay <= ARM_WINDOW_MS) {
          this.#clusterStartTimer = setTimeout(() => this.#updateActiveCluster(this.now()), startDelay);
          this.#clusterStartTimer.unref?.();
        }
      }
    } else {
      // not enforcing yet: re-evaluate at the next Child Lock boundary. That is
      // normally the next cluster's start/early-boundary, but for "at shkia" it
      // can be the delayed boundary of a cluster whose window is already open.
      const boundary = candidate
        ? enforceFrom
        : (next ? Math.min(next.startsAt.getTime(), this.enforceFromFor(next)) : null);
      if (boundary != null) {
        const delay = boundary - now;
        if (delay > 0 && delay <= ARM_WINDOW_MS) {
          this.#clusterStartTimer = setTimeout(() => this.#updateActiveCluster(this.now()), delay);
          this.#clusterStartTimer.unref?.();
        }
      }
    }
  }

  async #childLockCatchup() {
    const cfg = this.config.get();
    if (!this.canAct()) return; // same drive-authority guard as reconcile()
    if (!cfg.enforcement.enabled || !this.devices.connected) return;
    // concurrent per-zone turns for the same reason as reconcile(): a stalled
    // zone must not delay every later zone's catch-up
    await Promise.all(
      cfg.zones
        .filter((z) => z.enforce && z.kind !== 'automation')
        .map((z) => this.#withZoneLock(z.id, () => this.#catchupZone(z.id))),
    );
  }

  /** One zone's Child Lock catch-up turn. Runs INSIDE that zone's lock —
   *  authority/clock re-reads per turn, same reasoning as #reconcileZone. */
  async #catchupZone(zone) {
    if (!this.canAct()) return;
    if (this.enforcement.isLatched(zone)) return;
    const expected = expectedLevel(this.compiled.allActions, zone, this.now());
    if (expected === undefined) return;
    const level = this.devices.coerceLevel?.(zone, expected) ?? expected;
    const reported = this.tracker.reported(zone);
    if (reported !== undefined && Math.abs(reported - level) <= 1) return;
    try {
      await driveZone(this, zone, expected);
      this.log?.warn({ zone, to: level }, 'child lock: catch-up correction at cluster start');
    } catch (err) {
      this.log?.error({ zone, err: err.message }, 'child lock catch-up failed');
    }
  }

  /** Keep tracker.expected in sync after a recompile (no commands sent). */
  #refreshExpectedLevels(now) {
    for (const zoneCfg of this.config.get().zones) {
      if (zoneCfg.kind === 'automation') continue; // momentary: always idle, never "expected on"
      const level = expectedLevel(this.compiled.allActions, zoneCfg.id, now);
      if (level !== undefined) this.tracker.setExpected(zoneCfg.id, level);
    }
  }

  #armTimers(now) {
    this.#clearTimers();
    for (const action of this.compiled.actions) {
      if (action.at <= now || action.at > now + ARM_WINDOW_MS) continue;
      const t = setTimeout(() => this.#fire(action), action.at - now);
      t.unref?.();
      this.#timers.push(t);
    }
  }

  #clearTimers() {
    for (const t of this.#timers) clearTimeout(t);
    this.#timers = [];
  }

  async #fire(action) {
    const skewMs = Math.abs(this.now() - action.at);
    if (skewMs > FIRE_TOLERANCE_MS) {
      this.log?.warn({ action: action.source, skewMs }, 'timer fired far from schedule — recompiling instead');
      this.recompile();
      await this.reconcile();
      return;
    }
    await this.executeAction(action);
  }

  async executeAction(action) {
    if (!this.canAct()) return; // inactive standby: observe only — never drive or alert
    // Serialize against reconcile()/#childLockCatchup() on this SAME zone (see
    // #withZoneLock) — an armed timer firing at the exact moment a config-save
    // or cluster-boundary catch-up is mid-flight for the same zone must not
    // have its write silently clobbered by the other's stale computation.
    await this.#withZoneLock(action.zone, () => this.#doExecuteAction(action));
  }

  async #doExecuteAction(action) {
    // Re-check drive authority now that our zone-lock turn has arrived: the
    // action may have queued for seconds behind a slow same-zone write, and a
    // standby can lose authority (deferral/release) in that window. The
    // executeAction-entry check alone would drive anyway — stale by the time
    // the write actually happens.
    if (!this.canAct()) return;
    if (this.enforcement.isLatched(action.zone)) {
      this.log?.warn({ zone: action.zone, source: action.source }, "action skipped: zone latched by non-Jew's override");
      return;
    }
    try {
      if (action.type === 'setAutomation') {
        // enable/disable an HA automation — a persistent state, not a level, so
        // it bypasses the tracker/enforcement entirely
        await this.devices.setAutomationEnabled?.(action.zone, action.enabled);
      } else if (action.type === 'setPreset') {
        await this.devices.setPreset?.(action.zone, action.preset);
      } else if (action.type === 'setHvacMode') {
        await this.devices.setHvacMode?.(action.zone, action.hvacMode);
      } else if (action.type === 'flash') {
        // Restore the actual current state — a reminder blink must never
        // change what the lights were doing (reported beats stale expected).
        const restore = this.devices.coerceLevel?.(
          action.zone, this.tracker.reported(action.zone) ?? this.tracker.expected(action.zone) ?? 0,
        ) ?? this.tracker.reported(action.zone) ?? 0;
        const times = Math.max(1, action.times ?? 1);
        // Register the toggles for echo suppression only — a reminder blink must
        // never redefine the zone's expected level (expectCommand would leave it
        // at the final blink level, silently inverting what the schedule wants
        // and turning a benign on-light into an enforcement fight → false latch).
        for (const level of blinkLevels(restore, times)) this.tracker.expectEcho(action.zone, level);
        await this.devices.flash(action.zone, times, restore);
      } else if (this.config.get().zones.find((z) => z.id === action.zone)?.kind === 'automation') {
        // momentary trigger (HA automation/script): fire AT MOST ONCE — the
        // verify/retry path could re-run an action that actually went through
        // (a trigger never holds a queryable level to verify against)
        await this.devices.setLevel(action.zone, action.level, 0);
      } else {
        // retries + verify-before-fail: the user is only notified below when
        // the device really couldn't be driven AND isn't already at the level
        const level = await driveZone(this, action.zone, action.level, { fadeSec: action.fadeSec });
        // white color temperature / RGB color rides along with turning a
        // capable light on — best-effort so a light that lost the capability
        // can't fail the action
        const zc = this.config.get().zones.find((z) => z.id === action.zone);
        if (level > 0 && action.rgb != null && zc?.rgb) {
          await this.devices.setColor?.(action.zone, action.rgb).catch(() => {});
        } else if (level > 0 && action.kelvin != null && zc?.colorTemp) {
          await this.devices.setColorTemp?.(action.zone, action.kelvin).catch(() => {});
        }
      }
      this.enforcement.scheduledActionExecuted(action.zone);
      this.log?.info({ zone: action.zone, to: action.level, type: action.type, source: action.source }, 'action executed');
      this.emit('actionExecuted', action);
    } catch (err) {
      this.log?.error({ zone: action.zone, err: err.message, source: action.source }, 'action failed');
      const deviceName = this.config.get().zones.find((z) => z.id === action.zone)?.friendlyName;
      this.notifier?.send('action-failed', { action, deviceName, error: err.message });
      this.emit('actionFailed', { action, error: err });
    }
  }

  #startCron() {
    const tz = this.config.get().location.tzid;
    this.#cronTz = tz;
    this.#cronJobs = [
      // daily recompile shortly after midnight local
      new Cron('5 0 * * *', { timezone: tz }, () => {
        this.recompile();
        this.reconcile().catch(() => {});
      }),
      // hourly: re-arm the 6h timer window AND re-evaluate the Child Lock
      // boundary (so early-begin enforcement arms even on an erev with no
      // scheduled action before the boundary itself)
      new Cron('0 * * * *', { timezone: tz }, () => {
        this.#updateActiveCluster(this.now());
        this.#armTimers(this.now());
      }),
    ];
  }

  #startWatchdog() {
    this.#lastTick = Date.now();
    this.#watchdog = setInterval(async () => {
      const now = Date.now();
      const drift = Math.abs(now - this.#lastTick - WATCHDOG_INTERVAL_MS);
      this.#lastTick = now;
      if (drift > WATCHDOG_DRIFT_MS) {
        this.log?.warn({ driftMs: drift }, 'clock jump detected — recompiling and reconciling');
        this.recompile();
        await this.reconcile().catch(() => {});
      }
    }, WATCHDOG_INTERVAL_MS);
    this.#watchdog.unref?.();
  }
}
