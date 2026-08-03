import { api, onUnauthorized } from './api.js';
import { el, clear, mount, modal, toast, testModeSteps, navGuard, fmtDateRange } from './ui.js';
import { icon } from './icons.js';
import { dashboardPage } from './pages/dashboard.js';
import { calendarPage } from './pages/calendar.js';
import { schedulesPage, schedulesNavReset } from './pages/schedules.js';
import { scenesPage } from './pages/scenes.js';
import { devicesPage } from './pages/devices.js';
import { logsPage } from './pages/logs.js';
import { settingsPage } from './pages/settings.js';
import { wizardPage } from './pages/wizard.js';
import { loginPage } from './pages/login.js';
import { initPwaInstallPrompt } from './components/pwa-install.js';
import { initBackToTop } from './components/back-to-top.js';

export const APP_NAME = 'SmartOneg';
export const APP_TAGLINE = 'The Ultimate Shabbos & Yom Tov Smart Home Automation App';
export { APP_VERSION } from './version.js';
import { APP_VERSION } from './version.js';
const LOGO = '/demo/app/icons/icon-512.png';

const routes = {
  '': dashboardPage,
  dashboard: dashboardPage,
  calendar: calendarPage,
  schedules: schedulesPage,
  scenes: scenesPage,
  devices: devicesPage,
  zones: devicesPage, // legacy alias
  logs: logsPage,
  settings: settingsPage,
  wizard: wizardPage,
};

// Browser-tab title per page. The dashboard (and the login/setup screens) keep
// the app's branding title; every other page reads "<Page> | SmartOneg" so tabs
// are distinguishable. Dashboard has no entry here → falls back to the default.
const DEFAULT_TITLE = 'SmartOneg: Shabbos & Yom Tov Smart Home';
const PAGE_TITLES = {
  calendar: 'Calendar', schedules: 'Schedules', scenes: 'Scenes',
  devices: 'Devices', zones: 'Devices', logs: 'Logs', settings: 'Settings',
};
const setDocTitle = (route) => { document.title = PAGE_TITLES[route] ? `${PAGE_TITLES[route]} | SmartOneg` : DEFAULT_TITLE; };

const NAV = [
  ['dashboard', 'home', 'Dashboard'],
  ['devices', 'bulb', 'Devices'],
  ['schedules', 'clock', 'Schedules'],
  ['scenes', 'layers', 'Scenes'],
  ['calendar', 'calendar', 'Calendar'],
  ['logs', 'activity', 'Logs'],
  ['settings', 'settings', 'Settings'],
];
const MOBILE_TABS = ['dashboard', 'devices', 'schedules', 'calendar'];

const root = document.getElementById('app');
let me = null;
let healthCache = null;
let shownAuthedUI = false;

async function logout() {
  // In the browser-only demo there's no session — "Log out" leaves the demo,
  // the same as the banner's Exit button.
  if (window.__SMARTONEG_DEMO__) { location.href = '/index.html'; return; }
  await api.post('/api/auth/logout');
  location.hash = '#/';
  render();
}

function healthDot() {
  const fo = healthCache?.failover;
  const standbyIdle = fo?.role === 'standby' && !fo.active;
  const ok = healthCache?.lutronConnected;
  // on an inactive standby the bridge is intentionally not connected (it waits
  // for takeover), show a neutral "on hold" dot, not an alarming red one
  const color = standbyIdle ? 'bg-stone-400' : ok ? 'bg-emerald-500' : 'bg-rose-500';
  const title = standbyIdle
    ? 'Bridge on hold, the standby connects when it takes over'
    : ok ? 'Bridge connected' : 'Bridge disconnected';
  return el('span', { class: `inline-block w-2.5 h-2.5 rounded-full ${color}`, title, 'data-health-dot': true });
}

/** Patch the header/sidebar health dots in place from the current healthCache —
 *  so a bridge connect/disconnect updates them without a full page re-render
 *  (the dashboard card polls on its own; the dot must not lag behind it). */
function refreshHealthIndicators() {
  document.querySelectorAll('[data-health-dot]').forEach((n) => n.replaceWith(healthDot()));
}

/** A small "BACKUP" pill for the app header, shown only on a standby instance.
 *  block:true wraps it on its own line (sidebar, under the subtitle);
 *  compact:true drops the "· Active" suffix (mobile header, the color still
 *  flips to red when active) so it can't overflow a narrow title row. */
function backupBadge({ block = false, compact = false } = {}) {
  if (healthCache?.failover?.role !== 'standby' && healthCache?.role !== 'standby') return null;
  const active = healthCache?.failover?.active;
  const pill = el('span', {
    class: `inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide shrink-0 ${active
      ? 'bg-rose-100 text-rose-700 dark:bg-rose-500/20 dark:text-rose-300'
      : 'bg-sky-100 text-sky-700 dark:bg-sky-500/20 dark:text-sky-300'}`,
    title: active ? 'This backup instance is currently active (primary is down)' : 'This is the backup instance (standing by)',
  }, icon('refresh', 'w-3 h-3'), active && !compact ? 'Backup · Active' : 'Backup');
  return block ? el('div', { class: 'mt-1.5' }, pill) : pill;
}

