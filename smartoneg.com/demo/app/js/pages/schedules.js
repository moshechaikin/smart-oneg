import { api } from '../api.js';
import { el, clear, mount, toast, modal, field, select, groupedSelect, pageHeader, todayISO, localISO, colorControl, rgbToHex, setNavGuard } from '../ui.js';
import { icon } from '../icons.js';
import { timelineView, clusterDayLabels, guestPreviewNote, awayPreviewNote, guestOverlayToggle } from '../components/timeline.js';
import { ZMANIM, zmanLabel } from '../zman-names.js';
import { pdfSplitButton } from '../components/pdf-buttons.js';

// Thermostat setpoints are stored in °F (canonical) but shown in the device's
// own unit, matching the Devices page and scene editor.
const tempUnit = (z) => (z?.displayUnit === 'C' ? 'C' : 'F');
const fToDisplay = (f, unit) => (unit === 'C' ? Math.round((Number(f) - 32) * 5 / 9) : Math.round(Number(f)));
const displayToF = (v, unit) => (unit === 'C' ? Math.round((Number(v) * 9) / 5 + 32) : Math.round(Number(v)));
// Friendly labels for HA thermostat modes (preset like "home"/"eco", hvac like "heat_cool")
const presetLabel = (m) => m.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
const HVAC_LABEL = { heat: 'Heat', cool: 'Cool', heat_cool: 'Heat / Cool', auto: 'Auto', off: 'Off', dry: 'Dry', fan_only: 'Fan only' };
const hvacLabel = (m) => HVAC_LABEL[m] ?? presetLabel(m);

/* ── locale-aware names (follows Settings → holiday-name style) ─────────── */

const DAY_LABELS = {
  ashkenazi: {
    shabbos: 'Shabbos', 'rosh-hashanah-1': 'Rosh Hashanah I', 'rosh-hashanah-2': 'Rosh Hashanah II',
    'yom-kippur': 'Yom Kippur', 'sukkos-1': 'Sukkos I', 'sukkos-2': 'Sukkos II',
    'shmini-atzeres': 'Shmini Atzeres', 'simchas-torah': 'Simchas Torah',
    'pesach-1': 'Pesach I', 'pesach-2': 'Pesach II', 'pesach-7': 'Pesach VII', 'pesach-8': 'Pesach VIII',
    'shavuos-1': 'Shavuos I', 'shavuos-2': 'Shavuos II',
  },
  en: {
    shabbos: 'Shabbat', 'rosh-hashanah-1': 'Rosh Hashanah I', 'rosh-hashanah-2': 'Rosh Hashanah II',
    'yom-kippur': 'Yom Kippur', 'sukkos-1': 'Sukkot I', 'sukkos-2': 'Sukkot II',
    'shmini-atzeres': 'Shemini Atzeret', 'simchas-torah': 'Simchat Torah',
    'pesach-1': 'Pesach I', 'pesach-2': 'Pesach II', 'pesach-7': 'Pesach VII', 'pesach-8': 'Pesach VIII',
    'shavuos-1': 'Shavuot I', 'shavuos-2': 'Shavuot II',
  },
  he: {
    shabbos: 'שַׁבָּת', 'rosh-hashanah-1': 'רֹאשׁ הַשָּׁנָה א׳', 'rosh-hashanah-2': 'רֹאשׁ הַשָּׁנָה ב׳',
    'yom-kippur': 'יוֹם כִּפּוּר', 'sukkos-1': 'סוּכּוֹת א׳', 'sukkos-2': 'סוּכּוֹת ב׳',
    'shmini-atzeres': 'שְׁמִינִי עֲצֶרֶת', 'simchas-torah': 'שִׂמְחַת תּוֹרָה',
    'pesach-1': 'פֶּסַח א׳', 'pesach-2': 'פֶּסַח ב׳', 'pesach-7': 'פֶּסַח ז׳', 'pesach-8': 'פֶּסַח ח׳',
    'shavuos-1': 'שָׁבוּעוֹת א׳', 'shavuos-2': 'שָׁבוּעוֹת ב׳',
  },
  'he-x-NoNikud': {
    shabbos: 'שבת', 'rosh-hashanah-1': 'ראש השנה א׳', 'rosh-hashanah-2': 'ראש השנה ב׳',
    'yom-kippur': 'יום כפור', 'sukkos-1': 'סוכות א׳', 'sukkos-2': 'סוכות ב׳',
    'shmini-atzeres': 'שמיני עצרת', 'simchas-torah': 'שמחת תורה',
    'pesach-1': 'פסח א׳', 'pesach-2': 'פסח ב׳', 'pesach-7': 'פסח ז׳', 'pesach-8': 'פסח ח׳',
    'shavuos-1': 'שבועות א׳', 'shavuos-2': 'שבועות ב׳',
  },
};

const GROUP_NAMES = {
  ashkenazi: { shabbos: 'Shabbos', rh: 'Rosh Hashanah', yk: 'Yom Kippur', sukkos: 'Sukkos', pesach: 'Pesach', shavuos: 'Shavuos' },
  en: { shabbos: 'Shabbat', rh: 'Rosh Hashanah', yk: 'Yom Kippur', sukkos: 'Sukkot', pesach: 'Pesach', shavuos: 'Shavuot' },
  he: { shabbos: 'שַׁבָּת', rh: 'רֹאשׁ הַשָּׁנָה', yk: 'יוֹם כִּפּוּר', sukkos: 'סוּכּוֹת', pesach: 'פֶּסַח', shavuos: 'שָׁבוּעוֹת' },
  'he-x-NoNikud': { shabbos: 'שבת', rh: 'ראש השנה', yk: 'יום כפור', sukkos: 'סוכות', pesach: 'פסח', shavuos: 'שבועות' },
};

/** Overview grouping: one card per holiday, with its own icon. */
const HOLIDAY_GROUPS = [
  { key: 'shabbos', holiday: null, days: ['shabbos'] },
  { key: 'rh', holiday: 'shofar', days: ['rosh-hashanah-1', 'rosh-hashanah-2'] },
  { key: 'yk', holiday: 'synagogue', days: ['yom-kippur'] },
  { key: 'sukkos', holiday: 'sukkah', days: ['sukkos-1', 'sukkos-2', 'shmini-atzeres', 'simchas-torah'] },
  { key: 'pesach', holiday: 'sederPlate', days: ['pesach-1', 'pesach-2', 'pesach-7', 'pesach-8'] },
  { key: 'shavuos', holiday: 'luchos', days: ['shavuos-1', 'shavuos-2'] },
];

/** The schedule-overview group key for a day type (e.g. 'sukkos-1' → 'sukkos'),
 *  so other pages (the Dashboard) can deep-link straight to a situation. */
export const groupKeyForDayType = (dayType) => HOLIDAY_GROUPS.find((g) => g.days.includes(dayType))?.key;

const VARIANT_LABELS = {
  default: 'Regular',
  'on-shabbos': 'Falls on Shabbos',
  'erev-is-shabbos': 'Starts motzei Shabbos',
  'leads-into-shabbos': 'Friday, into Shabbos',
  'erev-pesach': 'Erev Pesach',
  'leads-into-yt': 'Erev Shavuos',   // the only YT that can follow a plain Shabbos besides Pesach
  'follows-yt': 'After Friday Yom Tov',
  'chol-hamoed-pesach': 'Chol Hamoed Pesach',
  'chol-hamoed-sukkos': 'Chol Hamoed Sukkos',
  'shabbos-chanukah': 'Shabbos Chanukah',
  guest: 'Guest mode',
};

// Canonical ordering for pickers/lists: day-types in festival order (Shabbos, RH,
// YK, Sukkos I→II→Shmini Atzeres→Simchas Torah, Pesach I→II→VII→VIII, Shavuos),
// then within a day-type its variants (Regular first, Guest last).
const DAY_TYPE_ORDER = HOLIDAY_GROUPS.flatMap((g) => g.days);
const VARIANT_ORDER = Object.keys(VARIANT_LABELS);
const dayTypeRank = (dt) => { const i = DAY_TYPE_ORDER.indexOf(dt); return i === -1 ? 999 : i; };
const variantRank = (v) => { const i = VARIANT_ORDER.indexOf(v); return i === -1 ? 999 : i; };

const VARIANT_HELP = {
  default: 'Used whenever no special situation below applies.',
  // Base sentence for every Yom Tov that can fall on Shabbos. The erev-Shabbos
  // clause is appended at render time ONLY for day-types that actually have an
  // 'erev-is-shabbos' variant (Pesach I, Shavuos I) — for Yom Kippur, Rosh
  // Hashanah, Sukkos I, etc. the erev can never be Shabbos, so it would describe
  // a situation that can't exist. See variantHelp().
  'on-shabbos': 'This Yom Tov day lands on Shabbos itself that year.',
  'erev-is-shabbos': 'Yom Tov begins right after Shabbos ends (like the 2025 seder night). This covers the Yom Tov day and its night; the Shabbos before it has its own situation under Shabbos (“Erev Pesach” / “Erev Shavuos”), two different days of the same weekend, not duplicates.',
  'leads-into-shabbos': 'This day is a Friday, flowing straight into Shabbos, no havdalah that night. The Friday-into-Shabbos rules belong here, the Shabbos that follows runs its own situation (its “After Friday Yom Tov,” or “Chol Hamoed Pesach / Sukkos”).',
  'erev-pesach': 'This Shabbos is also Erev Pesach,   chametz and seder prep change everything. Chametz stops mid-morning (sof zman achilas chametz), so meals shift earlier and the afternoon seudah differs, schedule this Shabbos daytime on its own timing, not the regular Shabbos one. Covers the Shabbos day itself; the seder night that follows lives under Pesach I → “Starts motzei Shabbos”.',
  'leads-into-yt': 'This Shabbos is Erev Shavuos, the only other Yom Tov that can begin motzei Shabbos. Covers the Shabbos day; the Yom Tov night lives under Shavuos I → “Starts motzei Shabbos”.',
  'follows-yt': 'This Shabbos comes right after a Friday Yom Tov (Rosh Hashanah II, Sukkos II, Simchas Torah, or Pesach II on a Friday), it began with candles from an existing flame, not a normal erev. Because that preceding Friday can be any of those Yomim Tovim, these are one generic set of Friday-evening-into-Shabbos rules that fit them all; the Friday daytime itself is that Yom Tov and runs under its own situation (edit it there, not here). In the preview, the Friday daytime shows collapsed under whichever Yom Tov it is that year, and this situation’s rules show as “Erev Shabbos / Friday Night” plus the Shabbos day. Note: on the years it is also Chol Hamoed (Sukkos II→Shabbos, or Pesach II→Shabbos on a Friday), the “Chol Hamoed Sukkos/Pesach” situation takes over instead of this one.',
  'chol-hamoed-pesach': 'This Shabbos falls during Chol Hamoed Pesach (an intermediate day of the festival). With nothing set here it simply runs your Regular Shabbos; add rules only for what should differ that Shabbos. When Chol Hamoed Pesach begins right after a Friday Yom Tov, this situation OVERRIDES “After Friday Yom Tov”: any rules you set here (not there) are what run. On those years the Friday before is Pesach II (its own Yom Tov, running under its own situation), and the rules here are the generic Friday-evening-into-Shabbos set; the preview shows that Friday daytime collapsed under Pesach II, and this situation as “Erev Shabbos / Friday Night” plus the Shabbos day.',
  'chol-hamoed-sukkos': 'This Shabbos falls during Chol Hamoed Sukkos (an intermediate day of the festival). With nothing set here it simply runs your Regular Shabbos; add rules only for what should differ that Shabbos. When Chol Hamoed Sukkos begins right after a Friday Yom Tov, this situation OVERRIDES “After Friday Yom Tov”: any rules you set here (not there) are what run. On those years the Friday before is Sukkos II (its own Yom Tov, running under its own situation), and the rules here are the generic Friday-evening-into-Shabbos set; the preview shows that Friday daytime collapsed under Sukkos II, and this situation as “Erev Shabbos / Friday Night” plus the Shabbos day.',
  'shabbos-chanukah': 'This Shabbos falls during Chanukah. With nothing set here it simply runs your Regular Shabbos, add rules only for what should differ that week, e.g. earlier lights or the dining room set for guests, or a Chanukah seudah. (Some years two Shabbosos fall in Chanukah; this covers each of them.)',
  guest: 'Used only while Guest mode is ON (toggle on the Dashboard). These rules layer on top of the regular schedule, they change only the specific devices and times you set here; every other rule (and every other room) keeps running as normal. E.g. set “basement off 7:30pm” and the basement still turns on at its regular time, only that off-time changes.',
};

// Help text for a situation. 'Falls on Shabbos' gets the erev-Shabbos
// disambiguation appended only when this day-type also offers 'Starts motzei
// Shabbos' — i.e. its erev genuinely can be Shabbos (Pesach I, Shavuos I). For
// Yom Kippur, Rosh Hashanah, Sukkos I, etc. that case is impossible, so the
// clause is dropped rather than describe a situation that can't occur.
const variantHelp = (variant, variants) => {
  const base = VARIANT_HELP[variant] ?? '';
  if (variant === 'on-shabbos' && variants.includes('erev-is-shabbos')) {
    return `${base} (Not the same as the year its erev is Shabbos — that Shabbos has its own situation under Shabbos: “Erev Pesach” / “Erev Shavuos”.)`;
  }
  return base;
};

// The other half of a paired Shabbos↔Yom Tov weekend, so you can hop between the
// two situations that share one weekend with a single button (keyed dayType|variant).
const PAIR_LINK = {
  'shabbos|erev-pesach': { dayType: 'pesach-1', variant: 'erev-is-shabbos', label: 'Pesach I · Starts motzei Shabbos' },
  'shabbos|leads-into-yt': { dayType: 'shavuos-1', variant: 'erev-is-shabbos', label: 'Shavuos I · Starts motzei Shabbos' },
  'pesach-1|erev-is-shabbos': { dayType: 'shabbos', variant: 'erev-pesach', label: 'Shabbos · Erev Pesach' },
  'shavuos-1|erev-is-shabbos': { dayType: 'shabbos', variant: 'leads-into-yt', label: 'Shabbos · Erev Shavuos' },
};

// Day-types that begin their observance (candle lighting from scratch) and so
// have a real erev with prep + candle lighting. This is any day that follows a
// non-Yom-Tov day: the first day of a cluster, plus Shmini Atzeres (after
// Hoshana Rabba / Chol Hamoed) and Pesach VII (after Chol Hamoed). Second days
// of a cluster (Pesach II, Sukkos II, Simchas Torah…) light from an existing
// flame mid-cluster, no separate erev.
const HAS_EREV = new Set(['shabbos', 'rosh-hashanah-1', 'yom-kippur', 'sukkos-1', 'shmini-atzeres', 'pesach-1', 'pesach-7', 'shavuos-1']);

// The concrete weekday a Yom Tov situation pins the erev / day-itself to, shown
// after the section title ("Erev Pesach I (candle lighting) · Friday") so a
// Falls-on-Shabbos (or motzei-Shabbos) year reads unambiguously. Only for Yom
// Tov day-types, the Shabbos schedule's days are self-evidently Friday/Shabbos.
const SITUATION_WEEKDAY = {
  'on-shabbos': { erev: 'Friday', day: 'Shabbos' },          // YT day is Shabbos
  'erev-is-shabbos': { erev: 'Motzei Shabbos', day: 'Sunday' }, // YT starts Saturday night
  'leads-into-shabbos': { erev: 'Thursday', day: 'Friday' },  // Friday YT into Shabbos
  'follows-yt': { erev: 'Friday' },                          // Shabbos after a Friday YT: its erev IS that YT
  // dual-identity Shabbos days: the day itself is Shabbos AND erev of the YT
  // that starts motzei Shabbos (page already says "Shabbos", so name the other)
  'erev-pesach': { day: 'Erev Pesach' },
  'leads-into-yt': { day: 'Erev Shavuos' },
};
// When a Yom Tov starts motzei Shabbos, its "erev" (the daytime before) is
// Shabbos itself, owned by the Shabbos schedule's "Erev Pesach"/"Erev Shavuos"
// situation. So this section is NOT that erev; it's only the night the Yom Tov
// begins. Naming it "Erev <YT>" collided with the Shabbos situation and read as
// a duplicate, so name it for what it actually is.
const erevLabelFor = (dayLabel, dayType, variant) => (
  // erev-is-shabbos: the daytime-before is Shabbos (owned by the Shabbos
  // schedule). follows-yt: this Shabbos's daytime-before is a Friday Yom Tov
  // (owned by that YT). Either way the section is only the NIGHT it begins, not
  // the "erev" day, naming it "Erev <X>" collided with the other schedule.
  (variant === 'erev-is-shabbos' || variant === 'follows-yt') ? 'The night it begins'
    // Shabbos erev is ALWAYS Friday, and this section owns Friday night into
    // Shabbos too, not just the daytime, so name the night explicitly (and match
    // the timeline's own "Erev Shabbos / Friday Night" label). A Yom Tov erev's
    // night falls on a different weekday each year, so it stays day-agnostic
    // ("candle lighting", which already reads as the evening).
    : dayType === 'shabbos' ? `Erev ${dayLabel} / Friday Night`
      : `Erev ${dayLabel} (candle lighting)`);

/**
 * A page title that doubles as a jump menu: the title text with a chevron that
 * opens a small dropdown of sibling options. `options` is [{ key, label }];
 * picking a different key calls onPick(key). Falls back to a plain title when
 * there's only one option. Used for the day editor (jump between a festival's
 * days) and the festival overview (jump between festivals).
 */
function headerSwitcher(currentKey, options, onPick) {
  const label = options.find((o) => o.key === currentKey)?.label ?? '';
  if (options.length <= 1) {
    return el('h1', { class: 'text-xl sm:text-2xl font-semibold tracking-tight truncate flex-1 min-w-0' }, label);
  }
  const menu = el('div', {
    class: 'hidden absolute left-0 top-full mt-1 z-50 min-w-[13rem] max-h-72 overflow-auto rounded-xl border '
      + 'border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 shadow-lg py-1',
  }, ...options.map((o) => el('button', {
    class: 'block w-full text-left px-3.5 py-2 text-[15px] hover:bg-stone-100 dark:hover:bg-stone-800 '
      + (o.key === currentKey ? 'font-semibold text-accent-600 dark:text-accent-400' : 'text-stone-700 dark:text-stone-200'),
    onclick: (e) => { e.stopPropagation(); close(); if (o.key !== currentKey) onPick(o.key); },
  }, o.label)));
  let open = false;
  const onDoc = (e) => { if (!wrap.contains(e.target)) close(); };
  const close = () => { if (!open) return; open = false; menu.classList.add('hidden'); document.removeEventListener('click', onDoc); };
  const btn = el('button', {
    class: 'text-xl sm:text-2xl font-semibold tracking-tight inline-flex items-center gap-1.5 min-w-0 max-w-full '
      + 'hover:text-accent-600 dark:hover:text-accent-400 transition-colors',
    title: 'Jump to another', 'aria-haspopup': 'true',
    onclick: (e) => {
      e.stopPropagation();
      if (open) { close(); return; }
      open = true; menu.classList.remove('hidden');
      setTimeout(() => document.addEventListener('click', onDoc));
    },
  }, el('span', { class: 'truncate' }, label), icon('chevronDown', 'w-5 h-5 shrink-0 opacity-60'));
  const wrap = el('div', { class: 'relative flex-1 min-w-0' }, btn, menu);
  return wrap;
}

