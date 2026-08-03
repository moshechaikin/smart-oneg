import { api } from '../api.js';
import { el, clear, mount, fmtDateTime, fmtTime, modal, pageHeader, localISO, todayISO, variantLabel } from '../ui.js';
import { icon } from '../icons.js';
import { timelineView, clusterDayLabels, guestOverlayToggle, guestPreviewNote } from '../components/timeline.js';
import { pdfSplitButton } from '../components/pdf-buttons.js';

let viewYear; let viewMonth; // 0-based
let jumpDate = null; // a date to open + highlight, from a deep link (e.g. a schedule preview)

export async function calendarPage() {
  const now = new Date();
  // deep link: #/calendar?date=YYYY-MM-DD opens that month and flags the day
  const dl = new URLSearchParams(location.hash.split('?')[1] || '').get('date');
  if (dl && /^\d{4}-\d{2}-\d{2}$/.test(dl)) {
    const [ty, tm] = dl.split('-').map(Number);
    viewYear = ty; viewMonth = tm - 1; jumpDate = dl;
  }
  viewYear ??= now.getFullYear();
  viewMonth ??= now.getMonth();
  const container = el('div', { class: 'space-y-5' });
  await renderMonth(container);
  if (jumpDate) {
    jumpDate = null; // highlight only on this deep-linked render
    requestAnimationFrame(() => container.querySelector('.cal-jump')?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
  }

  // Left / right arrow keys page through months. The listener self-cleans once
  // the calendar leaves the DOM, and stays out of the way while you're typing
  // in a field or a modal (like a cluster preview) is open.
  const onKey = (e) => {
    if (!container.isConnected) { document.removeEventListener('keydown', onKey); return; }
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target.closest('input, textarea, select, [contenteditable]')) return;
    if (document.querySelector('.modal-bd-in')) return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); shift(-1); renderMonth(container); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); shift(1); renderMonth(container); }
  };
  document.addEventListener('keydown', onKey);

  return container;
}

