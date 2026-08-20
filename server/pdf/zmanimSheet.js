// Printable Zmanim PDFs (8.5×11), all times computed from @hebcal/core for the
// configured location — nothing hard-coded. Two products:
//   • yomTovSheet(cfg, festival)  — one page: Pesach / Sukkos / Shavuos
//   • shabbosYearSheet(cfg, year) — multi-page: every Shabbos of a civil year
import PDFDocument from 'pdfkit';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { HebrewCalendar, HDate, Zmanim, GeoLocation, months, flags, gematriya } from '@hebcal/core';
import { DateTime } from 'luxon';
import { heb, smartonegNod } from './omerSheet.js';

// David Libre (SIL OFL) — the classic Times-like Hebrew serif
const FONT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fonts');
const HEB_FONT = path.join(FONT_DIR, 'DavidLibre-Regular.ttf');
const HEB_FONT_BOLD = path.join(FONT_DIR, 'DavidLibre-Bold.ttf');

// ── palette (per festival) ──────────────────────────────────────────────────
const THEMES = {
  pesach: { bar: '#1f2937', accent: '#b45309', tint: '#fdf6ec', name: 'Pesach' },
  sukkos: { bar: '#14532d', accent: '#15803d', tint: '#f0fdf4', name: 'Sukkos' },
  shavuos: { bar: '#4c1d95', accent: '#6d28d9', tint: '#f5f3ff', name: 'Shavuos' },
  'rosh-hashanah': { bar: '#7c2d12', accent: '#a16207', tint: '#fffbeb', name: 'Rosh Hashanah' },
  'yom-kippur': { bar: '#334155', accent: '#475569', tint: '#f8fafc', name: 'Yom Kippur' },
  shabbos: { bar: '#134e4a', accent: '#0f766e', tint: '#f0fdfa', name: 'Shabbos' },
};

// Zman names follow the app's display style. Hebrew locales can't be rendered
// as script in the PDF (no RTL/embedded font), so they use the Ashkenazi
// transliteration; 'en' uses the Sephardi/modern transliteration.
const NAMES = {
  ashkenazi: {
    alos: 'Alos Hashachar', neitz: 'Neitz (Hanetz)', shma: 'Sof Zman Shma (MG"A / GR"A)',
    tfila: 'Sof Zman Tefila', chatzos: 'Chatzos', minchaG: 'Mincha Gedola', plag: 'Plag HaMincha',
    candles: 'Hadlakas Neiros', shkia: 'Shkiah (sunset)', tzeis: 'Tzais (nightfall / R"T)',
    havdalah: 'Havdalah / Yom Tov ends', eatChametz: 'Sof Zman Achilas Chametz (MG"A / GR"A)',
    burnChametz: 'Sof Zman Biur Chametz (MG"A / GR"A)', omer: 'Sefiras HaOmer', omerTonight: 'Count tonight: Omer Day',
    eruv: 'Eruv Tavshilin today', tal: 'Tefilas Tal', yizkor: 'Yizkor', erev: 'Erev',
    fastBegins: 'Fast begins (shkia)', fastBeginsShort: 'Fast begins', fastBeginsDawn: 'Fast begins (alos)', fastEndsTzais: 'Fast ends (tzais)', fastEnds: 'Fast ends / Havdalah', tashlich: 'Tashlich',
    firstborn: 'Ta’anis Bechoros',
    bedikas: 'Bedikas Chametz tonight (after tzais)',
    burnFri: 'Biur Chametz (burn by; no Kol Chamira)', kolChamira: 'Kol Chamira / dispose of chametz by',
    chatzosNight: 'Chatzos HaLaylah (finish Afikomen by)',
    pesach: 'Pesach', sukkos: 'Sukkos', shavuos: 'Shavuos', 'rosh-hashanah': 'Rosh Hashanah', 'yom-kippur': 'Yom Kippur', shabbos: 'Shabbos', cholHamoed: 'Chol Hamoed',
    candlesShort: 'CANDLES', shkiaShort: 'SHKIA', havdalahShort: 'HAVDALAH', parsha: 'PARSHA',
  },
  sephardi: {
    alos: 'Alot Hashachar', neitz: 'Netz (Hanetz)', shma: 'Sof Zman Shema (MG"A / GR"A)',
    tfila: 'Sof Zman Tefila', chatzos: 'Chatzot', minchaG: 'Mincha Gedola', plag: 'Plag HaMinha',
    candles: 'Hadlakat Nerot', shkia: 'Shkia (sunset)', tzeis: 'Tzeit (nightfall / R"T)',
    havdalah: 'Havdala / Yom Tov ends', eatChametz: 'Sof Zman Achilat Chametz (MG"A / GR"A)',
    burnChametz: 'Sof Zman Biur Chametz (MG"A / GR"A)', omer: 'Sefirat HaOmer', omerTonight: 'Count tonight: Omer Day',
    eruv: 'Eruv Tavshilin today', tal: 'Tefilat Tal', yizkor: 'Yizkor', erev: 'Erev',
    fastBegins: 'Fast begins (shkia)', fastBeginsShort: 'Fast begins', fastBeginsDawn: 'Fast begins (alot)', fastEndsTzais: 'Fast ends (tzeit)', fastEnds: 'Fast ends / Havdala', tashlich: 'Tashlich',
    firstborn: 'Ta’anit Bechorot',
    bedikas: 'Bedikat Chametz tonight (after tzeit)',
    burnFri: 'Biur Chametz (burn by; no Kol Chamira)', kolChamira: 'Kol Chamira / dispose of chametz by',
    chatzosNight: 'Chatzot HaLaylah (finish Afikomen by)',
    pesach: 'Pesach', sukkos: 'Sukkot', shavuos: 'Shavuot', 'rosh-hashanah': 'Rosh Hashanah', 'yom-kippur': 'Yom Kippur', shabbos: 'Shabbat', cholHamoed: 'Chol Hamoed',
    candlesShort: 'CANDLES', shkiaShort: 'SHKIA', havdalahShort: 'HAVDALA', parsha: 'PARASHA',
  },
};
NAMES.hebrew = {
  hebrew: true,
  alos: 'עלות השחר', neitz: 'נץ החמה', shma: 'סוף זמן ק״ש מג״א · גר״א',
  tfila: 'סוף זמן תפילה', chatzos: 'חצות', minchaG: 'מנחה גדולה', plag: 'פלג המנחה',
  candles: 'הדלקת נרות', shkia: 'שקיעה', tzeis: 'צאת הכוכבים · ר״ת',
  havdalah: 'הבדלה · צאת החג', eatChametz: 'סוף זמן אכילת חמץ מג״א · גר״א',
  burnChametz: 'סוף זמן ביעור חמץ מג״א · גר״א', omer: 'ספירת העומר', omerTonight: 'ספירה הלילה: יום',
  eruv: 'עירוב תבשילין היום', tal: 'תפילת טל', yizkor: 'יזכור', erev: 'ערב',
  fastBegins: 'תחילת הצום בשקיעה', fastBeginsShort: 'תחילת הצום', fastBeginsDawn: 'תחילת הצום · עלות השחר', fastEndsTzais: 'סוף הצום · צאת הכוכבים', fastEnds: 'סוף הצום · הבדלה', tashlich: 'תשליך',
  firstborn: 'תענית בכורות',
  bedikas: 'בדיקת חמץ הלילה אחר צאת הכוכבים',
  burnFri: 'ביעור חמץ עד · בלי כל חמירא', kolChamira: 'כל חמירא וסילוק החמץ עד',
  chatzosNight: 'חצות הלילה · סיום אפיקומן',
  pesach: 'פסח', sukkos: 'סוכות', shavuos: 'שבועות', 'rosh-hashanah': 'ראש השנה', 'yom-kippur': 'יום כיפור', shabbos: 'שבת', cholHamoed: 'חול המועד',
  candlesShort: 'הדלקה', shkiaShort: 'שקיעה', havdalahShort: 'הבדלה', parsha: 'פרשה',
};
// PDFs NEVER use nikud: both Hebrew display locales map to the same
// nikud-free Hebrew label set (house decision).
const namesFor = (locale) => (locale === 'he' || locale === 'he-x-NoNikud'
  ? NAMES.hebrew
  : NAMES[locale === 'en' ? 'sephardi' : 'ashkenazi']);

