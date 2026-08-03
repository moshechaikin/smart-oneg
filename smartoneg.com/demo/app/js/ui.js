import { icon } from './icons.js';

/** Tiny DOM helpers, no framework, per project rules. */

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined && v !== false) node.setAttribute(k, v === true ? '' : v);
  }
  return mount(node, ...children);
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

/**
 * Append with el()'s child semantics: flattens arrays, skips false/null/
 * undefined. Native Node.append() stringifies those ("false", "[object …]"),
 * so ALWAYS use mount() when children are conditional or arrays.
 */
export function mount(node, ...children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/** Toasts: fixed top-center pills with icon. Pass { ms } for a longer stay. */
export function toast(message, kind = 'info', { ms = 3600 } = {}) {
  const styles = {
    info: ['bg-stone-900/95 text-white dark:bg-white/95 dark:text-stone-900', 'info'],
    success: ['bg-emerald-600/95 text-white', 'check'],
    error: ['bg-rose-600/95 text-white', 'alert'],
    warn: ['bg-accent-500/95 text-stone-950', 'alert'],
  };
  const [cls, ic] = styles[kind] ?? styles.info;
  const t = el('div', {
    class: `toast-enter pointer-events-auto flex items-center gap-2.5 ${cls} rounded-2xl pl-4 pr-5 py-3
            text-[15px] font-medium shadow-xl shadow-black/10 max-w-[92vw] sm:max-w-md backdrop-blur`,
    role: 'status',
  }, icon(ic, 'w-5 h-5 shrink-0'), el('span', {}, message));
  document.getElementById('toasts').append(t);
  setTimeout(() => { t.style.transition = 'opacity .35s, transform .35s'; t.style.opacity = '0'; t.style.transform = 'translateY(-10px)'; }, ms);
  setTimeout(() => t.remove(), ms + 400);
}

/**
 * Modal with backdrop. Returns { close }.
 * - dismissable (default true): clicking the backdrop closes. Set false for
 *   editors where accidental dismissal loses work.
 * - confirmClose (default false): the × and Cancel ask "discard changes?" first.
 * - stickyFooter (default false): footer stays pinned/blurred at the bottom so
 *   Save/Cancel are always visible in tall scrollable modals.
 */
export function modal({
  title, body, confirmText, confirmClass = 'btn', cancelText = 'Cancel', onConfirm, onClose,
  wide = false, dismissable = true, confirmClose = false, stickyFooter = false, saveOnCtrlS = false,
}) {
  const root = document.getElementById('modal-root');
  const backdrop = el('div', { class: 'modal-bd-in fixed inset-0 z-40 bg-stone-950/50 backdrop-blur-[2px] flex items-end sm:items-center justify-center p-0 sm:p-4' });
  let onKeydown = null; // ⌘/Ctrl+S handler, wired up below when saveOnCtrlS is set
  // animate out, then remove
  const hardClose = () => {
    if (backdrop.dataset.closing) return;
    backdrop.dataset.closing = '1';
    if (onKeydown) document.removeEventListener('keydown', onKeydown);
    box.classList.remove('modal-box-in'); box.classList.add('modal-box-out');
    backdrop.classList.remove('modal-bd-in'); backdrop.classList.add('modal-bd-out');
    setTimeout(() => backdrop.remove(), 170);
    onClose?.(); // fires on every close path (×, backdrop, confirm), once
  };
  // Runs the confirm action and closes unless it returns false (validation
  // failed). Shared by the footer button and the ⌘/Ctrl+S shortcut. Guarded so a
  // fast double-click can't fire the action twice: the modal only leaves after a
  // ~170ms close animation, so without this the button stays live and clickable
  // in that window (e.g. importing copied rules twice). Reset only on failure so
  // a validation error still lets the user correct and retry.
  let confirming = false;
  const doConfirm = async () => {
    if (confirming) return;
    confirming = true;
    try {
      if (await onConfirm?.() !== false) hardClose();
      else confirming = false;
    } catch (err) {
      confirming = false;
      throw err;
    }
  };
  const close = () => {
    // confirmClose may be a boolean or a predicate — only prompt when there are
    // actually unsaved changes (a function returning false closes immediately)
    if (!confirmClose || (typeof confirmClose === 'function' && !confirmClose())) return hardClose();
    modal({
      title: 'Discard changes?',
      body: el('p', { class: 'text-[15px]' }, 'You have unsaved changes. Close without saving?'),
      confirmText: 'Discard', confirmClass: 'btn-danger',
      onConfirm: hardClose,
    });
  };
  const footer = confirmText && el('div', {
    class: stickyFooter
      ? 'sticky bottom-0 -mx-5 sm:-mx-6 mt-6 px-5 sm:px-6 py-3.5 flex justify-end gap-2.5 bg-white/85 dark:bg-stone-900/85 backdrop-blur border-t border-stone-200 dark:border-stone-800'
      : 'mt-6 flex justify-end gap-2.5',
  },
    cancelText && el('button', { class: 'btn-secondary', onclick: close }, cancelText),
    el('button', {
      class: confirmClass,
      onclick: doConfirm,
    }, confirmText));
  // The card clips (overflow-hidden) while an inner scroller scrolls: the
  // scrollbar stays inside the rounded corners, and the title row is sticky
  // so long content keeps the heading + × in view.
  const scroller = el('div', {
    // scrollbar-gutter:stable reserves the scrollbar's width so it doesn't eat
    // into the right padding / overlap the sticky footer when content scrolls.
    class: `modal-scroll grow overflow-y-auto [scrollbar-gutter:stable] px-5 sm:px-6
            ${title ? '' : 'pt-5 sm:pt-6'} ${stickyFooter ? 'pb-0' : 'pb-8'}`,
  },
    // With a title: a sticky header (title + ×) with backdrop blur. Without:
    // no header row and the × floats pinned in the corner.
    title && el('div', { class: 'sticky top-0 z-10 -mx-5 sm:-mx-6 px-5 sm:px-6 pt-5 sm:pt-6 pb-3 mb-3 flex items-start justify-between gap-4 bg-white/85 dark:bg-stone-900/85 backdrop-blur' },
      el('h3', { class: 'text-xl font-semibold' }, title),
      el('button', { class: 'icon-btn -mr-1.5 -mt-1', onclick: close, 'aria-label': 'Close' }, icon('x'))),
    body instanceof Node ? body : el('p', { class: 'hint' }, body),
    footer,
  );
  const box = el('div', {
    class: `modal-box-in card relative w-full ${wide ? 'sm:max-w-2xl' : 'sm:max-w-lg'} max-h-[88vh] !p-0 overflow-hidden flex flex-col
            rounded-b-none sm:rounded-b-card safe-bottom`,
  },
    !title && el('button', { class: 'icon-btn absolute top-4 right-4 z-10', onclick: close, 'aria-label': 'Close' }, icon('x')),
    scroller,
  );
  if (dismissable) backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  // ⌘S / Ctrl+S confirms a save-style modal instead of the browser's save-page
  // dialog. Opt-in (never on destructive confirmations). Ignores auto-repeat so
  // holding the keys can't double-submit; removed in hardClose so it never leaks.
  if (saveOnCtrlS && onConfirm) {
    onKeydown = (e) => {
      if (e.repeat || !((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S'))) return;
      e.preventDefault();
      doConfirm();
    };
    document.addEventListener('keydown', onKeydown);
  }
  backdrop.append(box);
  root.append(backdrop);
  return { close: hardClose };
}

export function levelBadge(level, dimmable = true) {
  if (level === undefined || level === null) return el('span', { class: 'badge-off' }, '—');
  if (level > 0) {
    return el('span', { class: 'badge-on' },
      icon('bulb', 'w-3.5 h-3.5'),
      dimmable && level < 100 ? `${Math.round(level)}%` : 'On');
  }
  return el('span', { class: 'badge-off' }, 'Off');
}

export function fmtDateTime(iso, opts = {}) {
  return new Date(iso).toLocaleString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', ...opts,
  });
}

export function fmtTime(iso) {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/**
 * Human window for a date-only range, e.g. "Jul 25 – Aug 8" (or a single
 * "Oct 2" when from === to). Parse at local midnight so a `YYYY-MM-DD` never
 * slips a day in a negative-UTC timezone the way `new Date(iso)` would.
 */
export function fmtDateRange(from, to) {
  if (!from) return '';
  const d = (iso) => new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return !to || to === from ? d(from) : `${d(from)} – ${d(to)}`;
}

/**
 * LOCAL calendar date as YYYY-MM-DD. Never use `Date.toISOString().slice(0,10)`
 * for "today", that's UTC, so late at night it rolls to tomorrow's date and
 * the calendar highlights the wrong day. Always build from local getters.
 */
export function localISO(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function todayISO() {
  return localISO(new Date());
}

const VARIANT_DISPLAY = {
  default: 'Regular', 'on-shabbos': 'falls on Shabbos', 'erev-is-shabbos': 'starts motzei Shabbos',
  'leads-into-shabbos': 'leads into Shabbos', 'erev-pesach': 'Erev Pesach',
  'leads-into-yt': 'Erev Shavuos', 'follows-yt': 'follows Yom Tov',
  'chol-hamoed-pesach': 'Chol Hamoed Pesach', 'chol-hamoed-sukkos': 'Chol Hamoed Sukkos',
  'shabbos-chanukah': 'Shabbos Chanukah', guest: 'guest mode',
};
export function variantLabel(v) {
  return VARIANT_DISPLAY[v] ?? v.replace(/-/g, ' ');
}

/**
 * Human state string for a device level, aware of device kind:
 * thermostats speak °F/program, switches On/Off, dimmers percentages —
 * with 100% shown as "On · 100%".
 */
export function fmtState(zone, level) {
  if (zone?.kind === 'thermostat') {
    const unit = zone.displayUnit === 'C' ? 'C' : 'F'; // stored °F; display in the device's unit
    const t = unit === 'C' ? Math.round((level - 32) * 5 / 9) : Math.round(level);
    return level > 0 ? `Hold ${t}°${unit}` : 'Resume program';
  }
  if (level === undefined || level === null) return '—';
  // shades read as Open/Closed (their level is how far open), not On/Off
  if (zone?.kind === 'shade') return level <= 0 ? 'Closed' : (level >= 100 ? 'Open' : `Open · ${Math.round(level)}%`);
  // alarm partition: Armed/Disarmed; alarm bypass zone: Bypassed/Active
  if (zone?.kind === 'alarm') return level > 0 ? 'Armed' : 'Disarmed';
  if (zone?.kind === 'bypass') return level > 0 ? 'Bypassed' : 'Active';
  if (zone?.kind === 'lock') return level > 0 ? 'Locked' : 'Unlocked';
  if (zone?.kind === 'vacuum') return level > 0 ? 'Cleaning' : 'Docked';
  // momentary HA automation/script: "on" means run it once, it rests at idle
  if (zone?.kind === 'automation') return level > 0 ? 'Run' : 'Idle';
  if (level <= 0) return 'Off';
  // non-dimmable = On/Off only; match DeviceBus.coerceLevel's `!dimmable` so the
  // readout can't show "80%" for a switch that actually snaps to fully on
  if (!zone || !zone.dimmable) return 'On';
  return level >= 100 ? 'On · 100%' : `${Math.round(level)}%`;
}

export function spinner() {
  return el('div', { class: 'flex justify-center py-12' },
    el('div', { class: 'animate-spin h-8 w-8 border-[3px] border-accent-500 border-t-transparent rounded-full' }));
}

/** Checkbox on its own row with a real, clickable label. */
export function checkRow(label, { checked = false, onchange, hint } = {}) {
  const input = el('input', { class: 'checkbox', type: 'checkbox', checked, onchange });
  const node = el('div', { class: 'py-1' },
    el('label', { class: 'check-row' }, input, el('span', {}, label)),
    hint && el('p', { class: 'hint ml-8 -mt-0.5' }, hint));
  return { input, node };
}

/**
 * Copy text to the clipboard, working on a plain-HTTP LAN too (where
 * navigator.clipboard is unavailable / non-secure-context). Falls back to a
 * hidden textarea + execCommand. Returns true on success.
 */
export async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* fall through to the legacy path */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
}

export function field(labelText, control, hint, { labelClass = '' } = {}) {
  return el('div', {},
    el('label', { class: `label ${labelClass}` }, labelText), control,
    hint && el('p', { class: 'hint mt-1.5' }, hint));
}

/**
 * A split download button: a primary download link joined to a caret that
 * opens a dropdown of alternate downloads (e.g. a redacted variant).
 *   primary: { href, download, label }
 *   items:   [{ href, download, label, icon? }]
 */
export function splitDownload({ label, href, download, items = [] }) {
  let open = false;
  const close = () => { if (!open) return; open = false; menu.classList.add('hidden'); document.removeEventListener('click', onDoc); };
  const onDoc = (e) => { if (!wrap.contains(e.target)) close(); };
  const menu = el('div', {
    class: 'hidden absolute right-0 top-full mt-1.5 z-30 min-w-[15rem] rounded-xl border '
      + 'border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-800 shadow-lg overflow-hidden',
  }, ...items.map((it) => el('a', {
    class: 'flex items-center gap-2 px-3.5 py-2.5 text-sm text-stone-700 dark:text-stone-200 hover:bg-stone-100 dark:hover:bg-white/5',
    href: it.href, ...(it.download ? { download: it.download } : {}), onclick: close,
  }, icon(it.icon ?? 'download', 'w-4 h-4 shrink-0'), it.label)));
  const main = el('a', {
    class: 'btn-secondary btn-sm !rounded-r-none', href, ...(download ? { download } : {}),
  }, icon('download', 'w-4 h-4'), label);
  const caret = el('button', {
    class: 'btn-secondary btn-sm !rounded-l-none !border-l-0 !px-2', 'aria-label': 'More download options',
    onclick: (e) => { e.stopPropagation(); open = !open; menu.classList.toggle('hidden', !open); if (open) document.addEventListener('click', onDoc); },
  }, icon('chevronDown', 'w-4 h-4'));
  const wrap = el('div', { class: 'relative inline-flex' }, main, caret, menu);
  return wrap;
}

/**
 * A JSON entry field: paste OR upload a .json file, with live validation. The
 * status line turns green on valid JSON and red (with the parse error) on
 * invalid. Returns { node, parse() → object|throws, valid() → bool }.
 */
export function jsonInput({ placeholder = 'Paste JSON…', rows = 'h-44' } = {}) {
  const ta = el('textarea', { class: `input ${rows} font-mono text-[16px] sm:!text-[13px]`, placeholder });
  const status = el('div', { class: 'text-[13px] mt-1.5 min-h-5' });
  const fileInput = el('input', { class: 'hidden', type: 'file', accept: '.json,application/json' });

  const validate = () => {
    const v = ta.value.trim();
    if (!v) { clear(status); return; }
    try { JSON.parse(v); mount(clear(status), el('span', { class: 'text-emerald-600 dark:text-emerald-400 flex items-center gap-1' }, icon('check', 'w-4 h-4'), 'Valid JSON')); }
    catch (err) { mount(clear(status), el('span', { class: 'text-rose-600 flex items-center gap-1' }, icon('alert', 'w-4 h-4'), `Invalid JSON: ${err.message}`)); }
  };
  ta.addEventListener('input', validate);
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => { ta.value = String(reader.result); validate(); };
    reader.readAsText(file);
  });

  const node = el('div', {},
    el('div', { class: 'flex items-center gap-2 mb-2' },
      el('button', { class: 'btn-secondary btn-sm', type: 'button', onclick: () => fileInput.click() }, icon('upload', 'w-4 h-4'), 'Upload a file'),
      el('span', { class: 'hint' }, 'or paste below'),
      fileInput),
    ta, status);

  return {
    node,
    raw: () => ta.value,
    valid: () => { try { JSON.parse(ta.value); return true; } catch { return false; } },
    parse: () => JSON.parse(ta.value),
    setValue: (v) => { ta.value = v; validate(); },
  };
}

export function select(options, value, onSel, cls = 'select') {
  return el('select', { class: cls, onchange: (e) => onSel?.(e.target.value) },
    options.map(([v, label]) => el('option', { value: v, selected: String(v) === String(value) }, label)));
}

/**
 * Select grouped into <optgroup>s. `groups` = [{ label, options: [[v, text]] }].
 * Used for device pickers so rooms are delineated in the dropdown.
 */
export function groupedSelect(groups, value, onSel, cls = 'select') {
  return el('select', { class: cls, onchange: (e) => onSel?.(e.target.value) },
    groups.map((g) => el('optgroup', { label: g.label },
      g.options.map(([v, label]) => el('option', { value: v, selected: String(v) === String(value) }, label)))));
}

/**
 * Unsaved-changes guard. A mounted page registers `{ isDirty, confirmLeave }`;
 * the router (app.js) consults it before navigating to another page, and the
 * page itself consults it before internal view/tab switches. `confirmLeave`
 * shows the discard/keep-editing prompt and calls `proceed` only on discard.
 */
export const navGuard = { current: null };
export function setNavGuard(g) { navGuard.current = g; }

/**
 * Test-mode "skip between rules" state, shared by the settings Test-mode tab
 * (which starts test mode and seeds the steps) and the global TEST MODE banner
 * (which also steps). Steps are the occurrence's ordered action moments
 * ([{ label, at }]); jumping to step i sets the virtual clock to `secondsBefore`
 * ahead of it, so the scheduler waits that long and then fires it for real.
 */
export const testModeSteps = {
  get() { try { return JSON.parse(localStorage.getItem('testmode-steps') || 'null'); } catch { return null; } },
  set(steps) { localStorage.setItem('testmode-steps', JSON.stringify(steps)); },
  index() { return Math.max(0, Number(localStorage.getItem('testmode-step-index') || 0)); },
  setIndex(i) { localStorage.setItem('testmode-step-index', String(i)); },
  seconds() { const n = Number(localStorage.getItem('testmode-seconds-before')); return Number.isFinite(n) && n >= 2 ? n : 5; },
  setSeconds(n) { localStorage.setItem('testmode-seconds-before', String(n)); },
  // Each skip fires a full zone-reconcile burst; a shared cooldown (the user's
  // pre-roll seconds PLUS this settle buffer) stops the next skip stacking on
  // top before the last one's rule has fired and its lights have played out — so
  // any bridge, not just Lutron, isn't flooded. The settle runs AFTER the rule
  // fires (which is `seconds` in), giving a slow bridge / a many-device scene
  // time to finish adjusting before the arrows re-enable. In-memory (a page
  // reload clears it, which is fine — the burst is already done).
  _settleSec: 6,
  _throttleUntil: 0,
  throttle() { this._throttleUntil = Date.now() + (this.seconds() + this._settleSec) * 1000; },
  throttleRemainingSec() { return Math.max(0, Math.ceil((this._throttleUntil - Date.now()) / 1000)); },
  clear() { localStorage.removeItem('testmode-steps'); localStorage.removeItem('testmode-step-index'); this._throttleUntil = 0; },
};

/**
 * Poll `fn` every `ms` while `node` is attached to the document. Used for
 * live status refresh on every page; stops itself on navigation.
 */
export function pollWhileMounted(node, fn, ms) {
  const timer = setInterval(() => {
    if (!document.body.contains(node)) { clearInterval(timer); return; }
    fn();
  }, ms);
  return () => clearInterval(timer);
}

/**
 * Restart the server (Docker's restart policy brings it back) with a
 * full-screen overlay that polls /api/health and reloads once it returns.
 * Also usable purely as a "waiting for the server" screen (skipRequest).
 */
export async function restartApp(message = 'Applying changes, restarting…', { skipRequest = false } = {}) {
  const overlay = el('div', { class: 'fixed inset-0 z-[60] bg-stone-950/85 backdrop-blur flex flex-col items-center justify-center gap-5 text-white p-6 text-center' },
    el('div', { class: 'animate-spin h-10 w-10 border-[3px] border-accent-400 border-t-transparent rounded-full' }),
    el('div', { class: 'text-lg font-semibold' }, message),
    el('div', { class: 'text-sm text-white/60' }, 'This page reconnects automatically.'));
  document.body.append(overlay);
  if (!skipRequest) {
    try { await fetch('/api/system/restart', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); } catch { /* it may die mid-response */ }
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let wentDown = false;
  for (let i = 0; i < 120; i++) {
    await sleep(1000);
    try {
      const res = await fetch('/api/health', { cache: 'no-store' });
      if (!res.ok) { wentDown = true; continue; }
      const h = await res.json();
      if (wentDown || h.uptimeSec < 8) { location.reload(); return; }
    } catch { wentDown = true; }
  }
  location.reload(); // give up waiting gracefully
}

export function pageHeader(title, ...actions) {
  return el('div', { class: 'flex items-center justify-between gap-3 flex-wrap mb-5' },
    el('h1', { class: 'text-2xl sm:text-3xl font-semibold tracking-tight' }, title),
    actions.length > 0 && el('div', { class: 'flex items-center gap-2 flex-wrap' }, actions));
}

// ── RGB light color ────────────────────────────────────────────────────────
// Colors are stored/sent as [r,g,b] (0–255). A small on-brand preset palette
// plus the OS color picker for anything else.
export const COLOR_PRESETS = [
  [239, 68, 68], [249, 115, 22], [245, 158, 11], [34, 197, 94],
  [6, 182, 212], [59, 130, 246], [139, 92, 246], [236, 72, 153], [255, 214, 170],
];
export const rgbToHex = (rgb) => '#' + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
export const hexToRgb = (hex) => { const h = String(hex).replace('#', ''); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) || 0); };
export const rgbEq = (a, b) => Array.isArray(a) && Array.isArray(b) && a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

