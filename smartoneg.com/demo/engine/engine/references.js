/**
 * Find everything in the config that references the given zone ids —
 * used to warn before removing devices (Lutron re-import diff, manual
 * device deletion) so schedules never silently break.
 */
/** Rules that start/end any of the given scenes. */
export function findSceneReferences(cfg, sceneIds) {
  const ids = new Set(sceneIds);
  const refs = [];
  for (const [dayType, variants] of Object.entries(cfg.schedules ?? {})) {
    for (const [variant, schedule] of Object.entries(variants ?? {})) {
      for (const rule of schedule?.rules ?? []) {
        if (ids.has(rule.action?.sceneId)) {
          refs.push({ type: 'rule', dayType, variant, ruleId: rule.id, label: rule.label || 'unnamed rule', sceneId: rule.action.sceneId });
        }
      }
    }
  }
  return refs;
}

/** The scene plus every scene that (transitively) extends it. */
export function sceneDescendants(scenes, id) {
  const out = [id];
  for (const s of scenes) {
    if (s.extends === id) out.push(...sceneDescendants(scenes, s.id));
  }
  return out;
}

export function findZoneReferences(cfg, zoneIds) {
  const ids = new Set(zoneIds);
  const refs = [];
  for (const [dayType, variants] of Object.entries(cfg.schedules ?? {})) {
    for (const [variant, schedule] of Object.entries(variants ?? {})) {
      for (const rule of schedule?.rules ?? []) {
        const ruleZones = rule.action?.zones?.length ? rule.action.zones : [rule.action?.zone];
        const hitZone = ruleZones.find((z) => ids.has(z));
        if (hitZone !== undefined) {
          refs.push({ type: 'rule', dayType, variant, ruleId: rule.id, label: rule.label || 'unnamed rule', zone: hitZone });
        }
      }
    }
  }
  for (const scene of cfg.scenes ?? []) {
    const zones = [
      ...(scene.actions ?? []).map((a) => a.zone),
      ...(scene.add ?? []).map((a) => a.zone),
      ...Object.keys(scene.overrides ?? {}).map(Number),
      ...(scene.endActions ?? []).map((a) => a.zone),
    ];
    const hit = zones.filter((z) => ids.has(z));
    if (hit.length) refs.push({ type: 'scene', sceneId: scene.id, name: scene.name || 'unnamed scene', zones: hit });
  }
  return refs;
}
