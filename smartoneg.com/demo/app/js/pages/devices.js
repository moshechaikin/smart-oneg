import { api } from '../api.js';
import { el, clear, mount, toast, modal, field, checkRow, select, pollWhileMounted, pageHeader, fmtDateTime, fmtState, jsonInput, colorControl } from '../ui.js';
import { icon } from '../icons.js';
import { sortableList } from '../components/sortable.js';

const SOURCE_LABEL = { lutron: 'Lutron', hubitat: 'Hubitat', virtual: 'Manual', ecobee: 'Ecobee', homeassistant: 'Home Assistant', homebridge: 'Homebridge', matter: 'Matter', envisalink: 'EnvisaLink' };
const isThermostat = (z) => z.kind === 'thermostat';
// Flashing (a quick reminder blink) only makes sense for lights/dimmers, not
// plugs, fans, fridges, shades, or thermostats.
const isLight = (z) => !z.kind;

// Device kinds: control is always on/off + a 0-100 level; kind only affects the
// icon and the wording (a shade's level is "% open", a fan's is speed).
const KIND_ICON = { thermostat: 'thermometer', shade: 'blinds', fan: 'fan', outlet: 'plug', fridge: 'fridge', alarm: 'shield', bypass: 'lock', automation: 'play', lock: 'lock', vacuum: 'vacuum' };
const kindIcon = (z) => KIND_ICON[z.kind] ?? 'bulb';
// compact pill labels, the verbose forms live in the edit dialog's
// KIND_OPTIONS; long pills wrap the badge row into a sparse mess at the
// minimum card width
const KIND_LABEL = { thermostat: 'Thermostat', shade: 'Shade', fan: 'Fan', outlet: 'Smart plug', fridge: 'Fridge', alarm: 'Alarm', bypass: 'Zone bypass', automation: 'Automation', lock: 'Lock', vacuum: 'Vacuum' };
// 'On/Off' not 'On/Off switch': at the minimum card width the extra word
// pushed the badge row 9px past the content box, cascading all the pills
// into three sparse wrapped rows
const kindLabel = (z) => KIND_LABEL[z.kind] ?? (z.dimmable ? 'Dimmer' : 'On/Off');
// user-facing device-type choices for the edit dialog
const KIND_OPTIONS = [
  ['', 'Light'], ['outlet', 'Smart plug / outlet'], ['fan', 'Fan'],
  ['shade', 'Shade / blind'], ['fridge', 'Fridge (Sabbath mode)'], ['thermostat', 'Thermostat'],
  ['lock', 'Lock'], ['vacuum', 'Robot vacuum'],
  ['alarm', 'Alarm, arm/disarm'], ['bypass', 'Alarm, zone bypass'],
];
// on/off kinds (no brightness slider): plugs, the fridge Sabbath switch, the
// alarm partition / zone-bypass devices, locks, vacuums, and momentary triggers
const ONOFF_KINDS = new Set(['outlet', 'fridge', 'alarm', 'bypass', 'automation', 'lock', 'vacuum']);

// °F is the app's canonical thermostat unit; a device can DISPLAY in °C.
const fToDisplay = (f, unit) => (unit === 'C' ? Math.round((Number(f) - 32) * 5 / 9) : Math.round(Number(f)));
const displayToF = (v, unit) => (unit === 'C' ? Math.round((Number(v) * 9) / 5 + 32) : Math.round(Number(v)));
const tempUnit = (z) => (z.displayUnit === 'C' ? 'C' : 'F');
// Friendly thermostat mode labels (HA preset like "eco", hvac like "heat_cool")
const presetLabel = (m) => String(m).replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
const HVAC_LABEL = { heat: 'Heat', cool: 'Cool', heat_cool: 'Heat / Cool', auto: 'Auto', off: 'Off', dry: 'Dry', fan_only: 'Fan only' };
const hvacLabel = (m) => HVAC_LABEL[m] ?? presetLabel(m);

/**
 * Live devices page. Cards patch IN PLACE (no full re-render → no scroll
 * jumps): commands go out async, and an SSE stream pushes every level change
 *, from the app, a wall switch, or another user, the instant it happens.
 */
export async function devicesPage() {
  const container = el('div', {});
  // `pending` holds zone ids with a command in flight (spinner on the action
  // button until the device's state echoes back over SSE)
  const state = { zones: [], settings: null, cards: new Map(), pending: new Set(), pendingTimers: {} };

  const fullRender = async () => {
    [state.zones, state.settings] = await Promise.all([api.get('/api/zones'), api.get('/api/settings')]);
    draw(container, state, fullRender);
  };
  await fullRender();

  // instant updates via SSE; card gets a pop animation on change
  const es = new EventSource('/api/devices/stream');
  es.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    const z = state.zones.find((zz) => zz.id === msg.id);
    if (!z) return;
    // don't reshuffle cards while a dialog is open (avoids click races)
    const dialogOpen = () => document.querySelector('#modal-root > *');
    if (msg.mode) { // thermostat preset/hvac, or a light's color temperature
      let changed = false;
      if ('preset' in msg && z.reportedPreset !== msg.preset) { z.reportedPreset = msg.preset; changed = true; }
      if ('hvacMode' in msg && z.reportedHvacMode !== msg.hvacMode) { z.reportedHvacMode = msg.hvacMode; changed = true; }
      if ('kelvin' in msg && z.reportedKelvin !== msg.kelvin) { z.reportedKelvin = msg.kelvin; changed = true; }
      if ('rgbColor' in msg) { z.reportedRgb = msg.rgbColor; changed = true; }
      if ('controllable' in msg && z.reportedControllable !== msg.controllable) { z.reportedControllable = msg.controllable; changed = true; }
      // a thermostat Resume echoes back as a preset/hvac change (not always a
      // level change), so clear the action spinner here too — otherwise the
      // Hold/Resume button stays disabled until the 8s timeout and the press
      // looks like it did nothing
      if (state.pending.delete(z.id)) { clearTimeout(state.pendingTimers[z.id]); changed = true; }
      if (changed && !dialogOpen()) patchCard(state, z, fullRender, { animate: false });
      return;
    }
    // the state echoed back — clear any in-flight command spinner for this zone
    const wasPending = state.pending.delete(z.id);
    if (wasPending) clearTimeout(state.pendingTimers[z.id]);
    const levelChanged = z.reportedLevel !== msg.level;
    if (!levelChanged && !wasPending) return;
    z.reportedLevel = msg.level;
    if (!dialogOpen()) patchCard(state, z, fullRender, { animate: levelChanged });
  };
  new MutationObserver((_, obs) => {
    if (!document.body.contains(container)) { es.close(); obs.disconnect(); }
  }).observe(document.getElementById('app'), { childList: true, subtree: true });

  // slow poll for non-level changes (latches, renames from elsewhere)
  pollWhileMounted(container, async () => {
    if (document.querySelector('#modal-root > *')) return;
    const fresh = await api.get('/api/zones').catch(() => null);
    if (!fresh) return;
    for (const z of fresh) {
      const old = state.zones.find((o) => o.id === z.id);
      // carry the optimistic thermostat hold flag across the fresh fetch (the
      // server doesn't know it), else the poll would snap the pill back to "Hold"
      if (old && old.resumed != null) z.resumed = old.resumed;
      if (!old || JSON.stringify(old) !== JSON.stringify(z)) {
        const idx = state.zones.findIndex((o) => o.id === z.id);
        if (idx >= 0) state.zones[idx] = z; else state.zones.push(z);
        patchCard(state, z, fullRender, { animate: old && old.reportedLevel !== z.reportedLevel });
      }
    }
  }, 15_000);

  return container;
}