// Printable-zmanim PDF block shown under a holiday overview's mini-calendar.
const PDF_FESTIVALS = { pesach: 'pesach', sukkos: 'sukkos', shavuos: 'shavuos', rh: 'rosh-hashanah', yk: 'yom-kippur' };
function zmanimPdfBlock(groupKey) {
  const fest = PDF_FESTIVALS[groupKey];
  const wrap = (title, desc, viewHref) => el('div', { class: 'mt-5 pt-4 border-t border-stone-100 dark:border-stone-800' },
    el('div', { class: 'flex items-center gap-2 font-semibold text-[15px] mb-1' }, icon('book', 'w-4 h-4 text-accent-600 dark:text-accent-400'), title),
    el('p', { class: 'hint mb-3' }, desc),
    el('div', { class: 'flex flex-wrap gap-2.5' }, pdfSplitButton('View PDF', viewHref)));
  if (fest) {
    return el('div', {},
      wrap('Printable Zmanim',
        'A one-page, print-ready sheet of every zman for this Yom Tov (computed for your location).',
        `/api/pdf/yomtov/${fest}`),
      // Pesach starts the Omer, offer the counting chart as its own download
      groupKey === 'pesach' && wrap('Sefiras HaOmer chart',
        'A one-page counting chart for all 49 nights.',
        '/api/pdf/omer'));
  }
  if (groupKey === 'shabbos') {
    return wrap('Printable Shabbos zmanim',
      'Candle lighting, shkia and havdalah for every Shabbos of the coming year (multi-page), starting today (computed for your location).',
      `/api/pdf/shabbos-year?from=${todayISO()}`);
  }
  return false;
}

let state = { view: 'overview', dayType: 'shabbos', variant: 'default' };
// While a day editor with possible edits is on screen: { isDirty, confirmLeave }
let editorGuard = null;
let lastContainer = null;
// set when a confirmed discard/save should let the NEXT browser-back through
let bypassEditorGuard = false;

/** Navigate between schedules sub-views with a history entry, so the browser
 *  back button walks main → overview → day editor like real pages. */
function go(newState) {
  state = newState;
  history.pushState({ schedules: newState }, '', location.hash);
  if (lastContainer?.isConnected) render(lastContainer);
}
window.addEventListener('popstate', (e) => {
  if (!location.hash.startsWith('#/schedules')) return;
  if (!lastContainer?.isConnected) return;
  // Browser back/forward out of a dirty editor must prompt too — in-app nav
  // already does, but a same-hash popstate used to slip past. Re-push the
  // editor entry so we stay put, prompt, and on discard/save replay the back so
  // it actually lands on the target.
  if (!bypassEditorGuard && editorGuard?.isDirty()) {
    history.pushState({ schedules: state }, '', location.hash);
    editorGuard.confirmLeave(() => { bypassEditorGuard = true; history.back(); });
    return;
  }
  bypassEditorGuard = false;
  state = e.state?.schedules ?? { view: 'overview' };
  editorGuard = null;
  render(lastContainer);
});

export async function schedulesPage() {
  // arriving from the router (tab press / fresh navigation) always lands on
  // the main overview, not whatever sub-view was open last — unless the
  // Dashboard handed off a specific holiday to open (its overview + mini calendar)
  state = { view: 'overview' };
  const openGroup = sessionStorage.getItem('schedules-open-group');
  if (openGroup) {
    sessionStorage.removeItem('schedules-open-group');
    if (HOLIDAY_GROUPS.some((g) => g.key === openGroup)) state = { view: 'holiday', groupKey: openGroup };
  }
  // Deep-link into a specific day + situation editor (from the Calendar cluster
  // modal). Invalid handoffs fall through to the overview via render()'s guards.
  const openEdit = sessionStorage.getItem('schedules-open-edit');
  if (openEdit) {
    sessionStorage.removeItem('schedules-open-edit');
    try {
      const { dayType, variant } = JSON.parse(openEdit);
      if (dayType) state = { view: 'edit', dayType, variant: variant || 'default', from: 'overview' };
    } catch { /* malformed handoff — keep default state */ }
  }
  editorGuard = null;
  const container = el('div', { class: 'space-y-5' });
  lastContainer = container;
  await render(container);
  return container;
}

/**
 * Pressing the Schedules tab while already on the page returns to the main
 * overview, via the unsaved-changes prompt when a dirty editor is open.
 */
export function schedulesNavReset() {
  const reset = () => {
    state = { view: 'overview' };
    editorGuard = null;
    if (lastContainer?.isConnected) render(lastContainer);
  };
  if (editorGuard?.isDirty()) editorGuard.confirmLeave(reset);
  else reset();
}

async function render(container) {
  const [meta, schedules, zones, scenes, settings, allClusters] = await Promise.all([
    api.get('/api/schedules/meta'), api.get('/api/schedules'), api.get('/api/zones'), api.get('/api/scenes'),
    api.get('/api/settings'),
    api.get(`/api/calendar?from=${todayISO()}&to=${localISO(new Date(Date.now() + 500 * 86400000))}`).catch(() => []),
  ]);
  // Match the dashboard: an occurrence stops being "next" the moment its
  // havdalah passes, not at midnight. The calendar starts at today's date, so
  // without this a just-ended Shabbos would stay listed as next until 00:00.
  const upcoming = allClusters.filter((c) => new Date(c.endsAt).getTime() > Date.now());
  const locale = settings.display?.locale ?? 'ashkenazi';
  const dayLabel = (dt) => DAY_LABELS[locale]?.[dt] ?? DAY_LABELS.ashkenazi[dt] ?? dt;
  const groupName = (key) => GROUP_NAMES[locale]?.[key] ?? GROUP_NAMES.ashkenazi[key];
  const ctx = { meta, schedules, zones, scenes, upcoming, container, dayLabel, groupName, guestOn: Boolean(settings.guestMode?.enabled), awayMode: settings.awayMode };
  // only an open editor can hold unsaved changes; keep the GLOBAL nav guard in
  // sync so leaving via ANY nav item (Devices, etc.) prompts — not just the
  // Schedules tab (which is special-cased via schedulesNavReset)
  if (state.view !== 'edit') { editorGuard = null; setNavGuard(null); }
  // leaving the day editor: drop its scroll listener + stuck state so the
  // overview's own sticky bar isn't affected
  if (state.view !== 'edit' && container._editorScroll) {
    window.removeEventListener('scroll', container._editorScroll);
    container._editorScroll = null;
    container.classList.remove('is-editor-stuck');
  }
  const scrollYBefore = window.scrollY;
  if (state.view === 'edit' && meta.dayTypes.includes(state.dayType)) renderEditor(ctx);
  else if (state.view === 'holiday' && HOLIDAY_GROUPS.some((g) => g.key === state.groupKey)) renderHolidayOverview(ctx);
  else renderOverview(ctx);
  // opening a DIFFERENT sub-page starts at the top; re-rendering the same one
  // (saving, duplicating, deleting a rule) keeps the user's place
  const viewKey = `${state.view}:${state.dayType ?? ''}:${state.variant ?? ''}:${state.groupKey ?? ''}`;
  if (viewKey !== lastViewKey) window.scrollTo({ top: 0 });
  else window.scrollTo({ top: scrollYBefore });
  lastViewKey = viewKey;
}
let lastViewKey = null;

/* ── Yom Tov overview: mini calendar + zmanim + its days + full timeline ──── */

async function renderHolidayOverview(ctx) {
  const { meta, schedules, upcoming, container, dayLabel, groupName, guestOn } = ctx;
  const g = HOLIDAY_GROUPS.find((gg) => gg.key === state.groupKey);
  const days = g.days.filter((d) => meta.dayTypes.includes(d));
  const ruleCount = (dayType) => Object.values(schedules[dayType] ?? {}).reduce((n, s) => n + (s?.rules?.length ?? 0), 0);
  // A situation counts as configured if it has its own rules, starts from
  // Regular, or crossed some Regular rules out — same rule as the main overview.
  const configuredVariants = (dayType) => Object.entries(schedules[dayType] ?? {})
    .filter(([v, s]) => v !== 'default' && (s?.rules?.length || s?.inheritsRegular || s?.removedIds?.length))
    .map(([v]) => v);

  // Gather the clusters of the NEXT single occurrence only. A festival like
  // Sukkos spans two clusters (Sukkos I-II, then Shmini Atzeres/Simchas Torah
  // with Chol Hamoed between), but weekly Shabbos / yearly RH must not pull in
  // the following occurrence. Start at the first cluster with a group day, then
  // keep adding adjacent clusters until every group day-type is covered.
  const clusters = [];
  const firstIdx = upcoming.findIndex((c) => c.days.some((d) => days.includes(d.dayType)));
  if (firstIdx >= 0) {
    clusters.push(upcoming[firstIdx]);
    const seen = new Set(upcoming[firstIdx].days.map((d) => d.dayType).filter((dt) => days.includes(dt)));
    for (let i = firstIdx + 1; i < upcoming.length && seen.size < days.length; i++) {
      const c = upcoming[i];
      const fresh = c.days.filter((d) => days.includes(d.dayType) && !seen.has(d.dayType));
      const gapDays = (new Date(c.startsAt) - new Date(clusters[clusters.length - 1].endsAt)) / 86400000;
      if (fresh.length && gapDays < 15) { clusters.push(c); for (const d of fresh) seen.add(d.dayType); }
      else break;
    }
  }
  const first = clusters[0];
  const last = clusters[clusters.length - 1];

  // Hebrew dates for the mini-calendar's span (padded to whole weeks), like the
  // full calendar page.
  let heByDate = new Map();
  if (first) {
    const lastDate = last.days[last.days.length - 1].date;
    const heFrom = localISO(new Date(new Date(`${first.erevDate}T12:00`).getTime() - 7 * 86400000));
    const heTo = localISO(new Date(new Date(`${lastDate}T12:00`).getTime() + 7 * 86400000));
    const heDates = await api.get(`/api/hebrew-dates?from=${heFrom}&to=${heTo}`).catch(() => []);
    heByDate = new Map(heDates.map((h) => [h.date, h]));
  }

  mount(clear(container),
    // same sticky title bar as the day editor, so navigation is consistent
    el('div', {
      class: 'sticky-below-header z-20 -mx-4 sm:-mx-6 lg:-mx-10 -mt-5 sm:-mt-6 lg:-mt-7 px-4 sm:px-6 lg:px-10 py-2.5 lg:pt-7 mb-4 '
        + 'flex items-center gap-2 sm:gap-3 bg-stone-100/85 dark:bg-stone-950/85 backdrop-blur border-b border-stone-200/80 dark:border-stone-800/80',
    },
      el('button', {
        class: 'btn-ghost btn-sm shrink-0 !px-2', 'aria-label': 'Back',
        onclick: () => go({ view: 'overview' }),
      }, icon('chevronLeft', 'w-5 h-5'), 'Back'),
      // title doubles as a jump menu between festivals
      headerSwitcher(g.key,
        HOLIDAY_GROUPS.filter((gg) => gg.days.some((d) => meta.dayTypes.includes(d))).map((gg) => ({ key: gg.key, label: groupName(gg.key) })),
        (key) => go({ view: 'holiday', groupKey: key }))),

    first
      ? el('div', { class: 'card' },
        el('div', { class: 'section-title !mb-3' },
          `Next: ${holidaySpanLabel(first.days[0].date, last.days[last.days.length - 1].date)}`),
        // mini calendar of the whole holiday span (its clusters + chol hamoed between)
        holidayMiniCalendar(clusters, first.erevDate, last.days[last.days.length - 1].date, heByDate,
          (day) => go({ view: 'edit', dayType: day.dayType, variant: day.variant ?? 'default', from: 'holiday', groupKey: g.key })),
        // "First/Final" only make sense for a multi-day span; a single day
        // (Yom Kippur, a lone Shabbos) just says "Candle lighting"/"Havdalah".
        (() => {
          const singleDay = clusters.length === 1 && first.days.length === 1;
          return el('div', { class: 'grid sm:grid-cols-3 gap-3 text-[15px] mt-4' },
            zmanRow('candle', first.erevLabel ?? (singleDay ? 'Candle lighting' : 'First candle lighting'), first.startsAt),
            zmanRow('sunset', singleDay ? 'Shkia (sunset)' : 'First shkia (sunset)', first.erevSunset),
            zmanRow('kiddush', singleDay ? 'Havdalah' : 'Final havdalah', last.endsAt));
        })(),
        zmanimPdfBlock(g.key))
      : el('p', { class: 'hint' }, 'No upcoming occurrence found in the next 16 months.'),

    // each day → its editor
    el('div', { class: 'card' },
      el('div', { class: 'section-title !mb-2' }, icon('clock'), 'Days'),
      el('p', { class: 'hint mb-3' }, 'Click on a day to edit its schedule.'),
      el('div', { class: 'divide-y divide-stone-100 dark:divide-stone-800' },
        days.map((dayType) => {
          const n = ruleCount(dayType);
          const variants = configuredVariants(dayType);
          const hasGuest = variants.includes('guest');
          const otherVariants = variants.filter((v) => v !== 'guest').length;
          return el('button', {
            class: 'w-full text-left py-3 flex items-center gap-3 group',
            onclick: () => go({ view: 'edit', dayType, variant: 'default', from: 'holiday', groupKey: g.key }),
          },
            // edit affordance to the left of each day (tooltip sits on it, not the whole row)
            el('span', {
              class: 'flex items-center justify-center w-8 h-8 shrink-0 rounded-lg text-stone-400 '
                + 'bg-stone-100 dark:bg-stone-800 group-hover:bg-accent-100 group-hover:text-accent-600 '
                + 'dark:group-hover:bg-accent-600/20 dark:group-hover:text-accent-400 transition-colors',
              title: `Edit ${dayLabel(dayType)}`,
            }, icon('pencil', 'w-4 h-4')),
            el('div', {},
              // chevron sits right beside the day name, not stranded at the
              // far edge of a wide card
              el('div', { class: 'font-medium text-[15px] group-hover:text-accent-700 dark:group-hover:text-accent-400 transition-colors flex items-center gap-1' },
                dayLabel(dayType),
                el('span', { class: 'text-stone-300 dark:text-stone-600 group-hover:text-accent-500 transition-colors' }, icon('chevronRight', 'w-4.5 h-4.5'))),
              el('div', { class: 'hint' }, n === 0 ? 'No rules yet' : `${n} rule${n === 1 ? '' : 's'}`)),
            hasGuest && el('span', { class: `badge-info shrink-0 ${guestOn ? '!bg-sky-600 !text-white' : ''}` }, 'Guest'),
            otherVariants > 0
              && el('span', { class: 'badge-info shrink-0' }, `+${otherVariants} variant${otherVariants === 1 ? '' : 's'}`));
        }))),

    // whole-holiday timeline preview (each cluster in the span)
    clusters.length > 0 && holidayTimeline(ctx, clusters, groupName(g.key)),
  );
}

function zmanRow(ic, label, time) {
  return time ? el('div', { class: 'flex items-center gap-2' },
    icon(ic, 'w-4 h-4 text-accent-500 shrink-0'),
    el('span', { class: 'text-stone-500 dark:text-stone-400' }, label),
    el('b', {}, new Date(time).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' }))) : null;
}

/** The civil date an observance beginning on `dayISO` actually starts on: the
 * evening before it (candle lighting / shkia). Every Shabbos / Yom Tov day
 * begins the previous night, so that's the date users think of as its start. */
function eveBeforeISO(dayISO) {
  return localISO(new Date(new Date(`${dayISO}T12:00`).getTime() - 86400000));
}

/** "Sep 11 (evening) – Sep 13, 2026": from the evening the observance begins
 * (the erev, night before the first day) through its final day. */
function holidaySpanLabel(firstDayISO, endISO) {
  const s = new Date(`${eveBeforeISO(firstDayISO)}T12:00`);
  const e = new Date(`${endISO}T12:00`);
  const startLabel = `${s.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} (evening)`;
  const endLabel = e.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  return `${startLabel} – ${endLabel}`;
}

/**
 * Compact calendar covering a whole holiday's date span: erev (candle lighting
 * + shkia), each assur day (label + havdalah on cluster ends + mid-cluster
 * candle lighting), and Chol Hamoed days between clusters (Sukkos/Pesach).
 * Padded to whole weeks (Sun–Shabbos), with taller cells like the main calendar.
 */
function holidayMiniCalendar(clusters, startISO, endISO, heByDate = new Map(), onDayClick = null) {
  const assur = new Map();       // date -> holidayLabel
  const dayByDate = new Map();   // date -> the compiled day { dayType, variant, ... }
  const erevInfo = new Map();    // erevDate -> { candle, shkia }
  const erevOwner = new Map();   // erevDate -> the day it's the erev of (owns its erev rules)
  const havdalah = new Map();    // last day of each cluster -> time
  // NB: intermediate "from existing flame" candle-lightings are intentionally
  // omitted here, they physically happen the night before and would sit
  // confusingly next to havdalah on the same cell. They live in the detailed
  // calendar-page cluster view instead.
  for (const c of clusters) {
    for (const d of c.days) { assur.set(d.date, d.holidayLabel); dayByDate.set(d.date, d); }
    erevInfo.set(c.erevDate, { candle: c.startsAt, shkia: c.erevSunset });
    erevOwner.set(c.erevDate, c.days[0]); // the erev's rules live in the first day's editor
    havdalah.set(c.days[c.days.length - 1].date, c.endsAt);
  }
  const parse = (i) => { const [y, m, d] = i.split('-').map(Number); return new Date(y, m - 1, d); };
  const gridStart = parse(startISO); gridStart.setDate(gridStart.getDate() - gridStart.getDay());
  const gridEnd = parse(endISO); gridEnd.setDate(gridEnd.getDate() + (6 - gridEnd.getDay()));

  const timeRow = (ic, time, cls = 'text-accent-700/90 dark:text-accent-400/90') => el('div', {
    class: `flex items-center gap-1 text-[10px] leading-tight ${cls}`,
  }, icon(ic, 'w-3 h-3 shrink-0'), new Date(time).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }));

  const cells = [];
  for (let dt = new Date(gridStart); dt <= gridEnd; dt.setDate(dt.getDate() + 1)) {
    const d = localISO(dt);
    const inSpan = d >= startISO && d <= endISO;
    const label = assur.get(d);
    const erev = erevInfo.get(d);
    const chol = inSpan && !label && !erev;
    let cls = 'border-transparent text-stone-300 dark:text-stone-700';
    if (label) cls = 'bg-accent-100/70 border-accent-300 text-accent-800 dark:bg-accent-600/15 dark:border-accent-600/40 dark:text-accent-300';
    else if (erev) cls = 'bg-accent-50 border-accent-200 border-dashed text-accent-700 dark:bg-accent-600/[0.07] dark:border-accent-600/40 dark:text-accent-400';
    else if (chol) cls = 'bg-stone-100 border-stone-200 text-stone-500 dark:bg-stone-800/60 dark:border-stone-700 dark:text-stone-400';
    else if (inSpan) cls = 'border-stone-200 dark:border-stone-800 text-stone-500';
    const isToday = d === todayISO(); // highlight today, like the full calendar
    // Hoshanah Rabbah is BOTH the last Chol Hamoed day and Erev Shmini Atzeres
    //, name it, don't just say "Erev"
    const hrName = heByDate.get(d)?.cholHamoed && /hoshana/i.test(heByDate.get(d).cholHamoed) ? 'Hoshanah Rabbah' : null;
    // Yom Tov / Shabbos days jump to that day's editor (for the situation that
    // applies this year); an erev jumps to the day it belongs to, its erev
    // rules live in that same day's editor (the "Erev …" section).
    const targetDay = dayByDate.get(d) ?? (erev ? erevOwner.get(d) : null);
    const clickable = Boolean(onDayClick && targetDay && (label || erev));
    cells.push(el('div', {
      // overflow-hidden + min-w-0 so long day labels (Simchas Torah, Shmini
      // Atzeres, Chol Hamoed) wrap/clip inside the narrow cell instead of
      // spilling across neighbors on a zoomed phone
      class: `rounded-lg border p-1.5 min-h-14 sm:min-h-24 flex flex-col overflow-hidden min-w-0 ${cls} ${isToday ? 'ring-2 ring-accent-500' : ''}`
        + (clickable ? ' cursor-pointer hover:border-accent-400 dark:hover:border-accent-500 hover:shadow-sm transition-all' : ''),
      title: clickable
        ? (label ? `Edit ${label} rules` : `Edit ${targetDay.holidayLabel} rules (erev)`)
        : (label || (erev ? (hrName ? `Erev · ${hrName}` : 'Erev') : (chol ? 'Chol Hamoed' : ''))),
      ...(clickable ? {
        role: 'button', tabindex: '0',
        onclick: () => onDayClick(targetDay),
        onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onDayClick(targetDay); } },
      } : {}),
    },
      el('div', { class: 'text-[12px] font-semibold flex items-center justify-between gap-1' },
        el('span', { class: 'flex items-baseline gap-1' },
          String(dt.getDate()),
          heByDate.get(d) && el('span', {
            class: `text-[10px] font-normal ${heByDate.get(d).monthStart ? 'font-semibold text-accent-600 dark:text-accent-400' : 'opacity-70'}`,
            dir: 'rtl', title: heByDate.get(d).monthStart ? `Rosh Chodesh ${heByDate.get(d).heMonth}` : `${heByDate.get(d).heDay} ${heByDate.get(d).heMonth}`,
          }, heByDate.get(d).monthStart ? `${heByDate.get(d).heDayHe} ${heByDate.get(d).heMonth}` : heByDate.get(d).heDayHe)),
        havdalah.has(d) ? icon('kiddush', 'w-3.5 h-3.5') : (erev ? icon('candle', 'w-3.5 h-3.5') : '')),
      label && el('div', { class: 'text-[11px] leading-tight mt-0.5 font-medium break-words' }, label),
      !label && hrName && el('div', { class: 'text-[11px] leading-tight mt-0.5 font-medium break-words' }, hrName),
      chol && el('div', { class: 'text-[11px] leading-tight mt-0.5 break-words' }, 'Chol Hamoed'),
      // parsha + observances (Rosh Chodesh, fasts…) like the full calendar page —
      // hidden on phones where the cells are too small to fit them
      heByDate.get(d)?.parsha && el('div', { class: 'text-[10px] leading-tight mt-0.5 font-medium text-teal-700 dark:text-teal-400 hidden sm:block truncate' }, heByDate.get(d).parsha),
      heByDate.get(d)?.observances?.length > 0 && el('div', { class: 'text-[10px] leading-tight mt-0.5 text-teal-700 dark:text-teal-400 hidden sm:block' }, heByDate.get(d).observances.join(' · ')),
      // times pinned to the bottom of the cell, hidden on phones, where a
      // ~30px cell can't fit them (they spill across neighboring cells); the
      // candle/kiddush icon still marks the day and the zman rows below the
      // mini-calendar carry the times
      el('div', { class: 'mt-auto space-y-0.5 pt-1 hidden sm:block' },
        erev && timeRow('candle', erev.candle),
        erev && erev.shkia && timeRow('sunset', erev.shkia, 'text-stone-500 dark:text-stone-400'),
        havdalah.has(d) && timeRow('kiddush', havdalah.get(d)))));
  }

  return el('div', {},
    el('div', { class: 'grid grid-cols-7 gap-1 text-center text-[11px] font-semibold text-stone-400 mb-1' },
      ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Shab'].map((d) => el('div', {}, d))),
    el('div', { class: 'grid grid-cols-7 gap-1 week-strip' }, cells));
}