/**
 * A color picker: a row of preset swatches + the native OS picker. `value` is
 * the current [r,g,b] (or null); `onChange([r,g,b])` fires on every pick. Live
 * (device-row) use passes the value straight to an API; declarative (rule /
 * scene) use stores it on the action/member.
 */
export function colorControl(value, onChange) {
  let current = Array.isArray(value) ? [...value] : null;
  const swatch = el('input', {
    type: 'color', class: 'color-swatch', value: current ? rgbToHex(current) : '#ffd6aa',
    title: 'Pick a custom color',
  });
  const btns = [];
  const paint = () => btns.forEach((b, i) => b.classList.toggle('is-active', rgbEq(current, COLOR_PRESETS[i])));
  swatch.addEventListener('input', (e) => { current = hexToRgb(e.target.value); paint(); onChange([...current]); });
  for (const rgb of COLOR_PRESETS) {
    btns.push(el('button', {
      type: 'button', class: 'color-preset', style: `background:${rgbToHex(rgb)}`,
      title: rgbToHex(rgb), 'aria-label': `Set color ${rgbToHex(rgb)}`,
      onclick: () => { current = [...rgb]; swatch.value = rgbToHex(rgb); paint(); onChange([...rgb]); },
    }));
  }
  paint();
  return el('span', { class: 'inline-flex items-center gap-1 flex-wrap' }, ...btns, swatch);
}
