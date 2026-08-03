import { describe, it, expect } from 'vitest';
import { DateTime } from 'luxon';
import { CalendarService } from '../../server/calendar/CalendarService.js';
import { SceneRepository } from '../../server/engine/SceneRepository.js';
import { TimelineCompiler, expectedLevel } from '../../server/engine/TimelineCompiler.js';

const monsey = { lat: 41.1126, lng: -74.0176, tzid: 'America/New_York', il: false, elevation: 0, city: 'Monsey' };
const times = { candleLightingMins: 18, havdalahMins: 45, tzeitAngle: 8.5 };
const TZ = monsey.tzid;

const sceneRepo = new SceneRepository([
  { id: 'mealtime', actions: [{ zone: 3, level: 100 }, { zone: 9, level: 100 }],
    endActions: [{ zone: 3, level: 0 }, { zone: 9, level: 0 }] },
]);

function compileFor(schedules, fromISO, toISO, opts = {}) {
  const calendar = new CalendarService({ location: monsey, times });
  const clusters = calendar.clusters(fromISO, toISO);
  const compiler = new TimelineCompiler({ calendar, sceneRepo, schedules, ...opts });
  const start = DateTime.fromISO(`${fromISO}T00:00`, { zone: TZ }).minus({ days: 2 }).toMillis();
  const end = DateTime.fromISO(`${toISO}T00:00`, { zone: TZ }).plus({ days: 3 }).toMillis();
  return { ...compiler.compile(clusters, start, end), clusters, calendar };
}

function local(ms) {
  return DateTime.fromMillis(ms, { zone: TZ }).toFormat('yyyy-MM-dd HH:mm');
}

describe('TimelineCompiler — plain Shabbos', () => {
  const schedules = {
    shabbos: {
      default: {
        rules: [
          { id: 'r-cl', label: 'foyer on before candles', enabled: true,
            action: { type: 'setLevel', zone: 6, level: 100 },
            // "before candles" is an erev/night-before rule: candle lighting is
            // Friday evening, so it must resolve against the night Shabbos begins
            trigger: { kind: 'zman', zman: 'candleLighting', offsetMin: -90, day: 'erev' } },
          { id: 'r-meal', label: 'mealtime scene', enabled: true,
            action: { type: 'sceneStart', sceneId: 'mealtime' },
            trigger: { kind: 'fixed', time: '12:00' } },
          { id: 'r-meal-end', label: 'mealtime ends', enabled: true,
            action: { type: 'sceneEnd', sceneId: 'mealtime' },
            trigger: { kind: 'fixed', time: '16:00' } },
          { id: 'r-off', label: 'all off after havdalah', enabled: true,
            action: { type: 'setLevel', zone: 6, level: 0 },
            trigger: { kind: 'zman', zman: 'havdalah', offsetMin: 30 } },
          { id: 'r-disabled', label: 'disabled rule', enabled: false,
            action: { type: 'setLevel', zone: 2, level: 100 },
            trigger: { kind: 'fixed', time: '13:00' } },
        ],
      },
    },
  };

  it('compiles absolute, sorted actions with scene expansion', () => {
    // Shabbos May 3 2025 Monsey: sunset Fri 7:54pm → candles 7:36pm; sunset Sat 7:55pm → havdalah 8:40pm
    const { actions } = compileFor(schedules, '2025-05-03', '2025-05-03');
    expect(local(actions[0].at)).toBe('2025-05-02 18:06'); // candleLighting 19:36 − 90
    const meals = actions.filter((a) => a.source.ruleId === 'r-meal');
    expect(meals.map((a) => a.zone)).toEqual([3, 9]);
    expect(meals[1].at - meals[0].at).toBe(250); // stagger
    const ends = actions.filter((a) => a.source.ruleId === 'r-meal-end');
    expect(ends.every((a) => a.level === 0)).toBe(true);
    const off = actions.find((a) => a.source.ruleId === 'r-off');
    expect(local(off.at)).toBe('2025-05-03 21:11'); // havdalah 20:40 (+1min safety) + 30
    expect(actions.some((a) => a.source.ruleId === 'r-disabled')).toBe(false);
    // sorted
    for (let i = 1; i < actions.length; i++) expect(actions[i].at).toBeGreaterThanOrEqual(actions[i - 1].at);
  });

  it('expectedLevel returns last governing level, undefined before any action', () => {
    const { allActions } = compileFor(schedules, '2025-05-03', '2025-05-03');
    const noon = DateTime.fromISO('2025-05-03T12:30', { zone: TZ }).toMillis();
    const evening = DateTime.fromISO('2025-05-03T17:00', { zone: TZ }).toMillis();
    const weekBefore = DateTime.fromISO('2025-04-28T12:00', { zone: TZ }).toMillis();
    expect(expectedLevel(allActions, 3, noon)).toBe(100);
    expect(expectedLevel(allActions, 3, evening)).toBe(0);
    expect(expectedLevel(allActions, 3, weekBefore)).toBeUndefined();
  });

  it('actions stop governing once their cluster ends (Motzei is free)', () => {
    const { allActions } = compileFor(schedules, '2025-05-03', '2025-05-03');
    // havdalah Sat 20:41; in-cluster meal-end (16:00, level 0) governs zone 3
    // through the end of Shabbos...
    const lateShabbos = DateTime.fromISO('2025-05-03T20:30', { zone: TZ }).toMillis();
    expect(expectedLevel(allActions, 3, lateShabbos)).toBe(0);
    // ...but NOT at the Sunday 00:05 daily-cron reconcile — lights someone
    // turned on Motzei must never be snapped back to the schedule
    const sundayCron = DateTime.fromISO('2025-05-04T00:05', { zone: TZ }).toMillis();
    expect(expectedLevel(allActions, 3, sundayCron)).toBeUndefined();

    // the wind-down rule (havdalah+30, ~21:11) still governs for its grace
    // hour — a reboot right after a missed "all off" re-applies it...
    const at2130 = DateTime.fromISO('2025-05-03T21:30', { zone: TZ }).toMillis();
    expect(expectedLevel(allActions, 6, at2130)).toBe(0);
    // ...and expires after that (21:11 + 1h ≈ 22:11)
    const at2300 = DateTime.fromISO('2025-05-03T23:00', { zone: TZ }).toMillis();
    expect(expectedLevel(allActions, 6, at2300)).toBeUndefined();
  });
});

