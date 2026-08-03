import { api } from '../api.js';
import { el, clear, mount, toast, modal, field, checkRow, select, jsonInput, pageHeader, restartApp, fmtDateTime, todayISO, localISO, copyText, splitDownload, testModeSteps, setNavGuard } from '../ui.js';
import { icon } from '../icons.js';

// Unsaved-changes tracking for the whole settings page. Any edit to a control
// (except live auto-saving ones, marked data-autosave) flips this on; a
// successful save clears it. The router and the tab switcher consult it.
let settingsDirty = false;
// While a test-mode skip cools down, the Prev/Next buttons are disabled; this
// timer re-renders the card the moment the cooldown ends so they re-enable
// (the card has no ticker of its own, unlike the banner).
let testCooldownTimer = null;
// data-autosave = a control that saves itself; data-no-dirty = a card with no
// savable settings (e.g. Test mode is just a runner) — neither marks the page dirty
const markSettingsDirty = (e) => { if (!e.target.closest?.('[data-autosave],[data-no-dirty]')) settingsDirty = true; };

/** Discard/keep-editing prompt; `proceed` runs only if the user discards. */
function confirmLeaveSettings(proceed) {
  if (!settingsDirty) { proceed(); return; }
  const dlg = modal({
    title: 'Unsaved changes',
    body: el('div', { class: 'space-y-4' },
      el('p', { class: 'text-[15px]' }, 'You have unsaved settings on this page. Leaving without saving will discard them.'),
      el('button', {
        class: 'btn-secondary w-full !text-rose-600 dark:!text-rose-400',
        onclick: () => { settingsDirty = false; dlg.close(); proceed(); },
      }, 'Discard changes and leave')),
    confirmText: 'Keep editing',
    cancelText: '', // × and "Keep editing" already cover "stay" — no redundant Cancel
  });
}

export async function settingsPage() {
  const container = el('div', { class: 'space-y-5' });
  settingsDirty = false;
  container.addEventListener('input', markSettingsDirty);
  container.addEventListener('change', markSettingsDirty);
  setNavGuard({ isDirty: () => settingsDirty, confirmLeave: confirmLeaveSettings });
  await render(container);
  return container;
}

const text = (value, attrs = {}) => el('input', { class: 'input', value: value ?? '', ...attrs });

function sectionCard(iconName, title, ...children) {
  return el('div', { class: 'card' },
    el('div', { class: 'section-title' }, icon(iconName), title),
    ...children);
}

/**
 * Tie dependent fields to an enable toggle: while off, the nodes are dimmed
 * and every control inside is disabled, settings can't be filled in (and
 * mistakenly "saved") without enabling the feature first. `gate` is either a
 * checkRow (live wiring) or a plain boolean (server-driven state, re-rendered
 * on save). Controls marked data-keep-disabled stay disabled either way.
 */
function gateGroup(gate, ...nodes) {
  const apply = (on) => {
    for (const node of nodes) {
      node.classList.toggle('opacity-40', !on);
      node.classList.toggle('pointer-events-none', !on);
      const controls = [node, ...node.querySelectorAll('input, select, textarea, button')]
        .filter((c) => c.matches('input, select, textarea, button'));
      for (const c of controls) c.disabled = !on || c.hasAttribute('data-keep-disabled');
    }
  };
  if (typeof gate === 'boolean') apply(gate);
  else {
    gate.input.addEventListener('change', () => apply(gate.input.checked));
    apply(gate.input.checked);
  }
  return nodes[0];
}

