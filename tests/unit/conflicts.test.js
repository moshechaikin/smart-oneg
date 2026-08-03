import { describe, it, expect } from 'vitest';
import { DateTime } from 'luxon';
import { CalendarService } from '../../server/calendar/CalendarService.js';
import { SceneRepository } from '../../server/engine/SceneRepository.js';
import { TimelineCompiler } from '../../server/engine/TimelineCompiler.js';
import { ConflictDetector } from '../../server/engine/ConflictDetector.js';

const monsey = { lat: 41.1126, lng: -74.0176, tzid: 'America/New_York', il: false, elevation: 0, city: 'Monsey' };
const times = { candleLightingMins: 18, havdalahMins: 45, tzeitAngle: 8.5 };
const TZ = monsey.tzid;

function detect(rules, dateISO) {
  const calendar = new CalendarService({ location: monsey, times });
  const clusters = calendar.clusters(dateISO, dateISO);
  const compiler = new TimelineCompiler({
    calendar,
    sceneRepo: new SceneRepository([{ id: 'meal', actions: [{ zone: 9, level: 100 }], endActions: [{ zone: 9, level: 0 }] }]),
    schedules: { shabbos: { default: { rules } } },
  });
  const start = DateTime.fromISO(`${dateISO}T00:00`, { zone: TZ }).minus({ days: 2 }).toMillis();
  const { allActions } = compiler.compile(clusters, start, start + 6 * 86400_000);
  return new ConflictDetector({ tzid: TZ }).detect(allActions, clusters);
}

describe('ConflictDetector', () => {
  it('flags the winter mealtime-end vs kitchen-relight contradiction with concrete times', () => {
    const rules = [
      { id: 'end-meal', label: 'mealtime ends', action: { type: 'sceneEnd', sceneId: 'meal' },
        trigger: { kind: 'fixed', time: '16:00' } },
      { id: 'kitchen-on', label: 'kitchen before sunset', action: { type: 'setLevel', zone: 9, level: 100 },
        trigger: { kind: 'zman', zman: 'sunset', offsetMin: -30 } },
    ];
    // Sat Dec 20 2025: sunset ≈ 4:31pm → kitchen-on ≈ 4:01pm, 1 min after off @ 4:00pm
    const warnings = detect(rules, '2025-12-20');
    const contradiction = warnings.find((w) => w.type === 'contradiction');
    expect(contradiction).toBeDefined();
    expect(contradiction.zone).toBe(9);
    expect(contradiction.message).toMatch(/mealtime ends/);
    expect(contradiction.message).toMatch(/kitchen before sunset/);
    expect(contradiction.suggestion).toMatch(/fight|space|remove/i);
  });

  it('is quiet when the same rules are far apart (summer)', () => {
    const rules = [
      { id: 'end-meal', label: 'mealtime ends', action: { type: 'sceneEnd', sceneId: 'meal' },
        trigger: { kind: 'fixed', time: '16:00' } },
      { id: 'kitchen-on', label: 'kitchen before sunset', action: { type: 'setLevel', zone: 9, level: 100 },
        trigger: { kind: 'zman', zman: 'sunset', offsetMin: -30 } },
    ];
    expect(detect(rules, '2025-06-21').filter((w) => w.type === 'contradiction')).toHaveLength(0);
  });

  it('flags actions resolving far outside their cluster', () => {
    const rules = [
      { id: 'stray', label: 'stray noon action', action: { type: 'setLevel', zone: 2, level: 100 },
        trigger: { kind: 'fixed', time: '12:00', nextDay: true } }, // Sunday noon after a 1-day Shabbos
    ];
    const warnings = detect(rules, '2025-06-21');
    expect(warnings.find((w) => w.type === 'out-of-cluster')).toBeDefined();
  });

  // Paired weekend (2025 = erev Pesach on Shabbos: shabbos 4/12 → pesach-1
  // 4/13 → pesach-2 4/14). A rule landing a few hours into the adjacent day of
  // the same weekend is fine (those days flow into each other) — only genuine
  // zone contradictions are flagged, no matter which day they land on.
  function detectMulti(schedules, fromISO, toISO) {
    const calendar = new CalendarService({ location: monsey, times });
    const clusters = calendar.clusters(fromISO, toISO);
    const compiler = new TimelineCompiler({ calendar, sceneRepo: new SceneRepository([]), schedules });
    const start = DateTime.fromISO(`${fromISO}T00:00`, { zone: TZ }).minus({ days: 2 }).toMillis();
    const { allActions } = compiler.compile(clusters, start, start + 8 * 86400_000);
    return new ConflictDetector({ tzid: TZ }).detect(allActions, clusters);
  }

  it('does NOT flag a "day itself" rule that slips into the night before (day-overlap is fine)', () => {
    // "1h30m before candle lighting" filed under Shabbos/the-day lands Friday
    // evening — that overlap is expected, not a conflict.
    const w = detectMulti({ shabbos: { 'erev-pesach': { rules: [
      { id: 'test', label: 'TEST RULE', action: { type: 'setLevel', zone: 2, level: 100 },
        trigger: { kind: 'zman', zman: 'candleLighting', offsetMin: -90, day: 'day' } },
    ] } } }, '2025-04-12', '2025-04-14');
    expect(w).toHaveLength(0);
  });

  it('does NOT flag a Pesach I rule that lands during Shabbos, absent an actual conflict', () => {
    const w = detectMulti({ 'pesach-1': { default: { rules: [
      { id: 'p1-erev', label: 'dining on for erev', action: { type: 'setLevel', zone: 3, level: 100 },
        trigger: { kind: 'fixed', time: '15:00', day: 'erev' } },
    ] } } }, '2025-04-12', '2025-04-14');
    expect(w).toHaveLength(0);
  });

  it('STILL flags a real zone contradiction even across the Shabbos↔Yom Tov seam', () => {
    // A Shabbos rule turns zone 5 off and a Pesach I rule turns it on within a
    // few minutes at the seam — a genuine setting conflict, flagged regardless
    // of which day each rule "belongs" to.
    const w = detectMulti({
      shabbos: { 'erev-pesach': { rules: [
        { id: 's-off', label: 'hallway off', action: { type: 'setLevel', zone: 5, level: 0 },
          trigger: { kind: 'fixed', time: '20:10' } },
      ] } },
      'pesach-1': { 'erev-is-shabbos': { rules: [
        { id: 'p1-on', label: 'hallway on for seder', action: { type: 'setLevel', zone: 5, level: 100 },
          trigger: { kind: 'zman', zman: 'candleLighting', offsetMin: 2, day: 'erev' } },
      ] } },
    }, '2025-04-12', '2025-04-14');
    const c = w.find((x) => x.type === 'contradiction' && x.zone === 5);
    expect(c).toBeDefined();
    expect(c.message).toMatch(/hallway off/);
    expect(c.message).toMatch(/hallway on for seder/);
  });

  it('does not flag identical-level repeats or scene-internal stagger', () => {
    const rules = [
      { id: 'a', label: 'on 1', action: { type: 'setLevel', zone: 2, level: 100 },
        trigger: { kind: 'fixed', time: '12:00' } },
      { id: 'b', label: 'on again', action: { type: 'setLevel', zone: 2, level: 100 },
        trigger: { kind: 'fixed', time: '12:05' } },
      { id: 'scene', label: 'meal', action: { type: 'sceneStart', sceneId: 'meal' },
        trigger: { kind: 'fixed', time: '13:00' } },
    ];
    expect(detect(rules, '2025-06-21').filter((w) => w.type === 'contradiction')).toHaveLength(0);
  });
});
