import { DateTime } from 'luxon';

/**
 * Deterministic [0,1) from string parts (FNV-1a + a final mix). Same inputs →
 * same output, so the primary and standby compute the identical "random"
 * away-mode timeline and the preview shows exactly what will happen.
 */
export function seededRand(...parts) {
  const str = parts.join('|');
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  h ^= h >>> 15; h = Math.imul(h, 2246822507); h ^= h >>> 13; h >>>= 0;
  return h / 4294967296;
}
const randRange = (lo, hi, ...parts) => lo + (hi - lo) * seededRand(...parts);
const toMinutes = (hhmm) => { const [h, m] = String(hhmm ?? '').split(':').map(Number); return (h || 0) * 60 + (m || 0); };

const DEFAULTS = { jitterMin: 15, shortenPct: 25, quietFrom: '23:00', quietTo: '06:00', varyPct: 18 };
const MIN_ON_MS = 5 * 60_000;       // never shorten a lit period below 5 minutes
const EVENING_LEAD_MS = 90 * 60_000; // "evening" begins 1.5h before sunset
const DAY_CAP_MIN = [45, 120];       // daytime lit periods capped to this many minutes

/**
 * "Away" presence-simulation transform over a compiled action list.
 *
 * Layers bounded, seeded randomness on the user's OWN schedule so the house
 * looks lived-in rather than robotic — and, crucially, keeps lights on for
 * LESS time than normal. Only touches presence-relevant light zones (plain
 * lights, i.e. no `kind`) whose fire time falls inside the away date window;
 * every other action passes through untouched.
 *
 * Transforms, per zone per LIT PERIOD (an ON … closing OFF pair — paired even
 * across midnight, so a Friday-night ON and its Saturday-12:30am OFF always
 * move/drop together; all deterministic, seeded by the day the period starts):
 *  - vary: ~varyPct% of periods stay dark entirely (ON and OFF drop together);
 *  - jitter: shift the whole period by ±jitterMin (order within it preserved);
 *  - shorten: pull the closing OFF earlier — gently in the evening, hard (and
 *    capped to DAY_CAP_MIN) during the day;
 *  - quiet hours: a period whose ON lands late at night is suppressed whole.
 *
 * Only actions that fire DURING a cluster's assur window (candle lighting →
 * havdalah) for a cluster overlapping the away date range are transformed —
 * exactly like Child Lock's active period. Erev prep (before candle lighting),
 * post-havdalah wind-down, and Chol Hamoed (never part of a cluster) are all
 * left untouched.
 *
 * @param {Array} actions
 * @param {{ awayMode: object, zones: Array, tzid: string, clusters: Array,
 *           sunsetMs: (dateISO: string) => number|null }} opts
 */