function holidayTimeline(ctx, clusters, name) {
  const { zones, scenes, guestOn } = ctx;
  const box = el('div', { class: 'card' }, el('p', { class: 'hint' }, 'Computing the full timeline…'));
  // Overlay the guest rules on the whole festival's timeline. Defaults to the
  // live guest state; the toggle only shows when guest rules apply somewhere here.
  const cache = {};
  let showGuest = guestOn;
  const load = async () => {
    const key = String(showGuest);
    let results = cache[key];
    if (!results) {
      results = await Promise.all(clusters.map((c) =>
        api.get(`/api/timeline?date=${c.days[0].date}&guest=${showGuest ? '1' : '0'}`).then((tl) => ({ tl, c }))));
      cache[key] = results;
    }
    const sections = results.filter((r) => r.tl.actions.length > 0);
    const guestAvailable = results.some((r) => r.tl.guestAvailable);
    const hasGuest = sections.some((r) => r.tl.actions.some((a) => a.source?.guest));
    mount(clear(box),
      el('div', { class: 'flex items-center gap-3 mb-2 flex-wrap' },
        el('div', { class: 'section-title !mb-0' }, icon('eye'), 'Full timeline preview'),
        guestAvailable && guestOverlayToggle(showGuest, () => { showGuest = !showGuest; load(); })),
      el('p', { class: 'hint mb-4' }, `Everything scheduled across ${name}, resolved for its next occurrence.`),
      showGuest && hasGuest && guestPreviewNote({ forced: !guestOn }),
      sections.length === 0
        ? el('p', { class: 'hint' }, 'Nothing scheduled yet. Add rules to the days above.')
        : sections.map(({ tl, c }, i) => timelineView(tl.actions, { zones, scenes, dayLabels: clusterDayLabels(c), stacked: i > 0, stickyHeaders: 'sticky-below-editorbar z-10' })));
  };
  load().catch((err) => mount(clear(box), el('p', { class: 'text-rose-600' }, `Preview failed: ${err.message}`)));
  return box;
}

/* ── overview: one card per holiday with a schedule outline ─────────────── */

