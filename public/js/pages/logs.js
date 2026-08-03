import { api } from '../api.js';
import { el, clear, mount, select, pageHeader, pollWhileMounted, splitDownload, todayISO } from '../ui.js';
import { icon } from '../icons.js';

const LEVELS = { 10: 'TRACE', 20: 'DEBUG', 30: 'INFO', 40: 'WARN', 50: 'ERROR', 60: 'FATAL' };
const PAGE = 500; // rows per fetch, newest page on load, older pages on scroll-up
const LEVEL_CLASS = {
  40: 'text-accent-700 dark:text-accent-400',
  50: 'text-rose-600 dark:text-rose-400',
  60: 'text-rose-700 dark:text-rose-300 font-bold',
};

export async function logsPage() {
  let es = null;
  // Tall enough to fill most of the viewport, with room for the header, filter
  // row and the mobile bottom tabs. min-height keeps it usable on short screens.
  const list = el('div', {
    // Mobile: the page is a flex column pinned to the viewport (below), so the
    // list just fills the leftover space, only the log LINES scroll, never the
    // page, and it never runs under the bottom nav. Desktop keeps its tall panel.
    // overflow-x-hidden: only the LINES scroll vertically; nothing scrolls
    // sideways (a stray few-px overflow was cutting off the left of each line)
    class: 'font-mono text-[13px] leading-relaxed space-y-0.5 overflow-y-auto overflow-x-hidden '
      + 'flex-1 min-h-0 lg:flex-none lg:h-[calc(100dvh-15rem-var(--banner-h,0px)-var(--demo-bar-h,0px))] lg:min-h-[20rem]',
  });
  const q = el('input', { class: 'input sm:!w-64', placeholder: 'Search logs…' });
  const levelSel = select([['', 'All levels'], ['info', 'Info +'], ['warn', 'Warn +'], ['error', 'Errors']], '', () => load(), 'select !w-36');

  // Rows show the time; DAY-SEPARATOR headers (sticky, chat-style) mark where
  // the date changes, so scrolled-back history is never ambiguous. Each row
  // also carries its local day in data-day (separator bookkeeping) and the
  // full date+time as a hover tooltip.
  const dayKey = (ms) => new Date(ms).toLocaleDateString('en-CA'); // local YYYY-MM-DD
  const dayLabel = (ms) => new Date(ms).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  const row = (e) => el('div', {
    class: `whitespace-pre-wrap break-all ${LEVEL_CLASS[e.level] ?? 'text-stone-600 dark:text-stone-300'}`,
    'data-day': dayKey(e.time), title: new Date(e.time).toLocaleString(),
  },
    `${new Date(e.time).toLocaleTimeString()} ${String(LEVELS[e.level] ?? e.level).padEnd(5)} ${e.mod ? `[${e.mod}] ` : ''}${e.msg ?? ''} ${extras(e)}`);
  const daySep = (ms) => el('div', {
    // no negative margin, it pushed the sep past the list edges and forced a
    // horizontal scroll; full-width naturally, aligned with the rows
    class: 'day-sep sticky top-0 z-[5] py-1 font-sans text-xs font-semibold text-stone-500 dark:text-stone-400 '
      + 'bg-white/95 dark:bg-stone-900/95 backdrop-blur border-b border-stone-200 dark:border-stone-700',
    'data-day': dayKey(ms),
  }, dayLabel(ms));
  // Re-derive every separator from the rows currently in the DOM: strip them
  // all, then insert one before the first row and wherever the day changes.
  // Runs on load and after prepending an older page (NOT per stream message),
  // so boundaries stay correct no matter how pages splice together.
  const fixSeparators = () => {
    for (const s of list.querySelectorAll('.day-sep')) s.remove();
    let prevDay = null;
    for (const n of [...list.children]) {
      const d = n.dataset?.day;
      if (!d) continue;
      if (d !== prevDay) { const ms = Date.parse(`${d}T12:00`); list.insertBefore(daySep(ms), n); }
      prevDay = d;
    }
  };

  // Auto-follow + scroll-back pagination. The list holds only row elements;
  // `follow` (at the bottom) tails live; scrolling near the TOP fetches an older
  // page from the server (which reads deep history from app.log, far past the
  // in-memory ring, the old fixed 500-row load only reached ~2 hours back).
  let follow = true;
  let oldestTime = null;   // time (ms) of the oldest row currently rendered
  let loadingOlder = false;
  let noMoreOlder = false;
  const atBottom = () => list.scrollHeight - list.scrollTop - list.clientHeight < 48;
  const toBottom = () => { list.scrollTop = list.scrollHeight; follow = true; syncJump(); };

  const levelMin = () => ({ info: 30, warn: 40, error: 50 }[levelSel.value] ?? 0);
  const matchesFilters = (e) => (!q.value || JSON.stringify(e).toLowerCase().includes(q.value.toLowerCase()))
    && e.level >= levelMin();
  const filterParams = () => {
    const p = new URLSearchParams();
    if (q.value) p.set('q', q.value);
    if (levelSel.value) p.set('level', levelSel.value);
    return p;
  };

  const topLoader = el('div', { class: 'hidden absolute top-2 left-1/2 -translate-x-1/2 z-10 text-xs font-sans font-medium text-stone-500 bg-white/90 dark:bg-stone-800/90 border border-stone-200 dark:border-stone-700 rounded-full px-3 py-1 shadow' }, 'Loading older…');
  const jumpBtn = el('button', {
    class: 'opacity-0 pointer-events-none transition-opacity duration-200 absolute bottom-4 right-4 '
      + 'inline-flex items-center gap-1.5 whitespace-nowrap text-sm font-semibold '
      + 'bg-stone-900 text-white dark:bg-white dark:text-stone-900 shadow-lg rounded-full px-4 py-2',
    onclick: () => load(), // reset to the newest page (also bounds the DOM after paging up)
  }, icon('chevronDown', 'w-4 h-4 shrink-0'), 'Jump to latest');
  function syncJump() {
    jumpBtn.classList.toggle('opacity-0', follow);
    jumpBtn.classList.toggle('pointer-events-none', follow);
  }

  const loadOlder = async () => {
    if (loadingOlder || noMoreOlder || oldestTime == null) return;
    loadingOlder = true; topLoader.classList.remove('hidden');
    try {
      const older = await api.get(`/api/logs?${filterParams()}&before=${oldestTime}&limit=${PAGE}`);
      if (older.length) {
        const prevH = list.scrollHeight; const prevTop = list.scrollTop;
        const frag = document.createDocumentFragment();
        for (const e of older) frag.appendChild(row(e));
        list.insertBefore(frag, list.firstChild);
        fixSeparators(); // day boundaries move when a page splices in above
        oldestTime = new Date(older[0].time).getTime(); // entry time may be ISO or epoch
        list.scrollTop = prevTop + (list.scrollHeight - prevH); // keep the same rows in view
      }
      if (older.length < PAGE) noMoreOlder = true;
    } catch { /* transient, retry on the next scroll */ }
    loadingOlder = false; topLoader.classList.add('hidden');
  };

  list.addEventListener('scroll', () => {
    follow = atBottom(); syncJump();
    if (list.scrollTop < 200) loadOlder();
  });
  // Self-correcting: whatever any event's timing did, being at the bottom
  // means following (button fades out) and being scrolled up means not
  // (button fades in), re-checked every 800ms while the page is mounted.
  pollWhileMounted(list, () => {
    const ab = atBottom();
    if (ab !== follow) { follow = ab; syncJump(); }
  }, 800);

  const load = async () => {
    const entries = await api.get(`/api/logs?${filterParams()}&limit=${PAGE}`);
    oldestTime = entries.length ? new Date(entries[0].time).getTime() : null;
    noMoreOlder = entries.length < PAGE;
    mount(clear(list), entries.length === 0 ? el('p', { class: 'hint font-sans' }, 'No matching log entries.') : entries.map(row));
    fixSeparators();
    follow = true;
    // scroll after layout has settled so we land on the true bottom, not a
    // stale scrollHeight measured before the rows painted
    requestAnimationFrame(toBottom);
  };

  const startStream = () => {
    es = new EventSource('/api/logs/stream');
    es.onmessage = (ev) => {
      const e = JSON.parse(ev.data);
      if (!matchesFilters(e)) return;
      // crossing midnight while tailing: label the new day before its first row
      if (list.lastElementChild?.dataset?.day && list.lastElementChild.dataset.day !== dayKey(e.time)) {
        list.append(daySep(e.time));
      }
      list.append(row(e));
      // only trim (from the top) while tailing at the bottom, never while the
      // user has paged older content into view above
      if (follow) { while (list.childElementCount > 2000) list.firstChild.remove(); toBottom(); }
    };
  };

  // Debounce the search: a query scans the whole log file server-side, so we
  // wait for a typing pause instead of re-scanning on every keystroke.
  let searchTimer = null;
  q.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => load(), 250); });
  await load();
  startStream();

  const page = el('div', {
    // Below lg (mobile + tablet, where the fixed bottom nav is shown): a
    // fixed-height flex column filling from below the sticky header to just above
    // that nav (−mb-28 cancels <main>'s bottom padding so the tab-bar clearance
    // doesn't push us off-screen and scroll the page). lg (sidebar, no bottom
    // nav): normal flow with the tall fixed panel.
    class: 'flex flex-col gap-4 h-[calc(100dvh-9.25rem-var(--banner-h,0px)-var(--demo-bar-h,0px)-env(safe-area-inset-top)-env(safe-area-inset-bottom))] -mb-28 '
      + 'lg:h-auto lg:block lg:space-y-5 lg:mb-0',
  },
    pageHeader('Logs',
      splitDownload({
        label: 'Download', href: '/api/logs/download', download: `smartoneg-${todayISO()}.log`,
        items: [{ label: 'Download redacted logs', href: '/api/logs/download?redacted=1', download: `smartoneg-redacted-${todayISO()}.log`, icon: 'lock' }],
      })),
    el('div', { class: 'flex flex-wrap gap-3 items-center' }, q, levelSel),
    el('div', { class: 'card !p-4 relative flex-1 min-h-0 flex flex-col lg:block lg:flex-none' }, list, topLoader, jumpBtn));

  new MutationObserver((_, obs) => {
    if (!document.body.contains(page)) { es?.close(); obs.disconnect(); }
  }).observe(document.getElementById('app'), { childList: true, subtree: true });

  return page;
}

function extras(e) {
  const skip = new Set(['level', 'time', 'msg', 'pid', 'hostname', 'mod']);
  const kv = Object.entries(e).filter(([k]) => !skip.has(k)).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`);
  return kv.length ? `(${kv.join(' ')})` : '';
}
