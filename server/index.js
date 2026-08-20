import fs from 'node:fs';
import path from 'node:path';
import { Cron } from 'croner';
import { DateTime } from 'luxon';
import { createLogger } from './logging/logger.js';
import { ConfigStore } from './config/ConfigStore.js';
import { writeDailyBackup } from './config/backups.js';
import { StateStore } from './config/StateStore.js';
import { LutronClient } from './lutron/LutronClient.js';
import { MockBridge } from './lutron/MockBridge.js';
import { DeviceBus } from './devices/DeviceBus.js';
import { HubitatProvider } from './devices/HubitatProvider.js';
import { VirtualProvider } from './devices/VirtualProvider.js';
import { EcobeeProvider } from './devices/EcobeeProvider.js';
import { HomeAssistantProvider } from './devices/HomeAssistantProvider.js';
import { HomebridgeProvider } from './devices/HomebridgeProvider.js';
import { MatterProvider } from './devices/MatterProvider.js';
import { EnvisalinkProvider } from './devices/EnvisalinkProvider.js';
import { ZoneStateTracker } from './safety/ZoneStateTracker.js';
import { EnforcementEngine } from './safety/EnforcementEngine.js';
import { Scheduler } from './engine/Scheduler.js';
import { FailoverManager } from './failover/FailoverManager.js';
import { VersionChecker } from './version/VersionChecker.js';
import { APP_VERSION } from './version/appVersion.js';
import { Notifier } from './notify/Notifier.js';
import { buildClusterSummary } from './notify/summary.js';
import { yomTovSheet } from './pdf/zmanimSheet.js';
import { omerSheet } from './pdf/omerSheet.js';

const FESTIVAL_OF_DAYTYPE = {
  'pesach-1': 'pesach', 'pesach-2': 'pesach', 'pesach-7': 'pesach', 'pesach-8': 'pesach',
  'sukkos-1': 'sukkos', 'sukkos-2': 'sukkos', 'shmini-atzeres': 'sukkos', 'simchas-torah': 'sukkos',
  'shavuos-1': 'shavuos', 'shavuos-2': 'shavuos',
  'rosh-hashanah-1': 'rosh-hashanah', 'rosh-hashanah-2': 'rosh-hashanah', 'yom-kippur': 'yom-kippur',
};
const festivalOfCluster = (cluster) => {
  for (const d of cluster.days) if (FESTIVAL_OF_DAYTYPE[d.dayType]) return FESTIVAL_OF_DAYTYPE[d.dayType];
  return null;
};
/** Human-readable havdalah boundary for notifications, e.g. "Havdalah, Saturday Aug 9, 8:57 PM". */
const humanHavdalah = (iso, tzid) => {
  if (!iso) return null;
  const dt = DateTime.fromJSDate(new Date(iso), { zone: tzid || 'local' });
  return dt.isValid ? `Havdalah, ${dt.toFormat('EEEE MMM d, h:mm a')}` : null;
};
/** Buffer a PDFKit document stream; resolves null on error so email still sends. */
const pdfBuffer = (doc) => new Promise((resolve) => {
  if (!doc) return resolve(null);
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  doc.on('end', () => resolve(Buffer.concat(chunks)));
  doc.on('error', () => resolve(null));
});
import { CalendarService } from './calendar/CalendarService.js';
import { createApp } from './app.js';

const PORT = Number(process.env.PORT ?? 1836);
// DATA_DIR is only for tests/tooling — normal deployments never need env vars.
const dataDir = process.env.DATA_DIR ?? (fs.existsSync('/data') ? '/data' : path.resolve('data'));

// Module-scoped so the top-level catch and the crash handlers can log to the
// same file/ring even when a failure happens outside main()'s try scope.
let rootLogger = null;
const logDirPath = path.join(dataDir, 'logs');

/**
 * Last-resort logging for a crash. Writes to the app logger if it exists, and
 * ALSO synchronously appends to app.log — a hard crash can exit before pino's
 * async file stream flushes, so the sync write guarantees the reason survives
 * on disk for post-mortem diagnosis after a restart.
 */