// festival → the day-type slots that belong to it (diaspora)
const FESTIVAL_DAYTYPES = {
  pesach: ['pesach-1', 'pesach-2', 'pesach-7', 'pesach-8'],
  sukkos: ['sukkos-1', 'sukkos-2', 'shmini-atzeres', 'simchas-torah'],
  shavuos: ['shavuos-1', 'shavuos-2'],
  'rosh-hashanah': ['rosh-hashanah-1', 'rosh-hashanah-2'],
  'yom-kippur': ['yom-kippur'],
};
export const FESTIVALS = Object.keys(FESTIVAL_DAYTYPES);

const civilNoon = (iso) => { const [y, m, d] = iso.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d, 12)); };
const addDays = (iso, n) => { const dt = civilNoon(iso); dt.setUTCDate(dt.getUTCDate() + n); return dt.toISOString().slice(0, 10); };

/** Rich zmanim for one civil date, formatted in the location's timezone. */
function dayZmanim(gloc, iso, tzid, tzeitAngle) {
  const zm = new Zmanim(gloc, civilNoon(iso), false);
  const fmt = (dt) => (dt instanceof Date && !isNaN(dt)
    ? DateTime.fromJSDate(dt).setZone(tzid).toFormat('h:mm a') : '—');
  const sunrise = zm.sunrise();
  const sunset = zm.sunset();
  // Chametz times use Magen Avraham hours (the common stringent luach basis):
  // sof zman achilas = end of the 4th hour = sof zman tefila (MG"A); sof zman
  // biur = end of the 5th hour = one more MG"A hour. Derive the MG"A hour from
  // hebcal's own MG"A zmanim so it stays internally consistent.
  const mgaHour = zm.sofZmanTfillaMGA() - zm.sofZmanShmaMGA();
  const endEat = zm.sofZmanTfillaMGA();
  // GRA basis (sunrise→sunset hours) — the more lenient common luach time,
  // shown alongside the stringent MG"A time on the Erev Pesach sheet.
  const graHour = zm.sofZmanTfilla() - zm.sofZmanShma();
  const endEatGRA = zm.sofZmanTfilla();
  return {
    alos: fmt(zm.alotHaShachar()),
    misheyakir: fmt(zm.misheyakir()),
    neitz: fmt(sunrise),
    shmaMGA: fmt(zm.sofZmanShmaMGA()),
    shmaGRA: fmt(zm.sofZmanShma()),
    tfillaMGA: fmt(zm.sofZmanTfillaMGA()),
    tfillaGRA: fmt(zm.sofZmanTfilla()),
    chatzos: fmt(zm.chatzot()),
    chatzosNight: fmt(zm.chatzotNight()), // solar midnight — afikoman/seder deadline
    minchaGedola: fmt(zm.minchaGedola()),
    minchaKetana: fmt(zm.minchaKetana()),
    plag: fmt(zm.plagHaMincha()),
    shkia: fmt(sunset),
    tzeis: fmt(zm.tzeit(tzeitAngle)),
    tzeis72: fmt(new Date(sunset.getTime() + 72 * 60000)),
    endEatChametz: fmt(endEat),                                  // MG"A end of 4th hour
    endOwnChametz: fmt(new Date(endEat.getTime() + mgaHour)),    // MG"A end of 5th hour
    endEatChametzGRA: fmt(endEatGRA),                            // GR"A end of 4th hour
    endOwnChametzGRA: fmt(new Date(endEatGRA.getTime() + graHour)), // GR"A end of 5th hour
    _sunset: sunset,
  };
}