function attribution(cls = '', beforeAbout) {
  const updateReady = healthCache?.update?.updateAvailable;
  return el('div', { class: `text-xs text-stone-400 dark:text-stone-500 ${cls}` },
    el('button', {
      class: 'relative inline-flex items-center gap-1.5 rounded-xl border border-stone-200 dark:border-stone-700 '
        + 'px-3 py-1.5 text-[13px] font-medium text-stone-600 dark:text-stone-300 '
        + 'hover:bg-stone-100 dark:hover:bg-stone-800 hover:border-stone-300 dark:hover:border-stone-600 transition-colors',
      title: updateReady ? `Update available: ${healthCache.update.latest}` : '',
      onclick: () => { beforeAbout?.(); aboutModal(); },
    }, icon('info', 'w-4 h-4'), el('span', {}, 'About'), el('span', { class: 'opacity-60' }, APP_VERSION),
      updateReady && el('span', { class: 'ml-0.5 inline-block w-2 h-2 rounded-full bg-emerald-500', title: 'Update available' })),
    // "Moshe Chaikin" kept on one line, linked to GitHub
    el('div', { class: 'mt-2' }, 'Developed by ',
      el('a', { href: 'https://github.com/moshechaikin/', target: '_blank', class: 'whitespace-nowrap underline hover:text-stone-600 dark:hover:text-stone-300' }, 'Moshe Chaikin'),
      ' · Powered by ',
      el('a', { href: 'https://github.com/hebcal/hebcal-es6', target: '_blank', class: 'whitespace-nowrap underline hover:text-stone-600 dark:hover:text-stone-300' }, 'Hebcal')));
}

/** About dialog: identity + full open-source / icon attributions. */
function aboutModal() {
  const cite = (...kids) => el('li', { class: 'text-[13px] leading-relaxed' }, ...kids);
  const link = (href, text) => el('a', { href, target: '_blank', class: 'underline hover:text-accent-600' }, text);
  const linkBtn = (href, ic, label) => el('a', {
    href, target: '_blank',
    class: 'btn-secondary inline-flex items-center gap-2',
  }, icon(ic, 'w-4.5 h-4.5'), label);
  modal({
    title: '',
    wide: true,
    body: el('div', { class: 'space-y-5' },
      // pr-8 keeps the header clear of the modal's absolute top-right X (which
      // the version text used to collide with on narrow / zoomed screens)
      el('div', { class: 'flex items-center gap-4 pr-8' },
        // Apple app-icon corner proportion (~22.37% of size), matches the PWA dock icon
        el('img', { src: LOGO, alt: '', width: 96, height: 96, decoding: 'sync', fetchpriority: 'high', class: 'w-20 h-20 sm:w-24 sm:h-24 shrink-0 shadow-lg ring-1 ring-black/10', style: 'border-radius: 22.37%' }),
        el('div', { class: 'min-w-0' },
          // name + version on one baseline row; flex-wrap drops the version to
          // its own line ONLY when the row is too narrow (zoomed/small screens),
          // so normally it sits to the right of "SmartOneg" as before. The
          // version can't split mid-token (whitespace-nowrap).
          el('div', { class: 'flex flex-wrap items-baseline gap-x-2 gap-y-0.5' },
            el('span', { class: 'text-2xl font-bold tracking-tight leading-tight' }, APP_NAME),
            el('span', { class: 'text-sm font-normal text-stone-400 whitespace-nowrap' }, APP_VERSION)),
          el('div', { class: 'text-[15px] text-stone-500 dark:text-stone-400 mt-1' }, APP_TAGLINE),
          el('div', { class: 'text-[15px] mt-0.5' }, link('https://smartoneg.com', 'smartoneg.com')))),
      healthCache?.update?.updateAvailable && el('div', { class: 'rounded-xl bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-200 dark:border-emerald-500/30 p-3.5 text-[15px]' },
        el('div', { class: 'font-semibold flex items-center gap-2 text-emerald-700 dark:text-emerald-300' }, icon('download', 'w-4.5 h-4.5'), `Update available, ${healthCache.update.latest}`),
        healthCache.update.notes && el('div', { class: 'hint mt-1 whitespace-pre-wrap' }, healthCache.update.notes),
        el('a', { href: '#/settings', class: 'btn-secondary btn-sm mt-2 inline-flex', onclick: () => document.getElementById('modal-root').replaceChildren() }, 'Go to Settings to update')),
      el('div', { class: 'flex flex-wrap gap-2.5' },
        linkBtn('https://github.com/moshechaikin/smart-oneg', 'github', 'GitHub'),
        linkBtn('https://smartoneg.com/docs', 'book', 'Docs')),
      el('p', { class: 'text-[15px]' }, 'Developed by ',
        link('https://github.com/moshechaikin/', 'Moshe Chaikin'),
        '. Powered by ', link('https://github.com/hebcal/hebcal-es6', 'Hebcal'),
        '. Built carefully with the assistance of Claude Code (not “vibe-coded” - all code has been manually reviewed and extensively tested).'),
      el('div', {},
        el('div', { class: 'font-semibold mb-1.5' }, 'Credits & open source'),
        el('ul', { class: 'space-y-1.5 list-disc list-inside text-stone-600 dark:text-stone-300' },
          cite('Zmanim & Hebrew calendar: ', link('https://github.com/hebcal/hebcal-es6', '@hebcal/core (hebcal-es6)'), ' by ', link('https://github.com/mjradwin', 'Michael J. Radwin'), ' of the Hebcal project.'),
          cite('Styling: ', link('https://tailwindcss.com', 'Tailwind CSS'), '. Printable Zmanim PDFs: ', link('https://github.com/foliojs/pdfkit', 'PDFKit'),
            '. Also uses ', link('https://expressjs.com', 'Express'), ', ', link('https://github.com/moment/luxon', 'Luxon'), ', ',
            link('https://github.com/hexagon/croner', 'croner'), ', ', link('https://github.com/davglass/zipcodes', 'zipcodes'), ', ',
            link('https://github.com/darkskyapp/tz-lookup', 'tz-lookup'), ', ', link('https://getpino.io', 'pino'), ', ',
            link('https://github.com/ai/nanoid', 'nanoid'), ', ', link('https://github.com/web-push-libs/web-push', 'web-push'),
            ' and ', link('https://nodemailer.com', 'nodemailer'), ', thanks to their maintainers.'))),
    ),
  });
}