function draw(container, state, refresh) {
  state.cards.clear();
  mount(clear(container),
    pageHeader('Devices',
      state.zones.length > 0 && el('button', { class: 'btn-secondary', onclick: () => openRoomsReorder(state, refresh) },
        icon('reorder', 'w-5 h-5'), 'Reorder rooms'),
      el('button', { class: 'btn', onclick: () => addDeviceChooser(state.settings, refresh) },
        icon('plus', 'w-5 h-5'), 'Add devices')),

    state.zones.length === 0 && el('div', { class: 'card' },
      el('div', { class: 'section-title' }, icon('bulb'), 'No devices yet'),
      el('p', { class: 'hint mb-4' }, 'Add devices from Home Assistant, Lutron, Hubitat, Homebridge, Matter, EnvisaLink, or Ecobee, or add a manual device to get started.'),
      el('button', { class: 'btn', onclick: () => addDeviceChooser(state.settings, refresh) }, icon('plus', 'w-5 h-5'), 'Add devices')),

    // Compact rows grouped by room, in one vertical list in the saved room
    // order (so the reorder modal's list matches the page top-to-bottom). Each
    // room heading sticks while you scroll it, and a room's devices sit in a
    // two-column grid on desktop (row-major = natural reading order).
    (() => {
      const grouped = groupByArea(state.zones, state.settings?.roomOrder);
      // room controls: hover-reveal on desktop, but always visible on touch
      // (no hover on a phone) so reorder/rename stay reachable there
      // always visible (not hover-only) so it's obvious rooms can be renamed/reordered
      const roomBtn = 'icon-btn !w-7 !h-7 text-stone-400 hover:text-stone-600 dark:hover:text-stone-200';
      const heading = (area, list) => el('h2', {
        class: 'sticky-below-header z-10 group flex items-center gap-2 text-lg font-semibold py-2 mb-1 '
          + 'bg-stone-100/90 dark:bg-stone-950/90 backdrop-blur',
      },
        area,
        el('span', { class: 'text-sm font-normal text-stone-400' }, `· ${list.length}`),
        el('button', { class: roomBtn, title: 'Rename room', onclick: () => renameRoom(area, refresh) }, icon('pencil', 'w-4 h-4')),
        list.length > 1 && el('button', {
          class: roomBtn, title: 'Reorder devices in this room', onclick: () => openDevicesReorder(area, list, refresh),
        }, icon('reorder', 'w-4 h-4')));
      const room = ([area, list]) => el('section', { class: 'mb-6' },
        heading(area, list),
        // grid (not CSS columns): a device's height change on toggle only nudges
        // rows after it, never rebalances the whole column (that was the jitter);
        // row-major also matches the reorder list in natural reading order.
        // A lone device stays one column wide (left-aligned) instead of stretching
        // the whole row — matches the width it would have with a neighbour.
        el('div', { class: `card !p-1.5 grid gap-1.5 items-stretch ${list.length > 1 ? 'lg:grid-cols-2' : 'lg:max-w-[calc(50%-0.1875rem)]'}` },
          list.map((z) => {
            const node = deviceRow(z, state, refresh);
            state.cards.set(z.id, node);
            return node;
          })));
      return el('div', {}, grouped.map(room));
    })(),
  );
}

function patchCard(state, z, refresh, { animate = false } = {}) {
  const old = state.cards.get(z.id);
  if (!old || !document.body.contains(old)) return;
  const fresh = deviceRow(z, state, refresh, { animate });
  state.cards.set(z.id, fresh);
  old.replaceWith(fresh);
}