function logFatal(kind, err, { exit = false } = {}) {
  const entry = {
    level: 60, time: Date.now(), kind,
    msg: `${kind}: ${err?.message ?? String(err)}`,
    err: err?.message ?? String(err), stack: err?.stack ?? null,
  };
  try { rootLogger?.fatal({ err: entry.err, stack: entry.stack, kind }, entry.msg); } catch { /* logger unusable */ }
  try {
    fs.mkdirSync(logDirPath, { recursive: true });
    fs.appendFileSync(path.join(logDirPath, 'app.log'), `${JSON.stringify(entry)}\n`);
  } catch { /* disk unwritable — nothing more we can do */ }
  // eslint-disable-next-line no-console
  console.error(kind, err);
  if (exit) setTimeout(() => process.exit(1), 300).unref();
}

// Nothing should escape unlogged: a throw in a timer/event handler, or a
// rejected promise nobody awaited, still lands on disk before the process dies.
process.on('uncaughtException', (err) => logFatal('uncaughtException', err, { exit: true }));
process.on('unhandledRejection', (reason) => logFatal('unhandledRejection', reason instanceof Error ? reason : new Error(String(reason))));

function printBanner() {
  // Plain text banner — ASCII-art titles never render well across the places
  // logs are read (Synology's proportional-font viewer, docker logs, files).
  // Color only on a real TTY; non-TTY capture gets clean text.
  const tty = process.stdout.isTTY;
  const gold = tty ? '\x1b[38;5;179m' : '';
  const dim = tty ? '\x1b[2m' : '';
  const reset = tty ? '\x1b[0m' : '';
  const rule = '─'.repeat(56);
  process.stdout.write(`
  ${dim}${rule}${reset}
  ${gold}SmartOneg${reset} ${APP_VERSION}  ${dim}·${reset}  https://smartoneg.com
  Developed by Moshe Chaikin
  https://github.com/moshechaikin
  ${dim}The Ultimate Shabbos & Yom Tov Smart Home Automation App${reset}
  ${dim}${rule}${reset}
`);
}

