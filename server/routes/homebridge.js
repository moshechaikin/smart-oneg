import { Router } from 'express';
import { HomebridgeProvider } from '../devices/HomebridgeProvider.js';
import { cleanCredential } from './creds.js';

/** Homebridge (config-ui-x) management routes, mirroring Hubitat. */
export function homebridgeRouter({ configStore, logger }) {
  const router = Router();

  router.post('/homebridge/discover', async (req, res) => {
    const merged = { ...configStore.get().homebridge, ...stripEmpty(req.body) };
    try { if (merged.password != null) merged.password = cleanCredential(merged.password, 'password'); }
    catch (err) { return res.status(400).json({ ok: false, error: err.message }); }
    if (merged.host != null) merged.host = String(merged.host).trim();
    const probe = new HomebridgeProvider({ ...merged, logger });
    try {
      res.json({ ok: true, devices: await probe.listDevices() });
    } catch (err) {
      res.status(502).json({ ok: false, error: err.message });
    }
  });

  /** Add selected accessories as zones. Body: { deviceIds: [uniqueId, ...] }. */
  router.post('/homebridge/import', async (req, res) => {
    const cfg = configStore.get();
    const provider = new HomebridgeProvider({ ...cfg.homebridge, logger });
    try {
      const all = await provider.listDevices();
      const picks = req.body?.devices ?? (req.body?.deviceIds ?? []).map((id) => ({ id }));
      const wanted = new Set(picks.map((p) => String(p.id)));
      const areaFor = new Map(picks.map((p) => [String(p.id), p.area]));
      const existing = cfg.zones;
      const byExternal = new Map(existing.filter((z) => z.source === 'homebridge').map((z) => [z.externalId, z]));
      let nextId = Math.max(99, ...existing.map((z) => z.id)) + 1;
      const added = [];
      const refreshed = [];
      for (const d of all.filter((d) => wanted.has(String(d.id)))) {
        const ex = byExternal.get(d.id);
        if (ex) {
          // re-import = refresh capability only; keep room/rename/Child Lock
          ex.dimmable = Boolean(d.dimmable);
          refreshed.push(ex);
          continue;
        }
        added.push({
          id: nextId++, source: 'homebridge', externalId: d.id,
          name: d.label, area: areaFor.get(String(d.id))?.trim() || 'Homebridge', friendlyName: d.label,
          dimmable: Boolean(d.dimmable), enforce: false,
        });
      }
      configStore.update({ zones: [...existing, ...added] });
      logger?.info({ added: added.length, refreshed: refreshed.length }, 'homebridge accessories imported');
      res.json({ added, refreshed, zones: configStore.get().zones });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  return router;
}

const stripEmpty = (o) => Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => v !== '' && v != null));
