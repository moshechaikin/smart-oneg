import { describe, it, expect } from 'vitest';
import { DateTime } from 'luxon';
import { CalendarService } from '../../server/calendar/CalendarService.js';
import { SceneRepository } from '../../server/engine/SceneRepository.js';
import { TimelineCompiler } from '../../server/engine/TimelineCompiler.js';

const monsey = { lat: 41.1126, lng: -74.0176, tzid: 'America/New_York', il: false, elevation: 0, city: 'Monsey' };
const times = { candleLightingMins: 18, havdalahMins: 45, tzeitAngle: 8.5 };
const TZ = monsey.tzid;

function compileShabbos(rules, dateISO) {
  const calendar = new CalendarService({ location: monsey, times });
  const clusters = calendar.clusters(dateISO, dateISO);
  const compiler = new TimelineCompiler({
    calendar, sceneRepo: new SceneRepository([]), schedules: { shabbos: { default: { rules } } },
  });
  const start = DateTime.fromISO(`${dateISO}T00:00`, { zone: TZ }).minus({ days: 2 }).toMillis();
  return compiler.compile(clusters, start, start + 5 * 86400_000).actions;
}

const local = (ms) => DateTime.fromMillis(ms, { zone: TZ }).toFormat('yyyy-MM-dd HH:mm');

describe('early-Shabbos pinning via conditions', () => {
  // "Lights on 90 min before Friday sunset — but in the summer, when sunset is
  // past 7pm and we make early Shabbos at 7, always come on at 5:30pm."
  const earlyShabbosRule = {
    id: 'r-early', label: 'erev shabbos lights',
    action: { type: 'setLevel', zone: 6, level: 100 },
    trigger: {
      kind: 'zman', zman: 'sunset', offsetMin: -90, day: 'erev',
      conditions: [
        { if: { zman: 'sunset', cmp: 'after', time: '19:00', day: 'erev' },
          then: { kind: 'fixed', time: '17:30', day: 'erev' } },
      ],
    },
  };

  it('winter Friday: plain sunset offset applies', () => {
    // Fri Dec 19 2025 Monsey sunset 4:29:47pm → fires 2:59pm
    const [a] = compileShabbos([earlyShabbosRule], '2025-12-20');
    expect(local(a.at)).toBe('2025-12-19 14:59');
  });

  it('summer Friday: sunset after 7pm pins the trigger to 5:30pm', () => {
    // Fri Jun 20 2025 Monsey sunset ≈ 8:31pm → pinned
    const [a] = compileShabbos([earlyShabbosRule], '2025-06-21');
    expect(local(a.at)).toBe('2025-06-20 17:30');
  });

  it('across a full year, every Friday resolves to exactly one of the two regimes', () => {
    const calendar = new CalendarService({ location: monsey, times });
    let pinned = 0; let solar = 0;
    for (let d = DateTime.fromISO('2025-01-04', { zone: TZ }); d.year === 2025; d = d.plus({ weeks: 1 })) {
      const dateISO = d.toISODate();
      if (calendar.dayInfo(dateISO).dayType !== 'shabbos') continue; // skip YT-on-Shabbos wrinkles
      const actions = compileShabbos([earlyShabbosRule], dateISO);
      if (actions.length === 0) continue;
      const fireLocal = DateTime.fromMillis(actions[0].at, { zone: TZ });
      const erevSunset = calendar.zmanim(fireLocal.toISODate()).sunset;
      if (DateTime.fromJSDate(erevSunset, { zone: TZ }).hour >= 19) {
        expect(fireLocal.toFormat('HH:mm')).toBe('17:30');
        pinned++;
      } else {
        const expected = new Date(erevSunset.getTime() - 90 * 60000);
        expect(Math.abs(fireLocal.toMillis() - expected.getTime())).toBeLessThan(1000);
        solar++;
      }
    }
    expect(pinned).toBeGreaterThan(5);  // summer weeks exist
    expect(solar).toBeGreaterThan(5);   // winter weeks exist
  });
});

describe('clamps', () => {
  it('notBefore bounds the winter kitchen-relight collision', () => {
    // kitchen back on 1h before sunset, but never before mealtime end at 16:05
    const rule = {
      id: 'r-kitchen', label: 'kitchen before sunset',
      action: { type: 'setLevel', zone: 9, level: 100 },
      trigger: { kind: 'zman', zman: 'sunset', offsetMin: -60, clamp: { notBefore: '16:05' } },
    };
    // Sat Dec 20 2025 sunset ≈ 4:31pm → raw 3:31pm → clamped to 4:05pm
    const [winter] = compileShabbos([rule], '2025-12-20');
    expect(local(winter.at)).toBe('2025-12-20 16:05');
    // Sat Jun 21 2025 sunset 8:32:12pm → raw 7:32pm, clamp inactive
    const [summer] = compileShabbos([rule], '2025-06-21');
    expect(local(summer.at)).toBe('2025-06-21 19:32');
  });

  it('notAfter caps a trigger', () => {
    const rule = {
      id: 'r-cap', action: { type: 'setLevel', zone: 2, level: 100 },
      trigger: { kind: 'zman', zman: 'sunset', offsetMin: 60, clamp: { notAfter: '20:00' } },
    };
    const [summer] = compileShabbos([rule], '2025-06-21'); // sunset+60 ≈ 9:31pm → capped 8pm
    expect(local(summer.at)).toBe('2025-06-21 20:00');
  });
});
