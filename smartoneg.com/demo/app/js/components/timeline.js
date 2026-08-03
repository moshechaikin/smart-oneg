import { el, mount, fmtState, fmtTime, rgbToHex } from '../ui.js';
import { icon } from '../icons.js';
import { zmanOffsetLabel } from '../zman-names.js';

const guestBadge = () => el('span', {
  class: 'badge-info !bg-sky-100 !text-sky-700 dark:!bg-sky-500/20 dark:!text-sky-300 shrink-0',
}, icon('users', 'w-3.5 h-3.5'), 'Guest');

/**
 * A chip to sit above a preview when guest mode is influencing it.
 * `forced` = the editor is previewing the Guest situation while guest mode is
 * currently off, so the note explains it's a what-if preview, not live state.
 */
export function guestPreviewNote({ forced = false } = {}) {
  return el('div', {
    // w-fit max-w-full: hug the text (like a scene block) rather than span the
    // whole card, wrapping only when the text is wider than the container
    class: 'flex items-center gap-2 mb-3 w-fit max-w-full rounded-xl px-3 py-2 text-[14px] font-medium '
      + 'bg-sky-50 text-sky-700 border border-sky-200 dark:bg-sky-500/10 dark:text-sky-300 dark:border-sky-500/30',
  }, icon('users', 'w-4 h-4 shrink-0'),
    // one span so the flex gap can't open up around the inline badge
    el('span', {},
      forced
        ? 'Preview as if guest mode were ON, guest overrides are marked '
        : 'Guest mode is ON, this preview includes the guest overrides (marked ',
      el('span', { class: 'badge-info !bg-sky-100 !text-sky-700 dark:!bg-sky-500/20 dark:!text-sky-300 !py-0.5' }, 'Guest'),
      forced ? '. Turn guest mode on from the Dashboard to make it live.' : ').'));
}

/**
 * A compact toggle to show/hide the guest overlay in a timeline preview. Sky-
 * themed to match the Guest badge. Stateless — the caller flips `on` and re-
 * renders. Only render it when a guest overlay is actually applicable.
 */
export function guestOverlayToggle(on, onToggle) {
  return el('button', {
    type: 'button', 'aria-pressed': on ? 'true' : 'false',
    title: on ? 'Hide the guest-mode overlay' : 'Show what guest mode would overlay here',
    class: 'inline-flex items-center gap-1.5 rounded-xl border px-2.5 py-1 text-[13px] font-medium transition-colors '
      + (on
        ? 'border-sky-300 bg-sky-100 text-sky-700 dark:border-sky-500/40 dark:bg-sky-500/20 dark:text-sky-300'
        : 'border-stone-200 text-stone-500 hover:bg-stone-100 dark:border-stone-700 dark:text-stone-400 dark:hover:bg-stone-800'),
    onclick: onToggle,
  }, icon('users', 'w-3.5 h-3.5'), on ? 'Hide guest overlay' : 'Show guest overlay');
}

/** A chip to sit above a timeline when away (presence-simulation) mode shapes it. */
export function awayPreviewNote() {
  return el('div', {
    class: 'flex items-center gap-2 mb-3 w-fit max-w-full rounded-xl px-3 py-2 text-[14px] font-medium '
      + 'bg-indigo-50 text-indigo-700 border border-indigo-200 dark:bg-indigo-500/10 dark:text-indigo-300 dark:border-indigo-500/30',
  }, icon('plane', 'w-4 h-4 shrink-0'),
    el('span', {}, 'Away mode: this is the presence-simulated schedule (evenings kept lit longer, brief by day, times jittered).'));
}

/**
 * Flow-style timeline for compiled actions: grouped by day (with labels like
 * "Erev Shabbos · Fri, Jul 10" vs "Shabbos · Sat, Jul 11"), scene actions
 * collapsed into one scene block listing its device states, and a vertical
 * rail with dots so the sequence reads top-to-bottom at a glance.
 *
 * @param {Array} actions   compiled actions (sorted)
 * @param {object} opts     { zones, scenes, dayLabels: Map(dateISO -> label) }
 */