function moreSheet(route) {
  const backdrop = el('div', { class: 'fixed inset-0 z-40 bg-stone-950/50 lg:hidden' });
  const close = () => backdrop.remove();
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  backdrop.append(el('div', { class: 'absolute bottom-0 inset-x-0 bg-white dark:bg-stone-900 rounded-t-3xl p-4 pb-8 safe-bottom' },
    el('div', { class: 'w-10 h-1 rounded-full bg-stone-300 dark:bg-stone-700 mx-auto mb-3' }),
    NAV.filter(([r]) => !MOBILE_TABS.includes(r)).map(([r, ic, label]) => el('a', {
      href: `#/${r}`, class: `nav-link ${route === r ? 'active' : ''}`, onclick: close,
    }, icon(ic), label)),
    el('button', { class: 'nav-link w-full text-left', onclick: () => { close(); logout(); } }, icon('logout'), 'Log out'),
    attribution('text-center mt-4 mb-2', close)));
  document.body.append(backdrop);
}

async function refreshShell() {
  healthCache = await api.get('/api/health').catch(() => healthCache);
  render();
}

// Optimistic banner: apply an immediate patch to healthCache and re-render ONLY
// the banner region so it appears/disappears the instant the user acts, not
// after the server has finished driving every light. Crucially this does NOT go
// through render() (which re-fetches /api/health and would clobber the patch and
// rebuild the whole page). The real state is fetched right after (refreshShell)
// and reconciles any difference.
function optimisticBanner(patch) {
  healthCache = { ...healthCache, ...patch };
  refreshBanners();
}

/** Swap in fresh sticky banners from the current healthCache and re-measure
 *  their offset (`--banner-h`), without a network fetch or page rebuild, so a
 *  banner shows/hides instantly and never covers the header/sidebar. */
function refreshBanners() {
  root.querySelectorAll('[data-banner]').forEach((b) => b.remove());
  const banners = [failoverBanner(), awayBanner(), testModeBanner(), scenePreviewBanner()].filter(Boolean);
  if (banners.length) root.prepend(...banners);
  syncBannerOffset();
}

/** Away banner, shown on every page while away mode is active OR scheduled. */
function awayBanner() {
  const away = healthCache?.away;
  if (!away?.active && !away?.scheduled) return false;
  // show which window it's covering. Preset labels already embed the date
  // (e.g. "Shabbos · Oct 10"), so use the label when present and only fall back
  // to the raw date range for a custom window that has no label — otherwise the
  // date would appear twice ("Shabbos · Oct 10 · Oct 10").
  const tag = away.label || fmtDateRange(away.from, away.to);
  const text = away.active
    ? `Away mode${tag ? ` · ${tag}` : ''}, lights simulate presence during Shabbos/Yom Tov (evenings longer, brief by day).`
    : `Away mode scheduled${tag ? ` · ${tag}` : ''}, it starts automatically as the window nears.`;
  return el('div', { 'data-banner': true, class: `banner-enter sticky top-0 z-40 text-white flex items-center gap-2 px-4 safe-top-pad pb-2 text-[14px] font-semibold shadow ${away.active ? 'bg-indigo-600' : 'bg-indigo-500'}` },
    icon('plane', 'w-4.5 h-4.5 shrink-0'),
    el('span', { class: 'flex-1 min-w-0 truncate' }, text),
    el('button', { class: 'shrink-0 rounded-lg bg-white/15 hover:bg-white/25 px-3 py-1 transition-colors', onclick: exitAwayMode }, 'Turn off'));
}

