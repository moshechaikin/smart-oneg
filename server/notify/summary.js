import { DateTime } from 'luxon';
import { CalendarService } from '../calendar/CalendarService.js';
import { SceneRepository } from '../engine/SceneRepository.js';
import { TimelineCompiler } from '../engine/TimelineCompiler.js';
import { escapeHtml } from './emailTemplate.js';
import { emailTimeline, emailDayLabels } from './emailTimeline.js';

// Small inline-SVG icons for the HTML email — a clean, non-emoji replacement.
// Apple Mail / iOS Mail / Outlook-Mac / Yahoo / ProtonMail render inline SVG;
// Gmail strips it, so every icon here is paired with a colored box or bold
// label that already carries the meaning, and no icon is load-bearing.
const svgIcon = (inner, color, size = 14) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;">${inner}</svg>`;
const ICON = {
  paperclip: '<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
  user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  home: '<path d="M3 9.5 12 3l9 6.5"/><path d="M5 10v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V10"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
};

/**
 * Build the pre-Yom Tov summary (text + HTML email body) for one cluster:
 * boundaries, each day's variant, and every compiled action in local time.
 */
export function buildClusterSummary(cfg, clusterOrClusters) {
  // may be one cluster or the WHOLE festival occurrence (e.g. Sukkos I-II
  // plus Shmini Atzeres/Simchas Torah), the email covers everything
  const clusters = Array.isArray(clusterOrClusters) ? clusterOrClusters : [clusterOrClusters];
  const cluster = clusters[0];
  const last = clusters[clusters.length - 1];
  const tz = cfg.location.tzid;
  const calendar = new CalendarService({ location: cfg.location, times: cfg.times, locale: cfg.display?.locale });
  const compiler = new TimelineCompiler({
    calendar, sceneRepo: new SceneRepository(cfg.scenes), schedules: cfg.schedules,
    guestMode: cfg.guestMode?.enabled ?? false,
    guestUntil: cfg.guestMode?.until ? new Date(cfg.guestMode.until).getTime() : null,
    awayMode: cfg.awayMode?.enabled ? cfg.awayMode : null,
    zones: cfg.zones,
  });
  const from = cluster.startsAt.getTime() - 24 * 3600_000;
  const to = last.endsAt.getTime() + 12 * 3600_000;
  const { allActions } = compiler.compile(clusters, from, to);

  const zoneName = (id) => cfg.zones.find((z) => z.id === id)?.friendlyName || `Zone ${id}`;
  const fmt = (d) => DateTime.fromJSDate(new Date(d), { zone: tz }).toFormat('EEE MMM d, h:mma');
  const time = (d) => DateTime.fromJSDate(new Date(d), { zone: tz }).toFormat('h:mma');
  // Subject/title date range, matching the app's "date1 (evening) - date2":
  // starts the evening of the erev, ends on the last day (havdalah).
  const dateOnly = (d) => DateTime.fromJSDate(new Date(d), { zone: tz }).toFormat('LLL d');
  const dateRange = `${dateOnly(cluster.startsAt)} (evening) - ${dateOnly(last.endsAt)}`;
  // Per-cluster boundary times. A festival can be several clusters (Sukkos =
  // Sukkos I-II + Shmini/Simchas; Pesach = I-II + VII-VIII), each with its OWN
  // candle lighting → havdalah, and `transitions` carries the 2nd-night candle
  // lighting (lit from an existing flame). Showing every cluster's times avoids
  // the confusing mix of the FIRST candle lighting with the LAST havdalah.
  const multi = clusters.length > 1;
  const clusterTimes = clusters.map((c) => ({
    label: c.label,
    rows: [
      { k: 'Candle lighting', v: fmt(c.startsAt) },
      ...(c.erevSunset ? [{ k: 'Shkia', v: time(c.erevSunset) }] : []),
      ...((c.transitions ?? []).map((tr) => ({ k: tr.label || 'Candle lighting (from existing flame)', v: fmt(tr.at) }))),
      { k: 'Havdalah', v: fmt(c.endsAt) },
    ],
  }));
  // guest mode already changes the compiled timeline above; surface it so the
  // reader knows the schedule below is the guest-overridden one.
  // (NOTE for later: show away mode here the same way once it exists.)
  const guestOn = Boolean(cfg.guestMode?.enabled);
  const awayOn = Boolean(cfg.awayMode?.enabled);

  // The Schedules page groups a festival under one name, so the subject, title
  // and "go to Schedules → …" hint all use the festival (e.g. "Sukkos"), not the
  // day-by-day cluster list.
  const FESTIVAL_LABEL = {
    'pesach-1': 'Pesach', 'pesach-2': 'Pesach', 'pesach-7': 'Pesach', 'pesach-8': 'Pesach',
    'sukkos-1': 'Sukkos', 'sukkos-2': 'Sukkos', 'shmini-atzeres': 'Sukkos', 'simchas-torah': 'Sukkos',
    'shavuos-1': 'Shavuos', 'shavuos-2': 'Shavuos',
    'rosh-hashanah-1': 'Rosh Hashanah', 'rosh-hashanah-2': 'Rosh Hashanah', 'yom-kippur': 'Yom Kippur',
  };
  const navLabel = clusters.flatMap((c) => c.days).map((d) => FESTIVAL_LABEL[d.dayType]).find(Boolean)
    ?? clusters.map((c) => c.label).join('  +  ');

  const lines = [
    navLabel,
    ...clusterTimes.flatMap((ct) => [
      ...(multi ? ['', `${ct.label}:`] : []),
      ...ct.rows.map((r) => `${multi ? '  ' : ''}${r.k}: ${r.v}`),
    ]),
    ...(guestOn ? ['', 'Guest mode is ON, the schedule below reflects your guest overrides (marked “Guest”).'] : []),
    ...(awayOn ? ['', 'Away mode is ON, the times below are the presence-simulated schedule (jittered, with shorter lit periods).'] : []),
    '',
    'Planned light schedule:',
    ...allActions.map((a) => `  ${fmt(a.at)}  ${zoneName(a.zone)} -> ${a.type === 'flash' ? `flash ${a.times >= 2 ? 'twice' : 'once'}` : `${a.level}%`}  (${a.source.label || 'an unnamed rule'}${a.source.guest ? ' · Guest' : ''})`),
    '',
    'See the complete timeline and more information any time in the app → Schedules.',
  ];

  // The full schedule overview, rendered as the same day-grouped timeline the
  // app shows (scenes collapsed, colour chips, a time rail) instead of a flat
  // table — see emailTimeline.js. Not capped: a whole festival's timeline stays
  // well under Gmail's ~102KB clip threshold.
  const timelineHtml = emailTimeline(allActions, {
    zones: cfg.zones, scenes: cfg.scenes, dayLabels: emailDayLabels(clusters, tz), tz,
  });

  // Pesach / Sukkos / Shavuos summaries carry a printable one-page Zmanim PDF;
  // Pesach also carries the Sefiras HaOmer counting chart.
  const PDF_DAYTYPES = new Set(['pesach-1', 'pesach-2', 'pesach-7', 'pesach-8', 'sukkos-1', 'sukkos-2', 'shmini-atzeres', 'simchas-torah', 'shavuos-1', 'shavuos-2', 'rosh-hashanah-1', 'rosh-hashanah-2', 'yom-kippur']);
  const hasPdf = clusters.some((c) => c.days.some((d) => PDF_DAYTYPES.has(d.dayType)));
  const isPesach = clusters.some((c) => c.days.some((d) => d.dayType.startsWith('pesach')));
  const pdfNote = hasPdf
    ? `<div style="margin:0 0 18px;padding:11px 14px;background:#f0f9ff;border:1px solid #bae6fd;border-radius:10px;color:#0369a1;font-size:14px;">${svgIcon(ICON.paperclip, '#0369a1')} A <b>printable one-page Zmanim schedule</b> for this Yom Tov is attached to this email${isPesach ? ', along with a <b>Sefiras HaOmer chart</b>' : ''}.</div>`
    : '';
  const guestNote = guestOn
    ? `<div style="margin:0 0 18px;padding:11px 14px;background:#eff6ff;border:1px solid #bfdbfe;border-radius:10px;color:#1d4ed8;font-size:14px;">${svgIcon(ICON.user, '#1d4ed8')} <b>Guest mode is ON</b>, the schedule below reflects your guest overrides (rows marked <b>Guest</b>).</div>`
    : '';
  const awayNote = awayOn
    ? `<div style="margin:0 0 18px;padding:11px 14px;background:#eef2ff;border:1px solid #c7d2fe;border-radius:10px;color:#4338ca;font-size:14px;">${svgIcon(ICON.home, '#4338ca')} <b>Away mode is ON</b>, the times below are the presence-simulated schedule (jittered, with shorter lit periods so the house looks lived-in).</div>`
    : '';

  // Per-cluster time cards: label · value rows that stack cleanly at any width
  // (no fixed-column month grid to squash on mobile).
  const timesBlock = clusterTimes.map((ct) => {
    const rows = ct.rows.map((r) => `<tr>
        <td style="padding:3px 14px 3px 0;color:#78716c;font-size:14px;vertical-align:top;">${escapeHtml(r.k)}</td>
        <td align="right" style="padding:3px 0;color:#292524;font-weight:700;font-size:14px;white-space:nowrap;vertical-align:top;">${r.v}</td>
      </tr>`).join('');
    return `<div style="margin:0 0 12px;padding:12px 16px;background:#faf9f7;border:1px solid #ece9e5;border-radius:12px;">
      ${multi ? `<div style="font-weight:700;color:#1c1917;font-size:15px;margin-bottom:6px;">${escapeHtml(ct.label)}</div>` : ''}
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;">${rows}</table>
    </div>`;
  }).join('');

  const htmlSummary = `
    ${timesBlock}
    ${pdfNote}
    ${guestNote}
    ${awayNote}
    <p style="margin:16px 0 0;color:#57534e;font-size:15px;">See the complete timeline and more information any time in the app:<br/><b style="white-space:nowrap;">Schedules → ${escapeHtml(navLabel)}</b>.</p>
    <h2 style="margin:26px 0 10px;font-size:16px;color:#1c1917;">Full timeline preview</h2>
    ${timelineHtml}`;

  const textSummary = lines.join('\n')
    + (hasPdf ? `\n\nA printable one-page Zmanim schedule for this Yom Tov is attached to this email${isPesach ? ', along with a Sefiras HaOmer chart' : ''}.` : '');
  return { label: navLabel, dateRange, textSummary, htmlSummary };
}
