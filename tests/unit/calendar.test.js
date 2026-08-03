import { describe, it, expect } from 'vitest';
import { CalendarService } from '../../server/calendar/CalendarService.js';
import { ZipDatabase } from '../../server/calendar/ZipDatabase.js';
import { variantForDay, VARIANTS_BY_DAY_TYPE } from '../../server/calendar/dayTypes.js';

// Monsey, NY (zip 10952) — all golden times below verified against hebcal.com
const monsey = { lat: 41.1126, lng: -74.0176, tzid: 'America/New_York', il: false, elevation: 0, city: 'Monsey' };
const times = { candleLightingMins: 18, havdalahMins: 45, tzeitAngle: 8.5 };

const svc = () => new CalendarService({ location: monsey, times });

function closeTo(date, iso, toleranceSec = 90) {
  expect(Math.abs(date.getTime() - new Date(iso).getTime()) / 1000).toBeLessThanOrEqual(toleranceSec);
}

describe('ZipDatabase', () => {
  it('resolves zip to location and timezone offline', () => {
    const db = new ZipDatabase();
    const monseyHit = db.lookup('10952');
    expect(monseyHit.city.toLowerCase()).toContain('monsey');
    expect(monseyHit.state).toBe('NY');
    expect(monseyHit.tzid).toBe('America/New_York');
    expect(db.lookup('90210').tzid).toBe('America/Los_Angeles');
    expect(db.lookup('00000')).toBeNull();
  });
});

describe('CalendarService.dayInfo', () => {
  it('flags yom tov, shabbos, and non-assur days', () => {
    const s = svc();
    expect(s.dayInfo('2025-04-13')).toMatchObject({ assur: true, dayType: 'pesach-1' });
    expect(s.dayInfo('2025-04-15')).toMatchObject({ assur: false }); // chol hamoed
    expect(s.dayInfo('2025-05-03')).toMatchObject({ assur: true, dayType: 'shabbos' });
    expect(s.dayInfo('2025-10-02')).toMatchObject({ assur: true, dayType: 'yom-kippur' });
    expect(s.dayInfo('2025-04-12')).toMatchObject({ assur: true, dayType: 'shabbos', isErevPesach: true });
    expect(s.dayInfo('2025-04-16')).toMatchObject({ assur: false });
  });
});

describe('Pesach 2025 — the canonical Erev-Pesach-on-Shabbos collision', () => {
  it('builds the 3-day cluster with correct variants and boundaries', () => {
    const [cluster] = svc().clusters('2025-04-12', '2025-04-13');
    expect(cluster.days.map((d) => [d.date, d.dayType, d.variant])).toEqual([
      ['2025-04-12', 'shabbos', 'erev-pesach'],
      ['2025-04-13', 'pesach-1', 'erev-is-shabbos'],
      ['2025-04-14', 'pesach-2', 'default'],
    ]);
    expect(cluster.erevDate).toBe('2025-04-11');
    // hebcal.com: candles 7:14pm Fri Apr 11; havdalah (45) 8:20pm Mon Apr 14
    // endsAt carries a +1 minute clock-drift safety margin
    closeTo(cluster.startsAt, '2025-04-11T19:14:00-04:00');
    closeTo(cluster.endsAt, '2025-04-14T20:21:00-04:00');
    expect(cluster.erevLabel).toMatch(/Erev Pesach|Shabbos/); // erev of this cluster is Fri Apr 11
    expect(cluster.transitions).toHaveLength(2); // 2 intermediate candle lightings
  });

  it('Pesach VII 2025 falls on Shabbos (on-shabbos variant)', () => {
    const [cluster] = svc().clusters('2025-04-19', '2025-04-20');
    expect(cluster.days.map((d) => [d.date, d.dayType, d.variant])).toEqual([
      ['2025-04-19', 'pesach-7', 'on-shabbos'],
      ['2025-04-20', 'pesach-8', 'default'],
    ]);
  });
});

describe('other collision shapes', () => {
  it('RH 2024 (Thu-Fri) runs into Shabbos: 3-day cluster', () => {
    const [cluster] = svc().clusters('2024-10-03', '2024-10-05');
    expect(cluster.days.map((d) => [d.date, d.dayType, d.variant])).toEqual([
      ['2024-10-03', 'rosh-hashanah-1', 'default'],
      ['2024-10-04', 'rosh-hashanah-2', 'leads-into-shabbos'],
      ['2024-10-05', 'shabbos', 'follows-yt'],
    ]);
  });

  it('Pesach 2022: day 1 on Shabbos itself', () => {
    const [cluster] = svc().clusters('2022-04-16', '2022-04-17');
    expect(cluster.days.map((d) => [d.date, d.dayType, d.variant])).toEqual([
      ['2022-04-16', 'pesach-1', 'on-shabbos'],
      ['2022-04-17', 'pesach-2', 'default'],
    ]);
  });

  it('Shavuos 2022 starts motzei Shabbos: Shabbos leads-into-yt, YT erev-is-shabbos', () => {
    const [cluster] = svc().clusters('2022-06-04', '2022-06-06');
    expect(cluster.days.map((d) => [d.date, d.dayType, d.variant])).toEqual([
      ['2022-06-04', 'shabbos', 'leads-into-yt'],
      ['2022-06-05', 'shavuos-1', 'erev-is-shabbos'],
      ['2022-06-06', 'shavuos-2', 'default'],
    ]);
  });

  it('a plain Shabbos is a 1-day cluster with default variant', () => {
    const [cluster] = svc().clusters('2025-05-03', '2025-05-03');
    expect(cluster.days).toHaveLength(1);
    expect(cluster.days[0]).toMatchObject({ dayType: 'shabbos', variant: 'default' });
    expect(cluster.erevDate).toBe('2025-05-02');
  });

  it('clusters straddling the query range come back complete', () => {
    // query only the middle day of the Pesach 2025 cluster
    const [cluster] = svc().clusters('2025-04-13', '2025-04-13');
    expect(cluster.days).toHaveLength(3);
  });
});