async function main() {
  printBanner();
  const { logger, ring, logDir } = createLogger({ dir: logDirPath });
  rootLogger = logger;
  logger.info({ dataDir, pid: process.pid, node: process.version }, 'SmartOneg starting');

  const configStore = new ConfigStore({ dataDir, logger });
  configStore.load();
  const stateStore = new StateStore({ dataDir });
  stateStore.load();

  const cfg = configStore.get();

  // Demo/mock mode: run the simulator in-process and point the client at it.
  let mockBridge = null;
  let lutronTarget = { host: cfg.lutron.host, port: cfg.lutron.port };
  if (cfg.lutron.mock) {
    mockBridge = new MockBridge({
      username: cfg.lutron.username,
      password: cfg.lutron.password,
      // before zones are imported, expose the standard demo set (2-10)
      ...(cfg.zones.length ? { zoneIds: cfg.zones.map((z) => z.externalId ?? z.id) } : {}),
    });
    const port = await mockBridge.listen();
    lutronTarget = { host: '127.0.0.1', port };
    logger.warn({ port }, 'MOCK MODE: using in-process bridge simulator');
  }

  // The DeviceBus is a drop-in for LutronClient's surface; downstream modules
  // keep their `devices` parameter name but talk to whichever provider owns
  // each zone (Lutron directly; Zigbee/Z-Wave/Ecobee via a Hubitat hub;
  // manual devices via the in-memory virtual provider).
  const devices = new DeviceBus({ configStore, logger: logger.child({ mod: 'devices' }) });

  // (Re)register every device provider from the CURRENT config. Extracted so a
  // standby can rebuild its providers after it mirrors new bridge/zone config
  // from the primary — otherwise it would boot with the default (Lutron off)
  // config and, on takeover, hit "no provider registered for source lutron".
  const registerProviders = (c) => {
    devices.clearProviders();
    const target = c.lutron.mock ? lutronTarget : { host: c.lutron.host, port: c.lutron.port };
    if (c.lutron.enabled !== false) {
      devices.register('lutron', new LutronClient({
        ...target, username: c.lutron.username, password: c.lutron.password,
        zoneIds: c.zones.filter((z) => (z.source ?? 'lutron') === 'lutron').map((z) => z.externalId ?? z.id),
        primeDelayMs: 750, logger: logger.child({ mod: 'lutron' }),
      }));
    }
    if (c.hubitat.enabled) devices.register('hubitat', new HubitatProvider({ ...c.hubitat, logger: logger.child({ mod: 'hubitat' }) }));
    if (c.ecobee.enabled && c.ecobee.refreshToken) devices.register('ecobee', new EcobeeProvider({ configStore, logger: logger.child({ mod: 'ecobee' }) }));
    if (c.homeassistant?.enabled) devices.register('homeassistant', new HomeAssistantProvider({ ...c.homeassistant, logger: logger.child({ mod: 'homeassistant' }) }));
    if (c.homebridge?.enabled) devices.register('homebridge', new HomebridgeProvider({ ...c.homebridge, logger: logger.child({ mod: 'homebridge' }) }));
    if (c.matter?.enabled) devices.register('matter', new MatterProvider({ dataDir, logger: logger.child({ mod: 'matter' }) }));
    if (c.envisalink?.enabled) devices.register('envisalink', new EnvisalinkProvider({ ...c.envisalink, logger: logger.child({ mod: 'envisalink' }) }));
    devices.register('virtual', new VirtualProvider());
  };
  registerProviders(cfg);

  // fingerprint of the device/bridge/zone config the providers were built from
  const deviceFingerprint = (c) => JSON.stringify({
    l: [c.lutron?.enabled !== false, c.lutron?.host, c.lutron?.port, c.lutron?.mock],
    h: [c.hubitat?.enabled, c.hubitat?.host, c.hubitat?.appId],
    e: [c.ecobee?.enabled, Boolean(c.ecobee?.refreshToken)],
    a: [c.homeassistant?.enabled, c.homeassistant?.host],
    b: [c.homebridge?.enabled, c.homebridge?.host],
    m: c.matter?.enabled, v: [c.envisalink?.enabled, c.envisalink?.host],
    z: [...new Set((c.zones ?? []).map((z) => `${z.source ?? 'lutron'}:${z.externalId ?? z.id}`))].sort(),
  });
  let providerFingerprint = deviceFingerprint(cfg);

  const tracker = new ZoneStateTracker({ stateStore, logger: logger.child({ mod: 'tracker' }) });
  devices.on('zoneLevel', (e) => tracker.onZoneLevel(e));
  const notifier = new Notifier({ configStore, logger: logger.child({ mod: 'notify' }) });
  // Drive-authority: a primary always acts; a standby only when it has taken
  // over. Gates driving lights AND all notifications so an INACTIVE backup
  // never acts or alerts (except the failover events, which are its whole job).
  let failover; // assigned below; referenced lazily by hasControl
  // An active standby that has provably seen the primary come back stands down
  // from driving before the formal release (FailoverManager.drivesLights) —
  // that shrinks the window where BOTH instances drive every zone, which is
  // not just redundant but can falsely latch zones.
  const hasControl = () => configStore.get().instance.role === 'primary' || Boolean(failover?.drivesLights());
  const enforcement = new EnforcementEngine({
    configStore, stateStore, tracker, devices, canAct: hasControl,
    // Assigned just below; a deviation can only arrive once the scheduler is up.
    isTestMode: () => scheduler.isTestMode(),
    logger: logger.child({ mod: 'enforce' }),
  });
  enforcement.on('latched', ({ zone, level, until, test }) => {
    const cfg = configStore.get();
    const zoneName = cfg.zones.find((z) => z.id === zone)?.friendlyName;
    notifier.send('enforcement-latch', { zone, zoneName, level, until, test, untilHuman: humanHavdalah(until, cfg.location?.tzid) });
  });
  const scheduler = new Scheduler({
    // no zoneLock key: the Scheduler ADOPTS enforcement's — see its constructor
    configStore, stateStore, tracker, enforcement, devices, notifier, canAct: hasControl,
    logger: logger.child({ mod: 'scheduler' }),
  });
  // enforcement judges the cluster window on the scheduler's clock, so Child
  // Lock works inside test mode's virtual time too
  enforcement.setClock(() => scheduler.now());
  failover = new FailoverManager({
    configStore, stateStore, scheduler, devices, notifier, logger: logger.child({ mod: 'failover' }),
  });

  // Device/bridge/zone config can change at RUNTIME on both roles — the setup
  // wizard enabling Lutron + importing zones on a fresh primary, a Settings
  // save, or a standby mirroring the primary. Providers are built from config,
  // so any such change rebuilds them in place; without this a fresh instance
  // (which boots with every bridge disabled) hits "no provider registered for
  // source lutron" until a manual restart.
  configStore.on('change', (next) => {
    const fp = deviceFingerprint(next);
    if (fp === providerFingerprint) return;
    providerFingerprint = fp;
    logger.warn('device/bridge/zone config changed — rebuilding device providers');
    registerProviders(next);
    // (re)connect only when this instance is in control — a primary always,
    // a standby only after takeover (an idle standby stays off the bridge) —
    // and only if not already connected, so back-to-back changes can't stack
    // parallel retry chains.
    if (hasControl() && !devices.connected) connectWithRetry(devices, logger);
  });

  const versionChecker = new VersionChecker({
    stateStore, configStore, current: APP_VERSION, notifier, isActive: hasControl, logger: logger.child({ mod: 'version' }),
  });

  // Notify when the bridge stays unreachable >5 minutes, and send an all-clear
  // when it comes back — but only if we actually alerted about the outage.
  let disconnectTimer = null;
  let alertedDisconnect = false;
  devices.on('disconnected', () => {
    disconnectTimer = setTimeout(() => { alertedDisconnect = true; notifier.send('lutron-disconnected', { minutes: 5 }); }, 5 * 60_000);
    disconnectTimer.unref?.();
  });
  devices.on('connected', () => {
    clearTimeout(disconnectTimer);
    if (alertedDisconnect) { alertedDisconnect = false; notifier.send('bridge-reconnected', {}); }
  });
  devices.on('ready', () => scheduler.reconcile().catch((err) => logger.error({ err: err.message }, 'reconcile on ready failed')));

  const app = createApp({
    dataDir,
    configStore, stateStore, scheduler, tracker, enforcement, devices,
    failover, versionChecker, notifier, ring, logDir, logger,
  });
  const server = app.listen(PORT, () => logger.info({ port: PORT }, 'http listening'));

  await scheduler.start();
  versionChecker.start();

  const isPrimary = () => configStore.get().instance.role === 'primary';
  if (isPrimary()) {
    connectWithRetry(devices, logger);
  } else {
    failover.start();
    logger.info('standby mode: monitoring primary, Lutron connection deferred until takeover');
  }

  // ── uptime heartbeat + outage-recovery notice ──────────────────────────────
  // Persist a periodic "alive" timestamp so a boot can tell whether it's a quick
  // restart (seconds) or recovery from a real outage (power loss, crash). Only
  // the in-control instance with a configured location reports it.
  const lastBeat = stateStore.get().lastHeartbeat ? new Date(stateStore.get().lastHeartbeat).getTime() : null;
  if (lastBeat && hasControl() && configStore.get().location.lat) {
    const downMs = Date.now() - lastBeat;
    if (downMs > 5 * 60_000) notifier.send('app-recovered', { downtime: humanizeDuration(downMs) });
  }
  const beat = () => { stateStore.get().lastHeartbeat = new Date().toISOString(); stateStore.save(); };
  beat();
  setInterval(beat, 5 * 60_000).unref?.();

  // ── primary watches for the backup going silent ────────────────────────────
  // The backup polls our /api/health with the sync token (recorded in memory).
  // If it was checking in and then stops, warn that failover coverage is gone.
  if (isPrimary()) {
    let alertedBackupDown = false;
    setInterval(() => {
      if (!failover.backupSeen) return; // no backup has ever checked in
      const silentMs = Date.now() - failover.backupLastSeenAt;
      const threshold = Math.max(120_000, (configStore.get().failover.pollSeconds ?? 10) * 1000 * 6);
      if (silentMs > threshold && !alertedBackupDown) {
        alertedBackupDown = true;
        notifier.send('backup-down', { minutes: Math.round(silentMs / 60_000) });
      } else if (silentMs <= threshold && alertedBackupDown) {
        alertedBackupDown = false;
        notifier.send('backup-recovered', {});
      }
    }, 60_000).unref?.();
  }

  // Nightly config snapshot (data/backups, 14 rolling days) + one at boot if
  // today's is missing — a machine asleep at 02:30 still gets its daily copy.
  writeDailyBackup(dataDir, configStore.get(), logger, { onlyIfMissing: true });
  new Cron('30 2 * * *', { timezone: configStore.get().location.tzid || 'UTC' }, () => {
    writeDailyBackup(dataDir, configStore.get(), logger);
  });

  // Pre-Yom-Tov summary: daily 9am local, notify for clusters starting within N days.
  new Cron('0 9 * * *', { timezone: configStore.get().location.tzid || 'UTC' }, async () => {
    try {
      const c = configStore.get();
      if (!c.location.lat || (!isPrimary() && !failover.active)) return;
      const days = c.notifications.preYomTovSummaryDays;
      const calendar = new CalendarService({ location: c.location, times: c.times, locale: c.display?.locale });
      const horizon = new Date(Date.now() + days * 86400_000).toISOString().slice(0, 10);
      const today = new Date().toISOString().slice(0, 10);
      const notified = stateStore.get().notifiedClusters ?? [];
      // scan far enough that a festival's later clusters are grouped in even
      // when only the first one is inside the notify horizon
      const far = new Date(Date.now() + (days + 25) * 86400_000).toISOString().slice(0, 10);
      const allClusters = calendar.clusters(today, far);
      for (const cluster of allClusters) {
        if (cluster.startsAt.getTime() < Date.now() || notified.includes(cluster.id)) continue;
        if (cluster.startsAt.getTime() > Date.now() + days * 86400_000) break;
        // skip plain weekly Shabbos — the summary is for Yamim Tovim only
        if (cluster.days.every((d) => d.dayType === 'shabbos')) continue;
        // the WHOLE occurrence: pull in adjacent clusters (within ~15 days) so
        // e.g. Sukkos I-II + Shmini Atzeres/Simchas Torah share one email
        const group = [cluster];
        for (const c2 of allClusters) {
          if (c2 === cluster || group.includes(c2)) continue;
          const gap = (c2.startsAt.getTime() - group[group.length - 1].endsAt.getTime()) / 86400_000;
          if (gap >= 0 && gap < 15 && festivalOfCluster(c2) && festivalOfCluster(c2) === festivalOfCluster(cluster)) group.push(c2);
        }
        // attach the printable one-page Zmanim PDF for Pesach / Sukkos / Shavuos
        const festival = festivalOfCluster(cluster);
        const attachments = festival
          ? [{ filename: `${festival}-zmanim.pdf`, content: await pdfBuffer(yomTovSheet(calendar, festival, today)) }].filter((a) => a.content)
          : [];
        // Pesach also gets the Sefiras HaOmer counting chart
        if (festival === 'pesach') {
          const omer = await pdfBuffer(omerSheet(calendar, today));
          if (omer) attachments.push({ filename: 'sefiras-haomer.pdf', content: omer });
        }
        await notifier.send('pre-yomtov-summary', { ...buildClusterSummary(c, group), attachments });
        stateStore.get().notifiedClusters = [...notified, ...group.map((g) => g.id)].slice(-20);
        stateStore.save({ flush: true });
      }
    } catch (err) {
      logger.error({ err: err.message }, 'pre-YT summary job failed');
    }
  });

  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => {
      // logged synchronously to disk so the reason for a restart is always
      // recorded even if the async streams don't flush before exit
      logger.info({ sig }, 'shutting down');
      try { fs.appendFileSync(path.join(logDirPath, 'app.log'), `${JSON.stringify({ level: 30, time: Date.now(), sig, msg: `shutting down (${sig})` })}\n`); } catch { /* ignore */ }
      scheduler.stop();
      failover.stop();
      devices.close();
      stateStore.close();
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 3000).unref();
    });
  }
}

function humanizeDuration(ms) {
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min} minute${min === 1 ? '' : 's'}`;
  const hr = Math.round((min / 60) * 10) / 10;
  return `${hr} hour${hr === 1 ? '' : 's'}`;
}

function connectWithRetry(devices, logger, delayMs = 5000) {
  devices.connect().catch((err) => {
    logger.warn({ err: err.message, retryInMs: delayMs }, 'initial devices connect failed, retrying');
    setTimeout(() => connectWithRetry(devices, logger, Math.min(delayMs * 2, 60_000)), delayMs).unref?.();
  });
}

// A boot failure (bad config, port in use, disk unwritable…) must be
// diagnosable from the log file after the container restart-loops, not just
// from `docker logs`.
main().catch((err) => logFatal('startup-failed', err, { exit: true }));
