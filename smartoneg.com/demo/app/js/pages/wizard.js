import { api } from '../api.js';
import { el, clear, mount, toast, field, checkRow, select, jsonInput } from '../ui.js';
import { icon } from '../icons.js';
import { APP_VERSION } from '../version.js';

/**
 * First-run setup wizard.
 * 0 welcome/import -> 1 role -> 2 location & times -> 3 ecosystems (pick
 * Home Assistant / Lutron / Hubitat / Homebridge, set it up, optionally add
 * more) -> 4 account -> 5 notifications -> 6 enforcement -> done.
 */
export async function wizardPage() {
  const data = {
    role: 'primary', primaryUrl: '', syncToken: '',
    location: null, candleLightingMins: 18, havdalahMins: 45, il: false, locale: 'ashkenazi',
    ecosystems: {
      lutron: { chosen: false, host: '', report: null },
      homeassistant: { chosen: false, host: '', token: '' },
      hubitat: { chosen: false, host: '', appId: '', accessToken: '' },
      homebridge: { chosen: false, host: '', username: '', password: '' },
    },
    email: '', password: '',
    ntfyEnabled: false, ntfyTopic: '', ntfyServer: '', gmailEnabled: false, gmailUser: '', gmailAppPassword: '',
    enforcement: false,
  };
  let step = 0;
  let ecoScreen = null; // null = picker; 'lutron'|'homeassistant'|'hubitat' = that setup form
  let standbyConnecting = false; // standby path: skip the rest, just mirror the primary
  let standbyStarted = false;    // guards the one-shot connect routine
  const TOTAL = 7;

  // same backdrop as the login page (gradient + glows + dark-mode stars)
  const stage = el('div', { class: 'relative z-10 w-full flex justify-center' });
  const container = el('div', { class: 'login-bg min-h-screen relative overflow-hidden safe-top safe-bottom flex items-center justify-center p-4 py-8' },
    el('div', { class: 'pointer-events-none absolute -bottom-40 -left-28 w-[28rem] h-[28rem] rounded-full bg-accent-400/35 dark:bg-accent-500/20 blur-3xl' }),
    el('div', { class: 'pointer-events-none absolute -top-32 -right-24 w-96 h-96 rounded-full bg-sky-300/35 dark:bg-indigo-400/10 blur-3xl' }),
    el('div', { class: 'pointer-events-none absolute top-1/3 left-1/2 -translate-x-1/2 w-72 h-72 rounded-full bg-accent-200/40 dark:bg-accent-600/10 blur-3xl' }),
    el('div', { class: 'login-stars pointer-events-none absolute inset-0' }),
    stage);
  const draw = () => mount(clear(stage), render());
  const next = () => { step++; ecoScreen = null; draw(); };
  const back = () => { if (ecoScreen) { ecoScreen = null; } else { step--; } draw(); };

  const nav = (nextLabel = 'Continue', { onNext, skippable } = {}) => el('div', { class: 'flex justify-between items-center mt-8' },
    step > 0 || ecoScreen ? el('button', { class: 'btn-ghost', onclick: back }, icon('chevronLeft', 'w-5 h-5'), 'Back') : el('span', {}),
    el('div', { class: 'flex gap-2.5' },
      skippable && el('button', { class: 'btn-secondary', onclick: next }, 'Skip'),
      el('button', { class: 'btn', onclick: async () => { if (!onNext || await onNext() !== false) next(); } }, nextLabel)));

  function shell(title, subtitle, ...body) {
    const opts = body.length && body[0] && body[0].__shellOpts ? body.shift() : {};
    return el('div', { class: 'card w-full max-w-2xl !p-6 sm:!p-9' },
      el('div', { class: 'flex items-center gap-2 mb-5' },
        [...Array(TOTAL)].map((_, i) => el('span', {
          class: `h-1.5 rounded-full transition-all ${i === step ? 'w-8 bg-accent-500' : `w-3 ${i < step ? 'bg-accent-300 dark:bg-accent-700' : 'bg-stone-200 dark:bg-stone-700'}`}`,
        }))),
      opts.logo && el('img', { src: '/demo/app/icons/icon-512.png', alt: '', class: `w-24 h-24 rounded-2xl mb-4 shadow-lg ring-1 ring-black/10 ${opts.center ? 'mx-auto' : ''}` }),
      el('h2', { class: `text-2xl font-semibold tracking-tight ${opts.center ? 'text-center' : ''}` }, title),
      subtitle ? el('p', { class: `hint mt-1.5 mb-6 ${opts.center ? 'text-center' : ''}` }, subtitle) : el('div', { class: 'mb-6' }),
      ...body);
  }
  const shellOpts = (o) => ({ ...o, __shellOpts: true });

  /* ── ecosystem sub-screens ─────────────────────────────────────────────── */

  const chosenList = () => Object.entries(data.ecosystems).filter(([, e]) => e.chosen).map(([k]) => k);

  function ecoPicker() {
    const chosen = chosenList();
    // ecosystems with a brand logo (PNG/WebP) instead of a generic line icon
    const IMG_ICONS = { homeassistant: '/demo/app/icons/home-assistant-icon.png', lutron: '/demo/app/icons/lutron-icon.png', hubitat: '/demo/app/icons/hubitat-icon.png', homebridge: '/demo/app/icons/homebridge-icon.png' };
    const cards = [
      ['homeassistant', 'home', 'Home Assistant', 'Import and connect to devices from a local HA instance over websocket.'],
      ['lutron', 'server', 'Lutron Caséta bridge', 'Smart Bridge PRO with telnet integration.'],
      ['hubitat', 'server', 'Hubitat hub', 'Local hub bridging Zigbee, Z-Wave and Ecobee devices.'],
      ['homebridge', 'server', 'Homebridge', 'Import HomeKit accessories via the config-ui-x API (polled).'],
    ];
    return shell(
      chosen.length === 0 ? 'What runs your lights?' : 'Add another provider?',
      chosen.length === 0
        ? 'Pick what you primarily use. You can add the others right after, or any time later from the Devices page.'
        : 'You can also add more later from the Devices page.',
      el('div', { class: 'space-y-3' },
        cards.map(([key, ic, title, desc]) => el('button', {
          class: `w-full text-left rounded-xl border-2 p-4 sm:p-5 flex items-center gap-4 transition-colors ${data.ecosystems[key].chosen
            ? 'border-emerald-400 bg-emerald-50/60 dark:bg-emerald-500/10'
            : 'border-stone-200 dark:border-stone-700 hover:border-accent-400'}`,
          onclick: () => { ecoScreen = key; draw(); },
        },
          el('span', { class: data.ecosystems[key].chosen ? 'text-emerald-600' : 'text-accent-600 dark:text-accent-400' },
            data.ecosystems[key].chosen ? icon('check', 'w-7 h-7')
              : IMG_ICONS[key]
                // the Homebridge mark is a circle, so it reads a touch small in
                // a square box next to the others — nudge it up to match
                ? el('img', { src: IMG_ICONS[key], alt: '', class: `w-7 h-7 object-contain ${key === 'homebridge' ? 'scale-[1.15]' : ''}` })
                : icon(ic, 'w-7 h-7')),
          el('div', { class: 'flex-1' },
            el('div', { class: 'font-semibold text-[16px]' }, title),
            el('div', { class: 'hint' }, data.ecosystems[key].chosen ? 'Configured, click to edit' : desc))))),
      el('p', { class: 'hint mt-4 flex items-start gap-2' },
        icon('info', 'w-4 h-4 shrink-0 mt-0.5'),
        el('span', {}, 'EnvisaLink and Matter devices can be added later from the app’s Settings → Devices.')),
      chosen.length > 0
        ? el('div', { class: 'flex justify-between items-center mt-8' },
          el('button', { class: 'btn-ghost', onclick: () => { step--; draw(); } }, icon('chevronLeft', 'w-5 h-5'), 'Back'),
          el('button', { class: 'btn', onclick: next }, 'Continue setup', icon('chevronRight', 'w-5 h-5')))
        : el('div', { class: 'flex justify-between items-center mt-8' },
          el('button', { class: 'btn-ghost', onclick: () => { step--; draw(); } }, icon('chevronLeft', 'w-5 h-5'), 'Back'),
          el('button', { class: 'btn-secondary', onclick: next }, 'Skip for now')),
    );
  }

  function lutronScreen() {
    const eco = data.ecosystems.lutron;
    const host = el('input', { class: 'input', value: eco.host, placeholder: 'e.g., 192.168.0.100' });
    const testResult = el('div', { class: 'text-[15px] min-h-6 mt-2' });
    const ji = jsonInput({ placeholder: 'Paste the integration report JSON here…', rows: 'h-36' });
    if (eco.report) ji.setValue(JSON.stringify(eco.report));
    return shell('Set up the Lutron bridge', null,
      el('p', { class: 'hint mb-4' }, 'One-time steps in the Lutron app. Requires a ',
        el('b', { class: 'text-stone-700 dark:text-stone-200' }, 'Smart Bridge PRO (L-BDGPRO2)'), '.'),
      el('ol', { class: 'list-decimal list-inside text-[15px] space-y-2.5 mb-6' },
        el('li', {}, el('b', {}, 'Enable telnet: '), 'Lutron app → Settings → Advanced → Integration → turn ', el('b', {}, '“Telnet Support” ON'), '.'),
        el('li', {}, el('b', {}, 'Get the report: '), 'on that same screen tap ', el('b', {}, '“Send Integration Report”'), ' and email it to yourself. Paste the JSON below.'),
        el('li', {}, el('b', {}, 'Pin the IP: '), 'give the bridge a static IP (router DHCP reservation, or Lutron app → Advanced → Network). If the IP changes mid-Shabbos, automation breaks.')),
      el('div', { class: 'space-y-4' },
        field('Bridge IP address', el('div', { class: 'flex gap-2.5' }, host,
          el('button', {
            class: 'btn-secondary shrink-0',
            onclick: async () => {
              mount(clear(testResult), 'Connecting…');
              try {
                const res = await api.post('/api/settings/lutron/test', { host: host.value });
                mount(clear(testResult), el('span', { class: 'text-emerald-600 font-medium' }, `✓ Connected, ${Object.keys(res.levels).length} devices responded`));
              } catch (err) {
                mount(clear(testResult), el('span', { class: 'text-rose-600' }, `✗ ${err.message}`));
              }
            },
          }, 'Test'))),
        testResult,
        field('Integration report JSON', ji.node)),
      nav('Save Lutron setup', {
        onNext: () => {
          eco.host = host.value;
          if (ji.raw().trim()) {
            if (!ji.valid()) { toast('The report isn’t valid JSON, check the highlighted error', 'warn'); return false; }
            eco.report = ji.parse();
          }
          eco.chosen = true;
          ecoScreen = null; draw();
          return false; // stay in the ecosystems step (picker shows the ✓)
        },
      }));
  }

  function hubitatScreen() {
    const eco = data.ecosystems.hubitat;
    const host = el('input', { class: 'input', value: eco.host, placeholder: '192.168.0.50' });
    const appId = el('input', { class: 'input', value: eco.appId, placeholder: 'e.g. 5' });
    const token = el('input', { class: 'input', value: eco.accessToken, placeholder: 'access token' });
    return shell('Set up the Hubitat hub', 'On the hub: Apps → add the built-in “Maker API” app → select your devices → copy the app id and access token from the example URLs it shows.',
      el('div', { class: 'grid sm:grid-cols-3 gap-4' },
        field('Hub IP', host), field('Maker API app ID', appId), field('Access token', token)),
      el('p', { class: 'hint mt-4' }, 'Zigbee / Z-Wave devices and Ecobee thermostats paired to the hub become available here. You pick which to import after setup finishes.'),
      nav('Save Hubitat setup', {
        onNext: () => {
          if (!host.value || !appId.value || !token.value) { toast('All three fields are needed', 'warn'); return false; }
          Object.assign(eco, { host: host.value, appId: appId.value, accessToken: token.value, chosen: true });
          ecoScreen = null; draw();
          return false;
        },
      }));
  }

  function homebridgeScreen() {
    const eco = data.ecosystems.homebridge;
    const host = el('input', { class: 'input', value: eco.host, placeholder: '192.168.0.30:8581' });
    const user = el('input', { class: 'input', value: eco.username, placeholder: 'admin' });
    const pass = el('input', { class: 'input', type: 'password', value: eco.password, placeholder: 'password' });
    const testResult = el('div', { class: 'text-[15px] min-h-6' });
    return shell('Set up Homebridge', 'Homebridge must run in insecure mode (-I) so its config-ui-x API exposes accessory state. Enter the config-ui-x web address and login below.',
      el('div', { class: 'grid sm:grid-cols-3 gap-4' },
        field('config-ui-x address', host), field('Username', user, 'Blank = no-auth mode'), field('Password', pass)),
      el('div', { class: 'flex items-center gap-3 mt-4' },
        el('button', {
          class: 'btn-secondary shrink-0',
          onclick: async () => {
            if (!host.value) { toast('Enter the address first', 'warn'); return; }
            mount(clear(testResult), 'Connecting…');
            try {
              const res = await api.post('/api/homebridge/discover', { host: host.value, username: user.value, ...(pass.value ? { password: pass.value } : {}) });
              mount(clear(testResult), el('span', { class: 'text-emerald-600 font-medium' }, `✓ Connected, ${res.devices.length} accessories found`));
            } catch (err) {
              mount(clear(testResult), el('span', { class: 'text-rose-600' }, `✗ ${err.message}`));
            }
          },
        }, 'Test connection'),
        testResult),
      el('p', { class: 'hint mt-4' }, 'State is polled, so Child Lock corrections lag a few seconds. Prefer Home Assistant or Hubitat for enforced devices. You pick which accessories to import after setup finishes, from the Devices page.'),
      nav('Save Homebridge setup', {
        onNext: () => {
          if (!host.value) { toast('The config-ui-x address is needed', 'warn'); return false; }
          Object.assign(eco, { host: host.value, username: user.value, password: pass.value, chosen: true });
          ecoScreen = null; draw();
          return false;
        },
      }));
  }

  function homeAssistantScreen() {
    const eco = data.ecosystems.homeassistant;
    const host = el('input', { class: 'input', value: eco.host, placeholder: '192.168.0.20:8123' });
    const token = el('input', { class: 'input', value: eco.token, placeholder: 'long-lived access token' });
    const testResult = el('div', { class: 'text-[15px] min-h-6' });
    return shell('Set up Home Assistant', 'In Home Assistant: your profile → Security → Long-lived access tokens → Create token. Paste the address and token below.',
      el('div', { class: 'grid sm:grid-cols-2 gap-4' },
        field('Home Assistant address', host),
        field('Long-lived access token', token)),
      el('div', { class: 'flex items-center gap-3 mt-4' },
        el('button', {
          class: 'btn-secondary shrink-0',
          onclick: async () => {
            if (!host.value || !token.value) { toast('Enter the address and token first', 'warn'); return; }
            mount(clear(testResult), 'Connecting…');
            try {
              const res = await api.post('/api/homeassistant/discover', { host: host.value, token: token.value });
              mount(clear(testResult), el('span', { class: 'text-emerald-600 font-medium' }, `✓ Connected, ${res.devices.length} devices found`));
            } catch (err) {
              mount(clear(testResult), el('span', { class: 'text-rose-600' }, `✗ ${err.message}`));
            }
          },
        }, 'Test connection'),
        testResult),
      el('p', { class: 'hint mt-4' }, 'Lights, switches and thermostats arrive over websocket, so Child Lock works at full speed. You pick which devices to import after setup finishes, from the Devices page.'),
      nav('Save Home Assistant setup', {
        onNext: () => {
          if (!host.value || !token.value) { toast('Address and token are both needed', 'warn'); return false; }
          Object.assign(eco, { host: host.value, token: token.value, chosen: true });
          ecoScreen = null; draw();
          return false;
        },
      }));
  }

  /* ── main steps ────────────────────────────────────────────────────────── */

  function render() {
    if (standbyConnecting) return standbyConnectScreen();
    if (step === 3 && ecoScreen === 'lutron') return lutronScreen();
    if (step === 3 && ecoScreen === 'homeassistant') return homeAssistantScreen();
    if (step === 3 && ecoScreen === 'hubitat') return hubitatScreen();
    if (step === 3 && ecoScreen === 'homebridge') return homebridgeScreen();

    switch (step) {
      case 0: {
        const ji = jsonInput({ placeholder: 'Paste exported config.json…', rows: 'h-32' });
        ji.node.classList.add('hidden');
        const importBtn = el('button', {
          class: 'btn-secondary w-full hidden',
          onclick: async () => {
            try {
              await api.post('/api/config/import', ji.parse());
              toast('Configuration imported, all set!', 'success');
              location.hash = '#/';
              location.reload();
            } catch (err) { toast(err.message, 'error'); }
          },
        }, 'Import and finish');
        const link = (href, label) => el('a', { href, target: '_blank', class: 'whitespace-nowrap underline hover:text-stone-600 dark:hover:text-stone-300' }, label);
        return shell('Welcome to SmartOneg', 'The Ultimate Shabbos & Yom Tov Smart Home Automation App',
          shellOpts({ logo: true, center: true }),
          el('div', { class: 'flex flex-col items-center gap-3' },
            el('button', { class: 'btn !py-3 !px-12', onclick: next }, 'Start setup'),
            el('button', {
              class: 'btn-secondary',
              onclick: () => { ji.node.classList.toggle('hidden'); importBtn.classList.toggle('hidden'); },
            }, icon('upload', 'w-5 h-5'), 'Restore from an exported config'),
            el('div', { class: 'w-full' }, ji.node), importBtn),
          el('p', { class: 'text-center text-xs text-stone-400 mt-8' },
            'Developed by ', link('https://github.com/moshechaikin/', 'Moshe Chaikin'), ' · Powered by ', link('https://github.com/hebcal/hebcal-es6', 'Hebcal'),
            el('span', { class: 'block mt-1 opacity-75' }, APP_VERSION)));
      }
      case 1: {
        const url = el('input', { class: 'input', placeholder: 'http://192.168.0.10:1836', value: data.primaryUrl });
        const tok = el('input', { class: 'input', placeholder: 'sync token from the primary’s Settings page', value: data.syncToken });
        const roleBtn = (value, ic, title, desc) => el('button', {
          class: `w-full text-left rounded-xl border-2 p-4 sm:p-5 flex items-center gap-4 transition-colors ${data.role === value
            ? 'border-accent-500 bg-accent-50 dark:bg-accent-600/10'
            : 'border-stone-200 dark:border-stone-700 hover:border-accent-300'}`,
          onclick: () => { data.role = value; draw(); },
        },
          el('span', { class: value === 'standby' ? 'text-sky-600 dark:text-sky-400' : 'text-accent-600 dark:text-accent-400' }, icon(ic, 'w-7 h-7')),
          el('div', {},
            el('div', { class: 'font-semibold text-[16px]' }, title),
            el('div', { class: 'hint' }, desc)));
        return shell('What is this instance?', null,
          el('div', { class: 'space-y-3' },
            roleBtn('primary', 'server', 'Primary', 'Runs the lights. Choose this on your main server (NAS, mini PC).'),
            roleBtn('standby', 'refresh', 'Standby backup', 'Mirrors a primary and takes over automatically if it goes down.')),
          data.role === 'standby' && el('div', { class: 'mt-5 space-y-4' },
            field('Primary URL', url),
            field('Sync token', tok, 'Copy it from the primary: Settings → System tab → Copy sync token.'),
            el('p', { class: 'hint' }, 'A backup needs nothing else, it copies the location, schedules, devices and login from the primary automatically.')),
          nav(data.role === 'standby' ? 'Connect to primary' : 'Continue', { onNext: () => {
            data.primaryUrl = url?.value ?? ''; data.syncToken = tok?.value ?? '';
            if (data.role === 'standby') {
              if (!data.primaryUrl || !data.syncToken) { toast('Enter the primary URL and its sync token', 'warn'); return false; }
              standbyConnecting = true; standbyStarted = false; draw();
              return false; // don't advance, the connect screen takes over
            }
          } }));
      }
      case 2: {
        const zip = el('input', { class: 'input !w-44', placeholder: '10952', inputmode: 'numeric', autocomplete: 'postal-code', name: 'postal-code', value: data.location?.zip ?? '' });
        const found = el('div', { class: 'text-[15px] min-h-6 mt-1.5' },
          data.location ? `✓ ${data.location.city}, ${data.location.state} · ${data.location.tzid}` : '');
        const candles = el('input', { class: 'input', type: 'number', value: data.candleLightingMins });
        const havdalah = el('input', { class: 'input', type: 'number', value: data.havdalahMins });
        const ilRow = checkRow('Israel mode (one-day Yom Tov)', { checked: data.il });
        const locale = select([
          ['ashkenazi', 'Ashkenazi, Shabbos, Sukkos (default)'], ['en', 'Sephardic, Shabbat, Sukkot'],
          ['he', 'Hebrew (שַׁבָּת, סוּכּוֹת)'], ['he-x-NoNikud', 'Hebrew, no nikud (שבת, סוכות)'],
        ], data.locale);
        zip.addEventListener('input', async () => {
          if (zip.value.length !== 5) return;
          try {
            data.location = await api.get(`/api/zip/${zip.value}`);
            found.textContent = `✓ ${data.location.city}, ${data.location.state} · ${data.location.tzid}`;
            found.className = 'text-[15px] min-h-6 mt-1.5 text-emerald-600 font-medium';
          } catch { found.textContent = 'Zip code not found'; found.className = 'text-[15px] min-h-6 mt-1.5 text-rose-600'; data.location = null; }
        });
        // Israel mode: a curated city dropdown instead of a US zip lookup
        const citySel = el('select', { class: 'select', onchange: async () => {
          if (!citySel.value) { data.location = null; cityFound.textContent = ''; return; }
          try {
            data.location = await api.get(`/api/il-city/${encodeURIComponent(citySel.value)}`);
            cityFound.textContent = `✓ ${data.location.city} · ${data.location.tzid}`;
            cityFound.className = 'text-[15px] min-h-6 mt-1.5 text-emerald-600 font-medium';
          } catch { data.location = null; }
        } });
        const cityFound = el('div', { class: 'text-[15px] min-h-6 mt-1.5' });
        const zipBlock = el('div', { class: data.il ? 'hidden' : '' }, el('label', { class: 'label' }, 'US zip code'), zip, found);
        const cityBlock = el('div', { class: data.il ? '' : 'hidden' }, el('label', { class: 'label' }, 'Israeli city'), citySel, cityFound);
        api.get('/api/il-cities').then((cities) => {
          mount(clear(citySel), el('option', { value: '' }, 'Select a city…'),
            cities.map((c) => el('option', { value: c.name, selected: c.name === data.location?.city }, c.he ? `${c.name} · ${c.he}` : c.name)));
        }).catch(() => {});
        const syncLocMode = () => {
          const isIL = ilRow.input.checked;
          zipBlock.classList.toggle('hidden', isIL);
          cityBlock.classList.toggle('hidden', !isIL);
          // re-resolve the ACTIVE mode's current input rather than stranding a
          // valid entry (a typed zip stays valid when you toggle IL off again)
          data.location = null; found.textContent = ''; cityFound.textContent = '';
          if (isIL) { if (citySel.value) citySel.dispatchEvent(new Event('change')); }
          else if (zip.value.length === 5) zip.dispatchEvent(new Event('input'));
        };
        // Israel's common candle-lighting default is 20 min; diaspora is 18.
        // Nudge between the two on toggle, but never clobber a custom value.
        ilRow.input.addEventListener('change', () => {
          if (ilRow.input.checked && Number(candles.value) === 18) candles.value = 20;
          else if (!ilRow.input.checked && Number(candles.value) === 20) candles.value = 18;
        });
        ilRow.input.addEventListener('change', syncLocMode);
        return shell('Location & halachic times', 'Everything is computed on this device, no internet services involved.',
          el('div', { class: 'space-y-5' },
            zipBlock, cityBlock,
            ilRow.node,
            el('div', { class: 'grid sm:grid-cols-2 gap-4' },
              field('Candle lighting, minutes before shkia (sunset)', candles, null, { labelClass: 'sm:min-h-10' }),
              field('Havdalah, minutes after shkia (sunset)', havdalah, '45 is common · 72 for Rabbeinu Tam', { labelClass: 'sm:min-h-10' })),
            field('Holiday name style', locale)),
          nav('Continue', {
            onNext: () => {
              if (!data.location) { toast('Enter a valid zip code first', 'warn'); return false; }
              data.candleLightingMins = Number(candles.value);
              data.havdalahMins = Number(havdalah.value);
              data.il = ilRow.input.checked;
              data.locale = locale.value;
            },
          }));
      }
      case 3:
        return ecoPicker();
      case 4: {
        const email = el('input', { class: 'input', type: 'email', autocomplete: 'username', placeholder: 'you@example.com', value: data.email });
        const pass = el('input', { class: 'input', type: 'password', autocomplete: 'new-password', placeholder: 'At least 8 characters' });
        const pass2 = el('input', { class: 'input', type: 'password', autocomplete: 'new-password', placeholder: 'Re-enter your password' });
        return shell('Create your account', 'This is the login for the app.',
          el('div', { class: 'space-y-4' },
            field('Email', email), field('Password', pass), field('Confirm password', pass2)),
          nav('Continue', {
            onNext: () => {
              if (!email.value || pass.value.length < 8) { toast('Email and a password of 8+ characters are required', 'warn'); return false; }
              if (pass.value !== pass2.value) { toast('The two passwords don’t match', 'warn'); return false; }
              data.email = email.value; data.password = pass.value;
            },
          }));
      }
      case 5: {
        const topic = el('input', { class: 'input', placeholder: 'a-hard-to-guess-topic-name', value: data.ntfyTopic });
        const ntfyServer = el('input', { class: 'input', placeholder: 'https://ntfy.sh', value: data.ntfyServer });
        // name/autocomplete hardening so password managers don't autofill the
        // owner's login into the Gmail sender fields (they read as a login form)
        const gUser = el('input', { class: 'input', placeholder: 'you@gmail.com', value: data.gmailUser, name: 'gmail-sender', autocomplete: 'off' });
        const gPass = el('input', { class: 'input', type: 'password', placeholder: 'Gmail app password', name: 'gmail-app-password', autocomplete: 'new-password' });

        const ntfyOn = checkRow('Push notifications via ntfy.sh', {
          checked: data.ntfyEnabled,
          hint: el('span', {}, 'Get the ntfy mobile app for iOS and Android and subscribe to this same topic. Learn more at ',
            el('a', { href: 'https://ntfy.sh', target: '_blank', rel: 'noopener', class: 'underline hover:text-stone-600 dark:hover:text-stone-300' }, 'ntfy.sh'), '.'),
        });
        const gmailOn = checkRow('Email notifications via Gmail', {
          checked: data.gmailEnabled,
          hint: 'Receive email notifications via Gmail (your credentials are saved locally and stay private). Pre-Yom Tov schedule summaries are sent via Gmail only.',
        });

        const ntfyBody = el('div', { class: 'mt-3 grid sm:grid-cols-2 gap-4' },
          field('Topic', topic),
          field('Server', ntfyServer, 'Defaults to https://ntfy.sh (the free public service). Only change it if you run your own ntfy server.'));
        const gmailBody = el('div', { class: 'mt-3 grid sm:grid-cols-2 gap-4' },
          field('Gmail address', gUser),
          field('Gmail app password', gPass,
            el('a', { href: 'https://myaccount.google.com/apppasswords', target: '_blank', rel: 'noopener', class: 'btn-secondary btn-sm !py-1 !px-2.5 mt-1 inline-flex' }, 'Create an app password')));

        // dim + disable a group's fields until its enable checkbox is on
        const gate = (row, body) => {
          const apply = () => {
            const on = row.input.checked;
            body.classList.toggle('opacity-40', !on);
            body.classList.toggle('pointer-events-none', !on);
            body.querySelectorAll('input').forEach((c) => { c.disabled = !on; });
          };
          row.input.addEventListener('change', apply);
          apply();
        };
        gate(ntfyOn, ntfyBody);
        gate(gmailOn, gmailBody);

        const box = (...kids) => el('div', { class: 'rounded-xl border border-stone-200 dark:border-stone-700 p-4' }, ...kids);
        return shell('Notifications', 'Alerts for failover, disconnects, and a schedule summary before each Yom Tov. All optional, turn on either or both (or set them up later in Settings).',
          el('div', { class: 'space-y-4' },
            box(ntfyOn.node, ntfyBody),
            box(gmailOn.node, gmailBody)),
          nav('Continue', {
            skippable: true,
            onNext: () => {
              if (ntfyOn.input.checked && !topic.value.trim()) { toast('Enter an ntfy topic, or turn off ntfy notifications', 'warn'); return false; }
              if (gmailOn.input.checked && (!gUser.value.trim() || !gPass.value.trim())) { toast('Enter the Gmail address and app password, or turn off Gmail', 'warn'); return false; }
              data.ntfyEnabled = ntfyOn.input.checked; data.ntfyTopic = topic.value; data.ntfyServer = ntfyServer.value;
              data.gmailEnabled = gmailOn.input.checked; data.gmailUser = gUser.value; data.gmailAppPassword = gPass.value;
            },
          }));
      }
      case 6: {
        const enable = checkRow('Enable enforcement now (you must still turn it on per device, nothing is enforced until then)', { checked: data.enforcement });
        const docLink = (text) => el('a', { href: 'https://smartoneg.com/docs/#child-lock', target: '_blank', rel: 'noopener', class: 'underline hover:text-stone-600 dark:hover:text-stone-300' }, text);
        return shell(el('span', { class: 'flex items-center gap-2' }, icon('lock', 'w-6 h-6 text-accent-600'), 'Child Lock'),
          el('span', {}, 'Optional: watch for manual switch presses or conflicting automations during Shabbos/Yom Tov and switch the lights (or other devices) back after a short delay/grace period. Learn more in the ', docLink('documentation'), '.'),
          el('div', { class: 'rounded-xl bg-accent-50 dark:bg-accent-600/10 border border-accent-200 dark:border-accent-600/40 p-4 mb-5' },
            el('div', { class: 'font-semibold mb-1.5 flex items-center gap-2' }, icon('alert', 'w-5 h-5 text-accent-600'), 'Understand before enabling'),
            el('ul', { class: 'list-disc list-inside space-y-1 text-[15px]' },
              el('li', {}, 'It only ever acts during Shabbos / Yom Tov (or right before, see settings or ', docLink('documentation'), '), never on weekdays'),
              el('li', {}, 'A wrong schedule will be actively enforced'),
              el('li', {}, 'Recommended: read the ', docLink('documentation'), ' to understand how Child Lock works'))),
          enable.node,
          nav('Finish setup', {
            onNext: async () => { data.enforcement = enable.input.checked; return finish(); },
          }));
      }
      default:
        return shell('You’re all set', 'Setup is complete. Next stop: build your first Shabbos schedule.',
          el('a', {
            class: 'btn w-full !py-3', href: '#/',
            onclick: () => setTimeout(() => location.reload(), 50),
          }, 'Open the dashboard'));
    }
  }

  // ── standby: mirror the primary, no other setup needed ─────────────────────
  function standbyConnectScreen() {
    const spinner = el('div', { class: 'animate-spin h-9 w-9 border-[3px] border-accent-400 border-t-transparent rounded-full mx-auto' });
    const status = el('div', { class: 'text-[15px] mt-4' }, 'Saving standby configuration…');
    const actions = el('div', { class: 'mt-6 space-y-2' });
    const node = shell('Connecting to the primary', 'This backup receives all its settings from the primary, nothing else to configure here.',
      el('div', { class: 'text-center py-4' }, spinner, status), actions);
    if (!standbyStarted) { standbyStarted = true; runStandbyConnect({ spinner, status, actions }); }
    return node;
  }

  async function runStandbyConnect({ spinner, status, actions }) {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const set = (msg, cls = '') => { status.textContent = msg; status.className = `text-[15px] mt-4 ${cls}`; };
    const fail = (msg) => {
      spinner.classList.add('hidden');
      set(msg, 'text-rose-600');
      mount(clear(actions),
        el('button', { class: 'btn w-full', onclick: () => { standbyStarted = false; draw(); } }, 'Try again'),
        el('button', { class: 'btn-secondary w-full', onclick: () => { standbyConnecting = false; draw(); } }, 'Back'));
    };
    // 1) persist the standby identity (allowed pre-setup; the gate is open)
    try {
      await api.put('/api/settings', { instance: { role: 'standby' }, failover: { primaryUrl: data.primaryUrl, syncToken: data.syncToken } });
    } catch (e) { return fail(`Could not save the standby settings: ${e.message}`); }
    // 2) restart so the failover manager boots in standby mode and starts mirroring
    set('Restarting to connect to the primary…');
    try { await api.post('/api/system/restart'); } catch { /* the server dies mid-response, expected */ }
    // 3) wait for the first successful mirror from the primary
    set('Waiting for the primary to send its settings…');
    await sleep(3000);
    for (let i = 0; i < 75; i++) { // ~2.5 min of polling
      await sleep(2000);
      let h = null;
      try { h = await api.get('/api/health'); } catch { continue; } // server still down
      if (h?.failover?.lastSyncAt || (h?.setupComplete && h?.role === 'standby')) {
        spinner.classList.add('hidden');
        set('Received all settings from the primary, this backup is ready. It will take over automatically if the primary ever goes down.', 'text-emerald-600 font-medium');
        // auto-login with the sync token the standby already holds (no re-typing
        // credentials the standby doesn't have in plaintext), then open the app
        await fetch('/api/auth/claim-session', { method: 'POST', headers: { Authorization: `Bearer ${data.syncToken}` }, credentials: 'same-origin' }).catch(() => {});
        mount(clear(actions),
          el('button', { class: 'btn w-full !py-3', onclick: () => { location.hash = '#/'; location.reload(); } }, 'Finish, open the dashboard'));
        return;
      }
      if (h?.failover?.primaryReachable === false) set(`Can’t reach the primary at ${data.primaryUrl} yet, retrying…`, 'text-amber-600');
    }
    fail(`Couldn’t sync from the primary at ${data.primaryUrl}. Check the URL, the sync token, and that the primary’s port is reachable from here, then try again.`);
  }

  async function finish() {
    try {
      const eco = data.ecosystems;
      const partial = {
        instance: { role: data.role },
        location: { ...data.location, il: data.il },
        times: { candleLightingMins: data.candleLightingMins, havdalahMins: data.havdalahMins },
        display: { locale: data.locale },
        lutron: { enabled: eco.lutron.chosen, host: eco.lutron.host },
        homeassistant: eco.homeassistant.chosen
          ? { enabled: true, host: eco.homeassistant.host, token: eco.homeassistant.token }
          : { enabled: false },
        hubitat: eco.hubitat.chosen
          ? { enabled: true, host: eco.hubitat.host, appId: eco.hubitat.appId, accessToken: eco.hubitat.accessToken }
          : { enabled: false },
        homebridge: eco.homebridge.chosen
          ? { enabled: true, host: eco.homebridge.host, username: eco.homebridge.username, password: eco.homebridge.password }
          : { enabled: false },
        auth: { email: data.email, password: data.password },
        enforcement: { enabled: data.enforcement },
        notifications: {
          ntfy: { enabled: Boolean(data.ntfyEnabled && data.ntfyTopic), server: data.ntfyServer.trim() || 'https://ntfy.sh', topic: data.ntfyTopic },
          email: { enabled: Boolean(data.gmailEnabled && data.gmailUser && data.gmailAppPassword), user: data.gmailUser, appPassword: data.gmailAppPassword, to: data.gmailUser },
        },
        failover: data.role === 'standby' ? { primaryUrl: data.primaryUrl, syncToken: data.syncToken } : {},
        setupComplete: true,
      };
      await api.put('/api/settings', partial);
      // saving the password closes the auth gate, log in BEFORE any further calls
      await api.post('/api/auth/login', { email: data.email, password: data.password });
      if (eco.lutron.chosen && eco.lutron.report) {
        await api.post('/api/zones/import', eco.lutron.report).catch((e) => toast(`Lutron import: ${e.message}`, 'warn'));
      }
      toast('Setup complete!', 'success');
    } catch (err) {
      toast(err.message, 'error');
      return false;
    }
  }

  draw();
  return container;
}
