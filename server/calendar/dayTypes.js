/**
 * Canonical day-type keys (the schedule slots users configure) and the
 * variant vocabulary. The engine maps concrete calendar days onto these;
 * nothing here is date-specific.
 */

export const DAY_TYPES = [
  'shabbos',
  'rosh-hashanah-1', 'rosh-hashanah-2',
  'yom-kippur',
  'sukkos-1', 'sukkos-2',
  'shmini-atzeres', 'simchas-torah',
  'pesach-1', 'pesach-2', 'pesach-7', 'pesach-8',
  'shavuos-1', 'shavuos-2',
];

/**
 * Day-types that exist only in Diaspora (2-day Yom Tov) mode. Note RH is two
 * days in Israel as well, so rosh-hashanah-2 is NOT in this set.
 */
export const CHUL_ONLY_DAY_TYPES = new Set([
  'sukkos-2', 'simchas-torah', 'pesach-2', 'pesach-8', 'shavuos-2',
]);

/**
 * Map a hebcal holiday event description (ev.getDesc(), locale-independent)
 * to a day-type key, or null for events that are not assur days we schedule
 * (chol hamoed, fasts, erev-only markers, etc.).
 */
export function dayTypeFromDesc(desc) {
  if (desc.startsWith('Rosh Hashana II')) return 'rosh-hashanah-2';
  if (desc.startsWith('Rosh Hashana')) return 'rosh-hashanah-1'; // "Rosh Hashana 5786"
  switch (desc) {
    case 'Yom Kippur': return 'yom-kippur';
    case 'Sukkot I': return 'sukkos-1';
    case 'Sukkot II': return 'sukkos-2';
    case 'Shmini Atzeret': return 'shmini-atzeres';
    case 'Simchat Torah': return 'simchas-torah';
    case 'Pesach I': return 'pesach-1';
    case 'Pesach II': return 'pesach-2';
    case 'Pesach VII': return 'pesach-7';
    case 'Pesach VIII': return 'pesach-8';
    case 'Shavuot I': return 'shavuos-1';
    case 'Shavuot': return 'shavuos-1'; // Israel single-day desc
    case 'Shavuot II': return 'shavuos-2';
    default: return null;
  }
}

/**
 * Variant keys applicable to each day-type. The UI only offers variants that
 * can actually occur; the compiler picks whichever `variantForDay` returns.
 *
 * The list below is derived from the fixed-calendar weekday sets, not just
 * the Erev-Pesach example. Diaspora day-1 weekday possibilities (לא אד"ו ראש:
 * RH is never Sun/Wed/Fri; the rest follow arithmetically from RH and Pesach):
 *
 *   RH 1 / Sukkos 1 / Shmini Atzeres:  Mon Tue Thu Shabbos   (same weekday, 1/15/22 Tishrei)
 *   RH 2 / Sukkos 2 / Simchas Torah:   Tue Wed Fri Sun       (day1 + 1)
 *   Yom Kippur:                        Mon Wed Thu Shabbos   (never Fri/Sun)
 *   Pesach 1 / Pesach 8:               Sun Tue Thu Shabbos   (P8 = P1 + 7)
 *   Pesach 2 / Shavuos 1:              Mon Wed Fri Sun       (P1 + 1)
 *   Pesach 7:                          Mon Wed Fri Shabbos   (P1 − 1: Sat when P1=Sun, Fri when P1=Sat)
 *   Shavuos 2:                         Mon Tue Thu Shabbos   (Shavuos 1 + 1)
 *
 * Consequences for "erev on Shabbos" (a YT starting motzei Shabbos = day 1 on
 * Sunday): only **Pesach 1** and **Shavuos 1** can fall on Sunday. Erev RH,
 * Erev YK, Erev Sukkos and Hoshana Rabba can NEVER be Shabbos, and Pesach 7
 * on Sunday is likewise impossible (would need P1 on Monday) — so the only
 * two motzei-Shabbos starts are Pesach night (the 2025 seder case, special
 * enough for its own named Shabbos variant because of chametz/seder prep) and
 * Shavuos night (covered by the generic shabbos/leads-into-yt +
 * shavuos-1/erev-is-shabbos pair). Second days that follow a day-1-on-Shabbos
 * (e.g. Pesach 2 on Sunday) do NOT get erev-is-shabbos: the preceding Shabbos
 * is itself Yom Tov day 1, and the evening rules belong to day 1's schedule.
 */
export const VARIANTS_BY_DAY_TYPE = {
  shabbos: ['default', 'erev-pesach', 'leads-into-yt', 'follows-yt', 'chol-hamoed-pesach', 'chol-hamoed-sukkos', 'shabbos-chanukah', 'guest'],
  'rosh-hashanah-1': ['default', 'on-shabbos', 'guest'],
  'rosh-hashanah-2': ['default', 'leads-into-shabbos', 'guest'],
  'yom-kippur': ['default', 'on-shabbos', 'guest'],
  'sukkos-1': ['default', 'on-shabbos', 'guest'],
  'sukkos-2': ['default', 'leads-into-shabbos', 'guest'],
  'shmini-atzeres': ['default', 'on-shabbos', 'guest'],
  'simchas-torah': ['default', 'leads-into-shabbos', 'guest'],
  'pesach-1': ['default', 'on-shabbos', 'erev-is-shabbos', 'guest'],
  'pesach-2': ['default', 'leads-into-shabbos', 'guest'],
  'pesach-7': ['default', 'on-shabbos', 'leads-into-shabbos', 'guest'],
  'pesach-8': ['default', 'on-shabbos', 'guest'],
  'shavuos-1': ['default', 'erev-is-shabbos', 'leads-into-shabbos', 'guest'],
  'shavuos-2': ['default', 'on-shabbos', 'guest'],
};

/**
 * Decide the variant for a concrete day.
 * @param {object} day  { dayType, weekday (1=Mon..7=Sun ISO), prevIsShabbos, nextIsYomTov, prevIsYomTov, isErevPesach }
 */
export function variantForDay(day) {
  const applicable = VARIANTS_BY_DAY_TYPE[day.dayType] ?? ['default'];
  const pick = (v) => (applicable.includes(v) ? v : 'default');

  if (day.dayType === 'shabbos') {
    if (day.isErevPesach) return pick('erev-pesach');
    if (day.nextIsYomTov) return pick('leads-into-yt');
    // Chol Hamoed Shabbos overrides "follows Yom Tov": when Shabbos falls in the
    // middle days of Pesach/Sukkos it also follows the opening YT days, but the
    // Chol Hamoed situation is the more specific one and wins. (A Chol Hamoed
    // Shabbos can never *lead into* a YT — the closing YT is never on Sunday —
    // so there's no leads-into-yt conflict to resolve.)
    if (day.isCholHamoedPesach) return pick('chol-hamoed-pesach');
    if (day.isCholHamoedSukkos) return pick('chol-hamoed-sukkos');
    if (day.prevIsYomTov) return pick('follows-yt');
    // Chanukah never overlaps a Yom Tov, so a Shabbos in Chanukah is otherwise a
    // plain Shabbos — check it last, where 'default' would have been returned.
    if (day.isChanukah) return pick('shabbos-chanukah');
    return 'default';
  }
  if (day.weekday === 6) return pick('on-shabbos');          // Saturday
  if (day.prevIsShabbos) return pick('erev-is-shabbos');     // YT starting motzei Shabbos
  if (day.weekday === 5) return pick('leads-into-shabbos');  // Friday YT
  return 'default';
}
