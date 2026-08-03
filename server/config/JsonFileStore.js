import fs from 'node:fs';
import path from 'node:path';

/**
 * Crash-safe JSON file persistence shared by ConfigStore and StateStore.
 *
 * Write path: serialize -> write to <file>.tmp -> fsync -> rename over <file>.
 * A .bak copy of the previous good file is kept before each replace, and
 * load() falls back to it if the main file is missing or corrupt (microSD
 * power-loss on the backup Pi is a real failure mode).
 */
export class JsonFileStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.bakPath = `${filePath}.bak`;
    this.tmpPath = `${filePath}.tmp`;
  }

  load() {
    for (const candidate of [this.filePath, this.bakPath]) {
      try {
        return { data: JSON.parse(fs.readFileSync(candidate, 'utf8')), source: candidate };
      } catch (err) {
        if (err.code !== 'ENOENT') {
          // corrupt file: keep going to the backup, but preserve the evidence
          try { fs.copyFileSync(candidate, `${candidate}.corrupt`); } catch { /* ignore */ }
        }
      }
    }
    return { data: null, source: null };
  }

  save(data) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const json = JSON.stringify(data, null, 2);
    const fd = fs.openSync(this.tmpPath, 'w');
    try {
      fs.writeSync(fd, json);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try { fs.copyFileSync(this.filePath, this.bakPath); } catch { /* first save */ }
    fs.renameSync(this.tmpPath, this.filePath);
  }
}