describe('multi-day clusters: candleLighting/havdalah boundary zmanim', () => {
  const schedules = {
    shabbos: { default: { rules: [
      { id: 'r-start', action: { type: 'setLevel', zone: 6, level: 100 },
        trigger: { kind: 'zman', zman: 'candleLighting', offsetMin: 0 } },
      { id: 'r-hav', action: { type: 'setLevel', zone: 6, level: 0 },
        trigger: { kind: 'zman', zman: 'havdalah', offsetMin: 0 } },
    ] } },
    'pesach-1': { default: { rules: [
      { id: 'p1-hav', action: { type: 'setLevel', zone: 6, level: 0 },
        trigger: { kind: 'zman', zman: 'havdalah', offsetMin: 0 } },
    ] },
    'erev-is-shabbos': { rules: [
      { id: 'p1-seder-end', label: 'seder lights out', action: { type: 'setLevel', zone: 3, level: 0 },
        trigger: { kind: 'fixed', time: '02:30', day: 'erev', nextDay: true } },
    ] } },
    'pesach-2': { default: { rules: [
      { id: 'p2-hav', action: { type: 'setLevel', zone: 6, level: 0 },
        trigger: { kind: 'zman', zman: 'havdalah', offsetMin: 0 } },
    ] } },
  };

  it('havdalah rules fire only on the last cluster day; skips are reported', () => {
    const { actions, report } = compileFor(schedules, '2025-04-12', '2025-04-14');
    // Pesach 2025 cluster: shabbos(4/12) + pesach-1(4/13) + pesach-2(4/14)
    const hav = actions.filter((a) => a.source.ruleId.endsWith('-hav') || a.source.ruleId === 'r-hav');
    expect(hav).toHaveLength(1);
    expect(hav[0].source.date).toBe('2025-04-14');
    expect(local(hav[0].at)).toBe('2025-04-14 20:21'); // hebcal 8:20pm + 1min safety margin
    const skipped = report.skippedRules.map((s) => `${s.ruleId}@${s.date}`);
    expect(skipped).toContain('r-hav@2025-04-12');
    // p1-hav is NOT merely skipped on 4/13: the configured erev-is-shabbos
    // variant replaces the default rule list entirely, so it never evaluates.
    expect(actions.some((a) => a.source.ruleId === 'p1-hav')).toBe(false);
  });

  it('erev+nextDay fixed times land seder cleanup at 2:30am on the YT date', () => {
    const { actions } = compileFor(schedules, '2025-04-12', '2025-04-14');
    const seder = actions.find((a) => a.source.ruleId === 'p1-seder-end');
    expect(seder.source.variant).toBe('erev-is-shabbos');
    expect(local(seder.at)).toBe('2025-04-13 02:30');
  });

  // Regression: a "before candle lighting" rule written inside "Starts motzei
  // Shabbos" (Pesach I is day 2 of the 2025 cluster) must resolve to the
  // motzei-Shabbos candle lighting (tzeis of Saturday 4/12), from an existing
  // flame. That flame is the night Pesach I *begins*, so it's an erev anchor.
  it('candleLighting erev anchor resolves on the motzei-Shabbos flame, not skipped', () => {
    const seder = {
      'pesach-1': { 'erev-is-shabbos': { rules: [
        { id: 'seder-on', label: 'seder lights on', action: { type: 'setLevel', zone: 3, level: 100 },
          trigger: { kind: 'zman', zman: 'candleLighting', offsetMin: -30, day: 'erev' } },
      ] } },
    };
    const { actions, report, clusters } = compileFor(seder, '2025-04-12', '2025-04-14');
    const a = actions.find((x) => x.source.ruleId === 'seder-on');
    expect(a).toBeTruthy();
    expect(report.skippedRules.some((s) => s.ruleId === 'seder-on')).toBe(false);
    expect(a.source.date).toBe('2025-04-13'); // owned by the Pesach I day
    // its candle lighting = the cluster's 4/13 transition (motzei Shabbos); 30m before
    const cl = clusters[0].transitions.find((t) => t.date === '2025-04-13').at.getTime();
    expect(a.at).toBe(cl - 30 * 60000);
    expect(local(a.at).startsWith('2025-04-12')).toBe(true); // Saturday night
  });

  // Bulletproof: an EREV candleLighting rule (the flame a day begins on)
  // resolves on EVERY day of a cluster, first or not — day 0 to the cluster
  // start (Friday), every later day to that day's ushering flame (2nd-night
  // from an existing flame). None are skipped for an undefined zman.
  it('candleLighting (erev anchor) resolves on every cluster day — the flame it begins on', () => {
    const clRule = (dt) => ({ [dt]: { default: { rules: [
      { id: `cl-${dt}`, label: `candles ${dt}`, enabled: true, action: { type: 'setLevel', zone: 2, level: 100 },
        trigger: { kind: 'zman', zman: 'candleLighting', offsetMin: 0, day: 'erev' } },
    ] } } });
    const check = (fromISO, toISO, ...dayTypes) => {
      const schedules = Object.assign({}, ...dayTypes.map(clRule));
      const { actions, report, clusters } = compileFor(schedules, fromISO, toISO);
      const cluster = clusters[0];
      expect(report.skippedRules.filter((s) => (s.ruleId ?? '').startsWith('cl-'))).toHaveLength(0);
      cluster.days.forEach((d, i) => {
        const a = actions.find((x) => x.source.ruleId === `cl-${d.dayType}` && x.source.date === d.date);
        expect(a, `candleLighting missing on ${d.dayType} ${d.date}`).toBeTruthy();
        const expected = i === 0 ? cluster.startsAt.getTime() : cluster.transitions.find((t) => t.date === d.date).at.getTime();
        expect(a.at, `${d.dayType} ${d.date}`).toBe(expected);
      });
    };
    // 3-day motzei-Shabbos Pesach 2025 (shabbos → pesach-1 → pesach-2)
    check('2025-04-12', '2025-04-14', 'shabbos', 'pesach-1', 'pesach-2');
    // a plain 2-day Yom Tov, both days (Sun-Mon 2024)
    check('2024-06-12', '2024-06-13', 'shavuos-1', 'shavuos-2');
  });

  // The section fix: candle lighting respects the day/section it's placed in,
  // exactly like shkia. A "the day itself" (day-of) rule resolves to the flame
  // lit THAT evening — Pesach I's own Sunday-evening candle lighting (into
  // Pesach II) — not the motzei-Shabbos flame that started Pesach I.
  it('candleLighting "the day itself" resolves to that day’s own evening flame', () => {
    const s = { 'pesach-1': { 'erev-is-shabbos': { rules: [
      { id: 'p1-day', label: 'day-of candles', enabled: true, action: { type: 'setLevel', zone: 2, level: 100 },
        trigger: { kind: 'zman', zman: 'candleLighting', offsetMin: -60, day: 'day' } },
    ] } } };
    const { actions, clusters } = compileFor(s, '2025-04-12', '2025-04-14');
    const a = actions.find((x) => x.source.ruleId === 'p1-day');
    expect(a).toBeTruthy();
    // Pesach I is 4/13; its OWN evening candle lighting is the 4/14 transition
    // (the flame going into Pesach II, lit Sunday 4/13 evening).
    const own = clusters[0].transitions.find((t) => t.date === '2025-04-14').at.getTime();
    expect(a.at).toBe(own - 60 * 60000);
    expect(local(a.at).startsWith('2025-04-13')).toBe(true); // Sunday evening, not Saturday
  });

  // A candle-lighting rule placed on a day whose evening has NO candle lighting
  // (a plain Shabbos "the day itself" — Saturday evening is havdalah) is skipped
  // with a clear, actionable reason the editor can block on.
  it('candleLighting "the day itself" on a plain Shabbos is skipped with a candle-lighting reason', () => {
    const s = { shabbos: { default: { rules: [
      { id: 'sat-cl', label: 'saturday candles', enabled: true, action: { type: 'setLevel', zone: 2, level: 100 },
        trigger: { kind: 'zman', zman: 'candleLighting', offsetMin: -30, day: 'day' } },
    ] } } };
    const { actions, report } = compileFor(s, '2025-05-03', '2025-05-03');
    expect(actions.some((a) => a.source.ruleId === 'sat-cl')).toBe(false);
    const skip = report.skippedRules.find((r) => r.ruleId === 'sat-cl');
    expect(skip).toBeTruthy();
    expect(skip.reason).toMatch(/no candle lighting/i);
    expect(skip.wouldFireAt).toBeNull(); // an undefined zman has no place on the timeline
  });

  // A rule silenced by a "don't-fire" condition still has a base time — the
  // preview shows it greyed-out exactly where it would have fired.
  it('a condition-skipped rule reports the time it WOULD have fired', () => {
    const s = { shabbos: { default: { rules: [
      { id: 'reminder', label: '5 min before shkia reminder', enabled: true,
        action: { type: 'flash', zone: 2, times: 1 },
        trigger: { kind: 'fixed', time: '17:00',
          conditions: [{ if: { zman: 'sunset', cmp: 'after', time: '12:00' }, then: { skip: true } }] } },
    ] } } };
    const { report } = compileFor(s, '2025-05-03', '2025-05-03');
    const skip = report.skippedRules.find((r) => r.ruleId === 'reminder');
    expect(skip).toBeTruthy();
    expect(skip.reason).toMatch(/don.t-fire/i);
    expect(skip.wouldFireAt).toBeTruthy();
    expect(local(new Date(skip.wouldFireAt).getTime())).toBe('2025-05-03 17:00');
  });
});

