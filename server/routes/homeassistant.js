import { Router } from 'express';
import { HomeAssistantProvider } from '../devices/HomeAssistantProvider.js';
import { cleanCredential } from './creds.js';

/** Home Assistant management routes (discover + import), mirroring Hubitat. */
export function homeAssistantRouter({ configStore, logger }) {
  const router = Router();

  /** Probe an HA config (from the settings form) and list entities. */
  router.post('/homeassistant/discover', async (req, res) => {
    const merged = { ...configStore.get().homeassistant, ...stripEmpty(req.body) };
    let token;
    try { token = cleanCredential(merged.token, 'token'); }
    catch (err) { return res.status(400).json({ ok: false, error: err.message }); }
    const probe = new HomeAssistantProvider({ host: String(merged.host ?? '').trim(), token, logger });
    try {
      res.json({ ok: true, devices: await probe.listDevices() });
    } catch (err) {
      res.status(502).json({ ok: false, error: err.message });
    }
  });

  /**
   * Add selected HA entities as zones. Body: { deviceIds: [entity_id, ...] }.
   * App-level zone ids start at 100 so they never collide with Lutron LIP ids.
   */
  router.post('/homeassistant/import', async (req, res) => {
    const cfg = configStore.get();
    const provider = new HomeAssistantProvider({ ...cfg.homeassistant, logger });
    try {
      const all = await provider.listDevices();
      // accept { devices: [{ id, area }] } (per-device room) or legacy { deviceIds }
      const picks = req.body?.devices ?? (req.body?.deviceIds ?? []).map((id) => ({ id }));
      const wanted = new Set(picks.map((p) => String(p.id)));
      const areaFor = new Map(picks.map((p) => [String(p.id), p.area]));
      const existing = cfg.zones;
      const byExternal = new Map(existing.filter((z) => z.source === 'homeassistant').map((z) => [z.externalId, z]));
      let nextId = Math.max(99, ...existing.map((z) => z.id)) + 1;
      const added = [];
      const refreshed = [];
      for (const d of all.filter((d) => wanted.has(String(d.id)))) {
        const ex = byExternal.get(d.id);
        if (ex) {
          // re-import = refresh source-derived capabilities only (dimmable/kind,
          // and the thermostat's unit which HA owns); keep the user's room,
          // rename, and Child Lock settings untouched
          ex.dimmable = Boolean(d.dimmable);
          if (d.kind) ex.kind = d.kind; else delete ex.kind;
          if (d.displayUnit === 'C') ex.displayUnit = 'C'; else if ('displayUnit' in d) delete ex.displayUnit;
          if (d.presetModes?.length) ex.presetModes = d.presetModes; else delete ex.presetModes;
          if (d.hvacModes?.length) ex.hvacModes = d.hvacModes; else delete ex.hvacModes;
          if (d.colorTemp) { ex.colorTemp = true; ex.minKelvin = d.minKelvin; ex.maxKelvin = d.maxKelvin; }
          else { delete ex.colorTemp; delete ex.minKelvin; delete ex.maxKelvin; }
          if (d.rgb) ex.rgb = true; else delete ex.rgb;
          if ('controllable' in d) ex.controllable = d.controllable; else delete ex.controllable;
          refreshed.push(ex);
          continue;
        }
        // automations/scripts get their own Devices-page section by default,
        // so they never mix confusingly with real lights in a room
        const defaultArea = d.kind === 'automation' ? 'Automations' : 'Home Assistant';
        added.push({
          id: nextId++, source: 'homeassistant', externalId: d.id,
          name: d.label, area: areaFor.get(String(d.id))?.trim() || defaultArea, friendlyName: d.label,
          dimmable: Boolean(d.dimmable), enforce: false,
          ...(d.kind ? { kind: d.kind } : {}),
          ...(d.displayUnit === 'C' ? { displayUnit: 'C' } : {}),
          ...(d.presetModes?.length ? { presetModes: d.presetModes } : {}),
          ...(d.hvacModes?.length ? { hvacModes: d.hvacModes } : {}),
          ...(d.colorTemp ? { colorTemp: true, minKelvin: d.minKelvin, maxKelvin: d.maxKelvin } : {}),
          ...(d.rgb ? { rgb: true } : {}),
          ...('controllable' in d ? { controllable: d.controllable } : {}),
        });
      }
      configStore.update({ zones: [...existing, ...added] });
      logger?.info({ added: added.length, refreshed: refreshed.length }, 'home assistant devices imported');
      res.json({ added, refreshed, zones: configStore.get().zones });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  return router;
}

const stripEmpty = (o) => Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => v !== '' && v != null));
