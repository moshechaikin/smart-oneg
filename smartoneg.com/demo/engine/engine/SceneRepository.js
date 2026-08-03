const MAX_EXTENDS_DEPTH = 5;

/**
 * Scenes: reusable groups of zone actions. A scene may extend another scene;
 * resolution applies the parent chain then this scene's overrides/add/remove.
 * Resolution happens at timeline compile time, so editing a base scene
 * affects future compiles of every extension, while overridden zones in an
 * extension are immune to base edits.
 */
export class SceneRepository {
  constructor(scenes = []) {
    this.byId = new Map(scenes.map((s) => [s.id, s]));
  }

  get(id) {
    return this.byId.get(id) ?? null;
  }

  list() {
    return [...this.byId.values()];
  }

  /**
   * @returns {{ actions: Array<{zone, level, fadeSec?}>, endActions: Array }}
   * When a scene defines no endActions, endActions default to [] — i.e. ending
   * it leaves every device exactly as it is (a no-op), not "all zones -> 0".
   */
  resolve(id, _depth = 0) {
    const scene = this.byId.get(id);
    if (!scene) throw new Error(`scene not found: ${id}`);
    if (_depth > MAX_EXTENDS_DEPTH) throw new Error(`scene extends chain too deep at ${id}`);

    let actions;
    let endActions;
    if (scene.extends) {
      if (scene.extends === id) throw new Error(`scene ${id} extends itself`);
      const parent = this.resolve(scene.extends, _depth + 1);
      actions = [...parent.actions];
      endActions = parent.explicitEnd ? [...parent.endActions] : null;
    } else {
      actions = [...(scene.actions ?? [])];
      endActions = scene.endActions ? [...scene.endActions] : null;
    }

    if (scene.extends) {
      for (const [zoneStr, replacement] of Object.entries(scene.overrides ?? {})) {
        const zone = Number(zoneStr);
        const idx = actions.findIndex((a) => a.zone === zone);
        if (idx >= 0) actions[idx] = { zone, ...replacement };
        else actions.push({ zone, ...replacement });
      }
      for (const extra of scene.add ?? []) {
        const idx = actions.findIndex((a) => a.zone === extra.zone);
        if (idx >= 0) actions[idx] = extra; else actions.push(extra);
      }
      for (const zone of scene.remove ?? []) {
        actions = actions.filter((a) => a.zone !== zone);
      }
      if (scene.endActions) endActions = [...scene.endActions];
    }

    const explicitEnd = endActions !== null;
    if (!explicitEnd) {
      // default end behavior: leave every device as it is (no actions)
      endActions = [];
    } else {
      // drop end actions for zones no longer in the scene
      endActions = endActions.filter((a) => actions.some((x) => x.zone === a.zone) || !scene.extends);
    }
    return { actions, endActions, explicitEnd };
  }

  /** Validate all scenes resolve (used by config validation on save/import). */
  validateAll() {
    const errors = [];
    for (const id of this.byId.keys()) {
      try { this.resolve(id); } catch (err) { errors.push(err.message); }
    }
    return errors;
  }
}