describe('variant fallback reporting', () => {
  it('unconfigured variant falls back to default and is reported', () => {
    const schedules = {
      'pesach-1': { default: { rules: [
        { id: 'p1', action: { type: 'setLevel', zone: 2, level: 100 }, trigger: { kind: 'fixed', time: '11:00' } },
      ] } },
    };
    const { actions, report } = compileFor(schedules, '2025-04-13', '2025-04-13');
    expect(report.unconfiguredVariants).toContainEqual(
      expect.objectContaining({ dayType: 'pesach-1', variant: 'erev-is-shabbos', date: '2025-04-13' }),
    );
    expect(actions.some((a) => a.source.ruleId === 'p1' && a.source.date === '2025-04-13')).toBe(true);
  });

  it('days with no schedule at all are reported unscheduled', () => {
    const { report } = compileFor({}, '2025-05-03', '2025-05-03');
    expect(report.unscheduledDays).toContainEqual(
      expect.objectContaining({ dayType: 'shabbos', date: '2025-05-03' }),
    );
  });
});

describe('guest mode layers on top of the regular schedule', () => {
  const schedules = {
    shabbos: {
      default: { rules: [
        // basement (zone 3): on at 12:00, off at 23:00
        { id: 'r-base3-on', action: { type: 'setLevel', zone: 3, level: 100 }, trigger: { kind: 'fixed', time: '12:00' } },
        { id: 'r-base3-off', action: { type: 'setLevel', zone: 3, level: 0 }, trigger: { kind: 'fixed', time: '23:00' } },
        { id: 'r-base9', action: { type: 'setLevel', zone: 9, level: 80 }, trigger: { kind: 'fixed', time: '13:00' } },
      ] },
      // guest: basement off earlier, at 19:30
      guest: { rules: [
        { id: 'r-guest3', action: { type: 'setLevel', zone: 3, level: 0 }, trigger: { kind: 'fixed', time: '19:30' } },
      ] },
    },
  };

  it('OFF: regular schedule only; guest rules ignored', () => {
    const { actions } = compileFor(schedules, '2025-05-03', '2025-05-03', { guestMode: false });
    expect(actions.filter((a) => a.zone === 3).map((a) => a.level)).toEqual([100, 0]); // on 12:00, off 23:00
    expect(actions.filter((a) => a.zone === 9).map((a) => a.level)).toEqual([80]);
  });

  it('ON: regular basement "on 12:00" is KEPT; guest adds the 19:30 off', () => {
    const { actions } = compileFor(schedules, '2025-05-03', '2025-05-03', { guestMode: true });
    // zone 3, sorted by time: on 12:00 (kept), off 19:30 (guest), off 23:00 (kept, no-op)
    const z3 = actions.filter((a) => a.zone === 3);
    expect(z3.map((a) => a.level)).toEqual([100, 0, 0]);
    expect(z3.map((a) => new Date(a.at).getHours())).toEqual([12, 19, 23]);
    // zone 9: untouched by guest -> regular rule survives
    expect(actions.filter((a) => a.zone === 9).map((a) => a.level)).toEqual([80]);
  });

  it('ON: a guest action at the same device+time supersedes the regular one', () => {
    const same = structuredClone(schedules);
    same.shabbos.guest.rules = [{ id: 'g', action: { type: 'setLevel', zone: 3, level: 40 }, trigger: { kind: 'fixed', time: '12:00' } }];
    const { actions } = compileFor(same, '2025-05-03', '2025-05-03', { guestMode: true });
    const z3 = actions.filter((a) => a.zone === 3);
    // 12:00 becomes 40% (guest wins the exact-time clash); 23:00 off still there
    expect(z3.find((a) => new Date(a.at).getHours() === 12).level).toBe(40);
    expect(z3).toHaveLength(2);
  });

  it('ON but past the until boundary: guest does not apply', () => {
    const { actions } = compileFor(schedules, '2025-05-03', '2025-05-03',
      { guestMode: true, guestUntil: Date.parse('2020-01-01') });
    expect(actions.filter((a) => a.zone === 3).map((a) => a.level)).toEqual([100, 0]);
  });
});