describe('Israel mode', () => {
  it('drops second days: Pesach 2025 IL cluster is Shabbos + day 1 only', () => {
    const il = new CalendarService({ location: { ...monsey, il: true }, times });
    const [cluster] = il.clusters('2025-04-12', '2025-04-14');
    expect(cluster.days.map((d) => d.dayType)).toEqual(['shabbos', 'pesach-1']);
  });
});

describe('holiday-name locale', () => {
  it('defaults to Ashkenazi transliteration, supports Sephardic and Hebrew', () => {
    // Sukkos I 5786 = Oct 7 2025
    expect(svc().dayInfo('2025-10-07').holidayLabel).toBe('Sukkos I');
    const sephardi = new CalendarService({ location: monsey, times, locale: 'en' });
    expect(sephardi.dayInfo('2025-10-07').holidayLabel).toBe('Sukkot I');
    expect(sephardi.dayInfo('2025-05-03').holidayLabel).toBe('Shabbat');
    const hebrew = new CalendarService({ location: monsey, times, locale: 'he-x-NoNikud' });
    expect(hebrew.dayInfo('2025-10-07').holidayLabel).toContain('סוכות');
    // dayType mapping is locale-independent
    expect(hebrew.dayInfo('2025-10-07').dayType).toBe('sukkos-1');
  });

  it('labels Rosh Hashanah day 1 with an ordinal, not the year', () => {
    // hebcal renders day 1 as "Rosh Hashana 5786"; normalize to "Rosh Hashanah I"
    // so it reads consistently with day 2 ("Rosh Hashanah II") and the schedules page
    // (the app also standardizes hebcal's "Rosh Hashana" spelling to "Rosh Hashanah")
    expect(svc().dayInfo('2025-09-23').holidayLabel).toBe('Rosh Hashanah I');
    expect(svc().dayInfo('2025-09-24').holidayLabel).toBe('Rosh Hashanah II');
    const hebrew = new CalendarService({ location: monsey, times, locale: 'he-x-NoNikud' });
    expect(hebrew.dayInfo('2025-09-23').holidayLabel).toBe('ראש השנה א׳');
    expect(hebrew.dayInfo('2025-09-24').holidayLabel).toBe('ראש השנה ב׳');
  });
});

describe('user-configurable times', () => {
  it('honors candleLightingMins and havdalahMins', () => {
    const custom = new CalendarService({
      location: monsey,
      times: { candleLightingMins: 40, havdalahMins: 72, tzeitAngle: 8.5 },
    });
    const [c40] = custom.clusters('2025-05-03', '2025-05-03');
    const [c18] = svc().clusters('2025-05-03', '2025-05-03');
    expect(Math.round((c18.startsAt - c40.startsAt) / 60000)).toBe(22); // 40 - 18
    expect(Math.round((c40.endsAt - c18.endsAt) / 60000)).toBe(27);     // 72 - 45
  });
});

describe('zmanim', () => {
  it('returns all supported zmanim as Dates, chatzotNight = night leading into the date', () => {
    const z = svc().zmanim('2025-04-13');
    for (const key of ['sunrise', 'sunset', 'chatzot', 'chatzotNight', 'alotHaShachar',
      'plagHaMincha', 'minchaGedola', 'minchaKetana', 'sofZmanShma', 'sofZmanTfilla', 'tzeit']) {
      expect(z[key]).toBeInstanceOf(Date);
    }
    // seder-night chatzos: ~1am ET on Apr 13 (the night of the first seder)
    const local = z.chatzotNight.toLocaleString('en-US', { timeZone: monsey.tzid, hour12: false });
    expect(local).toContain('4/13/2025');
  });
});

describe('variantForDay fallbacks', () => {
  it('falls back to default when a theoretical variant is not applicable', () => {
    // pesach-2 preceded by Shabbos (Pesach 2022 shape): erev-is-shabbos not in
    // its vocabulary because the seder-night difference lives on pesach-1
    expect(variantForDay({ dayType: 'pesach-2', weekday: 7, prevIsShabbos: true }))
      .toBe('default');
    expect(VARIANTS_BY_DAY_TYPE['pesach-1']).toContain('erev-is-shabbos');
  });
});