function renderOverview({ meta, schedules, upcoming, container, dayLabel, groupName, guestOn }) {
  const nextDateFor = (days) => upcoming.flatMap((c) => c.days).find((d) => days.includes(d.dayType))?.date;
  const ruleCount = (dayType) => Object.values(schedules[dayType] ?? {}).reduce((n, s) => n + (s?.rules?.length ?? 0), 0);
  // A situation counts as set up if it has its own rules, OR it starts from
  // Regular (inheritsRegular), OR it disabled some Regular rules (removedIds) —
  // a "start from Regular and cross a few out" situation has no own rules but is
  // very much configured, so rules-only counting under-counted the pill.
  const configuredVariants = (dayType) => Object.entries(schedules[dayType] ?? {})
    .filter(([v, s]) => v !== 'default' && (s?.rules?.length || s?.inheritsRegular || s?.removedIds?.length))
    .map(([v]) => v);

  mount(clear(container),
    pageHeader('Schedules'),
    el('p', { class: 'hint max-w-2xl -mt-2' },
      'Each holiday below holds a schedule per day (including its erev) plus special variants for years when days collide with Shabbos.',
      guestOn && el('b', { class: 'text-sky-600 dark:text-sky-400' }, ' Guest mode is ON, days with a Guest schedule use it.')),
    el('div', { class: 'stagger grid md:grid-cols-2 gap-4' },
      HOLIDAY_GROUPS.filter((g) => g.days.some((d) => meta.dayTypes.includes(d))).map((g) => {
        const next = nextDateFor(g.days);
        // min-w-0: without it the truncated rule-summary line's full nowrap
        // width propagates into the grid track and the page overflows on phones
        const openOverview = () => go({ view: 'holiday', groupKey: g.key });
        return el('div', { class: 'card !p-5 min-w-0' },
          // View sits in the top-right corner, aligned to the title's top line
          // (items-start), with the date on its own line just below the title.
          el('div', { class: 'flex items-start justify-between gap-2.5 mb-1' },
            el('h2', {
              class: 'text-xl lg:text-2xl font-semibold min-w-0 leading-tight cursor-pointer hover:text-accent-700 dark:hover:text-accent-400 transition-colors',
              onclick: openOverview, title: `View ${groupName(g.key)} overview`,
            }, groupName(g.key)),
            el('button', {
              class: 'btn-secondary btn-sm shrink-0', title: `View ${groupName(g.key)} overview`,
              onclick: () => go({ view: 'holiday', groupKey: g.key }),
            }, icon('eye', 'w-4 h-4'), 'View')),
          next && el('div', { class: 'text-sm text-stone-500 dark:text-stone-400 mb-1' },
            `Next: ${new Date(`${eveBeforeISO(next)}T12:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })} (evening)`),
          el('div', { class: 'divide-y divide-stone-100 dark:divide-stone-800' },
            g.days.filter((d) => meta.dayTypes.includes(d)).map((dayType) => {
              const n = ruleCount(dayType);
              const variants = configuredVariants(dayType);
              const hasGuest = variants.includes('guest');
              return el('button', {
                class: 'w-full text-left py-3 flex items-center gap-3 group',
                onclick: () => go({ view: 'edit', dayType, variant: 'default', from: 'overview' }),
              },
                el('div', { class: 'flex-1 min-w-0' },
                  el('div', { class: 'font-medium text-[15px] group-hover:text-accent-700 dark:group-hover:text-accent-400 transition-colors' },
                    dayLabel(dayType)),
                  el('div', { class: 'hint truncate' },
                    n === 0 ? 'No rules yet' : `${n} rule${n === 1 ? '' : 's'}`)),
                hasGuest && el('span', { class: `badge-info shrink-0 ${guestOn ? '!bg-sky-600 !text-white' : ''}` }, 'Guest'),
                variants.filter((v) => v !== 'guest').length > 0
                  && el('span', { class: 'badge-info shrink-0' }, `+${variants.filter((v) => v !== 'guest').length} variant${variants.filter((v) => v !== 'guest').length === 1 ? '' : 's'}`),
                el('span', { class: 'text-stone-300 dark:text-stone-600 group-hover:text-accent-500 transition-colors shrink-0' },
                  icon('chevronRight', 'w-5 h-5')));
            })));
      })),
  );
}

/* ── day editor: variant chips + erev / day sections ────────────────────── */

function renderEditor(ctx) {
  const { meta, schedules, zones, scenes, upcoming, container, dayLabel, guestOn, awayMode } = ctx;
  const variants = meta.variants[state.dayType] ?? ['default'];
  if (!variants.includes(state.variant)) state.variant = 'default';
  const sched = schedules[state.dayType]?.[state.variant];
  const rules = structuredClone(sched?.rules ?? []);
  touchedRuleId = null; // fresh editor: nothing touched yet (drop any stale id from another situation)
  // approved inheritance model: non-Regular situations can layer on Regular.
  // Never-saved situations default to inheriting; saved ones keep their flag.
  const isInheritable = state.variant !== 'default' && state.variant !== 'guest';
  const inh = {
    // Off by default: a new situation starts empty; the user opts IN to
    // starting from the Regular schedule. Saved situations keep their flag.
    on: isInheritable && Boolean(sched?.inheritsRegular),
    removedIds: structuredClone(sched?.removedIds ?? []),
  };
  const regularRules = () => schedules[state.dayType]?.default?.rules ?? [];

  // The concrete weekday this situation pins the erev/day to. Rendered as a
  // lighter "· <day>" after the section title, wrapping naturally on mobile.
  // Keyed by variant, which is unambiguous across day-types (only follows-yt
  // is a Shabbos variant, and it just adds the Friday erev suffix).
  const wk = SITUATION_WEEKDAY[state.variant];
  const titleWithDay = (base, weekday) => (weekday
    ? el('span', { class: 'inline' }, base,
      el('span', { class: 'font-normal text-stone-500 dark:text-stone-400' }, ` · ${weekday}`))
    : base);

  // A day runs the Regular (default) schedule whenever its own situation has no
  // rules and doesn't inherit Regular, mirrors the compiler's fallback. So the
  // Regular preview's "next occurrence" is the next day that resolves to default
  // (its own default day, or a special variant left unconfigured, the cascade).
  const usesDefaultFallback = (dayType, dayVariant) => {
    if (dayVariant === 'default') return true;
    const s = schedules[dayType]?.[dayVariant];
    return !s?.rules?.length && !s?.inheritsRegular;
  };
  const nextOccurrence = (dayType, variant) => upcoming.flatMap((c) => c.days).find((d) => {
    if (d.dayType !== dayType) return false;
    if (variant === 'guest') return true;
    if (variant === 'default') return usesDefaultFallback(dayType, d.variant);
    return d.variant === variant;
  });

  const hasErev = HAS_EREV.has(state.dayType);
  const rerender = () => render(container);
  const pristine = JSON.stringify({ rules, on: inh.on, removed: inh.removedIds }); // to detect unsaved edits on back
  const isDirty = () => JSON.stringify({
    rules: sortRulesByTime(syncConditionDays(structuredClone(rules))), on: inh.on, removed: inh.removedIds,
  }) !== JSON.stringify({
    rules: sortRulesByTime(syncConditionDays(structuredClone(JSON.parse(pristine).rules))), on: JSON.parse(pristine).on, removed: JSON.parse(pristine).removed,
  });
  // return to wherever we came from: the Yom Tov overview or the main list
  const backState = state.from === 'holiday' && state.groupKey
    ? { view: 'holiday', groupKey: state.groupKey }
    : { view: 'overview' };
  const confirmLeave = (leave) => {
    if (!isDirty()) { leave(); return; }
    const dlg = modal({
      title: 'Unsaved changes',
      body: el('div', { class: 'space-y-4' },
        el('p', { class: 'text-[15px]' }, 'You have unsaved changes to this schedule. What would you like to do?'),
        el('button', {
          class: 'btn-secondary w-full !text-rose-600 dark:!text-rose-400',
          onclick: () => { dlg.close(); leave(); },
        }, 'Discard changes and leave')),
      confirmText: 'Save & leave',
      onConfirm: async () => {
        if (!validateBeforeSave()) return false;
        try {
          await api.put(`/api/schedules/${state.dayType}/${state.variant}`, { rules: sortRulesByTime(syncConditionDays(rules)), inheritsRegular: inh.on, removedIds: inh.removedIds });
          toast('Schedule saved', 'success');
        } catch (err) { toast(err.message, 'error'); return false; }
        leave();
      },
    });
  };
  editorGuard = { isDirty, confirmLeave };
  setNavGuard(editorGuard); // cross-page nav (Devices, etc.) now prompts too
  const goBack = () => confirmLeave(() => { editorGuard = null; go(backState); });
  const erevList = el('div', { class: 'space-y-4' });
  const dayList = el('div', { class: 'space-y-4' });
  const preview = el('div', { class: 'card' });
  // the cluster shown in the latest preview, used to validate candle-lighting
  // rules against the evenings this situation's occurrence actually has one
  let previewCluster = null;
  // Recompute the draft timeline after an edit. Debounced so a burst (typing a
  // time, dragging a slider, a redraw that emits several change events) collapses
  // into one compile; an immediate updatePreview() cancels a pending one.
  let previewTimer = null;
  const refreshPreview = () => { clearTimeout(previewTimer); previewTimer = setTimeout(() => updatePreview(), 250); };

  const addRule = (day) => {
    const rule = {
      // client id so we can scroll back to this exact rule after the save
      // re-sorts the list (the server keeps it, see newRuleId)
      id: newRuleId(),
      label: '', enabled: true,
      // Nothing preselected: no action, no device, no WHEN. The user consciously
      // picks each (save blocks until then), and a fresh rule with no time just
      // sits at the bottom of the list instead of jumping to some default slot.
      action: {},
      trigger: { day, clamp: {}, conditions: [] },
    };
    touchedRuleId = rule.id;
    rules.push(rule);
    drawRules();
    // on mobile the new rule is a summary card, open the editor modal straight
    // away so the user lands in it (there's no inline name field to focus)
    if (isMobileEditor()) { openRuleModal(rule); return; }
    // desktop: bring the new rule into view with a highlight so it's unmissable.
    // The list is sorted by time, so the new rule isn't necessarily the last
    // card, find it by object (like customizeRegular does).
    const fresh = ruleNodes.get(rule);
    if (fresh) {
      fresh.classList.add('rule-new');
      fresh.scrollIntoView({ behavior: 'smooth', block: 'center' });
      fresh.querySelector('input[placeholder]')?.focus({ preventScroll: true });
    }
  };

  const removeRule = (rule) => {
    rules.splice(rules.indexOf(rule), 1);
    drawRules();
  };

  // Run a list-mutating action while holding the window scroll position, so a
  // re-mount that changes layout above the viewport doesn't jump the page.
  const preserveScroll = (fn) => {
    const y = window.scrollY;
    fn();
    window.scrollTo({ top: y });
    requestAnimationFrame(() => window.scrollTo({ top: y }));
  };

  // A candle-lighting rule only resolves if candle lighting actually happens on
  // its section's evening. Candle lighting ushers each day in the night before,
  // so a day's OWN evening has one only when another assur day follows (Yom Tov,
  // or a Shabbos that is erev-Yom-Tov). A plain Shabbos "the day itself"
  // (Saturday evening = havdalah) or the last day of a Yom Tov has none, so a
  // candle-lighting rule there would never fire. Block the save and say so.
  const prevISO = (iso) => {
    const [y, m, d] = iso.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() - 1);
    return dt.toISOString().slice(0, 10);
  };
  const findCandleLightingIssues = (list) => {
    const days = previewCluster?.days;
    const own = days?.find((d) => d.dayType === state.dayType);
    if (!own) return []; // no occurrence to check against, the server still surfaces it
    const evenings = new Set(days.map((d) => prevISO(d.date))); // each day's ushering candle lighting is the night before
    const issues = [];
    for (const rule of list) {
      if (rule.enabled === false) continue;
      const t = rule.trigger;
      if (t?.kind !== 'zman' || t.zman !== 'candleLighting') continue;
      const sectionDate = t.day === 'erev' ? prevISO(own.date) : own.date;
      if (evenings.has(sectionDate)) continue;
      const name = rule.label ? `“${rule.label}”` : 'This rule';
      issues.push({
        rule,
        message: `${name} is set to candle lighting, but ${dayLabel(state.dayType)} has no candle lighting `
          + `${t.day === 'erev' ? 'the night it begins' : 'that evening, candle lighting is only the night a day begins'}. `
          + `${t.day === 'erev' ? 'Use a different zman for this night.' : 'Move it to the erev / night-before section, or use shkia (sunset).'}`,
      });
    }
    return issues;
  };

  // Two ENABLED rules in THIS situation that are literally identical (same action
  // AND same trigger, so they'd fire the same thing at the same instant) are an
  // authoring mistake — block the save. This is same-situation only; identical
  // actions that legitimately arrive from DIFFERENT situations (a Friday Yom Tov
  // flowing into Shabbos) never meet here, and are collapsed later by the
  // compiler's dedup. A same-time collision with a DIFFERENT result is a fight,
  // not a duplicate — caught separately by findRuleContradictions.
  const stableKey = (obj) => JSON.stringify(obj, (_k, v) => (v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v));
  const findDuplicateRules = (list) => {
    const seen = new Map(); // key -> first rule
    const issues = [];
    for (const rule of list) {
      if (rule.enabled === false || !rule.action?.type) continue;
      const key = stableKey({ action: rule.action, trigger: rule.trigger });
      const first = seen.get(key);
      if (first) {
        const name = rule.label ? `“${rule.label}”` : 'A rule';
        const firstName = first.label ? `“${first.label}”` : 'another rule';
        issues.push({ rule, message: `${name} is identical to ${firstName} — same action at the same time. Remove one; they’d fire the same thing at the same moment.` });
      } else {
        seen.set(key, rule);
      }
    }
    return issues;
  };

  // Contradictory clamps/conditions, a candle-lighting rule with no candle
  // lighting to anchor, or an exact-duplicate rule block save: highlight the
  // offending rule cards and explain the first problem.
  const validateBeforeSave = () => {
    document.querySelectorAll('.rule-conflict').forEach((n) => n.classList.remove('rule-conflict', 'ring-2', 'ring-rose-400'));
    const errors = [...findRuleContradictions(rules, scenes), ...findCandleLightingIssues(rules), ...findDuplicateRules(rules)];
    if (!errors.length) return true;
    for (const e of errors) {
      const node = ruleNodes.get(e.rule);
      node?.classList.add('rule-conflict', 'ring-2', 'ring-rose-400');
    }
    ruleNodes.get(errors[0].rule)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    toast(errors[0].message, 'error', { ms: 7000 }); // long enough to actually read
    return false;
  };

  const rerenderInherit = () => drawRules();

  const duplicateRule = (rule) => {
    const copy = structuredClone(rule);
    copy.id = newRuleId(); // its own id, kept across save so we can scroll to it
    copy.label = rule.label ? `${rule.label} (copy)` : '';
    touchedRuleId = copy.id;
    rules.splice(rules.indexOf(rule) + 1, 0, copy);
    drawRules();
    ruleNodes.get(copy)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    ruleNodes.get(copy)?.classList.add('rule-new');
  };

  // "Copy rules from…", import every rule from another day/situation as a
  // starting point
  // Copy-from: the button lives in a section (Erev or day-of), which decides
  // what's CHECKED by default. When the target has both sections, the checklist
  // also lists the OTHER section's rules (unchecked), so you can mix and match
  // erev + day-of without recreating them; each imported rule lands in the
  // section matching its own trigger.day. A day-type with no erev section (a
  // second Yom Tov day like Rosh Hashanah II) has a single "Schedule" section, so
  // it only ever offers the source's DAY rules (its erev rules would have nowhere
  // valid to land).
  const copyFromPicker = (scope) => {
    const scoped = scope; // 'erev' | 'day' — always the section the button lives in
    const inScope = (r) => (r.trigger?.day === 'erev' ? 'erev' : 'day') === scoped;
    const what = scoped === 'erev' ? 'erev ' : 'day-of ';   // lowercase, for prose/toast
    const whatLabel = scoped === 'erev' ? 'Erev' : 'day-of'; // for the dropdown option labels
    // A source that "starts from Regular" runs its own rules PLUS the Regular
    // rules it didn't remove or override, so resolve that layered set (own +
    // inherited, tagged) — used for the counts AND the checklist below.
    const resolvedSourceRules = (dt, variant) => {
      const s = schedules[dt]?.[variant];
      const own = (s?.rules ?? []).map((r) => ({ r }));
      if (variant === 'default' || variant === 'guest' || !s?.inheritsRegular) return own;
      const overridden = new Set((s.rules ?? []).map((r) => r.overridesId).filter(Boolean));
      const removed = new Set(s.removedIds ?? []);
      const inherited = (schedules[dt]?.default?.rules ?? [])
        .filter((r) => !removed.has(r.id) && !overridden.has(r.id))
        .map((r) => ({ r, inherited: true }));
      return [...own, ...inherited];
    };
    const sources = [];
    for (const [dt, variants] of Object.entries(schedules)) {
      for (const [variant] of Object.entries(variants ?? {})) {
        if (dt === state.dayType && variant === state.variant) continue;
        // Count the RESOLVED rules the checklist will offer (own + inherited "From
        // Regular"). When the target has both sections we offer all of them (mix
        // and match erev + day-of), so count all; otherwise only this section's.
        const n = resolvedSourceRules(dt, variant).filter(({ r }) => hasErev || inScope(r)).length;
        if (!n) continue;
        const countLabel = `${n} ${hasErev ? '' : `${whatLabel} `}rule${n === 1 ? '' : 's'}`;
        sources.push([`${dt}|${variant}`, `${dayLabel(dt)}${variant !== 'default' ? ` · ${VARIANT_LABELS[variant] ?? variant}` : ''} (${countLabel})`]);
      }
    }
    // Order the picker by festival day, then variant, so a day-type's situations
    // stay together (e.g. Sukkos I right beside Sukkos II) instead of following
    // the schedules object's arbitrary key order.
    sources.sort((a, b) => {
      const [dtA, vA] = a[0].split('|');
      const [dtB, vB] = b[0].split('|');
      return dayTypeRank(dtA) - dayTypeRank(dtB) || variantRank(vA) - variantRank(vB);
    });
    if (!sources.length) { toast(`No other schedule has ${hasErev ? '' : what}rules to copy yet`, 'warn'); return; }
    const picker = select(sources, sources[0][0], () => onSourceChange(), 'select');

    // Optional: also carry over the source situation's "Start from Regular"
    // setup, its inherit flag plus which Regular rules it disabled/edited, so a
    // situation built by starting from Regular and tweaking it can seed another.
    // Only coherent within the same day-type: removedIds/overrides reference
    // that day-type's Regular rule ids, which don't exist under another day-type's
    // Regular. Disabled (with a hover reason) otherwise.
    const inheritBox = el('input', { class: 'checkbox', type: 'checkbox' });
    const inheritLabel = el('label', { class: 'check-row !py-2' },
      inheritBox,
      el('span', {},
        el('span', { class: 'font-medium' }, 'Also copy its “Start from Regular” setup'),
        el('span', { class: 'hint block' }, 'Brings over the disabled and edited Regular rules too, not just this situation’s own added rules.')));
    const inheritReason = (val) => {
      const [dt, variant] = val.split('|');
      if (!isInheritable) return 'This schedule can’t start from the Regular schedule.';
      if (dt !== state.dayType) return `Only within the same day type. ${dayLabel(dt)} builds on its own Regular schedule, not ${dayLabel(state.dayType)}’s.`;
      if (!schedules[dt]?.[variant]?.inheritsRegular) return 'That schedule doesn’t start from Regular, so there’s no setup to copy.';
      return null;
    };
    // Per-rule checklist: each source rule (in this section) gets a checkbox so
    // the user picks exactly what to bring over. Rows carry the source rule id so
    // the async out-of-cluster check can flag/uncheck the right ones.
    const rows = new Map(); // ruleId -> { cb, warnEl }
    const listBox = el('div', { class: 'space-y-0.5 max-h-72 overflow-y-auto rounded-xl border border-stone-200 dark:border-stone-700 p-2' });
    // Compile the candidate rules against THIS destination's next occurrence and
    // pre-uncheck any that fire outside its Shabbos/Yom Tov window (e.g. a late
    // "11:45 PM" rule from an earlier festival day landing on the last day's
    // motzei). Reuses the timeline preview's ConflictDetector, so no new logic.
    const flagOutOfCluster = async (candidates) => {
      if (!candidates.length) return;
      try {
        const tl = await api.post('/api/timeline/preview', {
          draft: { dayType: state.dayType, variant: state.variant, rules: candidates, inheritsRegular: false, removedIds: [] },
        });
        const flagged = new Map();
        for (const c of tl.conflicts ?? []) {
          if (c.type !== 'out-of-cluster') continue;
          for (const a of c.actions ?? []) if (a.source?.ruleId) flagged.set(a.source.ruleId, c.message || 'Fires outside this day’s Shabbos/Yom Tov window.');
        }
        for (const [id, { cb, warnEl }] of rows) {
          const reason = flagged.get(id);
          if (!reason) continue;
          cb.checked = false; // opt-in: unchecked by default, user can re-check
          warnEl.textContent = reason;
          warnEl.classList.remove('hidden');
        }
      } catch { /* preview unavailable: leave every row checked, no warnings */ }
    };
    // A row per candidate rule. Checked by default only for the section this
    // button lives in; the OTHER section's rules show unchecked, there to opt
    // into for mixing and matching (deselection handles what you don't want).
    const ruleRow = ({ r, inherited }) => {
      const cb = el('input', { class: 'checkbox mt-0.5 shrink-0', type: 'checkbox', checked: inScope(r) });
      const warnEl = el('div', { class: 'hidden text-xs text-amber-600 dark:text-amber-400 mt-0.5' });
      rows.set(r.id, { cb, warnEl });
      return el('label', { class: 'flex items-start gap-2.5 py-1 cursor-pointer' },
        cb,
        el('div', { class: 'min-w-0' },
          el('div', { class: 'text-[15px] leading-snug flex flex-wrap items-center gap-x-2' },
            r.label || describeRule(r, zones, scenes),
            inherited && el('span', { class: 'shrink-0 text-[11px] px-1.5 py-0.5 rounded-full border border-stone-300 dark:border-stone-600 text-stone-500 dark:text-stone-400' }, 'From Regular')),
          r.label && el('div', { class: 'hint' }, describeRule(r, zones, scenes)),
          warnEl));
    };
    const sectionHeader = (txt) => el('div', { class: 'text-[11px] font-semibold uppercase tracking-wide text-stone-400 dark:text-stone-500 px-0.5 pt-1.5 pb-0.5' }, txt);
    const renderChecklist = () => {
      const [dt, variant] = picker.value.split('|');
      // Offer the other section's rules too when the target has both sections, so
      // erev/day-of can be mixed; a single-section target only offers its own.
      const candidates = resolvedSourceRules(dt, variant).filter(({ r }) => hasErev || inScope(r));
      const own = candidates.filter(({ r }) => inScope(r));
      const other = candidates.filter(({ r }) => !inScope(r));
      rows.clear();
      mount(clear(listBox), candidates.length === 0
        ? el('p', { class: 'hint p-1' }, 'No rules to copy.')
        : [
          // Only header the groups when both are present, so a same-section copy
          // looks exactly as before.
          ...(other.length ? [sectionHeader(scoped === 'erev' ? 'Erev' : 'Day-of')] : []),
          ...own.map(ruleRow),
          ...(other.length ? [sectionHeader(scoped === 'erev' ? 'Day-of · other section' : 'Erev · other section'), ...other.map(ruleRow)] : []),
        ]);
      flagOutOfCluster(candidates.map(({ r }) => r));
    };
    const refreshInherit = () => {
      const reason = inheritReason(picker.value);
      inheritBox.disabled = Boolean(reason);
      if (reason) inheritBox.checked = false;
      inheritLabel.title = reason ?? '';
      inheritLabel.classList.toggle('opacity-50', Boolean(reason));
      inheritLabel.classList.toggle('cursor-not-allowed', Boolean(reason));
    };
    const onSourceChange = () => { refreshInherit(); renderChecklist(); };
    // "Copy Regular setup" brings the whole situation, so the checklist doesn't
    // apply then — dim it and note that everything comes over.
    inheritBox.addEventListener('change', () => listBox.classList.toggle('opacity-40 pointer-events-none', inheritBox.checked && !inheritBox.disabled));
    refreshInherit();
    renderChecklist();

    modal({
      title: 'Copy rules from…',
      body: el('div', { class: 'space-y-3' },
        el('p', { class: 'hint' },
          hasErev
            ? el('span', {}, 'Pick any rules to bring over, its ',
                el('b', { class: 'text-accent-600 dark:text-accent-400' }, 'Erev'),
                ' and ',
                el('b', { class: 'text-accent-600 dark:text-accent-400' }, 'day-of'),
                ` rules are both listed (${scoped === 'erev' ? 'Erev' : 'day-of'} checked by default). Each lands in its matching section here; nothing is saved until you press Save schedule.`)
            : 'Imports the chosen schedule’s day-of rules into this section, nothing is saved until you press Save schedule.'),
        picker,
        isInheritable && inheritLabel,
        el('div', { class: 'text-sm font-semibold text-stone-500 dark:text-stone-400 pt-1' }, 'Rules to copy'),
        listBox),
      confirmText: 'Copy rules',
      onConfirm: () => {
        const [dt, variant] = picker.value.split('|');
        const src = schedules[dt]?.[variant];
        const withSetup = inheritBox.checked && !inheritBox.disabled;
        // "Copy Regular setup" replicates the WHOLE situation: its inherit flag
        // and removedIds are whole-situation, and its overrides can live in the
        // other section. Importing only this section's rules would silently drop
        // those overrides (e.g. a day-of "Mealtime" scene when copying the erev),
        // leaving the copy claiming to inherit but missing edits. So bring every
        // rule when copying the setup; otherwise bring only the CHECKED rules.
        const chosen = withSetup
          ? (src?.rules ?? [])
          : resolvedSourceRules(dt, variant).map(({ r }) => r)
            .filter((r) => (hasErev || inScope(r)) && (rows.get(r.id)?.cb.checked ?? inScope(r)));
        const imported = structuredClone(chosen);
        for (const r of imported) {
          delete r.id;
          // an override only makes sense against the same Regular base; across
          // day-types its target rule doesn't exist, so drop the dangling link
          if (dt !== state.dayType) delete r.overridesId;
        }
        if (imported.length === 0) { toast('No rules selected to copy.', 'warn'); return false; }
        rules.push(...imported);
        if (withSetup) {
          inh.on = true;
          inh.removedIds = [...new Set([...inh.removedIds, ...(src?.removedIds ?? [])])];
          const box = container.querySelector('[data-inherit-toggle]');
          if (box) box.checked = true; // reflect the flag flipping on (no onchange, no detach prompt)
        }
        drawRules();
        updatePreview(); // reflect the copied rules in the timeline right away
        toast(`Copied ${imported.length} rule${imported.length === 1 ? '' : 's'}${withSetup ? ' + Regular setup' : ''}, review and save`, 'success');
      },
    });
  };

  // Hiding a pinned heading's hint shrinks the page; on a barely-scrollable
  // page that unclamps the scroll, un-pins the heading, and the two states
  // flicker forever. The spacer gives back exactly the hidden height at the
  // bottom of the page so the total scroll height never changes.
  const stickyReservations = new Map();
  const stickySpacer = el('div', { 'aria-hidden': 'true' });
  const reserveStickyHeight = (key, px) => {
    stickyReservations.set(key, px);
    stickySpacer.style.height = `${[...stickyReservations.values()].reduce((a, b) => a + b, 0)}px`;
  };

  const section = (listNode, title, hintText, day, titleKey) => {
    // heading row: title with the buttons directly beside it; the hint sits
    // below and HIDES while the header is pinned (it was eating half a phone
    // screen of rule space)
    const hint = el('p', { class: 'hint section-hint mt-0.5' }, hintText);
    const heading = el('div', { class: 'sticky-below-editorbar z-10 mb-3 pt-5 pb-2 bg-stone-100/85 dark:bg-stone-950/85 backdrop-blur' },
      el('div', { class: 'flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between' },
        el('h3', { class: 'text-lg font-semibold' }, title),
        el('div', { class: 'flex gap-2 shrink-0' },
          el('button', { class: 'btn-secondary btn-sm', title: 'Import rules from another day or situation', onclick: () => copyFromPicker(day === 'erev' ? 'erev' : 'day') }, icon('copy', 'w-4 h-4'), 'Copy from…'),
          el('button', { class: 'btn-secondary btn-sm', onclick: () => addRule(day) }, icon('plus', 'w-4 h-4'), 'Add rule'))),
      hint);
    const sentinel = el('div', { class: 'h-px -mb-px' });
    requestAnimationFrame(() => {
      if (!sentinel.isConnected) return;
      const top = parseFloat(getComputedStyle(heading).top) || 0;
      new IntersectionObserver(
        ([e]) => {
          const stuck = !e.isIntersecting;
          if (stuck === heading.classList.contains('is-stuck')) return;
          const hintHeight = stuck ? hint.offsetHeight : 0; // measure while visible
          heading.classList.toggle('is-stuck', stuck);
          reserveStickyHeight(titleKey ?? title, hintHeight);
        },
        { rootMargin: `-${Math.ceil(top) + 1}px 0px 0px 0px`, threshold: 0 },
      ).observe(sentinel);
    });
    return el('div', {}, sentinel, heading, listNode);
  };

  // Inheritance helpers: a Regular rule shows as a compact read-only card
  // with Customize (become an override) and Hide (removedIds) actions.
  const customizeRegular = (reg) => {
    const copy = structuredClone(reg);
    copy.id = newRuleId(); // its own id (distinct from the Regular rule it overrides)
    copy.overridesId = reg.id;
    touchedRuleId = copy.id;
    rules.push(copy);
    drawRules();
    ruleNodes.get(copy)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    ruleNodes.get(copy)?.classList.add('rule-new');
  };
  // Stacks on mobile (description on its own full-width line, actions below on
  // the right) and sits inline on desktop, otherwise the badge + Customize +
  // ✕ squeeze the description into a tall narrow column on a phone.
  const inheritedCard = (reg) => el('div', { class: 'card !p-4 !bg-stone-50 dark:!bg-stone-900/60' },
    el('div', { class: 'flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-2.5' },
      el('div', { class: 'flex items-start gap-2.5 min-w-0 flex-1' },
        el('span', { class: 'badge-neutral shrink-0 mt-0.5' }, 'From Regular'),
        el('span', { class: 'font-medium text-[15px] min-w-0' }, reg.label || describeRule(reg, zones, scenes))),
      el('div', { class: 'flex items-center gap-2 shrink-0 self-end sm:self-auto' },
        el('button', { class: 'btn-secondary btn-sm', title: 'Copy this rule here and edit it for this situation', onclick: () => customizeRegular(reg) }, 'Customize'),
        el('button', {
          class: 'icon-btn !w-8 !h-8 text-rose-500', title: 'Disable this Regular rule in this situation',
          onclick: () => preserveScroll(() => { inh.removedIds.push(reg.id); drawRules(); }),
        }, icon('x', 'w-4 h-4')))),
    reg.label && el('div', { class: 'hint mt-1 sm:pl-24' }, describeRule(reg, zones, scenes)));
  const removedStub = (reg) => el('div', { class: 'card !p-3 !bg-transparent border-dashed flex items-center gap-2.5' },
    el('span', { class: 'hint line-through min-w-0 flex-1' }, `Disabled Regular rule: ${reg.label || describeRule(reg, zones, scenes)}`),
    el('button', {
      class: 'btn-secondary btn-sm shrink-0',
      // disabling/restoring reorders the list (stub <-> inherited card move
      // between sections), which shifts layout above the viewport, hold the
      // scroll position so the button doesn't jump away under the cursor
      onclick: () => preserveScroll(() => { inh.removedIds = inh.removedIds.filter((id) => id !== reg.id); drawRules(); }),
    }, 'Restore'));

  // ── mobile: compact summary cards + a full-editor modal ──────────────────
  // Below sm the stacked inline editor is painful to scroll and edit (a dozen
  // rules × many controls). On phones each rule becomes a one-line summary card;
  // a tap opens the SAME ruleEditor in a modal. ruleEditor mutates the rule
  // object in place, so closing the modal is all the "saving" it needs, the
  // page's Save button is still the real commit. Desktop (sm+) is unchanged.
  const mqDesktop = window.matchMedia('(min-width: 640px)');
  const isMobileEditor = () => !mqDesktop.matches;
  const inhOptsFor = (rule) => ({
    badge: inh.on ? (rule.overridesId ? 'Edited' : 'Added') : null,
    onRevert: inh.on && rule.overridesId ? () => removeRule(rule) : null,
  });
  const needsDevice = (rule) => rule.action.type !== 'sceneStart' && rule.action.type !== 'sceneEnd'
    && rule.action.zone == null && !(rule.action.zones?.length);

  const openRuleModal = (rule) => {
    const m = modal({
      title: 'Edit rule',
      wide: true,
      stickyFooter: true,
      confirmText: 'Done',
      cancelText: null, // edits apply live to the rule object, there's no "cancel"
      onConfirm: () => {}, // Done just closes
      body: ruleEditor(rule, zones, scenes,
        () => { m.close(); removeRule(rule); },
        () => { m.close(); duplicateRule(rule); },
        inhOptsFor(rule)),
      // the rule was mutated in place, refresh its summary card + the timeline
      // preview once the sheet closes (fires on ×, backdrop, or Done)
      onClose: () => { if (dayList.isConnected) { drawRules(); updatePreview(); } },
    });
    return m;
  };

  const ruleSummaryCard = (rule, inhOpts) => {
    const stop = (fn) => (e) => { e.stopPropagation(); fn(); };
    const summary = needsDevice(rule)
      ? el('span', { class: 'text-stone-400 dark:text-stone-500 italic' }, 'Unfinished, click to choose a device')
      : describeRule(rule, zones, scenes);
    const card = el('div', {
      class: 'card !p-4 flex items-center gap-3 cursor-pointer hover:border-accent-300 dark:hover:border-accent-600/60 transition-colors',
      onclick: () => openRuleModal(rule), role: 'button', tabindex: '0',
      onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openRuleModal(rule); } },
    },
      el('div', { class: 'min-w-0 flex-1' },
        el('div', { class: 'flex items-center gap-2 min-w-0' },
          inhOpts.badge && el('span', { class: `shrink-0 ${inhOpts.badge === 'Edited' ? 'badge-on' : 'badge-info'}` }, inhOpts.badge),
          el('div', { class: 'font-medium text-[15px] truncate' }, rule.label || summary)),
        rule.label && el('div', { class: 'hint truncate mt-0.5' }, summary)),
      el('div', { class: 'flex items-center gap-0.5 shrink-0' },
        inhOpts.onRevert && el('button', { class: 'btn-secondary btn-sm mr-1', title: 'Use the Regular rule again', onclick: stop(inhOpts.onRevert) }, 'Revert'),
        el('button', { class: 'icon-btn', title: 'Edit rule', onclick: stop(() => openRuleModal(rule)) }, icon('pencil', 'w-5 h-5')),
        el('button', { class: 'icon-btn', title: 'Duplicate rule', onclick: stop(() => duplicateRule(rule)) }, icon('copy', 'w-5 h-5')),
        el('button', { class: 'icon-btn text-rose-500 hover:!text-rose-600', title: 'Delete rule', onclick: stop(() => removeRule(rule)) }, icon('trash'))));
    ruleNodes.set(rule, card); // validation highlight + scroll target on mobile
    return card;
  };

  const drawRules = () => {
    // When there's no erev section, any stray erev rule shows under the day.
    const erevRules = hasErev ? rules.filter((r) => r.trigger.day === 'erev') : [];
    const dayRules = rules.filter((r) => !hasErev || r.trigger.day !== 'erev');
    const editorFor = (rule) => (isMobileEditor()
      ? ruleSummaryCard(rule, inhOptsFor(rule))
      : ruleEditor(rule, zones, scenes, () => removeRule(rule), () => duplicateRule(rule), inhOptsFor(rule)));
    // layered view: the Regular rules this situation still inherits
    const overriddenIds = new Set(rules.map((r) => r.overridesId).filter(Boolean));
    const inherited = inh.on
      ? regularRules().filter((r) => !overriddenIds.has(r.id))
      : [];
    const inhFor = (day) => inherited.filter((r) => (hasErev ? (day === 'erev' ? r.trigger.day === 'erev' : r.trigger.day !== 'erev') : day !== 'erev'));
    const stubsFor = (day) => (inh.on ? regularRules().filter((r) => inh.removedIds.includes(r.id)) : [])
      .filter((r) => (hasErev ? (day === 'erev' ? r.trigger.day === 'erev' : r.trigger.day !== 'erev') : day !== 'erev'));
    const visible = (list) => list.filter((r) => !inh.removedIds.includes(r.id));
    // Interleave the three kinds of rows, inherited "From Regular" cards,
    // disabled stubs, and this situation's own added/edited rules, sorted by
    // when each fires so an edited inherited rule keeps its chronological spot.
    // A brand-new rule has no WHEN chosen yet (ruleSortKey sorts it to the very
    // bottom), so adding one appends it at the end rather than dropping it into
    // some default slot; it takes its real position once its time is set (on the
    // next redraw / save re-fetch). Each row carries its rule so the key matches
    // sortRulesByTime at save time.
    const orderedRows = (ownRules, day) => [
      ...visible(inhFor(day)).map((reg) => [reg, inheritedCard(reg)]),
      ...stubsFor(day).map((reg) => [reg, removedStub(reg)]),
      ...ownRules.map((rule) => [rule, editorFor(rule)]),
    ].sort(([a], [b]) => ruleSortKey(a) - ruleSortKey(b)).map(([, node]) => node);
    if (hasErev) {
      mount(clear(erevList),
        erevRules.length === 0 && !inh.on && el('p', { class: 'hint py-2' }, 'Nothing scheduled on the erev yet, e.g. “lights on 30 minutes before candle lighting”.'),
        orderedRows(erevRules, 'erev'));
    }
    // Inheriting turned on but the Regular schedule for THIS day-type is empty
    //, explain why nothing appeared instead of showing a silent blank.
    const regularEmptyNote = inh.on && regularRules().length === 0
      && el('div', { class: 'card !p-4 !bg-sky-50 dark:!bg-sky-500/10 border border-sky-200 dark:border-sky-500/30 flex items-start gap-2.5' },
        el('span', { class: 'text-sky-600 dark:text-sky-400 mt-0.5 shrink-0' }, icon('info', 'w-5 h-5')),
        el('span', { class: 'text-[15px] text-sky-800 dark:text-sky-200' },
          `The Regular “${dayLabel(state.dayType)}” schedule has no rules yet, so there’s nothing to start from. `,
          el('a', { href: '#', class: 'underline font-medium', onclick: (e) => { e.preventDefault(); confirmLeave(() => { editorGuard = null; go({ view: 'edit', dayType: state.dayType, variant: 'default', from: state.from, groupKey: state.groupKey }); }); } },
            'Set up the Regular schedule first'),
          ', or just add rules directly here.'));
    mount(clear(dayList),
      regularEmptyNote,
      dayRules.length === 0 && !inh.on && el('p', { class: 'hint py-2' }, 'Nothing scheduled on the day itself yet.'),
      orderedRows(dayRules, 'day'));

    // After a save re-sorts the list, keep the anchored rule at the same
    // on-screen position it had before, so a zman-based rule that jumped order
    // is followed without the page lurching. Restoring its offset (not
    // centering it) means saving from the top with nothing edited doesn't
    // scroll anywhere. No highlight flash: the card is already on screen, so a
    // flash just confuses (the flash is for genuinely NEW/duplicated rules).
    if (focusScrollY != null) {
      const y = focusScrollY;
      const revealId = focusRuleId;
      focusScrollY = null;
      focusRuleId = null;
      window.scrollTo({ top: y });
      requestAnimationFrame(() => {
        window.scrollTo({ top: y }); // hold place across the re-sort — settles back, no creep
        if (revealId != null) {
          const target = rules.find((r) => r.id === revealId);
          const n = target && ruleNodes.get(target);
          // only scroll to the touched rule if the re-sort pushed it off-screen;
          // if it's still visible, leave the user exactly where they were
          if (n) {
            const top = n.getBoundingClientRect().top;
            if (top < 0 || top > window.innerHeight) n.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
        }
      });
    }
    // Every structural change (add / remove / duplicate / hide / unhide / inherit
    // toggle / copy) funnels through here, so refreshing the preview once from
    // drawRules keeps the timeline in step with the rule list without saving.
    refreshPreview();
  };
  // Inline field edits (device, time, action, brightness) mutate a rule in place
  // and re-render only their own card, bypassing drawRules — so keep the preview
  // in step by refreshing (debounced) as those fields change.
  erevList.addEventListener('input', refreshPreview);
  erevList.addEventListener('change', refreshPreview);
  dayList.addEventListener('input', refreshPreview);
  dayList.addEventListener('change', refreshPreview);

  // Preview toggle: overlay the guest rules on top of THIS situation. Defaults
  // to the live guest state; only shown when guest rules exist for this day-type.
  let showGuestOverlay = guestOn;
  async function updatePreview() {
    clearTimeout(previewTimer); // an explicit refresh supersedes any debounced one
    // keep the card's height while recomputing so the page doesn't shrink
    // under the user (a shorter page clamps the scroll position to the top)
    if (preview.offsetHeight) preview.style.minHeight = `${preview.offsetHeight}px`;
    const unpin = () => { preview.style.minHeight = ''; };
    mount(clear(preview), el('p', { class: 'hint' }, 'Computing preview…'));
    try {
      const match = nextOccurrence(state.dayType, state.variant);
      // Rare situations (a Shabbos that's Erev Pesach: 2045) fall outside the
      // 16-month calendar. Fall back to the true next date so the user still
      // sees a full timeline preview of their rules for when it next happens.
      const far = match ? null : await farNextDate;
      const previewDate = match?.date ?? far;
      if (!previewDate) {
        mount(clear(preview), el('p', { class: 'hint' },
          `No upcoming ${dayLabel(state.dayType)} · “${VARIANT_LABELS[state.variant]}” found.`));
        return;
      }
      const isFar = !match;
      // Regular preview whose next occurrence actually falls under an unconfigured
      // special situation, the cascade means Regular runs then, so say so.
      const cascadeVariant = state.variant === 'default' && match && match.variant !== 'default'
        ? match.variant : null;
      // "Far" (no match in the ~16-month window) means different things. For a
      // non-default situation it's genuine rarity. For a Regular (default) preview
      // it usually isn't: the near occurrences run configured SPECIAL situations,
      // so Regular simply next APPLIES in a later year — deferral, not rarity.
      const isRareSituation = isFar && state.variant !== 'default' && state.variant !== 'guest';
      const deferredBySpecial = isFar && state.variant === 'default'
        ? upcoming.flatMap((c) => c.days).find((d) => d.dayType === state.dayType && d.variant !== 'default')
        : null;
      // Previewing the Guest situation forces a guest-on compile so the user
      // sees the effect of their guest rules even while guest mode is off.
      const isGuestPreview = state.variant === 'guest';
      // Any situation can be previewed with the guest overlay on top — but the
      // toggle only applies when the Guest situation for THIS day-type has rules
      // (guest overlays every situation when it's on).
      const guestHasRules = (schedules[state.dayType]?.guest?.rules?.length ?? 0) > 0;
      const applicableGuest = guestHasRules && !isGuestPreview;
      const guestFlag = isGuestPreview ? '1' : (applicableGuest ? (showGuestOverlay ? '1' : '0') : undefined);
      // While there are unsaved edits, compile the DRAFT so the timeline reflects
      // rules the moment they're added/edited/copied — not only after Save. The
      // saved-config GET (memoized) is used once the editor is clean again.
      const tl = isDirty()
        ? await api.post('/api/timeline/preview', {
          draft: {
            dayType: state.dayType, variant: state.variant,
            rules: sortRulesByTime(syncConditionDays(structuredClone(rules))),
            inheritsRegular: inh.on, removedIds: inh.removedIds,
          },
          date: previewDate, guest: guestFlag,
        })
        : await api.get(`/api/timeline?date=${previewDate}${guestFlag != null ? `&guest=${guestFlag}` : ''}`);
      const cluster = tl.clusters[0];
      previewCluster = cluster ?? null;
      // Scope the preview to just THIS day's rules (its erev + the day itself),
      // so editing Pesach I doesn't show Pesach II / Shabbos actions.
      // Stitched preview: when the cluster spans more than one day-type, a
      // paired Shabbos↔Yom Tov weekend, or a multi-day Yom Tov, show the WHOLE
      // Show the whole weekend, but keep each situation's days together: the
      // edited day-type is open, the OTHER days of the cluster collapse into
      // title-only accordions (so Pesach I's preview shows Shabbos + Pesach II
      // as collapsed rows, not the full thing). A single-day-type cluster just
      // shows its own day.
      const clusterActions = cluster ? tl.actions.filter((a) => a.source.clusterId === cluster.id) : tl.actions;
      const clusterDayTypes = new Set((cluster?.days ?? []).map((d) => d.dayType));
      const stitched = clusterDayTypes.size > 1;
      const shownActions = stitched ? clusterActions : clusterActions.filter((a) => a.source.dayType === state.dayType);
      const guestActions = shownActions.filter((a) => a.source?.dayType === state.dayType);
      const dayConflicts = (tl.conflicts ?? []).filter((c) => !c.actions || c.actions.some((a) => a.source?.dayType === state.dayType));
      const daySkipped = (tl.report?.skippedRules ?? []).filter((s) => s.dayType === state.dayType);
      const dayOverridden = (tl.report?.overridden ?? []).filter((o) => o.dayType === state.dayType);
      // Previewing a special situation that has no rules of its own and isn't
      // inheriting: the compiler treats it as unconfigured and runs the Regular
      // schedule for it (report.unconfiguredVariants). Say so, so the Regular
      // rules in the timeline don't look like leftovers of just-deleted ones.
      const cascadesToRegular = state.variant !== 'default' && state.variant !== 'guest'
        && (tl.report?.unconfiguredVariants ?? []).some((u) => u.dayType === state.dayType && u.variant === state.variant);
      mount(clear(preview),
        // toggle sits right next to the title
        el('div', { class: 'flex items-center gap-3 mb-2 flex-wrap' },
          el('div', { class: 'section-title !mb-0' }, icon('eye'), 'Preview'),
          applicableGuest && guestOverlayToggle(showGuestOverlay, () => { showGuestOverlay = !showGuestOverlay; updatePreview(); })),
        el('p', { class: 'hint mb-4' },
          `${dayLabel(state.dayType)} rules resolved for ${deferredBySpecial ? 'when they next apply' : 'its next occurrence'} (`,
          el('a', {
            class: 'font-medium text-accent-700 dark:text-accent-400 underline decoration-dotted underline-offset-2 hover:decoration-solid cursor-pointer',
            href: `#/calendar?date=${previewDate}`, title: 'Show this date on the calendar',
            onclick: (e) => { e.preventDefault(); confirmLeave(() => { location.hash = `#/calendar?date=${previewDate}`; }); },
          }, fmtLongDate(previewDate)),
          ')',
          stitched ? ', the rest of the weekend is collapsed below.' : '',
          isRareSituation ? el('span', { class: 'block mt-0.5 text-accent-700 dark:text-accent-400' }, 'This situation is rare, this is the next time it happens.')
            : deferredBySpecial ? el('span', { class: 'block mt-0.5 text-accent-700 dark:text-accent-400' },
              `Nearer ${dayLabel(state.dayType)} occurrences run a special situation (${VARIANT_LABELS[deferredBySpecial.variant] ?? deferredBySpecial.variant}), so the Regular schedule next applies then.`)
              : (stitched ? '' : ':')),
        cascadeVariant && el('div', { class: 'mb-4 -mt-1 flex gap-2 text-[14px] text-accent-800 dark:text-accent-300 bg-accent-50 dark:bg-accent-600/10 border border-accent-200 dark:border-accent-600/30 rounded-xl px-3.5 py-2.5' },
          icon('info', 'w-5 h-5 shrink-0 mt-0.5'),
          el('span', {}, `The next ${dayLabel(state.dayType)} (${fmtLongDate(previewDate)}) actually falls under `,
            el('b', {}, `“${VARIANT_LABELS[cascadeVariant] ?? cascadeVariant}”`),
            `, a situation you haven’t set up, so this Regular schedule is what will run then. Set up `,
            el('b', {}, `“${VARIANT_LABELS[cascadeVariant] ?? cascadeVariant}”`),
            ' if you want different behavior for that occurrence.')),
        cascadesToRegular && el('div', { class: 'mb-4 -mt-1 flex gap-2 text-[14px] text-accent-800 dark:text-accent-300 bg-accent-50 dark:bg-accent-600/10 border border-accent-200 dark:border-accent-600/30 rounded-xl px-3.5 py-2.5' },
          icon('info', 'w-5 h-5 shrink-0 mt-0.5'),
          el('span', {}, 'This situation has no rules of its own, so the Regular ',
            el('b', {}, dayLabel(state.dayType)),
            ' schedule runs for it. That’s what the timeline below shows. Add rules here (or turn on “Start from the Regular schedule”) to make it differ.')),
        isGuestPreview && guestActions.some((a) => a.source?.guest) && guestPreviewNote({ forced: !guestOn }),
        // "forced" (what-if) unless guest mode is actually live
        !isGuestPreview && showGuestOverlay && guestActions.some((a) => a.source?.guest) && guestPreviewNote({ forced: !guestOn }),
        // away mode shapes this preview only when the shown occurrence is inside its window
        awayMode?.enabled && awayMode.from && previewDate >= awayMode.from && previewDate <= awayMode.to && awayPreviewNote(),
        shownActions.length === 0
          ? el('p', { class: 'hint' }, 'Nothing to preview. Add rules above.')
          : timelineView(shownActions, {
            zones, scenes, dayLabels: cluster ? clusterDayLabels(cluster) : new Map(),
            emphasizeDayType: stitched ? state.dayType : null, cluster: stitched ? cluster : null,
            conflictKeys: new Set(dayConflicts.flatMap((c) => (c.actions ?? []).map((a) => `${a.zone}|${a.at}|${a.source?.ruleId}`))),
            skipped: daySkipped,
            overridden: dayOverridden,
            // pin each day heading below the editor's title/save bar as you scroll
            stickyHeaders: 'sticky-below-editorbar z-10',
          }),
        dayConflicts.length > 0 && el('div', { class: 'mt-4 space-y-1.5 text-[15px] text-accent-700 dark:text-accent-400' },
          el('div', { class: 'font-semibold flex items-center gap-2' }, icon('alert', 'w-5 h-5'), `${dayConflicts.length} possible conflict${dayConflicts.length === 1 ? '' : 's'}`),
          dayConflicts.map((w) => el('div', { class: 'flex gap-2 pl-1' }, el('span', {}, '•'), el('span', {}, w.message)))),
        // placeable skips now render inline in the timeline (greyed, where they'd
        // have fired); only the ones with no possible position get a note here
        (() => {
          const unplaceable = daySkipped.filter((s) => !s.wouldFireAt);
          return unplaceable.length > 0 && el('div', { class: 'mt-4 space-y-1.5 text-[15px] text-stone-500 dark:text-stone-400' },
            el('div', { class: 'font-semibold flex items-center gap-2' }, icon('info', 'w-5 h-5'), `${unplaceable.length} rule${unplaceable.length === 1 ? '' : 's'} won’t fire this time`),
            unplaceable.map((s) => el('div', { class: 'flex gap-2 pl-1' }, el('span', {}, '•'),
              el('span', {}, el('b', {}, s.label || 'an unnamed rule'), `, ${s.reason}`))));
        })());
    } catch (err) {
      mount(clear(preview), el('p', { class: 'text-rose-600' }, `Preview failed: ${err.message}`));
    } finally {
      unpin();
    }
  }

  const next = nextOccurrence(state.dayType, state.variant);
  const fmtLongDate = (d) => new Date(`${d}T12:00`).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
  // "Next: <date>." rendered as a calendar deep-link, styled exactly like the
  // preview's date link (yellow accent, dotted underline that solidifies on
  // hover). confirmLeave guards unsaved edits before navigating.
  const nextDateLink = (d) => el('a', {
    class: 'font-medium text-accent-700 dark:text-accent-400 underline decoration-dotted underline-offset-2 hover:decoration-solid cursor-pointer',
    href: `#/calendar?date=${d}`, title: 'Show this date on the calendar',
    onclick: (e) => { e.preventDefault(); confirmLeave(() => { location.hash = `#/calendar?date=${d}`; }); },
  }, `Next: ${fmtLongDate(eveBeforeISO(d))} (evening).`);
  // rare situations (Shabbos Erev Pesach: 2045!) fall outside the 16-month
  // window, fetch the true next date so the chip doesn't look broken
  // Guest previews always resolve in-window; every real day-type + variant
  // (including Regular/default, e.g. a Pesach II that is only ever "Regular"
  // years out) has a true next date from the server so the preview never dead-ends.
  const farNextDate = (next || state.variant === 'guest')
    ? Promise.resolve(null)
    : api.get('/api/schedules/next-occurrences').then((m) => m[`${state.dayType}|${state.variant}`] ?? null).catch(() => null);
  const farNext = el('span', {});
  farNextDate.then((d) => { if (d) mount(clear(farNext), el('div', { class: 'mt-1' }, nextDateLink(d))); });

  // Count conflicts / non-firing rules for this situation's next occurrence —
  // used for the post-save toast (in case the user never scrolls to the timeline).
  async function saveIssues() {
    const match = nextOccurrence(state.dayType, state.variant);
    const previewDate = match?.date ?? await farNextDate;
    if (!previewDate) return { conflicts: 0, skipped: 0 };
    const tl = await api.get(`/api/timeline?date=${previewDate}${state.variant === 'guest' ? '&guest=1' : ''}`);
    const conflicts = (tl.conflicts ?? []).filter((c) => !c.actions || c.actions.some((a) => a.source?.dayType === state.dayType));
    const skipped = (tl.report?.skippedRules ?? []).filter((s) => s.dayType === state.dayType);
    return { conflicts: conflicts.length, skipped: skipped.length };
  }

  // Commit the schedule. Shared by the Save button and the ⌘/Ctrl+S shortcut;
  // `saving` guards against a second trigger while a save is in flight.
  let saving = false;
  const save = async () => {
    if (saving || !validateBeforeSave()) return;
    saving = true;
    // Hold the exact scroll position across the save, and remember the rule the
    // user just touched so we can scroll to it only if the re-sort shifts it
    // off-screen (see drawRules).
    focusScrollY = window.scrollY;
    focusRuleId = touchedRuleId;
    touchedRuleId = null;
    try {
      await api.put(`/api/schedules/${state.dayType}/${state.variant}`, { rules: sortRulesByTime(syncConditionDays(rules)), inheritsRegular: inh.on, removedIds: inh.removedIds });
      rerender();
      // In case the user never scrolls to the timeline, surface any conflicts /
      // non-firing rules for this weekend as a toast.
      const issues = await saveIssues().catch(() => null);
      if (issues?.conflicts) toast(`Saved, ${issues.conflicts} possible conflict${issues.conflicts === 1 ? '' : 's'} this weekend. Check the preview below.`, 'warn', { ms: 7000 });
      else if (issues?.skipped) toast(`Saved, ${issues.skipped} rule${issues.skipped === 1 ? '' : 's'} won’t fire this occurrence. See the preview.`, 'warn', { ms: 7000 });
      else toast('Schedule saved', 'success');
    } catch (err) { toast(err.message, 'error'); } finally { saving = false; }
  };

  mount(clear(container),
    // schedule name + Save stay pinned (below the mobile header) while the
    // rule list scrolls, navbar-style backdrop blur
    el('div', {
      class: 'sticky-below-header z-20 -mx-4 sm:-mx-6 lg:-mx-10 -mt-5 sm:-mt-6 lg:-mt-7 px-4 sm:px-6 lg:px-10 py-2.5 lg:pt-7 mb-4 '
        + 'flex items-center gap-2 sm:gap-3 bg-stone-100/85 dark:bg-stone-950/85 backdrop-blur border-b border-stone-200/80 dark:border-stone-800/80',
    },
      // back lives in the sticky bar so it's reachable from anywhere in a long
      // rule list
      el('button', { class: 'btn-ghost btn-sm shrink-0 !px-2', onclick: goBack, 'aria-label': 'Back' },
        icon('chevronLeft', 'w-5 h-5'), 'Back'),
      // title doubles as a jump menu between this festival's days
      headerSwitcher(state.dayType,
        (HOLIDAY_GROUPS.find((gg) => gg.days.includes(state.dayType))?.days ?? [state.dayType])
          .filter((dt) => meta.dayTypes.includes(dt)).map((dt) => ({ key: dt, label: dayLabel(dt) })),
        (dt) => confirmLeave(() => { editorGuard = null; go({ view: 'edit', dayType: dt, variant: 'default', from: state.from, groupKey: state.groupKey }); })),
      el('button', {
        class: 'btn shrink-0',
        onclick: save,
      }, icon('check', 'w-5 h-5'),
      // "Save" on phones (so the day title isn't crushed to an ellipsis),
      // "Save schedule" once there's room
      el('span', { class: 'sm:hidden' }, 'Save'),
      el('span', { class: 'hidden sm:inline' }, 'Save schedule'))),

    el('div', { class: 'card space-y-3' },
      el('div', {},
        el('label', { class: 'label' }, 'Situation'),
        el('div', { class: 'flex gap-2 flex-wrap' },
          variants.map((v) => el('button', {
            class: v === 'guest'
              ? (state.variant === v ? 'btn btn-sm !bg-sky-600 hover:!bg-sky-500' : 'btn-secondary btn-sm !text-sky-700 dark:!text-sky-300')
              : (state.variant === v ? 'btn btn-sm' : 'btn-secondary btn-sm'),
            onclick: () => { state.variant = v; rerender(); },
          }, v === 'guest' && icon('users', 'w-4 h-4'), VARIANT_LABELS[v] ?? v)))),
      el('div', { class: 'flex items-start gap-2 text-[15px] text-stone-600 dark:text-stone-300' },
        el('span', { class: 'text-stone-400 mt-0.5 shrink-0' }, icon('info', 'w-4.5 h-4.5')),
        el('span', {},
          variantHelp(state.variant, variants),
          next && state.variant !== 'guest' && el('div', { class: 'mt-1' }, nextDateLink(next.date)),
          !next && farNext,
          state.variant === 'guest' && el('b', { class: guestOn ? 'text-sky-600 dark:text-sky-400' : '' },
            guestOn ? ' Guest mode is currently ON.' : ' Guest mode is currently off.'),
          state.variant !== 'default' && state.variant !== 'guest' && el('span', { class: 'block hint mt-1' },
            'This schedule fully replaces the Regular one when this situation occurs. Leave it empty to fall back to Regular.'))),
      // one button to hop to the paired situation (the other day of this weekend)
      (() => {
        const pl = PAIR_LINK[`${state.dayType}|${state.variant}`];
        return pl && el('button', {
          class: 'btn-secondary btn-sm',
          onclick: () => confirmLeave(() => {
            editorGuard = null;
            const gk = HOLIDAY_GROUPS.find((gg) => gg.days.includes(pl.dayType))?.key ?? state.groupKey;
            go({ view: 'edit', dayType: pl.dayType, variant: pl.variant, from: state.from, groupKey: gk });
          }),
        }, 'The other half of this weekend: ', el('b', {}, pl.label), icon('chevronRight', 'w-4 h-4'));
      })()),

    isInheritable && el('label', { class: 'check-row card !py-3 !px-4 !flex' },
      el('input', {
        class: 'checkbox', type: 'checkbox', checked: inh.on, 'data-inherit-toggle': '',
        onchange: (e) => {
          if (!e.target.checked && inh.on) {
            e.target.checked = true; // decided by the modal below
            const layered = [
              ...regularRules().filter((r) => !inh.removedIds.includes(r.id) && !rules.some((o) => o.overridesId === r.id)),
              ...rules,
            ];
            const dlg = modal({
              title: 'Stop inheriting from Regular?',
              body: el('div', { class: 'space-y-3' },
                el('p', { class: 'text-[15px]' }, 'This situation currently starts from the Regular schedule. What should happen to those rules?'),
                el('button', {
                  class: 'btn-secondary w-full',
                  onclick: () => {
                    dlg.close();
                    const copies = structuredClone(layered).map((r) => { const c = { ...r }; delete c.overridesId; return c; });
                    rules.splice(0, rules.length, ...copies);
                    inh.on = false; inh.removedIds = [];
                    e.target.checked = false; // the box itself, not just the redrawn lists
                    rerenderInherit();
                  },
                }, 'Copy everything into this situation and detach'),
                el('button', {
                  class: 'btn-secondary w-full !text-rose-600 dark:!text-rose-400',
                  onclick: () => {
                    dlg.close();
                    rules.splice(0, rules.length);
                    inh.on = false; inh.removedIds = [];
                    e.target.checked = false;
                    rerenderInherit();
                  },
                }, 'Start empty')),
              cancelText: 'Keep inheriting',
            });
          } else {
            inh.on = e.target.checked;
            rerenderInherit();
          }
        },
      }),
      el('span', {},
        el('span', { class: 'font-medium' }, 'Start from the Regular schedule'),
        el('span', { class: 'hint block' }, 'Regular’s rules apply here as a base, customize or hide individual ones, and future edits to Regular flow through automatically.'))),

    hasErev && section(erevList,
      titleWithDay(erevLabelFor(dayLabel(state.dayType), state.dayType, state.variant), wk?.erev),
      'Before it begins, prep, candle-lighting time, and the night going into the day (a “12:30 AM” rule here means the first night).'
      + (state.variant === 'erev-is-shabbos'
        ? ' Note: the daytime before is Shabbos itself, governed by the Shabbos schedule (its “Erev Pesach” / “Erev Shavuos” situation). Rules here are only for the night after Shabbos ends, from an existing flame.'
        : state.variant === 'follows-yt'
          ? ' Note: this erev is itself a Yom Tov day, its daytime is governed by that Yom Tov’s “Friday, into Shabbos” situation. Rules here are for the transition into Shabbos.'
          : (state.variant === 'chol-hamoed-pesach' || state.variant === 'chol-hamoed-sukkos')
            ? ` Note: some years this Shabbos follows a Friday Yom Tov (${state.variant === 'chol-hamoed-pesach' ? 'Pesach II' : 'Sukkos II'}), and then this Friday IS that Yom Tov, governed by its “Friday, into Shabbos” situation, so put those rules there instead. This erev applies the years the Friday is Chol Hamoed (a weekday).`
            : ''), 'erev', `erev-${state.dayType}`),
    section(dayList,
      titleWithDay(hasErev ? 'The day itself' : 'Schedule', wk?.day),
      hasErev
        ? 'From the morning through havdalah (havdalah rules only fire on the last day of a cluster).'
        : 'This day begins the evening before, from an existing flame, everything for it lives here.', undefined, `day-${state.dayType}`),
    preview,
    stickySpacer,
  );
  // Once the editor scrolls, its sticky title/save bar is pinned to the top;
  // tighten its top padding (desktop) for more rule room, full padding at rest.
  // Detected by scroll position, a sentinel would break the bar's negative-margin
  // layout (its -mt cancels the page's top padding via margin-collapse).
  if (container._editorScroll) window.removeEventListener('scroll', container._editorScroll);
  const onEditorScroll = () => {
    if (!container.isConnected) { window.removeEventListener('scroll', onEditorScroll); return; }
    container.classList.toggle('is-editor-stuck', window.scrollY > 2);
  };
  container._editorScroll = onEditorScroll;
  window.addEventListener('scroll', onEditorScroll, { passive: true });
  onEditorScroll();

  // ⌘S / Ctrl+S saves the schedule instead of the browser's Save-page dialog.
  // Registered on window (a rule editor can hold focus inside a modal) and, like
  // the scroll handler, replaced on rerender and self-cleaned when the editor
  // leaves the DOM so it never leaks or double-fires across navigations.
  if (container._editorKeydown) window.removeEventListener('keydown', container._editorKeydown);
  const onEditorKeydown = (e) => {
    if (!container.isConnected) { window.removeEventListener('keydown', onEditorKeydown); return; }
    if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) { e.preventDefault(); save(); }
  };
  container._editorKeydown = onEditorKeydown;
  window.addEventListener('keydown', onEditorKeydown);

  drawRules();
  updatePreview();

  // Re-draw if the viewport crosses the sm breakpoint (e.g. rotating a phone),
  // switching between inline editors and summary cards. Self-cleans once this
  // editor's nodes leave the DOM, so it doesn't leak across navigations.
  const onBpChange = () => {
    if (!dayList.isConnected) { mqDesktop.removeEventListener('change', onBpChange); return; }
    drawRules();
  };
  mqDesktop.addEventListener('change', onBpChange);
}