describe('DST fall-back weekend compiles cleanly', () => {
  it('cross-midnight action lands after the repeated hour with valid ordering', () => {
    const schedules = { shabbos: { default: { rules: [
      { id: 'late', action: { type: 'setLevel', zone: 3, level: 0 },
        trigger: { kind: 'fixed', time: '02:30', nextDay: true } },  // Sun Nov 2 2025, 2:30am EST (post-fallback)
      { id: 'on', action: { type: 'setLevel', zone: 3, level: 100 },
        trigger: { kind: 'zman', zman: 'sunset', offsetMin: -60 } },
    ] } } };
    const { actions } = compileFor(schedules, '2025-11-01', '2025-11-01');
    const late = actions.find((a) => a.source.ruleId === 'late');
    const on = actions.find((a) => a.source.ruleId === 'on');
    expect(Number.isNaN(late.at)).toBe(false);
    expect(late.at).toBeGreaterThan(on.at);
    expect(local(late.at)).toBe('2025-11-02 02:30');
    expect(DateTime.fromMillis(late.at, { zone: TZ }).offset).toBe(-300); // EST, after fall-back
  });
});

describe('situation inheritance (layerOnRegular)', async () => {
  const { layerOnRegular } = await import('../../server/engine/TimelineCompiler.js');
  const base = [
    { id: 'a', label: 'on', action: { type: 'setLevel', zone: 1, level: 100 }, trigger: { kind: 'fixed', time: '18:00' } },
    { id: 'b', label: 'off', action: { type: 'setLevel', zone: 1, level: 0 }, trigger: { kind: 'fixed', time: '23:00' } },
  ];
  it('empty inheriting situation = Regular verbatim', () => {
    expect(layerOnRegular(base, { rules: [] })).toEqual(base);
  });
  it('overrides replace by id, removals hide, additions append', () => {
    const situation = {
      removedIds: ['b'],
      rules: [
        { id: 'x', overridesId: 'a', label: 'on later', action: base[0].action, trigger: { kind: 'fixed', time: '19:00' } },
        { id: 'y', label: 'extra', action: { type: 'setLevel', zone: 2, level: 50 }, trigger: { kind: 'fixed', time: '20:00' } },
      ],
    };
    const out = layerOnRegular(base, situation);
    expect(out.map((r) => r.id)).toEqual(['x', 'y']);
    expect(out[0].trigger.time).toBe('19:00');
  });
  it('an override whose Regular rule was deleted degrades to a plain rule', () => {
    const out = layerOnRegular([base[1]], { rules: [{ id: 'x', overridesId: 'a', label: 'orphan', action: base[0].action, trigger: base[0].trigger }] });
    expect(out.map((r) => r.id)).toEqual(['b', 'x']);
  });
});

