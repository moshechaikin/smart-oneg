import { DateTime } from 'luxon';
import { escapeHtml } from './emailTemplate.js';

// Email-safe re-creation of the in-app timeline preview (public/js/components/
// timeline.js). Same shape — grouped by the civil day each action FIRES on, a
// time rail down the left, scenes collapsed into one block listing their device
// rows, warm↔cool / RGB colour chips — but built as table-based HTML with NO
// absolute positioning, inline SVG, or flexbox, so Gmail / Apple Mail / Outlook
// all render it faithfully. Kept deliberately close to the app so the email and
// the on-screen preview read as the same thing.

const STONE = { 500: '#78716c', 600: '#57534e', 700: '#44403c', 400: '#a8a29e', 100: '#f5f5f4', 200: '#e7e5e4', 800: '#292524' };
const ACCENT = '#e0a63c';

// warm→cool dot colour for a kelvin value (matches the app's kelvinColor)
const kelvinColor = (k) => {
  const t = Math.max(0, Math.min(1, (k - 2200) / (6500 - 2200)));
  const warm = [255, 170, 66];
  const cool = [201, 222, 255];
  const c = warm.map((w, i) => Math.round(w + (cool[i] - w) * t));
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
};
const rgbToHex = (rgb) => '#' + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');

// Human state string for a level, aware of device kind — mirrors ui.js fmtState.
function fmtState(zone, level) {
  if (zone?.kind === 'thermostat') {
    const unit = zone.displayUnit === 'C' ? 'C' : 'F';
    const t = unit === 'C' ? Math.round((level - 32) * 5 / 9) : Math.round(level);
    return level > 0 ? `Hold ${t}°${unit}` : 'Resume program';
  }
  if (level === undefined || level === null) return '—';
  if (zone?.kind === 'shade') return level <= 0 ? 'Closed' : (level >= 100 ? 'Open' : `Open · ${Math.round(level)}%`);
  if (zone?.kind === 'alarm') return level > 0 ? 'Armed' : 'Disarmed';
  if (zone?.kind === 'bypass') return level > 0 ? 'Bypassed' : 'Active';
  if (zone?.kind === 'lock') return level > 0 ? 'Locked' : 'Unlocked';
  if (zone?.kind === 'vacuum') return level > 0 ? 'Cleaning' : 'Docked';
  if (zone?.kind === 'automation') return level > 0 ? 'Run' : 'Idle';
  if (level <= 0) return 'Off';
  if (!zone || !zone.dimmable) return 'On';
  return level >= 100 ? 'On · 100%' : `${Math.round(level)}%`;
}

const HVAC_LABEL = { heat: 'Heat', cool: 'Cool', heat_cool: 'Heat / Cool', auto: 'Auto', off: 'Off', dry: 'Dry', fan_only: 'Fan only' };
const modeLabel = (m) => (m ?? '').replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

// a small pill — green when the action leaves the device "on", grey when off
function stateBadge(zone, a) {
  const on = ['flash', 'setAutomation', 'setPreset', 'setHvacMode'].includes(a.type) || a.level > 0;
  const text = a.type === 'flash' ? (a.times >= 2 ? 'flash twice' : 'flash once')
    : a.type === 'setAutomation' ? (a.enabled ? 'Enable' : 'Disable')
      : a.type === 'setPreset' ? modeLabel(a.preset ?? a.mode)
        : a.type === 'setHvacMode' ? (HVAC_LABEL[a.hvacMode] ?? modeLabel(a.hvacMode))
          : fmtState(zone, a.level);
  // terse inline style (repeated once per device row, so kept minimal to hold
  // even a whole festival's timeline under Gmail's ~102KB clip threshold).
  // "on" uses the app's amber badge-on colours (accent-100 / accent-700).
  const s = on ? 'background:#fef3c7;color:#b45309' : 'background:#e7e5e4;color:#57534e';
  return `<span style="${s};border-radius:8px;padding:1px 7px;font-size:12px;font-weight:600;">${escapeHtml(text)}</span>`;
}