/**
 * Checkbox dropdown for picking one or more devices, grouped by room.
 * Selection is read/written through the accessors so the rule stays the
 * single source of truth; at least one device always stays selected.
 */
// Kinds whose ON action has its own verb + controls (Open / Lock / Arm / …);
// everything else is the plain on-off-or-dim group. A single rule targets ONE
// family — its verb and brightness field can't mean two things at once — so once
// a device is picked, cross-family devices grey out. Mix types with a scene.
const SPECIAL_VERB_KINDS = new Set(['shade', 'alarm', 'bypass', 'lock', 'vacuum']);
const deviceFamily = (z) => (SPECIAL_VERB_KINDS.has(z.kind) ? z.kind : 'onoff');
const FAMILY_NAME = { onoff: 'lights, switches & plugs', shade: 'shades', lock: 'locks', alarm: 'alarm zones', bypass: 'bypass zones', vacuum: 'vacuums' };

function multiDeviceSelect(zones, getSelected, setSelected, placeholder = 'Choose a device…') {
  const name = (z) => z.friendlyName || `${z.area} ${z.name}`;
  const label = () => {
    const sel = getSelected();
    const first = zones.find((z) => z.id === sel[0]);
    const base = first ? name(first) : placeholder;
    return sel.length > 1 ? `${base} + ${sel.length - 1} more` : base;
  };
  const summary = el('summary', { class: 'select !w-auto cursor-pointer list-none inline-flex items-center gap-1.5 select-none' },
    label());
  // unchosen state stands out so a fresh rule can't be mistaken for complete
  const paintEmpty = () => summary.classList.toggle('!border-accent-400', getSelected().length === 0);
  paintEmpty();
  const byArea = new Map();
  for (const z of zones) {
    const area = z.area || 'Other';
    if (!byArea.has(area)) byArea.set(area, []);
    byArea.get(area).push(z);
  }
  // Family-lock: once something is selected, disable every device of a different
  // family so a rule can't mix, say, a light and a shade. Re-applied on each
  // change (and on open, for a rule that already targets a device).
  const rows = [];
  const applyLock = () => {
    const sel = getSelected();
    const fam = sel.length ? deviceFamily(zones.find((z) => z.id === sel[0])) : null;
    for (const { z, cb, node } of rows) {
      const locked = fam != null && deviceFamily(z) !== fam;
      cb.disabled = locked;
      node.classList.toggle('opacity-40', locked);
      node.classList.toggle('cursor-not-allowed', locked);
      node.classList.toggle('cursor-pointer', !locked);
      node.title = locked ? `Clear the selection first to pick ${FAMILY_NAME[deviceFamily(z)] ?? 'a different type'} — one rule targets one type of device (use a scene to mix types).` : '';
    }
  };
  const panel = el('div', {
    class: 'picker-scroll absolute z-30 mt-1.5 w-72 max-w-[calc(100vw-1.75rem)] max-h-80 overflow-y-auto overscroll-contain rounded-xl border border-stone-200 dark:border-stone-700 '
      + 'bg-white dark:bg-stone-900 shadow-xl p-3 space-y-2.5',
  },
    [...byArea.entries()].map(([area, list]) => el('div', {},
      el('div', { class: 'text-xs font-semibold uppercase tracking-wide text-stone-400 mb-1' }, area),
      list.map((z) => {
        const cb = el('input', { class: 'checkbox', type: 'checkbox', checked: getSelected().includes(z.id) });
        cb.addEventListener('change', () => {
          let sel = getSelected().filter((id) => id !== z.id);
          if (cb.checked) sel = [...getSelected(), z.id];
          // Unchecking the last device IS allowed — it returns the rule to "no
          // device" (yellow, save-blocked), same as a fresh rule; forcing at
          // least one meant you couldn't clear a wrong pick without adding another.
          setSelected(sel);
          summary.textContent = label();
          paintEmpty();
          applyLock();
        });
        const node = el('label', { class: 'flex items-center gap-2.5 py-1 cursor-pointer text-[15px]' }, cb, name(z));
        rows.push({ z, cb, node });
        return node;
      }))));
  applyLock();
  const box = el('details', { class: 'relative' }, summary, panel);
  // <details> doesn't close on outside clicks by itself
  document.addEventListener('click', (e) => { if (box.open && !box.contains(e.target)) box.open = false; });
  return box;
}

