import { describe, it, expect } from 'vitest';
import { HDate } from '@hebcal/core';
import { omerDays, omerSheet, heb } from '../../server/pdf/omerSheet.js';
import { CalendarService } from '../../server/calendar/CalendarService.js';

const LOCATION = { zip: '21208', lat: 39.3719, lng: -76.6981, city: 'Pikesville', state: 'MD', tzid: 'America/New_York', il: false, elevation: 0 };
const cal = () => new CalendarService({ location: LOCATION, times: { candleLightingMins: 18, havdalahMins: 45 }, locale: 'ashkenazi' });

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

describe('Sefiras HaOmer data', () => {
  it('produces 49 consecutive nights starting 16 Nisan with real Hebrew text', () => {
    const days = omerDays(5787);
    expect(days).toHaveLength(49);
    expect(days[0].heDate).toContain('ניסן');
    expect(days[0].text).toContain('היום');
    expect(days[0].text).toContain('לעומר');
    expect(days[48].text).toContain('שבעה שבועות'); // day 49 = seven full weeks
    // nights are consecutive calendar days
    for (let i = 1; i < 49; i++) {
      expect(days[i].night.getTime() - days[i - 1].night.getTime()).toBe(86400000);
    }
    // day 1 is counted the night BEFORE 16 Nisan's civil day (i.e. seder night II's evening)
    const nisan16 = new HDate(16, 'Nisan', 5787).greg();
    expect(days[0].night.getTime()).toBe(nisan16.getTime() - 86400000);
    // no nikud anywhere (combining marks would break the PDF shaping)
    for (const d of days) expect(/[֑-ׇ]/.test(d.text)).toBe(false);
  });

  it('heb() joins words with NBSP so PDFKit keeps them one RTL run', () => {
    expect(heb('היום יום אחד לעומר')).toBe('היום יום אחד לעומר');
  });

  it('renders a real PDF with the embedded Hebrew font', async () => {
    const doc = omerSheet(cal(), '2027-03-01');
    const buf = await new Promise((resolve) => {
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
    });
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(buf.length).toBeGreaterThan(15_000); // font subset embedded
  });
});

describe('calendar display extras (observances + omer)', () => {
  it('marks Rosh Chodesh, fasts and Chanukah but never modern holidays', () => {
    const c = cal();
    // Asara B'Tevet 5787
    const fast = iso(new HDate(10, 'Tevet', 5787).greg());
    const rows = c.hebrewDates(fast, fast);
    expect(rows[0].observances.join(' ')).toMatch(/Tevet|Teves/i);

    // Rosh Chodesh Elul 5786
    const rc = iso(new HDate(1, 'Elul', 5786).greg());
    expect(c.hebrewDates(rc, rc)[0].observances.join(' ')).toMatch(/Rosh Chodesh/);

    // Chanukah 5787 (25 Kislev)
    const ch = iso(new HDate(25, 'Kislev', 5787).greg());
    expect(c.hebrewDates(ch, ch)[0].observances.join(' ')).toMatch(/Chanukah/);

    // Yom HaAtzmaut 5787 (5 Iyyar) — modern, must NOT appear
    const yh = iso(new HDate(5, 'Iyyar', 5787).greg());
    expect(c.hebrewDates(yh, yh)[0].observances.join(' ')).not.toMatch(/Atzma/i);
  });

  it('reports the omer said tonight during sefira and null otherwise', () => {
    const c = cal();
    // the civil day of 16 Nisan: that EVENING is night 2
    const d1 = iso(new HDate(16, 'Nisan', 5787).greg());
    expect(c.hebrewDates(d1, d1)[0].omerTonight).toBe(2);
    // the night before 16 Nisan (day of 15 Nisan) is night 1
    const d0 = iso(new HDate(15, 'Nisan', 5787).greg());
    expect(c.hebrewDates(d0, d0)[0].omerTonight).toBe(1);
    // mid-winter: nothing
    const w = iso(new HDate(10, 'Tevet', 5787).greg());
    expect(c.hebrewDates(w, w)[0].omerTonight).toBeNull();
  });
});