/** Turn off away mode from its banner (mirrors the dashboard toggle). */
async function exitAwayMode() {
  optimisticBanner({ away: { active: false, scheduled: false } });
  try {
    await api.post('/api/away-mode', { enabled: false });
    toast('Away mode off, back to your regular schedule.', 'info');
  } catch (err) { toast(err.message, 'error'); }
  await refreshShell();
}

/**
 * Standby-only banner, always visible on a backup instance so its state is
 * never a surprise: standing by (blue), lost contact with the primary (red),
 * or actively controlling because the primary is down (red). Primary
 * instances render nothing here.
 */
function failoverBanner() {
  const fo = healthCache?.failover;
  if (!fo || fo.role !== 'standby') return false;
  const secs = fo.pollSeconds ? `${fo.pollSeconds}s` : 'a few seconds';
  const base = 'banner-enter sticky top-0 z-40 flex items-center gap-2 px-4 safe-top-pad pb-2 text-[14px] font-semibold shadow';
  const mk = (color, ic, text) => el('div', { 'data-banner': true, class: `${base} ${color}` },
    icon(ic, 'w-4.5 h-4.5 shrink-0'), el('span', { class: 'flex-1 min-w-0' }, text));
  if (fo.active) {
    // release needs several consecutive healthy checks (deliberate hysteresis,
    // so a flapping primary can't cause churn), say so, or the ~minute where
    // the primary is back but the backup still shows ACTIVE looks stuck
    if (fo.primaryReachable === true) {
      return mk('bg-amber-500 text-stone-950', 'refresh',
        'Primary is BACK online, verifying it stays healthy, then handing control back automatically (under a minute).');
    }
    return mk('bg-rose-600 text-white', 'alert',
      `Primary is DOWN, this backup is now ACTIVE and controlling the lights. Rechecking every ${secs}; control hands back automatically when the primary returns.`);
  }
  if (fo.primaryReachable === false) {
    return mk('bg-rose-600 text-white', 'alert',
      `Cannot reach the primary${fo.primaryUrl ? ` at ${fo.primaryUrl}` : ''}, retrying every ${secs}. This backup will take over if it stays down.`);
  }
  return mk('bg-sky-600 text-white', 'refresh',
    'Standby mode, mirroring the primary. This backup takes over automatically if the primary ever goes down.');
}

async function exitTestMode() {
  testModeSteps.clear();
  clearInterval(skipCooldownTicker); skipCooldownTicker = null;
  optimisticBanner({ testMode: { active: false } });
  try { await api.del('/api/test-mode'); } catch { /* ignore */ }
  toast('Test mode off', 'success');
  await refreshShell();
}

// After a skip, the arrows cool down (pre-roll + settle, see testModeSteps) so
// the just-armed rule AND its light commands finish before the next skip — no
// back-to-back reconcile bursts flooding the bridge (any bridge). The ticker
// re-renders the banner each second to count the cooldown down, and is started
// by whichever control initiated the skip (banner arrows or the Settings twin).
let skipCooldownTicker = null;
function ensureCooldownTicker() {
  if (skipCooldownTicker) return;
  skipCooldownTicker = setInterval(() => {
    const rem = testModeSteps.throttleRemainingSec();
    if (rem <= 0) {
      clearInterval(skipCooldownTicker); skipCooldownTicker = null;
      refreshBanners(); // rebuild once, cooled down: re-enables the arrows, drops the countdown
      return;
    }
    // Update ONLY the countdown number in place. Rebuilding the whole banner
    // every second (refreshBanners) replayed its slide-in animation, so the
    // banner appeared to flash and slide down once per second. There can be two
    // countdowns on screen at once — the banner and the Settings test-mode twin.
    const spans = root.querySelectorAll('[data-testmode-countdown]');
    if (spans.length) spans.forEach((s) => { s.textContent = `${rem}s`; });
    else refreshBanners(); // countdown not on screen yet (first tick) — build it once
  }, 1000);
}

/** Step the active test-mode clock to the prev/next rule moment (banner arrows). */
async function testModeSkip(delta) {
  if (testModeSteps.throttleRemainingSec() > 0) return; // still cooling down — ignore
  const steps = testModeSteps.get();
  if (!steps?.length) return;
  const i = Math.max(0, Math.min(steps.length - 1, testModeSteps.index() + delta));
  testModeSteps.setIndex(i);
  const virtualNow = steps[i].at - testModeSteps.seconds() * 1000;
  testModeSteps.throttle();
  ensureCooldownTicker();
  toast(`Skipping to ${steps[i].label}…`, 'warn', { ms: 5000 });
  optimisticBanner({ testMode: { active: true, virtualNow: new Date(virtualNow).toISOString() } });
  try { await api.post('/api/test-mode', { virtualNow }); } catch (err) { toast(err.message, 'error'); }
  await refreshShell();
}

