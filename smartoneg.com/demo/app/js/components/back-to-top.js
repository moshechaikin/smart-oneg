import { el } from '../ui.js';
import { icon } from '../icons.js';

/**
 * A floating "back to top" button that fades in once the user has scrolled
 * down a long page (e.g. a Schedules → day page with many rules). Sits above
 * the mobile bottom tab bar and in the corner on desktop. Window-scroll based,
 * so it works on every page without per-page wiring.
 */
export function initBackToTop() {
  const btn = el('button', {
    'aria-label': 'Back to top',
    title: 'Back to top',
    class: 'fixed right-4 z-30 h-11 w-11 rounded-full bg-stone-900/80 dark:bg-white/85 text-white dark:text-stone-900 '
      + 'shadow-lg backdrop-blur flex items-center justify-center transition-all duration-200 '
      + 'opacity-0 translate-y-2 pointer-events-none hover:bg-stone-900 dark:hover:bg-white',
    // clear the mobile tab bar (safe-area aware); desktop has no bar so it sits lower
    style: 'bottom: calc(env(safe-area-inset-bottom, 0px) + 5.5rem)',
    onclick: () => window.scrollTo({ top: 0, behavior: 'smooth' }),
  }, icon('chevronUp', 'w-5 h-5'));
  // on desktop (no bottom tabs) drop it to a normal corner offset
  const mq = window.matchMedia('(min-width: 1024px)');
  const place = () => { btn.style.bottom = mq.matches ? '1.5rem' : 'calc(env(safe-area-inset-bottom, 0px) + 5.5rem)'; };
  place();
  mq.addEventListener?.('change', place);

  let shown = false;
  const onScroll = () => {
    const should = window.scrollY > 400;
    if (should === shown) return;
    shown = should;
    btn.classList.toggle('opacity-0', !should);
    btn.classList.toggle('translate-y-2', !should);
    btn.classList.toggle('pointer-events-none', !should);
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  document.body.append(btn);
}
