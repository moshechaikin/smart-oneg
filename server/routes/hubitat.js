import { Router } from 'express';
import { HubitatProvider } from '../devices/HubitatProvider.js';
import { safeEqual } from './auth.js';
import { cleanCredential } from './creds.js';

/**
 * Unauthenticated webhook for Maker API's "POST device events" URL.
 * The hub can't send session cookies or Bearer headers, so the shared
 * secret rides the query string: /api/hubitat/events?token=<accessToken>.
 */
export function hubitatWebhook({ configStore, devices, logger }) {
  return (req, res) => {
    const cfg = configStore.get().hubitat;
    if (!cfg.enabled || !cfg.accessToken || !safeEqual(req.query.token, cfg.accessToken)) {
      return res.status(401).json({ error: 'bad token' });
    }
    devices.provider('hubitat')?.handleEvent(req.body);
    res.json({ ok: true });
  };
}

/** Authenticated Hubitat management routes. */
export function hubitatRouter({ configStore, devices, logger }) {
  const router = Router();

  /** Probe a Maker API config (from settings form) and list devices. */
  router.post('/hubitat/discover', async (req, res) => {
    const { host, appId, accessToken } = { ...configStore.get().hubitat, ...req.body };
    let token;
    try { token = cleanCredential(accessToken, 'access token'); }
    catch (err) { return res.status(400).json({ ok: false, error: err.message }); }
    const probe = new HubitatProvider({ host: String(host ?? '').trim(), appId, accessToken: token, logger });
    try {
      res.json({ ok: true, devices: await probe.listDevices() });
    } catch (err) {
      res.status(502).json({ ok: false, error: err.message });
    }
  });

  /**
   * Add selected Hubitat devices as zones. Body: { deviceIds: [..] }.
   * App-level zone ids are assigned from 100 upward so they never collide
   * with Lutron LIP integration ids (single digits on a Caséta bridge).
   */
  router.post('/hubitat/import', async (req, res) => {
    const cfg = configStore.get();
    const provider = new HubitatProvider({ ...cfg.hubitat, logger });
    try {
      const all = await provider.listDevices();
      const picks = req.body?.devices ?? (req.body?.deviceIds ?? []).map((id) => ({ id }));
      const wanted = new Set(picks.map((p) => Number(p.id)));
      const areaFor = new Map(picks.map((p) => [Number(p.id), p.area]));
      const existing = cfg.zones;
      const byExternal = new Map(existing.filter((z) => z.source === 'hubitat').map((z) => [z.externalId, z]));
      let nextId = Math.max(99, ...existing.map((z) => z.id)) + 1;
      const added = [];
      const refreshed = [];
      for (const d of all.filter((d) => wanted.has(d.id))) {
        const ex = byExternal.get(d.id);
        if (ex) {
          // re-import = refresh capability only; keep room/rename/Child Lock
          ex.dimmable = Boolean(d.dimmable);
          refreshed.push(ex);
          continue;
        }
        added.push({
          id: nextId++, source: 'hubitat', externalId: d.id,
          name: d.label, area: areaFor.get(d.id)?.trim() || 'Hubitat', friendlyName: d.label,
          dimmable: d.dimmable, enforce: false,
        });
      }
      configStore.update({ zones: [...existing, ...added] });
      res.json({ added, refreshed, zones: configStore.get().zones });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  return router;
}