function deviceRow(z, state, refresh, { animate = false } = {}) {
  const thermo = isThermostat(z);
  const isShade = z.kind === 'shade';
  const unit = tempUnit(z);
  const level = z.reportedLevel ?? 0;
  const on = level > 0;
  // Home Assistant exposes NO reliable "is there a manual hold" signal (setting a
  // temperature doesn't change preset_mode), so a thermostat's Hold/Program state
  // can't be read back. We track it optimistically from the user's own actions in
  // this session (`z.resumed`): Resume → on program; setting a temperature → a
  // hold. Defaults to "holding" (the state whenever a setpoint has been applied).
  const thermoHolding = thermo && !z.resumed;
  const name = z.friendlyName || `${z.area} ${z.name}`;
  // a vacuum that advertises no start/dock services can't be driven remotely.
  // Prefer the LIVE flag from HA (reportedControllable) so it's right even
  // without a re-import; fall back to the stored capability.
  const vacUncontrollable = z.kind === 'vacuum' && (z.reportedControllable ?? z.controllable) === false;

  const pending = state.pending.has(z.id);
  const doCommand = async (newLevel) => {
    try {
      await api.post(`/api/zones/${z.id}/command`, { level: newLevel });
      // SSE echo updates the row; nothing else to do, page never re-renders
    } catch (err) {
      if (err.data?.standby) toast(err.data.error, 'error'); // backup instance: readonly / inactive
      else if (err.status === 409) confirmDuringCluster(z, newLevel, err.data);
      else toast(err.message, 'error');
    }
  };
  // A discrete on/off-style action (lock, dock, arm, turn on…) that has a real
  // round-trip: show a spinner + disable the button until the device's state
  // echoes back (or a safety timeout), so a slow lock can't be double-pressed.
  const clearPending = () => { state.pending.delete(z.id); clearTimeout(state.pendingTimers[z.id]); };
  const doAction = async (newLevel) => {
    state.pending.add(z.id);
    patchCard(state, z, refresh, { animate: false });
    clearTimeout(state.pendingTimers[z.id]);
    state.pendingTimers[z.id] = setTimeout(() => { if (state.pending.delete(z.id)) patchCard(state, z, refresh, { animate: false }); }, 8000);
    try {
      await api.post(`/api/zones/${z.id}/command`, { level: newLevel });
    } catch (err) {
      clearPending();
      patchCard(state, z, refresh, { animate: false });
      if (err.data?.standby) toast(err.data.error, 'error');
      else if (err.status === 409) confirmDuringCluster(z, newLevel, err.data);
      else toast(err.message, 'error');
    }
  };
  const spin = () => el('span', { class: 'animate-spin h-4 w-4 border-2 border-current border-t-transparent rounded-full shrink-0' });

  // Thermostats use a +/- stepper (a slider is fiddly for a 1° change); dimmers
  // keep a compact brightness slider inline in the row.
  // HA's standard climate range (7–35°C ≈ 45–95°F); the server still clamps to
  // the thermostat's own reported min/max, this just keeps the stepper from
  // capping a legitimate setpoint (e.g. a 35°C/95°F Ecobee) short.
  const tMin = unit === 'C' ? 7 : 45;
  const tMax = unit === 'C' ? 35 : 95;
  // Track the setpoint LOCALLY so repeated taps accumulate (recomputing from the
  // render-time `level` on every tap froze it at +1 until an SSE echo landed).
  // Update the readout immediately, then debounce the command so a burst of taps
  // sends one final setpoint instead of one request per degree.
  const thermoControl = () => {
    let curDisp = fToDisplay(level || 70, unit);
    const readout = el('span', { class: 'text-lg font-semibold tabular-nums text-center min-w-[3.5rem]' }, `${curDisp}°${unit}`);
    let timer = null;
    const stepBtn = (dir) => el('button', {
      class: 'icon-btn !w-8 !h-8 shrink-0 border border-stone-200 dark:border-stone-700 hover:bg-stone-100 dark:hover:bg-stone-800',
      title: dir < 0 ? 'Lower target' : 'Raise target',
      onclick: () => {
        const next = Math.min(tMax, Math.max(tMin, curDisp + dir));
        if (next === curDisp) return;
        curDisp = next;
        z.resumed = false; // setting a temperature IS a manual hold
        readout.textContent = `${curDisp}°${unit}`;
        clearTimeout(timer);
        timer = setTimeout(() => doCommand(displayToF(curDisp, unit)), 350);
      },
    }, icon(dir < 0 ? 'minus' : 'plus', 'w-4 h-4'));
    return el('div', { class: 'flex items-center gap-2 shrink-0' }, stepBtn(-1), readout, stepBtn(1));
  };
  const control = thermo
    ? thermoControl()
    : z.dimmable
      // On a phone the slider takes its OWN full-width row (basis-full) so it
      // stays big and usable, with the action + flash buttons flowing onto the
      // row below TOGETHER (flash never orphaned on a line by itself). From `sm`
      // up it flexes inline beside the buttons, capped at 11rem so it doesn't
      // stretch too wide on desktop.
      ? (() => {
        const readout = el('span', { class: 'w-11 text-right text-xs font-semibold text-stone-500 shrink-0 tabular-nums' },
          on ? `${Math.round(level)}%` : (isShade ? 'Closed' : 'Off'));
        return el('div', { class: 'flex items-center gap-2 min-w-0 basis-full sm:basis-0 sm:grow sm:max-w-[11rem]' },
          el('input', {
            // an OFF dimmer sits at 0, not 100 — otherwise the slider starts
            // full, so "drag and release at 100%" is a no-op change (the browser
            // fires `change` only when the release value differs from where the
            // drag began) and the light never turns on.
            class: 'dim-slider w-full min-w-0', type: 'range', min: 0, max: 100,
            value: on ? level : 0,
            style: `--dim:${on ? Math.round(level) : 0}%`,
            // live-update the fill AND the % readout while dragging; onchange
            // (release) sends the final value to the device
            oninput: (e) => {
              const v = Number(e.target.value);
              e.target.style.setProperty('--dim', `${v}%`);
              // at zero the readout matches its resting wording (a shade is
              // "Closed", a light "Off") instead of a bare "0%"
              readout.textContent = v === 0 ? (isShade ? 'Closed' : 'Off') : `${v}%`;
            },
            onchange: (e) => doCommand(Number(e.target.value)),
          }),
          readout);
      })()
      : null;

  // Thermostat mode controls: preset (Home/Away/…) and hvac (heat/cool/off),
  // reflecting the current mode and setting it on change.
  const setMode = async (body) => {
    try { await api.post(`/api/zones/${z.id}/mode`, body); }
    catch (err) { toast(err.message, 'error'); }
  };
  const modeControls = thermo && (z.presetModes?.length || z.hvacModes?.length) && el('div', { class: 'flex flex-wrap items-center gap-1.5 shrink-0' },
    z.presetModes?.length ? select(z.presetModes.map((m) => [m, presetLabel(m)]), z.reportedPreset ?? z.presetModes[0], (v) => setMode({ preset: v }), 'select !py-1.5 !text-sm !w-auto') : null,
    z.hvacModes?.length ? select(z.hvacModes.map((m) => [m, hvacLabel(m)]), z.reportedHvacMode ?? z.hvacModes[0], (v) => setMode({ hvacMode: v }), 'select !py-1.5 !text-sm !w-auto') : null);

  // Light color: an RGB picker when supported, else a warm↔cool white slider
  const minK = z.minKelvin ?? 2200; const maxK = z.maxKelvin ?? 6500;
  const colorTempControl = isLight(z) && z.rgb
    // RGB swatches take a full row of their own (basis-full breaks the flex line)
    // so the brightness slider keeps its width instead of being crushed tiny.
    ? el('div', { class: 'flex flex-wrap items-center gap-1.5 basis-full', title: 'Light color' },
        colorControl(z.reportedRgb ?? null, (rgb) => api.post(`/api/zones/${z.id}/color`, { rgb }).catch((err) => toast(err.message, 'error'))))
    // like the RGB picker, the warm↔cool slider takes a full row of its own
    // (basis-full breaks the flex line) so it isn't crushed next to the buttons
    : isLight(z) && z.colorTemp && el('div', { class: 'flex flex-wrap items-center gap-1.5 basis-full', title: 'White color temperature (warm ↔ cool)' },
        icon('sun', 'w-4 h-4 text-amber-400 shrink-0'),
        el('input', {
          type: 'range', class: 'ct-slider w-48', min: minK, max: maxK, step: 50,
          value: z.reportedKelvin ?? Math.round((minK + maxK) / 2),
          onchange: (e) => api.post(`/api/zones/${z.id}/color-temp`, { kelvin: Number(e.target.value) }).catch((err) => toast(err.message, 'error')),
        }));

  // State pill: dimmers show On/Off (the slider shows the %); shades Open/Closed;
  // thermostats their hold temperature in the chosen unit.
  const pillText = thermo ? (thermoHolding ? `Hold ${fToDisplay(level, unit)}°${unit}` : 'Program')
    : isShade ? (on ? 'Open' : 'Closed')
      : (z.dimmable ? (on ? 'On' : 'Off') : fmtState(z, level));

  // the action button keeps its full label (Turn on/off, Open/Close, Run, …),
  // no toggle switch, so it always says what pressing it does
  const actionBtn = thermo
    ? el('button', {
      class: 'btn-secondary btn-sm shrink-0', disabled: pending,
      title: thermoHolding ? 'Release the hold, thermostat follows its own program' : 'Hold at this temperature',
      onclick: () => {
        if (thermoHolding) { z.resumed = true; toast('Resuming the thermostat’s own schedule…'); doAction(0); }
        else { z.resumed = false; doAction(level || 70); }
      },
    }, pending && spin(), thermoHolding ? 'Resume' : 'Hold')
    : z.kind === 'automation'
      ? el('button', {
        class: 'btn btn-sm shrink-0', title: 'Run this automation now',
        onclick: (e) => {
          toast(`Running ${name}…`);
          doCommand(100);
          // automations don't hold a state, so pulse the row like it lit up and
          // let it settle back (accent flash + icon pop). Because the icon box
          // never changes to the "on" accent color on its own (no lasting
          // state), a bare scale pop on the faint gray icon is nearly invisible
          // — so we also momentarily swap it to the same accent colors a light
          // gets when it turns on, then transition back, so the pop reads.
          const row = e.currentTarget.closest('[data-zone]');
          const iconBox = row?.firstElementChild;
          if (row) {
            const onCls = ['bg-accent-200/80', 'text-accent-700', 'dark:bg-accent-500/25', 'dark:text-accent-300'];
            const offCls = ['bg-stone-100', 'text-stone-400', 'dark:bg-stone-800', 'dark:text-stone-500'];
            row.classList.add('run-pulse');
            if (iconBox) {
              iconBox.classList.add('device-pop');
              iconBox.classList.remove(...offCls);
              iconBox.classList.add(...onCls);
              setTimeout(() => { iconBox.classList.remove(...onCls); iconBox.classList.add(...offCls); }, 550);
            }
            setTimeout(() => { row.classList.remove('run-pulse'); iconBox?.classList.remove('device-pop'); }, 700);
          }
        },
      }, icon('play', 'w-4 h-4'), 'Run')
      : el('button', {
        class: `${on ? 'btn-secondary' : 'btn'} btn-sm shrink-0`, disabled: pending || vacUncontrollable,
        title: vacUncontrollable ? 'This vacuum doesn’t expose start/dock to Home Assistant, so it can’t be driven remotely' : '',
        onclick: () => doAction(on ? 0 : 100),
      }, pending ? spin() : icon(KIND_ICON[z.kind] && z.kind !== 'fridge' && z.kind !== 'outlet' ? KIND_ICON[z.kind] : 'power', 'w-4 h-4'),
      z.kind === 'alarm' ? (on ? 'Disarm' : 'Arm')
        : z.kind === 'bypass' ? (on ? 'Restore' : 'Bypass')
          : z.kind === 'lock' ? (on ? 'Unlock' : 'Lock')
            : z.kind === 'vacuum' ? (on ? 'Dock' : 'Start')
              : isShade ? (on ? 'Close' : 'Open') : (on ? 'Turn off' : 'Turn on'));

  const flashBtn = isLight(z) && el('button', {
    class: 'btn-secondary btn-sm !px-2.5 shrink-0', title: 'Flash device',
    onclick: () => {
      toast(`Flashing ${name}…`);
      api.post(`/api/zones/${z.id}/flash`, { times: 1 }).catch((err) => toast(err.message, 'error'));
    },
    // wrap the icon in a text-height (20px) box so this icon-only button matches
    // the height of the text buttons (Turn on/off) sitting beside it
  }, el('span', { class: 'flex items-center h-5' }, icon('zap', 'w-4 h-4')));

  // A rounded row (in a spaced list, so two lit-up neighbours stay visually
  // separate). Name spans the full width on its own line (no premature ellipsis);
  // controls sit above the pills, which get their own wrapping row underneath.
  return el('div', {
    // Every device reads as its own inset card inside the room: an always-on
    // neutral fill when off, the accent fill when on. break-inside-avoid keeps a
    // row whole when the room flows into two columns.
    class: `flex gap-3 rounded-xl px-2.5 py-2.5 transition-colors duration-300 ${on
      ? 'bg-accent-100/60 dark:bg-accent-600/15'
      : 'bg-stone-100 dark:bg-white/[0.04]'}`,
    'data-zone': z.id,
  },
    el('span', {
      class: `flex items-center justify-center w-10 h-10 rounded-xl shrink-0 self-start transition-colors duration-300 ${on
        ? 'bg-accent-200/80 text-accent-700 dark:bg-accent-500/25 dark:text-accent-300'
        : 'bg-stone-100 text-stone-400 dark:bg-stone-800 dark:text-stone-500'} ${animate ? 'device-pop' : ''}`,
    }, icon(kindIcon(z), 'w-5 h-5')),
    el('div', { class: 'flex-1 min-w-0' },
      el('div', { class: 'flex items-start gap-2' },
        el('div', { class: 'font-semibold text-[15px] leading-snug flex-1 min-w-0 line-clamp-2' }, name),
        el('button', { class: 'icon-btn !w-7 !h-7 shrink-0 -mr-1 -mt-0.5 text-stone-400', title: 'Edit device', onclick: () => editDevice(z, refresh, state.settings, state.zones) }, icon('pencil', 'w-4 h-4'))),
      el('div', { class: 'mt-1 space-y-2' },
        // pills sit ABOVE the buttons/controls
        el('div', { class: 'flex flex-wrap items-center gap-1.5' },
          el('span', { class: `${on ? 'badge-on' : 'badge-off'} ${animate ? 'value-flash' : ''}` }, pillText),
          el('span', { class: 'badge-info' }, SOURCE_LABEL[z.source ?? 'lutron']),
          el('span', { class: 'badge-off' }, kindLabel(z)),
          z.enforce && el('span', { class: 'badge-on' }, icon('lock', 'w-3.5 h-3.5'), 'Child Lock'),
          vacUncontrollable && el('span', { class: 'badge-warn', title: 'This vacuum doesn’t expose start/dock to Home Assistant' }, 'No remote control'),
          z.latch?.active && el('button', {
            class: 'badge-warn cursor-pointer', title: 'Manual override active until havdalah, click to release',
            onclick: async () => { await api.del(`/api/latches/${z.id}`); toast('Manual hold released'); refresh(); },
          }, 'Held · release')),
        el('div', { class: 'flex flex-wrap items-center gap-2' }, control, actionBtn, flashBtn, modeControls, colorTempControl))),
  );
}