/** Assemble the ordered day list for a festival's current-or-next occurrence. */
function festivalDays(cal, festival, fromISO) {
  const wanted = new Set(FESTIVAL_DAYTYPES[festival].filter((dt) => !cal.location.il || !dt.endsWith('-2')));
  // Look back far enough to catch an occurrence already in progress, so a `from`
  // that lands mid-festival (e.g. viewing October while Sukkos began in
  // September) still renders the WHOLE yom tov, not just its tail. A single
  // occurrence spans at most ~9 days (Sukkos: Erev → Simchas Torah), so 20 days
  // is ample and can never reach into the prior year's occurrence.
  const searchFrom = addDays(fromISO, -20);
  const horizon = addDays(fromISO, 420);
  const clusters = cal.clusters(searchFrom, horizon).filter((c) => c.days.some((d) => wanted.has(d.dayType)));
  if (!clusters.length) return null;
  // Group clusters into festival occurrences (adjacent clusters within ~15 days —
  // e.g. Sukkos I/II and Shmini Atzeres/Simchas Torah are one Sukkos).
  const occurrences = [];
  for (const c of clusters) {
    const prev = occurrences[occurrences.length - 1];
    const gap = prev ? (new Date(c.startsAt) - new Date(prev[prev.length - 1].endsAt)) / 86400000 : Infinity;
    if (gap < 15) prev.push(c); else occurrences.push([c]);
  }
  // Pick the current-or-next occurrence: the first that hasn't finished yet (its
  // last day is on/after `from`). Skipping forward to a later month therefore
  // lands on next year's occurrence, still rendered in full.
  const picked = occurrences.find((occ) => occ[occ.length - 1].days[occ[occ.length - 1].days.length - 1].date >= fromISO);
  if (!picked) return null;
  const first = picked[0];
  const last = picked[picked.length - 1];
  // Erev Pesach (14 Nisan) falling on Shabbos: the Shabbos is itself part of
  // the assur run, so the cluster's civil erev is FRIDAY 13 Nisan. Chametz
  // halachos shift (Star-K / Rabbi Heber): burn on Friday by the usual biur
  // time (custom; no Kol Chamira), while Sof Zman Achilas Chametz and Kol
  // Chamira apply on Shabbos morning itself. Bedika moves to Thursday night.
  const epShabbos = festival === 'pesach' && first.days[0]?.dayType === 'shabbos';
  // Pesach: also include the night of Bedikas Chametz (the day before erev) —
  // but only as a one-line reminder, not a full zmanim block.
  let start = first.erevDate;
  if (festival === 'pesach') start = addDays(first.days[0].date, -2); // 13 Nisan (12 Nisan when erev is Shabbos)
  const bedikasDate = festival === 'pesach' ? start : null;
  const end = last.days[last.days.length - 1].date;

  // omer map: civil date → count number
  const omerMap = new Map();
  const gy = Number(start.slice(0, 4));
  for (const y of [gy, gy + 1]) {
    for (const ev of HebrewCalendar.calendar({ year: y, isHebrewYear: false, il: cal.location.il, omer: true })) {
      if (ev.getFlags() & flags.OMER_COUNT) omerMap.set(ev.getDate().greg().toISOString().slice(0, 10), ev.omer);
    }
  }
  // which cluster erevs need Eruv Tavshilin (a Friday YT flows into Shabbos)
  const eruvDates = new Set();
  for (const c of picked) {
    const fridayYT = c.days.some((d) => d.weekday === 5 && d.dayType !== 'shabbos');
    const hasShabbos = c.days.some((d) => d.weekday === 6);
    if (fridayYT && hasShabbos) eruvDates.add(c.erevDate);
  }
  // A Shabbos that lands in Chol Hamoed with no adjacent Yom Tov forms its own
  // single-day assur cluster, which the wanted-dayType filter dropped from
  // `picked`. Fold those back in so Erev Shabbos Chol Hamoed still gets its
  // candle lighting and Shabbos Chol Hamoed its havdalah — the only Chol Hamoed
  // days the sheet keeps (see the drop filter at the end of this function).
  const shabbosCHClusters = cal.clusters(start, end).filter((c) => c.days.every((cd) => cd.dayType === 'shabbos'));
  const boundaryClusters = [...picked, ...shabbosCHClusters];
  const clusterEnds = new Map(boundaryClusters.map((c) => [c.days[c.days.length - 1].date, c.endsAt]));
  const clusterErevs = new Map(boundaryClusters.map((c) => [c.erevDate, c]));

  const nm = namesFor(cal.locale);
  const days = [];
  for (let d = start; d <= end; d = addDays(d, 1)) {
    const info = cal.dayInfo(d);
    const hd = new HDate(civilNoon(d));
    const holidays = HebrewCalendar.getHolidaysOnDate(hd, cal.location.il) ?? [];
    const chm = holidays.find((e) => e.getFlags() & flags.CHOL_HAMOED);
    const weekday = civilNoon(d).getUTCDay();
    const erevCluster = clusterErevs.get(d);
    // a night flowing into ANOTHER assur day gets Hadlakas Neiros too —
    // lit from an existing flame after tzais (2nd YT night, Shabbos→YT)
    const nextAssur = cal.dayInfo(addDays(d, 1)).assur;
    const fromFlame = !erevCluster && info.assur && nextAssur;
    // The two Chol Hamoed days the sheet keeps get an explicit label (Shabbos CH
    // otherwise reads as a bare "Shabbos"; Erev Shabbos CH otherwise reads as the
    // generic "Pesach IV (CH)"). Hoshana Rabba is an erev too, but of Yom Tov —
    // its cluster starts on a Yom Tov day, so it keeps its own name below.
    const isShabbosCH = Boolean(chm) && weekday === 6;
    const isErevShabbosCH = Boolean(chm) && erevCluster && erevCluster.days[0].dayType === 'shabbos';
    days.push({
      iso: d, weekday,
      heDay: hd.getDate(), heMonth: hd.getMonthName(),
      z: dayZmanim(cal.gloc, d, cal.location.tzid, cal.times.tzeitAngle),
      assur: info.assur,
      label: isShabbosCH ? `${nm.shabbos} ${nm.cholHamoed}`
        : isErevShabbosCH ? `${nm.erev} ${nm.shabbos} ${nm.cholHamoed}`
        : info.holidayLabel
        || (chm ? chm.render('en')
          : (erevCluster ? (epShabbos && erevCluster === first ? null : `${nm.erev} ${nm[festival]}`) : null)),
      dayType: info.dayType,
      cholHamoed: Boolean(chm),
      isErev: Boolean(erevCluster),
      isErevPesach: festival === 'pesach' && erevCluster === first && !epShabbos,
      burnChametzFriday: epShabbos && erevCluster === first,
      shabbosErevPesach: epShabbos && d === first.days[0].date,
      candleLighting: erevCluster ? DateTime.fromJSDate(erevCluster.startsAt).setZone(cal.location.tzid).toFormat('h:mm a') : null,
      candlesFromFlame: fromFlame,
      bedikasOnly: d === bedikasDate,
      // Ta'anis Bechoros — normally Erev Pesach, advanced to Thursday when Erev
      // Pesach is Shabbos. hebcal places it on the observed date.
      firstbornFast: festival === 'pesach' && holidays.some((e) => /Bechor/i.test(e.getDesc())),
      havdalah: clusterEnds.has(d) ? DateTime.fromJSDate(clusterEnds.get(d)).setZone(cal.location.tzid).toFormat('h:mm a') : null,
      eruv: eruvDates.has(d),
      omer: omerMap.get(d) ?? null,
      omerTonight: omerMap.get(addDays(d, 1)) ?? null,
    });
  }
  // Rosh Hashanah sheet also carries Tzom Gedaliah (3 Tishrei) as a fast-only
  // day. hebcal places it on the OBSERVED date, so nidcheh is automatic: when
  // 3 Tishrei is Shabbos the fast is pushed to Sunday, 4 Tishrei.
  if (festival === 'rosh-hashanah') {
    const rhLast = last.days[last.days.length - 1].date;
    for (let k = 1; k <= 3; k++) {
      const fd = addDays(rhLast, k);
      const fhd = new HDate(civilNoon(fd));
      const ev = (HebrewCalendar.getHolidaysOnDate(fhd, cal.location.il) ?? []).find((e) => /Gedali/i.test(e.getDesc()));
      if (!ev) continue;
      days.push({
        iso: fd, weekday: civilNoon(fd).getUTCDay(),
        heDay: fhd.getDate(), heMonth: fhd.getMonthName(),
        z: dayZmanim(cal.gloc, fd, cal.location.tzid, cal.times.tzeitAngle),
        assur: false, cholHamoed: false, label: ev.render(cal.locale), fastDayOnly: true,
      });
      break;
    }
  }
  // Drop the regular Chol Hamoed days: their zmanim are plain weekday times
  // anyone can look up, and leaving them off lets the sheet's auto-scaler size
  // the remaining days' text larger. Kept exceptions — Erev Shabbos Chol Hamoed
  // (Friday, candle lighting) and Shabbos Chol Hamoed (Saturday, havdalah), plus
  // any Chol Hamoed day that is the Erev of the next Yom Tov (Hoshana Rabba
  // before Shmini Atzeres; the last day before Pesach VII) which carries candle
  // lighting for that Yom Tov.
  const kept = days.filter((d) => !d.cholHamoed || d.isErev || d.weekday === 5 || d.weekday === 6);
  return { festival, days: kept, first, last, hebYear: new HDate(civilNoon(first.days[0].date)).getFullYear() };
}

