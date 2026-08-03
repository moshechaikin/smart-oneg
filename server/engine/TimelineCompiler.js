import { DateTime } from 'luxon';
import { applyAwayMode } from './awayMode.js';

const SCENE_STAGGER_MS = 250;
const POST_CLUSTER_GRACE_MS = 3600_000; // wind-down actions after havdalah govern for 1h
// A guest action overrides base actions on the same device within this window,
// so "guest override" wins even when the base action isn't at the exact same
// millisecond (a scene staggers its members by SCENE_STAGGER_MS; two rules can
// anchor to the same moment via different zmanim). Matches ConflictDetector's
// contradiction window: wherever base and guest would be flagged as fighting,
// the guest wins instead.
const GUEST_OVERRIDE_WINDOW_MS = 10 * 60_000;

/**
 * Compiles rules + calendar clusters into a flat, sorted list of concrete
 * actions (absolute timestamps). Pure and deterministic: same inputs, same
 * timeline, which is what lets a rebooted or standby instance reconstruct
 * exactly what every zone should be right now.
 */
export class TimelineCompiler {
  /**
   * @param {CalendarService} calendar
   * @param {SceneRepository} sceneRepo
   * @param {object} schedules  config.schedules: { [dayType]: { [variant]: {rules:[]} } }
   */
  constructor({ calendar, sceneRepo, schedules, guestMode = false, guestUntil = null, awayMode = null, zones = [] }) {
    this.calendar = calendar;
    this.sceneRepo = sceneRepo;
    this.schedules = schedules;
    this.guestMode = guestMode;
    this.guestUntil = guestUntil; // ms; guest applies only to clusters ending at/before this
    this.awayMode = awayMode;     // presence-simulation config (or null/off)
    this.zones = zones;           // needed to tell light zones from appliances
    this.tzid = calendar.location.tzid;
  }

