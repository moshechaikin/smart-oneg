import PDFDocument from 'pdfkit';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { HDate, OmerEvent, gematriya } from '@hebcal/core';

const FONTS = path.dirname(fileURLToPath(import.meta.url));
const HEB = path.join(FONTS, 'fonts', 'DavidLibre-Regular.ttf');
const HEB_BOLD = path.join(FONTS, 'fonts', 'DavidLibre-Bold.ttf');

/**
 * Hebrew for PDFKit: fontkit (PDFKit's shaper) reverses RTL runs itself, so
 * Hebrew goes in LOGICAL order — but regular spaces break the text into runs
 * and one inter-word space gets swallowed. Joining words with NBSP keeps the
 * line a single RTL run and renders exactly right (verified visually).
 * Nikud-free, pure-Hebrew lines only (no ASCII digits mixed in).
 */
export function heb(s) {
  return s
    // the maqaf (U+05BE) connects double parshios ("\u05E0\u05E6\u05D1\u05D9\u05DD\u05BE\u05D5\u05D9\u05DC\u05DA"); it sits inside
    // the nikud range below, so turn it into a space FIRST or the strip would
    // delete it and fuse the two words. NBSP (next step) keeps them one RTL run.
    .replaceAll('\u05BE', ' ')
    .replace(/[\u0591-\u05C7]/g, '')
    .replaceAll(' ', '\u00A0');
}

// אלקינו with a kuf, per the user — this is a reference chart, not a siddur
const BERACHA = 'ברוך אתה ה׳ אלקינו מלך העולם אשר קדשנו במצותיו וצונו על ספירת העומר';
const HARACHAMAN = 'הרחמן הוא יחזיר עבודת בית המקדש למקומה, במהרה בימינו. אמן סלה.';

const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Shabbos'];
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The 49 Omer days for the year containing `fromISO`'s upcoming Pesach. */
export function omerDays(hebYear) {
  const days = [];
  const start = new HDate(16, 'Nisan', hebYear); // day 1 of the count
  for (let n = 1; n <= 49; n++) {
    const hd = start.add(n - 1);
    const ev = new OmerEvent(hd, n);
    const greg = hd.greg();
    const night = new Date(greg.getTime() - 86400000); // counted the evening before
    days.push({
      n,
      night,
      heDate: hd.renderGematriya(true).split(' ').slice(0, 2).join(' '), // day + month, no year
      text: ev.getTodayIs('he-x-NoNikud'),
    });
  }
  return days;
}

/**
 * One-page Sefiras HaOmer chart: the beracha big up top (David Libre — the
 * classic Times-like Hebrew serif), then all 49 nights in two columns with
 * the civil night, Hebrew date, the count number, and the full Hebrew text.
 */
export function omerSheet(cal, fromISO = new Date().toISOString().slice(0, 10)) {
  // upcoming (or current) Omer: the Pesach whose 16 Nisan is >= fromISO - 49d
  const from = new Date(`${fromISO}T12:00:00Z`);
  let hebYear = new HDate(from).getFullYear();
  if (new HDate(16, 'Nisan', hebYear).greg() < new Date(from.getTime() - 50 * 86400000)) hebYear += 1;
  const days = omerDays(hebYear);

  const doc = new PDFDocument({ size: 'LETTER', margin: 32, bufferPages: true });
  doc.on('pageAdded', () => { doc.page.margins.bottom = 0; });
  doc.page.margins.bottom = 0;
  const M = 32; const PW = 612 - M * 2;

  // title with the location/year line to its RIGHT (saves a line of height)
  const hebrew = cal.locale === 'he' || cal.locale === 'he-x-NoNikud';
  const title = hebrew ? heb(`ספירת העומר ${gematriya(hebYear)}`) : `Sefiras HaOmer ${hebYear}`;
  doc.fillColor('#111827').font(hebrew ? HEB_BOLD : 'Helvetica-Bold').fontSize(21).text(title, M, M + 2, { lineBreak: false });
  const tw = doc.widthOfString(title);
  doc.font('Helvetica').fontSize(10.5).fillColor('#6b7280')
    .text(`${cal.location.city || 'Your location'}  ·  ${days[0].night.getFullYear()}  ·  count after nightfall`,
      M + tw + 14, M + 11, { lineBreak: false });
  doc.save().moveTo(M, M + 30).lineTo(M + PW, M + 30).lineWidth(1.4).strokeColor('#0e7490').stroke().restore();

  // the beracha, big and centered
  doc.font(HEB_BOLD).fontSize(15.5).fillColor('#111827')
    .text(heb(BERACHA), M, M + 42, { width: PW, align: 'center' });
  const topY = doc.y + 10;

  // two columns of 25 / 24 nights
  const gap = 16; const colW = (PW - gap) / 2;
  const cols = [M, M + colW + gap];
  const bottomY = 792 - 52; // leave room for the harachaman line
  const rowH = (bottomY - topY) / 25;

  for (let i = 0; i < days.length; i++) {
    const d = days[i];
    const ci = i < 25 ? 0 : 1;
    const y = topY + (i % 25) * rowH;
    const x = cols[ci];
    if (i % 25 !== 0) doc.save().moveTo(x, y).lineTo(x + colW, y).lineWidth(0.4).strokeColor('#e5e7eb').stroke().restore();

    // count number, big
    doc.font('Helvetica-Bold').fontSize(13).fillColor('#0e7490')
      .text(String(d.n), x, y + rowH / 2 - 8, { width: 22, align: 'center', lineBreak: false });
    // civil night + hebrew date (the hebrew date is the day being counted INTO)
    doc.font('Helvetica').fontSize(7.6).fillColor('#6b7280')
      .text(`Night of ${WEEKDAYS_SHORT[d.night.getDay()]}, ${MONTHS_SHORT[d.night.getMonth()]} ${d.night.getDate()}`, x + 26, y + 2.5, { lineBreak: false });
    doc.font(HEB).fontSize(7.6)
      .text(heb(d.heDate), x + 26, y + 2.5, { width: colW - 26, align: 'right', lineBreak: false });
    // the count itself, right-aligned Hebrew — shrink to fit the column so a
    // long night ("...שהם שלושה שבועות ושני ימים לעומר") never wraps
    const line = heb(d.text);
    doc.font(HEB).fontSize(9.6);
    const w = doc.widthOfString(line);
    if (w > colW - 28) doc.fontSize(9.6 * (colW - 28) / w);
    doc.fillColor('#111827').text(line, x + 26, y + rowH / 2 - 1, { width: colW - 26, align: 'right', lineBreak: false });
  }

  // the traditional closing line, centered along the bottom
  doc.font(HEB_BOLD).fontSize(12.5).fillColor('#111827')
    .text(heb(HARACHAMAN), M, 792 - 44, { width: PW, align: 'center', lineBreak: false });
  doc.font('Helvetica-Oblique').fontSize(6.8).fillColor('#9ca3af').text(
    `Dates computed with @hebcal/core for ${cal.location.city || 'your location'}. Count after tzeis; if you missed a full night, continue without the beracha.`,
    36, 792 - 27, { width: 612 - 72, align: 'center', lineBreak: false },
  );
  smartonegNod(doc);
  doc.end();
  return doc;
}

// Small nod to smartoneg along the bottom of every printable sheet.
export function smartonegNod(doc) {
  doc.font('Helvetica').fontSize(6.8).fillColor('#9ca3af').text(
    'Made with SmartOneg  ·  github.com/moshechaikin/smartoneg  ·  smartoneg.com',
    36, 792 - 18, { width: 612 - 72, align: 'center', lineBreak: false },
  );
}