// ── low-level drawing helpers (print-friendly: no ink-heavy fills) ───────────
// Label at the left, value right-aligned, dotted leader between. A long
// label+value pair (the Erev-Pesach chametz deadlines) can't fit one line at a
// big font: with `wrap` it drops the value to its own right-aligned line instead
// of colliding — so those lines stay full-size without shrinking the whole sheet.
function leaderLabelFits(doc, label, value, w, size, { bold = false, hebrew = false } = {}) {
  doc.font(hebrew ? (bold ? HEB_FONT_BOLD : HEB_FONT) : (bold ? 'Helvetica-Bold' : 'Helvetica')).fontSize(size);
  const lw = doc.widthOfString(hebrew ? heb(label) : label);
  doc.font('Helvetica-Bold').fontSize(size);
  const vw = doc.widthOfString(value);
  return lw + vw + 6 <= w; // room for the label, the value, and a small gap
}
function leader(doc, x, y, w, label, value, { bold = false, color = '#111827', size = 8, hebrew = false, wrap = false } = {}) {
  const labelStr = hebrew ? heb(label) : label;
  const labelFont = hebrew ? (bold ? HEB_FONT_BOLD : HEB_FONT) : (bold ? 'Helvetica-Bold' : 'Helvetica');
  doc.fontSize(size).fillColor(color).font(labelFont);
  const lw = doc.widthOfString(labelStr);
  doc.font('Helvetica-Bold').fontSize(size);
  const vw = doc.widthOfString(value);
  // Too wide for one line: label on top, value right-aligned beneath it.
  if (wrap && lw + vw + 6 > w) {
    doc.font(labelFont).fillColor(color).text(labelStr, x, y, { lineBreak: false });
    doc.font('Helvetica-Bold').fillColor(color).text(value, x + w - vw, y + size * 1.3, { lineBreak: false });
    return y + 2 * (size * 1.3);
  }
  doc.font(labelFont).fillColor(color).text(labelStr, x, y, { lineBreak: false });
  const dotsStart = x + lw + 4; const dotsEnd = x + w - vw - 4;
  if (dotsEnd > dotsStart + 4) {
    // a real dotted line reads cleaner than a string of '.' characters
    doc.save().moveTo(dotsStart, y + size - 1.5).lineTo(dotsEnd, y + size - 1.5)
      .lineWidth(0.6).dash(0.7, { space: 2.3 }).strokeColor('#b9b9b9').stroke().undash().restore();
  }
  doc.font('Helvetica-Bold').fillColor(color).text(value, x + w - vw, y, { lineBreak: false });
  return y + size + size * 0.3;
}

// Type metrics derived from a base font size, so a sheet with spare room can
// scale its text up to fill the page (and a packed one stays compact).
const metricsFor = (fs) => {
  const nfs = Math.max(7, fs * 0.92);
  // bar height reflects the single-line day header (title + hebrew date inline)
  return { fs, R: fs * 1.3, nfs, N: nfs * 1.2 + 1.5, bar: (fs + 0.5) * 1.15 + 6.5 + 4, blk: 4 + (fs - 8) };
};