window.addEventListener('smartoneg:refresh-shell', refreshShell);
window.addEventListener('smartoneg:optimistic-banner', (e) => {
  optimisticBanner(e.detail);
  if (testModeSteps.throttleRemainingSec() > 0) ensureCooldownTicker(); // a Settings-panel skip started a cooldown
});

async function exitScenePreview() {
  toast('Scene preview restoring…', 'success');
  optimisticBanner({ scenePreview: { active: false } });
  try { await api.del('/api/scene-preview'); } catch { /* ignore */ }
  await refreshShell();
}

/** Banner shown while a scene preview is live (Exit restores the snapshot). */
function scenePreviewBanner() {
  const sp = healthCache?.scenePreview;
  if (!sp?.active) return false;
  return el('div', { 'data-banner': true, class: 'banner-enter sticky top-0 z-40 bg-teal-600 text-white flex items-center gap-2 px-4 safe-top-pad pb-2 text-[14px] font-semibold shadow' },
    icon('layers', 'w-4.5 h-4.5 shrink-0'),
    el('span', { class: 'flex-1 min-w-0 truncate' }, `Scene preview: “${sp.name}”, your lights are showing this scene.`),
    el('button', { class: 'shrink-0 rounded-lg bg-white/15 hover:bg-white/25 px-3 py-1 transition-colors', onclick: exitScenePreview }, 'Exit & restore'));
}

/** Fixed banner shown on every page while test mode is active. */
function testModeBanner() {
  const tm = healthCache?.testMode;
  if (!tm?.active) return false;
  const when = tm.virtualNow ? new Date(tm.virtualNow).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
  const steps = testModeSteps.get();
  const idx = testModeSteps.index();
  const cooldownSec = testModeSteps.throttleRemainingSec();
  const cooling = cooldownSec > 0;
  const arrowBtn = (label, ic, onclick, disabled) => el('button', {
    class: `shrink-0 rounded-lg bg-stone-950/15 hover:bg-stone-950/25 p-1.5 transition-colors ${disabled || cooling ? 'opacity-40 pointer-events-none' : ''}`,
    'aria-label': label, title: cooling ? `Letting the last step finish… ${cooldownSec}s` : label, onclick,
  }, icon(ic, 'w-4.5 h-4.5'));
  // safe-top-pad: in the iOS PWA the banner must start below the status bar
  // (clock/battery), not underneath it
  return el('div', { 'data-banner': true, class: 'banner-enter sticky top-0 z-40 bg-amber-500 text-stone-950 flex items-center gap-2 px-4 safe-top-pad pb-2 text-[14px] font-semibold shadow' },
    icon('alert', 'w-4.5 h-4.5 shrink-0'),
    el('span', { class: 'flex-1 min-w-0 truncate' },
      `TEST MODE, simulating ${tm.label ? `${tm.label}, ` : ''}${when}. Lights are being driven for real.`),
    steps?.length && arrowBtn('Previous rule', 'chevronLeft', () => testModeSkip(-1), idx <= 0),
    cooling && el('span', {
      class: 'shrink-0 text-[13px] font-bold tabular-nums opacity-80',
      'data-testmode-countdown': true,
      title: 'Cooling down so the bridge isn’t flooded',
    }, `${cooldownSec}s`),
    steps?.length && arrowBtn('Next rule', 'chevronRight', () => testModeSkip(1), idx >= steps.length - 1),
    el('button', { class: 'shrink-0 rounded-lg bg-stone-950/15 hover:bg-stone-950/25 px-3 py-1 transition-colors', onclick: exitTestMode }, 'Exit test mode'));
}

/** Sticky banners live above the sticky header/sidebar; publish their combined
 *  height so those can offset their `top` and never get covered. */
function syncBannerOffset() {
  const h = [...root.querySelectorAll('[data-banner]')].reduce((n, b) => n + b.offsetHeight, 0);
  document.documentElement.style.setProperty('--banner-h', `${h}px`);
}
window.addEventListener('resize', syncBannerOffset);
window.addEventListener('orientationchange', syncBannerOffset);

/** Bottom-tab internals: icon clamped to a fixed 24px slot + a leading-none
 *  label, so every tab's label sits at exactly the same height no matter how
 *  a glyph or font renders (see the nav comment below). */
const tabContent = (ic, label) => [
  el('span', { class: 'w-6 h-6 flex items-center justify-center shrink-0' }, icon(ic, 'w-6 h-6')),
  el('span', { class: 'leading-none' }, label),
];