  /**
   * @param {Array} clusters from CalendarService.clusters()
   * @param {number} windowStartMs  include actions at/after this instant
   * @param {number} windowEndMs    include actions before this instant
   * @returns {{ actions: Array, report: object }}
   */
  compile(clusters, windowStartMs, windowEndMs) {
    const actions = [];
    const report = {
      compiledAt: new Date().toISOString(),
      window: { start: new Date(windowStartMs).toISOString(), end: new Date(windowEndMs).toISOString() },
      days: [],
      skippedRules: [],
      unconfiguredVariants: [],
      unscheduledDays: [],
      // base actions a guest override suppressed — not in `actions` (they never
      // fire), surfaced so the day editor can show them struck-through in place.
      overridden: [],
    };

    for (const cluster of clusters) {
      cluster.days.forEach((day, i) => {
        const daySchedules = this.schedules[day.dayType];
        if (!daySchedules || !hasAnyRules(daySchedules)) {
          report.unscheduledDays.push({ date: day.date, dayType: day.dayType, clusterId: cluster.id });
          return;
        }
        // Base schedule: this day's variant, falling back to default.
        let schedule = daySchedules[day.variant];
        if (day.variant !== 'default' && schedule?.inheritsRegular) {
          // approved inheritance model: Regular's rules (minus removed,
          // with per-id overrides applied) + the situation's own additions
          schedule = { rules: layerOnRegular(daySchedules.default?.rules ?? [], schedule) };
        } else if (day.variant !== 'default' && !schedule?.rules?.length) {
          report.unconfiguredVariants.push({
            date: day.date, dayType: day.dayType, variant: day.variant, clusterId: cluster.id,
          });
          schedule = daySchedules.default;
        }

        // Guest mode: MERGES onto the base for exactly the devices it names.
        // Guest applies only while enabled AND this cluster ends at/before the
        // "until" boundary set when it was turned on (so it auto-expires after
        // the one cluster it was enabled for).
        const guestApplies = this.guestMode
          && daySchedules.guest?.rules?.length
          && (this.guestUntil == null || cluster.endsAt.getTime() <= this.guestUntil + 60_000);

        if (!schedule?.rules?.length && !guestApplies) {
          report.unscheduledDays.push({ date: day.date, dayType: day.dayType, clusterId: cluster.id });
          return;
        }

        const ctx = {
          cluster, day,
          isFirstDay: i === 0,
          isLastDay: i === cluster.days.length - 1,
        };
        const dayReport = { date: day.date, dayType: day.dayType, variant: day.variant, guest: guestApplies, resolved: [] };

        const baseActions = this.#compileRules(schedule?.rules ?? [], ctx, report, dayReport);
        if (guestApplies) {
          const guestActions = this.#compileRules(daySchedules.guest.rules, ctx, report, dayReport);
          for (const a of guestActions) a.source = { ...a.source, guest: true }; // tag for the UI
          // Guest rules LAYER on top of the regular schedule: every regular
          // action still runs, EXCEPT one a guest action overrides — a guest
          // action supersedes base actions on the same device within
          // GUEST_OVERRIDE_WINDOW_MS of it. So "guest chandelier ON at candle
          // lighting" wins over a scene's staggered "chandelier OFF" at the same
          // moment (exact-time matching used to let both fire, and the later one
          // — the scene — silently won). Base actions elsewhere in time still
          // run: "basement off 7:30pm" in guest mode doesn't touch the regular
          // "on 6:00pm".
          const guestTimesByZone = new Map(); // zone -> [at, ...]
          for (const a of guestActions) {
            if (!guestTimesByZone.has(a.zone)) guestTimesByZone.set(a.zone, []);
            guestTimesByZone.get(a.zone).push(a.at);
          }
          const overriddenByGuest = (a) => (guestTimesByZone.get(a.zone) ?? [])
            .some((t) => Math.abs(t - a.at) <= GUEST_OVERRIDE_WINDOW_MS);
          for (const a of baseActions) {
            if (overriddenByGuest(a)) report.overridden.push({ ...a, dayType: day.dayType });
            else actions.push(a);
          }
          for (const a of guestActions) actions.push(a);
        } else {
          for (const a of baseActions) actions.push(a);
        }
        report.days.push(dayReport);
      });
    }

    // Away mode: layer seeded presence-simulation randomness on the compiled
    // schedule (jitter, shorter lit periods, quiet hours). Deterministic, so
    // both instances match and the preview is exact. No-op when off.
    const sunsetCache = new Map();
    const sunsetMs = (dateISO) => {
      if (!sunsetCache.has(dateISO)) {
        const s = this.calendar.zmanim(dateISO)?.sunset;
        sunsetCache.set(dateISO, s instanceof Date && !Number.isNaN(s.getTime()) ? s.getTime() : null);
      }
      return sunsetCache.get(dateISO);
    };
    const actions2 = applyAwayMode(actions, { awayMode: this.awayMode, zones: this.zones, tzid: this.tzid, clusters, sunsetMs });
    if (actions2 !== actions) { actions.length = 0; for (const a of actions2) actions.push(a); }

    // An action governs expected-state only until its cluster ends: once
    // havdalah passes, the app must not drive lights. Without this bound the
    // last action kept "governing" for up to 24h (the compile window's past
    // horizon), so the daily-cron / hub-reconnect reconcile would snap lights
    // someone turned on Motzei back to the schedule's final state. Wind-down
    // rules deliberately scheduled AFTER havdalah ("all off 30 min later")
    // get a bounded grace hour from their own time, a reboot right after a
    // missed off still applies it, but it can't haunt the rest of the night.
    const endsById = new Map(clusters.map((c) => [c.id, c.endsAt.getTime()]));
    for (const a of actions) {
      const end = endsById.get(a.source?.clusterId);
      if (end !== undefined) a.expiresAt = a.at > end ? a.at + POST_CLUSTER_GRACE_MS : end;
    }

    actions.sort((a, b) => a.at - b.at || a.zone - b.zone);
    // Collapse byte-identical actions: two rules (often from two situations that
    // share an evening — a Friday Yom Tov flowing into Shabbos, or the same rule
    // duplicated) can resolve to the exact same device, time, and result. Firing
    // both is redundant for a setLevel and actively wrong for a momentary
    // automation/scene (it would re-trigger). Keep the first; the timeline and
    // the bridge then both see one. A same-time collision with a DIFFERENT result
    // is a real fight, not a duplicate — it has a different key, so it survives
    // (and ConflictDetector still flags it).
    const deduped = dedupeActions(actions);
    actions.length = 0; for (const a of deduped) actions.push(a);
    const windowed = actions.filter((a) => a.at >= windowStartMs && a.at < windowEndMs);
    // keep everything (incl. past-of-window) available for expected-state math
    return { actions: windowed, allActions: actions, report };
  }

