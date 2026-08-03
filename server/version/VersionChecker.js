import fs from 'node:fs';

const DEFAULT_URL = 'https://smartoneg.com/version.json';
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Parse a `vX.Y.Z` / `X.Y.Z-rc.N` tag into comparable parts. Follows semver
 * precedence: a release outranks a pre-release of the same X.Y.Z, and numeric
 * pre-release identifiers compare numerically.
 */
function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(String(v ?? '').trim());
  if (!m) return null;
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? null };
}

/** true if `a` is a strictly newer version than `b`. Unparseable -> false. */
export function isNewer(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return false;
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] > pb.nums[i];
  }
  // same X.Y.Z: no pre-release beats a pre-release; else compare identifiers
  if (pa.pre === pb.pre) return false;
  if (pa.pre === null) return true;   // a is the release, b is a pre-release
  if (pb.pre === null) return false;  // b is the release
  const ai = pa.pre.split('.');
  const bi = pb.pre.split('.');
  for (let i = 0; i < Math.max(ai.length, bi.length); i++) {
    if (ai[i] === bi[i]) continue;
    if (ai[i] === undefined) return false;
    if (bi[i] === undefined) return true;
    const an = Number(ai[i]); const bn = Number(bi[i]);
    if (!Number.isNaN(an) && !Number.isNaN(bn)) return an > bn;
    return ai[i] > bi[i];
  }
  return false;
}

/**
 * Best-effort "is there a newer release?" check against a small static JSON on
 * smartoneg.com. Never throws into the app; the whole thing is optional and the
 * app is fully functional offline. Result is cached in state so the UI has an
 * answer immediately on load and the network is hit at most ~once a day.
 *
 * version.json shape: { "version": "1.0.1", "url": "https://…", "notes": "…" }
 */
export class VersionChecker {
  #timer = null;

  constructor({ stateStore, configStore = null, current, url = DEFAULT_URL, logger = null, notifier = null, isActive = () => true, fetchImpl = fetch, intervalMs = DAY_MS }) {
    this.state = stateStore;
    this.config = configStore; // for the autoCheck opt-out
    this.current = current;
    this.url = url;
    this.log = logger;
    this.notifier = notifier;
    this.isActive = isActive; // false on an inactive standby -> check, but don't notify
    this.fetch = fetchImpl;
    this.intervalMs = intervalMs;
  }

  /** Whether an in-container self-update even has a chance (Docker socket present). */
  get canSelfUpdate() {
    try { return fs.existsSync('/var/run/docker.sock'); } catch { return false; }
  }

  status() {
    const vc = this.state.get().versionCheck ?? {};
    const latest = vc.latest ?? null;
    return {
      current: this.current,
      latest,
      updateAvailable: latest ? isNewer(latest, this.current) : false,
      url: vc.url ?? null,
      notes: vc.notes ?? null,
      checkedAt: vc.checkedAt ?? null,
      canSelfUpdate: this.canSelfUpdate,
    };
  }

  async check() {
    try {
      const res = await this.fetch(this.url, { signal: AbortSignal.timeout(8000), headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`version.json ${res.status}`);
      const data = await res.json();
      const latest = data.version ? `v${String(data.version).replace(/^v/, '')}` : null;
      const prev = this.state.get().versionCheck ?? {};
      this.state.get().versionCheck = {
        latest, url: data.url ?? null, notes: data.notes ?? null,
        checkedAt: new Date().toISOString(), notifiedVersion: prev.notifiedVersion ?? null,
      };
      this.state.save();
      if (latest && isNewer(latest, this.current)) {
        this.log?.info({ latest, current: this.current }, 'a newer version is available');
        // notify once per new version (don't nag daily for the same one), and
        // only from the instance in control — an inactive standby stays quiet
        if (latest !== prev.notifiedVersion && this.isActive()) {
          this.notifier?.send('update-available', { current: this.current, latest, notes: data.notes, url: data.url }).catch(() => {});
          this.state.get().versionCheck.notifiedVersion = latest;
          this.state.save();
        }
      }
      return this.status();
    } catch (err) {
      this.log?.debug({ err: err.message }, 'version check failed (offline is fine)');
      // still stamp the attempt time so "last checked" is truthful
      const vc = this.state.get().versionCheck ?? {};
      this.state.get().versionCheck = { ...vc, checkedAt: new Date().toISOString() };
      this.state.save();
      return this.status();
    }
  }

  /** Whether automatic (non-user-initiated) checks are allowed to hit the network. */
  #autoAllowed() { return this.config?.get().updates?.autoCheck !== false; }

  start() {
    // a few seconds after boot, then daily — unref so it never holds the process.
    // Skipped entirely when the user turned auto-checking off (no outbound ping).
    const auto = () => { if (this.#autoAllowed()) this.check(); };
    setTimeout(auto, 10_000).unref?.();
    this.#timer = setInterval(auto, this.intervalMs);
    this.#timer.unref?.();
  }

  stop() { clearInterval(this.#timer); }
}
