import { DateTime } from 'luxon';

const CONTRADICTION_WINDOW_MIN = 10;

/**
 * Compile-time lint over a compiled timeline. Produces warnings (never
 * blockers) with concrete times and actionable suggestions, so the user can
 * fix schedule collisions before Shabbos rather than discover them during it.
 */
export class ConflictDetector {
  constructor({ tzid, windowMin = CONTRADICTION_WINDOW_MIN, zones = [] }) {
    this.tzid = tzid;
    this.windowMin = windowMin;
    this.zoneName = (id) => zones.find((z) => z.id === id)?.friendlyName || zones.find((z) => z.id === id)?.name || `device ${id}`;
  }

  /**
   * @param {Array} allActions sorted compiled actions (unwindowed)
   * @param {Array} clusters
   * @returns {Array<{type, severity, message, suggestion?, actions?}>}
   */
  detect(allActions, clusters) {
    // Only genuine problems are flagged: two rules fighting over the same zone
    // (a real setting conflict — caught across day-types by zone), and rules
    // that resolve onto a regular weekday far outside any Shabbos/Yom Tov
    // window (a broken trigger). A rule that merely lands a few hours into the
    // adjacent day of a weekend — a Shabbos-day rule slipping to Friday night,
    // or a motzei-Shabbos Yom Tov rule — is NOT flagged: those days flow into
    // each other, exactly like a Friday-night rule landing on Shabbos.
    return [
      ...this.#contradictions(allActions),
      ...this.#outOfCluster(allActions, clusters),
    ];
  }

  #contradictions(allActions) {
    const warnings = [];
    const byZone = new Map();
    for (const a of allActions) {
      if (a.type !== 'setLevel') continue;
      if (!byZone.has(a.zone)) byZone.set(a.zone, []);
      byZone.get(a.zone).push(a);
    }
    for (const [zone, list] of byZone) {
      for (let i = 1; i < list.length; i++) {
        const prev = list[i - 1];
        const cur = list[i];
        const gapMin = (cur.at - prev.at) / 60000;
        if (gapMin <= this.windowMin && prev.level !== cur.level) {
          // scene-internal stagger is intentional, not a contradiction
          if (prev.source.ruleId === cur.source.ruleId && prev.source.sceneId === cur.source.sceneId) continue;
          // a guest action superseding a base one is an intended OVERRIDE, not a
          // fight (the compiler already drops the base action it overrides; this
          // guards the boundary case where they sit just outside that window)
          if (Boolean(prev.source.guest) !== Boolean(cur.source.guest)) continue;
          const gap = Math.max(1, Math.round(gapMin));
          warnings.push({
            type: 'contradiction',
            severity: 'warn',
            zone,
            message: `${this.zoneName(zone)} is ${levelText(prev.level)} by “${ruleName(prev.source)}” at ${this.#fmt(prev.at)}, `
              + `then ${levelText(cur.level)} by “${ruleName(cur.source)}” just ${gap} ${gap === 1 ? 'minute' : 'minutes'} later at ${this.#fmt(cur.at)}.`,
            suggestion: 'Those two rules fight over the same device. Space them further apart, or remove one.',
            actions: [prev, cur],
          });
        }
      }
    }
    return warnings;
  }

  #outOfCluster(allActions, clusters) {
    const warnings = [];
    const seen = new Set(); // one warning per rule per date (scene members collapse)
    const ranges = clusters.map((c) => ({
      id: c.id,
      start: c.startsAt.getTime() - 12 * 3600_000,
      end: c.endsAt.getTime() + 2 * 3600_000,
    }));
    for (const a of allActions) {
      const range = ranges.find((r) => r.id === a.source.clusterId);
      if (range && (a.at < range.start || a.at > range.end)) {
        const key = `${a.source.ruleId}|${a.source.date}`;
        if (seen.has(key)) continue;
        seen.add(key);
        warnings.push({
          type: 'out-of-cluster',
          severity: 'warn',
          zone: a.zone,
          message: `Rule ${ruleName(a.source)} on ${a.source.date} resolves to ${this.#fmt(a.at)}, `
            + `far outside its Shabbos/Yom Tov window.`,
          suggestion: 'Check the trigger offset/nextDay flags — this action would fire on a regular weekday.',
          actions: [a],
        });
      }
    }
    return warnings;
  }

  #fmt(ms) {
    return DateTime.fromMillis(ms, { zone: this.tzid }).toFormat('EEE MMM d h:mma');
  }
}

// Plain-language action: turned on / off / set to a dimmer percentage.
function levelText(level) {
  return level >= 100 ? 'turned on' : level > 0 ? `set to ${level}%` : 'turned off';
}

// A readable name for a rule that may be unnamed (label is an empty string).
function ruleName(source) {
  return source?.label || 'an unnamed rule';
}
