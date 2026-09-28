/**
 * Device-kind predicates shared across the runtime.
 *
 * MOMENTARY kinds are triggers, not states: they fire once, at their rule's
 * time, and hold no level afterwards. Every part of the app that reasons about
 * "what should this zone be set to right now" has to exclude them, or it will
 * RE-FIRE something that already ran:
 *
 *  - reconcile / Child Lock catch-up would re-trigger them on every boot,
 *    reconnect, takeover and config save;
 *  - expectedLevel would report them as "supposed to be on", so Child Lock
 *    would fight a state they never actually hold;
 *  - test mode's snapshot/restore would fire them again on exit;
 *  - the execute path skips the verify-and-retry loop for them, because a
 *    retry could re-run an action that actually went through.
 *
 * Keeping the list HERE (rather than `kind === 'automation'` scattered across
 * a dozen call sites) is what makes adding a new momentary kind safe: miss one
 * site and the new kind silently becomes stateful.
 */
export const MOMENTARY_KINDS = new Set([
  'automation', // Home Assistant automation / script / scene
  'webhook',    // an outbound HTTP call
]);

/** True for a zone that fires once and holds no level. */
export function isMomentary(zone) {
  return MOMENTARY_KINDS.has(zone?.kind);
}