/** Zone options grouped by room, for a delineated device dropdown. */
function zoneGroups(zones) {
  const byArea = new Map();
  for (const z of zones) {
    const area = z.area || 'Other';
    if (!byArea.has(area)) byArea.set(area, []);
    byArea.get(area).push([z.id, z.friendlyName || z.name]);
  }
  return [...byArea.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([label, options]) => ({ label, options }));
}

/* ── rule editor ────────────────────────────────────────────────────────── */

// rule object -> its rendered card, so save-time validation can highlight it
const ruleNodes = new WeakMap();
// After a save re-sorts the list we PRESERVE the raw scroll position (settles
// back to the same spot, no drift from the sticky-heading hints toggling), and
// separately scroll to a rule the user just touched ONLY if the re-sort pushed
// it off-screen. Module-level so they survive the editor rerender a save fires.
let focusScrollY = null;
let focusRuleId = null;
// The rule the user most recently added/edited this session; on save we scroll
// to it so a re-sort doesn't leave them staring at where it used to be. Set by
// addRule/duplicate/customize and by any edit inside a rule editor; consumed
// (and reset) on save. Client-assigned ids survive the save round-trip (the
// server keeps r.id when present), so the rule is still findable afterwards.
let touchedRuleId = null;
let ruleIdSeq = 0;
const newRuleId = () => `r${Date.now().toString(36)}${(ruleIdSeq++).toString(36)}`;

