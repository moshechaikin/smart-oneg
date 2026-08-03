import { api } from '../api.js';
import { el, clear, mount, toast, modal, field, pageHeader, fmtState, colorControl, rgbToHex } from '../ui.js';
import { icon } from '../icons.js';
import { sortableList } from '../components/sortable.js';

// Thermostat setpoints are stored in °F (the app's canonical unit) but shown in
// the device's own unit, matching the Devices page.
const tempUnit = (z) => (z.displayUnit === 'C' ? 'C' : 'F');
const fToDisplay = (f, unit) => (unit === 'C' ? Math.round((Number(f) - 32) * 5 / 9) : Math.round(Number(f)));
const displayToF = (v, unit) => (unit === 'C' ? Math.round((Number(v) * 9) / 5 + 32) : Math.round(Number(v)));

// thermostat mode labels, matching the Devices/Schedules pages
const presetLabel = (m) => (m ?? '').replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
const HVAC_LABEL = { heat: 'Heat', cool: 'Cool', heat_cool: 'Heat / Cool', auto: 'Auto', off: 'Off', dry: 'Dry', fan_only: 'Fan only' };
const hvacLabel = (m) => HVAC_LABEL[m] ?? presetLabel(m);

export async function scenesPage() {
  const container = el('div', { class: 'space-y-5' });
  await render(container);
  return container;
}

async function render(container) {
  const [scenes, zones] = await Promise.all([api.get('/api/scenes'), api.get('/api/zones')]);
  const zoneOf = (id) => zones.find((z) => z.id === id);
  const zoneName = (id) => zoneOf(id)?.friendlyName || `Device ${id}`;

  mount(clear(container),
    pageHeader('Scenes',
      scenes.length > 1 && el('button', { class: 'btn-secondary', onclick: () => openScenesReorder(scenes, () => render(container)) },
        icon('reorder', 'w-5 h-5'), 'Reorder scenes'),
      el('button', { class: 'btn', onclick: () => editScene(null, null, scenes, zones, () => render(container)) },
        icon('plus', 'w-5 h-5'), 'New scene')),
    el('p', { class: 'hint max-w-2xl -mt-2' },
      'A scene is a reusable group of device states (like “mealtime”). Rules start and end scenes, so tweaking a scene updates every schedule that uses it. “Extend” makes a variant that inherits from a base scene.'),
    scenes.length === 0 && el('div', { class: 'card text-center py-10' },
      el('span', { class: 'inline-block text-stone-300 dark:text-stone-600 mb-2' }, icon('layers', 'w-10 h-10')),
      el('p', { class: 'hint' }, 'No scenes yet.')),
    el('div', { class: 'stagger grid sm:grid-cols-2 xl:grid-cols-3 gap-4' },
      // min-w-0: the truncated device names inside must not blow out the grid
      // track on narrow phones
      scenes.map((s) => {
      const openView = () => viewSceneModal(s, zoneOf, zoneName, () => editScene(s, null, scenes, zones, () => render(container)), scenes);
      // the whole card opens the view modal; the header buttons opt out
      return el('div', { class: 'card card-hover !p-5 min-w-0 cursor-pointer', onclick: (e) => { if (e.target.closest('button, a')) return; openView(); } },
        // flex-wrap: on very narrow phones (320px) the three icon buttons drop
        // below the name instead of pushing the card past the viewport
        el('div', { class: 'flex flex-wrap items-center justify-between gap-2 mb-3' },
          el('div', { class: 'min-w-0 flex-1' },
            el('div', { class: 'font-semibold text-[16px] leading-snug break-words' }, s.name ?? s.id),
            s.extends && el('div', { class: 'text-sm text-stone-500 dark:text-stone-400' },
              `extends ${scenes.find((p) => p.id === s.extends)?.name ?? s.extends}`)),
          el('div', { class: 'flex gap-1 shrink-0 self-start' },
            el('button', {
              class: 'icon-btn text-accent-600 dark:text-accent-400', title: 'Preview this scene on your real lights (a banner lets you restore)',
              onclick: async () => {
                // Show the banner immediately (optimistic), don't wait for the
                // server to finish driving every light before any feedback.
                toast('Scene preview starting…', 'success');
                window.dispatchEvent(new CustomEvent('smartoneg:optimistic-banner', { detail: { scenePreview: { active: true, name: s.name ?? s.id } } }));
                try {
                  await api.post(`/api/scenes/${s.id}/preview`);
                } catch (err) { toast(err.data?.error ?? err.message, 'error'); }
                window.dispatchEvent(new Event('smartoneg:refresh-shell'));
              },
            }, icon('play')),
            el('button', { class: 'icon-btn', title: 'Edit', onclick: () => editScene(s, null, scenes, zones, () => render(container)) }, icon('pencil')),
            el('button', { class: 'icon-btn', title: 'Extend scene', onclick: () => editScene(null, s, scenes, zones, () => render(container)) }, icon('layers')),
            el('button', { class: 'icon-btn text-rose-500', title: 'Delete scene', onclick: () => deleteScene(s, () => render(container)) }, icon('trash')))),
        resolvedList(s.id, zoneOf, zoneName, openView));
      })),
  );
}

/** Reorder scene cards on the page (drag handle or arrows), mirroring the
 *  Devices page's room/device reorder. Persists via POST /scenes/reorder. */