function shell(contentNode, route) {
  const isTab = (r) => route === r || (r === 'dashboard' && route === '') || (r === 'devices' && route === 'zones');
  // Logo-header tooltip. The native title tooltip lands wherever the browser
  // puts it (too low); this custom one anchors right under the header. `pos`
  // fine-tunes the horizontal offset per header (sidebar vs mobile bar).
  const aboutTip = (pos) => el('span', {
    class: `pointer-events-none absolute top-full ${pos} z-50 whitespace-nowrap rounded-lg bg-stone-800 dark:bg-stone-700 `
      + 'px-2.5 py-1 text-xs font-medium text-white shadow-lg opacity-0 transition-opacity duration-150 group-hover:opacity-100',
  }, 'About SmartOneg');
  mount(clear(root),
    failoverBanner(),
    awayBanner(),
    testModeBanner(),
    scenePreviewBanner(),
    // Banners above are sticky, so they still occupy their height in normal
    // flow; a plain min-h-screen (100vh) below them makes the page taller than
    // the viewport by exactly the banner height (a phantom scroll on pages
    // with no real overflow). Subtract --banner-h so the column fills exactly
    // the space left under the banner. --demo-bar-h does the same for the demo's
    // fixed top bar (it's 0px in the real app, where that variable is undefined).
    el('div', { class: 'lg:flex', style: 'min-height: calc(100vh - var(--banner-h, 0px) - var(--demo-bar-h, 0px))' },
      // ── desktop sidebar ──
      el('aside', { class: 'hidden lg:flex lg:flex-col w-64 shrink-0 border-r border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 sticky top-0 h-screen', style: 'top: var(--banner-h, 0px); height: calc(100vh - var(--banner-h, 0px))' },
        el('div', { class: 'relative group px-5 pt-7 pb-5 flex items-center gap-3 cursor-pointer', onclick: aboutModal, 'aria-label': 'About SmartOneg' },
          el('img', { src: LOGO, alt: '', class: 'w-12 h-12 shadow-md ring-1 ring-black/5', style: 'border-radius: 22.37%' }),
          el('div', { class: 'min-w-0' },
            el('div', { class: 'font-bold leading-none text-xl tracking-tight' }, APP_NAME),
            el('div', { class: 'text-sm text-stone-500 dark:text-stone-400 flex items-center gap-1.5 mt-1' }, 'Jewish Smart Home ', healthDot()),
            backupBadge({ block: true })),
          aboutTip('left-5 -mt-2')),
        el('nav', { class: 'flex-1 px-3 space-y-1 overflow-y-auto' },
          NAV.map(([r, ic, label]) => el('a', {
            href: `#/${r}`, class: `nav-link ${isTab(r) ? 'active' : ''}`,
            // pressing Schedules while already there returns to the main
            // overview (with an unsaved-changes prompt if an editor is dirty)
            ...(r === 'schedules' ? { onclick: (e) => { if (isTab('schedules')) { e.preventDefault(); schedulesNavReset(); } } } : {}),
          }, icon(ic), label))),
        el('div', { class: 'p-4 space-y-2' },
          el('button', { class: 'nav-link w-full text-left', onclick: logout }, icon('logout'), 'Log out'),
          attribution('px-3.5'))),
      // ── main column ──
      el('div', { class: 'flex-1 min-w-0 flex flex-col' },
        // mobile header (safe-area aware for iOS standalone)
        el('header', { class: 'lg:hidden sticky top-0 z-30 safe-top-under-banner bg-stone-100/90 dark:bg-stone-950/90 backdrop-blur border-b border-stone-200 dark:border-stone-800', style: 'top: var(--banner-h, 0px)' },
          el('div', { class: 'flex items-center gap-2.5 px-4 py-3' },
            el('div', { class: 'relative group flex items-center gap-2.5 cursor-pointer', onclick: aboutModal, 'aria-label': 'About SmartOneg' },
              el('img', { src: LOGO, alt: '', class: 'w-9 h-9 shadow-md ring-1 ring-black/5', style: 'border-radius: 22.37%' }),
              el('span', { class: 'font-bold text-[19px] tracking-tight' }, APP_NAME),
              backupBadge({ compact: true }),
              aboutTip('left-0 mt-1')),
            el('span', { class: 'ml-auto' }, healthDot()))),
        el('main', { class: 'flex-1 px-4 sm:px-6 lg:px-10 pt-5 sm:pt-6 lg:pt-7 max-w-[100rem] w-full pb-28 lg:pb-10' }, contentNode)),
    ),
    // ── mobile bottom tabs ──
    // Every tab is byte-identical structure: the icon lives in a FIXED 24px
    // slot and the label in its own leading-none span, so no svg or font
    // metric can shift one tab relative to another. (Real iOS rendered the
    // "more" glyph with different intrinsic metrics than its siblings, sagging
    // its label a few px, even after it became an <a> like the rest.)
    el('nav', { class: 'lg:hidden fixed bottom-0 inset-x-0 z-30 bg-white/95 dark:bg-stone-900/95 backdrop-blur border-t border-stone-200 dark:border-stone-800 safe-bottom' },
      el('div', { class: 'flex' },
        MOBILE_TABS.map((r) => {
          const [, ic, label] = NAV.find(([n]) => n === r);
          return el('a', {
            href: `#/${r}`, class: `tab-link ${isTab(r) ? 'active' : ''}`,
            ...(r === 'schedules' ? { onclick: (e) => { if (isTab('schedules')) { e.preventDefault(); schedulesNavReset(); } } } : {}),
          }, ...tabContent(ic, label));
        }),
        el('a', {
          href: '#',
          class: `tab-link ${['scenes', 'logs', 'settings'].includes(route) ? 'active' : ''}`,
          onclick: (e) => { e.preventDefault(); moreSheet(route); },
        }, ...tabContent('more', 'More')))),
  );
  syncBannerOffset();
}