/** One-line human description of a rule (used for inherited compact cards). */
function describeRule(rule, zones, scenes) {
  const a = rule.action;
  if (!a?.type) return 'Not set yet'; // a fresh rule with no action chosen
  const zname = (id) => zones.find((z) => z.id === id)?.friendlyName || `Device ${id}`;
  let what;
  if (a.type === 'sceneStart' || a.type === 'sceneEnd') {
    what = `${a.type === 'sceneStart' ? 'Start' : 'End'} scene “${scenes.find((sc) => sc.id === a.sceneId)?.name ?? a.sceneId}”`;
  } else if (a.type === 'flash') {
    what = `Flash ${zname(a.zone)} ${(a.times ?? (a.seconds >= 4 ? 2 : 1)) >= 2 ? 'twice' : 'once'}`;
  } else if (a.type === 'setAutomation') {
    const targets = a.zones?.length > 1 ? `${a.zones.length} automations` : zname(a.zone);
    what = `${a.enabled ? 'Enable' : 'Disable'} ${targets}`;
  } else if (a.type === 'setPreset') {
    what = `Set ${zname(a.zone)} to ${presetLabel(a.preset ?? '')}`;
  } else if (a.type === 'setHvacMode') {
    what = `Set ${zname(a.zone)} to ${hvacLabel(a.hvacMode ?? '')}`;
  } else {
    const targets = a.zones?.length > 1 ? `${a.zones.length} devices` : zname(a.zone);
    const z0 = zones.find((z) => z.id === a.zone);
    if (z0?.kind === 'thermostat') {
      // thermostats hold a temperature (in their own unit) or resume their program
      const unit = z0.displayUnit === 'C' ? 'C' : 'F';
      const t0 = unit === 'C' ? Math.round((a.level - 32) * 5 / 9) : Math.round(a.level);
      what = a.level > 0 ? `${targets} hold ${t0}°${unit}` : `${targets} resume program`;
    } else {
      what = z0?.kind === 'automation'
        ? `Run ${targets}`
        : a.level > 0 ? `${targets} on${a.level < 100 ? ` at ${a.level}%` : ''}${a.rgb != null ? `, ${rgbToHex(a.rgb)}` : a.kelvin != null ? `, ${a.kelvin}K white` : ''}` : `${targets} off`;
    }
  }
  const t = rule.trigger;
  const when = !t.kind
    ? 'when not set'
    : t.kind === 'fixed'
    ? `at ${new Date(`1970-01-01T${t.time}`).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}${t.nextDay ? ' (next day)' : ''}`
    : (t.offsetMin ? `${Math.abs(t.offsetMin) >= 60 ? `${Math.floor(Math.abs(t.offsetMin) / 60)}hr ${Math.abs(t.offsetMin) % 60}min` : `${Math.abs(t.offsetMin)} min`} ${t.offsetMin < 0 ? 'before' : 'after'} ${zmanLabel(t.zman)}` : `at ${zmanLabel(t.zman)}`);
  return `${what} · ${when}`;
}

function ruleEditor(rule, zones, scenes, onDelete, onDuplicate, inhOpts = {}) {
  const root = el('div', { class: 'card !p-5' });
  ruleNodes.set(rule, root); // save-time validation highlights the offending card
  // Any edit here marks this rule as the one to scroll to on the next save, so a
  // retimed rule that jumps order stays in front of the user (bubbles, so one
  // listener catches every field). Needs an id — new rules get one at creation.
  const markTouched = () => { if (rule.id != null) touchedRuleId = rule.id; };
  root.addEventListener('input', markTouched);
  root.addEventListener('change', markTouched);
  const t = () => rule.trigger;

  const isScene = () => rule.action.type === 'sceneStart' || rule.action.type === 'sceneEnd';
  const selectedZones = () => (rule.action.zones?.length ? rule.action.zones : [rule.action.zone].filter((z) => z != null));
  const device = () => zones.find((z) => z.id === selectedZones()[0]);
  const isThermo = () => device()?.kind === 'thermostat';

  // Automations are momentary "run" triggers, not controllable devices, so they
  // get their own "Run automation" action instead of being mixed into the
  // device picker (where their only option was "Run" with no way back).
  const autos = zones.filter((z) => z.kind === 'automation');
  const thermostats = zones.filter((z) => z.kind === 'thermostat');
  // "plain" = the on/off/dim family (lights, shades, plugs, locks, …); thermostats
  // and automations each get their own action + device set so they never mix
  const plainZones = zones.filter((z) => z.kind !== 'automation' && z.kind !== 'thermostat');
  // The WHAT dropdown always offers the full set of actions (Turn on, Thermostat,
  // Run automation, …); the CHOSEN action decides which devices the picker shows.
  // `runMode`/`thermoMode` track the current family even before a device is picked,
  // so you're never stuck (e.g. can switch a thermostat rule back to "Turn on").
  let runMode = device()?.kind === 'automation';
  let thermoMode = device()?.kind === 'thermostat';

  const uiAction = () => {
    // a fresh rule has no action chosen yet — the WHAT dropdown shows its
    // "Choose action…" placeholder and the device picker/controls stay hidden
    if (!rule.action?.type) return '';
    if (runMode) {
      if (rule.action.type === 'setAutomation') return rule.action.enabled ? 'enableAutomation' : 'disableAutomation';
      return 'runAutomation';
    }
    if (isScene()) return rule.action.type;
    // a thermostat is a single "Thermostat" WHAT with a sub-select for the
    // specific action (hold / resume / mode / heat-cool) — cleaner than
    // scattering four verbs in the top-level dropdown
    if (thermoMode || isThermo()) return 'thermostat';
    if (rule.action.type === 'flash') return 'flash';
    return rule.action.level > 0 ? 'on' : 'off';
  };
  // which thermostat action the current rule represents (drives the sub-select)
  const thermoAction = () => (rule.action.type === 'setPreset' ? 'preset'
    : rule.action.type === 'setHvacMode' ? 'hvac'
      : (rule.action.level > 0 ? 'hold' : 'resume'));
  const setThermoAction = (v, dev) => {
    const keep = { zone: rule.action.zone ?? null, ...(rule.action.zones?.length ? { zones: rule.action.zones } : {}) };
    if (v === 'hold') rule.action = { type: 'setLevel', ...keep, level: rule.action.level > 0 ? rule.action.level : 70, fadeSec: 0 };
    else if (v === 'resume') rule.action = { type: 'setLevel', ...keep, level: 0, fadeSec: 0 };
    else if (v === 'preset') rule.action = { type: 'setPreset', ...keep, preset: rule.action.preset ?? dev?.presetModes?.[0] };
    else rule.action = { type: 'setHvacMode', ...keep, hvacMode: rule.action.hvacMode ?? dev?.hvacModes?.[0] };
    redraw();
  };

  const redraw = () => {
    const dev = runMode ? null : device();              // the thermostat in thermoMode, else the plain device
    const plainDev = (!runMode && !thermoMode) ? dev : null;
    // "dimmable" gates the brightness field + "set brightness" wording. It means
    // the SELECTION actually contains a dimmer — so with no device picked (or
    // only on/off devices) there's no "at X%" field. In a mixed pick the field
    // shows and dimNote explains it lands on the dimmers only.
    const dimmable = !runMode && !thermoMode
      && selectedZones().some((id) => zones.find((z) => z.id === id)?.dimmable);
    const thermo = thermoMode || (!runMode && isThermo());
    // Flashing is a reminder blink, lights only. If the target changed to a
    // non-light while set to flash, fall back to a plain "turn on".
    const canFlash = !runMode && !thermoMode && !dev?.kind;
    if (rule.action.type === 'flash' && !canFlash) {
      rule.action = { type: 'setLevel', zone: rule.action.zone ?? null, ...(rule.action.zones?.length ? { zones: rule.action.zones } : {}), level: 100, fadeSec: 0 };
    }
    // When an "on at X%" rule targets a mix of dimmers and on/off devices, the
    // brightness only lands on the dimmers (switches/plugs snap fully on), so
    // spell that out. Updated live as devices are picked (no full redraw).
    const dimNote = el('div', { class: 'sm:col-start-2 hint -mt-1' });
    const updateDimNote = () => {
      const nonDim = selectedZones().map((id) => zones.find((z) => z.id === id))
        .filter((z) => z && !z.dimmable && z.kind !== 'thermostat');
      const show = uiAction() === 'on' && dimmable && nonDim.length > 0;
      dimNote.classList.toggle('hidden', !show);
      if (show) dimNote.textContent = `Brightness applies to dimmers only. The ${nonDim.length} on/off device${nonDim.length > 1 ? 's' : ''} here will just turn on.`;
    };
    updateDimNote();

    // on/off wording follows the (plain) device kind so a rule reads naturally
    // ("Lock" / "Open" / "Arm", not "Turn on"). Before a plain device is picked
    // we can't know if it dims, so show the inclusive "Turn on / set brightness"
    // — it collapses to a bare "Turn on" only once a non-dimmer is actually
    // selected, and stays on the brightness wording for a dimmer.
    const onVerb = { shade: 'Open', alarm: 'Arm', bypass: 'Bypass', lock: 'Lock', vacuum: 'Start' }[plainDev?.kind]
      ?? (!plainDev || dimmable ? 'Turn on / set brightness' : 'Turn on');
    const offVerb = { shade: 'Close', alarm: 'Disarm', bypass: 'Restore', lock: 'Unlock', vacuum: 'Dock' }[plainDev?.kind] ?? 'Turn off';
    const anyPlainLight = plainZones.some((z) => !z.kind);
    // The full action set is ALWAYS offered (Turn on, Thermostat, Run automation,
    // …); the chosen action decides which devices the picker shows, so you can
    // freely switch families and are never stuck.
    const actionOptions = [
      ['on', onVerb],
      ['off', offVerb],
      ...(anyPlainLight ? [['flash', 'Flash (reminder)']] : []),
      ...(thermostats.length ? [['thermostat', 'Thermostat']] : []),
      ...(scenes.length ? [['sceneStart', 'Start scene'], ['sceneEnd', 'End scene']] : []),
      ...(autos.length ? [['runAutomation', 'Run automation'], ['enableAutomation', 'Enable automation'], ['disableAutomation', 'Disable automation']] : []),
    ];

    mount(clear(root),
      el('div', { class: 'flex items-center gap-3 mb-4' },
        inhOpts.badge && el('span', { class: `shrink-0 ${inhOpts.badge === 'Edited' ? 'badge-on' : 'badge-info'}`, title: inhOpts.badge === 'Edited' ? 'Customized copy of a Regular rule' : 'Added just for this situation' }, inhOpts.badge),
        el('input', {
          class: 'input !py-2 flex-1', placeholder: 'Name this rule (e.g. “Dining room on for the meal”)',
          value: rule.label ?? '', oninput: (e) => { rule.label = e.target.value; },
        }),
        inhOpts.onRevert && el('button', { class: 'btn-secondary btn-sm shrink-0', title: 'Discard this customization and use the Regular rule again', onclick: inhOpts.onRevert }, 'Revert'),
        el('button', { class: 'icon-btn', title: 'Duplicate rule', onclick: onDuplicate }, icon('copy', 'w-5 h-5')),
        el('button', { class: 'icon-btn text-rose-500 hover:!text-rose-600', title: 'Delete rule', onclick: onDelete }, icon('trash'))),

      el('div', { class: 'grid sm:grid-cols-[auto_1fr] gap-x-4 gap-y-2 items-center mb-3' },
        el('span', { class: 'text-sm font-semibold uppercase tracking-wide text-stone-400' }, 'What'),
        el('div', { class: 'flex flex-wrap items-center gap-2' },
          // Starts unset ("Choose action…", yellow) like the device/WHEN pickers;
          // the placeholder drops out once an action is chosen, and save blocks
          // until then.
          select([...(uiAction() ? [] : [['', 'Choose action…']]), ...actionOptions], uiAction(), (v) => {
            if (v === '') return;
            // keep whatever compatible device(s) are already picked; otherwise
            // clear so the picker prompts for one from the new family (never stuck)
            const kept = (pool) => {
              const cur = selectedZones().filter((id) => pool.some((z) => z.id === id));
              if (cur.length) return { zone: cur[0], zones: cur };
              return pool.length === 1 ? { zone: pool[0].id, zones: [pool[0].id] } : { zone: null };
            };
            if (v === 'runAutomation' || v === 'enableAutomation' || v === 'disableAutomation') {
              runMode = true; thermoMode = false;
              const keepA = kept(autos);
              rule.action = v === 'runAutomation'
                ? { type: 'setLevel', ...keepA, level: 100, fadeSec: 0 }
                : { type: 'setAutomation', ...keepA, enabled: v === 'enableAutomation' };
              redraw(); return;
            }
            if (v === 'thermostat') {
              runMode = false; thermoMode = true;
              rule.action = { type: 'setLevel', ...kept(thermostats), level: rule.action.level > 0 && rule.action.level <= 95 ? rule.action.level : 70, fadeSec: 0 };
              redraw(); return;
            }
            runMode = false; thermoMode = false;
            if (v === 'sceneStart' || v === 'sceneEnd') { rule.action = { type: v, sceneId: rule.action.sceneId ?? scenes[0]?.id }; redraw(); return; }
            const keep = kept(plainZones);
            if (v === 'flash') rule.action = { type: 'flash', ...keep, times: 1 };
            else if (v === 'off') rule.action = { type: 'setLevel', ...keep, level: 0, fadeSec: rule.action.fadeSec ?? 0 };
            else rule.action = { type: 'setLevel', ...keep, level: 100, fadeSec: rule.action.fadeSec ?? 0 };
            redraw();
          }, `select !w-auto${uiAction() ? '' : ' !border-accent-400'}`),
          // no device picker until an action is chosen
          !uiAction() ? null : isScene()
            ? select(scenes.map((s) => [s.id, s.name ?? s.id]), rule.action.sceneId, (v) => { rule.action.sceneId = v; }, 'select !w-auto')
            : multiDeviceSelect(
              uiAction() === 'thermostat' ? thermostats : (runMode ? autos : plainZones),
              selectedZones, (sel) => {
                // keep the panel OPEN while picking several devices: only a
                // primary-device change that alters the controls forces a redraw
                const beforeSel = selectedZones();
                const before = device();
                rule.action.zones = sel;
                rule.action.zone = sel[0]; // legacy single-zone field mirrors the first pick
                const after = device();
                // whether the SELECTION as a whole exposes a color / white-temp
                // control (any rgb / colorTemp light in it) — so adding or removing
                // such a light must rebuild the row to show/hide that control.
                const colorCap = (ids) => {
                  const zs = ids.map((id) => zones.find((z) => z.id === id)).filter(Boolean);
                  return `${zs.some((z) => z.rgb)}|${zs.some((z) => z.colorTemp)}`;
                };
                // a different thermostat may expose different preset/hvac modes, so
                // its sub-select must rebuild; plain devices redraw on a dimmable/
                // kind change or when the color capability appears/disappears
                // (otherwise the picker stays open for fast multi-select)
                const anyDim = (ids) => ids.some((id) => zones.find((z) => z.id === id)?.dimmable);
                const needsRedraw = thermoMode
                  ? before?.id !== after?.id
                  : (after?.dimmable ?? true) !== (before?.dimmable ?? true) || after?.kind !== before?.kind
                    // the brightness field appears/disappears with the first/last dimmer
                    || anyDim(beforeSel) !== anyDim(sel)
                    || colorCap(beforeSel) !== colorCap(sel);
                if (!runMode && needsRedraw) redraw();
                else updateDimNote(); // primary unchanged: just refresh the mixed-devices note in place
              },
              uiAction() === 'thermostat' ? 'Choose a thermostat…' : (runMode ? 'Choose an automation…' : 'Choose a device…')),
          // thermostat sub-action: hold / resume / mode / heat-cool-off
          uiAction() === 'thermostat' && select(
            [['hold', 'Hold temperature'], ['resume', 'Resume program'],
              ...(dev?.presetModes?.length ? [['preset', 'Set mode']] : []),
              ...(dev?.hvacModes?.length ? [['hvac', 'Heat / cool / off']] : [])],
            thermoAction(), (v) => setThermoAction(v, dev), 'select !w-auto'),
          ((uiAction() === 'on' && dimmable) || (uiAction() === 'thermostat' && thermoAction() === 'hold')) && (() => {
            // thermostats show/edit in the device's unit (stored in °F); the
            // rule input was hardcoded to °F and ignored a °C thermostat
            const tUnit = thermo ? tempUnit(dev) : 'F';
            return el('span', { class: 'inline-flex items-center gap-1.5' },
              'at',
              el('input', {
                class: 'input !w-20 !py-2 text-center', type: 'number',
                min: thermo ? (tUnit === 'C' ? 7 : 45) : 1,
                max: thermo ? (tUnit === 'C' ? 35 : 95) : 100,
                value: thermo ? fToDisplay(rule.action.level ?? 70, tUnit) : (rule.action.level ?? 100),
                oninput: (e) => { rule.action.level = thermo ? displayToF(Number(e.target.value), tUnit) : Number(e.target.value); },
              }), thermo ? `°${tUnit}` : '%');
          })(),
          // optional light color: an RGB palette when the target(s) support it,
          // otherwise a warm↔cool white slider for color-temp-only lights. A
          // compact checkbox (with a live color dot) opts in on the row; the
          // palette/slider then drops to its own full-width line below so the
          // wide swatch strip never wraps awkwardly mid-row.
          uiAction() === 'on' && (() => {
            const sel = selectedZones().map((id) => zones.find((z) => z.id === id)).filter(Boolean);
            if (sel.some((z) => z.rgb)) {
              const dot = el('span', {
                class: 'w-3.5 h-3.5 rounded-full ring-1 ring-black/15 dark:ring-white/20 shrink-0',
                style: `background:${rule.action.rgb != null ? rgbToHex(rule.action.rgb) : 'transparent'}`,
              });
              const toggle = el('label', { class: 'inline-flex items-center gap-1.5 cursor-pointer text-sm shrink-0' },
                el('input', {
                  type: 'checkbox', class: 'checkbox', checked: rule.action.rgb != null,
                  onchange: (e) => { if (e.target.checked) { rule.action.rgb = rule.action.rgb ?? [245, 158, 11]; delete rule.action.kelvin; } else delete rule.action.rgb; redraw(); },
                }),
                rule.action.rgb != null ? el('span', { class: 'inline-flex items-center gap-1.5' }, dot, 'Color') : 'color');
              const palette = rule.action.rgb != null ? el('div', { class: 'basis-full flex items-center gap-2 pl-1 pb-1' },
                colorControl(rule.action.rgb, (rgb) => { rule.action.rgb = rgb; dot.style.background = rgbToHex(rgb); })) : null;
              return [toggle, palette];
            }
            if (sel.some((z) => z.colorTemp)) {
              const kLabel = el('span', { class: 'text-sm text-stone-500 tabular-nums' }, rule.action.kelvin != null ? `${rule.action.kelvin}K` : '');
              const toggle = el('label', { class: 'inline-flex items-center gap-1.5 cursor-pointer text-sm shrink-0' },
                el('input', {
                  type: 'checkbox', class: 'checkbox', checked: rule.action.kelvin != null,
                  onchange: (e) => { if (e.target.checked) rule.action.kelvin = rule.action.kelvin ?? 3000; else delete rule.action.kelvin; redraw(); },
                }),
                el('span', { class: 'text-amber-500 shrink-0' }, icon('sun', 'w-4 h-4')),
                rule.action.kelvin != null ? kLabel : 'white');
              const slider = rule.action.kelvin != null ? el('div', { class: 'basis-full flex items-center gap-2 pl-1 pb-1' },
                el('input', {
                  type: 'range', class: 'ct-slider w-40', min: 2200, max: 6500, step: 50, value: rule.action.kelvin,
                  oninput: (e) => { rule.action.kelvin = Number(e.target.value); kLabel.textContent = `${rule.action.kelvin}K`; },
                })) : null;
              return [toggle, slider];
            }
            return null;
          })(),
          uiAction() === 'thermostat' && thermoAction() === 'preset' && dev?.presetModes?.length && el('span', { class: 'inline-flex items-center gap-1.5' }, 'to',
            select(dev.presetModes.map((m) => [m, presetLabel(m)]), rule.action.preset ?? dev.presetModes[0], (v) => { rule.action.preset = v; }, 'select !w-auto')),
          uiAction() === 'thermostat' && thermoAction() === 'hvac' && dev?.hvacModes?.length && el('span', { class: 'inline-flex items-center gap-1.5' }, 'to',
            select(dev.hvacModes.map((m) => [m, hvacLabel(m)]), rule.action.hvacMode ?? dev.hvacModes[0], (v) => { rule.action.hvacMode = v; }, 'select !w-auto')),
          uiAction() === 'flash' && el('span', { class: 'inline-flex items-center gap-1.5' },
            select([['1', 'once'], ['2', 'twice']],
              String(rule.action.times ?? (rule.action.seconds >= 4 ? 2 : 1)), // legacy rules stored seconds 2/4
              (v) => { rule.action.times = Number(v); delete rule.action.seconds; }, 'select !w-auto'))),
        uiAction() === 'flash' && el('div', { class: 'sm:col-start-2 hint -mt-1' },
          'A quick reminder blink, e.g. flash the lights before candle lighting.'),
        dimNote),

      el('div', { class: 'grid sm:grid-cols-[auto_1fr] gap-x-4 gap-y-2 items-center' },
        el('span', { class: 'text-sm font-semibold uppercase tracking-wide text-stone-400' }, 'When'),
        el('div', { class: 'flex flex-wrap items-center gap-2' },
          // Starts unset ("Choose when…", yellow-bordered like the device
          // picker) so a fresh rule has no default time; save blocks until picked.
          // The placeholder drops out of the list once a kind is chosen.
          select([...(t().kind ? [] : [['', 'Choose when…']]), ['zman', 'Relative to a zman'], ['fixed', 'At a fixed time']], t().kind ?? '', (v) => {
            if (v === '') return;
            // fresh zman rule: leave the offset UNSET so the before/at/after
            // comparator is chosen first and the hr/min boxes only then appear.
            if (v === 'fixed') rule.trigger = { kind: 'fixed', time: t().time ?? '18:00', nextDay: t().nextDay ?? false, day: t().day, clamp: t().clamp ?? {}, conditions: t().conditions ?? [] };
            else rule.trigger = { kind: 'zman', zman: t().zman ?? 'sunset', offsetMin: t().offsetMin, day: t().day, clamp: t().clamp ?? {}, conditions: t().conditions ?? [] };
            redraw();
          }, `select !w-auto${t().kind ? '' : ' !border-accent-400'}`),
          !t().kind
            ? null
            : t().kind === 'zman'
            ? el('span', { class: 'inline-flex flex-wrap items-center gap-2' },
              // Comparator FIRST (before / exactly at / after), unset until
              // chosen. The hr+min boxes appear only once "before" or "after" is
              // picked — "exactly at" needs no offset. Reads "1h 40m before
              // sunset" / "exactly at sunset".
              select([...(t().offsetMin == null ? [['', 'before / at / after…']] : []), ['before', 'before'], ['at', 'exactly at'], ['after', 'after']],
                t().offsetMin == null ? '' : (t().offsetMin === 0 ? 'at' : t().offsetMin < 0 ? 'before' : 'after'),
                (v) => {
                  if (v === '') return;
                  if (v === 'at') t().offsetMin = 0;
                  else { const mag = Math.abs(t().offsetMin || 60); t().offsetMin = v === 'before' ? -mag : mag; }
                  redraw();
                }, `select !w-auto${t().offsetMin == null ? ' !border-accent-400' : ''}`),
              (t().offsetMin != null && t().offsetMin !== 0) && el('span', { class: 'inline-flex items-center gap-1.5' },
                (() => {
                  const mag = () => Math.abs(t().offsetMin ?? 0);
                  const setMag = (m) => { t().offsetMin = ((t().offsetMin ?? 0) < 0 ? -1 : 1) * Math.max(1, m); };
                  const mins = el('input', {
                    class: 'input !w-16 !py-2 text-center', type: 'number', min: 0, max: 59,
                    value: mag() % 60,
                    oninput: (e) => setMag(Number(hours.value === '--' ? 0 : hours.value) * 60 + (Math.abs(Number(e.target.value)) || 0)),
                  });
                  const hours = select(
                    [['--', '--'], ...Array.from({ length: 12 }, (_, i) => [String(i + 1), String(i + 1)])],
                    mag() >= 60 ? String(Math.floor(mag() / 60)) : '--',
                    (v) => setMag((v === '--' ? 0 : Number(v)) * 60 + (Math.abs(Number(mins.value)) || 0)),
                    'select !w-auto');
                  return el('span', { class: 'inline-flex items-center gap-1.5' }, hours, 'hr', mins, 'min');
                })()),
              select(ZMANIM, t().zman, (v) => {
                t().zman = v;
                // "chatzos of the night" means the coming night's midnight: a
                // Friday-evening rule should land Friday night → early Saturday.
                // chatzotNight(X) is the midnight leading INTO X, so that needs
                // the next civil day. Auto-tick it on select; clear it otherwise.
                t().nextDay = v === 'chatzotNight';
                redraw();
              }, 'select !w-auto max-w-full'),
              // Only chatzos of the night can fall after midnight relative to its
              // section, so it's the one zman that needs the day made explicit.
              t().zman === 'chatzotNight' && el('label', { class: 'check-row !py-0' },
                el('input', { class: 'checkbox !w-4.5 !h-4.5', type: 'checkbox', checked: t().nextDay ?? false, onchange: (e) => { t().nextDay = e.target.checked; } }),
                el('span', { class: 'text-sm' }, 'after midnight (next day)')))
            : el('span', { class: 'inline-flex flex-wrap items-center gap-3' },
              el('input', {
                class: 'input !w-40 !py-2', type: 'time', value: t().time ?? '18:00',
                oninput: (e) => { t().time = e.target.value; },
              }),
              el('label', { class: 'check-row !py-0' },
                el('input', { class: 'checkbox !w-4.5 !h-4.5', type: 'checkbox', checked: t().nextDay ?? false, onchange: (e) => { t().nextDay = e.target.checked; } }),
                el('span', { class: 'text-sm' }, 'after midnight (next day)'))))),

      advancedSection(rule),
    );
    return root;
  };

  return redraw();
}