function openScenesReorder(scenes, refresh) {
  const sortable = sortableList(scenes.map((s) => ({
    id: s.id,
    label: s.name ?? s.id,
    sub: s.extends
      ? `extends ${scenes.find((p) => p.id === s.extends)?.name ?? s.extends}`
      : `${s.actions?.length ?? 0} device${(s.actions?.length ?? 0) === 1 ? '' : 's'}`,
  })));
  modal({
    title: 'Reorder scenes',
    body: el('div', {},
      el('p', { class: 'hint mb-3' }, 'Drag the handle or use the arrows to set the order scenes appear on this page.'),
      sortable.node),
    stickyFooter: true, saveOnCtrlS: true,
    confirmText: 'Save order',
    onConfirm: async () => {
      try { await api.post('/api/scenes/reorder', { ids: sortable.getOrder() }); toast('Scene order saved', 'success'); refresh(); }
      catch (err) { toast(err.message, 'error'); return false; }
    },
  });
}

// warm→cool dot for a color-temperature chip (matches the timeline's)
const kelvinColor = (k) => {
  const t = Math.max(0, Math.min(1, (k - 2200) / (6500 - 2200)));
  const warm = [255, 170, 66], cool = [201, 222, 255];
  const c = warm.map((w, i) => Math.round(w + (cool[i] - w) * t));
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
};

/** The On/Off/level/mode pill for one scene action. */
function stateBadge(a, zoneOf) {
  const isMode = a.preset != null || a.hvacMode != null;
  const badgeOn = a.flash || isMode || a.level > 0;
  const badgeText = a.flash ? `flash ${a.flash >= 2 ? 'twice' : 'once'}`
    : a.preset != null ? presetLabel(a.preset)
      : a.hvacMode != null ? hvacLabel(a.hvacMode)
        : fmtState(zoneOf(a.zone), a.level);
  return el('span', { class: badgeOn ? 'badge-on' : 'badge-off' }, badgeText);
}

/** One device-state row inside a scene (name + On/Off/level/mode badge). */
function sceneStateRow(a, zoneOf, zoneName) {
  const colorChip = !a.flash && a.level > 0 && (
    a.rgb != null
      ? el('span', { class: 'inline-flex items-center gap-1 text-xs text-stone-500 dark:text-stone-400 tabular-nums' },
          el('span', { class: 'w-2.5 h-2.5 rounded-full ring-1 ring-black/10 dark:ring-white/15', style: `background:${rgbToHex(a.rgb)}` }),
          rgbToHex(a.rgb))
      : a.kelvin != null
        ? el('span', { class: 'inline-flex items-center gap-1 text-xs text-stone-500 dark:text-stone-400 tabular-nums' },
            el('span', { class: 'w-2.5 h-2.5 rounded-full ring-1 ring-black/10 dark:ring-white/15', style: `background:${kelvinColor(a.kelvin)}` }),
            `${a.kelvin}K`)
        : null);
  return el('div', { class: 'flex justify-between items-center gap-2 text-[15px] py-1 border-b border-stone-100 dark:border-stone-800 last:border-0' },
    el('span', { class: 'truncate min-w-0' }, zoneName(a.zone)),
    el('span', { class: 'flex items-center gap-1.5 shrink-0' },
      colorChip,
      stateBadge(a, zoneOf)));
}

/** A row for the "Scene end" section: device name and the progression from its
 *  scene-start state to its scene-end state, e.g. "On → Off" or "60% → 20%".
 *  `endAct` is {zone, level}; `startAct` is the matching scene-start action. */
function sceneEndRow(endAct, startAct, zoneOf, zoneName) {
  const endBadge = stateBadge(endAct, zoneOf);
  return el('div', { class: 'flex justify-between items-center gap-2 text-[15px] py-1 border-b border-stone-100 dark:border-stone-800 last:border-0' },
    el('span', { class: 'truncate min-w-0' }, zoneName(endAct.zone)),
    el('span', { class: 'flex items-center gap-1.5 shrink-0' },
      startAct ? stateBadge(startAct, zoneOf) : null,
      startAct ? el('span', { class: 'text-stone-400 dark:text-stone-500' }, icon('chevronRight', 'w-4 h-4')) : null,
      endBadge));
}

// Preview at most this many device rows on the card; the rest live in the modal.
const SCENE_PREVIEW_ROWS = 5;

function resolvedList(id, zoneOf, zoneName, openView) {
  const box = el('div', { class: 'hint' }, 'Loading…');
  api.get(`/api/scenes/${id}/resolved`).then(({ actions }) => {
    if (actions.length === 0) { mount(clear(box), 'No devices'); return; }
    const more = actions.length - SCENE_PREVIEW_ROWS;
    if (more <= 0) { mount(clear(box), actions.map((a) => sceneStateRow(a, zoneOf, zoneName))); return; }
    // fade the overflow under a gradient, with a centered "View all" button
    mount(clear(box),
      el('div', { class: 'relative' },
        el('div', {}, actions.slice(0, SCENE_PREVIEW_ROWS).map((a) => sceneStateRow(a, zoneOf, zoneName))),
        el('div', { class: 'pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-white dark:from-stone-900 to-transparent' })),
      el('div', { class: 'flex justify-center mt-1.5' },
        el('button', { class: 'btn-secondary btn-sm', onclick: (e) => { e.stopPropagation(); openView(); } },
          `View all ${actions.length}`, icon('chevronDown', 'w-4 h-4'))));
  }).catch((err) => mount(clear(box), el('span', { class: 'text-rose-500 text-sm' }, err.message)));
  return box;
}

