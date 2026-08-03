import { api } from '../api.js';
import { el, clear, mount, modal, levelBadge, fmtDateTime, fmtDateRange, pollWhileMounted, pageHeader, toast, fmtState, todayISO, localISO, variantLabel, select } from '../ui.js';
import { icon } from '../icons.js';
import { timelineView, clusterDayLabels, guestPreviewNote, awayPreviewNote } from '../components/timeline.js';
import { groupKeyForDayType } from './schedules.js';

function countdown(target) {
  const ms = new Date(target) - Date.now();
  if (ms <= 0) return 'now';
  const d = Math.floor(ms / 86400000);
  const h = Math.floor((ms % 86400000) / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return d > 0 ? `in ${d}d ${h}h` : `in ${h}h ${m}m`;
}

export async function dashboardPage() {
  const container = el('div', { class: 'space-y-5' });
  await draw(container, true);
  pollWhileMounted(container, () => draw(container, false), 5000);

  // live device tiles via SSE
  const es = new EventSource('/api/devices/stream');
  es.onmessage = (ev) => {
    const { id, level } = JSON.parse(ev.data);
    const badge = container.querySelector(`[data-tile="${id}"]`);
    if (badge) badge.replaceWith(levelBadgeFor(id, level, draw.zonesCache ?? []));
  };
  new MutationObserver((_, obs) => {
    if (!document.body.contains(container)) { es.close(); obs.disconnect(); }
  }).observe(document.getElementById('app'), { childList: true, subtree: true });

  return container;
}

function levelBadgeFor(id, level, zones) {
  const z = zones.find((zz) => zz.id === id);
  const node = levelBadge(level, z?.dimmable ?? true);
  node.setAttribute('data-tile', id);
  return node;
}

async function draw(container, firstLoad) {
  if (document.querySelector('#modal-root > *')) return; // don't disturb open dialogs
  const [health, clusters, zones, settings, compileRes] = await Promise.all([
    api.get('/api/health'),
    api.get(`/api/calendar?from=${todayISO()}&to=${localISO(new Date(Date.now() + 45 * 86400000))}`).catch(() => []),
    api.get('/api/zones'),
    api.get('/api/settings'),
    firstLoad || !draw.lastCompile ? api.post('/api/compile').catch(() => null) : Promise.resolve(draw.lastCompile),
  ]);
  draw.lastCompile = compileRes;
  draw.zonesCache = zones;
  const now = Date.now();
  const active = clusters.find((c) => new Date(c.startsAt) <= now && now <= new Date(c.endsAt));
  const next = clusters.find((c) => new Date(c.startsAt) > now);
  const featured = active ?? next;
  const conflicts = compileRes?.conflicts ?? [];
  const report = compileRes?.report;
  const warnings = [
    ...conflicts.map((w) => ({ text: w.message, extra: w.suggestion })),
    ...(report?.unconfiguredVariants ?? []).map((v) => ({
      text: `${v.date}: ${v.dayType} needs its "${v.variant}" schedule, the regular one will be used.`, link: '#/schedules',
    })),
    ...(report?.unscheduledDays ?? []).map((v) => ({ text: `${v.date} (${v.dayType}) has no schedule at all.`, link: '#/schedules' })),
  ];

  // Bridge status chip: prefer the server's per-bridge breakdown
  // (health.bridges); fall back to a zone/settings-derived list at the
  // aggregate state for older servers. 'virtual' (manual devices) isn't a
  // bridge. Stable order, Lutron first.
  const BRIDGE_LABEL = { lutron: 'Lutron', hubitat: 'Hubitat', ecobee: 'Ecobee', homeassistant: 'Home Assistant', homebridge: 'Homebridge', matter: 'Matter', envisalink: 'EnvisaLink' };
  const bridgeOrder = Object.keys(BRIDGE_LABEL);
  let bridgeList;
  if (Array.isArray(health.bridges) && health.bridges.length) {
    bridgeList = health.bridges.map((b) => ({ label: BRIDGE_LABEL[b.source] ?? b.source, connected: Boolean(b.connected) }));
  } else {
    const usedSources = new Set(zones.map((z) => z.source ?? 'lutron'));
    bridgeList = bridgeOrder
      .filter((s) => usedSources.has(s) || (s === 'lutron' ? settings.lutron?.enabled !== false : settings[s]?.enabled))
      .map((s) => ({ label: BRIDGE_LABEL[s], connected: Boolean(health.lutronConnected) }));
  }
  bridgeList.sort((a, b) => bridgeOrder.findIndex((s) => BRIDGE_LABEL[s] === a.label) - bridgeOrder.findIndex((s) => BRIDGE_LABEL[s] === b.label));
  const bridgesUp = bridgeList.filter((b) => b.connected).length;
  const bridgesDown = bridgeList.length - bridgesUp;
  const bridgeLabel = bridgeList.length === 1 ? `${bridgeList[0].label} bridge` : (bridgeList.length ? 'Bridges' : 'Bridge');
  // an inactive standby keeps its bridges intentionally disconnected until it
  // takes over, that's "on hold", not a fault
  const standbyIdle = health.failover?.role === 'standby' && !health.failoverActive;
  let bridgeValue; let bridgeTone;
  if (standbyIdle) { bridgeValue = 'Disconnected · On hold'; bridgeTone = 'warn'; }
  else if (bridgeList.length <= 1) { bridgeValue = bridgesUp ? 'Connected' : 'Disconnected'; bridgeTone = bridgesUp ? 'ok' : 'bad'; }
  else if (bridgesDown === 0) { bridgeValue = 'All connected'; bridgeTone = 'ok'; }
  else { bridgeValue = `${bridgesUp} connected · ${bridgesDown} offline`; bridgeTone = 'bad'; }
  const bridgeTip = bridgeList.length ? 'Click for details' : undefined;
  // The Bridges modal is LIVE: it re-polls health while open, so a bridge
  // reconnecting (e.g. right after a takeover) updates the rows in place —
  // the modal must never disagree with the dashboard card behind it.
  const openBridges = bridgeList.length ? () => {
    const body = el('div', {});
    const renderRows = (list, idle) => mount(clear(body),
      el('div', { class: 'space-y-2' },
        ...list.map((b) => el('div', { class: 'flex items-center justify-between gap-4 rounded-xl border border-stone-200 dark:border-stone-700 p-3' },
          el('div', { class: 'flex items-center gap-2.5 min-w-0' },
            el('span', { class: `w-2.5 h-2.5 rounded-full shrink-0 ${b.connected ? 'bg-emerald-500' : idle ? 'bg-amber-500' : 'bg-rose-500'}` }),
            el('span', { class: 'font-medium truncate' }, b.label)),
          el('span', { class: `text-sm font-semibold shrink-0 ${b.connected ? 'text-emerald-600 dark:text-emerald-400' : idle ? 'text-amber-600 dark:text-amber-400' : 'text-rose-600 dark:text-rose-400'}` }, b.connected ? 'Connected' : idle ? 'On hold' : 'Offline'))),
        el('p', { class: 'hint mt-3' }, idle
          ? 'This is the backup instance and it is standing by, so it deliberately keeps its bridges disconnected. The moment the primary goes down, it connects to them and takes over control. Nothing is wrong.'
          : 'An offline bridge is one SmartOneg can’t reach right now, so it can’t control or monitor those devices, scheduled changes and Child Lock for them pause until it’s back. The devices keep working on their own; SmartOneg reconnects automatically and re-applies the correct scheduled state when it does.')));
    renderRows(bridgeList, standbyIdle);
    modal({ title: 'Bridges', body });
    pollWhileMounted(body, async () => {
      const h = await api.get('/api/health').catch(() => null);
      if (!h || !Array.isArray(h.bridges)) return;
      const list = h.bridges.map((b) => ({ label: BRIDGE_LABEL[b.source] ?? b.source, connected: Boolean(b.connected) }));
      list.sort((a, b) => bridgeOrder.findIndex((s) => BRIDGE_LABEL[s] === a.label) - bridgeOrder.findIndex((s) => BRIDGE_LABEL[s] === b.label));
      renderRows(list, (h.failover?.role ?? h.role) === 'standby' && !h.failoverActive);
    }, 4000);
  } : undefined;
  const parsha = featured?.days.find((d) => d.parsha)?.parsha;
  const guestOn = Boolean(settings.guestMode?.enabled);
  // "active" = within a week of the window (or ongoing); further out is only
  // "scheduled" (a banner, not an ON card).
  const awayEnabled = Boolean(settings.awayMode?.enabled);
  const awayActive = Boolean(health.away?.active);
  const awayScheduled = Boolean(health.away?.scheduled);
  const redrawModes = () => { draw.lastCompile = null; draw(container, true); };

  // Away mode: pick a window (upcoming Shabbos / a Yom Tov / custom range) then enable
  const openAwayModal = async () => {
    const { shabbosos = [], festivals = [] } = await api.get('/api/away-presets').catch(() => ({}));
    const cFrom = el('input', { class: 'input', type: 'date', value: todayISO() });
    const cTo = el('input', { class: 'input', type: 'date', value: todayISO() });
    const yt = select([['', 'Choose a Yom Tov…'], ...festivals.map((f, i) => [String(i), f.label])], '',
      (v) => { if (v !== '') { const f = festivals[Number(v)]; enable(f.from, f.to, f.label); } });
    const enable = async (from, to, label) => {
      try {
        await api.post('/api/away-mode', { enabled: true, from, to, label });
        document.getElementById('modal-root').replaceChildren();
        toast(`Away mode set${label ? `, ${label}` : ''}. Your lights will simulate presence during that Shabbos/Yom Tov.`, 'warn', { ms: 9000 });
        window.dispatchEvent(new CustomEvent('smartoneg:optimistic-banner', { detail: { away: { active: from <= new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10), scheduled: from > new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10), label: label ?? null, from, to } } }));
        redrawModes();
      } catch (err) { toast(err.message, 'error'); }
    };
    modal({
      title: 'Away for Shabbos / Yom Tov?',
      body: el('div', { class: 'space-y-4 text-[15px] -mt-2' },
        el('p', { class: 'hint' }, 'Your lights will run a presence-simulated version of your own schedule, jittered times, lights kept on longer in the evening but only briefly during the day, some rooms varying night to night, so the house looks lived-in. It only ever runs during Shabbos/Yom Tov (candle lighting → havdalah), never on Chol Hamoed or weekdays.'),
        shabbosos.length ? el('div', {},
          el('div', { class: 'label' }, 'An upcoming Shabbos'),
          el('div', { class: 'flex flex-wrap gap-2' },
            shabbosos.map((p) => el('button', { class: 'btn-secondary btn-sm', onclick: () => enable(p.from, p.to, p.label) }, p.label)))) : null,
        festivals.length ? el('div', {}, el('div', { class: 'label' }, 'Or a Yom Tov (this year)'), yt) : null,
        el('div', {},
          el('div', { class: 'label' }, 'Or a custom date range'),
          el('div', { class: 'flex items-center gap-2 flex-wrap' },
            cFrom, el('span', { class: 'text-stone-400' }, '→'), cTo,
            el('button', { class: 'btn btn-sm', onclick: () => {
              if (cFrom.value && cTo.value && cFrom.value <= cTo.value) enable(cFrom.value, cTo.value, null);
              else toast('Pick a valid date range', 'warn');
            } }, 'Turn on')))),
      dismissable: true,
    });
  };
  const toggleAway = async () => {
    if (awayEnabled) {
      try {
        await api.post('/api/away-mode', { enabled: false });
        toast('Away mode off, back to your regular schedule.', 'info');
        window.dispatchEvent(new CustomEvent('smartoneg:optimistic-banner', { detail: { away: { active: false } } }));
        redrawModes();
      } catch (err) { toast(err.message, 'error'); }
    } else { openAwayModal(); }
  };

  // upcoming planned actions for the featured cluster
  const upcomingTimeline = featured
    ? await api.get(`/api/timeline?date=${featured.days[0].date}`).catch(() => null) : null;
  const scenes = await api.get('/api/scenes').catch(() => []);

  mount(clear(container),
    pageHeader('Dashboard'),

    // surface schedule warnings up top with a jump link (they live further down)
    warnings.length > 0 && el('button', {
      class: 'w-full sm:w-auto flex items-center gap-2 rounded-xl px-4 py-2.5 text-[14px] font-medium transition-colors '
        + 'bg-accent-50 dark:bg-accent-500/10 text-accent-800 dark:text-accent-200 ring-1 ring-accent-200 dark:ring-accent-500/30 '
        + 'hover:bg-accent-100 dark:hover:bg-accent-500/15',
      onclick: () => document.getElementById('schedule-warnings')?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
    }, icon('alert', 'w-4 h-4 shrink-0'),
      el('span', {}, `${warnings.length} schedule warning${warnings.length === 1 ? '' : 's'}, click to review`),
      icon('chevronDown', 'w-4 h-4 ml-auto sm:ml-1 shrink-0')),

    // status chips
    // stagger only on the first render, the 5s poll re-renders and would
    // otherwise replay the animation every time
    el('div', { class: `${firstLoad ? 'stagger ' : ''}grid grid-cols-1 min-[400px]:grid-cols-2 lg:grid-cols-4 gap-3` },
      statusCard('bulb', bridgeLabel, bridgeValue, bridgeTone, bridgeTip, openBridges),
      statusCard('server', 'Instance', health.role === 'primary' ? 'Primary' : (health.failoverActive ? 'Standby · ACTIVE' : 'Standby · Inactive'),
        health.role === 'primary' || !health.failoverActive ? 'ok' : 'warn'),
      statusCard('kiddush', 'Shabbos / Yom Tov', active ? 'In progress' : 'Not active', active ? 'warn' : 'ok'),
      statusCard('lock', 'Child Lock', settings.enforcement.enabled && zones.some((z) => z.enforce)
        ? 'Watching switches' : 'Off', 'ok', 'Reverses manual switch presses during Shabbos/Yom Tov so children can\u2019t change the lights')),

    // guest + away modes, side by side (2-col desktop, stacked on mobile)
    el('div', { class: 'grid sm:grid-cols-2 gap-3' },
      // ── guest mode ──
      el('div', { class: `card !py-4 flex flex-col gap-2 ${guestOn ? 'ring-2 ring-sky-400' : ''}` },
        el('div', { class: 'flex items-center gap-2.5' },
          el('span', { class: guestOn ? 'text-sky-600' : 'text-stone-400' }, icon('users', 'w-6 h-6')),
          el('div', { class: 'font-semibold text-[16px]' }, `Guest mode ${guestOn ? 'is ON' : 'is off'}`)),
        el('div', { class: 'hint flex-1' }, guestOn
          ? 'Guest rules override the regular schedule for the devices they name. Turns off automatically after this Shabbos/Yom Tov.'
          : 'Override the regular schedule for specific devices, just for the next Shabbos/Yom Tov.'),
        el('button', {
          class: `${guestOn ? 'btn' : 'btn-secondary'} btn-sm w-full sm:w-auto sm:self-start`,
          onclick: async () => {
            try {
              const res = await api.post('/api/guest-mode', { enabled: !guestOn });
              toast(!guestOn
                ? (res.cluster
                  ? `Guest mode ON for ${res.cluster.label}, turns off automatically after havdalah (${fmtDateTime(res.cluster.endsAt)}).`
                  : 'Guest mode ON, guest rules override the regular schedule for the devices they name.')
                : 'Guest mode off, back to the regular schedules for everything.',
              !guestOn ? 'warn' : 'info', { ms: 9000 });
              redrawModes();
            } catch (err) { toast(err.message, 'error'); }
          },
        }, guestOn ? 'Turn off' : 'Turn on')),
      // ── away mode (ON when active/ongoing; only "scheduled" when >7 days out) ──
      el('div', { class: `card !py-4 flex flex-col gap-2 ${awayActive ? 'ring-2 ring-indigo-400' : ''}` },
        el('div', { class: 'flex items-center gap-2.5' },
          el('span', { class: awayActive || awayScheduled ? 'text-indigo-500' : 'text-stone-400' }, icon('plane', 'w-6 h-6')),
          el('div', { class: 'font-semibold text-[16px]' }, `Away mode ${awayActive ? 'is ON' : awayScheduled ? 'is scheduled' : 'is off'}`)),
        // when on/scheduled, spell out the exact window so it's never a mystery
        (awayActive || awayScheduled) && settings.awayMode?.from && el('div', {
          class: 'flex items-center gap-1.5 text-[13px] font-semibold text-indigo-600 dark:text-indigo-300',
        }, icon('calendar', 'w-4 h-4 shrink-0'),
          // preset labels already embed the date (e.g. "Shabbos · Oct 10"); only
          // fall back to the raw range for a custom window, so it never doubles up
          settings.awayMode.label || fmtDateRange(settings.awayMode.from, settings.awayMode.to)),
        el('div', { class: 'hint flex-1' }, awayActive
          ? 'Simulating presence, evenings kept lit longer, brief during the day. Turns off automatically after the window.'
          : awayScheduled
            ? 'Scheduled, it kicks in automatically as the window nears.'
            : 'Away for Shabbos/Yom Tov? Make your lights look lived-in (a randomized version of your own schedule).'),
        el('button', {
          class: `${awayEnabled ? 'btn' : 'btn-secondary'} btn-sm w-full sm:w-auto sm:self-start`,
          onclick: toggleAway,
        }, awayEnabled ? 'Turn off' : 'Set up')),
    ),

    // featured cluster — its title + a View button open this holiday's schedule
    // overview (the page with its mini calendar)
    featured && (() => {
      const groupKey = featured.days.map((d) => groupKeyForDayType(d.dayType)).find(Boolean);
      const openSchedule = groupKey ? () => { sessionStorage.setItem('schedules-open-group', groupKey); location.hash = '#/schedules'; } : null;
      return el('div', { class: `card ${active ? 'ring-2 ring-accent-400 dark:ring-accent-500' : ''}` },
        el('div', { class: 'flex items-start justify-between gap-3 flex-wrap' },
          el('div', {},
            el('div', { class: 'flex items-center gap-2 text-sm font-medium text-accent-700 dark:text-accent-400 mb-1' },
              icon(active ? 'kiddush' : 'candle', 'w-4 h-4'),
              active ? 'Now observing' : `Next up ${countdown(featured.startsAt)} · ${featured.erevLabel ?? ''}`),
            el('h2', {
              class: `text-xl sm:text-2xl font-semibold tracking-tight ${openSchedule ? 'cursor-pointer hover:text-accent-700 dark:hover:text-accent-400 transition-colors' : ''}`,
              ...(openSchedule ? { onclick: openSchedule, title: `View the ${featured.label} schedule` } : {}),
            }, featured.label, parsha ? el('span', { class: 'font-normal text-stone-500 dark:text-stone-400' }, `, ${parsha}`) : '')),
          openSchedule
            ? el('button', { class: 'btn-secondary btn-sm shrink-0', onclick: openSchedule, title: `View the ${featured.label} schedule` }, icon('eye', 'w-4 h-4'), 'View')
            : el('a', { href: '#/calendar', class: 'btn-secondary btn-sm' }, 'Calendar')),
      el('div', { class: 'mt-4 grid sm:grid-cols-2 xl:grid-cols-3 gap-x-6 gap-y-1.5 text-[15px]' },
        el('div', { class: 'flex items-center gap-2' }, icon('candle', 'w-4 h-4 text-accent-500'),
          el('span', { class: 'text-stone-500 dark:text-stone-400' }, 'Candle Lighting'), el('b', {}, fmtDateTime(featured.startsAt))),
        featured.erevSunset && el('div', { class: 'flex items-center gap-2' }, icon('sunset', 'w-4 h-4 text-accent-500'),
          el('span', { class: 'text-stone-500 dark:text-stone-400' }, 'Shkia (sunset)'), el('b', {}, fmtDateTime(featured.erevSunset))),
        el('div', { class: 'flex items-center gap-2' }, icon('kiddush', 'w-4 h-4 text-accent-500'),
          el('span', { class: 'text-stone-500 dark:text-stone-400' }, 'Havdalah'), el('b', {}, fmtDateTime(featured.endsAt)))),
      el('div', { class: 'mt-3 flex flex-wrap gap-2' },
        featured.days.map((d) => el('span', { class: 'badge-info' },
          `${new Date(`${d.date}T12:00`).toLocaleDateString(undefined, { weekday: 'short' })} · ${d.holidayLabel}${d.variant !== 'default' ? ` (${variantLabel(d.variant)})` : ''}`))));
    })(),

    // planned schedule for the featured cluster
    featured && upcomingTimeline && el('div', { class: 'card' },
      el('div', { class: 'section-title !mb-4' }, icon('clock'), `Planned for ${featured.label}`),
      awayActive && awayPreviewNote(),
      guestOn && upcomingTimeline.actions.some((a) => a.source?.guest) && guestPreviewNote(),
      timelineView(upcomingTimeline.actions, { zones, scenes, dayLabels: clusterDayLabels(featured), stickyHeaders: 'sticky-below-header z-10' })),

    // warnings
    warnings.length > 0 && el('div', { id: 'schedule-warnings', class: 'card border-accent-300 dark:border-accent-600/50 scroll-mt-24' },
      el('div', { class: 'section-title text-accent-700 dark:text-accent-400 !mb-3' }, icon('alert'), 'Schedule warnings'),
      el('ul', { class: 'space-y-2 text-[15px]' },
        warnings.map((w) => el('li', { class: 'flex gap-2' },
          el('span', { class: 'text-accent-500 mt-0.5' }, '•'),
          el('span', {}, w.text, ' ',
            w.extra && el('span', { class: 'text-stone-500' }, w.extra),
            w.link && el('a', { href: w.link, class: 'text-accent-600 dark:text-accent-400 underline ml-1' }, 'Fix')))))),
  );
}

function statusCard(ic, label, value, tone, title, onClick) {
  const tones = {
    ok: 'text-emerald-600 dark:text-emerald-400',
    warn: 'text-accent-600 dark:text-accent-400',
    bad: 'text-rose-600 dark:text-rose-400',
  };
  // h-full + wrapping value: long values ("Watching switches") wrap instead of
  // truncating on phones, and every card in the row stretches to equal height
  return el('div', {
    class: `card !p-4 h-full flex items-center gap-3${onClick ? ' cursor-pointer transition hover:-translate-y-0.5 hover:shadow-md hover:border-accent-300 dark:hover:border-accent-600/60' : ''}`,
    ...(title ? { title } : {}),
    ...(onClick ? { onclick: onClick, role: 'button', tabindex: '0',
      onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } } } : {}),
  },
    el('span', { class: 'text-stone-400 dark:text-stone-500 shrink-0' }, icon(ic, 'w-6 h-6')),
    el('div', { class: 'min-w-0' },
      el('div', { class: 'text-[13px] text-stone-500 dark:text-stone-400' }, label),
      el('div', { class: `font-semibold text-[15px] break-words ${tones[tone]}` }, value)));
}