function confirmDuringCluster(zone, level, data) {
  modal({
    title: 'Shabbos / Yom Tov is active',
    body: el('div', { class: 'space-y-3' },
      el('p', { class: 'text-[15px]' }, `${data.activeCluster.label} is in progress (until ${fmtDateTime(data.activeCluster.endsAt)}).`),
      el('p', { class: 'hint' }, 'Changing lights manually now is exactly what this app exists to prevent. Are you sure?')),
    confirmText: 'Yes, change it', confirmClass: 'btn-danger',
    onConfirm: () => api.post(`/api/zones/${zone.id}/command`, { level, confirm: true }).catch((e) => toast(e.message, 'error')),
  });
}

/** Group zones by room/area, alphabetical. */
function groupByArea(zones, roomOrder = []) {
  const groups = new Map();
  for (const z of zones) {
    const area = z.area || 'Other';
    if (!groups.has(area)) groups.set(area, []);
    groups.get(area).push(z);
  }
  // rooms follow the saved order; any not listed (new rooms) fall to the end
  // alphabetically. Device order within a room is the zones-array order.
  const rank = new Map(roomOrder.map((name, i) => [name, i]));
  return [...groups.entries()].sort(([a], [b]) => {
    const ra = rank.has(a) ? rank.get(a) : Infinity;
    const rb = rank.has(b) ? rank.get(b) : Infinity;
    return ra - rb || a.localeCompare(b);
  });
}

