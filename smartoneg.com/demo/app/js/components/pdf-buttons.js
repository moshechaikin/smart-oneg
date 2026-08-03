import { el } from '../ui.js';
import { icon } from '../icons.js';

const inStandalone = () => window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true;
// On touch devices / the installed PWA, opening the PDF url gives the native
// iOS viewer (Quick Look) with its own share + dismiss chrome, nicer than any
// in-app viewer, so there we open natively and offer Share/Print. Desktop keeps
// the browser's PDF viewer + a plain Download.
const isMobile = () => inStandalone() || window.matchMedia?.('(pointer: coarse)').matches;

const pdfFilename = (label) => `${label.replace(/\s+/g, '-').replace(/[^\w-]/g, '').toLowerCase() || 'document'}.pdf`;

async function fetchPdfBlob(href) {
  const res = await fetch(href);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.blob();
}

// navigator.share() needs the tap's transient activation to still be live when
// it's called; on iOS that activation is easily lost across an awaited fetch, so
// PRIME the fetch on pointerdown (before the click) and, on click, share as soon
// as the blob is ready — keeping the call inside the activation window.
let primed = null; // { href, at, promise }
function primePdf(href) {
  primed = { href, at: Date.now(), promise: fetchPdfBlob(href) };
  primed.promise.catch(() => {}); // real error handling happens on the share attempt
}
function takePrimedBlob(href) {
  if (primed && primed.href === href && Date.now() - primed.at < 10_000) {
    const { promise } = primed; primed = null; return promise;
  }
  return fetchPdfBlob(href);
}

/** Hand the PDF to the native iOS share sheet (Web Share L2 — includes Print and
 *  Save to Files). If sharing is unavailable or fails, fall back to the native
 *  full-screen viewer — NOT window.open, which in the installed PWA is a
 *  swipe-only preview with no dismiss chrome. */
async function sharePdf(label, href) {
  // Web Share (files) needs a SECURE CONTEXT (https, or localhost). Served over
  // plain http on a LAN IP the app is NOT secure, so iOS leaves navigator.share
  // undefined and the sheet can never open — go straight to the native viewer
  // instead of fetching for a share that can't happen.
  if (typeof navigator.share !== 'function' || typeof navigator.canShare !== 'function') {
    return viewPdfNative(label, href);
  }
  try {
    const file = new File([await takePrimedBlob(href)], pdfFilename(label), { type: 'application/pdf' });
    if (navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: label });
      return;
    }
  } catch (err) {
    if (err?.name === 'AbortError') return; // user dismissed the share sheet — done, don't re-open
    /* any other failure: fall through to the native viewer */
  }
  viewPdfNative(label, href);
}

/** Mobile "view": fetch the PDF and trigger a blob download. In the installed
 *  PWA iOS presents that as the full-screen native preview, share icon, X to
 *  close, with no download-bar detour; in plain Safari it's the standard
 *  download pill. Falls back to a direct open if the fetch fails. */
async function viewPdfNative(label, href) {
  try {
    const res = await fetch(href);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const url = URL.createObjectURL(new Blob([await res.blob()], { type: 'application/pdf' }));
    const a = el('a', { href: url, download: pdfFilename(label) });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000); // keep alive while the preview opens
  } catch {
    window.open(href, '_blank');
  }
}

/**
 * Split button for a PDF. Desktop: the labeled segment opens it in the browser's
 * PDF viewer, the attached segment downloads it. Mobile / installed PWA: the
 * labeled segment opens the native iOS viewer directly, and the attached segment
 * is Share / Print (the iOS share sheet).
 */
export function pdfSplitButton(label, viewHref) {
  const seg = 'inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-stone-700 dark:text-stone-200 '
    + 'bg-white dark:bg-stone-900 hover:bg-stone-50 dark:hover:bg-stone-800 transition-colors';
  // PDFs are rendered by the server; in the static demo there's no server, so
  // show the control disabled instead of navigating to a dead /api/pdf link.
  if (window.__SMARTONEG_DEMO__) {
    return el('span', {
      class: 'inline-flex items-center gap-1.5 rounded-xl border border-stone-200 dark:border-stone-700 px-3 py-1.5 '
        + 'text-sm font-medium text-stone-400 dark:text-stone-500 opacity-60 cursor-not-allowed',
      title: 'PDF export runs on the server, available in the installed app, not the demo.',
    }, icon('eye', 'w-4 h-4'), label);
  }
  const mobile = isMobile();
  const dlHref = `${viewHref}${viewHref.includes('?') ? '&' : '?'}download=1`;
  return el('span', { class: 'inline-flex rounded-xl border border-stone-200 dark:border-stone-700 overflow-hidden shadow-sm' },
    // labeled segment, native full-screen preview on mobile (share + X, no
    // download-bar detour), browser PDF viewer on desktop
    mobile
      ? el('button', {
        class: seg, title: `View ${label}`, type: 'button',
        onclick: () => viewPdfNative(label, viewHref),
      }, icon('eye', 'w-4 h-4'), label)
      : el('a', {
        class: seg, href: viewHref, title: `View ${label}`, target: '_blank',
      }, icon('eye', 'w-4 h-4'), label),
    // attached segment, Share/Print on mobile, Download on desktop
    mobile
      ? el('button', {
        class: `${seg} border-l border-stone-200 dark:border-stone-700`,
        title: `Share / print ${label}`, 'aria-label': `Share or print ${label}`,
        // prime the fetch on press so share() runs inside the tap's activation window
        onpointerdown: () => primePdf(viewHref),
        onclick: () => sharePdf(label, viewHref),
      }, icon('upload', 'w-4 h-4'))
      : el('a', {
        class: `${seg} border-l border-stone-200 dark:border-stone-700`,
        href: dlHref, title: `Download ${label}`, 'aria-label': `Download ${label}`,
      }, icon('download', 'w-4 h-4')));
}
