import { Router } from 'express';
import { nanoid } from 'nanoid';
import { CalendarService } from '../calendar/CalendarService.js';
import { DAY_TYPES, VARIANTS_BY_DAY_TYPE, CHUL_ONLY_DAY_TYPES } from '../calendar/dayTypes.js';
import { SceneRepository } from '../engine/SceneRepository.js';
import { TimelineCompiler } from '../engine/TimelineCompiler.js';
import { ConflictDetector } from '../engine/ConflictDetector.js';
import { findSceneReferences, sceneDescendants } from '../engine/references.js';
import { yomTovSheet, shabbosYearSheet, FESTIVALS } from '../pdf/zmanimSheet.js';
import { omerSheet } from '../pdf/omerSheet.js';

export function schedulingRouter({ configStore, scheduler, notifier = null }) {
  const router = Router();

  const calendarFor = (cfg) => new CalendarService({
    location: cfg.location, times: cfg.times, locale: cfg.display?.locale,
  });
  // PDFs never use nikud: the with-nikud display locale maps to nikud-free
  const pdfCalendarFor = (cfg) => new CalendarService({
    location: cfg.location, times: cfg.times,
    locale: cfg.display?.locale === 'he' ? 'he-x-NoNikud' : cfg.display?.locale,
  });

  // ── scenes ──────────────────────────────────────────────────────────────
  router.get('/scenes', (_req, res) => res.json(configStore.get().scenes));

  router.post('/scenes', (req, res) => {
    const scene = { id: req.body.id ?? nanoid(8), ...req.body };
    const scenes = [...configStore.get().scenes, scene];
    const errors = new SceneRepository(scenes).validateAll();
    if (errors.length) return res.status(400).json({ error: errors.join('; ') });
    configStore.update({ scenes });
    res.status(201).json(scene);
  });

  router.put('/scenes/:id', (req, res) => {
    const scenes = configStore.get().scenes.map((s) => (s.id === req.params.id ? { ...req.body, id: s.id } : s));
    if (!scenes.some((s) => s.id === req.params.id)) return res.status(404).json({ error: 'scene not found' });
    const errors = new SceneRepository(scenes).validateAll();
    if (errors.length) return res.status(400).json({ error: errors.join('; ') });
    configStore.update({ scenes });
    res.json(scenes.find((s) => s.id === req.params.id));
  });

  /**
   * Delete a scene. Deleting a parent cascades to every extension (they
   * cannot resolve without it). 409 first unless force=true, listing the
   * scenes that will go and the rules that reference any of them.
   */
  router.delete('/scenes/:id', (req, res) => {
    const cfg = configStore.get();
    if (!cfg.scenes.some((s) => s.id === req.params.id)) return res.status(404).json({ error: 'scene not found' });
    const toDelete = sceneDescendants(cfg.scenes, req.params.id);
    const references = findSceneReferences(cfg, toDelete);
    const extensions = toDelete.filter((id) => id !== req.params.id)
      .map((id) => cfg.scenes.find((s) => s.id === id)?.name ?? id);
    if ((extensions.length || references.length) && req.query.force !== 'true') {
      return res.status(409).json({
        error: 'Deleting this scene also removes its extensions, and rules reference it.',
        extensions, references,
      });
    }
    configStore.update({ scenes: cfg.scenes.filter((s) => !toDelete.includes(s.id)) });
    res.json({ ok: true, deleted: toDelete, references });
  });

  /** Reorder the scene cards on the Scenes page. Body: { ids: [sceneId, ...] }.
   *  Rebuilds `scenes` in the given order; any scene omitted from `ids` is kept
   *  and appended (defensive, so nothing is ever dropped). */
  router.post('/scenes/reorder', (req, res) => {
    const ids = req.body?.ids;
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) {
      return res.status(400).json({ error: 'ids must be an array of scene ids' });
    }
    const scenes = configStore.get().scenes;
    const byId = new Map(scenes.map((s) => [s.id, s]));
    const seen = new Set();
    const reordered = ids.map((id) => byId.get(id)).filter((s) => s && !seen.has(s.id) && seen.add(s.id));
    for (const s of scenes) if (!seen.has(s.id)) reordered.push(s);
    configStore.update({ scenes: reordered });
    res.json({ ok: true });
  });

  // scene preview: apply live with a one-time snapshot; exit restores it
  router.post('/scenes/:id/preview', async (req, res) => {
    try {
      res.json(await scheduler.startScenePreview(req.params.id));
    } catch (err) { res.status(409).json({ error: err.message }); }
  });
  router.delete('/scene-preview', async (_req, res) => {
    await scheduler.exitScenePreview({ restore: true });
    res.json({ ok: true });
  });

  router.get('/scenes/:id/resolved', (req, res) => {
    try {
      res.json(new SceneRepository(configStore.get().scenes).resolve(req.params.id));
    } catch (err) {
      res.status(404).json({ error: err.message });
    }
  });

  // ── schedules ───────────────────────────────────────────────────────────
  router.get('/schedules/meta', (_req, res) => {
    const il = configStore.get().location.il;
    const dayTypes = DAY_TYPES.filter((dt) => !il || !CHUL_ONLY_DAY_TYPES.has(dt));
    res.json({ dayTypes, variants: VARIANTS_BY_DAY_TYPE });
  });

  /**
   * Long-horizon "when does each situation next occur". Rare variants (a
   * Shabbos that is Erev Pesach won't recur until 2045) looked broken when
   * the 16-month preview just said "no upcoming occurrence" — this lets the
   * UI say when it actually happens. Scans year-by-year, up to 30 years,
   * stopping early once every (dayType, variant) pair has a date. Cached:
   * the answer only depends on the Hebrew calendar and the IL flag.
   */
  let nextOccCache = null;
  router.get('/schedules/next-occurrences', (_req, res) => {
    const cfg = configStore.get();
    const il = Boolean(cfg.location.il);
    if (nextOccCache?.il === il && Date.now() - nextOccCache.computedAt < 24 * 3600 * 1000) {
      return res.json(nextOccCache.data);
    }
    const cal = calendarFor(cfg);
    const iso = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: cfg.location.tzid });
    const want = new Set();
    for (const [dt, variants] of Object.entries(VARIANTS_BY_DAY_TYPE)) {
      for (const v of variants) if (v !== 'guest') want.add(`${dt}|${v}`);
    }
    const data = {};
    const start = Date.now();
    outer:
    for (let year = 0; year < 30; year++) {
      const from = start + year * 365.25 * 86400000;
      for (const c of cal.clusters(iso(from), iso(from + 366 * 86400000))) {
        for (const d of c.days) {
          const k = `${d.dayType}|${d.variant}`;
          if (want.has(k)) { want.delete(k); data[k] = d.date; }
        }
        if (want.size === 0) break outer;
      }
    }
    nextOccCache = { il, computedAt: Date.now(), data };
    res.json(data);
  });

  router.get('/schedules', (_req, res) => res.json(configStore.get().schedules));

  router.get('/schedules/:dayType/:variant', (req, res) => {
    const { dayType, variant } = req.params;
    res.json(configStore.get().schedules[dayType]?.[variant] ?? { rules: [] });
  });

  router.put('/schedules/:dayType/:variant', (req, res) => {
    const { dayType, variant } = req.params;
    if (!DAY_TYPES.includes(dayType)) return res.status(400).json({ error: `unknown dayType ${dayType}` });
    if (!(VARIANTS_BY_DAY_TYPE[dayType] ?? []).includes(variant)) {
      return res.status(400).json({ error: `variant ${variant} not applicable to ${dayType}` });
    }
    const rules = (req.body?.rules ?? []).map((r) => ({ ...r, id: r.id ?? nanoid(8) }));
    for (const r of rules) {
      if (!r.action?.type) return res.status(400).json({ error: `rule ${r.id} missing action.type` });
      if (!r.trigger?.kind) return res.status(400).json({ error: `rule ${r.id} missing trigger.kind` });
    }
    const schedules = structuredClone(configStore.get().schedules);
    const entry = { rules };
    if (variant !== 'default' && variant !== 'guest') {
      // Always write both flags explicitly. configStore.update() deep-merges, so
      // an OMITTED key keeps its old value — meaning a variant could never be
      // un-inherited or have its removedIds cleared. Writing false/[] forces the
      // merge to overwrite, so "Start empty" (inheritsRegular:false, no removedIds)
      // actually detaches instead of silently reviving the old setup.
      entry.inheritsRegular = Boolean(req.body?.inheritsRegular);
      entry.removedIds = Array.isArray(req.body?.removedIds) ? req.body.removedIds : [];
    }
    schedules[dayType] = { ...(schedules[dayType] ?? {}), [variant]: entry };
    configStore.update({ schedules });
    res.json(schedules[dayType][variant]);
  });

  // ── calendar / timeline previews ────────────────────────────────────────

  // Both previews are PURE functions of (configVersion, query params) — the
  // calendar and compiler are deterministic, and everything they read (rules,
  // guest/away state, location, the away seed) lives in config. Memoize them
  // so the dashboard's 5-second poll doesn't recompute 45 days of Hebcal
  // clusters plus a full timeline compile on every tick — real CPU on a Pi.
  // Small LRU; any config change bumps configVersion and misses the cache.
  const previewMemo = new Map();
  const memoized = (key, compute) => {
    if (previewMemo.has(key)) {
      const v = previewMemo.get(key);
      previewMemo.delete(key); previewMemo.set(key, v); // LRU bump
      return v;
    }
    const value = compute();
    previewMemo.set(key, value);
    if (previewMemo.size > 40) previewMemo.delete(previewMemo.keys().next().value);
    return value;
  };

  router.get('/calendar', (req, res) => {
    const cfg = configStore.get();
    if (!cfg.location.lat) return res.status(400).json({ error: 'location not configured' });
    const from = req.query.from ?? new Date().toISOString().slice(0, 10);
    const to = req.query.to ?? new Date(Date.now() + 400 * 86400_000).toISOString().slice(0, 10);
    res.json(memoized(`cal|${cfg.configVersion}|${from}|${to}`, () => {
      const calendar = calendarFor(cfg);
      return calendar.clusters(from, to);
    }));
  });

  /** Dry-run compile for any date — the safe answer to "test as if it were Pesach 2025". */
  // Shared compile used by both the (memoized, saved-config) GET and the
  // (draft, un-memoized) POST preview. `schedules` lets the POST overlay the
  // editor's UNSAVED working rules so the timeline reflects them before Save.
  const buildTimeline = (cfg, { date, forceGuest, forceGuestOff, forceAway, schedules }) => {
    const calendar = calendarFor(cfg);
    const clusters = calendar.clusters(date, date);
    const compiler = new TimelineCompiler({
      calendar, sceneRepo: new SceneRepository(cfg.scenes), schedules,
      guestMode: forceGuest || (!forceGuestOff && (cfg.guestMode?.enabled ?? false)),
      guestUntil: forceGuest ? null : (cfg.guestMode?.until ? new Date(cfg.guestMode.until).getTime() : null),
      awayMode: forceAway
        ? { ...cfg.awayMode, enabled: true, from: date, to: date }
        : (cfg.awayMode?.enabled ? cfg.awayMode : null),
      zones: cfg.zones,
    });
    const from = Date.parse(`${date}T00:00:00Z`) - 2 * 86400_000;
    const { allActions, report } = compiler.compile(clusters, from, from + 7 * 86400_000);
    const conflicts = new ConflictDetector({ tzid: cfg.location.tzid, zones: cfg.zones }).detect(allActions, clusters);
    // Whether a guest overlay is even possible here: does any day-type in the
    // clusters have guest rules? Drives the "show guest overlay" toggle so it
    // only appears when applicable.
    const guestAvailable = clusters.some((c) => c.days.some((d) => schedules?.[d.dayType]?.guest?.rules?.length > 0));
    return { date, clusters, actions: allActions, report, conflicts, guestAvailable };
  };

  // date + guest/away flags shared by the timeline GET and POST.
  const timelineParams = (src) => ({
    date: src.date ?? new Date().toISOString().slice(0, 10),
    // guest=1 forces a guest-on compile for the schedule editor's preview, so
    // the user sees the effect of guest rules even while guest mode is off in
    // the app (guestUntil=null → guest rules apply to the previewed date).
    forceGuest: src.guest === '1' || src.guest === 'true' || src.guest === true,
    // guest=0 forces guest OFF, so a preview can HIDE the overlay even while
    // guest mode is globally on (the "show/hide guest overlay" toggle).
    forceGuestOff: src.guest === '0' || src.guest === 'false' || src.guest === false,
    forceAway: src.away === '1' || src.away === 'true' || src.away === true,
  });

  router.get('/timeline', (req, res) => {
    const cfg = configStore.get();
    if (!cfg.location.lat) return res.status(400).json({ error: 'location not configured' });
    const p = timelineParams(req.query);
    res.json(memoized(`tl|${cfg.configVersion}|${p.date}|${p.forceGuest}|${p.forceGuestOff}|${p.forceAway}`,
      () => buildTimeline(cfg, { ...p, schedules: cfg.schedules })));
  });

  // Draft preview: overlay the editor's UNSAVED working rules for one
  // day-type/variant onto saved config and compile, WITHOUT persisting. Lets the
  // schedule editor's timeline update live as rules are added/edited/copied,
  // before the user presses Save. Not memoized (drafts change constantly).
  router.post('/timeline/preview', (req, res) => {
    const cfg = configStore.get();
    if (!cfg.location.lat) return res.status(400).json({ error: 'location not configured' });
    const { dayType, variant, rules, inheritsRegular, removedIds } = req.body?.draft ?? {};
    if (!DAY_TYPES.includes(dayType)) return res.status(400).json({ error: `unknown dayType ${dayType}` });
    if (!(VARIANTS_BY_DAY_TYPE[dayType] ?? []).includes(variant)) {
      return res.status(400).json({ error: `variant ${variant} not applicable to ${dayType}` });
    }
    const entry = { rules: Array.isArray(rules) ? rules : [] };
    if (variant !== 'default' && variant !== 'guest') {
      entry.inheritsRegular = Boolean(inheritsRegular);
      entry.removedIds = Array.isArray(removedIds) ? removedIds : [];
    }
    const schedules = { ...cfg.schedules, [dayType]: { ...(cfg.schedules[dayType] ?? {}), [variant]: entry } };
    res.json(buildTimeline(cfg, { ...timelineParams(req.body ?? {}), schedules }));
  });

  /**
   * Toggle guest mode. Enabling computes an expiry ("until") = havdalah of the
   * active-or-next cluster, so guest mode auto-turns-off after that one
   * Shabbos/Yom Tov. Disabling clears it.
   */
  router.post('/guest-mode', (req, res) => {
    const cfg = configStore.get();
    const enabled = Boolean(req.body?.enabled);
    let until = null;
    let cluster = null;
    if (enabled && cfg.location.lat) {
      const cal = calendarFor(cfg);
      const now = Date.now();
      const from = new Date(now - 2 * 86400_000).toISOString().slice(0, 10);
      const to = new Date(now + 400 * 86400_000).toISOString().slice(0, 10);
      cluster = cal.clusters(from, to).find((c) => c.endsAt.getTime() > now);
      until = cluster ? cluster.endsAt.toISOString() : null;
    }
    const wasEnabled = cfg.guestMode?.enabled;
    // guest and away are mutually exclusive
    configStore.update({ guestMode: { enabled, until }, ...(enabled ? { awayMode: { enabled: false, from: null, to: null, label: null } } : {}) });
    scheduler.recompile();
    // notify only on the ON transition (the auto-OFF is notified from the scheduler)
    if (enabled && !wasEnabled) {
      const endsHuman = until
        ? new Date(until).toLocaleString('en-US', { timeZone: cfg.location.tzid, weekday: 'short', hour: 'numeric', minute: '2-digit' })
        : null;
      notifier?.send('guest-mode-on', { label: cluster?.label, endsHuman });
    }
    res.json({ enabled, until, cluster: cluster ? { label: cluster.label, endsAt: cluster.endsAt } : null });
  });

  // ── away mode (presence simulation) ──────────────────────────────────────
  const FEST = {
    'pesach-1': 'Pesach', 'pesach-2': 'Pesach', 'pesach-7': 'Pesach', 'pesach-8': 'Pesach',
    'sukkos-1': 'Sukkos', 'sukkos-2': 'Sukkos', 'shmini-atzeres': 'Sukkos', 'simchas-torah': 'Sukkos',
    'shavuos-1': 'Shavuos', 'shavuos-2': 'Shavuos',
    'rosh-hashanah-1': 'Rosh Hashanah', 'rosh-hashanah-2': 'Rosh Hashanah',
    'yom-kippur': 'Yom Kippur',
  };
  const festOf = (c) => { for (const d of c.days) if (FEST[d.dayType]) return FEST[d.dayType]; return null; };
  const shortDate = (iso) => new Date(`${iso}T12:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

  // Suggested away windows: the next several Shabbosos (rolling — always
  // upcoming), and every whole festival in the coming year (Chol Hamoed is
  // skipped automatically by the transform). Returns { shabbosos, festivals }.
  router.get('/away-presets', (_req, res) => {
    const cfg = configStore.get();
    if (!cfg.location.lat) return res.json({ shabbosos: [], festivals: [] });
    const now = Date.now();
    const today = new Date().toISOString().slice(0, 10);
    const horizon = new Date(now + 380 * 86400_000).toISOString().slice(0, 10);
    const clusters = calendarFor(cfg).clusters(today, horizon).filter((c) => c.endsAt.getTime() > now);

    const shabbosos = clusters
      .filter((c) => c.days.every((d) => d.dayType === 'shabbos'))
      .slice(0, 8)
      .map((c) => ({ label: `Shabbos · ${shortDate(c.days[0].date)}`, from: c.days[0].date, to: c.days.at(-1).date }));

    const festivals = [];
    const grouped = new Set();
    for (let i = 0; i < clusters.length; i++) {
      const fest = festOf(clusters[i]);
      if (!fest || grouped.has(clusters[i])) continue;
      const group = [clusters[i]];
      for (let j = i + 1; j < clusters.length; j++) {
        const gap = (clusters[j].startsAt.getTime() - group[group.length - 1].endsAt.getTime()) / 86400_000;
        if (gap >= 0 && gap < 20 && festOf(clusters[j]) === fest) group.push(clusters[j]);
      }
      group.forEach((g) => grouped.add(g));
      const from = group[0].days[0].date; const to = group[group.length - 1].days.at(-1).date;
      const range = (f, t) => `${shortDate(f)}${t !== f ? `–${shortDate(t)}` : ''}`;
      // Two-part festivals (Pesach I-II … VII-VIII; Sukkos … Shmini/Simchas
      // Torah): offer the whole thing OR just its first/last days.
      if (group.length > 1) {
        const first = group[0]; const last = group[group.length - 1];
        festivals.push({ label: `${fest}: entire · ${range(from, to)}`, from, to });
        festivals.push({ label: `${fest}: first days · ${range(first.days[0].date, first.days.at(-1).date)}`,
          from: first.days[0].date, to: first.days.at(-1).date });
        festivals.push({ label: `${fest}: last days · ${range(last.days[0].date, last.days.at(-1).date)}`,
          from: last.days[0].date, to: last.days.at(-1).date });
      } else {
        festivals.push({ label: `${fest} · ${range(from, to)}`, from, to });
      }
    }
    res.json({ shabbosos, festivals });
  });

  router.post('/away-mode', (req, res) => {
    const cfg = configStore.get();
    const enabled = Boolean(req.body?.enabled);
    if (!enabled) {
      configStore.update({ awayMode: { enabled: false, from: null, to: null, label: null } });
      scheduler.recompile();
      return res.json({ enabled: false });
    }
    const { from, to, label } = req.body ?? {};
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from ?? '') || !/^\d{4}-\d{2}-\d{2}$/.test(to ?? '') || from > to) {
      return res.status(400).json({ error: 'A valid from/to date range is required' });
    }
    // away and guest are mutually exclusive — turning one on turns the other off
    configStore.update({
      guestMode: { enabled: false, until: null },
      awayMode: { ...cfg.awayMode, enabled: true, from, to, label: label ?? null },
    });
    scheduler.recompile();
    notifier?.send('away-mode-on', { label: label ?? null, from: shortDate(from), to: shortDate(to) });
    res.json({ enabled: true, from, to, label: label ?? null });
  });

  router.post('/compile', (_req, res) => {
    scheduler.recompile();
    res.json({ report: scheduler.compiled.report, conflicts: scheduler.compiled.conflicts });
  });

  /** Hebrew date for each civil date in a range (calendar display). */
  router.get('/hebrew-dates', (req, res) => {
    const cfg = configStore.get();
    if (!cfg.location.lat) return res.status(400).json({ error: 'location not configured' });
    const from = req.query.from ?? new Date().toISOString().slice(0, 10);
    const to = req.query.to ?? new Date(Date.now() + 40 * 86400_000).toISOString().slice(0, 10);
    res.json(calendarFor(cfg).hebrewDates(from, to));
  });

  router.get('/zmanim', (req, res) => {
    const cfg = configStore.get();
    if (!cfg.location.lat) return res.status(400).json({ error: 'location not configured' });
    const date = req.query.date ?? new Date().toISOString().slice(0, 10);
    res.json(calendarFor(cfg).zmanim(date));
  });

  // ── printable zmanim PDFs (hebcal-computed) ───────────────────────────────
  const streamPdf = (res, doc, filename, download) => {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename="${filename}"`);
    doc.pipe(res);
  };
  router.get('/pdf/yomtov/:festival', (req, res) => {
    const cfg = configStore.get();
    if (!cfg.location.lat) return res.status(400).json({ error: 'location not configured' });
    const festival = req.params.festival;
    if (!FESTIVALS.includes(festival)) return res.status(404).json({ error: 'unknown festival' });
    const doc = yomTovSheet(pdfCalendarFor(cfg), festival, req.query.from);
    if (!doc) return res.status(404).json({ error: 'no upcoming occurrence found' });
    streamPdf(res, doc, `${festival}-zmanim.pdf`, req.query.download === '1');
  });
  router.get('/pdf/shabbos-year', (req, res) => {
    const cfg = configStore.get();
    if (!cfg.location.lat) return res.status(400).json({ error: 'location not configured' });
    const from = req.query.from || new Date().toISOString().slice(0, 10);
    streamPdf(res, shabbosYearSheet(pdfCalendarFor(cfg), from), `shabbos-times-${from}.pdf`, req.query.download === '1');
  });
  router.get('/pdf/omer', (req, res) => {
    const cfg = configStore.get();
    if (!cfg.location.lat) return res.status(400).json({ error: 'location not configured' });
    const from = req.query.from || new Date().toISOString().slice(0, 10);
    streamPdf(res, omerSheet(pdfCalendarFor(cfg), from), 'sefiras-haomer.pdf', req.query.download === '1');
  });

  return router;
}