export function applyAwayMode(actions, { awayMode, zones = [], tzid = 'UTC', clusters = [], sunsetMs = null } = {}) {
  if (!awayMode?.enabled || !awayMode.from || !awayMode.to) return actions;
  const cfg = { ...DEFAULTS, ...awayMode };
  const seed = cfg.seed || 'away';
  const jitterMs = Math.max(0, cfg.jitterMin) * 60_000;
  const shorten = Math.min(0.6, Math.max(0, cfg.shortenPct / 100));
  const varyP = Math.min(0.6, Math.max(0, cfg.varyPct / 100));
  const presence = new Set(zones.filter((z) => !z.kind).map((z) => z.id)); // plain lights only
  const localDate = (ms) => DateTime.fromMillis(ms, { zone: tzid }).toFormat('yyyy-MM-dd');
  // assur windows (candle lighting → havdalah) of clusters overlapping [from,to].
  // Keying off these means erev prep, post-havdalah, and Chol Hamoed (never in a
  // cluster) are left untouched — away mode matches Child Lock's active period.
  const intervals = clusters
    .filter((c) => localDate(c.endsAt.getTime()) >= cfg.from && localDate(c.startsAt.getTime()) <= cfg.to)
    .map((c) => [c.startsAt.getTime(), c.endsAt.getTime()]);
  const inAssur = (ms) => intervals.some(([s, e]) => ms >= s && ms <= e);
  const qFrom = toMinutes(cfg.quietFrom);
  const qTo = toMinutes(cfg.quietTo);
  const inQuiet = (ms) => {
    const dt = DateTime.fromMillis(ms, { zone: tzid });
    const m = dt.hour * 60 + dt.minute;
    return qFrom <= qTo ? (m >= qFrom && m < qTo) : (m >= qFrom || m < qTo);
  };

  const keep = [];
  const byZone = new Map();
  for (const a of actions) {
    // flashes (reminders) and non-light zones are never touched
    if (a.type === 'flash' || !presence.has(a.zone) || !inAssur(a.at)) { keep.push(a); continue; }
    (byZone.get(a.zone) ?? byZone.set(a.zone, []).get(a.zone)).push(a);
  }

  // Per zone: walk the sorted stream and pair every ON with its closing OFF
  // into one segment — EVEN ACROSS MIDNIGHT. (Grouping by calendar day, the old
  // approach, split a Friday-23:00 ON from its Saturday-00:30 OFF: `vary` could
  // drop the OFF alone — light stuck ON all night — and independent per-day
  // jitter could invert their order. Segments make every transform atomic.)
  const out = [...keep];
  for (const [zone, arr] of byZone) {
    arr.sort((x, y) => x.at - y.at);
    const zid = String(zone);
    let prevEnd = null; // end of the previously emitted action (overlap clamp)
    let i = 0;
    while (i < arr.length) {
      // a leading/orphan OFF (no preceding ON — e.g. closing an erev-lit light)
      // passes through untouched
      if (!(arr[i].level > 0)) { prevEnd = Math.max(prevEnd ?? 0, arr[i].at); out.push(arr[i]); i += 1; continue; }
      // lit period: the ON, any intermediate level changes, the closing OFF
      const seg = [arr[i]]; i += 1;
      while (i < arr.length) { const a = arr[i]; seg.push(a); i += 1; if (a.level === 0) break; }
      const d = localDate(seg[0].at); // seeded by the day the period STARTS
      if (seededRand(seed, 'vary', zid, d) < varyP) continue; // dark — ON and OFF drop together
      const jit = Math.round(randRange(-1, 1, seed, 'jitter', zid, d) * jitterMs);
      const moved = seg.map((a) => ({ ...a, at: a.at + jit }));
      // jitter must never overlap the previous period — shift forward if needed
      if (prevEnd != null && moved[0].at < prevEnd + 60_000) {
        const shift = prevEnd + 60_000 - moved[0].at;
        for (const a of moved) a.at += shift;
      }
      const on = moved[0];
      if (inQuiet(on.at)) continue; // no late-night turn-ons — suppress the whole period
      const off = moved[moved.length - 1].level === 0 ? moved[moved.length - 1] : null;
      if (off) {
        const gap = off.at - on.at;
        if (gap > MIN_ON_MS) {
          // TIME-OF-DAY aware shortening: evenings (from 1.5h before sunset on)
          // keep most of their duration — that's when presence reads; daytime
          // periods are trimmed hard and capped (lights barely show in daylight).
          const sunset = sunsetMs?.(localDate(on.at));
          const isEvening = !sunset || on.at >= sunset - EVENING_LEAD_MS;
          if (isEvening) {
            off.at -= Math.round((gap - MIN_ON_MS) * shorten * 0.35 * seededRand(seed, 'cutE', zid, d));
          } else {
            off.at -= Math.round((gap - MIN_ON_MS) * Math.min(0.85, shorten * 2) * seededRand(seed, 'cutD', zid, d));
            const cap = Math.round((DAY_CAP_MIN[0] + seededRand(seed, 'cap', zid, d) * (DAY_CAP_MIN[1] - DAY_CAP_MIN[0])) * 60_000);
            if (off.at - on.at > cap) off.at = on.at + cap;
          }
          // the OFF stays after the floor and any intermediate level change
          const lastMid = moved.length > 2 ? moved[moved.length - 2].at : on.at;
          off.at = Math.max(off.at, on.at + MIN_ON_MS, lastMid + 60_000);
        }
      }
      out.push(...moved);
      prevEnd = moved[moved.length - 1].at;
    }
  }
  return out;
}
