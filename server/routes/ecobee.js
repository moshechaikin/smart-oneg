import { Router } from 'express';
import { EcobeeProvider, requestPin, exchangePin } from '../devices/EcobeeProvider.js';

export function ecobeeRouter({ configStore, logger }) {
  const router = Router();

  /** Step 1 of the PIN flow: get a PIN the user enters at ecobee.com. */
  router.post('/ecobee/authorize', async (req, res) => {
    const apiKey = req.body?.apiKey || configStore.get().ecobee.apiKey;
    if (!apiKey) return res.status(400).json({ error: 'API key required (developer.ecobee.com → create an app)' });
    try {
      const { pin, code, expiresInMin } = await requestPin({ apiKey });
      configStore.update({ ecobee: { apiKey, pendingCode: code } });
      res.json({ pin, expiresInMin });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  /** Step 2: after the user authorized the PIN on ecobee.com. */
  router.post('/ecobee/token', async (_req, res) => {
    const { apiKey, pendingCode } = configStore.get().ecobee;
    if (!pendingCode) return res.status(400).json({ error: 'Request a PIN first' });
    try {
      const tokens = await exchangePin({ apiKey, code: pendingCode });
      configStore.update({ ecobee: { ...tokens, pendingCode: '' } });
      res.json({ ok: true });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  router.post('/ecobee/discover', async (_req, res) => {
    try {
      const provider = new EcobeeProvider({ configStore, logger });
      res.json({ ok: true, devices: await provider.listDevices() });
    } catch (err) {
      res.status(502).json({ ok: false, error: err.message });
    }
  });

  /** Add selected thermostats as devices (kind "thermostat", level = °F). */
  router.post('/ecobee/import', async (req, res) => {
    try {
      const provider = new EcobeeProvider({ configStore, logger });
      const all = await provider.listDevices();
      const wanted = new Set((req.body?.identifiers ?? []).map(String));
      const existing = configStore.get().zones;
      const byExternal = new Set(existing.filter((z) => z.source === 'ecobee').map((z) => String(z.externalId)));
      let nextId = Math.max(99, ...existing.map((z) => z.id)) + 1;
      const added = [];
      for (const t of all.filter((t) => wanted.has(String(t.id)))) {
        if (byExternal.has(String(t.id))) continue;
        added.push({
          id: nextId++, source: 'ecobee', externalId: String(t.id), kind: 'thermostat',
          name: t.label, area: 'Climate', friendlyName: t.label,
          dimmable: true, enforce: false,
        });
      }
      configStore.update({ zones: [...existing, ...added] });
      res.json({ added, zones: configStore.get().zones });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  return router;
}