// A scene's device rows in the timeline, capped so a huge scene doesn't
// dominate: show the first 10 under a fade, with a chevron to slide the rest
// open inline. Expanded scenes are remembered (by key) so a timeline re-render
// (e.g. the dashboard's 5s poll) doesn't snap them shut again.
const TL_SCENE_ROWS = 10;
const expandedScenes = new Set();
function sceneRowList(items, rowEl, key) {
  const rows = items.map(rowEl);
  if (rows.length <= TL_SCENE_ROWS) return el('div', { class: 'space-y-1.5' }, rows);
  const fade = el('div', { class: 'pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-stone-50 dark:from-stone-800/50 to-transparent' });
  const head = el('div', { class: 'relative' }, el('div', { class: 'space-y-1.5' }, rows.slice(0, TL_SCENE_ROWS)), fade);
  // grid 0fr → 1fr is a measure-free slide; the inner clips while collapsed
  const restInner = el('div', { class: 'overflow-hidden' }, el('div', { class: 'space-y-1.5 pt-1.5' }, rows.slice(TL_SCENE_ROWS)));
  const rest = el('div', { class: 'scene-slide grid', style: 'grid-template-rows:0fr' }, restInner);
  const chev = icon('chevronDown', 'w-4 h-4 transition-transform');
  const label = el('span', {}, `Show all ${rows.length}`);
  const apply = (open) => {
    rest.style.gridTemplateRows = open ? '1fr' : '0fr';
    fade.style.display = open ? 'none' : '';
    chev.style.transform = open ? 'rotate(180deg)' : '';
    label.textContent = open ? 'Show less' : `Show all ${rows.length}`;
  };
  const btn = el('button', {
    class: 'mt-2 inline-flex items-center gap-1 text-sm font-medium text-accent-600 dark:text-accent-400',
    onclick: (e) => {
      e.stopPropagation();
      const open = !expandedScenes.has(key);
      if (open) expandedScenes.add(key); else expandedScenes.delete(key);
      apply(open);
    },
  }, chev, label);
  apply(expandedScenes.has(key)); // restore persisted state across re-renders
  return el('div', {}, head, rest, btn);
}

