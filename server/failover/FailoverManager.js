import { EventEmitter } from 'node:events';

/**
 * Standby-side failover loop. Primary instances do nothing here.
 *
 * Every pollSeconds: GET {primaryUrl}/api/health.
 *  - failThreshold consecutive failures  -> takeover(): connect Lutron, boot
 *    catch-up via Scheduler, notify.
 *  - recoverThreshold consecutive successes while active -> release():
 *    disconnect Lutron, notify, back to standby.
 *  - configVersion drift while healthy -> mirror config via /api/sync/export.
 *
 * Split-brain tolerance comes from determinism: both instances compile the
 * identical timeline from mirrored config, so brief double-driving sends the
 * same idempotent levels.
 *
 * Events: 'takeover', 'release', 'synced'
 */
export class FailoverManager extends EventEmitter {
  #timer = null;
  #failures = 0;
  #successes = 0;
  #reachable = null;       // null = not polled yet, true/false after first poll
  #lastContactAt = null;   // ISO of the last successful primary contact
  #lastError = null;       // message from the last failed poll
  #lastSyncAt = null;      // ISO of the last successful config mirror
  #backupLastSeenAt = null; // ms: last time our backup polled us (primary side)
  #deferring = false;      // active, but the primary is provably back — see drivesLights()
  active = false;

  /**
   * Drive-authority for an ACTIVE standby. Taking over and *driving* are
   * deliberately separate: on recovery the standby stays `active` (connected
   * and armed) until recoverThreshold consecutive successes confirm the
   * primary is really back, but it must stop DRIVING the moment the primary
   * is provably healthy again — otherwise both instances drive every zone for
   * the whole confirmation window (~60s at the defaults).
   *
   * That window isn't merely redundant, it's harmful: the instance that did
   * NOT issue a command has no pending echo for it, so the other instance's
   * writes read as genuine wall-switch deviations — a reminder blink's toggles
   * (each a discrete ~OUTPUT), or a mid-boundary race where the two instances
   * command different levels. Enough of those inside the rolling override
   * window falsely latch the zone, and a latched zone stops following the
   * schedule for the rest of the cluster. (Plain fades are benign per
   * docs/ARCHITECTURE.md — the bridge reports only the final level — and when
   * both instances agree on the level there's no deviation; the hazard is the
   * multi-write and disagreement cases.) Deferring closes it: canAct() goes
   * false, so this instance neither drives nor counts deviations
   * (EnforcementEngine gates on canAct first).
   *
   * Deferral is only ever entered on POSITIVE proof — the primary answered AND
   * reports its own bridge connected — and is dropped the instant that proof
   * lapses: a failed poll, or a still-reachable primary reporting its bridge
   * DOWN (it answers HTTP but cannot drive lights). Both exits matter — either
   * alone leaves a "nobody is driving" gap.
   */
  drivesLights() {
    return this.active && !this.#deferring;
  }