async function render(container) {
  // preserve scroll position across re-renders (saving must not jump to top)
  const scrollY = window.scrollY;
  const s = await api.get('/api/settings');

  const save = async (partial, msg = 'Saved') => {
    try {
      await api.put('/api/settings', partial);
      toast(msg, 'success');
      settingsDirty = false;
      render(container);
    } catch (err) { toast(err.message, 'error'); }
  };

  // ── location & times ──
  // widths capped so these don't stretch to the full grid-column width on a
  // wide desktop (a zip / a 2-3 digit minutes value needs very little room)
  const zip = text(s.location.zip, { class: 'input sm:max-w-[12rem]', placeholder: '10952', inputmode: 'numeric', autocomplete: 'postal-code', name: 'postal-code' });
  const candles = text(s.times.candleLightingMins, { class: 'input sm:max-w-[8rem]', type: 'number', min: 0, max: 120 });
  const havdalah = text(s.times.havdalahMins, { class: 'input sm:max-w-[8rem]', type: 'number', min: 0, max: 180 });
  const il = checkRow('Israel mode (one-day Yom Tov)', { checked: s.location.il });
  const latIn = text(s.location.lat ?? '', { placeholder: 'e.g. 41.11260', inputmode: 'decimal' });
  const lngIn = text(s.location.lng ?? '', { placeholder: 'e.g. -74.07360', inputmode: 'decimal' });
  // Israel mode uses a curated city dropdown instead of a US zip lookup.
  let ilLocation = null; // location patch from the picked city (lat/lng/tzid/…)
  const citySel = el('select', { class: 'select', onchange: async () => {
    if (!citySel.value) return;
    try {
      ilLocation = await api.get(`/api/il-city/${encodeURIComponent(citySel.value)}`);
      latIn.value = ilLocation.lat; lngIn.value = ilLocation.lng; // reflected in fine-tune
    } catch { /* keep current */ }
  } });
  const locale = select([
    ['ashkenazi', 'Ashkenazi (Shabbos, Sukkos)'], ['en', 'Sephardic (Shabbat, Sukkot)'],
    ['he-x-NoNikud', 'Hebrew, no nikud (שבת, סוכות)'], ['he', 'Hebrew (שַׁבָּת, סוּכּוֹת)'],
  ], s.display?.locale, undefined, 'select sm:max-w-[22rem]');

  const zipField = field('Zip code', zip, 'Looked up locally, no internet needed');
  const cityField = field('Israeli city', citySel, 'Coordinates are set automatically; fine-tune below if needed');
  const syncLocMode = () => {
    const isIL = il.input.checked;
    zipField.classList.toggle('hidden', isIL);
    cityField.classList.toggle('hidden', !isIL);
  };
  // Nudge the candle-lighting default to Israel's common 20 min when Israel
  // mode is turned on (and back to the diaspora 18 when off), but only while
  // it's still at the OTHER default, so a custom value (e.g. 40 for Jerusalem)
  // is never overwritten.
  il.input.addEventListener('change', () => {
    if (il.input.checked && Number(candles.value) === 18) candles.value = 20;
    else if (!il.input.checked && Number(candles.value) === 20) candles.value = 18;
  });
  il.input.addEventListener('change', syncLocMode);
  syncLocMode();
  api.get('/api/il-cities').then((cities) => {
    mount(clear(citySel), el('option', { value: '' }, 'Select a city…'),
      cities.map((c) => el('option', { value: c.name, selected: c.name === s.location.city }, c.he ? `${c.name} · ${c.he}` : c.name)));
  }).catch(() => {});

  const locationCard = sectionCard('calendar', 'Location & halachic times',
    el('p', { class: 'hint mb-4' }, s.location.city
      ? `Currently: ${s.location.city}, ${s.location.state} · ${s.location.tzid}`
      : 'Location not configured yet.'),
    el('div', { class: 'grid sm:grid-cols-2 gap-4' }, zipField, cityField),
    el('div', { class: 'mt-3' }, il.node),
    // the two minute-offset inputs pair naturally in one row; the holiday-name
    // select gets its own full-width row (its long hint made a 3-in-a-grid
    // layout tile unevenly, leaving Candle lighting orphaned mid-row)
    el('div', { class: 'grid sm:grid-cols-2 gap-4 mt-4 items-start' },
      field('Candle lighting (minutes before shkia, sunset)', candles),
      field('Havdalah (minutes after shkia, sunset)', havdalah, '45 is common; 72 for Rabbeinu Tam. One extra safety minute is always added.')),
    el('div', { class: 'mt-4' },
      field('Holiday-name style', locale, 'Controls how zmanim, holiday names and Hebrew words are shown everywhere, the Schedules cards, calendar, previews and the printable Zmanim PDFs.')),
    el('details', { class: 'mt-3 group' },
      el('summary', { class: 'cursor-pointer text-[15px] font-medium text-stone-500 dark:text-stone-400 flex items-center gap-1.5 select-none list-none' },
        icon('chevronRight', 'w-4 h-4 transition-transform group-open:rotate-90'),
        'Fine-tune exact coordinates (optional)'),
      el('p', { class: 'hint mt-2 mb-3' },
        'Zip codes resolve to a city-center point (zmanim shift by only seconds across a town). For street-address precision, paste your exact coordinates (no internet service is involved). On a phone, press-and-hold your house in the Maps app to drop a pin and copy the lat/long. On a computer, open ',
        el('a', { href: 'https://maps.google.com', target: '_blank', class: 'underline' }, 'maps.google.com'),
        ', click-and-hold on your house to drop a pin, then right-click the pin and copy the coordinates (e.g. \u201c39.38172440803908, -76.69650757889433\u201d). The first number is the latitude, the second the longitude.'),
      el('div', { class: 'grid sm:grid-cols-2 gap-4' },
        field('Latitude', latIn), field('Longitude', lngIn))),
    el('div', { class: 'mt-4' },
      el('button', {
        class: 'btn', 'data-settings-save': '1',
        onclick: async () => {
          const partial = {
            times: { candleLightingMins: Number(candles.value), havdalahMins: Number(havdalah.value) },
            display: { locale: locale.value },
            location: { il: il.input.checked },
          };
          // Israel mode: apply the picked city; otherwise a US zip lookup
          if (il.input.checked) {
            if (ilLocation) Object.assign(partial.location, ilLocation);
          } else if (zip.value && zip.value !== s.location.zip) {
            try {
              const loc = await api.get(`/api/zip/${zip.value}`);
              Object.assign(partial.location, loc);
            } catch { toast('Zip lookup failed, keeping current location', 'warn'); }
          }
          // fine-tuned coordinates win over both (kept in sync when a city is picked)
          if (latIn.value && lngIn.value) {
            partial.location.lat = Number(latIn.value);
            partial.location.lng = Number(lngIn.value);
          }
          save(partial);
        },
      }, 'Save')));

  // ── bridges ──
  const lEnabled = checkRow('Use a Lutron bridge', { checked: s.lutron.enabled !== false });
  const lHost = text(s.lutron.host);
  const hEnabled = checkRow('Use a Hubitat hub', {
    checked: Boolean(s.hubitat?.enabled),
    hint: 'Brings in Zigbee, Z-Wave and Ecobee devices paired to the hub via its local Maker API.',
  });
  const hHost = text(s.hubitat?.host, { placeholder: '192.168.0.50' });
  const hApp = text(s.hubitat?.appId, { placeholder: 'Maker API app id' });
  const hTok = text('', { placeholder: s.hubitat?.accessToken === '__SET__' ? '(token saved, enter to replace)' : 'access token' });

  // ── home assistant ──
  const haEnabled = checkRow('Use Home Assistant', {
    checked: Boolean(s.homeassistant?.enabled),
    hint: 'Imports lights, switches and thermostats from a local HA instance. State changes arrive by push (websocket), so Child Lock works at full speed.',
  });
  const haHost = text(s.homeassistant?.host, { placeholder: '192.168.0.20:8123' });
  const haTok = text('', { placeholder: s.homeassistant?.token === '__SET__' ? '(token saved, enter to replace)' : 'long-lived access token' });

  // ── homebridge ──
  const hbEnabled = checkRow('Use Homebridge', {
    checked: Boolean(s.homebridge?.enabled),
    hint: 'Imports accessories via the config-ui-x API (Homebridge must run in insecure mode, -I). State is POLLED, Child Lock corrections lag a few seconds, so prefer Home Assistant or Hubitat for enforced devices.',
  });
  const hbHost = text(s.homebridge?.host, { placeholder: '192.168.0.30:8581' });
  const hbUser = text(s.homebridge?.username, { placeholder: 'admin (blank = no-auth mode)' });
  const hbPass = text('', { placeholder: s.homebridge?.password === '__SET__' ? '(password saved, enter to replace)' : 'password', type: 'password' });
  const hbPoll = text(s.homebridge?.pollSeconds ?? 5, { type: 'number', min: 2, class: 'input !w-24 text-center' });

  // ── matter (experimental) ──
  const mtEnabled = checkRow('Use Matter (experimental)', {
    checked: Boolean(s.matter?.enabled),
    hint: 'Local Matter-over-IP controller. After enabling and restarting, pair devices from the Devices page using their 11-digit pairing code. Untested on real hardware, please report issues.',
  });

  // ── ecobee (native cloud) ──
  const ecEnabled = checkRow('Use native Ecobee (cloud)', {
    checked: Boolean(s.ecobee?.enabled),
    hint: 'Recommended instead: pair your Ecobee to a Hubitat hub, that stays local and keeps working if the internet or Ecobee’s cloud has a bad Shabbos. Use this only without a Hubitat.',
  });
  const ecKey = text(s.ecobee?.apiKey === '__SET__' ? '' : s.ecobee?.apiKey, {
    placeholder: s.ecobee?.apiKey ? '(API key saved, enter to replace)' : 'API key from developer.ecobee.com',
  });
  const ecStatus = s.ecobee?.refreshToken
    ? el('span', { class: 'badge-on' }, 'Authorized')
    : el('span', { class: 'badge-off' }, 'Not authorized');

  // ── envisalink (alarm) ──
  const evEnabled = checkRow('Use EnvisaLink alarm', {
    checked: Boolean(s.envisalink?.enabled),
    hint: 'Local TPI connection to an EnvisaLink board (EVL-3/4/4EZR) on a DSC panel. Exposes the partition (arm/disarm) and per-zone bypass as devices you can schedule, e.g. bypass motion zones for Shabbos and restore them after havdalah.',
  });
  const evHost = text(s.envisalink?.host, { placeholder: '192.168.0.40' });
  const evPort = text(s.envisalink?.port ?? 4025, { type: 'number', class: 'input !w-24 text-center' });
  const evPass = text('', { placeholder: s.envisalink?.password === '__SET__' ? '(password saved, enter to replace)' : 'EnvisaLink password', type: 'password' });
  const evCode = text('', { placeholder: s.envisalink?.code === '__SET__' ? '(code saved, enter to replace)' : 'alarm code (used to disarm)', type: 'password' });
  const evPart = text(s.envisalink?.partition ?? 1, { type: 'number', min: 1, class: 'input !w-20 text-center' });
  const evArm = select([['stay', 'Arm, stay (interior aware)'], ['away', 'Arm, away'], ['night', 'Arm, night / no-entry-delay']], s.envisalink?.armMode ?? 'stay', () => {}, 'select');
  // Add the partition + bypass-zone devices (they must be named manually, the
  // board can't enumerate zones). They land on the Devices page as on/off devices.
  const addAlarmDevice = (kind) => {
    const nm = text('', { placeholder: kind === 'alarm' ? 'e.g. House alarm' : 'e.g. Downstairs motion' });
    const zn = text('', { type: 'number', min: 1, max: 64, placeholder: 'zone #' });
    modal({
      title: kind === 'alarm' ? 'Add alarm partition' : 'Add bypass zone',
      body: el('div', { class: 'space-y-3' },
        field('Name', nm),
        kind === 'bypass' ? field('Zone number', zn, 'The DSC zone number to bypass') : null),
      confirmText: 'Add device',
      onConfirm: async () => {
        if (!nm.value.trim()) { toast('Name required', 'error'); return false; }
        if (kind === 'bypass' && !Number(zn.value)) { toast('Zone number required', 'error'); return false; }
        const externalId = kind === 'alarm' ? `partition:${Number(evPart.value) || 1}` : `bypass:${Number(zn.value)}`;
        try {
          await api.post('/api/zones/manual', { name: nm.value, area: 'Alarm', source: 'envisalink', externalId, kind, enforce: false });
          toast('Added, see it on the Devices page', 'success');
        } catch (err) { toast(err.message, 'error'); return false; }
      },
    });
  };
  const envisalinkBox = el('div', { class: 'rounded-xl border border-stone-200 dark:border-stone-700 p-4' },
    evEnabled.node,
    gateGroup(evEnabled, el('div', {},
      el('div', { class: 'grid sm:grid-cols-3 gap-4 mt-3' },
        field('EnvisaLink address', evHost),
        field('Port', evPort),
        field('Partition', evPart)),
      el('div', { class: 'grid sm:grid-cols-2 gap-4 mt-3' },
        field('Password', evPass),
        field('Alarm code', evCode, 'Required to disarm')),
      el('div', { class: 'mt-3 max-w-md' }, field('Arm mode', evArm, 'How the partition arms when a rule or scene turns it on')),
      el('div', { class: 'mt-4 pt-3 border-t border-stone-200 dark:border-stone-700' },
        el('div', { class: 'font-medium text-[15px] mb-1' }, 'Alarm devices'),
        el('p', { class: 'hint mb-2' }, 'Add the partition and each zone you want to be able to bypass. They appear on the Devices page and can be used in schedules and scenes.'),
        el('div', { class: 'flex flex-wrap gap-2' },
          el('button', { class: 'btn-secondary btn-sm', onclick: () => addAlarmDevice('alarm') }, icon('shield', 'w-4 h-4'), 'Add partition'),
          el('button', { class: 'btn-secondary btn-sm', onclick: () => addAlarmDevice('bypass') }, icon('lock', 'w-4 h-4'), 'Add bypass zone'))))));

  const ecobeeBox = el('div', { class: 'rounded-xl border border-stone-200 dark:border-stone-700 p-4' },
    el('div', { class: 'flex items-center justify-between gap-2 flex-wrap' }, ecEnabled.node, ecStatus),
    gateGroup(ecEnabled, el('div', {},
    el('div', { class: 'grid sm:grid-cols-2 gap-4 mt-3' },
      field('Ecobee API key', ecKey, 'developer.ecobee.com → “Create New App” (PIN authorization)')),
    el('div', { class: 'mt-3 flex gap-2.5 flex-wrap' },
      el('button', {
        class: 'btn-secondary btn-sm',
        onclick: async () => {
          try {
            const { pin, expiresInMin } = await api.post('/api/ecobee/authorize', ecKey.value ? { apiKey: ecKey.value } : {});
            modal({
              title: 'Authorize with your PIN',
              body: el('div', { class: 'space-y-3 text-[15px]' },
                el('div', { class: 'text-center' },
                  el('div', { class: 'text-4xl font-bold tracking-[0.3em] text-accent-600 my-3' }, pin),
                  el('p', { class: 'hint' }, `Valid for ${expiresInMin} minutes`)),
                el('ol', { class: 'list-decimal list-inside space-y-1.5' },
                  el('li', {}, 'Log in at ecobee.com → My Apps → Add Application'),
                  el('li', {}, 'Enter the PIN above and authorize'),
                  el('li', {}, 'Come back and press “I’ve authorized”'))),
              confirmText: 'I’ve authorized, connect',
              onConfirm: async () => {
                try {
                  await api.post('/api/ecobee/token');
                  toast('Ecobee authorized', 'success');
                  render(container);
                } catch (err) { toast(err.message, 'error'); return false; }
              },
            });
          } catch (err) { toast(err.message, 'error'); }
        },
      }, 'Get authorization PIN'),
      s.ecobee?.refreshToken && el('button', {
        class: 'btn-secondary btn-sm',
        onclick: async () => {
          try {
            const res = await api.post('/api/ecobee/discover');
            toast(`Found ${res.devices.length} thermostat(s), add them from the Devices page`, 'success');
          } catch (err) { toast(err.message, 'error'); }
        },
      }, 'Test / discover')))));

  const bridgesCard = sectionCard('server', 'Bridges & hubs',
    el('p', { class: 'hint mb-4' }, 'Use any combination. Saving here restarts the app automatically to apply the change.'),
    el('div', { class: 'rounded-xl border border-stone-200 dark:border-stone-700 p-4 mb-4' },
      lEnabled.node,
      gateGroup(lEnabled, el('div', { class: 'mt-3' },
        el('label', { class: 'label' }, 'Bridge IP'),
        el('div', { class: 'flex gap-2.5 items-center' },
          // input flexes down on narrow/zoomed screens instead of a fixed w-44
          // that pushed the Test button past the card edge
          el('span', { class: 'flex-1 min-w-0 max-w-44' }, lHost),
          el('button', {
            class: 'btn-secondary shrink-0',
            onclick: async () => {
              try {
                const res = await api.post('/api/settings/lutron/test', { host: lHost.value });
                toast(`Connected, devices respond: ${Object.keys(res.levels).length}`, 'success');
              } catch (err) { toast(err.message, 'error'); }
            },
          }, 'Test')),
        el('p', { class: 'hint mt-1.5' },
          'Requires a ', el('b', {}, 'Smart Bridge PRO (L-BDGPRO2)'), '. Give it a static IP / DHCP reservation.')))),
    el('div', { class: 'rounded-xl border border-stone-200 dark:border-stone-700 p-4' },
      hEnabled.node,
      gateGroup(hEnabled, el('div', {},
        el('div', { class: 'grid sm:grid-cols-3 gap-4 mt-3' },
          field('Hub IP', hHost), field('App ID', hApp), field('Access token', hTok)),
        el('div', { class: 'mt-3' },
          el('button', {
            class: 'btn-secondary btn-sm',
            onclick: async () => {
              try {
                const res = await api.post('/api/hubitat/discover', { host: hHost.value, appId: hApp.value, ...(hTok.value ? { accessToken: hTok.value } : {}) });
                toast(`Found ${res.devices.length} devices, add them from the Devices page`, 'success');
              } catch (err) { toast(err.message, 'error'); }
            },
          }, 'Test / discover'))))),
    el('div', { class: 'mt-4 rounded-xl border border-stone-200 dark:border-stone-700 p-4' },
      haEnabled.node,
      gateGroup(haEnabled, el('div', {},
        el('div', { class: 'grid sm:grid-cols-2 gap-4 mt-3' },
          field('HA address', haHost, 'host:port, or a full http(s) URL'),
          field('Access token', haTok, 'HA profile → Security → Create long-lived access token')),
        el('div', { class: 'mt-3' },
          el('button', {
            class: 'btn-secondary btn-sm',
            onclick: async () => {
              try {
                const res = await api.post('/api/homeassistant/discover', { host: haHost.value, ...(haTok.value ? { token: haTok.value } : {}) });
                toast(`Found ${res.devices.length} entities, add them from the Devices page`, 'success');
              } catch (err) { toast(err.message, 'error'); }
            },
          }, 'Test / discover'))))),
    el('div', { class: 'mt-4 rounded-xl border border-stone-200 dark:border-stone-700 p-4' },
      hbEnabled.node,
      gateGroup(hbEnabled, el('div', {},
        el('div', { class: 'grid sm:grid-cols-3 gap-4 mt-3' },
          field('Homebridge address', hbHost, 'the config-ui-x web UI address'),
          field('Username', hbUser), field('Password', hbPass)),
        el('div', { class: 'mt-3 flex items-center gap-2.5 flex-wrap' },
          el('span', { class: 'text-[15px]' }, 'Check for wall presses every'), hbPoll, el('span', { class: 'text-[15px]' }, 'seconds')),
        el('div', { class: 'mt-3' },
          el('button', {
            class: 'btn-secondary btn-sm',
            onclick: async () => {
              try {
                const res = await api.post('/api/homebridge/discover', {
                  host: hbHost.value, username: hbUser.value, ...(hbPass.value ? { password: hbPass.value } : {}),
                });
                toast(`Found ${res.devices.length} accessories, add them from the Devices page`, 'success');
              } catch (err) { toast(err.message, 'error'); }
            },
          }, 'Test / discover'))))),
    el('div', { class: 'mt-4 rounded-xl border border-stone-200 dark:border-stone-700 p-4' },
      mtEnabled.node,
      gateGroup(mtEnabled, el('div', {},
        el('div', { class: 'mt-3 flex items-start gap-2.5 rounded-lg bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30 px-3 py-2' },
          el('span', { class: 'text-amber-600 dark:text-amber-400 mt-0.5 shrink-0' }, icon('alert', 'w-4.5 h-4.5')),
          el('span', { class: 'text-[14px] text-amber-800 dark:text-amber-200' },
            'Experimental and not yet verified on real hardware. Once enabled and the app restarts, add Matter devices from the Devices page with their pairing code.'))))),
    el('div', { class: 'mt-4' }, ecobeeBox),
    el('div', { class: 'mt-4' }, envisalinkBox),
    // sticky save so it stays in view no matter how far the bridges list scrolls
    // (users were adding a bridge and missing the Save at the very bottom). Sits
    // above the mobile bottom-nav; flush to the viewport bottom on desktop.
    el('div', {
      class: 'lg:sticky lg:bottom-0 z-10 '
        + '-mx-5 sm:-mx-6 -mb-5 sm:-mb-6 mt-6 px-5 sm:px-6 py-3.5 rounded-b-card '
        + 'bg-white/85 dark:bg-stone-900/85 backdrop-blur border-t border-stone-200 dark:border-stone-800',
    },
      el('button', {
        class: 'btn', 'data-settings-save': '1',
        onclick: async () => {
          try {
            await api.put('/api/settings', {
              lutron: { enabled: lEnabled.input.checked, host: lHost.value },
              hubitat: { enabled: hEnabled.input.checked, host: hHost.value, appId: hApp.value, ...(hTok.value ? { accessToken: hTok.value } : {}) },
              homeassistant: { enabled: haEnabled.input.checked, host: haHost.value, ...(haTok.value ? { token: haTok.value } : {}) },
              homebridge: {
                enabled: hbEnabled.input.checked, host: hbHost.value, username: hbUser.value,
                pollSeconds: Math.max(2, Number(hbPoll.value) || 5),
                ...(hbPass.value ? { password: hbPass.value } : {}),
              },
              matter: { enabled: mtEnabled.input.checked },
              ecobee: { enabled: ecEnabled.input.checked, ...(ecKey.value ? { apiKey: ecKey.value } : {}) },
              envisalink: {
                enabled: evEnabled.input.checked, host: evHost.value, port: Number(evPort.value) || 4025,
                partition: Number(evPart.value) || 1, armMode: evArm.value,
                ...(evPass.value ? { password: evPass.value } : {}),
                ...(evCode.value ? { code: evCode.value } : {}),
              },
            });
            settingsDirty = false;
            await restartApp('Bridge settings saved, restarting to apply…');
          } catch (err) { toast(err.message, 'error'); }
        },
      }, 'Save & restart')));

  // In the static demo, bridges are pre-configured, show them enabled but
  // read-only (native disabled inputs read as greyed-out).
  if (window.__SMARTONEG_DEMO__) {
    bridgesCard.querySelectorAll('input, select, button, textarea').forEach((elm) => { elm.disabled = true; });
    bridgesCard.insertBefore(
      el('div', { class: 'mb-4 rounded-lg bg-stone-100 dark:bg-stone-800 px-3.5 py-2.5 text-[14px] text-stone-500 dark:text-stone-400' },
        'Demo, these bridges are pre-configured and read-only here.'),
      bridgesCard.children[1]);
  }

  // ── enforcement ──
  const grace = text(s.enforcement.graceSeconds, { type: 'number', min: 5, max: 15, class: 'input !w-24 text-center' });
  const presses = text(s.enforcement.overridePresses, { type: 'number', min: 2, max: 10, class: 'input !w-24 text-center' });
  // When Child Lock begins: the day's first rule (earliest), candle lighting
  // (default), or shkia/sunset (latest, leaves the pre-shkia minutes free).
  const beginsKindInit = ['firstRule', 'shkia'].includes(s.enforcement.begins?.kind) ? s.enforcement.begins.kind : 'candles';
  const beginsKind = select(
    [['firstRule', 'At the day’s first rule'], ['candles', 'At candle lighting (default)'], ['shkia', 'At Shkia (sunset)']],
    beginsKindInit,
    (v) => {
      firstRuleNote.classList.toggle('hidden', v !== 'firstRule');
      shkiaNote.classList.toggle('hidden', v !== 'shkia');
    }, 'select w-full sm:!w-auto max-w-full');
  const firstRuleNote = el('p', { class: `hint mt-2 ${beginsKindInit === 'firstRule' ? '' : 'hidden'}` },
    'Child Lock will begin at whatever time your earliest rule for that Shabbos/Yom Tov fires, including an erev rule. For example, if a Friday rule turns lights on 90 minutes before shkia, watching starts then.');
  const shkiaNote = el('p', { class: `hint mt-2 ${beginsKindInit === 'shkia' ? '' : 'hidden'}` },
    'Child Lock holds off until actual sunset (shkia). The minutes between candle lighting and shkia stay free, switches only lock once shkia arrives.');
  const enforcementCard = sectionCard('lock', 'Child Lock',
    el('div', { class: 'flex items-center gap-2 mb-3' },
      el('span', { class: 'text-[15px]' }, 'Status:'),
      s.enforcement.enabled
        ? el('span', { class: 'badge-on' }, 'On')
        : el('span', { class: 'badge-off' }, 'Off (default)')),
    el('p', { class: 'hint mb-2' },
      'For homes with children: the app watches the bridge for wall-switch presses during Shabbos and Yom Tov. If a child (or anyone) flips a light that the schedule says should be otherwise, the app quietly flips it back after the grace delay below, so lights end up exactly where your schedule intends, no matter who touches the switches.'),
    el('p', { class: 'hint mb-2' },
      `It never acts on a regular weekday. And there\u2019s a deliberate escape hatch for a non-Jewish helper: flip the same switch ${s.enforcement.overridePresses} times in a row (each flip counts, and after each one the app restores the light, so you flip again). On the last flip the light blinks twice to confirm the override has taken hold, then stays exactly where it was put until havdalah.`),
    el('p', { class: 'hint mb-2' },
      `Those flips only count when they come in quick succession (within about ${s.enforcement.graceSeconds + 25} seconds of each other, which follows automatically from the grace delay). Once there\u2019s a longer gap the count resets, so a press here and another an hour or a day later never add up to an accidental hold. The whole sequence takes well under a minute.`),
    el('p', { class: 'hint mb-2 font-bold' },
      'Child Lock applies from candle lighting until havdalah. Before candle lighting (erev) switches stay free to use, and the moment candle lighting arrives, any watched light that was left in the wrong position is set back to what the schedule intends.'),
    el('p', { class: 'hint mb-4' },
      'Running other automations too (HomeKit, Home Assistant, SmartThings, etc.)? Child Lock helps there as well, during Shabbos and Yom Tov this app overrides whatever they do to the watched lights.'),
    gateGroup(s.enforcement.enabled, el('div', { class: 'flex flex-wrap gap-x-8 gap-y-4' },
      field('Grace delay (seconds)', grace, 'How long the app waits after a manual change before restoring it (5–15s).'),
      field('Presses to hold manually', presses, 'Flips in a row to leave a light as-is until havdalah (2–10).'))),
    gateGroup(s.enforcement.enabled, el('div', { class: 'mt-4 rounded-xl border border-stone-200 dark:border-stone-700 p-4' },
      el('div', { class: 'font-medium text-[15px] mb-1' }, 'When Child Lock begins'),
      el('p', { class: 'hint mb-3' }, 'Default is candle lighting. If your family accepts Shabbos early, choose the day’s first rule so watching starts as soon as your earliest rule fires; or choose Shkia (sunset) to hold off until actual sunset. This only shifts when watching begins around the erev window, once active, Child Lock stays on until havdalah.'),
      el('div', { class: 'flex flex-wrap items-center gap-x-3 gap-y-2' }, beginsKind),
      firstRuleNote, shkiaNote)),
    el('div', { class: 'mt-4 flex gap-2.5 flex-wrap' },
      s.enforcement.enabled
        ? el('button', { class: 'btn-danger', onclick: () => save({ enforcement: { enabled: false } }, 'Child Lock disabled') }, 'Turn off')
        : el('button', {
          class: 'btn',
          onclick: () => {
            const confirmInput = el('input', { class: 'input mt-3', placeholder: 'Type: I understand' });
            modal({
              title: 'Turn on Child Lock?',
              body: el('div', { class: 'space-y-3 text-[15px]' },
                el('p', {}, 'The app will actively flip lights back during Shabbos/Yom Tov. Before enabling:'),
                el('ul', { class: 'list-disc list-inside space-y-1.5' },
                  el('li', {}, 'A wrong schedule gets enforced, verify your rules first'),
                  el('li', {}, 'Household and guests must know the override rhythm'),
                  el('li', {}, 'It never fires outside Shabbos/Yom Tov.')),
                confirmInput),
              confirmText: 'Turn on',
              onConfirm: () => {
                if (confirmInput.value.trim().toLowerCase() !== 'i understand') { toast('Please type "I understand"', 'warn'); return false; }
                save({ enforcement: { enabled: true } }, 'On, now switch it on per device in Devices');
              },
            });
          },
        }, 'Turn on…'),
      gateGroup(s.enforcement.enabled,
        el('button', { class: 'btn-secondary', 'data-settings-save': '1', onclick: () => save({ enforcement: {
          graceSeconds: Number(grace.value), overridePresses: Number(presses.value),
          // null the legacy fixed-time fields so they can't linger under a deep-merge
          begins: beginsKind.value === 'firstRule' ? { kind: 'firstRule', time: null, onlyIfSunsetAfter: null }
            : beginsKind.value === 'shkia' ? { kind: 'shkia' }
              : null,
        } }) }, 'Save timing'))));

  // ── notifications ──
  const eEnabled = checkRow('Email (Gmail)', { checked: s.notifications.email.enabled });
  // autocomplete/name hardening: without it, a text input next to an enabled
  // password input reads as a "login form" and password managers autofill the
  // OWNER'S saved email/password into the Gmail sender fields (seen in the
  // field right after "Reset app password" re-enabled the password input)
  const eUser = text(s.notifications.email.user, { placeholder: 'you@gmail.com', name: 'gmail-sender', autocomplete: 'off' });
  // once an app password is saved it stays locked (even with email enabled) so
  // it can't be overwritten by accident, Reset below is the only way out
  const passSaved = s.notifications.email.appPassword === '__SET__';
  const ePass = text('', {
    type: 'password',
    name: 'gmail-app-password', autocomplete: 'new-password',
    placeholder: passSaved ? '(app password saved)' : 'Gmail app password',
    ...(passSaved ? { disabled: true, 'data-keep-disabled': true } : {}),
  });
  const resetPassBtn = el('button', {
    class: 'btn-secondary btn-sm !py-1 !px-2.5 mt-1',
    onclick: () => modal({
      title: 'Reset the saved app password?',
      body: el('div', { class: 'space-y-2.5 text-[15px]' },
        el('p', {}, 'Google never shows an app password again after you create it, the one saved here cannot be recovered.'),
        el('p', {}, 'Resetting deletes it from SmartOneg. Email notifications will stop working until you create a new app password in your Google account and save it here.')),
      confirmText: 'Reset', confirmClass: 'btn-danger',
      onConfirm: () => save({ notifications: { email: { appPassword: '' } } }, 'App password cleared, enter a new one'),
    }),
  }, 'Reset app password…');
  const eTo = text(s.notifications.email.to, { placeholder: 'you@gmail.com, spouse@gmail.com', name: 'notify-recipients', autocomplete: 'off' });
  const nEnabled = checkRow('ntfy.sh push (simplest, free app, no account)', { checked: s.notifications.ntfy.enabled });
  const nTopic = text(s.notifications.ntfy.topic, { placeholder: 'a-hard-to-guess-topic' });
  const summaryDays = text(s.notifications.preYomTovSummaryDays, { type: 'number', min: 1, max: 30, class: 'input !w-24 text-center' });

  // per-category, per-channel opt-out matrix (everything on by default)
  const NOTIFY_CATEGORIES = [
    ['bridge', 'Bridge & action failures', 'Lost bridge connection, or a scheduled light action failed.'],
    ['failover', 'Backup / failover', 'Backup instance took over, primary unreachable / recovered.'],
    ['childlock', 'Child Lock overrides', 'A non-Jew’s override latched a device.'],
    ['summary', 'Pre–Yom Tov summaries', 'The schedule preview before each Yom Tov, email only (too long for push).', { emailOnly: true }],
    ['modes', 'Guest, away & test mode', 'Guest/away mode on-off, test mode auto-exit.'],
    ['updates', 'Software updates', 'A newer SmartOneg release is available to install.'],
    ['system', 'App restarts & recovery', 'The app came back online after an outage.'],
  ];
  const cats = s.notifications.categories ?? {};
  const catRefs = {};
  const catMatrix = el('div', { class: 'rounded-xl border border-stone-200 dark:border-stone-700 p-4 sm:p-5' },
    el('h4', { class: 'font-semibold' }, 'Which notifications to receive'),
    el('p', { class: 'hint mb-2' }, 'Everything is on by default. Uncheck a category to stop it on that channel.'),
    // label column is capped so the Email/ntfy checkboxes sit right beside it
    // (not pushed to the far edge); justify-start packs everything to the left.
    // Header cells carry the row gap via pb-* so the label→list gap isn't huge.
    el('div', { class: 'grid grid-cols-[minmax(6rem,24rem)_3rem_3rem_3.5rem] gap-x-5 gap-y-4 items-center justify-start' },
      el('div', {}),
      el('div', { class: 'text-xs font-semibold text-stone-500 dark:text-stone-400 text-center uppercase tracking-wide self-end -mb-1.5' }, 'Email'),
      el('div', { class: 'text-xs font-semibold text-stone-500 dark:text-stone-400 text-center uppercase tracking-wide self-end -mb-1.5' }, 'ntfy'),
      el('div', { class: 'text-xs font-semibold text-stone-500 dark:text-stone-400 text-center uppercase tracking-wide self-end -mb-1.5', title: 'Web push to devices enabled below' }, 'Push'),
      ...NOTIFY_CATEGORIES.flatMap(([key, label, desc, opts]) => {
        const em = el('input', { class: 'checkbox', type: 'checkbox', checked: cats[key]?.email !== false });
        const nt = el('input', { class: 'checkbox', type: 'checkbox', checked: !opts?.emailOnly && cats[key]?.ntfy !== false, ...(opts?.emailOnly ? { disabled: true } : {}) });
        const pu = el('input', { class: 'checkbox', type: 'checkbox', checked: !opts?.emailOnly && cats[key]?.push !== false, ...(opts?.emailOnly ? { disabled: true } : {}) });
        catRefs[key] = { email: em, ntfy: nt, push: pu };
        const dash = () => el('span', { class: 'text-stone-300 dark:text-stone-600', title: 'Email only' }, '—');
        return [
          el('div', {}, el('div', { class: 'text-[15px] font-medium' }, label), el('div', { class: 'hint' }, desc)),
          el('div', { class: 'flex justify-center' }, em),
          el('div', { class: 'flex justify-center' }, opts?.emailOnly ? dash() : nt),
          el('div', { class: 'flex justify-center' }, opts?.emailOnly ? dash() : pu),
        ];
      })));

  const notifyCard = sectionCard('bell', 'Notifications',
    el('div', { class: 'space-y-5' },
      el('div', {}, eEnabled.node,
        gateGroup(eEnabled, el('div', { class: 'mt-2 space-y-4' },
          el('div', { class: 'grid sm:grid-cols-3 gap-4' },
            field('Gmail address', eUser),
            field('App password', ePass, passSaved
              ? resetPassBtn
              : el('a', { href: 'https://myaccount.google.com/apppasswords', target: '_blank', class: 'btn-secondary btn-sm !py-1 !px-2.5 mt-1 inline-flex' }, 'Create an app password')),
            field('Send to', eTo, 'Defaults to the sender. Enter multiple recipients separated by commas, e.g. you@gmail.com, spouse@gmail.com.')),
          // email-only (too long for push), so it lives here and greys out with email
          field('Send the Yom Tov schedule summary (days before)', summaryDays,
            'The full schedule preview is emailed this many days before each Yom Tov.')))),
      el('div', {}, nEnabled.node,
        gateGroup(nEnabled, el('div', {},
          el('p', { class: 'hint mt-1 mb-2' },
            'ntfy.sh is a free push service that needs no account. Pick a hard-to-guess topic name below, then install the ',
            el('a', { href: 'https://ntfy.sh', target: '_blank', class: 'underline' }, 'ntfy app'),
            ' on your iPhone or Android and subscribe to that same topic to receive alerts (bridge disconnects, failover, guest-mode changes, pre-Yom-Tov summaries).'),
          el('div', { class: 'grid sm:grid-cols-2 gap-4 mt-1' },
            field('Topic', nTopic, 'e.g. shabbos-alerts-a8f3c1, anyone who knows it can send you notifications, so keep it private'))))),
      catMatrix),
    el('div', {
      class: 'lg:sticky lg:bottom-0 z-10 '
        + '-mx-5 sm:-mx-6 -mb-5 sm:-mb-6 mt-6 px-5 sm:px-6 py-3.5 rounded-b-card '
        + 'bg-white/85 dark:bg-stone-900/85 backdrop-blur border-t border-stone-200 dark:border-stone-800 '
        + 'flex gap-2.5 flex-wrap items-center',
    },
      el('button', {
        class: 'btn', 'data-settings-save': '1',
        onclick: () => save({ notifications: {
          email: { enabled: eEnabled.input.checked, user: eUser.value, to: eTo.value, ...(ePass.value ? { appPassword: ePass.value } : {}) },
          ntfy: { enabled: nEnabled.input.checked, topic: nTopic.value },
          preYomTovSummaryDays: Number(summaryDays.value),
          categories: Object.fromEntries(NOTIFY_CATEGORIES.map(([key, , , opts]) => [key, {
            email: catRefs[key].email.checked,
            ntfy: opts?.emailOnly ? false : catRefs[key].ntfy.checked,
            push: opts?.emailOnly ? false : catRefs[key].push.checked,
          }])),
        } }),
      }, 'Save'),
      el('button', {
        class: 'btn-secondary',
        onclick: async () => {
          try {
            const res = await api.post('/api/notify/test');
            const ch = res.message?.channels ?? {};
            const line = ['email', 'ntfy', 'push'].map((k) => `${k}: ${ch[k] ?? '?'}`).join(' \u00b7 ');
            const failed = Object.values(ch).some((v) => String(v).startsWith('FAILED'));
            toast(`Test sent \u2014 ${line}`, failed ? 'warn' : 'success', { ms: 9000 });
          } catch (err) { toast(err.message, 'error', { ms: 9000 }); }
        },
      }, 'Send test'),
      el('button', { class: 'btn-secondary', onclick: enablePush }, 'Enable push on this device')));

  // ── this instance / backup ──
  const isPrimary = s.instance.role === 'primary';
  const role = select([
    ['primary', 'Primary, this instance runs the lights'],
    ['standby', 'Standby, backup that takes over if the primary dies'],
  ], s.instance.role);
  const primaryUrl = text(s.failover.primaryUrl, { placeholder: 'http://192.168.0.10:1836' });
  const primaryUrlField = field('Primary URL', primaryUrl, 'Where this standby finds the primary');
  const syncPrimaryUrlVisibility = () => primaryUrlField.classList.toggle('hidden', role.value !== 'standby');
  role.addEventListener('change', syncPrimaryUrlVisibility);

  const updatesCard = buildUpdatesCard(s);

  const instanceCard = sectionCard('server', 'Primary & Backup Instance',
    el('p', { class: 'hint mb-4' },
      'You can run a second copy of this app on another device (e.g. a Raspberry Pi) as a hot backup. The backup mirrors all your settings automatically and takes over control of the lights if this primary instance ever goes down, then hands control back when it returns. This keeps your Shabbos automation running even if the main machine reboots or loses power.'),
    el('div', {
      class: `rounded-xl p-4 mb-4 flex items-center gap-3 ${isPrimary
        ? 'bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-200 dark:border-emerald-500/30'
        : 'bg-sky-50 dark:bg-sky-500/10 border border-sky-200 dark:border-sky-500/30'}`,
    },
      icon(isPrimary ? 'server' : 'refresh', `w-7 h-7 shrink-0 ${isPrimary ? 'text-emerald-600' : 'text-sky-600'}`),
      el('div', {},
        el('div', { class: 'font-semibold text-[16px]' },
          `You are looking at the ${isPrimary ? 'PRIMARY' : 'STANDBY'} instance`),
        el('div', { class: 'hint' }, isPrimary
          ? 'It controls the lights. A standby instance (e.g. on a Raspberry Pi) can mirror it and take over automatically.'
          : 'It mirrors the primary and only takes control if the primary stops responding.'))),
    el('div', { class: 'grid sm:grid-cols-2 gap-4' },
      field('Role of this instance', role),
      primaryUrlField),
    // the sync-token setup steps are only relevant ON the primary, a standby
    // receives the token, it doesn't hand one out
    isPrimary && el('div', { class: 'mt-4 rounded-xl bg-stone-50 dark:bg-stone-800/60 p-4 text-[15px]' },
      el('div', { class: 'font-semibold mb-1' }, 'Setting up a backup?'),
      el('ol', { class: 'list-decimal list-inside hint space-y-1' },
        el('li', {}, 'Install this app on the second device and open its setup wizard'),
        el('li', {}, 'Choose “Standby” and enter this instance’s URL'),
        el('li', {}, 'Copy the sync token below and paste it into the standby during its setup, it authenticates the mirror and appears on the standby’s “Primary URL” step')),
      el('button', {
        class: 'btn-secondary btn-sm mt-3',
        onclick: async () => {
          const full = await api.get('/api/sync/export');
          const token = full.failover.syncToken;
          const ok = await copyText(token);
          // long-lived toast that always SHOWS the token too, so it can be
          // read/transcribed even when the clipboard copy succeeded
          toast(ok ? `Copied to clipboard, sync token: ${token}` : `Copy failed, sync token: ${token}`,
            ok ? 'success' : 'warn', { ms: 15000 });
        },
      }, icon('key', 'w-4 h-4'), 'Copy sync token')),
    el('div', { class: 'mt-4' },
      el('button', {
        class: 'btn', 'data-settings-save': '1',
        onclick: async () => {
          try {
            await api.put('/api/settings', { instance: { role: role.value }, failover: { primaryUrl: primaryUrl.value } });
            settingsDirty = false;
            await restartApp('Saved, restarting to apply…');
          } catch (err) { toast(err.message, 'error'); }
        },
      }, 'Save and restart')));
  syncPrimaryUrlVisibility();

  // ── tabbed layout ──────────────────────────────────────────────────────
  // The page is long, so group the cards into tabs with a sticky tab bar.
  // One tab shows at a time; the choice persists across saves/visits.
  const TABS = [
    { id: 'location', label: 'Location', icon: 'calendar', nodes: [locationCard] },
    { id: 'devices', label: 'Devices', icon: 'bulb', nodes: [bridgesCard] },
    { id: 'childlock', label: 'Child Lock', icon: 'lock', nodes: [enforcementCard] },
    { id: 'testmode', label: 'Test mode', icon: 'play', nodes: [testModeCard(container)] },
    { id: 'notifications', label: 'Notifications', icon: 'bell', nodes: [notifyCard] },
    { id: 'system', label: 'System', icon: 'server', nodes: [updatesCard, backupCard(container), instanceCard] },
    { id: 'account', label: 'Account', icon: 'user', nodes: [dangerZone(s, container)] },
  ];
  let activeTab = localStorage.getItem('settings-tab');
  if (!TABS.some((t) => t.id === activeTab)) activeTab = TABS[0].id;

  const btnClass = (on) => 'shrink-0 inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-[14px] font-medium '
    + `transition-colors whitespace-nowrap ${on ? 'bg-accent-600 text-white shadow-sm'
      : 'text-stone-600 dark:text-stone-300 hover:bg-stone-200/70 dark:hover:bg-stone-800'}`;
  const tabBtns = new Map();
  const panels = new Map();
  // ── custom mobile dropdown (icons + labels; desktop uses the pill row) ──
  const swBtnInner = el('span', { class: 'inline-flex items-center gap-2.5 min-w-0' });
  const swItems = new Map();
  const swMenu = el('div', {
    class: 'hidden absolute left-0 right-0 top-full mt-1.5 z-50 max-h-[70vh] overflow-auto rounded-xl border '
      + 'border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 shadow-xl py-1.5',
  });
  const swItemClass = (on) => 'flex items-center gap-3 w-full text-left px-4 py-3 text-[16px] '
    + (on ? 'font-semibold text-accent-600 dark:text-accent-400 bg-accent-50 dark:bg-accent-600/10'
      : 'text-stone-700 dark:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800');
  let swOpen = false;
  const onSwDoc = (e) => { if (!swWrap.contains(e.target)) closeSw(); };
  const closeSw = () => { if (!swOpen) return; swOpen = false; swMenu.classList.add('hidden'); document.removeEventListener('click', onSwDoc); };
  const swBtn = el('button', {
    class: 'xl:hidden w-full rounded-xl border border-stone-300 dark:border-stone-700 bg-white dark:bg-stone-900 '
      + 'px-4 py-2.5 flex items-center justify-between gap-2 text-left', 'aria-haspopup': 'true',
    onclick: (e) => { e.stopPropagation(); if (swOpen) { closeSw(); return; } swOpen = true; swMenu.classList.remove('hidden'); setTimeout(() => document.addEventListener('click', onSwDoc)); },
  }, swBtnInner, icon('chevronDown', 'w-5 h-5 shrink-0 opacity-60'));
  const swWrap = el('div', { class: 'relative xl:hidden', role: 'tablist' }, swBtn, swMenu);
  const renderSwBtn = () => {
    const t = TABS.find((x) => x.id === activeTab);
    mount(clear(swBtnInner), icon(t.icon, 'w-5 h-5 shrink-0 text-accent-600 dark:text-accent-400'),
      el('span', { class: 'font-semibold text-[16px] truncate' }, t.label));
  };

  const doShowTab = (id) => {
    activeTab = id;
    localStorage.setItem('settings-tab', id);
    for (const t of TABS) {
      panels.get(t.id).classList.toggle('hidden', t.id !== id);
      const b = tabBtns.get(t.id);
      b.className = btnClass(t.id === id);
      b.setAttribute('aria-selected', String(t.id === id));
      swItems.get(t.id).className = swItemClass(t.id === id);
    }
    renderSwBtn();
    window.scrollTo({ top: 0 });
  };
  // switching tabs with unsaved edits prompts first; discarding re-renders the
  // page fresh (server state) on the target tab, keeping otherwise loses them
  const showTab = (id) => {
    if (id === activeTab) return;
    if (settingsDirty) {
      confirmLeaveSettings(() => { settingsDirty = false; localStorage.setItem('settings-tab', id); render(container); });
      return;
    }
    doShowTab(id);
  };

  mount(clear(swMenu), TABS.map((t) => {
    const item = el('button', {
      class: swItemClass(t.id === activeTab), role: 'tab',
      onclick: (e) => { e.stopPropagation(); closeSw(); showTab(t.id); },
    }, icon(t.icon, 'w-5 h-5 shrink-0'), t.label);
    swItems.set(t.id, item);
    return item;
  }));
  renderSwBtn();

  mount(clear(container),
    // sticky title + tab bar (same offset as the Schedules bar, so it never
    // hides under the mobile header)
    el('div', {
      class: 'sticky-below-header z-20 -mx-4 sm:-mx-6 lg:-mx-10 -mt-5 sm:-mt-6 lg:-mt-7 px-4 sm:px-6 lg:px-10 pt-4 sm:pt-5 lg:pt-7 pb-2.5 mb-5 '
        + 'bg-stone-100/85 dark:bg-stone-950/85 backdrop-blur border-b border-stone-200/80 dark:border-stone-800/80',
    },
      el('div', { class: 'flex items-center justify-between gap-3 mb-3' },
        el('h1', { class: 'text-2xl sm:text-3xl font-semibold tracking-tight' }, 'Settings'),
        !s.setupComplete && el('a', { class: 'btn-secondary btn-sm', href: '#/wizard' }, 'Setup wizard')),
      swWrap,
      el('div', { class: 'hidden xl:flex gap-1.5 overflow-x-auto', role: 'tablist' },
        TABS.map((t) => {
          const b = el('button', {
            class: btnClass(t.id === activeTab), role: 'tab', 'aria-selected': String(t.id === activeTab),
            onclick: () => showTab(t.id),
          }, icon(t.icon, 'w-4 h-4'), t.label);
          tabBtns.set(t.id, b);
          return b;
        }))),
    ...TABS.map((t) => {
      const panel = el('div', { class: `space-y-5 ${t.id === activeTab ? '' : 'hidden'}`, role: 'tabpanel' }, ...t.nodes);
      panels.set(t.id, panel);
      return panel;
    }));
  // restore the scroll position so a save doesn't jump the page to the top
  if (scrollY) window.scrollTo(0, scrollY);

  // ⌘S / Ctrl+S saves the active tab — clicks that panel's Save button (some
  // tabs save-and-restart, matching the button). Always suppresses the browser's
  // save-page dialog, even on tabs with no save button (e.g. Test mode), so the
  // shortcut behaves consistently across the page. Replaced on rerender and
  // self-cleaned once Settings leaves the DOM, so it never leaks across navs.
  if (container._settingsKeydown) window.removeEventListener('keydown', container._settingsKeydown);
  const onSettingsKeydown = (e) => {
    if (!container.isConnected) { window.removeEventListener('keydown', onSettingsKeydown); return; }
    if (!((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S'))) return;
    e.preventDefault();
    container.querySelector('[role=tabpanel]:not(.hidden) [data-settings-save]')?.click();
  };
  container._settingsKeydown = onSettingsKeydown;
  window.addEventListener('keydown', onSettingsKeydown);
}

/**
 * Software updates: current vs latest (from smartoneg.com/version.json, checked
 * in the background), a manual "Check now", and, when an update is available —
 * an "Update now" that either self-updates via the Docker socket or hands back
 * the exact host command.
 */
function buildUpdatesCard(s) {
  const body = el('div', {});
  const autoRow = checkRow('Automatically check for updates', {
    checked: s.updates?.autoCheck !== false,
    hint: 'Contacts smartoneg.com/version.json about once a day to see if a newer version exists, it sends nothing about you. Turn this off to stop all automatic outbound requests; “Check now” still works on demand.',
    onchange: async (e) => {
      const checked = e.target.checked;
      try { await api.put('/api/settings', { updates: { autoCheck: checked } }); toast(checked ? 'Automatic update checks on' : 'Automatic update checks off', 'success'); }
      catch (err) { toast(err.message, 'error'); }
    },
  });
  autoRow.input.setAttribute('data-autosave', '1'); // saves itself, not part of the dirty check
  const card = sectionCard('download', 'Software updates', body,
    el('div', { class: 'mt-4 pt-4 border-t border-stone-200 dark:border-stone-800' }, autoRow.node),
    el('p', { class: 'hint mt-3' }, 'Your data in the ./data volume is never touched by an update.'));

  const draw = (v) => {
    const up = v?.updateAvailable;
    const checked = v?.checkedAt ? `Last checked: ${fmtDateTime(v.checkedAt)}` : 'Not checked yet';
    mount(clear(body),
      el('div', { class: 'flex flex-wrap items-center gap-x-6 gap-y-1 text-[15px]' },
        el('div', {}, el('span', { class: 'text-stone-500' }, 'Installed: '), el('b', {}, v?.current ?? '—')),
        el('div', {}, el('span', { class: 'text-stone-500' }, 'Latest: '), el('b', {}, v?.latest ?? '—')),
        el('span', { class: up ? 'badge-on' : 'badge-off' }, up ? 'Update available' : 'Up to date')),
      up && v?.notes && el('div', { class: 'mt-3 rounded-xl bg-stone-50 dark:bg-stone-800/60 p-3 text-[14px] whitespace-pre-wrap' }, v.notes),
      el('div', { class: 'mt-4 flex flex-wrap gap-2.5 items-center' },
        el('button', {
          class: 'btn-secondary btn-sm',
          onclick: async (e) => {
            const b = e.currentTarget; b.disabled = true; b.textContent = 'Checking…';
            try { draw(await api.post('/api/version/check')); toast('Checked for updates', 'success'); }
            catch (err) { toast(err.message, 'error'); b.disabled = false; b.textContent = 'Check now'; }
          },
        }, 'Check now'),
        up && el('button', {
          class: 'btn btn-sm',
          onclick: () => startUpdate(),
        }, icon('download', 'w-4 h-4'), `Update to ${v.latest}`),
        v?.url && el('a', { class: 'btn-ghost btn-sm', href: v.url, target: '_blank' }, 'Release notes')),
      el('p', { class: 'hint mt-2' }, checked));
  };

  const startUpdate = async () => {
    try {
      const r = await api.post('/api/system/update');
      if (r.mode === 'auto') {
        // watchtower recreates this container, wait it out, then reload
        restartApp('Updating, pulling the new version…', { skipRequest: true });
      } else {
        // manual: show the exact command to run on the host
        modal({
          title: 'Update from the host',
          body: el('div', { class: 'space-y-3 text-[15px]' },
            el('p', {}, r.message ?? 'Run this where your docker-compose.yml lives:'),
            el('pre', { class: 'rounded-xl bg-stone-100 dark:bg-stone-800 p-3 text-[13px] font-mono overflow-x-auto' }, r.command ?? 'docker compose pull && docker compose up -d'),
            el('p', { class: 'hint' }, 'To enable one-click updates from here instead, mount the Docker socket into the container (see the docs).')),
          confirmText: 'Copy command',
          onConfirm: async () => { const ok = await copyText(r.command ?? 'docker compose pull && docker compose up -d'); toast(ok ? 'Command copied to clipboard' : 'Copy failed, select it manually', ok ? 'success' : 'warn'); },
        });
      }
    } catch (err) { toast(err.message, 'error'); }
  };

  api.get('/api/version').then(draw).catch(() => draw(null));
  return card;
}

/**
 * Test mode: run the scheduler on a virtual clock so an upcoming Shabbos/Yom
 * Tov can be demoed or tested any day, real timers, real lights. Auto-exits
 * when a real Shabbos/YT begins.
 */
function testModeCard(container) {
  // Test mode is a runner, not settings — its controls must never trip the
  // page's unsaved-changes guard.
  const card = el('div', { class: 'card', 'data-no-dirty': '1' }, el('p', { class: 'hint' }, 'Loading test mode…'));

  (async () => {
    const [health, clusters] = await Promise.all([
      api.get('/api/health'),
      api.get(`/api/calendar?from=${todayISO()}&to=${localISO(new Date(Date.now() + 500 * 86400000))}`).catch(() => []),
    ]);
    const tm = health.testMode ?? { active: false };

    if (tm.active) {
      const steps = testModeSteps.get();
      const idx = testModeSteps.index();
      const cooling = testModeSteps.throttleRemainingSec() > 0;
      const jumpTo = async (i) => {
        if (testModeSteps.throttleRemainingSec() > 0) return; // shared cooldown — don't stack bursts
        const all = testModeSteps.get(); if (!all?.length) return;
        const at = Math.max(0, Math.min(all.length - 1, i));
        testModeSteps.setIndex(at);
        const virtualNow = all[at].at - testModeSteps.seconds() * 1000;
        // start the shared cooldown BEFORE the banner listener sees this event,
        // so app.js starts ticking the countdown (see optimistic-banner listener)
        testModeSteps.throttle();
        toast(`Skipping to ${all[at].label}…`, 'warn', { ms: 5000 });
        window.dispatchEvent(new CustomEvent('smartoneg:optimistic-banner', { detail: { testMode: { active: true, virtualNow: new Date(virtualNow).toISOString() } } }));
        try { await api.post('/api/test-mode', { virtualNow }); } catch (err) { toast(err.message, 'error'); }
        window.dispatchEvent(new Event('smartoneg:refresh-shell'));
        render(container);
      };
      const secBox = el('input', { class: 'input !w-20', type: 'number', min: 2, max: 600, value: testModeSteps.seconds(),
        onchange: (e) => { const n = Number(e.target.value); if (n >= 2) testModeSteps.setSeconds(n); } });
      mount(clear(card),
        el('div', { class: 'section-title text-amber-600 dark:text-amber-400' }, icon('alert'), 'Test mode is ON'),
        el('p', { class: 'text-[15px] mb-3' },
          'The app is simulating ', el('b', {}, tm.label ?? 'an event'),
          tm.virtualNow ? el('span', {}, ' at ', el('b', {}, fmtDateTime(tm.virtualNow))) : '',
          '. Scheduled rules are firing on your real lights. Exiting yourself restores your lights to how they were before you started. If a real Shabbos/Yom Tov begins, it auto-exits and hands control to your real schedule instead.'),
        // step through the occurrence's rules; each skip lands `secondsBefore`
        // ahead of the moment and lets the scheduler fire it for real
        steps?.length && el('div', { class: 'rounded-xl border border-stone-200 dark:border-stone-800 p-3 mb-4' },
          el('div', { class: 'label mb-2' }, 'Step between rules'),
          el('div', { class: 'flex items-center gap-3' },
            el('button', { class: 'btn-secondary btn-sm shrink-0', disabled: idx <= 0 || cooling, onclick: () => jumpTo(idx - 1) }, icon('chevronLeft', 'w-4 h-4'), 'Prev'),
            cooling && el('span', {
              class: 'shrink-0 text-[13px] font-bold tabular-nums text-amber-600 dark:text-amber-400',
              'data-testmode-countdown': true,
              title: 'Cooling down so the bridge isn’t flooded',
            }, `${testModeSteps.throttleRemainingSec()}s`),
            el('button', { class: 'btn-secondary btn-sm shrink-0', disabled: idx >= steps.length - 1 || cooling, onclick: () => jumpTo(idx + 1) }, 'Next', icon('chevronRight', 'w-4 h-4')),
            el('div', { class: 'min-w-0 text-[15px] font-medium truncate' }, steps[idx]?.label ?? '—')),
          el('div', { class: 'flex items-center gap-2 mt-3' },
            el('span', { class: 'hint' }, 'Wait'), secBox, el('span', { class: 'hint' }, 'seconds before each rule fires')),
          el('p', { class: 'hint mt-3' },
            'After each Prev/Next there’s a short waiting period (the countdown above) before you can step again. Each step fires a full burst of commands to your lights, so the pause lets the bridge finish one step before starting the next and keeps it from being overloaded.')),
        el('button', { class: 'btn-danger', onclick: async () => { testModeSteps.clear(); await api.del('/api/test-mode'); toast('Test mode off', 'success'); window.dispatchEvent(new Event('hashchange')); } },
          icon('power', 'w-4 h-4'), 'Exit test mode'));
      // Re-render once the cooldown ends so Prev/Next re-enable. clearTimeout
      // first so repeated renders don't stack pending timers.
      clearTimeout(testCooldownTimer);
      if (cooling) {
        testCooldownTimer = setTimeout(() => {
          if (document.body.contains(container)) render(container);
        }, testModeSteps.throttleRemainingSec() * 1000 + 200);
      }
      return;
    }

    // Curate the event list: EVERY Yom Tov in the year ahead, plus a variety of
    // Shabbosos (the next few, then some spread across the seasons for testing
    // winter/summer candle-lighting times).
    const future = clusters.filter((c) => new Date(c.endsAt) > Date.now());
    const yomTov = future.filter((c) => c.days.some((d) => d.dayType !== 'shabbos'));
    const shabbosos = future.filter((c) => c.days.every((d) => d.dayType === 'shabbos'));
    const variedShabbos = shabbosos.filter((c, i) => i < 4 || i % 9 === 0);
    const upcoming = [...yomTov, ...variedShabbos].sort((a, b) => new Date(a.startsAt) - new Date(b.startsAt));
    if (upcoming.length === 0) {
      mount(clear(card), el('div', { class: 'section-title' }, icon('play'), 'Test mode'),
        el('p', { class: 'hint' }, 'No upcoming events to simulate.'));
      return;
    }

    const eventSel = select(upcoming.map((c, i) => [String(i), `${c.label} · ${new Date(c.startsAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`]), '0');
    const jumpSel = el('div', {});
    const secondsIn = el('input', { class: 'input !w-24', type: 'number', min: 2, max: 600, value: testModeSteps.seconds() });
    const wkTime = (ms) => new Date(ms).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
    const hm = (ms) => new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

    // Rebuild the "jump to" options for the selected event. Distinct scheduled
    // moments (deduped by time+rule) plus a "specific time" picker so you can
    // land just before any exact time, e.g. 5:30 PM on the erev.
    const loadJump = async () => {
      const c = upcoming[Number(eventSel.value)];
      mount(clear(jumpSel), el('p', { class: 'hint' }, 'Loading times…'));
      const tl = await api.get(`/api/timeline?date=${c.days[0].date}`).catch(() => ({ actions: [] }));
      const seen = new Set();
      const actionPoints = [];
      for (const a of tl.actions) {
        const label = (a.source?.label || '').trim() || 'scheduled action';
        const key = `${Math.round(a.at / 60000)}|${label}`;
        if (seen.has(key)) continue;
        seen.add(key);
        actionPoints.push({ label: `${wkTime(a.at)} · ${label}`, at: a.at });
      }
      const points = [
        { label: `Candle lighting · ${hm(new Date(c.startsAt))}`, at: new Date(c.startsAt).getTime() },
        ...actionPoints,
        { label: `Havdalah · ${hm(new Date(c.endsAt))}`, at: new Date(c.endsAt).getTime() },
      ];

      // "specific time" picker: a day within the event + a time
      const dayOpts = [
        { iso: c.erevDate, label: `${c.erevLabel ?? 'Erev'} (${new Date(`${c.erevDate}T12:00`).toLocaleDateString(undefined, { weekday: 'short' })})` },
        ...c.days.map((d) => ({ iso: d.date, label: `${d.holidayLabel} (${new Date(`${d.date}T12:00`).toLocaleDateString(undefined, { weekday: 'short' })})` })),
      ];
      const daySel = select(dayOpts.map((o, i) => [String(i), o.label]), '0', null, 'select !w-auto');
      const timeIn = el('input', { class: 'input !w-36', type: 'time', value: '17:30' });
      const customBlock = el('div', { class: 'hidden mt-2 flex flex-wrap items-center gap-2' },
        el('span', { class: 'hint' }, 'on'), daySel, el('span', { class: 'hint' }, 'at'), timeIn);

      const sel = select([
        ...points.map((p, i) => [String(i), p.label]),
        ['custom', 'A specific time…'],
      ], '0', (v) => customBlock.classList.toggle('hidden', v !== 'custom'), 'select');

      mount(clear(jumpSel), field('Jump to just before…', el('div', {}, sel, customBlock)));
      jumpSel._points = points;
      jumpSel._getTarget = () => {
        if (sel.value === 'custom') {
          const day = dayOpts[Number(daySel.value)];
          return new Date(`${day.iso}T${timeIn.value || '17:30'}`).getTime();
        }
        return points[Number(sel.value)].at;
      };
      // which step the skip arrows start on: the chosen point, or the point
      // nearest a custom time so the arrows still line up with the timeline
      jumpSel._getIndex = () => {
        if (sel.value !== 'custom') return Number(sel.value);
        const t = jumpSel._getTarget();
        let best = 0, bestD = Infinity;
        points.forEach((p, i) => { const d = Math.abs(p.at - t); if (d < bestD) { bestD = d; best = i; } });
        return best;
      };
    };
    eventSel.addEventListener('change', loadJump);
    await loadJump();

    mount(clear(card),
      el('div', { class: 'section-title' }, icon('play'), 'Test mode'),
      el('p', { class: 'hint mb-2' },
        'Demo or test a Shabbos/Yom Tov on any day. The scheduler pretends it’s just before the moment you pick and runs for real, driving your actual lights (and Child Lock, if on). It never runs during a real Shabbos/Yom Tov, and auto-exits the moment one begins.'),
      el('p', { class: 'hint mb-4' },
        el('b', {}, 'Your lights are snapshotted first: '),
        'when you exit test mode yourself, everything is restored to exactly how it was before you started. The one exception: if a real Shabbos/Yom Tov (or its erev schedule) begins while you’re testing, test mode auto-exits and hands control straight to your real schedule, so your actual Shabbos/Yom Tov automation runs, rather than restoring the weekday snapshot.'),
      el('div', { class: 'grid sm:grid-cols-2 gap-4' },
        field('Event to simulate', eventSel),
        jumpSel),
      el('div', { class: 'mt-4' },
        el('label', { class: 'label' }, 'Start this many seconds before'),
        secondsIn),
      el('button', {
        class: 'btn mt-4',
        onclick: async () => {
          const virtualNow = jumpSel._getTarget() - Number(secondsIn.value) * 1000;
          // seed the "skip between rules" state so the arrows (banner + this
          // tab) can step through the occurrence's timeline from here
          testModeSteps.setSeconds(Number(secondsIn.value));
          testModeSteps.set(jumpSel._points ?? []);
          testModeSteps.setIndex(jumpSel._getIndex?.() ?? 0);
          // Show the TEST MODE banner immediately (optimistic), the POST only
          // resolves once every light has been driven, which looked frozen.
          toast('Test mode starting…', 'warn', { ms: 6000 });
          window.dispatchEvent(new CustomEvent('smartoneg:optimistic-banner', { detail: { testMode: { active: true, virtualNow: new Date(virtualNow).toISOString() } } }));
          try {
            await api.post('/api/test-mode', { virtualNow });
          } catch (err) { toast(err.message, 'error'); }
          window.dispatchEvent(new Event('smartoneg:refresh-shell'));
        },
      }, icon('power', 'w-4 h-4'), 'Start test mode'));
  })();

  return card;
}

/** Account (password) reset + full factory reset. */
/**
 * Backup & Restore: manual export/import of the full config, plus the nightly
 * on-disk snapshots (2:30 AM, 14 rolling days) with download and restore.
 */
function backupCard(container) {
  const DEMO = window.__SMARTONEG_DEMO__;
  const card = el('div', { class: 'card' },
    el('div', { class: 'section-title' }, icon('history'), 'Backup & Restore'),
    el('p', { class: 'hint' }, 'Loading backups…'));
  // The static demo has no server to export from or import into, show the
  // section but with the actions disabled so nothing appears broken.
  const demoDisabled = (ic, label) => el('span', {
    class: 'btn-secondary btn-sm opacity-50 cursor-not-allowed', title: 'Not available in the demo',
  }, icon(ic, 'w-4 h-4'), label);

  const importModal = () => {
    const ji = jsonInput({ placeholder: 'Paste an exported config.json…' });
    modal({
      title: 'Import configuration',
      body: el('div', { class: 'space-y-3' },
        el('p', { class: 'hint' }, 'Upload the exported file or paste it below. Replaces all settings, devices, scenes and schedules. If you run a backup (failover) device, this one stays whichever it already is, primary or backup.'),
        ji.node),
      confirmText: 'Import', confirmClass: 'btn-danger',
      onConfirm: async () => {
        if (!ji.valid()) { toast('That isn’t valid JSON, check the highlighted error', 'error'); return false; }
        try {
          await api.post('/api/config/import', ji.parse());
          toast('Config imported', 'success');
          render(container);
        } catch (err) { toast(err.message, 'error'); return false; }
      },
    });
  };

  (async () => {
    const backups = await api.get('/api/backups').catch(() => []);
    const picker = backups.length
      ? select(backups.map((b) => [b.name, `${b.date}  ·  ${Math.max(1, Math.round(b.size / 1024))} KB`]), backups[0].name, () => {}, 'select !w-auto')
      : null;
    mount(clear(card),
      el('div', { class: 'section-title' }, icon('history'), 'Backup & Restore'),
      el('p', { class: 'hint mb-3' },
        'Your entire configuration, devices, scenes, schedules, bridges and notification settings, lives in one file. '
        + 'Export it any time, and the app also snapshots it automatically every night at 2:30 AM (the last 14 days are kept).'),
      el('div', { class: 'flex flex-wrap gap-2' },
        DEMO
          ? demoDisabled('download', 'Export current config')
          : splitDownload({
            label: 'Export current config', href: '/api/sync/export', download: `smartoneg-config-${todayISO()}.json`,
            items: [{ label: 'Export redacted config', href: '/api/sync/export?redacted=1', download: `smartoneg-config-redacted-${todayISO()}.json`, icon: 'lock' }],
          }),
        DEMO
          ? demoDisabled('upload', 'Import')
          : el('button', { class: 'btn-secondary btn-sm', onclick: importModal }, icon('upload', 'w-4 h-4'), 'Import')),
      el('div', { class: 'mt-4 pt-4 border-t border-stone-200 dark:border-stone-800' },
        el('div', { class: 'font-medium text-[15px] mb-1.5' }, 'Nightly backups'),
        picker
          ? el('div', { class: 'flex flex-wrap items-center gap-2' },
            picker,
            el('a', {
              class: 'btn-secondary btn-sm', title: 'Download this backup',
              href: `/api/backups/${backups[0].name}`, download: backups[0].name,
            }, icon('download', 'w-4 h-4'), 'Download'),
            el('button', {
              class: 'btn-secondary btn-sm !text-rose-600 dark:!text-rose-400',
              onclick: () => modal({
                title: 'Restore this backup?',
                body: el('p', { class: 'text-[15px]' },
                  `Replaces ALL current settings, devices, scenes and schedules with the snapshot from ${picker.value.slice(7, 17)}. If you run a backup (failover) device, this one stays whichever it already is, primary or backup.`),
                confirmText: 'Restore', confirmClass: 'btn-danger',
                onConfirm: async () => {
                  try {
                    await api.post(`/api/backups/${picker.value}/restore`);
                    toast('Backup restored', 'success');
                    render(container);
                  } catch (err) { toast(err.message, 'error'); return false; }
                },
              }),
            }, 'Restore…'))
          : el('p', { class: 'hint' }, DEMO
            ? 'Nightly backups run on the server, not available in this browser-only demo.'
            : 'No nightly backups yet, the first one is written tonight at 2:30 AM (or the next time the app starts).')));
    // the Download link follows the dropdown selection
    if (picker) {
      const dl = card.querySelector('a[title="Download this backup"]');
      picker.addEventListener('change', () => { dl.href = `/api/backups/${picker.value}`; dl.setAttribute('download', picker.value); });
    }
  })();
  return card;
}

function dangerZone(s, container) {
  const email = el('input', { class: 'input', type: 'email', value: s.auth?.email ?? '', autocomplete: 'username' });
  const pass = el('input', { class: 'input', type: 'password', autocomplete: 'new-password', placeholder: 'New password (8+ characters)' });
  const pass2 = el('input', { class: 'input', type: 'password', autocomplete: 'new-password', placeholder: 'Re-enter new password' });

  return el('div', { class: 'card border-rose-200 dark:border-rose-500/30' },
    el('div', { class: 'section-title text-rose-700 dark:text-rose-400' }, icon('alert'), 'Account & reset'),

    el('div', { class: 'mb-6' },
      el('h4', { class: 'font-semibold mb-1' }, 'Change login email / password'),
      el('div', { class: 'grid sm:grid-cols-2 gap-4 mt-2' }, field('Email', email), el('div', {}),
        field('New password', pass), field('Confirm new password', pass2)),
      el('button', {
        class: 'btn-secondary mt-3',
        onclick: async () => {
          if (pass.value.length < 8) { toast('Password must be at least 8 characters', 'warn'); return; }
          if (pass.value !== pass2.value) { toast('The two passwords don’t match', 'warn'); return; }
          try {
            await api.post('/api/auth/reset-credentials', { email: email.value, password: pass.value });
            toast('Login updated', 'success');
            pass.value = ''; pass2.value = '';
          } catch (err) { toast(err.message, 'error'); }
        },
      }, 'Update login')),

    el('div', { class: 'divider' }),
    el('h4', { class: 'font-semibold mb-1 text-rose-700 dark:text-rose-400' }, 'Reset all settings'),
    el('p', { class: 'hint mb-3' },
      'Erases everything, devices, scenes, schedules, bridges, notifications, and your login, and returns the app to the first-run setup wizard. There is no undo. Export a backup first if you might want it.'),
    el('button', { class: 'btn-danger', onclick: () => confirmReset(container) }, icon('trash', 'w-4 h-4'), 'Reset all settings'));
}

function confirmReset(container) {
  const typed = el('input', { class: 'input mt-3', placeholder: 'Type: I understand' });
  modal({
    title: 'Reset everything?',
    body: el('div', { class: 'space-y-3 text-[15px]' },
      el('p', {}, 'This permanently deletes all devices, scenes, schedules, bridge settings, notifications, and your account. The app restarts into the setup wizard.'),
      el('p', { class: 'font-medium' }, 'Type “I understand” to confirm.'),
      typed),
    confirmText: 'Continue', confirmClass: 'btn-danger',
    onConfirm: () => {
      if (typed.value.trim().toLowerCase() !== 'i understand') { toast('Please type "I understand"', 'warn'); return false; }
      // second, final confirmation
      modal({
        title: 'Last chance',
        body: el('p', { class: 'text-[15px]' }, 'Are you absolutely sure? Everything will be erased and you will be taken to the setup wizard.'),
        confirmText: 'Yes, erase everything', confirmClass: 'btn-danger',
        onConfirm: async () => {
          try {
            await api.post('/api/config/reset');
            toast('All settings reset', 'success');
            setTimeout(() => { location.hash = '#/'; location.reload(); }, 600);
          } catch (err) { toast(err.message, 'error'); return false; }
        },
      });
    },
  });
}

async function enablePush() {
  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) throw new Error('Push not supported in this browser');
    if (!window.isSecureContext) throw new Error('Push needs HTTPS, open the app via your Cloudflare Tunnel / Tailscale hostname');
    const reg = await navigator.serviceWorker.ready;
    const { key } = await api.get('/api/push/vapid-public-key');
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64(key) });
    await api.post('/api/push/subscribe', sub.toJSON());
    toast('Push enabled on this device', 'success');
  } catch (err) { toast(err.message, 'error'); }
}

function urlB64(base64) {
  const pad = '='.repeat((4 - (base64.length % 4)) % 4);
  const b = (base64 + pad).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}