export function timelineView(actions, {
  zones = [], scenes = [], dayLabels = new Map(), stacked = false,
  // keys of actions involved in a conflict (zone|at|ruleId), marked inline
  conflictKeys = null,
  // Stitched-cluster mode: group by the schedule-day each action belongs to,
  // open the situation being edited (split into its night-before + the day
  // itself, with proper labels), and collapse the OTHER days of the weekend
  // into title-only accordions. null = the classic group-by-fire-date view.
  emphasizeDayType = null, cluster = null,
  // rules that won't fire this occurrence but have a would-be time, shown
  // greyed-out inline where they would have fired (see task: non-firing rules)
  skipped = [],
  // base actions a guest override suppressed: shown struck-through in place (in
  // their scene block, or as a standalone row) so the full outline is visible.
  // Only the day editor passes these; the overview stays clean.
  overridden = [],
  // When set (a sticky-* utility class), each day heading pins to the top as you
  // scroll its section, so you always know which day the rules below belong to;
  // the next day's heading pushes it up in turn. null = not sticky (default).
  stickyHeaders = null,
} = {}) {
  // fold placeable skips into the action stream as tagged pseudo-entries, so
  // all the existing grouping (by date / day-type / time) places them for free
  const skipActions = (skipped ?? [])
    .filter((s) => s.wouldFireAt)
    .map((s) => ({ _skip: true, at: new Date(s.wouldFireAt).getTime(), reason: s.reason, source: { label: s.label, dayType: s.dayType, ruleId: s.ruleId } }));
  // suppressed-by-guest actions carry full action data (zone/level/source), so
  // they slot into the same scene block as their surviving siblings.
  const overriddenActions = (overridden ?? []).map((a) => ({ ...a, _overridden: true }));
  if (skipActions.length || overriddenActions.length) {
    actions = [...actions, ...skipActions, ...overriddenActions].sort((a, b) => a.at - b.at || (a.zone ?? 0) - (b.zone ?? 0));
  }
  if (!actions.length) {
    return el('p', { class: 'hint' }, 'No planned actions yet. Build rules in Schedules.');
  }
  const zoneOf = (id) => zones.find((z) => z.id === id);
  const zoneName = (id) => zoneOf(id)?.friendlyName || `Device ${id}`;
  const sceneName = (id) => scenes.find((s) => s.id === id)?.name ?? id;
  const inConflict = (a) => conflictKeys?.has(`${a.zone}|${a.at}|${a.source?.ruleId}`);
  const conflictMark = () => el('span', {
    class: 'inline-flex items-center gap-1 badge-warn shrink-0', title: 'This rule is in a possible conflict. See the list below',
  }, icon('alert', 'w-3.5 h-3.5'), 'conflict');

  // Group by the civil date the action actually FIRES on (not the schedule
  // day it's attached to), so "Friday 5:30pm" sits under Erev Shabbos and
  // "Shabbos 9:30am" under Shabbos itself.
  const localISO = (ms) => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const byDate = new Map();
  for (const a of actions) {
    const key = localISO(a.at);
    if (!byDate.has(key)) byDate.set(key, []);
    byDate.get(key).push(a);
  }

  // within a date: collapse each scene's staggered actions into one block —
  // keyed by rule+phase, not adjacency, so a non-scene action landing between
  // the staggered timestamps can't split the block, then group everything
  // sharing a displayed time under a single timeline point.
  const entriesFor = (list) => {
    const entries = [];
    const openScenes = new Map();
    for (const a of list) {
      if (a._skip) { entries.push({ at: a.at, skip: a }); continue; }
      if (a.source.sceneId) {
        const key = `${a.source.ruleId}|${a.source.sceneId}|${a.source.scenePhase ?? ''}`;
        let blk = openScenes.get(key);
        if (!blk || a.at - blk.items[blk.items.length - 1].at > 60_000) {
          blk = { scene: a.source.sceneId, phase: a.source.scenePhase, label: a.source.label, at: a.at, items: [] };
          openScenes.set(key, blk);
          entries.push(blk);
        }
        blk.items.push(a);
      } else {
        entries.push({ at: a.at, action: a });
      }
    }
    const groups = [];
    const byTime = new Map();
    for (const e of entries) {
      const key = fmtTime(e.at);
      let g = byTime.get(key);
      if (!g) { g = { at: e.at, scenes: [], actions: [], skips: [] }; byTime.set(key, g); groups.push(g); }
      if (e.scene) g.scenes.push(e); else if (e.skip) g.skips.push(e.skip); else g.actions.push(e.action);
    }
    return groups;
  };

  const trigOf = (a) => (a.source?.trigger ? zmanOffsetLabel(a.source.trigger.zman, a.source.trigger.offsetMin) : null);

  const HVAC_LABEL = { heat: 'Heat', cool: 'Cool', heat_cool: 'Heat / Cool', auto: 'Auto', off: 'Off', dry: 'Dry', fan_only: 'Fan only' };
  const modeLabel = (m) => (m ?? '').replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  const stateBadge = (zone, level, type, times, enabled, mode) => el('span', {
    class: ['flash', 'setAutomation', 'setPreset', 'setHvacMode'].includes(type) || level > 0 ? 'badge-on' : 'badge-off',
  }, type === 'flash' ? (times >= 2 ? 'flash twice' : 'flash once')
    : type === 'setAutomation' ? (enabled ? 'Enable' : 'Disable')
      : type === 'setPreset' ? modeLabel(mode)
        : type === 'setHvacMode' ? (HVAC_LABEL[mode] ?? modeLabel(mode))
          : fmtState(zone, level));

  // a small "3000K" chip with a dot that fades warm→cool, shown next to an
  // "on" badge when a rule/scene sets the light's white color temperature
  const kelvinColor = (k) => {
    const t = Math.max(0, Math.min(1, (k - 2200) / (6500 - 2200)));
    const warm = [255, 170, 66], cool = [201, 222, 255];
    const c = warm.map((w, i) => Math.round(w + (cool[i] - w) * t));
    return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
  };
  const ctBadge = (k) => el('span', { class: 'inline-flex items-center gap-1 text-xs text-stone-500 dark:text-stone-400 tabular-nums' },
    el('span', { class: 'w-2.5 h-2.5 rounded-full ring-1 ring-black/10 dark:ring-white/15', style: `background:${kelvinColor(k)}` }),
    `${k}K`);
  const rgbBadge = (rgb) => el('span', { class: 'inline-flex items-center gap-1 text-xs text-stone-500 dark:text-stone-400 tabular-nums' },
    el('span', { class: 'w-2.5 h-2.5 rounded-full ring-1 ring-black/10 dark:ring-white/15', style: `background:${rgbToHex(rgb)}` }),
    rgbToHex(rgb));
  // a light-color chip next to an "on" badge: RGB swatch, else warm↔cool white
  const ctOf = (a) => {
    if (a.type !== 'setLevel' || !(a.level > 0)) return null;
    if (a.rgb != null) return rgbBadge(a.rgb);
    if (a.kelvin != null) return ctBadge(a.kelvin);
    return null;
  };

  // one vertical rail of timeline points for a list of actions (any order)
  const renderRail = (list) => el('div', { class: 'relative border-l-2 border-stone-200 dark:border-stone-700 ml-1.5 pl-5 space-y-4' },
    entriesFor(list).map((g) => {
      // overridden (struck-through) actions don't count toward the point's live
      // state — the dot colour, "all guest", and the shared zman annotation
      const all = [...g.scenes.flatMap((s) => s.items), ...g.actions].filter((a) => !a._overridden);
      const guest = all.every((a) => a.source?.guest) && all.length > 0;
      const skipOnly = all.length === 0 && g.skips.length > 0;
      // one shared zman annotation next to the time when everything at this
      // point resolves the same way; per-row otherwise
      const descs = new Set(all.map(trigOf).filter(Boolean));
      const shared = descs.size === 1 ? [...descs][0] : null;
      const rowNote = (a) => {
        const d = !shared && trigOf(a);
        return [a.source.label, d].filter(Boolean).join(' · ');
      };
      return el('div', { class: 'relative' },
        el('span', { class: `absolute -left-[1.65rem] top-1 w-3 h-3 rounded-full ring-4 ring-stone-100 dark:ring-stone-950 ${skipOnly ? 'bg-stone-300 dark:bg-stone-600' : guest ? 'bg-sky-400' : 'bg-accent-400'}` }),
        el('div', { class: 'text-sm font-medium text-stone-500 dark:text-stone-400 tabular-nums' },
          fmtTime(g.at),
          shared && el('span', { class: 'font-normal text-stone-400 dark:text-stone-500' }, ` · ${shared}`)),
        g.scenes.map((entry) => {
          const sguest = entry.items.some((a) => a.source?.guest);
          const rowEl = (a) => (a._overridden
            ? el('div', { class: 'flex items-center gap-2 text-[15px]' },
              el('span', { class: 'line-through opacity-60' }, zoneName(a.zone)),
              el('span', { class: 'opacity-60' }, stateBadge(zoneOf(a.zone), a.level, a.type, a.times, a.enabled, a.preset ?? a.hvacMode)),
              el('span', { class: 'italic text-xs text-sky-700 dark:text-sky-300' }, 'overridden by guest'))
            : el('div', { class: 'flex items-center gap-2.5 text-[15px]' },
              el('span', {}, zoneName(a.zone)),
              stateBadge(zoneOf(a.zone), a.level, a.type, a.times, a.enabled, a.preset ?? a.hvacMode),
              ctOf(a)));
          return el('div', { class: 'mt-1.5 w-fit max-w-full rounded-xl border border-stone-200 dark:border-stone-700 bg-stone-50 dark:bg-stone-800/50 p-3.5' },
            el('div', { class: 'flex items-center gap-2 font-semibold text-[15px] mb-2' },
              el('span', { class: 'text-accent-600 dark:text-accent-400' }, icon('layers', 'w-4.5 h-4.5')),
              `${entry.phase === 'sceneEnd' ? 'Scene End' : 'Scene Start'}: ${sceneName(entry.scene)}`,
              entry.label && el('span', { class: 'hint font-normal' }, `· ${entry.label}`),
              sguest && guestBadge(),
              entry.items.some(inConflict) && conflictMark()),
            sceneRowList(entry.items, rowEl, `${entry.scene}|${entry.phase ?? ""}|${entry.at}`));
        }),
        g.actions.map((action) => (action._overridden
          ? el('div', { class: 'mt-1 flex items-center gap-2 flex-wrap text-[15px]' },
            el('span', { class: 'font-medium line-through opacity-60' }, zoneName(action.zone)),
            el('span', { class: 'opacity-60' }, stateBadge(zoneOf(action.zone), action.level, action.type, action.times, action.enabled, action.preset ?? action.hvacMode)),
            el('span', { class: 'italic text-xs text-sky-700 dark:text-sky-300' }, 'overridden by guest'))
          : el('div', { class: 'mt-1 flex items-center gap-2.5 flex-wrap text-[15px]' },
            el('span', { class: 'font-medium' }, zoneName(action.zone)),
            stateBadge(zoneOf(action.zone), action.level, action.type, action.times, action.enabled, action.preset ?? action.hvacMode),
            ctOf(action),
            rowNote(action) && el('span', { class: 'hint' }, rowNote(action)),
            inConflict(action) && conflictMark(),
            // always mark guest rows (like scene rows do) — even when every action
            // at this point is guest, so the overlay's guest overrides are visible
            action.source?.guest && guestBadge()))),
        // rules that won't fire this occurrence, greyed-out where they'd have been
        g.skips.map((s) => el('div', { class: 'mt-1 flex items-center gap-2 flex-wrap text-[15px] text-stone-400 dark:text-stone-500' },
          icon('x', 'w-4 h-4 shrink-0'),
          el('span', { class: 'font-medium line-through' }, s.source?.label || 'unnamed rule'),
          el('span', { class: 'italic' }, `won’t fire: ${s.reason}`))));
    }));

  // Sticky headings. `stickyHeaders`, when set, carries the sticky offset
  // utility AND a z (page previews z-10; the calendar modal a low z so it tucks
  // under the modal's own sticky title). The heading gets a SOLID opaque bg
  // (matches the card / modal, so nothing bleeds through) plus:
  //  - a bottom FADE into the scrolling rows, and
  //  - a solid CAP just above it that fills any residual gap up to the top bar —
  //    shown ONLY while pinned (an IntersectionObserver on a sentinel toggles
  //    it), so it never covers the content sitting above the heading at rest.
  // The heading stays a sibling of its rows (so it pins for the day's length);
  // el() flattens the returned [sentinel, heading] array in place.
  const stickyBg = 'bg-white dark:bg-stone-900';
  const stickyFade = () => el('div', { class: 'pointer-events-none absolute inset-x-0 top-full h-5 bg-gradient-to-b from-white dark:from-stone-900 to-transparent' });
  const makeSticky = (headerEl) => {
    const cap = el('div', { class: `hidden pointer-events-none absolute inset-x-0 bottom-full h-8 ${stickyBg}` });
    headerEl.append(cap, stickyFade());
    const sentinel = el('div', { class: 'h-px -mb-px' });
    requestAnimationFrame(() => {
      if (!sentinel.isConnected) return;
      const top = parseFloat(getComputedStyle(headerEl).top) || 0;
      new IntersectionObserver(
        ([e]) => cap.classList.toggle('hidden', e.isIntersecting),
        { rootMargin: `-${Math.ceil(top) + 1}px 0px 0px 0px`, threshold: 0 },
      ).observe(sentinel);
    });
    return sentinel;
  };
  const dayHeader = (label) => {
    const header = el('div', {
      class: 'flex items-center gap-2 text-[17px] font-bold mb-3'
        + (stickyHeaders ? ` ${stickyHeaders} py-2 -mx-5 sm:-mx-6 px-5 sm:px-6 ${stickyBg}` : ''),
    }, el('span', { class: 'text-accent-500' }, icon('calendar', 'w-4.5 h-4.5')), label);
    return stickyHeaders ? [makeSticky(header), header] : header;
  };
  const dateFmt = (date) => new Date(`${date}T12:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });

  // Stitched mode: group by the schedule-day each action belongs to (not fire
  // date), so the whole weekend shows but each situation's days stay together.
  // The edited day-type is open; the others collapse into title-only accordions.
  if (emphasizeDayType && cluster?.days?.length) {
    const days = cluster.days;
    // An action normally displays under the schedule-day it was authored on
    // (source.dayType). But an "after midnight (next day)" action fires in the
    // early morning of the FOLLOWING cluster day — e.g. a Rosh Hashanah I "day
    // itself" rule at 2:30am lands on Rosh Hashanah II. Attribute it to the day
    // it actually fires on (matching the overview timeline) so it doesn't read
    // as a duplicate under the authoring day. Only moves an action FORWARD to a
    // later cluster day; a night-before rule (fires before its own day) stays
    // put and keeps its Erev/Motzei night split below.
    const displayDayType = (a) => {
      const srcDt = a.source?.dayType ?? '_';
      const srcDay = days.find((d) => d.dayType === srcDt);
      const fireDay = days.find((d) => d.date === localISO(a.at));
      return srcDay && fireDay && fireDay.date > srcDay.date ? fireDay.dayType : srcDt;
    };
    const byDayType = new Map();
    for (const a of actions) {
      const dt = displayDayType(a);
      (byDayType.get(dt) ?? byDayType.set(dt, []).get(dt)).push(a);
    }
    // The night a day begins on (fires BEFORE the day's own date). Only called
    // for the two nights that earn their own section: the first cluster day's
    // erev, or a Motzei Shabbos (the previous day is Shabbos).
    const weekdayName = (date) => new Date(`${date}T12:00`).toLocaleDateString(undefined, { weekday: 'long' });
    const nightInfo = (d) => {
      const idx = days.findIndex((x) => x.date === d.date);
      if (idx <= 0) return { label: `${cluster.erevLabel ?? 'Erev'} / ${weekdayName(cluster.erevDate)} Night`, date: cluster.erevDate };
      const prev = days[idx - 1];
      // A Shabbos that comes in from a Friday Yom Tov (After Friday Yom Tov,
      // Chol Hamoed on Shabbos): the night IS Erev Shabbos — lit from the Yom
      // Tov's existing flame — not a Motzei (the Yom Tov hasn't ended). The
      // Friday DAYTIME is that Yom Tov's own situation, shown separately.
      if (d.dayType === 'shabbos' && prev.dayType !== 'shabbos') {
        return { label: `${cluster.erevShabbosLabel ?? 'Erev Shabbos'} / ${weekdayName(prev.date)} Night`, date: prev.date };
      }
      // "Motzei Shabbos" reads cleaner than "Motzei Shabbos (Erev Pesach)"
      return { label: `Motzei ${(prev.holidayLabel ?? '').replace(/\s*\([^)]*\)\s*$/, '')}`, date: prev.date };
    };
    // A day gets its own separate "night it begins on" section ONLY when that
    // night is genuinely distinct: the first cluster day's erev (e.g. "Erev
    // Shabbos / Friday Night") or a Motzei Shabbos (Shabbos → Yom Tov is a real
    // seam). Every other day's evening rules, e.g. candle-lighting prep the
    // night Pesach II begins, read more naturally kept with the day itself than
    // broken out under a "Motzei Pesach I" header.
    const partsOf = (d) => {
      const own = d.dayType === emphasizeDayType;
      // A non-emphasized weekend day with no rules of its own still belongs to
      // the cluster: show it as a collapsed placeholder so "the rest of the
      // weekend" is actually visible (e.g. the Friday Yom Tov before an After-
      // Friday-Yom-Tov Shabbos, when that Yom Tov has no rules set), instead of
      // silently vanishing while the header still says it's collapsed below.
      const dayActions = byDayType.get(d.dayType) ?? [];
      if (!dayActions.length) return own ? [] : [{ label: dayIdentityLabel(d), date: d.date, list: [], own, empty: true }];
      const list = dayActions.slice().sort((a, b) => a.at - b.at);
      const idx = days.findIndex((x) => x.date === d.date);
      const splitNight = idx === 0 || days[idx - 1]?.dayType === 'shabbos'
        // a Shabbos coming in from a Friday Yom Tov: split its Erev Shabbos /
        // Friday-night rules off so they don't read as firing on Shabbos day
        || (d.dayType === 'shabbos' && idx > 0 && days[idx - 1]?.dayType !== 'shabbos');
      if (!splitNight) return [{ label: dayIdentityLabel(d), date: d.date, list, own }];
      const night = list.filter((a) => localISO(a.at) < d.date);
      const day = list.filter((a) => localISO(a.at) >= d.date);
      const out = [];
      if (night.length) { const ni = nightInfo(d); out.push({ label: ni.label, date: ni.date, list: night, own }); }
      if (day.length) out.push({ label: dayIdentityLabel(d), date: d.date, list: day, own });
      return out;
    };
    const parts = days.flatMap(partsOf);
    return el('div', { class: 'space-y-5' },
      parts.map((part, i) => {
        const border = i > 0 ? 'border-t-2 border-stone-200 dark:border-stone-800 pt-4' : '';
        const title = `${part.label} · ${dateFmt(part.date)}`;
        if (part.own) return el('div', { class: border }, dayHeader(title), renderRail(part.list));
        const summary = el('summary', {
          class: 'flex items-center gap-2 cursor-pointer list-none select-none text-[17px] font-bold text-stone-500 dark:text-stone-400'
            + (stickyHeaders ? ` ${stickyHeaders} py-2 -mx-5 sm:-mx-6 px-5 sm:px-6 ${stickyBg}` : ''),
        },
          icon('chevronRight', 'w-4 h-4 shrink-0 transition-transform group-open:rotate-90'),
          title);
        // pinned-cap + fade attached to the summary (only pins while open, since
        // a closed accordion has no rows to scroll under it)
        const sentinel = stickyHeaders ? makeSticky(summary) : null;
        const details = el('details', { class: `${border} group` }, summary,
          el('div', { class: 'mt-4' }, part.empty
            ? el('p', { class: 'hint' }, 'No rules set for this day.')
            : renderRail(part.list)));
        // wrap so the sentinel isn't treated as a space-y sibling of the details
        return stickyHeaders ? el('div', {}, sentinel, details) : details;
      }));
  }

  return el('div', { class: 'space-y-6' },
    [...byDate.entries()].map(([date, list], dayIdx) => el('div', {
      // each day reads as its own section, divider + bigger heading so
      // consecutive days don't blend together while scrolling.
      class: [
        stacked && dayIdx === 0 ? 'mt-6' : '',
        (dayIdx > 0 || stacked) ? 'border-t-2 border-stone-200 dark:border-stone-800 pt-5' : '',
      ].filter(Boolean).join(' '),
    },
      dayHeader(dayLabels.get(date) ?? dateFmt(date)),
      renderRail(list))));
}

/** A day's holiday label enriched with its dual identity when the situation
 *  makes it one, e.g. a Shabbos that is also Erev Pesach/Shavuos, or a Yom Tov
 *  day that falls on Shabbos itself. Keyed off the compiled day's variant. */
function dayIdentityLabel(d) {
  const has = (s) => (d.holidayLabel ?? '').toLowerCase().includes(s.toLowerCase());
  const add = (extra) => (has(extra) ? d.holidayLabel : `${d.holidayLabel} · ${extra}`);
  if (d.dayType === 'shabbos' && d.variant === 'erev-pesach') return add('Erev Pesach');
  if (d.dayType === 'shabbos' && d.variant === 'leads-into-yt') return add('Erev Shavuos');
  if (d.dayType === 'shabbos' && d.variant === 'chol-hamoed-pesach') return add('Chol Hamoed Pesach');
  if (d.dayType === 'shabbos' && d.variant === 'chol-hamoed-sukkos') return add('Chol Hamoed Sukkos');
  if (d.dayType === 'shabbos' && d.variant === 'shabbos-chanukah') return add('Chanukah');
  if (d.dayType !== 'shabbos' && d.variant === 'on-shabbos') return add('Shabbos');
  return d.holidayLabel;
}

/** Build dayLabels for a cluster: erev + each day, using its labels. */
export function clusterDayLabels(cluster) {
  const fmt = (d) => new Date(`${d}T12:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  const map = new Map();
  // Erev also carries the night it collides with, since that night's rules live
  // here too, e.g. "Erev Shabbos / Friday Night", "Erev Sukkos / Wednesday Night".
  const erevNight = `${new Date(`${cluster.erevDate}T12:00`).toLocaleDateString(undefined, { weekday: 'long' })} Night`;
  map.set(cluster.erevDate, `${cluster.erevLabel ?? 'Erev'} / ${erevNight} · ${fmt(cluster.erevDate)}`);
  for (const d of cluster.days) map.set(d.date, `${dayIdentityLabel(d)}${d.parsha ? `, ${d.parsha}` : ''} · ${fmt(d.date)}`);
  return map;
}
