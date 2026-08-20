/**
 * The one way to drive a zone to a level. Every scheduled/enforcement/manual
 * writer must go through this exact sequence — coerce the level for the zone's
 * device type, register the command echo (so the device's ~OUTPUT isn't
 * mistaken for a wall-switch change), then write — because a copy that drifts
 * on any step silently reintroduces the echo-misdetection / false-latch bugs
 * this codebase exists to prevent. Callers hold the zone's ZoneLock turn and
 * have already made their own decisions (authority, latch, expected level);
 * this helper only executes the write contract.
 *
 * `verified: true` (schedule/enforcement writes) uses setLevelVerified —
 * retries + verify-before-fail. `verified: false` (preview/restore paths) is a
 * deliberate single best-effort setLevel: those writes are cosmetic and must
 * never retry-storm a struggling bridge. Throws on failure either way — each
 * caller owns its error handling (log, notify, or swallow).
 *
 * `deps` is any object carrying { devices, tracker } — Scheduler and
 * EnforcementEngine both do, so call as driveZone(this, ...).
 */
export async function driveZone({ devices, tracker }, zone, rawLevel, { verified = true, fadeSec = 0, attempts } = {}) {
  const level = devices.coerceLevel?.(zone, rawLevel) ?? rawLevel;
  tracker.expectCommand(zone, level);
  if (verified && devices.setLevelVerified) await devices.setLevelVerified(zone, level, fadeSec, attempts ? { attempts } : undefined);
  else await devices.setLevel(zone, level, fadeSec);
  return level;
}
