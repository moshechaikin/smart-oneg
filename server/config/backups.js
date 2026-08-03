import fs from 'node:fs';
import path from 'node:path';

/**
 * Rolling daily snapshots of config.json: data/backups/config-YYYY-MM-DD.json,
 * newest 14 kept (14 days of history). Written by the nightly cron and once
 * at boot when today's snapshot doesn't exist yet, so a machine that sleeps
 * through the cron window still gets its daily copy.
 */
const KEEP = 14;
const NAME_RE = /^config-\d{4}-\d{2}-\d{2}\.json$/;

export const backupDir = (dataDir) => path.join(dataDir, 'backups');

const todayName = (tzid) =>
  `config-${new Date().toLocaleDateString('en-CA', tzid ? { timeZone: tzid } : {})}.json`;

export function writeDailyBackup(dataDir, config, logger, { onlyIfMissing = false } = {}) {
  const dir = backupDir(dataDir);
  const name = todayName(config.location?.tzid);
  const file = path.join(dir, name);
  try {
    if (onlyIfMissing && fs.existsSync(file)) return null;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
    const all = fs.readdirSync(dir).filter((f) => NAME_RE.test(f)).sort();
    for (const stale of all.slice(0, Math.max(0, all.length - KEEP))) {
      fs.unlinkSync(path.join(dir, stale));
    }
    logger?.info({ file: name, kept: Math.min(all.length, KEEP) }, 'daily config backup written');
    return name;
  } catch (err) {
    logger?.error({ err: err.message }, 'daily config backup FAILED');
    return null;
  }
}

export function listBackups(dataDir) {
  const dir = backupDir(dataDir);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => NAME_RE.test(f)).sort().reverse()
    .map((f) => ({ name: f, date: f.slice(7, 17), size: fs.statSync(path.join(dir, f)).size }));
}

/** Resolve a backup name to its path — rejects anything but our own naming. */
export function backupPath(dataDir, name) {
  if (!NAME_RE.test(name)) return null;
  const file = path.join(backupDir(dataDir), name);
  return fs.existsSync(file) ? file : null;
}
