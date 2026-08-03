/**
 * A per-zone async mutex. Any operation that drives a zone's level — a
 * Scheduler reconcile pass, Child Lock's cluster-entry catch-up, a fired
 * timer, or EnforcementEngine correcting a manual override back to schedule
 * — computes "the expected level" and writes it independently, and more than
 * one of these can legitimately be triggered within the same second (a
 * config save, a cluster boundary, and an armed timer landing together is
 * ordinary). Without serialization, whichever one's device write happens to
 * SETTLE last wins, even if it started first and is stale by the time it
 * finishes (a slow device retry is exactly this shape). A single shared
 * instance across Scheduler and EnforcementEngine closes that gap for every
 * caller, not just the ones inside one class: different zones stay fully
 * independent (their own queue), and because every caller re-reads its
 * target fresh at execution time, whichever turn runs LAST is correct by
 * construction.
 */
export class ZoneLock {
  #tails = new Map(); // zone -> tail of its serialized queue

  /** Run `fn` for `zone` after every previously-queued op for that zone has
   *  settled (success or failure never blocks the next one). */
  run(zone, fn) {
    const tail = (this.#tails.get(zone) ?? Promise.resolve()).catch(() => {});
    const p = tail.then(fn);
    this.#tails.set(zone, p.catch(() => {}));
    return p;
  }
}
