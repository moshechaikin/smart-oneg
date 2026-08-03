import { api } from '../api.js';
import { el, toast, clear, pollWhileMounted } from '../ui.js';
import { icon } from '../icons.js';

/**
 * Theme-aware login: warm dawn gradient with soft color glows in light mode,
 * starry night with a candle-glow horizon in dark mode. Glass card either way.
 */
export function loginPage(onSuccess) {
  const inputCls = 'w-full rounded-xl px-4 py-3 text-[16px] transition-shadow '
    + 'bg-white/70 dark:bg-white/10 border border-stone-300/70 dark:border-white/20 '
    + 'text-stone-900 dark:text-white placeholder:text-stone-400 dark:placeholder:text-white/40 '
    + 'focus:outline-none focus:ring-2 focus:ring-accent-500/60 dark:focus:ring-accent-400/70 focus:border-accent-500/60';
  // id + name matter: iOS/keychain and password managers key off them for
  // autofill; autocomplete alone isn't enough (DevTools flags it too)
  const email = el('input', {
    class: inputCls, type: 'email', id: 'login-email', name: 'email',
    autocomplete: 'username', placeholder: 'you@example.com', required: true,
  });
  const password = el('input', {
    class: inputCls, type: 'password', id: 'login-password', name: 'password',
    autocomplete: 'current-password', placeholder: '••••••••', required: true,
  });
  const submitBtn = el('button', { class: 'btn w-full !py-3 mt-7 text-base', type: 'submit' }, 'Sign in');

  const submit = async (e) => {
    e.preventDefault();
    submitBtn.disabled = true;
    try {
      await api.post('/api/auth/login', { email: email.value, password: password.value });
      onSuccess();
    } catch (err) {
      toast(err.message, 'error');
      submitBtn.disabled = false;
    }
  };

  // Instance identity + standby state, from the unauthenticated /api/health.
  // The banner tells anyone at the login screen which box this is and, for a
  // backup, whether it's standing by or has taken over, refreshed on a timer.
  const banner = el('div', { class: 'relative z-10 safe-top' });
  const roleChip = el('div', { class: 'mt-3 flex justify-center' });
  const applyHealth = (h) => {
    clear(banner); clear(roleChip);
    if (!h) return;
    const fo = h.failover;
    const standby = (fo?.role ?? h.role) === 'standby';
    // role chip under the tagline
    roleChip.append(el('span', {
      class: `inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold ${standby
        ? 'bg-sky-500/15 text-sky-700 dark:text-sky-300 border border-sky-500/30'
        : 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30'}`,
    }, icon(standby ? 'refresh' : 'server', 'w-3.5 h-3.5'), standby ? 'Backup (secondary) instance' : 'Primary instance'));
    // standby-only banner across the top
    if (standby) {
      const mk = (color, text) => el('div', { class: `${color} text-white text-center text-[13px] font-semibold px-4 py-2 shadow` }, text);
      if (fo?.active) banner.append(mk('bg-rose-600', 'Primary is DOWN, this backup is ACTIVE and controlling the lights.'));
      else if (fo?.primaryReachable === false) banner.append(mk('bg-rose-600', 'This backup cannot reach the primary right now.'));
      else banner.append(mk('bg-sky-600', 'Standby, mirroring the primary, ready to take over automatically.'));
    }
  };

  const node = el('div', { class: 'login-bg h-viewport relative overflow-hidden flex flex-col safe-top safe-bottom' },
    // decorative glows (both themes) + stars (dark only)
    el('div', { class: 'pointer-events-none absolute -bottom-40 -left-28 w-[28rem] h-[28rem] rounded-full bg-accent-400/35 dark:bg-accent-500/20 blur-3xl' }),
    el('div', { class: 'pointer-events-none absolute -top-32 -right-24 w-96 h-96 rounded-full bg-sky-300/35 dark:bg-indigo-400/10 blur-3xl' }),
    el('div', { class: 'pointer-events-none absolute top-1/3 left-1/2 -translate-x-1/2 w-72 h-72 rounded-full bg-accent-200/40 dark:bg-accent-600/10 blur-3xl' }),
    el('div', { class: 'login-stars pointer-events-none absolute inset-0' }),
    // in-flow banner so it pushes the card down instead of overlapping it
    banner,
    el('div', { class: 'flex-1 min-h-0 flex items-center justify-center p-4' },
    el('form', {
      class: 'relative rounded-3xl p-8 sm:p-10 w-full max-w-sm backdrop-blur-2xl shadow-2xl shadow-stone-900/10 dark:shadow-black/40 '
        + 'bg-white/60 dark:bg-white/10 border border-white/60 dark:border-white/15 text-stone-900 dark:text-white',
      method: 'post', action: '/api/auth/login', // recognizable login form for autofill; JS intercepts submit
      onsubmit: submit,
    },
      el('div', { class: 'text-center mb-8' },
        el('img', { src: '/demo/app/icons/icon-512.png', alt: '', class: 'w-20 h-20 rounded-2xl mb-4 mx-auto shadow-lg ring-1 ring-black/10' }),
        el('h1', { class: 'text-3xl font-bold tracking-tight' }, 'SmartOneg'),
        el('p', { class: 'text-stone-500 dark:text-white/60 mt-1.5 text-sm px-2' }, 'The Ultimate Shabbos & Yom Tov Smart Home Automation App'),
        roleChip),
      el('label', { class: 'block text-sm font-medium text-stone-600 dark:text-white/70 mb-1.5', for: 'login-email' }, 'Email'), email,
      el('label', { class: 'block text-sm font-medium text-stone-600 dark:text-white/70 mb-1.5 mt-3.5', for: 'login-password' }, 'Password'), password,
      submitBtn,
    )));

  const refresh = () => api.get('/api/health').then(applyHealth).catch(() => {});
  refresh();
  pollWhileMounted(node, refresh, 7000);
  return node;
}
