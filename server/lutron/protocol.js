/**
 * Lutron Integration Protocol (LIP / "GNET") line building and parsing.
 * Reference: Lutron-040249.pdf rev O — OUTPUT command, Integrator's Reference.
 */

export const OUTPUT_ACTION = { SET_LEVEL: 1, START_FLASH: 5, PULSE: 6 };

export const ERROR_MESSAGES = {
  1: 'Parameter count mismatch',
  2: 'Object does not exist',
  3: 'Invalid action number',
  4: 'Parameter data out of range',
  5: 'Parameter data malformed',
  6: 'Unsupported command',
};

/** #OUTPUT,<id>,1,<level>[,<fade>] — fade in seconds formatted SS or MM:SS. */
export function buildSetLevel(id, level, fadeSec = 0) {
  const lvl = clampLevel(level);
  return fadeSec > 0
    ? `#OUTPUT,${id},${OUTPUT_ACTION.SET_LEVEL},${lvl},${formatFade(fadeSec)}`
    : `#OUTPUT,${id},${OUTPUT_ACTION.SET_LEVEL},${lvl}`;
}

export function buildQueryLevel(id) {
  return `?OUTPUT,${id},${OUTPUT_ACTION.SET_LEVEL}`;
}

export function buildStartFlash(id) {
  return `#OUTPUT,${id},${OUTPUT_ACTION.START_FLASH}`;
}

export function clampLevel(level) {
  const n = Math.max(0, Math.min(100, Number(level)));
  return Number.isInteger(n) ? n : n.toFixed(2);
}

export function formatFade(totalSec) {
  const s = Math.round(totalSec);
  if (s < 60) return String(s);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * Parse one monitor/response line.
 * @returns {{type:'output', id, action, level}|{type:'error', code, message}|{type:'other', raw}|null}
 */
export function parseLine(rawLine) {
  const line = rawLine.replace(/^GNET>\s*/, '').trim();
  if (!line) return null;

  if (line.startsWith('~OUTPUT,')) {
    const parts = line.split(',');
    const id = Number(parts[1]);
    const action = Number(parts[2]);
    const level = parts[3] !== undefined ? Number(parts[3]) : null;
    if (!Number.isFinite(id) || !Number.isFinite(action)) return { type: 'other', raw: line };
    return { type: 'output', id, action, level };
  }
  if (line.startsWith('~ERROR')) {
    const payload = line.slice('~ERROR'.length).replace(/^,/, '');
    const code = Number(payload);
    return Number.isInteger(code)
      ? { type: 'error', code, message: `${ERROR_MESSAGES[code] ?? 'Unknown error'} (~ERROR,${code})` }
      // real Caséta bridges reply with non-numeric payloads for some rejects
      : { type: 'error', code: null, message: `Bridge error: ${line}` };
  }
  return { type: 'other', raw: line };
}

/**
 * Parse the raw JSON integration report (lutron-integration-report.json)
 * into zone records for config.zones.
 */
export function parseIntegrationReport(json) {
  const list = json?.LIPIdList;
  if (!list || !Array.isArray(list.Zones)) {
    throw new Error('Not a Lutron integration report: missing LIPIdList.Zones');
  }
  return list.Zones.map((z) => ({
    id: z.ID,
    name: z.Name,
    area: z.Area?.Name ?? '',
    friendlyName: `${z.Area?.Name ?? ''} ${z.Name}`.trim(),
    dimmable: true,
    enforce: false,
  }));
}
