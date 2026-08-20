import { EventEmitter } from 'node:events';

/**
 * Standby-side failover loop. Primary instances do nothing here.
 *
 * Every pollSeconds: GET {primaryUrl}/api/health.
 *  - failThreshold consecutive "primary can't drive" polls -> takeover():
 *    connect Lutron, boot catch-up via Scheduler, notify. "Can't drive" means
 *    unreachable OR reachable-but-reporting-its-bridge-down (devicesConnected:
 *    false) — a restart that brings HTTP back before the bridge must still
 *    trigger failover, not leave the house unattended.
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
  // primary side: instanceId -> last-seen ms for every backup that has polled
  // our /api/health with the sync token. A map (not one timestamp) so we can
  // detect MORE THAN ONE backup checking in — running multiple standbys makes
  // them fight over the bridge, so the UI warns about it.
  #backups = new Map();
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

  /** Primary side: a standby polled our /api/health with the sync token; record
   *  it keyed by its instance id (older backups that send none fall back to a
   *  caller-supplied tag, e.g. source IP). Prunes entries idle over an hour so
   *  a reinstalled backup with a fresh id can't grow the map without bound. */
  noteBackupContact(id = 'unknown') {
    const now = Date.now();
    this.#backups.set(id, now);
    for (const [k, ts] of this.#backups) if (now - ts > 3_600_000) this.#backups.delete(k);
  }
  get backupLastSeenAt() {
    let max = null;
    for (const ts of this.#backups.values()) if (max === null || ts > max) max = ts;
    return max;
  }
  get backupSeen() { return this.#backups.size > 0; }

  /** Number of DISTINCT backups that checked in within `windowMs` — the basis
   *  for the "multiple backups detected" guard. */
  liveBackupCount(windowMs) {
    const now = Date.now();
    let n = 0;
    for (const ts of this.#backups.values()) if (now - ts <= windowMs) n += 1;
    return n;
  }

  constructor({ configStore, stateStore, scheduler, devices, notifier, logger = null, fetchImpl = fetch }) {
    super();
    this.config = configStore;
    this.state = stateStore;
    this.scheduler = scheduler;
    this.devices = devices;
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
    if (!this.isStandby) {
      // Surface how many backups are checking in so the primary UI can warn
      // when more than one standby is running (they would fight over the
      // bridge). Live window mirrors the backup-silent threshold in index.js.
      const pollMs = (this.config.get().failover.pollSeconds ?? 10) * 1000;
      const backupCount = this.liveBackupCount(Math.max(120_000, pollMs * 6));
      return { role: 'primary', backupCount, multipleBackups: backupCount > 1 };
    }
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
        headers: {
          Authorization: `Bearer ${failover.syncToken}`,
          // identify THIS backup so the primary can tell distinct backups apart
          // and warn when more than one standby is checking in
          'X-SmartOneg-Instance': this.config.get().instance.id,
        },
      });
      if (res.ok) health = await res.json();
      else error = `primary responded ${res.status}`;
    } catch (err) { error = err.message || 'unreachable'; }

    const reachable = health?.status === 'ok';
    // Prefer the current `devicesConnected` field; fall back to the legacy
    // `lutronConnected` alias so a standby on a newer build still reads an
    // older primary correctly during a rolling update. Undefined on both (a
    // primary too old to report either) leaves this undefined — handled below
    // as "presumed driving", never a false takeover.
    const primaryConnected = health?.devicesConnected ?? health?.lutronConnected;
    const primaryCanDrive = primaryConnected === true;
    // A primary that answers HTTP but reports its bridge DOWN cannot drive
    // lights — it is useless for failover and must be treated exactly like an
    // unreachable one. This is the real restart case: after a container swap
    // the primary's HTTP is back in seconds while it still can't reach the
    // Lutron bridge, so keying takeover on HTTP liveness alone left the standby
    // asleep and the house unattended. A primary too OLD to report the field
    // (undefined) is presumed to be driving — a missing field never triggers
    // takeover (mirrors the release-side guard: double-driving beats a false
    // takeover against a healthy old primary).
    const primaryBridgeDown = reachable && primaryConnected === false;
    // Can the primary actually drive right now? Unreachable and up-but-bridge-
    // less both answer NO, and both must drive failover.
    const primaryHealthy = reachable && !primaryBridgeDown;

    // Config stays authoritative on any reachable primary — mirror it even when
    // its bridge is down, so a standby that takes over is already in sync.
    if (reachable) {
      const wasUnreachable = this.#reachable === false;
      this.#reachable = true;
      this.#lastContactAt = new Date().toISOString();
      if (wasUnreachable) this.log?.info('primary reachable again');
      await this.#maybeSync(health);
    } else {
      this.#reachable = false;
    }

    if (primaryHealthy) {
      this.#failures = 0;
      // #successes counts consecutive polls of a FULLY capable primary — HTTP
      // ok AND holding its bridge. An HTTP-ok but bridge-less primary cannot
      // drive lights, so such polls must not count toward release: releasing
      // on them would close OUR working bridge with nobody able to drive.
      // (Strict === true: a primary too old to report the field never releases
      // us — double-driving is the safer failure mode than unattended.)
      this.#successes = primaryCanDrive ? this.#successes + 1 : 0;
      this.#lastError = null;
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
      if (this.active && this.#successes >= failover.recoverThreshold) await this.#release();
    } else {
      const firstBadPoll = this.#failures === 0;
      this.#successes = 0;
      this.#failures += 1;
      // keep last-error meaningful for the UI banner: a primary we can't reach
      // reads differently from one that answers but can't drive.
      this.#lastError = primaryBridgeDown ? 'primary reachable but its bridge is down' : error;
      // Lost drive-capability again mid-recovery: resume driving immediately.
      // This is what guarantees deferral can never leave the house unattended.
      if (this.#deferring) {
        this.#deferring = false;
        this.log?.warn('primary can no longer drive while we were standing down — resuming drive authority');
      }
      // log the loss-of-capability transition once (at warn), then stay quiet so
      // a down primary doesn't flood the log every poll
      if (firstBadPoll) {
        if (primaryBridgeDown) this.log?.warn({ primaryUrl: failover.primaryUrl }, 'primary is up but its bridge is down — treating as a failover condition');
        else this.log?.warn({ err: error, primaryUrl: failover.primaryUrl }, 'lost contact with primary');
      } else {
        this.log?.debug({ failures: this.#failures, bridgeDown: primaryBridgeDown, err: error }, 'primary still cannot drive');
      }
      if (this.#failures === failover.failThreshold) {
        this.notifier?.send('primary-down', { failures: this.#failures, bridgeDown: primaryBridgeDown });
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
      await this.devices.connect();
    } catch (err) {
      this.log?.error({ err: err.message }, 'takeover: devices connect failed (will keep retrying via client backoff)');
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
    this.devices.close();
    this.log?.info('failover: primary recovered, releasing control');
    this.notifier?.send('release', {});
    this.emit('release');
  }
}
