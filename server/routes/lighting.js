import { Router } from 'express';
import { parseIntegrationReport } from '../lutron/protocol.js';
import { findZoneReferences } from '../engine/references.js';
import { blinkLevels } from '../devices/DeviceBus.js';
import { driveZone } from '../engine/driveZone.js';

export function lightingRouter({ configStore, stateStore, scheduler, tracker, enforcement, lutron, logger }) {
  const router = Router();
  // Manual zone writes must serialize on the SAME per-zone lock as the
  // scheduler/enforcement writers (scheduler.zoneLock is the shared instance
  // wired in index.js) — otherwise a manual command races an in-flight
  // reconcile/fired-action/correction for the same zone and whichever write
  // settles LAST wins, even if stale. Falls back to running unlocked only if
  // a test stubs the scheduler without a lock.
  const locked = (zone, fn) => (scheduler?.zoneLock ? scheduler.zoneLock.run(zone, fn) : fn());

  router.get('/zones', (_req, res) => {
    const zones = configStore.get().zones.map((z) => {
      const mode = (z.kind === 'thermostat' || z.kind === 'vacuum' || z.colorTemp || z.rgb) ? (lutron.getMode?.(z.id) ?? {}) : {};
      return {
        ...z,
        expectedLevel: tracker.expected(z.id),
        reportedLevel: tracker.reported(z.id),
        latch: stateStore.zone(z.id).latch,
        ...(z.kind === 'thermostat' ? { reportedPreset: mode.preset ?? null, reportedHvacMode: mode.hvacMode ?? null } : {}),
        ...(z.kind === 'vacuum' ? { reportedControllable: mode.controllable ?? null } : {}),
        ...(z.colorTemp ? { reportedKelvin: mode.kelvin ?? null } : {}),
        ...(z.rgb ? { reportedRgb: mode.rgbColor ?? null } : {}),
      };
    });
    res.json(zones);
  });

  /** Set a thermostat's preset (Home/Away/…) or hvac mode (heat/cool/off) from
   *  the device row. Persistent modes, not levels, so they bypass the tracker. */
  router.post('/zones/:id/mode', async (req, res) => {
    const id = Number(req.params.id);
    const zone = configStore.get().zones.find((z) => z.id === id);
    if (!zone) return res.status(404).json({ error: 'zone not found' });
    const { preset, hvacMode } = req.body ?? {};
    try {
      if (preset != null) await lutron.setPreset?.(id, preset);
      if (hvacMode != null) await lutron.setHvacMode?.(id, hvacMode);
      res.json({ ok: true });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  /** Set a light's white color temperature (Kelvin) from the device row. */
  router.post('/zones/:id/color-temp', async (req, res) => {
    const id = Number(req.params.id);
    const kelvin = Number(req.body?.kelvin);
    if (!configStore.get().zones.some((z) => z.id === id)) return res.status(404).json({ error: 'zone not found' });
    if (!Number.isFinite(kelvin)) return res.status(400).json({ error: 'kelvin required' });
    try {
      await lutron.setColorTemp?.(id, kelvin);
      res.json({ ok: true });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  /** Set a light's RGB color ([r,g,b], 0–255) from the device row. */
  router.post('/zones/:id/color', async (req, res) => {
    const id = Number(req.params.id);
    const rgb = req.body?.rgb;
    if (!configStore.get().zones.some((z) => z.id === id)) return res.status(404).json({ error: 'zone not found' });
    if (!Array.isArray(rgb) || rgb.length !== 3 || !rgb.every((v) => Number.isFinite(v))) return res.status(400).json({ error: 'rgb [r,g,b] required' });
    try {
      await lutron.setColor?.(id, rgb);
      res.json({ ok: true });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  router.patch('/zones/:id', (req, res) => {
    const id = Number(req.params.id);
    const zones = configStore.get().zones.map((z) => {
      if (z.id !== id) return z;
      const next = {
        ...z,
        friendlyName: req.body.friendlyName ?? z.friendlyName,
        enforce: req.body.enforce ?? z.enforce,
        dimmable: req.body.dimmable ?? z.dimmable,
        area: req.body.area ?? z.area,
      };
      // device type + thermostat display unit (null clears back to a plain light / °F)
      if ('kind' in req.body) { if (req.body.kind) next.kind = req.body.kind; else delete next.kind; }
      if ('displayUnit' in req.body) { if (req.body.displayUnit === 'C') next.displayUnit = 'C'; else delete next.displayUnit; }
      return next;
    });
    if (!zones.some((z) => z.id === id)) return res.status(404).json({ error: 'zone not found' });
    configStore.update({ zones });
    res.json(zones.find((z) => z.id === id));
  });

  /** Rename a room: updates the area on every device currently in it. */
  router.post('/rooms/rename', (req, res) => {
    const { from, to } = req.body ?? {};
    if (!from || !to?.trim()) return res.status(400).json({ error: 'from and to required' });
    const zones = configStore.get().zones.map((z) => (z.area === from ? { ...z, area: to.trim() } : z));
    const count = zones.filter((z) => z.area === to.trim()).length;
    configStore.update({ zones });
    res.json({ ok: true, renamed: count });
  });

  /** Reorder rooms on the Devices page. Body: { order: [roomName, ...] }. */
  router.post('/rooms/reorder', (req, res) => {
    const order = req.body?.order;
    if (!Array.isArray(order) || order.some((n) => typeof n !== 'string')) {
      return res.status(400).json({ error: 'order must be an array of room names' });
    }
    configStore.update({ roomOrder: order });
    res.json({ ok: true });
  });

  /**
   * Reorder the devices within one room. Body: { ids: [zoneId, ...] } — the new
   * order of that room's zones. Rebuilds `zones` so those ids appear in the
   * given order, in place (the room's block stays where it was; other zones and
   * their order are untouched).
   */
  router.post('/zones/reorder', (req, res) => {
    const ids = req.body?.ids;
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'number')) {
      return res.status(400).json({ error: 'ids must be an array of zone ids' });
    }
    const zones = configStore.get().zones;
    const idSet = new Set(ids);
    const byId = new Map(zones.map((z) => [z.id, z]));
    const reordered = ids.map((id) => byId.get(id)).filter(Boolean);
    let inserted = false;
    const next = [];
    for (const z of zones) {
      if (idSet.has(z.id)) {
        if (!inserted) { next.push(...reordered); inserted = true; } // drop the block in at the first member's slot
      } else {
        next.push(z);
      }
    }
    configStore.update({ zones: next });
    res.json({ ok: true });
  });

  /** Add a manual (virtual) device — no hub required. */
  router.post('/zones/manual', (req, res) => {
    const { name, area = 'Manual', dimmable = false, source = 'virtual', externalId, kind, enforce = false } = req.body ?? {};
    if (!name?.trim()) return res.status(400).json({ error: 'name required' });
    const existing = configStore.get().zones;
    const id = Math.max(99, ...existing.map((z) => z.id)) + 1;
    const zone = {
      id, source, externalId: externalId ?? id,
      name: name.trim(), area, friendlyName: name.trim(),
      dimmable: Boolean(dimmable), enforce: Boolean(enforce),
      ...(kind ? { kind } : {}),
    };
    configStore.update({ zones: [...existing, zone] });
    res.status(201).json(zone);
  });

  /** Remove a device. 409 with the referencing rules/scenes unless force. */
  router.delete('/zones/:id', (req, res) => {
    const id = Number(req.params.id);
    const cfg = configStore.get();
    if (!cfg.zones.some((z) => z.id === id)) return res.status(404).json({ error: 'zone not found' });
    const references = findZoneReferences(cfg, [id]);
    // deleting is ALWAYS two-step: the client shows a confirmation with the
    // consequences, then retries with force=true
    if (req.query.force !== 'true') {
      return res.status(409).json({ error: 'confirmation required', references });
    }
    // cascade: rules targeting ONLY this device are removed; multi-device
    // rules just lose it; scenes drop it from every member list
    const schedules = structuredClone(cfg.schedules);
    let rulesRemoved = 0; let rulesUpdated = 0;
    for (const variants of Object.values(schedules)) {
      for (const sched of Object.values(variants ?? {})) {
        if (!sched?.rules) continue;
        sched.rules = sched.rules.filter((r) => {
          const a = r.action ?? {};
          if (a.type === 'sceneStart' || a.type === 'sceneEnd') return true;
          const targets = a.zones?.length ? a.zones : [a.zone];
          if (!targets.includes(id)) return true;
          const remaining = targets.filter((z) => z !== id);
          if (remaining.length === 0) { rulesRemoved++; return false; }
          a.zones = remaining;
          a.zone = remaining[0];
          rulesUpdated++;
          return true;
        });
      }
    }
    let scenesUpdated = 0;
    const scenes = structuredClone(cfg.scenes).map((sc) => {
      let touched = false;
      for (const k of ['actions', 'add', 'endActions']) {
        if (sc[k]?.some((a) => a.zone === id)) { sc[k] = sc[k].filter((a) => a.zone !== id); touched = true; }
      }
      if (sc.overrides?.[id]) { delete sc.overrides[id]; touched = true; }
      if (sc.remove?.includes(id)) { sc.remove = sc.remove.filter((z) => z !== id); touched = true; }
      if (touched) scenesUpdated++;
      return sc;
    });
    configStore.update({ zones: cfg.zones.filter((z) => z.id !== id), schedules, scenes });
    logger?.warn({ zone: id, rulesRemoved, rulesUpdated, scenesUpdated }, 'device removed with cascade cleanup');
    res.json({ ok: true, rulesRemoved, rulesUpdated, scenesUpdated });
  });

  /**
   * Dry-run comparison of a fresh Lutron integration report against the
   * current config, so re-imports never silently orphan rules. Returns
   * added / removed (with everything referencing them) / renamed / unchanged.
   */
  router.post('/zones/lutron/diff', (req, res) => {
    let incoming;
    try {
      incoming = parseIntegrationReport(req.body);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    const cfg = configStore.get();
    const current = cfg.zones.filter((z) => (z.source ?? 'lutron') === 'lutron');
    const incomingById = new Map(incoming.map((z) => [z.id, z]));
    const currentById = new Map(current.map((z) => [z.externalId ?? z.id, z]));

    const added = incoming.filter((z) => !currentById.has(z.id));
    const removedZones = current.filter((z) => !incomingById.has(z.externalId ?? z.id));
    const renamed = incoming
      .filter((z) => currentById.has(z.id))
      .map((z) => ({ incoming: z, existing: currentById.get(z.id) }))
      .filter(({ incoming: inc, existing }) => inc.name !== existing.name || inc.area !== existing.area)
      .map(({ incoming: inc, existing }) => ({
        id: inc.id,
        from: { name: existing.name, area: existing.area, friendlyName: existing.friendlyName },
        to: { name: inc.name, area: inc.area },
      }));
    const removed = removedZones.map((z) => ({
      ...z,
      references: findZoneReferences(cfg, [z.id]),
    }));

    res.json({
      added,
      removed,
      renamed,
      unchangedCount: incoming.length - added.length - renamed.length,
      safe: removed.length === 0,
    });
  });

  /**
   * Ingest a Lutron integration report. The report owns only the Lutron facts
   * (zone id, name, area); everything the user curates — friendlyName,
   * dimmable, enforce (Child Lock), kind, etc. — is preserved on re-import.
   * A renumbered zone (same name+area, new id, unambiguous both ways) is
   * remapped in place, including every rule/scene that referenced the old id.
   * Non-Lutron devices (EnvisaLink, Matter, manual) are never in the report
   * and must survive untouched.
   */
  router.post('/zones/import', (req, res) => {
    try {
      const incoming = parseIntegrationReport(req.body);
      const cfg = configStore.get();
      const isLutron = (z) => (z.source ?? 'lutron') === 'lutron';
      const lutronZones = cfg.zones.filter(isLutron);
      const prevById = new Map(lutronZones.map((z) => [z.id, z]));
      const incomingIds = new Set(incoming.map((z) => z.id));

      // Renumber detection: an unmatched incoming zone whose name+area equals
      // exactly one existing Lutron zone that the report no longer lists.
      const orphans = lutronZones.filter((z) => !incomingIds.has(z.id));
      const remapped = new Map(); // oldId -> newId
      const remapFor = (inc) => {
        const hits = orphans.filter((o) => o.name === inc.name && o.area === inc.area && !remapped.has(o.id));
        const twins = incoming.filter((i) => i.name === inc.name && i.area === inc.area && !prevById.has(i.id));
        return hits.length === 1 && twins.length === 1 ? hits[0] : null;
      };

      const zones = incoming.map((z) => {
        const prev = prevById.get(z.id) ?? remapFor(z);
        if (!prev) return z; // genuinely new device
        if (prev.id !== z.id) remapped.set(prev.id, z.id);
        return { ...prev, id: z.id, name: z.name, area: z.area };
      });
      zones.push(...cfg.zones.filter((z) => !isLutron(z)));

      const patch = { zones };
      if (remapped.size) {
        // carry every rule/scene reference over to the new zone number
        const renumber = (id) => remapped.get(id) ?? id;
        const schedules = structuredClone(cfg.schedules ?? {});
        for (const variants of Object.values(schedules)) {
          for (const sched of Object.values(variants ?? {})) {
            for (const rule of sched?.rules ?? []) {
              if (rule.action?.zone !== undefined) rule.action.zone = renumber(rule.action.zone);
              if (rule.action?.zones?.length) rule.action.zones = rule.action.zones.map(renumber);
            }
          }
        }
        const scenes = structuredClone(cfg.scenes ?? []).map((scene) => {
          for (const list of [scene.actions, scene.add, scene.endActions]) {
            for (const a of list ?? []) a.zone = renumber(a.zone);
          }
          if (scene.overrides) {
            scene.overrides = Object.fromEntries(
              Object.entries(scene.overrides).map(([k, v]) => [renumber(Number(k)), v]),
            );
          }
          return scene;
        });
        patch.schedules = schedules;
        patch.scenes = scenes;
        logger?.warn({ remapped: [...remapped.entries()] }, 'lutron re-import: renumbered zones remapped in rules/scenes');
      }

      configStore.update(patch);
      res.json(zones);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  /**
   * Manual control. During an active Shabbos/YT cluster this is exactly the
   * kind of change the app exists to prevent, so require an explicit
   * confirm flag and log loudly.
   */
  router.post('/zones/:id/command', async (req, res) => {
    const id = Number(req.params.id);
    let { level } = req.body ?? {};
    const { fadeSec = 0, confirm = false } = req.body ?? {};
    const zoneCfg = configStore.get().zones.find((z) => z.id === id);
    if (!zoneCfg) return res.status(404).json({ error: 'zone not found' });
    if (typeof level !== 'number' || level < 0 || level > 100) return res.status(400).json({ error: 'level must be 0-100' });
    // switches only know on/off; a thermostat's level is a temperature, never snap it
    if (!zoneCfg.dimmable && zoneCfg.kind !== 'thermostat') level = level > 0 ? 100 : 0;
    const active = scheduler.activeCluster();
    if (active && !confirm) {
      return res.status(409).json({
        error: 'Shabbos/Yom Tov is currently active. Pass confirm:true to override.',
        activeCluster: { id: active.id, label: active.label, endsAt: active.endsAt },
      });
    }
    try {
      // verify-before-fail (attempts: 2) so a slow/no-op echo doesn't toast a
      // false error, without the schedule paths' full retry patience
      await locked(id, () => driveZone({ lutron, tracker }, id, level, { fadeSec, attempts: 2 }));
      logger?.warn({ zone: id, to: level, manual: true, duringCluster: Boolean(active) }, 'manual zone command');
      res.json({ ok: true });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  router.post('/zones/:id/flash', async (req, res) => {
    const id = Number(req.params.id);
    const times = Math.min(5, Math.max(1, Number(req.body?.times ?? 1)));
    // Flashing is a reminder blink — only meaningful for lights/dimmers, not
    // plugs, fans, fridges, shades, or thermostats.
    const zone = configStore.get().zones.find((z) => z.id === id);
    if (zone?.kind) return res.status(400).json({ error: 'Flashing is only supported for lights' });
    try {
      await locked(id, async () => {
        // Restore the actual pre-flash state (reported), not the app's expected
        // level — outside a cluster expected is stale (e.g. wall-switched ON).
        // Read it INSIDE the lock turn: a queued same-zone write that ran just
        // before us may have changed the level we must restore to.
        const raw = tracker.reported(id) ?? tracker.expected(id) ?? 0;
        const restore = lutron.coerceLevel?.(id, raw) ?? raw;
        for (const level of blinkLevels(restore, times)) tracker.expectCommand(id, level);
        await lutron.flash(id, times, restore);
      });
      res.json({ ok: true });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  /** Live device state stream (SSE): every ~OUTPUT/level event as it happens. */
  router.get('/devices/stream', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('retry: 3000\n\n');
    const onLevel = (e) => res.write(`data: ${JSON.stringify(e)}\n\n`);
    const onMode = (e) => res.write(`data: ${JSON.stringify({ ...e, mode: true })}\n\n`);
    lutron.on('zoneLevel', onLevel);
    lutron.on('zoneMode', onMode);
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => { lutron.off('zoneLevel', onLevel); lutron.off('zoneMode', onMode); clearInterval(ping); });
  });

  router.get('/latches', (_req, res) => {
    const out = [];
    for (const [zoneId, z] of Object.entries(stateStore.get().zones)) {
      if (z.latch?.active) out.push({ zone: Number(zoneId), ...z.latch });
    }
    res.json(out);
  });

  router.delete('/latches/:zoneId', (req, res) => {
    enforcement.clearLatch(Number(req.params.zoneId));
    res.json({ ok: true });
  });

  return router;
}