describe('chatzos of the night — nextDay resolves the coming night', () => {
  // chatzotNight(X) is the midnight LEADING INTO X (early-morning of X). For a
  // Friday-evening (erev) rule, "chatzos of the night" means Friday night, i.e.
  // early Saturday — which is chatzotNight of the next civil day.
  const ruleFor = (nextDay) => ({
    shabbos: { default: { rules: [
      { id: 'r-chatzos', label: 'chatzos rule', enabled: true,
        action: { type: 'setLevel', zone: 6, level: 100 },
        trigger: { kind: 'zman', zman: 'chatzotNight', offsetMin: 60, day: 'erev', nextDay } },
    ] } },
  });

  it('without nextDay fires the erev date (Thursday night → early Friday)', () => {
    const { actions } = compileFor(ruleFor(false), '2025-05-03', '2025-05-03');
    const a = actions.find((x) => x.source.ruleId === 'r-chatzos');
    expect(local(a.at).startsWith('2025-05-02')).toBe(true); // early Friday
  });

  it('with nextDay fires the following civil day (Friday night → early Saturday)', () => {
    const { actions } = compileFor(ruleFor(true), '2025-05-03', '2025-05-03');
    const a = actions.find((x) => x.source.ruleId === 'r-chatzos');
    expect(local(a.at).startsWith('2025-05-03')).toBe(true); // early Saturday
  });
});