/** Clamp time field with a clear ✕, iOS time inputs can't be emptied by hand. */
function clampInput(rule, key) {
  const t = rule.trigger;
  const input = el('input', {
    class: 'input !w-40 max-w-full !py-2', type: 'time', value: t.clamp?.[key] ?? '',
    oninput: (e) => { t.clamp = { ...t.clamp, [key]: e.target.value || null }; },
  });
  const clear = el('button', {
    class: 'icon-btn !w-8 !h-8 shrink-0', title: 'Clear',
    onclick: () => { t.clamp = { ...t.clamp, [key]: null }; input.value = ''; },
  }, icon('x', 'w-4 h-4'));
  return el('span', { class: 'inline-flex items-center gap-1.5 max-w-full' }, input, clear);
}

function advancedSection(rule) {
  const t = rule.trigger;
  const open = advancedIsInteresting(t);
  return el('details', { class: 'mt-4 group', ...(open ? { open: true } : {}) },
    el('summary', { class: 'cursor-pointer text-[15px] font-medium text-stone-500 dark:text-stone-400 flex items-center gap-1.5 select-none list-none' },
      icon('chevronRight', 'w-4 h-4 transition-transform group-open:rotate-90'),
      'Fine-tuning', open && el('span', { class: 'badge-on !text-xs' }, 'active')),
    el('div', { class: 'mt-3 pl-1 space-y-4' },
      el('div', { class: 'flex flex-wrap gap-x-8 gap-y-4' },
        field('Never earlier than', clampInput(rule, 'notBefore'),
          'Winter guard, e.g. don’t re-light the kitchen before the meal ends.'),
        field('Never later than', clampInput(rule, 'notAfter'))),
      el('div', {},
        el('label', { class: 'label' }, 'Seasonal conditions'),
        conditionEditor(t))));
}

function advancedIsInteresting(t) {
  return Boolean(t.clamp?.notBefore || t.clamp?.notAfter || t.conditions?.length);
}

/**
 * Condition rows read as sentences:
 *   "If <zman> is after/before <HH:MM> → fire at <fixed | zman ± offset>"
 * First match replaces the trigger (the early-Shabbos pin).
 */
function conditionEditor(t) {
  t.conditions ??= [];
  const wrap = el('div', { class: 'space-y-2.5' });

  const draw = () => {
    mount(clear(wrap),
      t.conditions.length === 0 && el('p', { class: 'hint' },
        'None, the time above always applies. Add one for things like “once sunset is past 7pm, always start at 5:30pm” (early Shabbos).'),
      t.conditions.map((c, idx) => conditionRow(c, idx)),
      el('div', { class: 'flex items-center gap-3 flex-wrap' },
        el('button', {
          class: 'btn-secondary btn-sm',
          onclick: () => {
            t.conditions.push({
              if: { zman: 'sunset', cmp: 'after', time: '19:00', day: t.day },
              then: { kind: 'fixed', time: '17:30', day: t.day },
            });
            draw();
          },
        }, icon('plus', 'w-4 h-4'), 'Add condition'),
        t.conditions.length > 1 && el('span', { class: 'hint' }, 'Checked top to bottom, first match wins.')));
  };

  const conditionRow = (c, idx) => {
    const thenControls = () => (c.then.kind ?? 'fixed') === 'fixed'
      ? el('input', {
        class: 'input !w-36 !py-2', type: 'time', value: c.then.time ?? '17:30',
        oninput: (e) => { c.then.time = e.target.value; },
      })
      // flex-wrap + max-w-full: the zman <select> can't shrink below its
      // widest option, so on phones it must wrap to its own line, not clip.
      // The minutes box is hidden when the mode is "exactly at" (offsetMin 0),
      // so the row reads "exactly at sunset" / "30 min before sunset".
      : el('span', { class: 'inline-flex flex-wrap items-center gap-2 max-w-full' },
        (c.then.offsetMin ?? 0) !== 0 && el('span', { class: 'inline-flex items-center gap-2' },
          el('input', {
            class: 'input !w-20 !py-2 text-center', type: 'number', min: 0, max: 720, value: Math.abs(c.then.offsetMin ?? 0),
            oninput: (e) => { const mag = Math.max(1, Math.abs(Number(e.target.value))); c.then.offsetMin = (c.then.offsetMin ?? 0) < 0 ? -mag : mag; },
          }),
          'min'),
        select([['at', 'exactly at'], ['before', 'before'], ['after', 'after']],
          (c.then.offsetMin ?? 0) === 0 ? 'at' : ((c.then.offsetMin ?? 0) < 0 ? 'before' : 'after'),
          (v) => {
            if (v === 'at') c.then.offsetMin = 0;
            else { const mag = Math.abs(c.then.offsetMin || 30); c.then.offsetMin = v === 'before' ? -mag : mag; }
            draw();
          }, 'select !w-auto max-w-full'),
        select(ZMANIM, c.then.zman ?? 'sunset', (v) => { c.then.zman = v; }, 'select !w-auto max-w-full'));

    return el('div', { class: 'relative rounded-xl border border-stone-200 dark:border-stone-700 p-3.5 pr-10 space-y-2.5' },
      // the delete X floats in the corner so it never opens gaps in the
      // wrapped control rows on phones
      el('button', {
        class: 'icon-btn absolute top-1.5 right-1.5 !w-8 !h-8 text-rose-500', title: 'Remove condition',
        onclick: () => { t.conditions.splice(idx, 1); draw(); },
      }, icon('x', 'w-4 h-4')),
      el('div', { class: 'flex flex-wrap items-center gap-2' },
        el('span', { class: 'text-stone-500 font-medium' }, 'If'),
        select(ZMANIM, c.if.zman, (v) => { c.if.zman = v; }, 'select !w-auto max-w-full'),
        select([['after', 'is after'], ['before', 'is before']], c.if.cmp, (v) => { c.if.cmp = v; }, 'select !w-auto max-w-full'),
        el('input', {
          class: 'input !w-36 !py-2 max-w-full', type: 'time', value: c.if.time,
          oninput: (e) => { c.if.time = e.target.value; },
        })),
      el('div', { class: 'flex flex-wrap items-center gap-2' },
        el('span', { class: 'text-stone-500 font-medium' }, 'then'),
        select([['fire', 'fire'], ['skip', "don't fire (skip this rule)"]], c.then.skip ? 'skip' : 'fire', (v) => {
          c.then = v === 'skip'
            ? { skip: true, day: t.day }
            : { kind: 'fixed', time: c.then.time ?? '17:30', day: t.day };
          draw();
        }, 'select !w-auto max-w-full'),
        !c.then.skip && select([['fixed', 'at a fixed time'], ['zman', 'relative to a zman']], c.then.kind ?? 'fixed', (v) => {
          c.then = v === 'fixed'
            ? { kind: 'fixed', time: c.then.time ?? '17:30', day: t.day }
            : { kind: 'zman', zman: c.then.zman ?? 'sunset', offsetMin: c.then.offsetMin ?? 0, day: t.day };
          draw();
        }, 'select !w-auto max-w-full'),
        !c.then.skip && thenControls()));
  };

  draw();
  return wrap;
}

// Approximate time-of-day rank for each zman (minutes past midnight), used to
// sort rules chronologically on save so the list mirrors the preview order.
const ZMAN_RANK = {
  alotHaShachar: 300, sunrise: 360, sofZmanShma: 540, sofZmanTfilla: 600,
  chatzot: 720, minchaGedola: 810, minchaKetana: 960, plagHaMincha: 1050,
  candleLighting: 1120, sunset: 1140, havdalah: 1200, tzeit: 1205, chatzotNight: 1470,
};

function ruleSortKey(rule) {
  const t = rule.trigger ?? {};
  // A not-yet-configured WHEN (no kind, or a zman rule whose before/at/after
  // isn't chosen) has no real time, so sort it to the very bottom of the list —
  // a freshly added rule sits at the end until its time is set. Such rules can't
  // be saved (validation blocks them), so this never affects persisted order.
  if (!t.kind || (t.kind === 'zman' && t.offsetMin == null)) return Number.MAX_SAFE_INTEGER;
  const dayOffset = t.day === 'erev' ? -1440 : 0;
  let base;
  if (t.kind === 'fixed') {
    const [h, m] = (t.time ?? '18:00').split(':').map(Number);
    base = h * 60 + m + (t.nextDay ? 1440 : 0);
  } else {
    base = (ZMAN_RANK[t.zman] ?? 1140) + (t.offsetMin ?? 0);
  }
  return dayOffset + base;
}

/** Sort rules chronologically (erev first, then by resolved time-of-day). */
export function sortRulesByTime(rules) {
  return [...rules].sort((a, b) => ruleSortKey(a) - ruleSortKey(b));
}

/** Conditions evaluate on the same day reference as their rule's trigger. */
/**
 * Impossible setups that must block save: clamp bounds that can never both
 * hold, and condition pairs on the same zman that can never both be true
 * (e.g. "sunset is after 7pm" + "sunset is before 6pm", almost certainly a
 * mis-entered range). Returns [{ rule, message }].
 */
export function findRuleContradictions(rules, scenes = []) {
  const errors = [];
  const name = (r) => `"${r.label || 'unnamed rule'}"`;
  for (const r of rules) {
    const a = r.action ?? {};
    // A fresh rule starts with no action / no WHEN chosen; block until each is set.
    if (!a.type) errors.push({ rule: r, message: `${name(r)}: choose what this rule does before saving.` });
    if (!r.trigger?.kind) errors.push({ rule: r, message: `${name(r)}: choose when this rule should run before saving.` });
    // a zman rule needs its before / exactly at / after chosen (offset unset)
    else if (r.trigger.kind === 'zman' && r.trigger.offsetMin == null) errors.push({ rule: r, message: `${name(r)}: choose before, exactly at, or after for this rule before saving.` });
    if (a.type === 'setLevel' || a.type === 'flash') {
      const targets = (a.zones?.length ? a.zones : [a.zone]).filter((z) => z != null);
      if (targets.length === 0) errors.push({ rule: r, message: `${name(r)}: choose a device for this rule before saving.` });
    } else if ((a.type === 'sceneStart' || a.type === 'sceneEnd') && a.sceneId == null) {
      errors.push({ rule: r, message: `${name(r)}: choose a scene for this rule before saving.` });
    } else if (a.type === 'sceneEnd' && !sceneEndDoesSomething(a.sceneId, scenes)) {
      // "End scene" on a scene with no end actions silently does nothing (the
      // engine leaves every device as-is), so flag it before save.
      const sceneName = scenes.find((sc) => sc.id === a.sceneId)?.name;
      const label = sceneName ? `“${sceneName}”` : 'that scene';
      errors.push({ rule: r, message: sceneIsFlashOnly(a.sceneId, scenes)
        ? `${name(r)}: ${label} only flashes reminders, which hold no state, so ending it does nothing. Remove this rule.`
        : `${name(r)}: ${label} has no end behavior set, so ending it would do nothing. Open the scene and turn on “Customize what happens when the scene ends” first.` });
    }
    const t = r.trigger ?? {};
    const c = t.clamp ?? {};
    if (c.notBefore && c.notAfter && c.notBefore > c.notAfter) {
      errors.push({ rule: r, message: `${name(r)}: “Never earlier than” (${c.notBefore}) is later than “Never later than” (${c.notAfter}), the bounds can never both hold.` });
    }
    const conds = t.conditions ?? [];
    for (let i = 0; i < conds.length; i++) {
      for (let j = i + 1; j < conds.length; j++) {
        const a = conds[i].if; const b = conds[j].if;
        if (!a || !b || a.zman !== b.zman || a.cmp === b.cmp) continue;
        const after = a.cmp === 'after' ? a : b;
        const before = a.cmp === 'after' ? b : a;
        if (before.time <= after.time) {
          errors.push({ rule: r, message: `${name(r)}: conditions “${a.zman} is after ${after.time}” and “is before ${before.time}` + '” contradict, they can never both be true.' });
        }
      }
    }
  }
  return errors;
}

/**
 * Would ending this scene actually change anything? True only if the scene (or,
 * by inheritance, the scene it extends) resolves to at least one end action. A
 * scene with no endActions — or an explicitly EMPTY endActions, which is what
 * you get from a flash-only reminder scene or from enabling "customize end" but
 * leaving every device on "skip" — resolves to a no-op, so ending it does
 * nothing. That is the case the editor blocks.
 */
function sceneEndDoesSomething(sceneId, scenes, seen = new Set()) {
  const s = scenes.find((x) => x.id === sceneId);
  if (!s || seen.has(sceneId)) return false;
  if (Array.isArray(s.endActions)) return s.endActions.length > 0;
  seen.add(sceneId);
  return s.extends ? sceneEndDoesSomething(s.extends, scenes, seen) : false;
}

/** A standalone scene whose only actions are reminder flashes (no stateful
 *  devices) — so it has no end state to restore, and its "customize end" toggle
 *  is disabled. Child scenes are judged generically (return false). */
function sceneIsFlashOnly(sceneId, scenes) {
  const s = scenes.find((x) => x.id === sceneId);
  if (!s || s.extends) return false;
  const acts = s.actions ?? [];
  return acts.length > 0 && acts.every((a) => a.flash != null);
}

export function syncConditionDays(rules) {
  for (const r of rules) {
    for (const c of r.trigger?.conditions ?? []) {
      c.if.day = r.trigger.day;
      c.then.day = r.trigger.day;
    }
  }
  return rules;
}
