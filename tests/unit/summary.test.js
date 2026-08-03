import { describe, it, expect } from 'vitest';
import { CalendarService } from '../../server/calendar/CalendarService.js';
import { buildClusterSummary } from '../../server/notify/summary.js';

const cfg = {
  location: { lat: 41.1126, lng: -74.0736, tzid: 'America/New_York', il: false, elevation: 0 },
  times: { candleLightingMins: 18, havdalahMins: 45, tzeitAngle: 8.5 },
  zones: [{ id: 3, friendlyName: 'Dining' }],
  scenes: [],
};

function summaryFor(schedules, extra = {}) {
  const cal = new CalendarService({ location: cfg.location, times: cfg.times });
  const clusters = cal.clusters('2025-04-12', '2025-04-14'); // erev-Pesach-on-Shabbos weekend
  return buildClusterSummary({ ...cfg, schedules, ...extra }, clusters);
}

describe('pre-Yom-Tov email summary', () => {
  it('lists genuine rule conflicts and a review-the-timeline nudge', () => {
    // two rules fight over the same zone within minutes — a real setting
    // conflict (mere day-overlap is intentionally NOT flagged)
    const s = summaryFor({ 'pesach-1': { default: { rules: [
      { id: 'dining-off', label: 'dining off', enabled: true,
        action: { type: 'setLevel', zone: 3, level: 0 }, trigger: { kind: 'fixed', time: '15:00' } },
      { id: 'dining-on', label: 'dining back on', enabled: true,
        action: { type: 'setLevel', zone: 3, level: 100 }, trigger: { kind: 'fixed', time: '15:05' } },
    ] } } });
    expect(s.textSummary).toMatch(/possible rule conflict/i);
    expect(s.textSummary).toMatch(/dining off/i);
    expect(s.textSummary).toMatch(/dining back on/i);
    expect(s.htmlSummary).toMatch(/possible rule conflict/i);
    expect(s.textSummary).toMatch(/review the full timeline/i);
  });

  it('says "no conflicts detected" when the schedule is clean', () => {
    const s = summaryFor({ 'pesach-1': { 'erev-is-shabbos': { rules: [
      { id: 'p1-seder', label: 'seder on', enabled: true,
        action: { type: 'setLevel', zone: 3, level: 100 }, trigger: { kind: 'zman', zman: 'candleLighting', offsetMin: 30 } },
    ] } } });
    expect(s.textSummary).toMatch(/no conflicts detected/i);
    expect(s.htmlSummary).toMatch(/No conflicts detected/i);
  });

  it('surfaces guest mode in the email when it is on', () => {
    const schedules = { 'pesach-1': { 'erev-is-shabbos': { rules: [
      { id: 'p1-seder', label: 'seder on', enabled: true,
        action: { type: 'setLevel', zone: 3, level: 100 }, trigger: { kind: 'zman', zman: 'candleLighting', offsetMin: 30 } },
    ] } } };
    const off = summaryFor(schedules);
    expect(off.textSummary).not.toMatch(/guest mode is on/i);
    const on = summaryFor(schedules, { guestMode: { enabled: true, until: '2025-04-20T00:00:00.000Z' } });
    expect(on.textSummary).toMatch(/guest mode is on/i);
    expect(on.htmlSummary).toMatch(/Guest mode is ON/i);
  });
});