describe('TimelineCompiler — identical-action dedup', () => {
  const base = (rules) => ({ shabbos: { default: { rules } } });

  it('collapses two byte-identical rules to a single action', () => {
    const rules = [
      { id: 'a', label: 'basement off', enabled: true,
        action: { type: 'setLevel', zone: 5, level: 0 },
        trigger: { kind: 'fixed', time: '19:30' } },
      { id: 'b', label: 'basement off (dup)', enabled: true,
        action: { type: 'setLevel', zone: 5, level: 0 },
        trigger: { kind: 'fixed', time: '19:30' } },
    ];
    const { actions } = compileFor(base(rules), '2025-05-03', '2025-05-03');
    const hits = actions.filter((x) => x.zone === 5 && x.type === 'setLevel' && x.level === 0);
    expect(hits.length).toBe(1);
  });

  it('keeps a same-time collision with a DIFFERENT result (a real fight, not a dup)', () => {
    const rules = [
      { id: 'a', label: 'off', enabled: true,
        action: { type: 'setLevel', zone: 5, level: 0 },
        trigger: { kind: 'fixed', time: '19:30' } },
      { id: 'b', label: 'dim', enabled: true,
        action: { type: 'setLevel', zone: 5, level: 60 },
        trigger: { kind: 'fixed', time: '19:30' } },
    ];
    const { actions } = compileFor(base(rules), '2025-05-03', '2025-05-03');
    const hits = actions.filter((x) => x.zone === 5 && x.type === 'setLevel');
    expect(hits.length).toBe(2);
  });
});