  get deferring() { return this.#deferring; }

  /** Primary side: the standby polls our /api/health with the sync token; record
   *  that contact (in memory) so we can alert if the backup goes silent. */
  noteBackupContact() { this.#backupLastSeenAt = Date.now(); }
  get backupLastSeenAt() { return this.#backupLastSeenAt; }
  get backupSeen() { return this.#backupLastSeenAt !== null; }

  constructor({ configStore, stateStore, scheduler, lutron, notifier, logger = null, fetchImpl = fetch }) {
    super();
    this.config = configStore;
    this.state = stateStore;
    this.scheduler = scheduler;
    this.lutron = lutron;
    this.notifier = notifier;
    this.log = logger;
    this.fetch = fetchImpl;
  }

  get isStandby() {
    return this.config.get().instance.role === 'standby';
  }

  /**
   * Snapshot the standby's view of the primary, for the UI banners and the
   * /api/health payload. Primary instances report role only.
   */
  status() {
    if (!this.isStandby) return { role: 'primary' };
    return {
      role: 'standby',
      active: this.active,
      // still active (connected/armed) but no longer driving: the primary is
      // back and we're waiting out the release confirmation
      deferring: this.#deferring,
      primaryReachable: this.#reachable,
      failures: this.#failures,
      lastContactAt: this.#lastContactAt,
      lastSyncAt: this.#lastSyncAt,
      lastError: this.#lastError,
      primaryUrl: this.config.get().failover.primaryUrl,
      pollSeconds: this.config.get().failover.pollSeconds,
      failThreshold: this.config.get().failover.failThreshold,
    };
  }

  start() {
    if (!this.isStandby) return;
    const poll = () => this.#poll().catch((err) => this.log?.error({ err: err.message }, 'failover poll crashed'));
    this.#timer = setInterval(poll, this.config.get().failover.pollSeconds * 1000);
    this.#timer.unref?.();
    poll();
  }

  stop() {
    clearInterval(this.#timer);
  }

  async #poll() {
    const { failover } = this.config.get();
    let health = null;
    let error = null;
    try {
      const res = await this.fetch(`${failover.primaryUrl.replace(/\/$/, '')}/api/health`, {
        signal: AbortSignal.timeout(5000),
        headers: { Authorization: `Bearer ${failover.syncToken}` },
      });
      if (res.ok) health = await res.json();
      else error = `primary responded ${res.status}`;
    } catch (err) { error = err.message || 'unreachable'; }

    if (health?.status === 'ok') {
      const wasUnreachable = this.#reachable === false;
      const primaryCanDrive = health.lutronConnected === true;
      this.#failures = 0;
      // #successes counts consecutive polls of a FULLY capable primary — HTTP
      // ok AND holding its bridge. An HTTP-ok but bridge-less primary cannot
      // drive lights, so such polls must not count toward release: releasing
      // on them would close OUR working bridge with nobody able to drive.
      // (Strict === true: a primary too old to report the field never releases
      // us — double-driving is the safer failure mode than unattended.)
      this.#successes = primaryCanDrive ? this.#successes + 1 : 0;
      this.#reachable = true;
      this.#lastContactAt = new Date().toISOString();
      this.#lastError = null;
      // log only the recovery transition, not every healthy poll
      if (wasUnreachable) this.log?.info('primary reachable again');
      // Stand down from DRIVING as soon as the primary is provably back and
      // holding its own bridge — the formal release still waits for
      // recoverThreshold below. And the moment that proof lapses (the primary
      // still answers but reports its bridge DOWN — it cannot drive), resume
      // driving immediately: deferral is only ever justified by positive,
      // CURRENT proof, or it becomes a "nobody is driving" gap.
      if (this.active && !this.#deferring && primaryCanDrive) {
        this.#deferring = true;
        this.log?.warn('primary is back and holding its bridge — standing down from driving (release pending confirmation)');
      } else if (this.#deferring && !primaryCanDrive) {
        this.#deferring = false;
        this.log?.warn('primary lost its bridge while we were standing down — resuming drive authority');
      }
      await this.#maybeSync(health);
      if (this.active && this.#successes >= failover.recoverThreshold) await this.#release();
    } else {
      const wasReachable = this.#reachable !== false;
      this.#successes = 0;
      this.#failures += 1;
      this.#reachable = false;
      this.#lastError = error;
      // Contact lost again mid-recovery: resume driving immediately. This is
      // what guarantees deferral can never leave the house unattended.
      if (this.#deferring) {
        this.#deferring = false;
        this.log?.warn('lost the primary again while standing down — resuming drive authority');
      }
      // log the loss-of-contact transition once (at warn), then stay quiet so
      // an offline primary doesn't flood the log every poll
      if (wasReachable) this.log?.warn({ err: error, primaryUrl: failover.primaryUrl }, 'lost contact with primary');
      else this.log?.debug({ failures: this.#failures, err: error }, 'primary still unreachable');
      if (this.#failures === failover.failThreshold) {
        this.notifier?.send('primary-down', { failures: this.#failures });
      }
      if (!this.active && this.#failures >= failover.failThreshold) await this.#takeover();
    }
  }

  async #maybeSync(health) {
    const cfg = this.config.get();
    // mirror when the primary's config is different from what we last imported
    if (health.configVersion === this.state.get().failover.lastSyncedVersion) return;
    try {
      const res = await this.fetch(`${cfg.failover.primaryUrl.replace(/\/$/, '')}/api/sync/export`, {
        signal: AbortSignal.timeout(10_000),
        headers: { Authorization: `Bearer ${cfg.failover.syncToken}` },
      });
      if (!res.ok) throw new Error(`sync export ${res.status}`);
      const incoming = await res.json();
      this.config.import(incoming); // preserves our instance id/role & primaryUrl
      this.state.get().failover.lastSyncedVersion = health.configVersion;
      this.state.save({ flush: true });
      this.#lastSyncAt = new Date().toISOString();
      this.log?.info({ primaryVersion: health.configVersion }, 'config mirrored from primary');
      this.emit('synced', health.configVersion);
    } catch (err) {
      this.log?.error({ err: err.message }, 'config mirror failed');
    }
  }

  async #takeover() {
    this.active = true;
    this.#deferring = false; // a fresh takeover always drives
    this.state.get().failover = { ...this.state.get().failover, active: true, activeSince: new Date().toISOString() };
    this.state.save({ flush: true });
    this.log?.warn('FAILOVER: taking over light control');
    try {
      await this.lutron.connect();
    } catch (err) {
      this.log?.error({ err: err.message }, 'takeover: lutron connect failed (will keep retrying via client backoff)');
    }
    this.scheduler.recompile();
    await this.scheduler.reconcile();
    this.notifier?.send('takeover', { name: this.config.get().instance.name });
    this.emit('takeover');
  }

  async #release() {
    this.active = false;
    this.#deferring = false; // released outright — `active` alone now gates driving
    this.state.get().failover = { ...this.state.get().failover, active: false, activeSince: null };
    this.state.save({ flush: true });
    this.lutron.close();
    this.log?.info('failover: primary recovered, releasing control');
    this.notifier?.send('release', {});
    this.emit('release');
  }
}