function dayBar(doc, x, y, w, theme, title, heDate, label, fs = 8.5, hebrewLabel = false) {
  // ONE line: DAY, DATE · hebrew date · holiday label. The gray sub shrinks
  // to fit beside the title instead of wrapping or truncating, so the
  // auto-scaler can spend the saved height on bigger zmanim text.
  doc.fillColor('#111827').font('Helvetica-Bold').fontSize(fs);
  const t = title.toUpperCase();
  doc.text(t, x, y, { lineBreak: false });
  const tw = doc.widthOfString(t);
  const sep = '  ·  ';
  const measure = (sz) => {
    doc.font('Helvetica').fontSize(sz);
    let wsum = doc.widthOfString(sep + heDate);
    if (label) {
      wsum += doc.widthOfString(sep);
      if (hebrewLabel) { doc.font(HEB_FONT).fontSize(sz + 1); wsum += doc.widthOfString(heb(label)); }
      else wsum += doc.widthOfString(label);
    }
    return wsum;
  };
  let subSize = fs * 0.82;
  while (subSize > 6 && tw + measure(subSize) > w) subSize -= 0.4;
  let cx = x + tw;
  const baseY = y + (fs - subSize) * 0.75;
  doc.font('Helvetica').fontSize(subSize).fillColor('#6b7280').text(sep + heDate, cx, baseY, { lineBreak: false });
  cx += doc.widthOfString(sep + heDate);
  if (label) {
    doc.text(sep, cx, baseY, { lineBreak: false });
    cx += doc.widthOfString(sep);
    if (hebrewLabel) doc.font(HEB_FONT).fontSize(subSize + 1).text(heb(label), cx, baseY - 1, { lineBreak: false });
    else doc.text(label, cx, baseY, { lineBreak: false });
  }
  const ly = y + fs * 1.15 + 2.5;
  doc.save().moveTo(x, ly).lineTo(x + w, ly).lineWidth(1).strokeColor(theme.accent).stroke().restore();
  return ly + 4;
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Shabbos'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// The Erev-Pesach chametz deadline lines a day renders (label → value). Shared
// by the height pass and the renderer so both agree on how many wrap.
function chametzPairs(day, nm) {
  if (!day.z) return [];
  const eatBoth = `${day.z.endEatChametz} / ${day.z.endEatChametzGRA}`;
  const burnBoth = `${day.z.endOwnChametz} / ${day.z.endOwnChametzGRA}`;
  const out = [];
  if (day.isErevPesach) out.push([nm.eatChametz, eatBoth], [nm.burnChametz, burnBoth]);
  if (day.burnChametzFriday) out.push([nm.burnFri, burnBoth]);
  if (day.shabbosErevPesach) out.push([nm.eatChametz, eatBoth], [nm.kolChamira, burnBoth]);
  return out;
}

/** Exact rendered height of a day block, so column wrapping never guesses. */
function dayHeight(day, m, doc, w, nm) {
  const { R, N } = m; let h = m.bar;
  // Height of one accent leader line: a long label+value pair (bedikas, chametz,
  // chatzos halayla) wraps to two lines rather than colliding, so it may be 2R.
  const lineH = (label, value) => (leaderLabelFits(doc, label, value, w, m.fs, { bold: true, hebrew: nm.hebrew }) ? R : 2 * R);
  if (day.bedikasOnly) return h + lineH(nm.bedikas, day.z.tzeis) + m.blk;
  if (day.fastDayOnly) return h + 2 * R + m.blk; // just fast begins + ends
  if (day.eruv) h += N;
  if (day.firstbornFast) h += N;
  if (day.fastBegins) h += N;
  if (day.tashlich) h += N;
  // chametz deadlines: each takes two lines when it has to wrap at this size
  for (const [label, value] of chametzPairs(day, nm)) h += lineH(label, value);
  if (day.tefilasTal) h += N;
  let rows = 5;
  if (day.candleLighting || day.isErev) rows++;
  h += rows * R + 2 * R; // + shkia + tzeis
  if (day.candleLighting) h += R;
  if (day.candlesFromFlame) h += R;
  if (day.sederNight) h += lineH(nm.chatzosNight, day.z.chatzosNight);
  if (day.havdalah) h += R;
  // today's omer count + tonight's-count reminder share one line when both apply
  if (day.omer || (day.omerTonight && day.assur)) h += N;
  if (day.yizkor) h += N;
  return h + m.blk;
}

/** Render one festival day into a column, returns the new y. */
function renderDay(doc, x, y, w, theme, day, nm, m) {
  const cn = civilNoon(day.iso);
  const dateStr = `${MONTHS[cn.getUTCMonth()]} ${cn.getUTCDate()}`;
  const title = `${WEEKDAYS[day.weekday]}, ${dateStr}`;
  y = dayBar(doc, x, y, w, theme, title, `${day.heDay} ${day.heMonth}`, day.label, m.fs + 0.5, nm.hebrew);
  const note = (txt, col = theme.accent) => {
    doc.font(nm.hebrew ? HEB_FONT_BOLD : 'Helvetica-Bold').fontSize(m.nfs).fillColor(col)
      .text(nm.hebrew ? heb(txt) : txt, x, y, { width: w });
    y = doc.y + 1;
  };

  // the pre-erev-Pesach day exists only for the Bedikas Chametz reminder
  if (day.bedikasOnly) {
    y = leader(doc, x, y, w, nm.bedikas, day.z.tzeis, { bold: true, color: theme.accent, size: m.fs, hebrew: nm.hebrew, wrap: true });
    return y + m.blk;
  }
  // a minor fast day appended after a Yom Tov (e.g. Tzom Gedaliah after Rosh
  // Hashanah): just the fast window, not a full zmanim block.
  if (day.fastDayOnly) {
    y = leader(doc, x, y, w, nm.fastBeginsDawn, day.z.alos, { bold: true, color: theme.accent, size: m.fs, hebrew: nm.hebrew });
    y = leader(doc, x, y, w, nm.fastEndsTzais, day.z.tzeis, { bold: true, color: theme.accent, size: m.fs, hebrew: nm.hebrew });
    return y + m.blk;
  }

  if (day.eruv) note(nm.eruv);
  if (day.firstbornFast) note(nm.firstborn, theme.bar);
  if (day.tashlich) note(nm.tashlich, theme.bar);
  // Sof zman achilas / biur chametz on Erev Pesach — MG"A (stringent) then GR"A.
  // These are the widest lines on any sheet; they wrap (value drops beneath the
  // label) rather than force the whole sheet to a smaller font. On an Erev Pesach
  // that falls on Shabbos the pairs shift: burn Friday by the usual biur time
  // (custom, no Kol Chamira), while eating + Kol Chamira land Shabbos morning.
  for (const [label, value] of chametzPairs(day, nm)) {
    y = leader(doc, x, y, w, label, value, { bold: true, color: theme.accent, size: m.fs, hebrew: nm.hebrew, wrap: true });
  }
  if (day.tefilasTal) note(nm.tal);

  const rows = [];
  rows.push([nm.alos, day.z.alos]);
  rows.push([nm.neitz, day.z.neitz]);
  rows.push([nm.shma, `${day.z.shmaMGA} / ${day.z.shmaGRA}`]);
  for (const [l, v] of rows.splice(0)) y = leader(doc, x, y, w, l, v, { size: m.fs, hebrew: nm.hebrew });
  // Yizkor is said during the morning service — list it before Chatzos
  if (day.yizkor) note(nm.yizkor, theme.bar);
  rows.push([nm.chatzos, day.z.chatzos]);
  rows.push([nm.minchaG, day.z.minchaGedola]);
  if (day.candleLighting || day.isErev) rows.push([nm.plag, day.z.plag]);
  for (const [l, v] of rows) y = leader(doc, x, y, w, l, v, { size: m.fs, hebrew: nm.hebrew });

  if (day.candleLighting) y = leader(doc, x, y, w, nm.candles, day.candleLighting, { bold: true, color: theme.accent, size: m.fs, hebrew: nm.hebrew });
  if (day.fastBegins) y = leader(doc, x, y, w, `${nm.shkia} · ${nm.fastBeginsShort}`, day.z.shkia, { bold: true, color: theme.accent, size: m.fs, hebrew: nm.hebrew });
  else y = leader(doc, x, y, w, nm.shkia, day.z.shkia, { size: m.fs, hebrew: nm.hebrew });
  y = leader(doc, x, y, w, nm.tzeis, `${day.z.tzeis} / ${day.z.tzeis72}`, { size: m.fs, hebrew: nm.hebrew });
  // a night flowing into another assur day: light from an existing flame
  if (day.candlesFromFlame) y = leader(doc, x, y, w, nm.candles, day.z.tzeis, { bold: true, color: theme.accent, size: m.fs, hebrew: nm.hebrew });
  // seder night: halachic midnight (afikoman/seder deadline)
  if (day.sederNight) y = leader(doc, x, y, w, nm.chatzosNight, day.z.chatzosNight, { bold: true, color: theme.accent, size: m.fs, hebrew: nm.hebrew, wrap: true });
  if (day.havdalah) y = leader(doc, x, y, w, day.fastEnds ? nm.fastEnds : nm.havdalah, day.havdalah, { bold: true, color: theme.accent, size: m.fs, hebrew: nm.hebrew });

  // Sefiras HaOmer: today's count, plus (on assur days) a reminder of tonight's.
  // When both apply they share one line to save vertical space.
  const omerNight = day.omerTonight && day.assur;
  if (day.omer && omerNight) {
    note(nm.hebrew
      ? `${nm.omer} · יום ${gematriya(day.omer)} · הלילה: יום ${gematriya(day.omerTonight)}`
      : `${nm.omer} · Day ${day.omer} · tonight: Day ${day.omerTonight}`, theme.bar);
  } else if (day.omer) {
    note(nm.hebrew ? `${nm.omer} · יום ${gematriya(day.omer)}` : `${nm.omer} · Day ${day.omer}`, theme.bar);
  } else if (omerNight) {
    note(nm.hebrew ? `${nm.omerTonight} ${gematriya(day.omerTonight)}` : `${nm.omerTonight} ${day.omerTonight}`, '#6b7280');
  }
  return y + m.blk;
}

/**
 * Build a one-page Yom Tov zmanim sheet. Returns a PDFDocument (already ended);
 * pipe or buffer it. `festival` ∈ pesach | sukkos | shavuos.
 */
export function yomTovSheet(cal, festival, fromISO = new Date().toISOString().slice(0, 10)) {
  const data = festivalDays(cal, festival, fromISO);
  if (!data) return null;
  const theme = THEMES[festival];
  // mark special once-per-occurrence reminders
  const ytDays = data.days.filter((d) => d.assur && !d.cholHamoed);
  // Tal is Musaf of Pesach I itself — when Erev Pesach is Shabbos, the first
  // assur day is that Shabbos, which must NOT get the Tal note
  if (festival === 'pesach') {
    const p1 = data.days.find((d) => d.dayType === 'pesach-1') ?? ytDays[0];
    if (p1) p1.tefilasTal = true;
    // Seder nights (afikoman/seder should finish by chatzos halayla): the
    // night going into Pesach I is the first seder; in the diaspora the night
    // going into Pesach II is the second. Each night "belongs" to the day it
    // starts on — i.e. the day BEFORE the seder day.
    const dayBefore = (dt) => {
      const i = data.days.findIndex((d) => d.dayType === dt);
      return i > 0 ? data.days[i - 1] : null;
    };
    const firstSeder = dayBefore('pesach-1');
    if (firstSeder) firstSeder.sederNight = true;
    if (!cal.location.il) { const secondSeder = data.days.find((d) => d.dayType === 'pesach-1'); if (secondSeder) secondSeder.sederNight = true; }
  }
  // Yizkor: last day of Pesach/Shavuos, Shmini Atzeres, and Yom Kippur (not RH)
  if (festival === 'pesach' || festival === 'shavuos') { const l = data.days.filter((d) => d.assur).pop(); if (l) l.yizkor = true; }
  if (festival === 'sukkos') { const sa = data.days.find((d) => d.dayType === 'shmini-atzeres'); if (sa) sa.yizkor = true; }
  if (festival === 'yom-kippur') {
    const erev = data.days.find((d) => d.isErev); if (erev) erev.fastBegins = true;
    const yk = data.days.find((d) => d.dayType === 'yom-kippur'); if (yk) { yk.yizkor = true; yk.fastEnds = true; }
  }
  if (festival === 'rosh-hashanah') {
    // Tashlich: RH day 1, or day 2 if day 1 is Shabbos
    const d1 = data.days.find((d) => d.dayType === 'rosh-hashanah-1');
    const d2 = data.days.find((d) => d.dayType === 'rosh-hashanah-2');
    const t = (d1 && d1.weekday === 6 && d2) ? d2 : d1; if (t) t.tashlich = true;
  }

  const nm = namesFor(cal.locale);
  const doc = new PDFDocument({ size: 'LETTER', margin: 32, bufferPages: true });
  // disable pdfkit auto-pagination — our column logic controls every page break
  doc.on('pageAdded', () => { doc.page.margins.bottom = 0; });
  doc.page.margins.bottom = 0;
  const M = 32; const PW = 612 - M * 2;

  // header — title with the location/year inline to its right (frees a line of
  // vertical space so the body text auto-sizes a touch larger). Dark text + a
  // thin accent rule; no filled band, so it prints cleanly in B&W.
  const titleText = nm.hebrew
    ? heb(`זמני ${nm[festival]} ${gematriya(data.hebYear)}`)
    : `Zmanim for ${nm[festival]} ${data.hebYear}`;
  doc.fillColor('#111827').font(nm.hebrew ? HEB_FONT_BOLD : 'Helvetica-Bold').fontSize(21).text(titleText, M, M + 2, { lineBreak: false });
  const titleW = doc.widthOfString(titleText);
  doc.font('Helvetica').fontSize(10.5).fillColor('#6b7280')
    .text(`${cal.location.city || 'Your location'}  ·  ${civilNoon(data.days[0].iso).getUTCFullYear()}`, M + titleW + 12, M + 12, { lineBreak: false });
  doc.save().moveTo(M, M + 30).lineTo(M + PW, M + 30).lineWidth(1.4).strokeColor(theme.accent).stroke().restore();

  // two columns
  const gap = 18; const colW = (PW - gap) / 2;
  const cols = [M, M + colW + gap];
  const topY = M + 42; const bottomY = 792 - 34;

  // Pick the LARGEST font that still packs every day into two columns on one
  // page, so sheets with spare room (e.g. Sukkos, Shavuos) print big and easy
  // to read while the fullest one (Pesach) stays compact.
  const fits = (m) => {
    let ci = 0; let yy = topY;
    for (const day of data.days) {
      const h = dayHeight(day, m, doc, colW, nm);
      if (h > bottomY - topY) return false;
      if (yy + h > bottomY && yy > topY) { ci++; yy = topY; if (ci > 1) return false; }
      yy += h;
    }
    return true;
  };
  // Horizontal cap: without it a sparse sheet would pick a font so large that
  // the longest label collides with its right-aligned time. Measure the widest
  // label + value at a reference size; width scales linearly with font size, so
  // that gives an exact ceiling on the chosen size. Only ONE-LINE content counts
  // — the chametz deadlines ("Sof Zman Achilas Chametz (MG"A / GR"A)" + its two
  // times, the widest lines anywhere) are excluded on purpose because they wrap
  // (see leader's `wrap`); counting them used to shrink the whole sheet and leave
  // the second column near-empty.
  const REF = 10; const MIN_GAP = 12;
  const labelFont = nm.hebrew ? HEB_FONT : 'Helvetica';
  const labelStrs = [nm.alos, nm.neitz, nm.shma, nm.chatzos, nm.minchaG, nm.plag,
    nm.candles, nm.shkia, nm.tzeis].map((s) => (nm.hebrew ? heb(s) : s));
  doc.font(labelFont).fontSize(REF);
  const maxLabelW = Math.max(...labelStrs.map((s) => doc.widthOfString(s)));
  const valStrs = [];
  for (const day of data.days) {
    if (!day.z) continue;
    valStrs.push(`${day.z.shmaMGA} / ${day.z.shmaGRA}`, `${day.z.tzeis} / ${day.z.tzeis72}`);
  }
  doc.font('Helvetica-Bold').fontSize(REF);
  const maxValW = Math.max(...valStrs.map((s) => doc.widthOfString(s)));
  // The exact font size at which the widest label + value + gap fills the column.
  // Width scales linearly with size, so this is the ceiling for ANY chosen size
  // (including the 10.5–11.5 rungs above REF) — never skip it, or a big font
  // would collide its label into its right-aligned time.
  const hCap = ((colW - MIN_GAP) * REF) / (maxLabelW + maxValW);

  let m = metricsFor(7);
  for (const fs of [11.5, 11, 10.5, 10, 9.5, 9, 8.5, 8, 7.5, 7]) { if (fs <= hCap && fits(metricsFor(fs))) { m = metricsFor(fs); break; } }

  let ci = 0; let y = topY;
  for (const day of data.days) {
    if (y + dayHeight(day, m, doc, colW, nm) > bottomY && y > topY) { ci++; if (ci > 1) { doc.addPage(); ci = 0; } y = topY; }
    y = renderDay(doc, cols[ci], y, colW, theme, day, nm, m);
  }

  footer(doc, cal);
  doc.end();
  return doc;
}

/**
 * Multi-page: candle lighting / shkia / havdalah for every Shabbos in the year
 * STARTING FROM `fromISO` (so the sheet is a rolling 12 months from when it's
 * generated, not a fixed calendar year). Zman names follow the display locale.
 */
export function shabbosYearSheet(cal, fromISO = new Date().toISOString().slice(0, 10)) {
  const theme = THEMES.shabbos;
  const nm = namesFor(cal.locale);
  const start = fromISO;
  const end = addDays(fromISO, 365); // a full year forward from when it's generated
  const doc = new PDFDocument({ size: 'LETTER', margin: 40, bufferPages: true });
  doc.on('pageAdded', () => { doc.page.margins.bottom = 0; });
  doc.page.margins.bottom = 0;
  const M = 40; const PW = 612 - M * 2;

  const range = `${MONTHS[civilNoon(start).getUTCMonth()].slice(0, 3)} ${civilNoon(start).getUTCDate()}, ${civilNoon(start).getUTCFullYear()} – ${MONTHS[civilNoon(end).getUTCMonth()].slice(0, 3)} ${civilNoon(end).getUTCDate()}, ${civilNoon(end).getUTCFullYear()}`;
  const header = () => {
    if (nm.hebrew) doc.fillColor('#111827').font(HEB_FONT_BOLD).fontSize(20).text(heb(`זמני ${nm.shabbos}`), M, M + 2, { lineBreak: false });
    else doc.fillColor('#111827').font('Helvetica-Bold').fontSize(20).text(`${nm.shabbos} Zmanim`, M, M + 2);
    doc.font('Helvetica').fontSize(10).fillColor('#6b7280').text(`${cal.location.city || 'Your location'} · ${range} · Candle Lighting, ${(nm.hebrew ? NAMES.ashkenazi : nm).shkia} & Havdalah`, M, M + 26);
    doc.save().moveTo(M, M + 42).lineTo(M + PW, M + 42).lineWidth(1.4).strokeColor(theme.accent).stroke().restore();
  };
  header();
  let y = M + 52;
  // larger, easier-to-read rows (this sheet may span multiple pages, so there's
  // no need to cram it)
  const RH = 21; const FS = 11;
  // parsha column starts early and runs wide — double parshios like
  // "Parshas Nitzavim-Vayeilech" must never truncate
  const cols = [M + 6, M + 110, M + 312, M + 400, M + 478];
  const headRow = (yy) => {
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#6b7280');
    const hnm = nm.hebrew ? NAMES.ashkenazi : nm;
    doc.text('DATE', cols[0], yy, { lineBreak: false }); doc.text(hnm.parsha, cols[1], yy, { lineBreak: false });
    doc.text(hnm.candlesShort, cols[2], yy, { lineBreak: false }); doc.text(hnm.shkiaShort, cols[3], yy, { lineBreak: false }); doc.text(hnm.havdalahShort, cols[4], yy, { lineBreak: false });
    return yy + 18;
  };
  y = headRow(y);

  // collect every Friday→Shabbos in the rolling year
  const clusters = cal.clusters(start, end);
  const shabbosClusters = clusters.filter((c) => c.days.some((d) => d.weekday === 6));
  let i = 0;
  for (const c of shabbosClusters) {
    const sat = c.days.find((d) => d.weekday === 6);
    if (!sat || sat.date < start || sat.date > end) continue;
    // Only show a Shabbos whose havdalah is a real motzei-Shabbos havdalah.
    // When the Saturday flows into more Yom Tov (its cluster continues past
    // Saturday — Sukkos I → Sukkos II, Rosh Hashanah I → II, Shmini Atzeres →
    // Simchas Torah, or an Erev-Yom-Tov that falls on Shabbos), c.endsAt is the
    // end of the whole Yom Tov run, not motzei Shabbos — so the row would show a
    // havdalah that doesn't exist that night. Skip it; the Yom Tov sheet covers
    // those days. A Yom Tov whose LAST day is Shabbos (Yom Kippur, Simchas
    // Torah, Pesach VIII…) ends on the Saturday and keeps its genuine havdalah.
    if (c.days[c.days.length - 1].date !== sat.date) continue;
    const cn = civilNoon(sat.date);
    const info = cal.dayInfo(sat.date);
    // Shabbos Chol Hamoed has no weekly parsha (special reading) — label it by
    // the festival it falls in rather than the bare "Shabbos" holidayLabel.
    let parsha = info.parsha
      || (info.cholHamoed ? `${nm.shabbos} ${nm.cholHamoed} ${nm[info.cholHamoed]}` : null)
      || (info.holidayLabel ?? '').replace(/ \(.*/, '') || '—';
    // a holiday label carrying a year (e.g. Rosh Hashanah "ראש השנה 5787") would
    // reverse its ASCII digits inside the RTL run — drop the year in Hebrew.
    if (nm.hebrew) parsha = parsha.replace(/\s+\d{3,4}\s*$/, '');
    const candles = DateTime.fromJSDate(c.startsAt).setZone(cal.location.tzid).toFormat('h:mm a');
    const shkia = DateTime.fromJSDate(new Zmanim(cal.gloc, civilNoon(sat.date), false).sunset()).setZone(cal.location.tzid).toFormat('h:mm a');
    const havdalah = DateTime.fromJSDate(c.endsAt).setZone(cal.location.tzid).toFormat('h:mm a');
    if (i % 2 === 0) { doc.rect(M, y - 4, PW, RH).fill('#f4f4f5'); }
    doc.font('Helvetica').fontSize(FS).fillColor('#111827');
    doc.text(`${MONTHS[cn.getUTCMonth()].slice(0, 3)} ${cn.getUTCDate()}, ${cn.getUTCFullYear()}`, cols[0], y, { lineBreak: false });
    if (nm.hebrew) doc.font(HEB_FONT).fillColor('#374151').text(heb(parsha.slice(0, 34)), cols[1], y, { lineBreak: false, width: 196, height: RH, ellipsis: true });
    else doc.fillColor('#374151').text(parsha.slice(0, 34), cols[1], y, { lineBreak: false, width: 196, height: RH, ellipsis: true });
    doc.font('Helvetica-Bold').fillColor(theme.accent).text(candles, cols[2], y, { lineBreak: false });
    doc.font('Helvetica').fillColor('#111827').text(shkia, cols[3], y, { lineBreak: false });
    doc.font('Helvetica-Bold').fillColor(theme.accent).text(havdalah, cols[4], y, { lineBreak: false });
    y += RH; i++;
    if (y > 792 - 60) { footer(doc, cal); doc.addPage(); header(); y = M + 52; y = headRow(y); }
  }
  footer(doc, cal);
  doc.end();
  return doc;
}

function footer(doc, cal) {
  // draw right at the page edge without triggering pdfkit auto-pagination
  doc.page.margins.bottom = 0;
  doc.font('Helvetica-Oblique').fontSize(6.8).fillColor('#9ca3af').text(
    `All times dynamically calculated with @hebcal/core for ${cal.location.city || 'your location'} `
    + `(${Number(cal.location.lat).toFixed(4)}, ${Number(cal.location.lng).toFixed(4)}).`,
    36, 792 - 46, { width: 612 - 72, align: 'center', lineBreak: false },
  );
  smartonegNod(doc);
}
