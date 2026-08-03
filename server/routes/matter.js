import { Router } from 'express';

/**
 * Matter management routes (EXPERIMENTAL). Unlike the other providers, Matter
 * commissioning happens against the ONE running controller instance (it holds
 * the fabric), so these operate on the live `devices` bus provider, not a
 * throwaway probe.
 */
export function matterRouter({ configStore, devices, logger }) {
  const router = Router();

  const provider = () => {
    const p = devices.provider('matter');
    if (!p) throw new Error('Matter is not enabled, turn it on in Settings first');
    return p;
  };

  /** List already-commissioned Matter nodes (to add as zones). */
  router.post('/matter/discover', async (_req, res) => {
    if (!configStore.get().matter?.enabled) return res.status(409).json({ error: 'Matter is not enabled in Settings' });
    try {
      res.json({ ok: true, devices: await provider().listDevices() });
    } catch (err) {
      logger?.error({ err: err.message }, 'matter discover failed');
      res.status(502).json({ ok: false, error: err.message });
    }
  });

  /** Commission a new device by manual pairing code, then it can be imported. */
  router.post('/matter/commission', async (req, res) => {
    if (!configStore.get().matter?.enabled) return res.status(409).json({ error: 'Matter is not enabled in Settings' });
    const code = req.body?.pairingCode;
    if (!code) return res.status(400).json({ error: 'pairingCode required' });
    try {
      const device = await provider().commission(code);
      logger?.warn({ nodeId: device.id }, 'matter device commissioned via API');
      res.json({ ok: true, device });
    } catch (err) {
      logger?.error({ err: err.message }, 'matter commission failed');
      res.status(502).json({ ok: false, error: err.message });
    }
  });

  /** Add selected commissioned nodes as zones. Body: { deviceIds: [nodeId, ...] }. */
  router.post('/matter/import', async (req, res) => {
    const cfg = configStore.get();
    try {
      const all = await provider().listDevices();
      const picks = req.body?.devices ?? (req.body?.deviceIds ?? []).map((id) => ({ id }));
      const wanted = new Set(picks.map((p) => String(p.id)));
      const areaFor = new Map(picks.map((p) => [String(p.id), p.area]));
      const existing = cfg.zones;
      const byExternal = new Map(existing.filter((z) => z.source === 'matter').map((z) => [String(z.externalId), z]));
      let nextId = Math.max(99, ...existing.map((z) => z.id)) + 1;
      const added = [];
      for (const d of all.filter((d) => wanted.has(String(d.id)))) {
        if (byExternal.has(String(d.id))) continue;
        added.push({
          id: nextId++, source: 'matter', externalId: String(d.id),
          name: d.label, area: areaFor.get(String(d.id))?.trim() || 'Matter', friendlyName: d.label,
          dimmable: Boolean(d.dimmable), enforce: false,
        });
      }
      configStore.update({ zones: [...existing, ...added] });
      logger?.info({ added: added.length }, 'matter devices imported');
      res.json({ added, zones: configStore.get().zones });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  return router;
}
