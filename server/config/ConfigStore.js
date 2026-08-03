import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { JsonFileStore } from './JsonFileStore.js';
import { defaultConfig, deepMerge, validateConfig, migrateConfig, normalizeEnforcement } from './schema.js';

/**
 * Owns data/config.json — the single source of truth for all settings, zones,
 * scenes and schedules. Every successful write bumps `configVersion`
 * (standby instances use it to detect drift) and emits 'change'.
 */
export class ConfigStore extends EventEmitter {
  #store;
  #config;
  #logger;

  #backupPath;

  constructor({ dataDir, logger }) {
    super();
    this.#store = new JsonFileStore(path.join(dataDir, 'config.json'));
    // A clean, always-current, human-recognizable full backup written on every
    // change — sits in ./data (next to docker-compose) so the user always has a
    // grab-and-restore copy of ALL settings without exporting manually.
    this.#backupPath = path.join(dataDir, 'smartoneg-config-backup.json');
    this.#logger = logger;
  }

  load() {
    const { data, source } = this.#store.load();
    if (data === null) {
      this.#config = defaultConfig();
      this.#logger?.info('no config found, starting with defaults (setup wizard will run)');
      this.#store.save(this.#config);
    } else {
      let cfg = migrateConfig(deepMerge(defaultConfig(), data));
      // preserve identity fields exactly as stored (deepMerge already does, but
      // defaults generate fresh ids for missing ones only)
      const { valid, errors } = validateConfig(cfg);
      if (!valid) {
        throw new Error(`config.json invalid: ${errors.join('; ')}`);
      }
      this.#config = cfg;
      if (source === this.#store.bakPath) {
        this.#logger?.warn('config.json was corrupt or missing — recovered from backup');
        this.#store.save(this.#config);
      }
    }
    return this.#config;
  }

  /** Current config (live object — treat as read-only outside this class). */
  get() {
    return this.#config;
  }

  /**
   * Merge a partial config (PATCH semantics: objects merge deep, arrays
   * replace). Validates before persisting; throws on invalid without
   * mutating current state.
   */
  update(partial) {
    const next = deepMerge(this.#config, partial);
    return this.#commit(next);
  }

  /** Replace wholesale (config import). Keeps this instance's identity + role. */
  import(incoming) {
    const preserved = {
      instance: this.#config.instance,
      failover: { ...incoming.failover, primaryUrl: this.#config.failover.primaryUrl },
    };
    let next = migrateConfig(deepMerge(defaultConfig(), incoming));
    next = deepMerge(next, preserved);
    return this.#commit(next);
  }

  /**
   * Wipe everything (including auth) back to a fresh install so the setup
   * wizard runs again. Keeps only this instance's identity so failover config
   * on other nodes isn't orphaned.
   */
  reset() {
    const fresh = defaultConfig();
    fresh.instance = { ...fresh.instance, id: this.#config.instance.id };
    return this.#commit(fresh);
  }

  #commit(next) {
    next = { ...next, configVersion: (this.#config?.configVersion ?? 0) + 1 };
    // clamp Child Lock bounds on every write path (update bypasses migrate)
    normalizeEnforcement(next);
    const { valid, errors } = validateConfig(next);
    if (!valid) {
      const err = new Error(`invalid config: ${errors.join('; ')}`);
      err.validationErrors = errors;
      throw err;
    }
    this.#store.save(next);
    this.#config = next;
    // Best-effort readable backup — never let a backup write fail a real save.
    try { fs.writeFileSync(this.#backupPath, `${JSON.stringify(next, null, 2)}\n`); }
    catch (err) { this.#logger?.warn({ err: err.message }, 'config backup write failed'); }
    this.#logger?.info({ configVersion: next.configVersion }, 'config saved');
    this.emit('change', next);
    return next;
  }
}
