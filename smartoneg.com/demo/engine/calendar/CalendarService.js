import { HebrewCalendar, HDate, Zmanim, GeoLocation, Sedra, ParshaEvent, gematriya, flags } from '@hebcal/core';
import { DateTime } from 'luxon';
import { dayTypeFromDesc, variantForDay } from './dayTypes.js';

/**
 * Civil date (YYYY-MM-DD) -> JS Date at 12:00 UTC. Noon UTC falls on the same
 * civil date in every timezone between UTC-11 and UTC+11, so hebcal reads the
 * intended calendar day regardless of the host/container timezone.
 */
function civilNoon(dateISO) {
  const [y, m, d] = dateISO.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12));
}

function addDays(dateISO, n) {
  const dt = civilNoon(dateISO);
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

/**
 * All Hebrew-calendar and solar-time computation for the app. Pure and
 * deterministic: config in, Dates out. No caching invalidation subtleties —
 * construct a new instance whenever location/times config changes.
 */
export class CalendarService {
  #zmanimCache = new Map();
  #dayInfoCache = new Map();
  #sedraCache = new Map();

  /**
   * @param {object} location { lat, lng, tzid, il, elevation, city }
   * @param {object} times { candleLightingMins, havdalahMins, tzeitAngle }
   * @param {string} [locale] holiday-name rendering: 'ashkenazi' (default) | 'en' | 'he' | 'he-x-NoNikud'
   */
  constructor({ location, times, locale = 'ashkenazi' }) {
    this.location = location;
    this.times = times;
    this.locale = locale;
    this.gloc = new GeoLocation(
      location.city || 'home', location.lat, location.lng,
      location.elevation ?? 0, location.tzid,
    );
  }

  /** ISO weekday for a civil date in the configured timezone context. 1=Mon..7=Sun */
  weekday(dateISO) {
    return DateTime.fromISO(dateISO, { zone: this.location.tzid }).weekday;
  }

  /** Solar zmanim for a civil date. All values are JS Dates (absolute instants). */
  zmanim(dateISO) {
    let z = this.#zmanimCache.get(dateISO);
    if (z) return z;
    const zm = new Zmanim(this.gloc, civilNoon(dateISO), false);
    z = {
      dateISO,
      sunrise: zm.sunrise(),
      sunset: zm.sunset(),
      chatzot: zm.chatzot(),
      // chatzotNight(date) = midpoint of the night LEADING INTO this civil
      // date (~12:45am). A pesach-1 rule using chatzotNight fires on seder
      // night, which is exactly the halachic intent (matzah before chatzos).
      chatzotNight: zm.chatzotNight(),
      alotHaShachar: zm.alotHaShachar(),
      plagHaMincha: zm.plagHaMincha(),
      minchaGedola: zm.minchaGedola(),
      minchaKetana: zm.minchaKetana(),
      sofZmanShma: zm.sofZmanShma(),
      sofZmanTfilla: zm.sofZmanTfilla(),
      tzeit: zm.tzeit(this.times.tzeitAngle),
    };
    this.#zmanimCache.set(dateISO, z);
    return z;
  }

  /**
   * Holiday facts for one civil date.
   * @returns {{ assur, dayType, holidayLabel, isErevPesach }}
   *  dayType is the YT slot key, or 'shabbos' for a plain Saturday; a YT that
   *  coincides with Saturday keeps its YT dayType (variant handles Shabbos-ness).
   */
  dayInfo(dateISO) {
    let info = this.#dayInfoCache.get(dateISO);
    if (info) return info;

    const hd = new HDate(civilNoon(dateISO));
    const events = HebrewCalendar.getHolidaysOnDate(hd, this.location.il) ?? [];
    let dayType = null;
    let holidayLabel = null;
    for (const ev of events) {
      if (ev.getFlags() & flags.CHAG) {
        const mapped = dayTypeFromDesc(ev.getDesc()); // getDesc() is locale-independent
        if (mapped) {
          dayType = mapped;
          holidayLabel = ev.render(this.locale);
          break;
        }
      }
    }
    // hebcal renders Rosh Hashana day 1 with the year ("Rosh Hashana 5789",
    // "ראש השנה 5789"), unlike day 2's ordinal ("Rosh Hashana II", "ראש השנה ב׳").
    // Swap the trailing year for the day-1 ordinal so the two days read
    // consistently in the calendar/timeline and match the schedules page.
    if (dayType === 'rosh-hashanah-1' && holidayLabel && /\s+\d{3,4}\s*$/.test(holidayLabel)) {
      const isHebrew = this.locale === 'he' || this.locale === 'he-x-NoNikud';
      holidayLabel = holidayLabel.replace(/\s+\d{3,4}\s*$/, isHebrew ? ' א׳' : ' I');
    }
    // hebcal's English render spells it "Rosh Hashana"; the app standardizes on
    // "Rosh Hashanah" everywhere (matches the schedules page). Idempotent: the
    // \b won't match the already-corrected "Hashanah". Hebrew labels are unaffected.
    if (holidayLabel) holidayLabel = holidayLabel.replace(/Rosh Hashana\b/g, 'Rosh Hashanah');
    const isSaturday = this.weekday(dateISO) === 6;
    const isErevPesach = events.some((ev) => ev.getDesc() === 'Erev Pesach');
    if (!dayType && isSaturday) {
      dayType = 'shabbos';
      const shabbosName = { ashkenazi: 'Shabbos', en: 'Shabbat', he: 'שַׁבָּת', 'he-x-NoNikud': 'שבת' }[this.locale] ?? 'Shabbos';
      holidayLabel = isErevPesach ? `${shabbosName} (Erev Pesach)` : shabbosName;
    }
    // Parsha of the week — display only, for plain Shabbosos
    let parsha = null;
    if (isSaturday) {
      try {
        const year = hd.getFullYear();
        if (!this.#sedraCache.has(year)) this.#sedraCache.set(year, new Sedra(year, this.location.il));
        const sedra = this.#sedraCache.get(year);
        const res = sedra.lookup(hd);
        if (!res.chag) parsha = new ParshaEvent(res).render(this.locale);
      } catch { /* parsha is decorative — never fail dayInfo over it */ }
    }
    // Chol Hamoed of Pesach/Sukkos — used to pick the Shabbos Chol Hamoed
    // situations (a Shabbos in the intermediate days). getDesc() is locale-safe.
    const chmEv = events.find((ev) => ev.getFlags() & flags.CHOL_HAMOED);
    const cholHamoed = chmEv
      ? (/Pesach/i.test(chmEv.getDesc()) ? 'pesach' : (/Sukk/i.test(chmEv.getDesc()) ? 'sukkos' : null))
      : null;
    // Chanukah — used to pick the "Shabbos Chanukah" situation (a Shabbos falling
    // during Chanukah). Match the description, not the CHANUKAH_CANDLES flag: that
    // flag is absent on the 8th day ("Chanukah: 8th Day" — no candle lit that
    // night), which is still Chanukah. A minor holiday, never assur on its own.
    const chanukah = events.some((ev) => /Chanukah/i.test(ev.getDesc()));
    info = { assur: dayType !== null, dayType, holidayLabel, isErevPesach, cholHamoed, chanukah, parsha };
    this.#dayInfoCache.set(dateISO, info);
    return info;
  }

  /**
   * Hebrew date info for every civil date in [fromISO, toISO] (display only).
   * @returns {Array<{date, heDay, heMonth, heDayHe, monthStart}>}
   *  heDay = 1-30, heMonth = English month name, heDayHe = Hebrew-numeral day,
   *  monthStart = true on Rosh Chodesh (1st of the Hebrew month).
   */
  hebrewDates(fromISO, toISO) {
    const out = [];
    let prevOffset = DateTime.fromISO(`${addDays(fromISO, -1)}T12:00`, { zone: this.location.tzid }).offset;
    for (let d = fromISO; d <= toISO; d = addDays(d, 1)) {
      const hd = new HDate(civilNoon(d));
      // Detect a civil clock change (DST) for the configured timezone: compare
      // the UTC offset at noon today vs yesterday. Hebcal has no DST concept —
      // Luxon's tz database does.
      const offset = DateTime.fromISO(`${d}T12:00`, { zone: this.location.tzid }).offset;
      let clockChange = null;
      if (offset > prevOffset) clockChange = 'forward'; // spring forward
      else if (offset < prevOffset) clockChange = 'back'; // fall back
      prevOffset = offset;
      // Chol Hamoed (intermediate days of Pesach/Sukkos) — not assur, so not part
      // of a cluster, but worth marking on the calendar as a UI touch.
      const holidays = HebrewCalendar.getHolidaysOnDate(hd, this.location.il) ?? [];
      const chm = holidays.find((ev) => ev.getFlags() & flags.CHOL_HAMOED);
      // Display-only observances: Rosh Chodesh, fasts (major + minor), minor
      // holidays (Chanukah, Purim, Tu BiShvat, Lag BaOmer, Tu B'Av…). Assur
      // days are excluded (the cluster styling already labels them) and so are
      // modern holidays (Yom HaAtzmaut etc.) per the house rule.
      const OBSERVANCE_MASK = flags.ROSH_CHODESH | flags.MAJOR_FAST | flags.MINOR_FAST
        | flags.MINOR_HOLIDAY | flags.CHANUKAH_CANDLES | flags.EREV;
      const keptEvents = holidays.filter((ev) => {
        const f = ev.getFlags();
        // Keep every Chanukah night as an observance — the FIRST ("Chanukah: 1
        // Candle") is also EREV-flagged, which the erev drop below would discard,
        // so check it first.
        if (f & flags.CHANUKAH_CANDLES) return true;
        if (f & flags.MODERN_HOLIDAY) return false;
        if (f & flags.BEHAB) return false;           // optional BeHaB fasts — not wanted on the calendar
        if (/LaBehemot|Yom Kippur Katan/i.test(ev.getDesc())) return false; // obscure — keep off the calendar
        if (f & flags.CHAG) return false;            // assur — cluster shows it
        if (f & flags.CHOL_HAMOED) return false;     // already shown separately
        // Erev styling normally comes from clusters, so erevs are dropped — but
        // Tisha B'Av is a weekday fast with no cluster, so surface its erev as a
        // display-only label (the fast-times guard below keeps it label-only).
        if (f & flags.EREV) return /Tish.a B.Av/i.test(ev.getDesc());
        if (f & flags.SPECIAL_SHABBAT) return false; // not requested
        return Boolean(f & OBSERVANCE_MASK);
      });
      const observances = keptEvents.map((ev) => ev.render(this.locale));
      // fast times for display. Tisha B'Av spans two civil days, so it is split:
      // Erev Tisha B'Av shows only when the fast begins (shkia), and Tisha B'Av
      // itself shows when it ends (tzeis) plus chatzos (halachically relevant).
      // Every other fast is a single dawn→nightfall day (alos → tzeis).
      let fast = null;
      const fastEv = keptEvents.find((ev) => ev.getFlags() & (flags.MAJOR_FAST | flags.MINOR_FAST));
      if (fastEv) {
        const z = this.zmanim(d);
        const isTishaBav = /Tish.a B.Av/i.test(fastEv.getDesc());
        const isErev = Boolean(fastEv.getFlags() & flags.EREV);
        if (isTishaBav && isErev) fast = { begins: z.sunset, beginsOnly: true };
        else if (isTishaBav) fast = { ends: z.tzeit, chatzos: z.chatzot, endsOnly: true };
        else if (!isErev) fast = { begins: z.alotHaShachar, ends: z.tzeit };
      }
      // Omer said TONIGHT (the evening of this civil date = the next Hebrew day)
      const omerTonight = HebrewCalendar.calendar({ start: hd.next(), end: hd.next(), omer: true, noHolidays: true, il: this.location.il })
        .find((ev) => ev.getFlags() & flags.OMER_COUNT)?.omer ?? null;
      out.push({
        date: d,
        heDay: hd.getDate(),
        heMonth: hd.getMonthName(),
        heDayHe: gematriya(hd.getDate()),
        monthStart: hd.getDate() === 1,
        clockChange,
        cholHamoed: chm ? chm.render(this.locale) : null,
        parsha: this.dayInfo(d).parsha ?? null, // weekly parsha on Shabbos (for the mini-calendar)
        observances,
        fast,
        omerTonight,
      });
    }
    return out;
  }

  /**
   * Build clusters (maximal runs of consecutive assur days) intersecting
   * [fromISO, toISO]. Scans a few days beyond the edges so straddling
   * clusters come back complete.
   */
  clusters(fromISO, toISO) {
    const scanFrom = addDays(fromISO, -4);
    const scanTo = addDays(toISO, 4);
    const runs = [];
    let current = null;

    for (let d = scanFrom; d <= scanTo; d = addDays(d, 1)) {
      const info = this.dayInfo(d);
      if (info.assur) {
        if (!current) current = [];
        current.push({ date: d, ...info });
      } else if (current) {
        runs.push(current);
        current = null;
      }
    }
    if (current) runs.push(current);

    return runs
      .filter((run) => run[run.length - 1].date >= fromISO && run[0].date <= toISO)
      .map((run) => this.#buildCluster(run));
  }

  #buildCluster(run) {
    const first = run[0].date;
    const last = run[run.length - 1].date;
    const erevDate = addDays(first, -1);

    const days = run.map((day, i) => {
      const weekday = this.weekday(day.date);
      const prev = i > 0 ? run[i - 1] : null;
      const next = i < run.length - 1 ? run[i + 1] : null;
      const variant = variantForDay({
        dayType: day.dayType,
        weekday,
        prevIsShabbos: prev !== null && this.weekday(prev.date) === 6,
        prevIsYomTov: prev !== null && prev.dayType !== 'shabbos',
        nextIsYomTov: next !== null && next.dayType !== 'shabbos',
        isErevPesach: day.isErevPesach,
        isCholHamoedPesach: day.cholHamoed === 'pesach',
        isCholHamoedSukkos: day.cholHamoed === 'sukkos',
        isChanukah: day.chanukah,
      });
      return {
        date: day.date,
        weekday,
        dayType: day.dayType,
        holidayLabel: day.holidayLabel,
        parsha: day.parsha ?? null,
        variant,
      };
    });

    // Boundaries: candle lighting before the first day; havdalah after the
    // last. One extra minute is always added to havdalah as a safety margin
    // in case the host clock drifts slightly — better late than early.
    const HAVDALAH_SAFETY_MS = 60_000;
    const startsAt = new Date(this.zmanim(erevDate).sunset.getTime() - this.times.candleLightingMins * 60000);
    const endsAt = new Date(this.zmanim(last).sunset.getTime() + this.times.havdalahMins * 60000 + HAVDALAH_SAFETY_MS);

    // Informational intermediate transitions (2nd-night candle lighting etc.)
    const transitions = [];
    for (let i = 1; i < run.length; i++) {
      const prevDate = run[i - 1].date;
      const isFridayNight = this.weekday(prevDate) === 5; // erev-Shabbos within cluster
      transitions.push({
        date: run[i].date,
        label: isFridayNight
          ? 'Candle lighting before shkia (from existing flame)'
          : 'Candle lighting after tzeis (from existing flame)',
        at: isFridayNight
          ? new Date(this.zmanim(prevDate).sunset.getTime() - this.times.candleLightingMins * 60000)
          : this.zmanim(prevDate).tzeit,
      });
    }

    return {
      id: `cluster-${first}`,
      erevDate,
      erevLabel: this.#erevLabel(erevDate, days[0]),
      erevShabbosLabel: this.#erevShabbosLabel(),
      erevSunset: this.zmanim(erevDate).sunset,
      startsAt,
      endsAt,
      days,
      label: [...new Set(days.map((d) => d.holidayLabel))].join(' · '),
      transitions,
    };
  }

  /**
   * Human label for the preparation day before a cluster: "Erev Shabbos",
   * "Erev Pesach", "Hoshana Rabba" (before Shmini Atzeres), "Erev Rosh
   * Hashanah", etc. Sourced from hebcal when it names the day, otherwise
   * derived from what the cluster starts with.
   */
  #erevLabel(erevDate, firstDay) {
    const hd = new HDate(civilNoon(erevDate));
    const events = HebrewCalendar.getHolidaysOnDate(hd, this.location.il) ?? [];
    // Named erev days & Hoshana Rabba come straight from hebcal, whose English
    // render spells it "Erev Rosh Hashana" — standardize to "Rosh Hashanah".
    // The first Chanukah night ("Chanukah: 1 Candle") is also EREV-flagged, but
    // it must NOT masquerade as the cluster's erev name — Erev Shabbos wins there,
    // and Chanukah shows as a normal observance instead.
    const named = events.find((ev) => (
      ((ev.getFlags() & flags.EREV) && !(ev.getFlags() & flags.CHANUKAH_CANDLES))
      || ev.getDesc().includes('Hoshana Raba')));
    if (named) return named.render(this.locale).replace(/Rosh Hashana\b/g, 'Rosh Hashanah');
    // hebcal has no named "Erev Shabbos" event, so it's built here — localized
    // to match the holiday-name style (the same locales as shabbosName above).
    if (firstDay.dayType === 'shabbos') return this.#erevShabbosLabel();
    // Fallback for an unnamed erev of a holiday: localize the "Erev" prefix too.
    const erevWord = { ashkenazi: 'Erev', en: 'Erev', he: 'עֶרֶב', 'he-x-NoNikud': 'ערב' }[this.locale] ?? 'Erev';
    return `${erevWord} ${firstDay.holidayLabel}`;
  }

  /** Localized "Erev Shabbos", matching the holiday-name style. Also exposed on
   *  the cluster so the frontend can label a Shabbos that comes in from a Friday
   *  Yom Tov (which hebcal doesn't name) without hardcoding English. */
  #erevShabbosLabel() {
    return { ashkenazi: 'Erev Shabbos', en: 'Erev Shabbat', he: 'עֶרֶב שַׁבָּת', 'he-x-NoNikud': 'ערב שבת' }[this.locale] ?? 'Erev Shabbos';
  }
}