  /** Resolve a rule list for one day into a fresh action array (for merging). */
  #compileRules(rules, ctx, report, dayReport) {
    const out = [];
    for (const rule of rules) {
      if (rule.enabled === false) continue;
      if (!rule.action?.type) continue; // a half-built rule (no action chosen yet) in a draft preview
      const meta = {};
      const at = this.resolveTrigger(rule.trigger, ctx, meta);
      if (at === null) {
        // For a condition-skip the base trigger still has a time, resolve it
        // (ignoring the conditions) so the preview can show the rule greyed-out
        // exactly where it WOULD have fired. Undefined-zman skips have no place.
        let wouldFireAt = null;
        if (meta.skipped) {
          const baseAt = this.resolveTrigger({ ...rule.trigger, conditions: [] }, ctx, {});
          wouldFireAt = baseAt ? baseAt.toISOString() : null;
        }
        report.skippedRules.push({
          ruleId: rule.id,
          label: rule.label,
          date: ctx.day.date,
          dayType: ctx.day.dayType,
          wouldFireAt,
          reason: meta.skipped
            ? "disabled by a don't-fire condition"
            : meta.undefinedZman === 'havdalah'
              ? 'no havdalah on this day, Yom Tov follows, so it fires on the cluster’s last day instead'
              : meta.undefinedZman === 'candleLighting'
                ? 'no candle lighting this evening, candle lighting is only the night a day begins. Put this rule on the erev / night-before (or a day that has one).'
                : `${meta.undefinedZman ?? 'the trigger zman'} isn’t defined for this day, so this rule won’t fire this time`,
        });
        continue;
      }
      dayReport.resolved.push({ ruleId: rule.id, label: rule.label, at: at.toISOString() });
      this.#emit(out, rule, at.getTime(), ctx, report, meta);
    }
    return out;
  }

  /**
   * Resolve a rule trigger to an absolute Date for the given day, or null if
   * the referenced zman is undefined that day (e.g. havdalah mid-cluster).
   *
   * Order: conditions (first match replaces trigger) -> base time (zman+offset
   * or fixed) -> clamp bounds.
   */
  resolveTrigger(trigger, ctx, meta = {}) {
    let t = trigger;
    for (const cond of trigger.conditions ?? []) {
      if (this.#condMatches(cond.if, ctx)) {
        // a "don't fire" condition disables the whole rule for this day
        if (cond.then?.skip) { meta.skipped = true; return null; }
        t = { ...trigger, ...cond.then, conditions: [] };
        break;
      }
    }

    const dateISO = t.day === 'erev' ? prevDate(ctx.day.date) : ctx.day.date;
    let base;
    if (t.kind === 'fixed') {
      base = this.#fixedTime(dateISO, t.time, t.nextDay);
    } else {
      // `nextDay` resolves the zman on the following civil date. Needed for
      // "chatzos of the night": chatzotNight(X) is the midnight LEADING INTO X
      // (early-morning of X), so the chatzos of the night that FOLLOWS this
      // section's evening (e.g. Friday night) is chatzotNight of the next day.
      const zmanDate = t.nextDay ? nextDate(dateISO) : dateISO;
      const zman = this.#zmanValue(t.zman, zmanDate, ctx);
      if (!zman) { meta.undefinedZman = t.zman; return null; }
      base = new Date(zman.getTime() + (t.offsetMin ?? 0) * 60000);
      meta.zman = t.zman;
      meta.offsetMin = t.offsetMin ?? 0;
    }

    const clamp = t.clamp ?? {};
    if (clamp.notBefore) {
      const bound = this.#fixedTime(dateISO, clamp.notBefore, false);
      if (base < bound) { base = bound; meta.clamped = true; }
    }
    if (clamp.notAfter) {
      const bound = this.#fixedTime(dateISO, clamp.notAfter, false);
      if (base > bound) { base = bound; meta.clamped = true; }
    }
    return base;
  }

  #condMatches(ifClause, ctx) {
    const dateISO = ifClause.day === 'erev' ? prevDate(ctx.day.date) : ctx.day.date;
    const zman = this.#zmanValue(ifClause.zman, dateISO, ctx);
    if (!zman) return false;
    const ref = this.#fixedTime(dateISO, ifClause.time, false);
    return ifClause.cmp === 'after' ? zman > ref : zman < ref;
  }

  #zmanValue(name, dateISO, ctx) {
    if (name === 'candleLighting') {
      // Candle lighting resolves to the flame lit on the EVENING of this
      // section's own date, exactly like shkia resolves to that date's sunset.
      // A "the day itself" rule (dateISO = the day) uses the candle lighting done
      // that evening (going into the next day); an erev rule (dateISO = the night
      // before) uses the flame that ushers the day in. On Yom Tov a candle
      // lighting exists almost every evening; on a plain Shabbos only Friday has
      // one, so a Saturday "the day itself" rule finds none and is skipped, the
      // editor blocks saving it and tells you to move it to Friday/erev.
      const events = [ctx.cluster.startsAt, ...(ctx.cluster.transitions ?? []).map((t) => t.at)];
      return events.find((at) => at && this.#localDate(at) === dateISO) ?? null;
    }
    if (name === 'havdalah') {
      // havdalah only exists on the last day of a cluster; mid-cluster Yom Tov
      // follows, so it's genuinely undefined and the rule is skipped (surfaced).
      return ctx.isLastDay ? ctx.cluster.endsAt : null;
    }
    const z = this.calendar.zmanim(dateISO);
    const v = z[name];
    return v instanceof Date && !Number.isNaN(v.getTime()) ? v : null;
  }

  #localDate(date) {
    return DateTime.fromJSDate(date, { zone: this.tzid }).toFormat('yyyy-MM-dd');
  }

  #fixedTime(dateISO, hhmm, nextDay) {
    let dt = DateTime.fromISO(`${dateISO}T${hhmm}`, { zone: this.tzid });
    if (nextDay) dt = dt.plus({ days: 1 });
    return dt.toJSDate();
  }

  #emit(actions, rule, atMs, ctx, report, meta = {}) {
    const source = {
      clusterId: ctx.cluster.id,
      date: ctx.day.date,
      dayType: ctx.day.dayType,
      variant: ctx.day.variant,
      ruleId: rule.id,
      label: rule.label,
    };
    // zman-relative rules carry their zman + offset so previews can show
    // "6:54 PM · 1h 40m before shkia (sunset)"; clamped times don't (the
    // offset no longer describes the actual time)
    if (meta.zman && !meta.clamped) source.trigger = { zman: meta.zman, offsetMin: meta.offsetMin };
    const a = rule.action;
    // one rule may target several devices (action.zones); legacy rules have a
    // single action.zone
    const zones = a.zones?.length ? a.zones : [a.zone];
    switch (a.type) {
      case 'setLevel':
        for (const zone of zones) actions.push({ at: atMs, type: 'setLevel', zone, level: a.level, fadeSec: a.fadeSec ?? 0, ...(a.kelvin != null ? { kelvin: a.kelvin } : {}), ...(a.rgb != null ? { rgb: a.rgb } : {}), source });
        break;
      case 'setAutomation':
        // enable/disable an HA automation (e.g. turn off a motion→lights
        // automation for Shabbos, back on at havdalah)
        for (const zone of zones) actions.push({ at: atMs, type: 'setAutomation', zone, enabled: Boolean(a.enabled), source });
        break;
      case 'setPreset':
        for (const zone of zones) actions.push({ at: atMs, type: 'setPreset', zone, preset: a.preset, source });
        break;
      case 'setHvacMode':
        for (const zone of zones) actions.push({ at: atMs, type: 'setHvacMode', zone, hvacMode: a.hvacMode, source });
        break;
      case 'flash':
        // legacy rules stored seconds (2 = once, 4 = twice); new rules store times
        for (const zone of zones) actions.push({ at: atMs, type: 'flash', zone, times: a.times ?? (a.seconds >= 4 ? 2 : 1), source });
        break;
      case 'sceneStart':
      case 'sceneEnd': {
        // a deleted/broken scene must never take down the whole compile
        let resolved;
        try {
          resolved = this.sceneRepo.resolve(a.sceneId);
        } catch (err) {
          report?.skippedRules.push({ ruleId: rule.id, date: ctx.day.date, reason: `scene "${a.sceneId}": ${err.message}` });
          return;
        }
        const list = a.type === 'sceneStart' ? resolved.actions : resolved.endActions;
        list.forEach((sa, idx) => {
          // a scene member may be a reminder flash, a thermostat preset / hvac
          // mode, or a plain level
          const at = atMs + idx * SCENE_STAGGER_MS;
          const src = { ...source, sceneId: a.sceneId, scenePhase: a.type };
          if (sa.flash) actions.push({ at, type: 'flash', zone: sa.zone, times: sa.flash, source: src });
          else if (sa.preset != null) actions.push({ at, type: 'setPreset', zone: sa.zone, preset: sa.preset, source: src });
          else if (sa.hvacMode != null) actions.push({ at, type: 'setHvacMode', zone: sa.zone, hvacMode: sa.hvacMode, source: src });
          else actions.push({ at, type: 'setLevel', zone: sa.zone, level: sa.level, fadeSec: sa.fadeSec ?? 0,
            ...(sa.kelvin != null ? { kelvin: sa.kelvin } : {}), ...(sa.rgb != null ? { rgb: sa.rgb } : {}), source: src });
        });
        break;
      }
      default:
        throw new Error(`unknown rule action type: ${a.type}`);
    }
  }
}