function editDevice(z, refresh, settings, allZones = []) {
  let m; // the modal handle, so the Child Lock note can close it before navigating
  const name = el('input', { class: 'input', value: z.friendlyName ?? '' });
  // Room is a styled combobox: pick an existing room from the list, or type a
  // new name to move the device / split a big room (e.g. carve up the Home
  // Assistant room). A native <datalist> filtered by the pre-filled value (so
  // it hid every other room); this always shows them all and matches the app.
  const rooms = [...new Set((allZones.length ? allZones : settings?.zones ?? []).map((zz) => zz.area).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  // Room picker: a real dropdown (chevron) so it reads as one, with a search box
  // inside that doubles as "add a new room" — clearer than a bare text field that
  // was secretly also a dropdown.
  let chosenRoom = z.area ?? '';
  const roomValue = () => chosenRoom;
  const roomLabel = el('span', { class: chosenRoom ? '' : 'text-stone-400' }, chosenRoom || 'Choose a room…');
  const trigger = el('button', {
    type: 'button', class: 'input w-full flex items-center justify-between gap-2 !text-left',
  }, roomLabel, icon('chevronDown', 'w-4 h-4 shrink-0 text-stone-400'));
  const search = el('input', { class: 'input !py-2 mb-1.5', placeholder: 'Search rooms, or type a new one…', autocomplete: 'off' });
  const roomList = el('div', { class: 'max-h-56 overflow-y-auto overscroll-contain' });
  const roomPanel = el('div', {
    class: 'hidden absolute z-30 left-0 right-0 mt-1.5 rounded-xl border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 shadow-xl p-1.5',
  }, search, roomList);
  const closeRooms = () => roomPanel.classList.add('hidden');
  const choose = (r) => { chosenRoom = r; roomLabel.textContent = r; roomLabel.className = ''; closeRooms(); };
  const renderRooms = () => {
    const q = search.value.trim();
    const matches = rooms.filter((r) => r.toLowerCase().includes(q.toLowerCase()));
    const exact = rooms.some((r) => r.toLowerCase() === q.toLowerCase());
    mount(clear(roomList),
      matches.map((r) => el('button', {
        type: 'button',
        class: `w-full text-left px-3 py-1.5 rounded-lg text-[15px] hover:bg-stone-100 dark:hover:bg-stone-800 ${r === chosenRoom ? 'text-accent-700 dark:text-accent-300 font-medium' : ''}`,
        onclick: () => choose(r),
      }, r)),
      q && !exact && el('button', {
        type: 'button', class: 'w-full text-left px-3 py-1.5 rounded-lg text-[15px] text-accent-700 dark:text-accent-300 hover:bg-stone-100 dark:hover:bg-stone-800 flex items-center gap-1.5',
        onclick: () => choose(q),
      }, icon('plus', 'w-4 h-4'), `Create “${q}”`),
      !matches.length && !q && el('div', { class: 'px-3 py-1.5 text-sm text-stone-400' }, 'No rooms yet — type to add one'));
  };
  trigger.addEventListener('click', () => {
    if (roomPanel.classList.contains('hidden')) { search.value = ''; renderRooms(); roomPanel.classList.remove('hidden'); search.focus(); }
    else closeRooms();
  });
  search.addEventListener('input', renderRooms);
  const roomField = el('div', { class: 'relative' }, trigger, roomPanel);
  document.addEventListener('click', (e) => { if (!roomField.contains(e.target)) closeRooms(); });
  const isLutron = (z.source ?? 'lutron') === 'lutron';
  const dim = checkRow('Dimmer (supports brightness levels)', {
    checked: z.dimmable,
    hint: 'Off: the device is treated as a plain on/off switch (no sliders or percentages anywhere).',
  });
  const enforce = checkRow('Child Lock, reverse manual switch presses on Shabbos/Yom Tov', { checked: z.enforce });
  // Child Lock only actually runs when the global toggle is on (Settings →
  // Child Lock). If it's turned on for a device while globally off, this would
  // silently do nothing, so point the user there to enable + customize it.
  const childLockNote = el('div', {
    class: 'hidden ml-8 -mt-0.5 rounded-lg bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30 px-3 py-2 text-[13px] leading-snug text-amber-800 dark:text-amber-200',
  },
    'Child Lock is turned off for the whole app right now, so this won’t take effect yet. ',
    el('a', {
      href: '#/settings', class: 'font-semibold underline',
      onclick: (e) => { e.preventDefault(); m?.close(); localStorage.setItem('settings-tab', 'childlock'); location.hash = '#/settings'; },
    }, 'Turn it on in Settings → Child Lock'),
    ' to enable and customize it.');
  const syncChildLockNote = () => childLockNote.classList.toggle('hidden', !(enforce.input.checked && !settings?.enforcement?.enabled));
  enforce.input.addEventListener('change', syncChildLockNote);
  syncChildLockNote();
  // Automations are momentary triggers: they hold no state, so Child Lock
  // doesn't apply, and the type is fixed (only an HA import can create one;
  // exposing it in the picker would let a real light opt out of Child Lock).
  const isAutomation = z.kind === 'automation';
  const kindOptions = isAutomation ? [...KIND_OPTIONS, ['automation', 'Automation, runs once']] : KIND_OPTIONS;
  // Device type controls the icon + wording (a plug, a shade’s open %, a fan’s
  // speed, a thermostat’s setpoint). The dimmer toggle only applies to lights.
  const kindSel = select(kindOptions, z.kind ?? '', (v) => {
    dimRow.classList.toggle('hidden', v !== '');
    unitRow.classList.toggle('hidden', v !== 'thermostat');
  }, 'select');
  if (isAutomation) kindSel.disabled = true;
  const dimRow = el('div', { class: (z.kind ?? '') === '' ? '' : 'hidden' }, dim.node);
  const unitSel = select([['F', 'Fahrenheit (°F)'], ['C', 'Celsius (°C)']], tempUnit(z), () => {}, 'select');
  const unitRow = el('div', { class: z.kind === 'thermostat' ? '' : 'hidden' }, field('Temperature display', unitSel));
  m = modal({
    title: 'Edit device',
    // sticky footer so Save/Cancel stay pinned even when the content is tall
    // (a Lutron light with the room hint + the Child Lock note can overflow)
    stickyFooter: true, saveOnCtrlS: true,
    body: el('div', { class: 'space-y-4' },
      field('Name', name),
      field('Room', roomField, isLutron
        ? 'For Lutron devices, it’s best to set rooms in the Lutron app and re-import the integration report (this keeps everything in sync if you add switches later).'
        : null),
      field('Device type', kindSel),
      unitRow,
      dimRow,
      isAutomation ? null : enforce.node,
      isAutomation ? null : childLockNote,
      el('div', { class: 'divider' }),
      el('button', {
        class: 'btn-danger btn-sm',
        onclick: async () => {
          // always a two-step confirm: the server replies 409 with the
          // consequences; rules/scenes are cleaned up automatically on force
          let refs = [];
          try { await api.del(`/api/zones/${z.id}`); } catch (err) {
            if (err.status !== 409) { toast(err.message, 'error'); return; }
            refs = err.data.references ?? [];
          }
          const ruleRefs = refs.filter((r) => r.type === 'rule');
          const sceneRefs = refs.filter((r) => r.type === 'scene');
          modal({
            title: `Remove “${z.friendlyName || z.name}”?`,
            body: el('div', { class: 'space-y-2.5' },
              refs.length === 0 && el('p', { class: 'text-[15px]' }, 'No rules or scenes use this device. It will simply disappear from the app (the physical device is untouched).'),
              ruleRefs.length > 0 && el('p', { class: 'text-[15px]' },
                el('b', {}, `${ruleRefs.length} rule${ruleRefs.length === 1 ? '' : 's'}`),
                ' reference it, rules targeting only this device will be deleted; rules with several devices just lose this one:'),
              ruleRefs.length > 0 && el('ul', { class: 'list-disc list-inside hint' },
                ruleRefs.map((r) => el('li', {}, `“${r.label}” (${r.dayType})`))),
              sceneRefs.length > 0 && el('p', { class: 'text-[15px]' },
                el('b', {}, `${sceneRefs.length} scene${sceneRefs.length === 1 ? '' : 's'}`),
                ' include it, it will be dropped from them: ',
                sceneRefs.map((r) => r.name).join(', ')),
              el('p', { class: 'text-[15px] font-semibold text-rose-600 dark:text-rose-400' }, 'This cannot be undone.')),
            confirmText: 'Remove device', confirmClass: 'btn-danger',
            onConfirm: async () => {
              try {
                const out = await api.del(`/api/zones/${z.id}?force=true`);
                toast(`Device removed${out.rulesRemoved || out.rulesUpdated ? ` · ${out.rulesRemoved} rule(s) deleted, ${out.rulesUpdated} updated` : ''}`);
                document.querySelector('#modal-root > div')?.remove();
                refresh();
              } catch (err) { toast(err.message, 'error'); }
            },
          });
        },
      }, icon('trash', 'w-4 h-4'), 'Remove device')),
    confirmText: 'Save',
    onConfirm: async () => {
      const kind = kindSel.value || null; // '' → light (null)
      // dimmable is user-choice for lights; derived for the other types
      const dimmable = kind === null ? dim.input.checked : !ONOFF_KINDS.has(kind);
      await api.patch(`/api/zones/${z.id}`, {
        friendlyName: name.value, area: roomValue() || z.area,
        dimmable, enforce: enforce.input.checked,
        kind, displayUnit: kind === 'thermostat' ? unitSel.value : null,
      });
      toast('Device saved', 'success');
      refresh();
    },
  });
}

function renameRoom(from, refresh) {
  const input = el('input', { class: 'input', value: from });
  modal({
    title: `Rename “${from}”`,
    body: el('div', { class: 'space-y-2' },
      el('p', { class: 'hint' }, 'Renames the room for every device currently in it.'),
      field('Room name', input)),
    confirmText: 'Rename',
    onConfirm: async () => {
      if (!input.value.trim() || input.value.trim() === from) return;
      await api.post('/api/rooms/rename', { from, to: input.value.trim() });
      toast('Room renamed', 'success');
      refresh();
    },
  });
}

/** Reorder the rooms on the Devices page (drag handle or arrows). */
function openRoomsReorder(state, refresh) {
  const rooms = groupByArea(state.zones, state.settings?.roomOrder);
  if (rooms.length < 2) { toast('You need at least two rooms to reorder', 'info'); return; }
  const sortable = sortableList(rooms.map(([area, list]) => ({
    id: area, label: area, sub: `${list.length} device${list.length === 1 ? '' : 's'}`,
  })));
  modal({
    title: 'Reorder rooms',
    body: el('div', {},
      el('p', { class: 'hint mb-3' }, 'Drag the handle or use the arrows to set the order rooms appear on this page.'),
      sortable.node),
    stickyFooter: true, saveOnCtrlS: true,
    confirmText: 'Save order',
    onConfirm: async () => {
      try { await api.post('/api/rooms/reorder', { order: sortable.getOrder() }); toast('Room order saved', 'success'); refresh(); }
      catch (err) { toast(err.message, 'error'); return false; }
    },
  });
}

/** Reorder the devices within one room (drag handle or arrows). */
function openDevicesReorder(area, list, refresh) {
  const sortable = sortableList(list.map((z) => ({
    id: z.id, label: z.friendlyName || `${z.area} ${z.name}`, sub: kindLabel(z),
  })));
  modal({
    title: `Reorder ${area}`,
    body: el('div', {},
      el('p', { class: 'hint mb-3' }, 'Drag the handle or use the arrows to set the order of devices in this room.'),
      sortable.node),
    stickyFooter: true, saveOnCtrlS: true,
    confirmText: 'Save order',
    onConfirm: async () => {
      try { await api.post('/api/zones/reorder', { ids: sortable.getOrder() }); toast('Device order saved', 'success'); refresh(); }
      catch (err) { toast(err.message, 'error'); return false; }
    },
  });
}

/** "+ Add devices": choose an ecosystem, then its specific flow. */
export function addDeviceChooser(settings, refresh) {
  const options = [
    // order mirrors the setup wizard. Home Assistant + Hubitat show their brand
    // logos (img); the rest use line icons.
    { key: 'homeassistant', img: '/demo/app/icons/home-assistant-icon.png', title: 'Home Assistant',
      desc: settings.homeassistant?.enabled ? 'Import lights, switches and thermostats (push state, full Child Lock)' : 'Enable it in Settings first' },
    { key: 'lutron', img: '/demo/app/icons/lutron-icon.png', title: 'Lutron Caséta bridge',
      desc: settings.lutron.enabled !== false ? 'Import or refresh the integration report' : 'Currently disabled in Settings' },
    { key: 'hubitat', img: '/demo/app/icons/hubitat-icon.png', title: 'Hubitat hub',
      desc: settings.hubitat?.enabled ? 'Import Zigbee / Z-Wave / Ecobee devices from Maker API' : 'Enable it in Settings first' },
    { key: 'homebridge', img: '/demo/app/icons/homebridge-icon.png', title: 'Homebridge',
      desc: settings.homebridge?.enabled ? 'Import accessories via config-ui-x (polled, Child Lock lags a few seconds)' : 'Enable it in Settings first' },
    { key: 'matter', img: '/demo/app/icons/matter-icon.png', title: 'Matter device (experimental)',
      desc: settings.matter?.enabled ? 'Pair a Matter device with its code, then import it' : 'Enable it in Settings first' },
    { key: 'ecobee', img: '/demo/app/icons/ecobee-icon.png', title: 'Ecobee thermostat (cloud)',
      desc: 'Native cloud API. Recommended instead: pair to Hubitat/Home Assistant (local is more reliable on Shabbos)' },
    { key: 'manual', icon: 'plus', title: 'Manual device', desc: 'A virtual device (plan schedules without hardware)' },
  ];
  const m = modal({
    title: 'Add devices',
    body: el('div', { class: 'space-y-2' },
      options.map((o) => el('button', {
        class: 'w-full text-left card !p-3 hover:border-accent-400 dark:hover:border-accent-500 transition-colors flex items-center gap-3.5',
        onclick: () => { m.close(); ({ lutron: lutronFlow, hubitat: hubitatFlow, homeassistant: homeAssistantFlow, homebridge: homebridgeFlow, matter: matterFlow, ecobee: ecobeeFlow, manual: manualFlow })[o.key](settings, refresh); },
      },
        el('span', { class: 'text-accent-600 dark:text-accent-400 shrink-0' },
          o.img ? el('img', { src: o.img, alt: '', class: `w-6 h-6 object-contain ${o.key === 'homebridge' ? 'scale-[1.15]' : ''}` }) : icon(o.icon, 'w-6 h-6')),
        el('div', { class: 'min-w-0' },
          el('div', { class: 'font-semibold text-[15px]' }, o.title),
          el('div', { class: 'hint' }, o.desc))))),
  });
}

function manualFlow(_settings, refresh) {
  const name = el('input', { class: 'input', placeholder: 'e.g. Porch light' });
  const dim = checkRow('Dimmer (supports brightness levels)', { checked: false });
  modal({
    title: 'Add a manual device',
    body: el('div', { class: 'space-y-4' },
      el('p', { class: 'hint' }, 'Manual devices are virtual: they follow schedules and show in previews, but control no real hardware. Great for planning.'),
      field('Name', name), dim.node),
    confirmText: 'Add device',
    onConfirm: async () => {
      if (!name.value.trim()) { toast('Name required', 'warn'); return false; }
      await api.post('/api/zones/manual', { name: name.value, dimmable: dim.input.checked });
      toast('Device added', 'success');
      refresh();
    },
  });
}

function lutronFlow(_settings, refresh) {
  const ji = jsonInput({ placeholder: '{ "LIPIdList": { ... } }' });
  modal({
    title: 'Import / refresh Lutron devices',
    wide: true,
    body: el('div', { class: 'space-y-3' },
      el('ol', { class: 'list-decimal list-inside text-[15px] space-y-1' },
        el('li', {}, 'Lutron app → Settings → Advanced → Integration'),
        el('li', {}, el('b', {}, 'Send Integration Report'), ' → email it to yourself'),
        el('li', {}, 'Upload the file or paste the JSON below, existing device names, rules and settings are preserved')),
      ji.node),
    confirmText: 'Check & import',
    onConfirm: async () => {
      if (!ji.valid()) { toast('That isn’t valid JSON, check the highlighted error', 'warn'); return false; }
      const report = ji.parse();
      try {
        const diff = await api.post('/api/zones/lutron/diff', report);
        showLutronDiff(diff, report, refresh);
      } catch (err) { toast(err.message, 'error'); return false; }
    },
  });
}

/** Show what a re-import would change; warn hard when rules would break. */
function showLutronDiff(diff, report, refresh) {
  const apply = async () => {
    await api.post('/api/zones/import', report);
    toast('Lutron devices updated', 'success');
    refresh();
  };
  if (diff.added.length === 0 && diff.removed.length === 0 && diff.renamed.length === 0) {
    toast('No changes, the report matches your current devices', 'info');
    return;
  }
  modal({
    title: diff.safe ? 'Confirm Lutron changes' : 'Warning: devices are missing',
    wide: true,
    body: el('div', { class: 'space-y-4 text-[15px]' },
      diff.removed.length > 0 && el('div', { class: 'rounded-xl bg-rose-50 dark:bg-rose-500/10 border border-rose-200 dark:border-rose-500/30 p-4' },
        el('div', { class: 'font-semibold text-rose-700 dark:text-rose-300 mb-2 flex items-center gap-2' },
          icon('alert', 'w-5 h-5'), `${diff.removed.length} device(s) missing from the new report`),
        el('ul', { class: 'space-y-1.5' }, diff.removed.map((z) => el('li', {},
          el('b', {}, z.friendlyName || z.name),
          z.references.length > 0
            ? el('span', { class: 'text-rose-600 dark:text-rose-300' },
              `, used by: ${z.references.map((r) => r.type === 'rule' ? `rule "${r.label}"` : `scene "${r.name}"`).join(', ')}`)
            : ', not referenced by any rules')))),
      diff.added.length > 0 && el('div', {},
        el('div', { class: 'font-semibold mb-1' }, `${diff.added.length} new device(s)`),
        el('ul', { class: 'hint list-disc list-inside' }, diff.added.map((z) => el('li', {}, `${z.area} · ${z.name} (LIP ${z.id})`)))),
      diff.renamed.length > 0 && el('div', {},
        el('div', { class: 'font-semibold mb-1' }, `${diff.renamed.length} renamed on the bridge`),
        el('ul', { class: 'hint list-disc list-inside' }, diff.renamed.map((r) => el('li', {}, `LIP ${r.id}: ${r.from.area} ${r.from.name} → ${r.to.area} ${r.to.name} (your name "${r.from.friendlyName}" is kept)`)))),
      el('p', { class: 'hint' }, `${diff.unchangedCount} device(s) unchanged. Friendly names and enforcement settings are always preserved.`),
      !diff.safe && el('p', { class: 'font-medium text-rose-600 dark:text-rose-300' },
        'Importing will NOT delete the missing devices or your rules, but commands to them will fail until they return. Fix the report or update your rules.')),
    confirmText: diff.safe ? 'Apply changes' : 'Import anyway',
    confirmClass: diff.safe ? 'btn' : 'btn-danger',
    onConfirm: apply,
  });
}

function hubitatFlow(settings, refresh) {
  return providerImportFlow({
    enabled: Boolean(settings.hubitat?.enabled),
    name: 'Hubitat',
    apiBase: '/api/hubitat',
    deviceLine: (d) => `${d.label}, ${d.dimmable ? 'dimmer' : 'switch'}`,
  }, refresh);
}

/** Existing room names across all zones, for the "combine into a room" pickers. */
async function existingRooms() {
  const zones = await api.get('/api/zones').catch(() => []);
  return [...new Set(zones.map((z) => z.area).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

/**
 * A per-device row with a "check to import" box and a Room dropdown. The Room
 * is a plain <select> of the rooms you already have plus a "default" entry, so
 * imported devices combine into existing rooms (Living Room, Kitchen, …)
 * instead of creating a separate "Home Assistant"/"Homebridge"/"Matter" room.
 * Leaving it on the default groups the device under `defaultArea`.
 * Returns { node, get } where get() -> {id, area}|null.
 */
function importRow(device, line, rooms, defaultArea, onToggle, existing) {
  const check = el('input', { class: 'checkbox shrink-0 mt-0.5', type: 'checkbox' });
  // already-imported devices: the room is fixed (re-import keeps it), so the
  // dropdown just shows the current room and stays disabled. New devices pick one.
  const room = existing
    ? select([[existing.area, existing.area]], existing.area, null, 'select !py-1.5 w-44 shrink-0')
    : select([['', `${defaultArea} (default)`], ...rooms.map((r) => [r, r])], '', null, 'select !py-1.5 w-44 shrink-0');
  room.disabled = true;
  const sync = () => { room.disabled = existing ? true : !check.checked; onToggle?.(); };
  check.addEventListener('change', sync);
  const badge = existing && el('span', { class: 'shrink-0 self-center text-[11px] font-medium px-2 py-0.5 rounded-md bg-stone-200 text-stone-600 dark:bg-stone-700 dark:text-stone-300' }, 'Added');
  // items-start + break-words so a long entity id wraps under its own text
  // instead of sliding beneath the Room dropdown on narrow rows
  const node = el('label', { class: 'flex items-start gap-3 py-1.5' },
    check,
    el('span', { class: 'flex-1 min-w-0 text-[15px] leading-snug break-words' }, line),
    badge || null,
    room);
  return {
    node,
    existing: Boolean(existing),
    checked: () => check.checked,
    set: (v) => { check.checked = v; room.disabled = existing ? true : !v; },
    get: () => (check.checked ? { id: device.id, area: existing ? existing.area : (room.value.trim() || undefined) } : null),
  };
}

function roomDatalist(id, rooms) {
  return el('datalist', { id }, rooms.map((r) => el('option', { value: r })));
}

/** Shared discover→check→import flow for the REST providers (HA, Homebridge, Hubitat). */
async function providerImportFlow({ enabled, name, apiBase, note, deviceLine, sortDevices }, refresh) {
  if (!enabled) {
    modal({
      title: `${name} is not enabled`,
      body: el('p', { class: 'text-[15px]' }, `Enable and configure ${name} in Settings first, then come back here to import its devices.`),
      confirmText: 'Open Settings',
      onConfirm: () => { location.hash = '#/settings'; },
    });
    return;
  }
  try {
    const [{ devices: found }, zones] = await Promise.all([api.post(`${apiBase}/discover`, {}), api.get('/api/zones').catch(() => [])]);
    if (!found.length) { toast(`${name} reports no importable devices`, 'warn'); return; }
    const rooms = [...new Set(zones.map((z) => z.area).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    const src = apiBase.replace('/api/', ''); // homeassistant | hubitat | homebridge
    const importedById = new Map(zones.filter((z) => z.source === src).map((z) => [String(z.externalId), z]));
    const devices = sortDevices ? sortDevices([...found]) : found;
    const selectAll = el('input', { class: 'checkbox shrink-0', type: 'checkbox' });
    const newOnly = el('input', { class: 'checkbox shrink-0', type: 'checkbox' });
    const countSpan = el('span', {});
    const visibleRows = () => rows.filter((r) => !(newOnly.checked && r.existing));
    // keep the header box in sync with the VISIBLE rows: all → checked, some →
    // indeterminate, none → off; the count reflects what's currently shown
    const syncSelectAll = () => {
      const vis = visibleRows();
      const n = vis.filter((r) => r.checked()).length;
      selectAll.checked = vis.length > 0 && n === vis.length;
      selectAll.indeterminate = n > 0 && n < vis.length;
      countSpan.textContent = `Select all (${vis.length})`;
    };
    const rows = devices.map((d) => importRow(d, deviceLine(d), rooms, d.kind === 'automation' ? 'Automations' : name, syncSelectAll, importedById.get(String(d.id))));
    const anyAdded = rows.some((r) => r.existing);
    // "New only" hides (and unchecks) already-imported devices, so a long list is
    // just the handful you haven't added yet — no wading past dozens of "Added"
    // rows, and no accidental mass re-import.
    const applyFilter = () => {
      rows.forEach((r) => {
        const hide = newOnly.checked && r.existing;
        r.node.classList.toggle('hidden', hide);
        if (hide) r.set(false);
      });
      syncSelectAll();
    };
    selectAll.addEventListener('change', () => { visibleRows().forEach((r) => r.set(selectAll.checked)); syncSelectAll(); });
    newOnly.addEventListener('change', applyFilter);
    syncSelectAll();
    modal({
      title: `Import ${name} devices`,
      stickyFooter: true,
      body: el('div', {},
        el('p', { class: 'hint -mt-2 mb-3' }, note ? `${note} ` : '', 'Pick a Room to file each device with your existing rooms, or leave the default to group them under “', name, '”. Devices already imported are marked “Added” — check one to re-import and refresh its capabilities (your room, name and Child Lock settings are kept).'),
        el('div', { class: 'flex items-center gap-3 py-1.5 mb-1 border-b border-stone-200 dark:border-stone-800 font-medium text-[15px]' },
          el('label', { class: 'flex items-center gap-3 cursor-pointer' }, selectAll, countSpan),
          anyAdded && el('label', { class: 'ml-auto flex items-center gap-2 text-[13px] font-normal text-stone-500 dark:text-stone-400 cursor-pointer' }, newOnly, 'New only')),
        el('div', { class: 'space-y-0.5' }, rows.map((r) => r.node))),
      confirmText: 'Add selected',
      onConfirm: async () => {
        const picks = rows.map((r) => r.get()).filter(Boolean);
        if (picks.length === 0) { toast('Nothing selected', 'warn'); return false; }
        const res = await api.post(`${apiBase}/import`, { devices: picks });
        const parts = [];
        if (res.added?.length) parts.push(`added ${res.added.length}`);
        if (res.refreshed?.length) parts.push(`refreshed ${res.refreshed.length}`);
        toast(parts.length ? `Devices ${parts.join(', ')}` : 'No changes', 'success');
        refresh();
      },
    });
  } catch (err) { toast(err.message, 'error'); }
}

const HA_KIND_WORD = { thermostat: 'thermostat', shade: 'shade / blind', fan: 'fan', outlet: 'smart plug', fridge: 'fridge (Sabbath mode)', automation: 'automation, runs once' };
function homeAssistantFlow(settings, refresh) {
  return providerImportFlow({
    enabled: Boolean(settings.homeassistant?.enabled),
    name: 'Home Assistant',
    apiBase: '/api/homeassistant',
    note: 'Automations, scripts, and HA scenes import as "Run" devices: a schedule rule or SmartOneg scene turning one on runs it once in Home Assistant.',
    // real devices first, then the automations/scripts block
    sortDevices: (list) => list.sort((a, b) => (a.kind === 'automation') - (b.kind === 'automation')),
    deviceLine: (d) => `${d.label}, ${HA_KIND_WORD[d.kind] ?? (d.dimmable ? 'dimmer' : 'switch')} (${d.id})`,
  }, refresh);
}

function homebridgeFlow(settings, refresh) {
  return providerImportFlow({
    enabled: Boolean(settings.homebridge?.enabled),
    name: 'Homebridge',
    apiBase: '/api/homebridge',
    note: 'Homebridge state is polled, so Child Lock corrections on these devices lag a few seconds. For enforced devices prefer Home Assistant or Hubitat.',
    deviceLine: (d) => `${d.label}, ${d.dimmable ? 'dimmer' : 'switch'}`,
  }, refresh);
}

function matterFlow(settings, refresh) {
  if (!settings.matter?.enabled) {
    modal({
      title: 'Matter is not enabled',
      body: el('p', { class: 'text-[15px]' }, 'Enable Matter (experimental) in Settings and let the app restart, then come back here to pair a device.'),
      confirmText: 'Open Settings',
      onConfirm: () => { location.hash = '#/settings'; },
    });
    return;
  }
  const code = el('input', { class: 'input tracking-wider', placeholder: '1234-567-8901', inputmode: 'numeric' });
  const room = el('input', { class: 'input', list: 'rooms-matter', placeholder: 'e.g. Living Room' });
  existingRooms().then((rooms) => { room.after(roomDatalist('rooms-matter', rooms)); });
  modal({
    title: 'Pair a Matter device',
    body: el('div', { class: 'space-y-3' },
      el('p', { class: 'hint' }, 'Enter the device’s 11-digit Matter pairing code (on the device or its box/app). Pairing runs over your local network and can take up to a minute. This feature is experimental.'),
      field('Pairing code', code),
      field('Room', room, 'Files it with your existing rooms, leave blank to group under “Matter”.')),
    confirmText: 'Pair device',
    onConfirm: async () => {
      const digits = (code.value || '').replace(/\D/g, '');
      if (digits.length < 11) { toast('Enter the full 11-digit pairing code', 'warn'); return false; }
      try {
        toast('Pairing… this can take up to a minute', 'info', { ms: 8000 });
        const { device } = await api.post('/api/matter/commission', { pairingCode: digits });
        await api.post('/api/matter/import', { devices: [{ id: device.id, area: room.value.trim() || undefined }] });
        toast(`Paired and added “${device.label}”`, 'success');
        refresh();
      } catch (err) { toast(err.message, 'error', { ms: 9000 }); return false; }
    },
  });
}

async function ecobeeFlow(settings, refresh) {
  if (!settings.ecobee?.enabled || !settings.ecobee?.refreshToken) {
    modal({
      title: 'Ecobee is not connected',
      body: el('div', { class: 'space-y-2 text-[15px]' },
        el('p', {}, 'Enable native Ecobee and run the PIN authorization in Settings → Bridges & hubs first.'),
        el('p', { class: 'hint' }, 'Better option: pair the Ecobee to a Hubitat hub, it stays local and doesn’t depend on Ecobee’s cloud during Shabbos.')),
      confirmText: 'Open Settings',
      onConfirm: () => { location.hash = '#/settings'; },
    });
    return;
  }
  try {
    const { devices } = await api.post('/api/ecobee/discover');
    const checks = new Map();
    modal({
      title: 'Import Ecobee thermostats',
      body: el('div', { class: 'space-y-1' },
        devices.map((d) => {
          const row = checkRow(`${d.label}, currently ${d.actualTempF}°F (${d.hvacMode})`, { onchange: (e) => checks.set(d.id, e.target.checked) });
          return row.node;
        })),
      confirmText: 'Add selected',
      onConfirm: async () => {
        const identifiers = [...checks.entries()].filter(([, v]) => v).map(([id]) => id);
        if (identifiers.length === 0) { toast('Nothing selected', 'warn'); return false; }
        const res = await api.post('/api/ecobee/import', { identifiers });
        toast(`Added ${res.added.length} thermostat(s)`, 'success');
        refresh();
      },
    });
  } catch (err) { toast(err.message, 'error'); }
}
