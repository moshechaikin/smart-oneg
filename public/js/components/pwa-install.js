import { el } from '../ui.js';
import { icon } from '../icons.js';

const DISMISS_KEY = 'pwa-install-dismissed';

/**
 * On mobile browsers (not in standalone/PWA mode), show a one-time dismissable
 * sheet explaining how to add the app to the home screen.
 */
export function initPwaInstallPrompt() {
  const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  const mobile = /android|iphone|ipad|ipod/i.test(navigator.userAgent);
  if (standalone || !mobile || localStorage.getItem(DISMISS_KEY)) return;

  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const steps = isIOS
    ? ['Tap the Share button in Safari', 'Scroll down and tap “Add to Home Screen”', 'Tap “Add”, the app opens full-screen from your home screen']
    : ['Open the browser menu (⋮)', 'Tap “Install app” (or “Add to Home screen”)', 'Confirm, the app opens full-screen from your home screen'];

  const backdrop = el('div', { class: 'fixed inset-0 z-50 bg-stone-950/50 flex items-end sm:items-center justify-center' });
  const dismiss = () => { localStorage.setItem(DISMISS_KEY, '1'); backdrop.remove(); };
  backdrop.append(el('div', { class: 'card w-full sm:max-w-md rounded-b-none sm:rounded-b-card',
    style: 'padding-bottom: calc(env(safe-area-inset-bottom, 0px) + 1.5rem)' },
    el('div', { class: 'flex items-start justify-between mb-2' },
      el('h3', { class: 'text-xl font-semibold flex items-center gap-2.5' },
        el('span', { class: 'text-accent-600' }, icon('download', 'w-6 h-6')), 'Install this app'),
      el('button', { class: 'icon-btn', onclick: dismiss }, icon('x'))),
    el('p', { class: 'hint mb-4' },
      'Add SmartOneg to your home screen for full-screen access and push alerts.'),
    el('ol', { class: 'list-decimal list-inside text-[15px] space-y-2' },
      steps.map((s) => el('li', {}, s))),
    el('button', { class: 'btn-secondary w-full mt-6', onclick: dismiss }, 'Got it'),
  ));
  document.body.append(backdrop);
}