/** A neutral shimmer placeholder shown in the content area while a page's data
 *  loads, so navigation feels instant instead of landing on a blank panel. The
 *  chrome (sidebar/header/nav) is already painted by shell(); this only fills
 *  the content. Route-aware just enough to not look wrong (logs = one panel). */
function pageSkeleton(route) {
  const bar = (cls) => el('div', { class: `skeleton bg-stone-200 dark:bg-stone-800 rounded-lg ${cls}` });
  const header = el('div', { class: 'space-y-2.5' }, bar('h-8 w-40'), bar('h-4 w-64 opacity-70'));
  if (route === 'logs') {
    return el('div', { class: 'space-y-5', 'aria-hidden': 'true' },
      header, el('div', { class: 'flex gap-3' }, bar('h-10 w-64'), bar('h-10 w-32')), bar('h-[60vh] w-full'));
  }
  return el('div', { class: 'space-y-5', 'aria-hidden': 'true' },
    header,
    ...Array.from({ length: 4 }, (_, i) => el('div', { class: 'card space-y-3' },
      bar('h-5 w-1/3'), bar('h-4 w-full opacity-70'), bar(`h-4 ${['w-5/6', 'w-2/3', 'w-3/4', 'w-4/5'][i]} opacity-70`))));
}

export async function render() {
  const route = location.hash.replace(/^#\/?/, '').split('?')[0];
  try {
    me = await api.get('/api/auth/me');
    healthCache = await api.get('/api/health').catch(() => healthCache);
  } catch {
    clear(root).append(el('div', { class: 'min-h-screen flex items-center justify-center p-8 text-center text-stone-500' },
      'Cannot reach the server. Retrying…'));
    setTimeout(render, 3000);
    return;
  }
  if (!me.setupComplete && !me.authConfigured) {
    document.title = DEFAULT_TITLE;
    clear(root).append(await wizardPage());
    return;
  }
  if (!me.authed) {
    shownAuthedUI = false; // so the next login fades the whole app in
    document.title = DEFAULT_TITLE; // login keeps the branding title
    clear(root).append(loginPage(render));
    return;
  }
  if (route === 'wizard') {
    document.title = DEFAULT_TITLE;
    clear(root).append(await wizardPage());
    return;
  }
  const page = routes[route] ?? dashboardPage;
  setDocTitle(route);
  const node = el('div', {});
  shell(node, route);
  // content fades in on every navigation; the whole app fades in once, right
  // after login (or first load)
  node.classList.add('page-enter');
  if (!shownAuthedUI) { shownAuthedUI = true; root.firstElementChild?.classList.add('login-enter'); }
  // Shimmer placeholder for slow loads, but only after a short grace period.
  // Many pages resolve almost instantly (memoized endpoints), and showing then
  // removing the skeleton in the same breath is a jarring flash. So we arm it
  // on a timer: a fast page cancels it before it ever paints; a slow one shows
  // it just before the wait becomes noticeable.
  let skel = null;
  const skelTimer = setTimeout(() => { skel = pageSkeleton(route); node.append(skel); }, 160);
  try {
    const content = await page();
    clearTimeout(skelTimer);
    skel?.remove();
    node.append(content);
  } catch (err) {
    clearTimeout(skelTimer);
    skel?.remove();
    if (err.status !== 401) node.append(el('div', { class: 'card text-rose-600' }, `Failed to load: ${err.message}`));
  }
}

onUnauthorized.handler = () => { navGuard.current = null; render(); };

// Unsaved-changes guard: before a hash navigation, ask the mounted page's guard
// (if it has unsaved edits). Reverting the URL with replaceState keeps us on the
// current page WITHOUT re-rendering, so the discard/keep prompt can show first.
let currentHash = location.hash;
function onHashChange() {
  const g = navGuard.current;
  if (g?.isDirty?.() && location.hash !== currentHash) {
    const target = location.hash;
    history.replaceState(null, '', currentHash);
    g.confirmLeave(() => { navGuard.current = null; currentHash = target; location.hash = target; });
    return;
  }
  currentHash = location.hash;
  navGuard.current = null;
  // A real page navigation always starts at the top; nothing here should
  // carry over the previous page's scroll position (the browser otherwise
  // just clamps the old scrollY to the new page's height, landing you
  // mid-page — or even at the exact same offset — instead of at the top).
  // In-page state that must keep its scroll (the schedules editor's sub-view
  // switches, a settings save) goes through pushState/popstate or a direct
  // re-render, not hashchange, so this only affects true route changes.
  window.scrollTo(0, 0);
  render();
}
window.addEventListener('hashchange', onHashChange);
window.addEventListener('beforeunload', (e) => { if (navGuard.current?.isDirty?.()) { e.preventDefault(); e.returnValue = ''; } });

/** Remove the boot splash once the first view has mounted (login, wizard, the
 *  app, or even the "can't reach server" retry screen, anything is better than
 *  a blank splash that outlives the load). Idempotent; a hard fallback timer
 *  guarantees it never sticks. */
let splashHidden = false;
function hideSplash() {
  if (splashHidden) return;
  splashHidden = true;
  // the inline boot script (index.html) owns the reveal-delay + fade-out
  // timing; fall back to a plain removal if it somehow didn't run
  if (typeof window.__hideBootSplash === 'function') { window.__hideBootSplash(); return; }
  const s = document.getElementById('splash');
  if (!s) return;
  s.classList.add('hide');
  setTimeout(() => s.remove(), 400);
}
render().finally(hideSplash);
setTimeout(hideSplash, 8000); // safety net if the first render ever stalls

// Live banner refresh: re-poll health on a slow cadence so a failover/standby
// state change (primary goes down, comes back) surfaces its banner within
// seconds on ANY page, without rebuilding the whole view. render() reconciles
// on the next navigation.
setInterval(async () => {
  if (!me?.authed) return;
  const h = await api.get('/api/health').catch(() => null);
  if (!h) return;
  // a failover takeover/release changes the nav badge + dashboard cards too,
  // so re-render the whole view; lesser changes only refresh the banners
  const failoverChanged = h.failover?.active !== healthCache?.failover?.active
    || (h.failover?.role ?? h.role) !== (healthCache?.failover?.role ?? healthCache?.role);
  const bannerChanged = h.failover?.primaryReachable !== healthCache?.failover?.primaryReachable
    || h.away?.active !== healthCache?.away?.active
    || h.away?.scheduled !== healthCache?.away?.scheduled
    || h.lutronConnected !== healthCache?.lutronConnected;
  healthCache = h;
  if (failoverChanged) render();
  else if (bannerChanged) { refreshBanners(); refreshHealthIndicators(); }
}, 8000);
initPwaInstallPrompt();
initBackToTop();
initTooltips();

/**
 * Instant styled tooltips on hover (desktop only). Native title tooltips have a
 * ~1s delay and are easy to miss; this shows a small dark pill immediately, and
 * suppresses the native one. Two sources: any element with an explicit `title`,
 * and any `.truncate` label whose text is actually clipped (so a cut-off name
 * reveals itself in full on hover) — the latter needs no `title` in the markup.
 */
function initTooltips() {
  if (window.matchMedia('(hover: none)').matches) return; // no hover on touch devices
  let tip = null;
  let owner = null; // the element the current tooltip belongs to
  const hide = () => {
    tip?.remove(); tip = null;
    // restore a native title we suppressed (truncate-derived tips never had one)
    if (owner && owner.dataset.tiptext !== undefined) { owner.setAttribute('title', owner.dataset.tiptext); delete owner.dataset.tiptext; }
    owner = null;
  };
  document.addEventListener('pointerover', (e) => {
    if (e.pointerType === 'touch') return;
    let target = e.target.closest('[title]');
    let text = target?.getAttribute('title') || '';
    // no explicit title? fall back to a clipped truncate label's full text
    if (!text) {
      const tr = e.target.closest('.truncate');
      if (tr && tr.scrollWidth > tr.clientWidth + 1) { target = tr; text = tr.textContent.trim(); }
    }
    // moving within the same element (over its child icon/text) must NOT recreate
    // the tooltip, only show a NEW one when hovering a different element
    if (!target || !text || target === owner) return;
    hide();
    owner = target;
    if (target.hasAttribute('title')) { target.dataset.tiptext = text; target.removeAttribute('title'); } // suppress the native tooltip
    tip = el('div', { class: 'tooltip-pop' }, text);
    document.body.append(tip);
    const r = target.getBoundingClientRect();
    // clamp the centre so the pill keeps a comfortable margin from either edge
    const M = 14;
    const half = tip.offsetWidth / 2;
    const cx = Math.min(Math.max(r.left + r.width / 2, M + half), window.innerWidth - M - half);
    tip.style.left = `${Math.round(cx)}px`;
    tip.style.top = `${Math.round(r.top - 8)}px`;
    if (r.top < tip.offsetHeight + 16) { tip.style.top = `${Math.round(r.bottom + 8)}px`; tip.dataset.below = '1'; }
  });
  document.addEventListener('pointerout', (e) => {
    // ignore moves that stay inside the owner element (child → child)
    if (owner && (e.relatedTarget == null || !owner.contains(e.relatedTarget))) hide();
  });
  document.addEventListener('click', hide, true); // dismiss on click
}

if ('serviceWorker' in navigator) {
  Promise.reject('demo').catch(() => {});
}