/**
 * Expected level per zone at instant t, given the full (unwindowed) action
 * list. Returns undefined when no compiled action governs the zone yet —
 * enforcement must stay inactive for that zone.
 */
export function expectedLevel(allActions, zone, tMs) {
  let level;
  for (const a of allActions) {
    if (a.at > tMs) break;
    // expired = its cluster is over: post-havdalah nothing governs the zone
    if (a.expiresAt !== undefined && tMs > a.expiresAt) continue;
    if (a.zone === zone && a.type === 'setLevel') level = a.level;
  }
  return level;
}

/**
 * Layer a situation onto Regular: base rules minus removedIds, each replaced
 * by its override (matched by overridesId); the situation's other rules are
 * additive. An override whose Regular rule was deleted degrades to a plain
 * rule (safe: the tweak survives).
 */
export function layerOnRegular(baseRules, situation) {
  const removed = new Set(situation.removedIds ?? []);
  const own = situation.rules ?? [];
  const overrides = new Map(own.filter((r) => r.overridesId).map((r) => [r.overridesId, r]));
  const out = [];
  for (const b of baseRules) {
    if (removed.has(b.id)) continue;
    out.push(overrides.get(b.id) ?? b);
  }
  for (const r of own) {
    if (!r.overridesId || !baseRules.some((b) => b.id === r.overridesId)) out.push(r);
  }
  return out;
}

// Drop exact-duplicate actions (same device, time, and full effect), keeping the
// first. The key covers every action type's payload so only TRULY identical
// commands merge; anything differing (a different level at the same instant)
// keeps its own key and both survive.
function dedupeActions(actions) {
  const seen = new Set();
  const out = [];
  for (const a of actions) {
    const key = [
      a.zone, a.type, a.at,
      a.level ?? '', a.fadeSec ?? '', a.kelvin ?? '', JSON.stringify(a.rgb ?? null),
      a.enabled ?? '', a.preset ?? '', a.hvacMode ?? '', a.times ?? '',
    ].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out;
}

function hasAnyRules(daySchedules) {
  return Object.values(daySchedules ?? {}).some((s) => s?.rules?.length);
}

function prevDate(dateISO) {
  const [y, m, d] = dateISO.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12));
  dt.setUTCDate(dt.getUTCDate() - 1);
  return dt.toISOString().slice(0, 10);
}

function nextDate(dateISO) {
  const [y, m, d] = dateISO.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12));
  dt.setUTCDate(dt.getUTCDate() + 1);
  return dt.toISOString().slice(0, 10);
}