// warm↔cool / RGB colour chip shown next to an "on" badge
function colorChip(a) {
  if (a.type !== 'setLevel' || !(a.level > 0)) return '';
  let dot; let label;
  if (a.rgb != null) { dot = rgbToHex(a.rgb); label = rgbToHex(a.rgb); }
  else if (a.kelvin != null) { dot = kelvinColor(a.kelvin); label = `${a.kelvin}K`; }
  else return '';
  return ` <span style="color:#a8a29e;font-size:12px;">`
    + `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${dot};"></span> ${label}</span>`;
}

/**
 * @param {Array}  actions   compiled actions (already sorted)
 * @param {object} opts      { zones, scenes, dayLabels: Map(dateISO→label), tz }
 */
export function emailTimeline(actions, { zones = [], scenes = [], dayLabels = new Map(), tz = 'UTC' } = {}) {
  if (!actions.length) return `<p style="color:${STONE[400]};font-size:14px;margin:0;">No planned actions.</p>`;
  const zoneOf = (id) => zones.find((z) => z.id === id);
  const zoneName = (id) => zoneOf(id)?.friendlyName || `Device ${id}`;
  const sceneName = (id) => scenes.find((s) => s.id === id)?.name ?? id;
  const localISO = (ms) => DateTime.fromMillis(ms, { zone: tz }).toISODate();
  const fmtTime = (ms) => DateTime.fromMillis(ms, { zone: tz }).toFormat('h:mm a');
  const dateFmt = (iso) => DateTime.fromISO(iso, { zone: tz }).toFormat('cccc, LLL d, yyyy');

  // group by fire date
  const byDate = new Map();
  for (const a of actions) {
    const key = localISO(a.at);
    if (!byDate.has(key)) byDate.set(key, []);
    byDate.get(key).push(a);
  }

  // collapse scenes (keyed rule|scene|phase, 60s adjacency reset) then group by time
  const groupsFor = (list) => {
    const entries = [];
    const open = new Map();
    for (const a of list) {
      if (a.source?.sceneId) {
        const key = `${a.source.ruleId}|${a.source.sceneId}|${a.source.scenePhase ?? ''}`;
        let blk = open.get(key);
        if (!blk || a.at - blk.items[blk.items.length - 1].at > 60_000) {
          blk = { scene: a.source.sceneId, phase: a.source.scenePhase, label: a.source.label, at: a.at, items: [] };
          open.set(key, blk);
          entries.push(blk);
        }
        blk.items.push(a);
      } else {
        entries.push({ at: a.at, action: a });
      }
    }
    const byTime = new Map();
    const groups = [];
    for (const e of entries) {
      const key = fmtTime(e.at);
      let g = byTime.get(key);
      if (!g) { g = { at: e.at, scenes: [], actions: [] }; byTime.set(key, g); groups.push(g); }
      if (e.scene) g.scenes.push(e); else g.actions.push(e.action);
    }
    return groups;
  };

  // Base typography lives on the content <td> so each of the (potentially
  // hundreds of) device rows below carries almost no inline style of its own.
  const guestPill = ' <span style="background:#dbeafe;color:#1d4ed8;border-radius:7px;padding:0 6px;font-size:11px;font-weight:600;">Guest</span>';
  const deviceRow = (a) => `<div style="margin:2px 0;">`
    + `${escapeHtml(zoneName(a.zone))} ${stateBadge(zoneOf(a.zone), a)}${colorChip(a)}${a.source?.guest ? guestPill : ''}</div>`;

  const sceneBlock = (entry) => {
    const guest = entry.items.some((x) => x.source?.guest);
    return `<div style="margin:6px 0;border:1px solid #e7e5e4;border-radius:9px;background:#fafaf9;padding:8px 11px;">`
      + `<div style="font-weight:700;color:#292524;margin-bottom:4px;">`
      + `<span style="color:${ACCENT};">◆</span> ${entry.phase === 'sceneEnd' ? 'Scene End' : 'Scene Start'}: ${escapeHtml(sceneName(entry.scene))}`
      + `${entry.label ? ` <span style="font-weight:400;color:#a8a29e;">· ${escapeHtml(entry.label)}</span>` : ''}`
      + `${guest ? guestPill : ''}</div>${entry.items.map(deviceRow).join('')}</div>`;
  };

  // one time-point: the time (with a rail dot) on its own line, then the content
  // full-width below it. Single column — no two-column table whose time column
  // ballooned from long sub-notes (that caused the desktop whitespace) and whose
  // total width forced mobile clients to zoom the whole email out.
  const pointBlock = (g) => {
    const guest = [...g.scenes.flatMap((s) => s.items), ...g.actions].every((a) => a.source?.guest)
      && (g.scenes.length + g.actions.length) > 0;
    const dot = guest ? '#38bdf8' : ACCENT;
    // one shared rule label when everything at this point comes from the same rule
    const labels = new Set(g.actions.map((a) => a.source?.label).filter(Boolean));
    const content = g.scenes.map(sceneBlock).join('')
      + g.actions.map((a) => {
        const note = labels.size !== 1 && a.source?.label ? ` <span style="color:#a8a29e;font-size:12px;">· ${escapeHtml(a.source.label)}</span>` : '';
        return `<div style="margin:2px 0;"><b>${escapeHtml(zoneName(a.zone))}</b> ${stateBadge(zoneOf(a.zone), a)}${colorChip(a)}${note}${a.source?.guest ? guestPill : ''}</div>`;
      }).join('');
    const sharedNote = labels.size === 1 && !g.scenes.length ? [...labels][0] : null;
    return `<div style="margin:0 0 15px;">
      <div style="margin-bottom:5px;line-height:1.3;">
        <span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${dot};margin-right:8px;vertical-align:middle;"></span>
        <span style="font-weight:700;color:#57534e;vertical-align:middle;">${fmtTime(g.at)}</span>
        ${sharedNote ? `<span style="color:#a8a29e;font-size:13px;"> · ${escapeHtml(sharedNote)}</span>` : ''}
      </div>
      <div style="font-size:14px;color:#44403c;line-height:1.5;">${content}</div>
    </div>`;
  };

  const daySection = (iso, list) => `<div style="margin:0 0 12px;">
      <div style="font-size:15px;font-weight:800;color:#292524;padding:12px 0 8px;border-bottom:2px solid #e7e5e4;margin-bottom:12px;">
        <span style="color:${ACCENT};">▸</span> ${escapeHtml(dayLabels.get(iso) ?? dateFmt(iso))}
      </div>
      <div style="border-left:2px solid #ece8e3;padding-left:16px;">${groupsFor(list).map(pointBlock).join('')}</div>
    </div>`;

  return [...byDate.entries()].map(([iso, list]) => daySection(iso, list)).join('');
}

/**
 * dayLabels for the email timeline: the erev (with the night it collides with)
 * plus each assur day, matching the in-app clusterDayLabels.
 */
export function emailDayLabels(clusters, tz) {
  const map = new Map();
  const fmt = (iso) => DateTime.fromISO(iso, { zone: tz }).toFormat('ccc, LLL d, yyyy');
  for (const cluster of clusters) {
    const erevNight = DateTime.fromISO(cluster.erevDate, { zone: tz }).toFormat('cccc') + ' Night';
    map.set(cluster.erevDate, `${cluster.erevLabel ?? 'Erev'} / ${erevNight} · ${fmt(cluster.erevDate)}`);
    for (const d of cluster.days) map.set(d.date, `${d.holidayLabel}${d.parsha ? `, ${d.parsha}` : ''} · ${fmt(d.date)}`);
  }
  return map;
}
