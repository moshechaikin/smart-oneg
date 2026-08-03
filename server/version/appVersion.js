import fs from 'node:fs';

/** The running app version as `vX.Y.Z`, read from package.json at import time. */
export const APP_VERSION = (() => {
  try { return `v${JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version}`; }
  catch { return 'unknown'; }
})();