async function renderMonth(container) {
  const first = new Date(viewYear, viewMonth, 1);
  const from = localISO(new Date(viewYear, viewMonth, -6));
  const to = localISO(new Date(viewYear, viewMonth + 1, 7));
  const [clusters, heDates] = await Promise.all([
    api.get(`/api/calendar?from=${from}&to=${to}`),
    api.get(`/api/hebrew-dates?from=${from}&to=${to}`).catch(() => []),
  ]);
  const heByDate = new Map(heDates.map((h) => [h.date, h]));

  const byDate = new Map();      // assur days
  const erevByDate = new Map();  // candle-lighting/prep days
  const endByDate = new Map();   // last day of each cluster (havdalah)
  for (const c of clusters) {
    for (const d of c.days) byDate.set(d.date, { day: d, cluster: c });
    if (!byDate.has(c.erevDate)) erevByDate.set(c.erevDate, c);
    endByDate.set(c.days[c.days.length - 1].date, c);
  }

  const monthName = first.toLocaleString(undefined, { month: 'long', year: 'numeric' });
  const startPad = first.getDay();
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const today = todayISO();

  const timeRow = (ic, time, cls = 'text-accent-700/90 dark:text-accent-400/90') => el('div', {
    class: `cal-detail-flex items-center gap-1 text-[12px] leading-tight ${cls}`,
  }, icon(ic, 'w-3 h-3 shrink-0'), fmtTime(time));

  const cells = [];
  for (let i = 0; i < startPad; i++) cells.push(el('div', {}));
  for (let d = 1; d <= daysInMonth; d++) {
    const iso = `${viewYear}-${String(viewMonth + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const hit = byDate.get(iso);
    const erev = erevByDate.get(iso);
    const clusterEnd = endByDate.get(iso);
    const he = heByDate.get(iso);
    const chm = !hit && !erev && he?.cholHamoed; // Chol Hamoed day (not assur)
    // Hoshanah Rabbah = last Chol Hamoed day AND Erev Shmini Atzeres, name it
    const hrName = he?.cholHamoed && /hoshana/i.test(he.cholHamoed) ? 'Hoshanah Rabbah' : null;
    const isToday = iso === today;
    const base = 'cal-cell rounded-lg sm:rounded-xl border p-1 sm:p-1.5 text-left flex flex-col items-start transition-[filter,border-color]';
    // Only Yom Tov / Shabbos and their erev open a modal; plain weekdays and
    // Chol Hamoed (not erev/Shabbos) do nothing on click, so they get no hover
    // affordance or pointer cursor.
    const clickable = Boolean(hit || erev);
    let cls;
    if (hit) cls = 'bg-accent-100/70 border-accent-300 dark:bg-accent-600/15 dark:border-accent-600/50';
    else if (erev) cls = 'bg-accent-50 border-accent-200 border-dashed dark:bg-accent-600/[0.07] dark:border-accent-600/40';
    else if (chm) cls = 'bg-stone-100/80 border-stone-200 dark:bg-stone-800/50 dark:border-stone-700';
    else cls = 'border-stone-200 dark:border-stone-800';
    // subtle hover: a gentle brightness lift + firmer border, instead of flooding
    // the already-amber cell with bright yellow.
    const hover = clickable
      ? 'cursor-pointer hover:brightness-95 dark:hover:brightness-125 hover:border-accent-400 dark:hover:border-accent-500/80'
      : 'cursor-default';
    const isJump = iso === jumpDate;
    cells.push(el('button', {
      class: `${base} ${cls} ${hover} ${isToday ? 'ring-2 ring-accent-500' : ''} ${isJump ? 'cal-jump ring-2 ring-accent-500 value-flash' : ''}`,
      'aria-label': hit ? hit.day.holidayLabel : (erev ? erev.erevLabel : undefined),
      onclick: () => { const c = hit?.cluster ?? erev; if (c) showCluster(c); },
    },
      // number pinned to the very top-left corner; marker icon top-right.
      // Civil day + Hebrew day (Hebrew numerals) side by side.
      el('div', { class: 'w-full flex items-start justify-between gap-0.5' },
        el('span', { class: 'flex items-baseline gap-1.5' },
          el('span', {
            class: `text-[13px] sm:text-[16px] leading-none font-semibold ${hit || erev ? 'text-accent-800/80 dark:text-accent-300/80' : 'text-stone-500 dark:text-stone-400'}`,
          }, String(d)),
          he && el('span', {
            class: `cal-heb text-[12px] leading-none ${he.monthStart ? 'font-semibold text-accent-600 dark:text-accent-400' : 'text-stone-400 dark:text-stone-500'}`,
            dir: 'rtl', title: he.monthStart ? `Rosh Chodesh ${he.heMonth}` : `${he.heDay} ${he.heMonth}`,
          }, he.monthStart ? `${he.heDayHe} ${he.heMonth}` : he.heDayHe)),
        hit && el('span', { class: 'text-accent-600 dark:text-accent-400' }, icon('kiddush', 'w-4 h-4')),
        erev && !hit && el('span', { class: 'text-accent-500/90' }, icon('candle', 'w-4 h-4'))),
      hit && el('div', { class: 'cal-lbl leading-snug font-medium text-accent-800 dark:text-accent-300' },
        hit.day.holidayLabel,
        hit.day.parsha && el('span', { class: 'cal-detail text-[12px] font-normal opacity-80' }, hit.day.parsha)),
      erev && !hit && el('div', { class: 'cal-lbl leading-snug text-accent-700/90 dark:text-accent-400/90' },
        hrName ?? erev.erevLabel ?? 'Erev'),
      chm && el('div', { class: 'cal-lbl leading-snug font-medium text-stone-500 dark:text-stone-400' },
        'Chol Hamoed'),
      // display-only observances: Rosh Chodesh, fasts, Chanukah, Purim,
      // Tu BiShvat, Lag BaOmer… (never modern holidays)
      he?.observances?.length > 0 && el('div', { class: 'cal-detail text-[12px] leading-snug mt-1 text-teal-700 dark:text-teal-400' },
        he.observances.join(' · ')),
      // fast times (display only). Tisha B'Av is split: begins on the erev,
      // ends (+ chatzos) on the day itself; other fasts show begins–ends.
      he?.fast && el('div', { class: 'cal-detail text-[11px] leading-snug mt-0.5 text-teal-700/80 dark:text-teal-400/80' },
        he.fast.beginsOnly ? `Fast begins ${fmtTime(he.fast.begins)}`
          : he.fast.endsOnly
            ? `Fast ends ${fmtTime(he.fast.ends)}${he.fast.chatzos ? ` · Chatzos ${fmtTime(he.fast.chatzos)}` : ''}`
            : `Fast ${fmtTime(he.fast.begins)} – ${fmtTime(he.fast.ends)}`),
      // the night's Omer count (counted the evening BEFORE this civil day, so
      // show it on the night it's said: the day before the hebrew date)
      he?.omerTonight && el('div', { class: 'cal-detail text-[11px] leading-snug mt-0.5 text-stone-400 dark:text-stone-500' },
        `Omer ${he.omerTonight} tonight`),
      he?.clockChange && el('div', { class: 'cal-detail-flex items-center gap-1 text-[12px] mt-1 text-sky-600 dark:text-sky-400' },
        icon('clock', 'w-3.5 h-3.5 shrink-0'),
        he.clockChange === 'forward' ? 'Clocks spring forward' : 'Clocks fall back'),
      // times: candle lighting + shkia on erev; havdalah (kiddush cup) on the last day
      el('div', { class: 'mt-auto w-full space-y-0.5 pt-1' },
        erev && !hit && timeRow('candle', erev.startsAt),
        erev && !hit && erev.erevSunset && timeRow('sunset', erev.erevSunset, 'text-stone-500 dark:text-stone-400'),
        clusterEnd && timeRow('kiddush', clusterEnd.endsAt)),
    ));
  }

  // Which printable-Zmanim festivals appear in the month being viewed?
  const FEST_OF = {
    'pesach-1': 'pesach', 'pesach-2': 'pesach', 'pesach-7': 'pesach', 'pesach-8': 'pesach',
    'sukkos-1': 'sukkos', 'sukkos-2': 'sukkos', 'shmini-atzeres': 'sukkos', 'simchas-torah': 'sukkos',
    'shavuos-1': 'shavuos', 'shavuos-2': 'shavuos',
    'rosh-hashanah-1': 'rosh-hashanah', 'rosh-hashanah-2': 'rosh-hashanah', 'yom-kippur': 'yom-kippur',
  };
  const FEST_LABEL = { pesach: 'Pesach', sukkos: 'Sukkos', shavuos: 'Shavuos', 'rosh-hashanah': 'Rosh Hashanah', 'yom-kippur': 'Yom Kippur' };
  const monthStartISO = `${viewYear}-${String(viewMonth + 1).padStart(2, '0')}-01`;
  // offer the Omer chart in any month with counting nights
  const omerActive = [...heByDate.values()].some((h) => {
    const dt = new Date(`${h.date}T12:00`);
    return h.omerTonight && dt.getFullYear() === viewYear && dt.getMonth() === viewMonth;
  });
  const festsInMonth = new Set();
  for (const [date, { day }] of byDate) {
    const dt = new Date(`${date}T12:00`);
    if (dt.getFullYear() === viewYear && dt.getMonth() === viewMonth && FEST_OF[day.dayType]) festsInMonth.add(FEST_OF[day.dayType]);
  }

  mount(clear(container),
    pageHeader('Calendar',
      el('div', { class: 'flex flex-wrap items-center gap-1' },
        el('button', {
          class: 'btn-secondary btn-sm mr-1.5', title: "Jump to today's month",
          onclick: () => { const n = new Date(); viewYear = n.getFullYear(); viewMonth = n.getMonth(); renderMonth(container); },
        }, icon('calendar', 'w-4 h-4'), 'Today'),
        // Keep prev / month / next together as one no-wrap unit so the arrows
        // never split across lines when the header wraps (e.g. zoomed mobile);
        // the whole switcher drops below "Today" as a block instead.
        el('div', { class: 'flex items-center gap-1 shrink-0' },
          el('button', { class: 'icon-btn', 'aria-label': 'Previous month', onclick: () => { shift(-1); renderMonth(container); } }, icon('chevronLeft')),
          // fixed min width keeps the arrows from shifting month to month, but
          // must fit a 320px screen next to the buttons
          el('span', { class: 'font-semibold text-[18px] min-w-28 sm:min-w-44 text-center' }, monthName),
          el('button', { class: 'icon-btn', 'aria-label': 'Next month', onclick: () => { shift(1); renderMonth(container); } }, icon('chevronRight'))))),

    el('div', { class: 'card !p-3 sm:!p-6' },
      // Printable Zmanim for any Yom Tov this month lives INSIDE the calendar
      // card (divider below), split buttons: labeled view + attached download
      (festsInMonth.size > 0 || omerActive) && el('div', { class: 'flex flex-wrap items-center gap-x-3 gap-y-2 pb-3 mb-3 border-b border-stone-200 dark:border-stone-800' },
        el('span', { class: 'flex items-center gap-2 font-semibold text-[15px]' }, icon('book', 'w-4 h-4 text-accent-600 dark:text-accent-400'), 'Printable Zmanim this month:'),
        // generate for the month being VIEWED (travel to 2029 → 2029's PDFs)
        ...[...festsInMonth].map((f) => pdfSplitButton(`${FEST_LABEL[f]} PDF`, `/api/pdf/yomtov/${f}?from=${monthStartISO}`)),
        omerActive && pdfSplitButton('Sefiras HaOmer PDF', `/api/pdf/omer?from=${monthStartISO}`)),
      el('div', { class: 'grid grid-cols-7 gap-1 sm:gap-1.5 text-center text-[12px] sm:text-[14px] font-semibold text-stone-500 dark:text-stone-400 mb-2' },
        [['S', 'Sun'], ['M', 'Mon'], ['T', 'Tue'], ['W', 'Wed'], ['T', 'Thu'], ['F', 'Fri'], ['Sh', 'Shabbos']].map(([short, long]) => el('div', {},
          el('span', { class: 'sm:hidden' }, short), el('span', { class: 'hidden sm:inline' }, long)))),
      el('div', { class: 'grid grid-cols-7 gap-1 sm:gap-1.5' }, cells),
      el('div', { class: 'flex flex-wrap items-center gap-x-4 gap-y-1.5 mt-4 text-[15px] text-stone-500 dark:text-stone-400' },
        el('span', { class: 'flex items-center gap-1.5' },
          el('span', { class: 'text-accent-600 dark:text-accent-400' }, icon('kiddush', 'w-4 h-4')), 'Shabbos / Yom Tov (time = havdalah)'),
        el('span', { class: 'flex items-center gap-1.5' },
          el('span', { class: 'text-accent-500' }, icon('candle', 'w-4 h-4')), 'Erev, candle lighting'),
        el('span', { class: 'flex items-center gap-1.5' },
          icon('sunset', 'w-4 h-4'), 'Shkia (sunset)'),
        el('span', { class: 'flex items-center gap-1.5' },
          el('span', { class: 'w-3.5 h-3.5 rounded border border-stone-300 bg-stone-100 dark:bg-stone-800 dark:border-stone-600' }), 'Chol Hamoed'),
        el('span', { class: 'flex items-center gap-1.5' },
          el('span', { class: 'text-accent-600 dark:text-accent-400 font-semibold' }, 'א׳ Nisan'), '= start of a Hebrew month'))),

    el('div', { class: 'space-y-3' },
      el('h3', { class: 'text-lg font-semibold' }, 'Upcoming'),
      clusters.filter((c) => new Date(c.endsAt) >= new Date()).slice(0, 6).map((c) => {
        const parsha = c.days.find((d) => d.parsha)?.parsha;
        return el('button', {
          class: 'card !p-4 w-full text-left hover:border-accent-300 dark:hover:border-accent-600 transition-colors',
          onclick: () => showCluster(c),
        },
          el('div', { class: 'flex items-center justify-between gap-3' },
            el('div', { class: 'min-w-0' },
              el('div', { class: 'font-semibold text-[16px] truncate' }, c.label, parsha ? `, ${parsha}` : ''),
              el('div', { class: 'hint flex items-center gap-1.5 flex-wrap' },
                c.erevLabel && el('span', {}, `${c.erevLabel} ·`),
                el('span', { class: 'text-accent-500 shrink-0' }, icon('candle', 'w-3.5 h-3.5')),
                fmtDateTime(c.startsAt), '→',
                el('span', { class: 'text-accent-500 shrink-0' }, icon('kiddush', 'w-3.5 h-3.5')),
                fmtDateTime(c.endsAt))),
            el('span', { class: 'text-stone-400 shrink-0' }, icon('chevronRight'))));
      })),
  );
}

function shift(n) {
  viewMonth += n;
  if (viewMonth < 0) { viewMonth = 11; viewYear--; }
  if (viewMonth > 11) { viewMonth = 0; viewYear++; }
}

async function showCluster(cluster) {
  const [timeline, zones, scenes] = await Promise.all([
    api.get(`/api/timeline?date=${cluster.days[0].date}`).catch(() => null),
    api.get('/api/zones').catch(() => []),
    api.get('/api/scenes').catch(() => []),
  ]);
  const lastDay = cluster.days[cluster.days.length - 1];
  const endsLabel = `${lastDay.dayType === 'shabbos' ? 'Shabbos' : 'Yom Tov'} ends · havdalah`;
  const first = cluster.days[0];
  let m; // modal handle, so a Days row can close it before deep-linking to Schedules
  const fmtDay = (iso) => new Date(`${iso}T12:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  // Hand off to the Schedules editor for a specific day + situation. This is the
  // reverse of the editor's "Next:" → calendar deep-link; making every listed
  // day its own target sidesteps the "which day of the cluster?" ambiguity.
  const editDay = (dayType, variant) => {
    m?.close();
    sessionStorage.setItem('schedules-open-edit', JSON.stringify({ dayType, variant: variant || 'default' }));
    location.hash = '#/schedules';
  };
  const dayRow = (dateISO, label, dayType, variant, badge = null, leadIcon = null) => el('button', {
    class: 'w-full flex items-start gap-2 text-left rounded-xl -mx-2 px-2 py-1.5 cursor-pointer transition-colors hover:bg-stone-500/10 group',
    title: 'Edit this day’s schedule', onclick: () => editDay(dayType, variant),
  },
    el('span', { class: 'text-stone-500 w-28 shrink-0 leading-6' }, fmtDay(dateISO)),
    // middle column wraps internally; the date + pencil stay as fixed side
    // columns so the pencil never spills onto its own line on a long label
    el('span', { class: 'flex-1 min-w-0 flex flex-wrap items-center gap-x-1.5 gap-y-1 leading-6' },
      leadIcon, el('span', { class: 'min-w-0 break-words' }, label), badge),
    // Persistent (dimmed) pencil, pinned right; brightens on hover. mt-1 centers
    // the 16px icon within the first 24px (leading-6) text line, so it reads
    // centered on a single-line row yet stays aligned to the first line when a
    // long label wraps to two.
    el('span', { class: 'shrink-0 mt-1 text-stone-400/70 group-hover:text-accent-500 transition-colors' }, icon('pencil', 'w-4 h-4')));
  const body = el('div', { class: 'space-y-5 text-[15px]' },
    el('div', { class: 'grid sm:grid-cols-2 gap-2' },
      el('div', { class: 'flex items-center gap-2' }, icon('candle', 'w-4 h-4 text-accent-500 shrink-0'),
        el('span', { class: 'text-stone-500 min-w-0' }, 'Candle Lighting'), el('b', { class: 'whitespace-nowrap' }, fmtDateTime(cluster.startsAt))),
      cluster.erevSunset && el('div', { class: 'flex items-center gap-2' }, icon('sunset', 'w-4 h-4 text-accent-500 shrink-0'),
        el('span', { class: 'text-stone-500 min-w-0' }, 'Shkia (sunset)'), el('b', { class: 'whitespace-nowrap' }, fmtDateTime(cluster.erevSunset))),
      el('div', { class: 'flex items-center gap-2 sm:col-span-2' }, icon('kiddush', 'w-4 h-4 text-accent-500 shrink-0'),
        el('span', { class: 'text-stone-500 min-w-0' }, endsLabel), el('b', { class: 'whitespace-nowrap' }, fmtDateTime(cluster.endsAt)))),
    el('div', {},
      el('div', { class: 'font-semibold mb-1.5' }, 'Days'),
      el('div', { class: 'space-y-0.5' },
        // The erev shows on the calendar too — list it here, linking to the first
        // day's editor (that's where its erev rules live).
        cluster.erevDate && cluster.erevLabel
          && dayRow(cluster.erevDate, cluster.erevLabel, first.dayType, first.variant, null, icon('candle', 'w-4 h-4 text-accent-500 shrink-0')),
        cluster.days.map((d) => dayRow(d.date, `${d.holidayLabel}${d.parsha ? `, ${d.parsha}` : ''}`, d.dayType, d.variant,
          d.variant !== 'default' ? el('span', { class: 'badge-info' }, variantLabel(d.variant)) : null)))),
    cluster.transitions?.length > 0 && el('div', {},
      el('div', { class: 'font-semibold mb-1.5' }, 'Candle-lighting transitions'),
      el('div', { class: 'space-y-1 hint' },
        cluster.transitions.map((t) => el('div', {}, `${fmtDateTime(t.at)}, ${t.label}`)))),
    timeline && (() => {
      const plannedBox = el('div', {});
      const cache = {};
      // the initial fetch respects the live guest state, so guest actions in it
      // mean guest mode is actually ON (drives "is ON" vs "preview as if" wording)
      const guestLive = (timeline.actions ?? []).some((a) => a.source?.guest);
      let guestShown = guestLive;
      cache[String(guestShown)] = timeline;
      const renderPlanned = async () => {
        const key = String(guestShown);
        let tl = cache[key];
        if (!tl) {
          mount(clear(plannedBox), el('div', { class: 'font-semibold mb-3' }, 'Planned actions'), el('div', { class: 'hint' }, 'Loading…'));
          tl = await api.get(`/api/timeline?date=${cluster.days[0].date}&guest=${guestShown ? '1' : '0'}`).catch(() => null);
          if (!tl) { mount(clear(plannedBox), el('span', { class: 'text-rose-500 text-sm' }, 'Failed to load actions')); return; }
          cache[key] = tl;
        }
        mount(clear(plannedBox),
          el('div', { class: 'flex items-center justify-between gap-2 mb-3 flex-wrap' },
            el('div', { class: 'font-semibold' }, 'Planned actions'),
            // only when guest rules exist for a day-type in this cluster
            tl.guestAvailable && guestOverlayToggle(guestShown, () => { guestShown = !guestShown; renderPlanned(); })),
          guestShown && tl.actions.some((a) => a.source?.guest) && guestPreviewNote({ forced: !guestLive }),
          // pin day headings under the modal's own sticky title (z-10): z-[5]
          // sits above the timeline rows (which are relative/z-auto and come
          // later in tree order) but below the title; top-16 clears the title.
          timelineView(tl.actions, { zones, scenes, dayLabels: clusterDayLabels(cluster), stickyHeaders: 'sticky top-16 z-[5]' }));
      };
      renderPlanned();
      return plannedBox;
    })(),
  );
  m = modal({ title: cluster.label, body, wide: true });
}