/** Read-only modal listing every device state in a scene. The edit affordance
 *  is a pencil next to the name (in the sticky header, like the scene cards),
 *  so there are no footer buttons to reach past a long device list. */
function viewSceneModal(scene, zoneOf, zoneName, onEdit, scenes = []) {
  const body = el('div', { class: 'hint' }, 'Loading…');
  let dlg;
  const parentName = scene.extends ? (scenes.find((p) => p.id === scene.extends)?.name ?? scene.extends) : null;
  const title = el('div', { class: 'min-w-0' },
    el('span', { class: 'inline-flex items-center gap-2' },
      scene.name ?? scene.id,
      el('button', { class: 'icon-btn shrink-0', title: 'Edit scene', onclick: () => { dlg.close(); onEdit(); } }, icon('pencil'))),
    // mirror the card: show what this scene extends, just under the name
    parentName && el('div', { class: 'text-sm font-normal text-stone-500 dark:text-stone-400 mt-0.5' }, `extends ${parentName}`));
  dlg = modal({ title, body });
  api.get(`/api/scenes/${scene.id}/resolved`).then(({ actions, endActions }) => {
    if (actions.length === 0) { mount(clear(body), el('p', { class: 'hint' }, 'No devices')); return; }
    const heading = (txt) => el('h4', { class: 'text-base font-semibold mb-1' }, txt);
    // "Scene end" only appears when the scene actually changes something on end;
    // each row shows the start → end progression so the change is obvious.
    const hasEnd = Array.isArray(endActions) && endActions.length > 0;
    mount(clear(body),
      heading('Scene start'),
      el('div', {}, actions.map((a) => sceneStateRow(a, zoneOf, zoneName))),
      hasEnd && el('div', { class: 'mt-5' },
        heading('Scene end'),
        el('div', {}, endActions.map((ea) => sceneEndRow(ea, actions.find((a) => a.zone === ea.zone), zoneOf, zoneName)))));
  }).catch((err) => mount(clear(body), el('span', { class: 'text-rose-500 text-sm' }, err.message)));
}

function deleteScene(scene, onDone) {
  const attempt = async (force) => {
    try {
      await api.del(`/api/scenes/${scene.id}${force ? '?force=true' : ''}`);
      toast('Scene deleted');
      onDone();
    } catch (err) {
      if (err.status === 409 && !force) {
        modal({
          title: `Delete “${scene.name ?? scene.id}”?`,
          body: el('div', { class: 'space-y-3 text-[15px]' },
            err.data.extensions?.length > 0 && el('p', {},
              el('b', {}, 'These extended scenes will be deleted too: '), err.data.extensions.join(', ')),
            err.data.references?.length > 0 && el('p', {},
              el('b', {}, 'Rules that use it will stop working: '),
              err.data.references.map((r) => `“${r.label}” (${r.dayType})`).join(', ')),
            el('p', { class: 'text-[15px] font-semibold text-rose-600 dark:text-rose-400' }, 'This cannot be undone.')),
          confirmText: 'Delete everything', confirmClass: 'btn-danger',
          onConfirm: () => attempt(true),
        });
      } else toast(err.message, 'error');
    }
  };
  modal({
    title: `Delete “${scene.name ?? scene.id}”?`,
    body: el('p', { class: 'text-[15px]' }, 'Remove this scene? Rules that reference it will stop doing anything.'),
    confirmText: 'Delete', confirmClass: 'btn-danger',
    onConfirm: () => attempt(false),
  });
}

function editScene(existing, parent, scenes, zones, onSaved) {
  const scene = structuredClone(existing) ?? {
    name: parent ? `${parent.name} (custom)` : '', extends: parent?.id ?? null,
    actions: parent ? undefined : [], overrides: parent ? {} : undefined, add: parent ? [] : undefined, remove: parent ? [] : undefined,
  };
  const isChild = Boolean(scene.extends);
  const name = el('input', { class: 'input', value: scene.name ?? '', placeholder: 'Scene name' });

  // Editing state: levels Map(zoneId -> level). Present = included in scene
  // (level may be 0 = "turn Off"); absent = not part of the scene.
  const rows = el('div', { class: 'space-y-1 mt-4' });
  const levels = new Map();
  const kelvins = new Map(); // zoneId -> white color temperature (K), colorTemp lights only
  const rgbs = new Map();    // zoneId -> [r,g,b] color, rgb lights only
  const presets = new Map(); // zoneId -> thermostat preset (Home/Away/…)
  const hvacs = new Map();    // zoneId -> thermostat hvac mode (heat/cool/off)
  const flashes = new Map(); // zoneId -> 1|2 (reminder blink instead of a level)
  const inherited = new Set();
  const lastOn = new Map(); // remember dim level across off/on toggles

  // a thermostat member is one of: a hold temperature, a preset, or an hvac
  // mode (mutually exclusive, matching a rule's single action)
  const clearMember = (zone) => { levels.delete(zone); kelvins.delete(zone); rgbs.delete(zone); presets.delete(zone); hvacs.delete(zone); };
  const applyMember = (zone, m) => {
    if (m.preset != null) presets.set(zone, m.preset);
    else if (m.hvacMode != null) hvacs.set(zone, m.hvacMode);
    else { levels.set(zone, m.level); if (m.rgb != null) rgbs.set(zone, m.rgb); else if (m.kelvin != null) kelvins.set(zone, m.kelvin); }
  };
  const memberZones = () => [...new Set([...levels.keys(), ...presets.keys(), ...hvacs.keys()])];

  const seed = async () => {
    if (isChild) {
      const parentResolved = await api.get(`/api/scenes/${scene.extends}/resolved`);
      for (const a of parentResolved.actions) { applyMember(a.zone, a); inherited.add(a.zone); }
      for (const [z, o] of Object.entries(scene.overrides ?? {})) { const zone = Number(z); clearMember(zone); applyMember(zone, o); inherited.delete(zone); }
      for (const a of scene.add ?? []) { clearMember(a.zone); applyMember(a.zone, a); inherited.delete(a.zone); }
      for (const z of scene.remove ?? []) clearMember(z);
    } else {
      for (const a of scene.actions ?? []) {
        if (a.flash) flashes.set(a.zone, a.flash);
        else applyMember(a.zone, a);
      }
    }
    for (const [z, lvl] of levels) if (lvl > 0) lastOn.set(z, lvl);
  };

  // End behavior. Default (not customized): every device is left as it is.
  let customEnd = Array.isArray(scene.endActions);
  const endState = new Map(); // zoneId -> { mode: 'off'|'on'|'level'|'skip', level }
  // The end-behavior choices offered for a device, by kind. Lights gain an
  // explicit "Turn on" (full on) so a scene can flip a device from off to on;
  // non-dimmable lights, which had only Leave/Turn off, get it too.
  const endModeOptions = (zc) => (zc?.kind === 'shade'
    ? [['skip', 'Leave as is'], ['off', 'Close'], ['level', 'Open to…']]
    : zc?.kind === 'thermostat'
      ? [['skip', 'Leave as is'], ['off', 'Resume program'], ['level', 'Hold at…']]
      : zc?.dimmable
        ? [['skip', 'Leave as is'], ['off', 'Turn off'], ['on', 'Turn on'], ['level', 'Dim to…']]
        : [['skip', 'Leave as is'], ['off', 'Turn off'], ['on', 'Turn on']]);
  // Which stored mode a saved end level maps back to, mirroring the options
  // above so reopening shows the friendly label (a full-on light reads
  // "Turn on", not "Dim to 100"). Shades/thermostats have no "on" mode.
  const endModeFromLevel = (zc, level) => {
    if (level <= 0) return 'off';
    if (zc?.kind === 'shade' || zc?.kind === 'thermostat') return 'level';
    return (zc?.dimmable && level < 100) ? 'level' : 'on';
  };
  const seedEnd = () => {
    for (const zone of memberZones()) {
      const entry = (scene.endActions ?? []).find((a) => a.zone === zone);
      endState.set(zone, entry
        ? { mode: endModeFromLevel(zones.find((z) => z.id === zone), entry.level), level: entry.level }
        : { mode: 'skip', level: 0 });
    }
  };

  const byArea = () => {
    const groups = new Map();
    for (const z of zones) {
      const area = z.area || 'Other';
      if (!groups.has(area)) groups.set(area, []);
      groups.get(area).push(z);
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  };

  // Thermostats get their own row: a "kind" selector (Hold temperature / Resume
  // program / Set mode / Heat·cool·off) plus the matching control, mirroring a
  // rule's thermostat action. Kept separate from the on/off deviceRow below.
  const thermostatRow = (z) => {
    const included = levels.has(z.id) || presets.has(z.id) || hvacs.has(z.id);
    const unit = tempUnit(z);
    // a stored level of 0 means "resume the thermostat's own program", NOT a 0°
    // hold — the engine treats level 0 that way (never send it as a temperature)
    const kind = presets.has(z.id) ? 'preset' : hvacs.has(z.id) ? 'hvac'
      : (levels.has(z.id) && levels.get(z.id) <= 0) ? 'resume' : 'temp';
    const kindOpts = [['temp', 'Hold temperature'], ['resume', 'Resume program'],
      ...(z.presetModes?.length ? [['preset', 'Set mode']] : []),
      ...(z.hvacModes?.length ? [['hvac', 'Heat / cool / off']] : [])];

    const setKind = (k) => {
      presets.delete(z.id); hvacs.delete(z.id); levels.delete(z.id);
      if (k === 'preset') presets.set(z.id, presets.get(z.id) ?? z.presetModes[0]);
      else if (k === 'hvac') hvacs.set(z.id, hvacs.get(z.id) ?? z.hvacModes[0]);
      else if (k === 'resume') levels.set(z.id, 0);
      else levels.set(z.id, lastOn.get(z.id) ?? 70);
      inherited.delete(z.id); seedEnd(); draw();
    };

    // clamp the hold to the thermostat's own range so a stale value can never
    // read as a nonsensical temperature (e.g. 0°F showing as -18°C)
    const minD = unit === 'C' ? 7 : 45; const maxD = unit === 'C' ? 35 : 95;
    const rawHoldF = levels.has(z.id) && levels.get(z.id) > 0 ? levels.get(z.id) : (lastOn.get(z.id) ?? 70);
    // a +/- stepper (matching the Devices page) — a slider is fiddly for a 1° change
    const thermoStepper = () => {
      let curDisp = Math.min(maxD, Math.max(minD, fToDisplay(rawHoldF, unit)));
      const readout = el('span', { class: 'text-[15px] font-semibold tabular-nums text-center min-w-[3.25rem]' }, `${curDisp}°${unit}`);
      const stepBtn = (dir) => el('button', {
        type: 'button', class: 'icon-btn !w-8 !h-8 shrink-0 border border-stone-200 dark:border-stone-700 hover:bg-stone-100 dark:hover:bg-stone-800',
        title: dir < 0 ? 'Lower target' : 'Raise target',
        onclick: () => {
          const next = Math.min(maxD, Math.max(minD, curDisp + dir));
          if (next === curDisp) return;
          curDisp = next; readout.textContent = `${curDisp}°${unit}`;
          const f = displayToF(curDisp, unit); levels.set(z.id, f); lastOn.set(z.id, f); inherited.delete(z.id);
        },
      }, icon(dir < 0 ? 'minus' : 'plus', 'w-4 h-4'));
      return el('div', { class: 'flex items-center gap-1.5 shrink-0' }, stepBtn(-1), readout, stepBtn(1));
    };
    const control = kind === 'temp'
      ? thermoStepper()
      : kind === 'resume'
        ? el('span', { class: 'text-sm text-stone-500 dark:text-stone-400' }, 'Releases any hold, back to its own schedule')
        : kind === 'preset'
          ? el('select', { class: 'select !w-auto !py-2 shrink-0', onchange: (e) => { presets.set(z.id, e.target.value); inherited.delete(z.id); } },
              z.presetModes.map((m) => el('option', { value: m, selected: presets.get(z.id) === m }, presetLabel(m))))
          : el('select', { class: 'select !w-auto !py-2 shrink-0', onchange: (e) => { hvacs.set(z.id, e.target.value); inherited.delete(z.id); } },
              z.hvacModes.map((m) => el('option', { value: m, selected: hvacs.get(z.id) === m }, hvacLabel(m))));

    // one line on desktop; wraps only on narrow phones
    return el('div', { class: 'flex flex-wrap items-center gap-3 py-1.5' },
      el('input', {
        class: 'checkbox', type: 'checkbox', checked: included, title: 'Include this thermostat in the scene',
        onchange: (e) => { if (e.target.checked) setKind('temp'); else { clearMember(z.id); inherited.delete(z.id); seedEnd(); draw(); } },
      }),
      el('span', { class: `w-36 sm:w-44 truncate text-[15px] shrink-0 ${inherited.has(z.id) ? 'text-stone-500 italic' : ''}` },
        z.friendlyName || `${z.area} ${z.name}`, inherited.has(z.id) ? ' *' : ''),
      included && kindOpts.length > 1 && el('select', {
        class: 'select !w-auto !py-2 shrink-0', title: 'What this scene does to the thermostat',
        onchange: (e) => setKind(e.target.value),
      }, kindOpts.map(([v, l]) => el('option', { value: v, selected: kind === v }, l))),
      included && control);
  };

  const deviceRow = (z) => {
    if (z.kind === 'thermostat') return thermostatRow(z);
    const flash = flashes.get(z.id);
    const included = levels.has(z.id) || Boolean(flash);
    const level = levels.has(z.id) ? levels.get(z.id) : undefined;
    const isOn = levels.has(z.id) && level > 0;
    const thermo = z.kind === 'thermostat';
    const isShade = z.kind === 'shade';

    // Thermostats aren't "dimmable" but still take a specific setpoint, so they
    // get the slider + readout too — shown in the device's own °C/°F unit while
    // stored in °F.
    const unit = tempUnit(z);
    const hasSlider = z.dimmable || thermo;
    // Only slider rows get the right-hand readout ("90%" / "Hold 70°F"). For
    // on/off devices it just duplicated the pill ("On" twice) and orphan-wrapped
    // onto its own line on phones; the flash count lives on the zap button.
    const showVal = hasSlider && !flash;
    const valText = () => (levels.has(z.id) ? fmtState(z, levels.get(z.id)) : '—');
    const val = showVal && el('span', { class: 'w-24 text-right text-sm font-semibold text-stone-500 shrink-0' }, valText());

    const slider = hasSlider && el('input', {
      class: `flex-1 min-w-24 ${included && isOn ? '' : 'opacity-40'}`, type: 'range',
      // thermostat range in the display unit (HA standard 7–35°C ≈ 45–95°F)
      min: thermo ? (unit === 'C' ? 7 : 45) : 0,
      max: thermo ? (unit === 'C' ? 35 : 95) : 100,
      value: (() => {
        const f = isOn ? level : (lastOn.get(z.id) ?? (thermo ? 70 : 100));
        return thermo ? fToDisplay(f, unit) : f;
      })(),
      disabled: !included || !isOn,
      oninput: (e) => {
        const v = thermo ? displayToF(Number(e.target.value), unit) : Number(e.target.value);
        levels.set(z.id, v);
        if (v > 0) lastOn.set(z.id, v);
        inherited.delete(z.id);
        val.textContent = valText();
      },
      // dragging a dimmable all the way down turns it Off; a thermostat's min is
      // a real hold temp (never 0), so this only ever fires for dimmables
      onchange: (e) => { if (!thermo && Number(e.target.value) === 0) draw(); },
    });

    const toggle = el('button', {
      class: `${isOn ? 'badge-on' : 'badge-off'} !px-3 !py-1.5 shrink-0 ${flash ? 'opacity-50' : ''} ${included ? 'cursor-pointer' : 'opacity-40 pointer-events-none'}`,
      title: flash ? 'Currently set to flash, tap to switch this device to On/Off instead' : (included ? 'Toggle between On and Off for this scene' : ''),
      onclick: () => {
        // in flash mode there's no On/Off state, tapping the pill leaves flash
        // and makes this a normal "On" member (then it toggles On/Off as usual)
        if (flashes.has(z.id)) {
          flashes.delete(z.id);
          levels.set(z.id, lastOn.get(z.id) ?? (thermo ? 70 : 100));
          inherited.delete(z.id);
          draw();
          return;
        }
        if (!levels.has(z.id)) return;
        const cur = levels.get(z.id);
        levels.set(z.id, cur > 0 ? 0 : (lastOn.get(z.id) ?? (thermo ? 70 : 100)));
        inherited.delete(z.id);
        draw();
      },
    }, isOn ? (thermo ? 'Hold' : isShade ? 'Open' : z.kind === 'alarm' ? 'Armed' : z.kind === 'bypass' ? 'Bypassed' : z.kind === 'automation' ? 'Runs' : 'On')
      : (thermo ? 'Resume' : isShade ? 'Closed' : z.kind === 'alarm' ? 'Disarmed' : z.kind === 'bypass' ? 'Active' : 'Off'));

    // light color for a capable light that's on (not flashing): an RGB palette
    // when supported, otherwise a warm↔cool white slider. A compact checkbox
    // (with a live color dot) opts in on the row; the actual palette/slider then
    // drops to its own full-width line below (basis-full), indented under the
    // name — so the wide swatch strip never wraps awkwardly mid-row.
    const ctControl = (z.rgb || z.colorTemp) && included && isOn && !flash && (() => {
      if (z.rgb) {
        const has = rgbs.has(z.id);
        const dot = el('span', {
          class: 'w-3.5 h-3.5 rounded-full ring-1 ring-black/15 dark:ring-white/20 shrink-0',
          style: `background:${has ? rgbToHex(rgbs.get(z.id)) : 'transparent'}`,
        });
        const toggle = el('label', {
          class: 'flex items-center gap-1.5 shrink-0 cursor-pointer text-xs text-stone-500',
          title: 'Set a color for this light',
        },
          el('input', {
            class: 'checkbox !w-4 !h-4', type: 'checkbox', checked: has,
            onchange: (e) => { if (e.target.checked) { rgbs.set(z.id, rgbs.get(z.id) ?? [245, 158, 11]); kelvins.delete(z.id); } else rgbs.delete(z.id); inherited.delete(z.id); draw(); },
          }),
          has ? el('span', { class: 'inline-flex items-center gap-1.5' }, dot, 'Color') : 'color');
        const palette = has ? el('div', { class: 'basis-full flex items-center gap-2 pl-8 pb-1' },
          colorControl(rgbs.get(z.id), (rgb) => { rgbs.set(z.id, rgb); inherited.delete(z.id); dot.style.background = rgbToHex(rgb); })) : null;
        return [toggle, palette];
      }
      const has = kelvins.has(z.id);
      const kLabel = el('span', { class: 'text-xs text-stone-500 tabular-nums' }, has ? `${kelvins.get(z.id)}K` : '');
      const toggle = el('label', {
        class: 'flex items-center gap-1.5 shrink-0 cursor-pointer text-xs text-stone-500',
        title: 'Set a white color temperature (warm ↔ cool) for this light',
      },
        el('input', {
          class: 'checkbox !w-4 !h-4', type: 'checkbox', checked: has,
          onchange: (e) => { if (e.target.checked) kelvins.set(z.id, kelvins.get(z.id) ?? 3000); else kelvins.delete(z.id); inherited.delete(z.id); draw(); },
        }),
        el('span', { class: 'text-amber-500 shrink-0' }, icon('sun', 'w-4 h-4')),
        has ? kLabel : 'white');
      const slider = has ? el('div', { class: 'basis-full flex items-center gap-2 pl-8 pb-1' },
        el('input', {
          class: 'ct-slider w-40', type: 'range', min: z.minKelvin ?? 2200, max: z.maxKelvin ?? 6500, step: 50, value: kelvins.get(z.id),
          oninput: (e) => { kelvins.set(z.id, Number(e.target.value)); inherited.delete(z.id); kLabel.textContent = `${kelvins.get(z.id)}K`; },
        })) : null;
      return [toggle, slider];
    })();

    // flex-wrap: on phones the fixed name + toggle + slider + value can't fit
    // one line inside the modal, the slider (and value) drop to a second line
    return el('div', { class: 'flex flex-wrap items-center gap-3 py-1.5' },
      el('input', {
        class: 'checkbox', type: 'checkbox', checked: included, title: 'Include this device in the scene',
        onchange: (e) => {
          if (e.target.checked) levels.set(z.id, lastOn.get(z.id) ?? (thermo ? 70 : 100));
          else { levels.delete(z.id); flashes.delete(z.id); }
          inherited.delete(z.id);
          seedEnd(); draw();
        },
      }),
      el('span', { class: `w-36 sm:w-44 truncate text-[15px] shrink-0 ${inherited.has(z.id) ? 'text-stone-500 italic' : ''}` },
        z.friendlyName || `${z.area} ${z.name}`, inherited.has(z.id) ? ' *' : ''),
      toggle,
      // reminder-flash member: cycles off -> once -> twice (base scenes, lights only)
      !z.kind && !isChild && el('button', {
        class: `icon-btn ${flash ? '!w-auto !px-1.5 gap-0.5 !text-accent-600 dark:!text-accent-400' : '!w-8'} !h-8 shrink-0 ${included ? '' : 'opacity-40 pointer-events-none'}`,
        title: flash ? `Flashes ${flash >= 2 ? 'twice' : 'once'} when the scene starts, click to change` : 'Make this device flash (reminder) instead of setting a level',
        onclick: () => {
          const cur = flashes.get(z.id) ?? 0;
          if (cur === 0) { flashes.set(z.id, 1); levels.delete(z.id); }
          else if (cur === 1) flashes.set(z.id, 2);
          else { flashes.delete(z.id); levels.set(z.id, lastOn.get(z.id) ?? 100); }
          inherited.delete(z.id);
          draw();
        },
      }, icon('zap', 'w-4 h-4'),
      flash ? el('span', { class: 'text-[11px] font-semibold' }, flash >= 2 ? '×2' : '×1') : null),
      // slider + readout wrap as ONE unit (never an orphaned value on its own
      // line): phones get "checkbox name pill zap" / "slider 90%", desktop
      // fits everything on one line. Rows without a slider just end after the
      // pill/zap, the pill already states On/Off.
      !flash && slider
        ? el('div', { class: 'flex flex-1 items-center gap-3 min-w-56' }, slider, val)
        : el('span', { class: 'flex-1' }),
      ctControl || null);
  };

  const draw = () => {
    // toggling a device rebuilds `rows`, which would reset the modal's scroll
    // to the top, capture the scrolling ancestor and restore it after remount.
    let scroller = rows.parentElement;
    while (scroller && !(/(auto|scroll)/.test(getComputedStyle(scroller).overflowY) && scroller.scrollHeight > scroller.clientHeight)) scroller = scroller.parentElement;
    const savedTop = scroller?.scrollTop ?? 0;
    mount(clear(rows),
      el('h4', { class: 'text-base font-semibold mb-1' }, 'Devices in this scene'),
      inherited.size > 0 && el('p', { class: 'hint -mt-1 mb-1' }, '* inherited from the base scene'),
      byArea().map(([area, list]) => el('div', { class: 'mb-2' },
        el('div', { class: 'text-sm font-semibold uppercase tracking-wide text-stone-400 mt-3 mb-1' }, area),
        list.map(deviceRow))),
      // ── end behavior ──
      // Only stateful devices (levels/presets/hvac) have an end state to
      // customize; a scene of only flash reminders (or no devices) has nothing
      // to restore, so disable the toggle and explain why instead of letting it
      // be checked into an empty panel.
      (() => {
        const canCustomize = memberZones().length > 0;
        const reason = canCustomize ? null
          : (flashes.size > 0
            ? 'Only flash (reminder) devices are in this scene. They hold no state, so there is nothing to restore when it ends.'
            : 'Add devices to the scene first.');
        return el('div', { class: 'mt-5 pt-4 border-t border-stone-200 dark:border-stone-700' },
          el('label', { class: `check-row ${canCustomize ? '' : 'opacity-50 cursor-not-allowed'}` },
            el('input', {
              class: 'checkbox', type: 'checkbox', checked: canCustomize && customEnd, disabled: !canCustomize, 'data-testid': 'custom-end',
              onchange: (e) => { customEnd = e.target.checked; seedEnd(); draw(); },
            }),
            el('span', {}, 'Customize what happens when the scene ends')),
          el('p', { class: 'hint ml-8' }, reason ?? (customEnd ? '' : 'Default: every device is left as it is.')),
          canCustomize && customEnd && el('div', { class: 'space-y-2 mt-2' },
            memberZones().map((zone) => {
            const zc = zones.find((z) => z.id === zone);
            const st = endState.get(zone) ?? { mode: 'skip', level: 0 };
            endState.set(zone, st);
            // Initialize st.level from the field's default so a device left at the
            // shown value still saves it. Previously the default was only visual,
            // so an untouched "Dim to…" saved level 0 and reopened as "Turn off".
            const defaultLevel = zc?.kind === 'thermostat' ? 70 : 30;
            if (st.mode === 'level' && !st.level) st.level = defaultLevel;
            const unit = zc?.kind === 'thermostat' ? `°${tempUnit(zc)}` : '%';
            const lvl = el('input', {
              class: 'input !w-20 !py-2 text-center', type: 'number',
              min: zc?.kind === 'thermostat' ? 50 : 1, max: zc?.kind === 'thermostat' ? 90 : 100,
              value: st.level || defaultLevel,
              oninput: (e) => { st.level = Number(e.target.value); },
            });
            // input + unit ("%" for lights/shades, "°F/°C" for thermostats). Inline
            // style toggles visibility (unambiguous vs. Tailwind display classes).
            const lvlWrap = el('span', { class: 'items-center gap-1.5', style: `display:${st.mode === 'level' ? 'inline-flex' : 'none'}` },
              lvl, el('span', { class: 'text-stone-500 dark:text-stone-400 text-sm' }, unit));
            const modeOptions = endModeOptions(zc);
            return el('div', { class: 'flex items-center gap-2.5' },
              el('span', { class: 'w-36 sm:w-44 truncate text-[15px]' }, zc?.friendlyName || `Device ${zone}`),
              el('select', {
                class: 'select !w-auto !py-2',
                onchange: (e) => {
                  st.mode = e.target.value;
                  if (st.mode === 'level' && !st.level) st.level = Number(lvl.value) || defaultLevel;
                  lvlWrap.style.display = st.mode === 'level' ? 'inline-flex' : 'none';
                },
              }, modeOptions.map(([v, l]) => el('option', { value: v, selected: st.mode === v }, l))),
              lvlWrap);
            })));
      })(),
    );
    if (scroller) requestAnimationFrame(() => { scroller.scrollTop = savedTop; });
  };
  // A stable snapshot of the editable state, so closing only prompts to discard
  // when something actually changed (name, device levels/flashes, or end state).
  const signature = () => JSON.stringify({
    name: name.value,
    levels: [...levels.entries()].sort((a, b) => a[0] - b[0]),
    kelvins: [...kelvins.entries()].filter(([z]) => levels.get(z) > 0).sort((a, b) => a[0] - b[0]),
    rgbs: [...rgbs.entries()].filter(([z]) => levels.get(z) > 0).sort((a, b) => a[0] - b[0]),
    presets: [...presets.entries()].sort((a, b) => a[0] - b[0]),
    hvacs: [...hvacs.entries()].sort((a, b) => a[0] - b[0]),
    flashes: [...flashes.entries()].sort((a, b) => a[0] - b[0]),
    customEnd,
    end: customEnd ? [...endState.entries()].filter(([z]) => memberZones().includes(z)).map(([z, e]) => [z, e.mode, e.level]).sort((a, b) => a[0] - b[0]) : [],
  });
  let pristine = null;
  const isDirty = () => pristine !== null && signature() !== pristine;
  seed().then(() => { seedEnd(); draw(); pristine = signature(); });

  // existing child scene: show what it extends under the title (the "Extend X"
  // and "New scene" titles already say it, so only the edit case needs it)
  const editParentName = existing?.extends ? (scenes.find((p) => p.id === existing.extends)?.name ?? existing.extends) : null;
  modal({
    title: el('div', { class: 'min-w-0' },
      el('span', {}, existing ? `Edit scene “${existing.name ?? existing.id}”` : (parent ? `Extend “${parent.name}”` : 'New scene')),
      editParentName && el('div', { class: 'text-sm font-normal text-stone-500 dark:text-stone-400 mt-0.5' }, `extends ${editParentName}`)),
    wide: true, dismissable: false, confirmClose: isDirty, stickyFooter: true, saveOnCtrlS: true,
    body: el('div', {}, field('Name', name), rows),
    confirmText: 'Save',
    onConfirm: async () => {
      const zonesActive = memberZones();
      let payload;
      // the fields a scene member stores: a preset, an hvac mode, or a level
      // (color temp only rides along when that light is actually on)
      const memberFields = (zone) => {
        if (presets.has(zone)) return { preset: presets.get(zone) };
        if (hvacs.has(zone)) return { hvacMode: hvacs.get(zone) };
        const level = levels.get(zone);
        if (level > 0 && rgbs.has(zone)) return { level, rgb: rgbs.get(zone) };
        return level > 0 && kelvins.has(zone) ? { level, kelvin: kelvins.get(zone) } : { level };
      };
      // canonical shape for detecting a real change vs. the parent scene
      const canon = (m) => JSON.stringify([m.level ?? null, m.preset ?? null, m.hvacMode ?? null, m.kelvin ?? null, m.rgb ?? null]);
      if (isChild) {
        const parentResolved = await api.get(`/api/scenes/${scene.extends}/resolved`);
        const parentMap = new Map(parentResolved.actions.map((a) => [a.zone, a]));
        const overrides = {}; const add = [];
        for (const zone of zonesActive) {
          const m = memberFields(zone);
          if (parentMap.has(zone)) { if (canon(parentMap.get(zone)) !== canon(m)) overrides[zone] = m; }
          else add.push({ zone, ...m });
        }
        const remove = [...parentMap.keys()].filter((z) => !zonesActive.includes(z));
        payload = { ...scene, name: name.value, overrides, add, remove };
      } else {
        payload = { ...scene, name: name.value, actions: [
          ...zonesActive.map((zone) => ({ zone, ...memberFields(zone) })),
          ...[...flashes.entries()].map(([zone, flash]) => ({ zone, flash })),
        ] };
      }
      if (customEnd) {
        payload.endActions = zonesActive
          .filter((zone) => endState.get(zone)?.mode !== 'skip')
          .map((zone) => {
            const st = endState.get(zone);
            // 'on' turns the device fully on; 'level' uses the entered level; 'off' → 0
            const level = st.mode === 'level' ? st.level : st.mode === 'on' ? 100 : 0;
            return { zone, level };
          });
      } else {
        delete payload.endActions;
      }
      try {
        if (existing) await api.put(`/api/scenes/${existing.id}`, payload);
        else await api.post('/api/scenes', payload);
        toast('Scene saved', 'success');
        onSaved();
      } catch (err) { toast(err.message, 'error'); }
    },
  });
}
