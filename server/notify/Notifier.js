import nodemailer from 'nodemailer';
import webpush from 'web-push';
import { emailShell, escapeHtml, logoAttachment } from './emailTemplate.js';

// Pictographic emoji look out of place in a formal email subject/heading, so we
// strip them there. The same titles keep their emoji on ntfy/push, where a
// leading glyph reads as normal.
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/gu;
const deEmoji = (s) => String(s).replace(EMOJI_RE, '').replace(/\s{2,}/g, ' ').trim();

/**
 * Fan-out notifications to every enabled channel (Gmail SMTP, ntfy.sh, web
 * push). Channel failures are logged, never thrown, a dead SMTP server must
 * not take down light scheduling.
 */
export class Notifier {
  constructor({ configStore, logger = null }) {
    this.config = configStore;
    this.log = logger;
  }

  /** @param {string} event  e.g. takeover|release|primary-down|lutron-disconnected|
   *                          pre-yomtov-summary|enforcement-latch|action-failed|test */
  async send(event, payload = {}) {
    const msg = buildMessage(event, payload);
    const cfg = this.config.get().notifications;
    const cat = EVENT_CATEGORY[event]; // undefined/'*' → always deliver (e.g. test)
    // A category is on for a channel unless explicitly set false.
    const on = (channel) => cat === undefined || cat === '*'
      || cfg.categories?.[cat]?.[channel] !== false;
    const attachments = payload.attachments ?? [];
    const results = await Promise.allSettled([
      cfg.email?.enabled && on('email') ? this.#email(cfg.email, msg, attachments) : null,
      cfg.ntfy?.enabled && on('ntfy') ? this.#ntfy(cfg.ntfy, msg) : null,
      cfg.push?.subscriptions?.length && on('push') ? this.#push(cfg.push, msg) : null,
    ]);
    const channels = ['email', 'ntfy', 'push'];
    results.forEach((r, i) => {
      if (r.status === 'rejected') this.log?.error({ event, channel: channels[i], err: String(r.reason) }, 'notification channel FAILED');
    });
    const channelResults = Object.fromEntries(results.map((r, i) => [
      channels[i],
      r.status === 'rejected' ? `FAILED: ${String(r.reason?.message ?? r.reason)}` : (r.value === null ? 'off' : (r.value ?? 'ok')),
    ]));
    this.log?.info({ event, category: cat, title: msg.title, channels: channelResults }, 'notification dispatched');
    return { ...msg, channels: channelResults };
  }

  async #email(cfg, msg, attachments = []) {
    const transporter = nodemailer.createTransport({
      host: cfg.host, port: cfg.port, secure: cfg.port === 465,
      auth: { user: cfg.user, pass: cfg.appPassword },
    });
    // emails carry no emoji in the subject or heading (see deEmoji)
    const title = deEmoji(msg.title);
    const inner = msg.html ?? `<p style="margin:0;">${escapeHtml(msg.body)}</p>`;
    await transporter.sendMail({
      from: `SmartOneg <${cfg.user}>`, to: cfg.to || cfg.user,
      // [SmartOneg] prefix makes these easy to filter in the inbox
      subject: `[SmartOneg] ${title}`,
      text: msg.body,
      html: emailShell({ title, innerHtml: inner, accent: msg.accent ?? '#e0a63c' }),
      attachments: [logoAttachment(), ...attachments],
    });
  }

  async #ntfy(cfg, msg) {
    const res = await fetch(`${cfg.server.replace(/\/$/, '')}/${cfg.topic}`, {
      method: 'POST',
      body: msg.body,
      // HTTP header values must be ByteString (Latin-1); an emoji in the title
      // (e.g. "🏠 Away mode is on") throws, so strip it — the Tags header already
      // carries the icon for ntfy.
      headers: { Title: deEmoji(msg.title), Priority: msg.priority ?? 'default', Tags: msg.tags ?? 'bulb' },
    });
    if (!res.ok) throw new Error(`ntfy ${res.status}`);
  }

  async #push(cfg, msg) {
    // The VAPID subject must be a real contact URL: Apple's push service
    // (iOS PWA) rejects invalid subjects like "admin@localhost" with a
    // 403 BadJwtToken, which looked like "push silently does nothing".
    webpush.setVapidDetails('https://smartoneg.com', cfg.vapidPublicKey, cfg.vapidPrivateKey);
    const payload = JSON.stringify({ title: msg.title, body: msg.body });
    const dead = [];
    let ok = 0;
    const failures = [];
    await Promise.all(cfg.subscriptions.map(async (sub) => {
      const host = (() => { try { return new URL(sub.endpoint).host; } catch { return '?'; } })();
      try {
        await webpush.sendNotification(sub, payload, { TTL: 3600, urgency: 'high' });
        ok++;
        this.log?.info({ host }, 'web push delivered');
      } catch (err) {
        // 404/410 = subscription gone (app reinstalled etc.), prune quietly.
        // EVERYTHING else must be loud: these failures were being swallowed.
        if (err.statusCode === 404 || err.statusCode === 410) {
          dead.push(sub.endpoint);
          this.log?.warn({ host, status: err.statusCode }, 'web push subscription expired, pruning');
        } else {
          failures.push(`${host}: ${err.statusCode ?? ''} ${err.body ?? err.message}`.trim());
          this.log?.error({ host, status: err.statusCode, body: err.body, err: err.message }, 'web push send FAILED');
        }
      }
    }));
    if (dead.length) {
      this.config.update({
        notifications: { push: { ...cfg, subscriptions: cfg.subscriptions.filter((s) => !dead.includes(s.endpoint)) } },
      });
    }
    if (ok === 0 && failures.length) throw new Error(`push failed for every device: ${failures.join(' | ')}`);
    // summary surfaces in the Send-test toast and the dispatch log line
    return `delivered ${ok}/${cfg.subscriptions.length}${failures.length ? `, failed: ${failures.join(' | ')}` : ''}${dead.length ? `, pruned ${dead.length} expired` : ''}`;
  }
}

const RED = '#dc2626';
const AMBER = '#e0a63c';
const GREEN = '#059669';

/** User-facing notification categories (for the Settings opt-out matrix). */
export const NOTIFICATION_CATEGORIES = [
  { key: 'bridge', label: 'Bridge & action failures', desc: 'Lost connection to the bridge, or a scheduled light action failed to apply.' },
  { key: 'failover', label: 'Backup / failover', desc: 'The backup instance took over, or the primary went unreachable / recovered.' },
  { key: 'childlock', label: 'Child Lock overrides', desc: "A non-Jew's override latched a device until havdalah." },
  { key: 'summary', label: 'Pre–Yom Tov summaries', desc: 'The schedule preview emailed a few days before each Shabbos/Yom Tov.' },
  { key: 'modes', label: 'Guest, away & test mode', desc: 'Guest mode and away mode turning on/off, and test-mode auto-exit.' },
  { key: 'updates', label: 'Software updates', desc: 'A newer SmartOneg release is available to install.' },
  { key: 'system', label: 'App restarts & recovery', desc: 'The app came back online after an outage (power loss, crash, reboot).' },
];

/** Which category each event belongs to ('*' = always deliver, ignore filters). */
const EVENT_CATEGORY = {
  'lutron-disconnected': 'bridge', 'bridge-reconnected': 'bridge', 'action-failed': 'bridge',
  takeover: 'failover', release: 'failover', 'primary-down': 'failover',
  'backup-down': 'failover', 'backup-recovered': 'failover',
  'enforcement-latch': 'childlock',
  'pre-yomtov-summary': 'summary',
  'guest-mode-off': 'modes', 'guest-mode-on': 'modes',
  'away-mode-on': 'modes', 'away-mode-off': 'modes', 'test-mode-auto-exit': 'modes',
  'update-available': 'updates',
  'app-recovered': 'system',
  test: '*',
};

export function buildMessage(event, p) {
  switch (event) {
    case 'takeover': {
      // instance.name is optional (and has no UI to set it yet), so only quote
      // it when present — otherwise the body reads `The backup instance ""`.
      const who = p.name ? `The backup instance "${p.name}"` : 'The backup instance';
      return { title: '⚠️ Backup instance has taken over', priority: 'high', tags: 'warning', accent: RED,
        body: `${who} could not reach the primary and is now controlling the lights.` };
    }
    case 'release':
      return { title: 'Backup instance released control', tags: 'white_check_mark', accent: GREEN,
        body: 'The primary instance is healthy again; the backup returned to standby.' };
    case 'primary-down':
      return { title: '⚠️ Primary instance unreachable', priority: 'high', tags: 'warning', accent: RED,
        body: `Health checks to the primary failed ${p.failures ?? '?'} times.` };
    case 'backup-down':
      return { title: '⚠️ Backup instance is offline', priority: 'high', tags: 'warning', accent: RED,
        body: `The primary hasn't heard from the backup for about ${p.minutes ?? '?'} minutes. If the primary goes down now, nothing will take over, check the backup instance.` };
    case 'backup-recovered':
      return { title: 'Backup instance is back', tags: 'white_check_mark', accent: GREEN,
        body: 'The backup is checking in with the primary again and is ready to take over if needed.' };
    case 'lutron-disconnected':
      return { title: '⚠️ Lutron bridge unreachable', priority: 'high', tags: 'rotating_light', accent: RED,
        body: `The app lost its telnet connection to the Lutron bridge for over ${p.minutes ?? 5} minutes.` };
    case 'bridge-reconnected':
      return { title: 'Bridge reconnected', tags: 'white_check_mark', accent: GREEN,
        body: 'The bridge is reachable again and the correct scheduled state has been re-applied.' };
    case 'enforcement-latch': {
      const device = p.zoneName ?? `#${p.zone}`;
      const until = p.untilHuman ?? p.until;
      const real = `Device "${device}" is now held at ${p.level}% until ${until}. Scheduled changes are paused for it.`;
      if (p.test) {
        // Test-mode dry run: no real override happened. Show exactly what the real
        // alert would say, framed loudly as a preview.
        return { title: '🧪 Child Lock override — TEST MODE preview', tags: 'test_tube', accent: AMBER, priority: 'low',
          body: `TEST MODE — this is only a preview. No override actually happened, and "${device}" will keep following its schedule.\n\n`
            + `On a real Shabbos or Yom Tov, an override like this would send you:\n\n“${real}”`,
          html: `<div style="border-left:4px solid ${AMBER};background:#fffbeb;padding:10px 14px;border-radius:6px;margin:0 0 12px;">`
            + `<b style="color:#92400e;">TEST MODE — preview only.</b> No override actually happened, and <b>${escapeHtml(device)}</b> will keep following its schedule.</div>`
            + `<p style="margin:0 0 8px;">On a real Shabbos or Yom Tov, an override like this would send you:</p>`
            + `<blockquote style="margin:0;padding:10px 14px;border-left:3px solid #d6d3d1;color:#57534e;">${escapeHtml(real)}</blockquote>` };
      }
      return { title: 'Child Lock override engaged', tags: 'hand', accent: AMBER, body: real };
    }
    case 'action-failed': {
      // describe the target by action type — a flash/preset/mode carries no level%
      const a = p.action ?? {};
      const target = a.type === 'flash' ? 'flash reminder'
        : a.level != null ? `${a.level}%`
        : a.preset != null ? `preset "${a.preset}"`
        : a.hvacMode != null ? `${a.hvacMode} mode`
        : a.type ?? 'action';
      const dev = p.deviceName ?? `#${a.zone}`;
      return { title: '⚠️ Scheduled light action failed', priority: 'high', tags: 'x', accent: RED,
        body: `Device "${dev}" → ${target} failed: ${p.error}` };
    }
    case 'pre-yomtov-summary':
      return { title: `Upcoming: ${p.label}, ${p.dateRange}`, tags: 'candle', accent: AMBER,
        body: p.textSummary ?? '', html: p.htmlSummary };
    case 'guest-mode-on':
      return { title: 'Guest mode turned on', tags: 'house', accent: AMBER,
        body: p.label
          ? `Guest mode is on for ${p.label}. Guest rules override the regular schedule for the devices they name; it turns off automatically after havdalah${p.endsHuman ? ` (${p.endsHuman})` : ''}.`
          : 'Guest mode is on, guest rules override the regular schedule for the devices they name.' };
    case 'guest-mode-off':
      return { title: 'Guest mode turned off', tags: 'house', accent: GREEN,
        body: 'The Shabbos/Yom Tov it was enabled for has ended, so guest mode automatically switched off. Schedules are back to normal.' };
    case 'app-recovered':
      return { title: 'SmartOneg is back online', tags: 'white_check_mark', accent: GREEN,
        body: `The app restarted after being down for about ${p.downtime ?? 'a while'}.` };
    case 'away-mode-on': {
      // The preset label already embeds the date (e.g. "Shabbos · Aug 8"); only
      // fall back to the raw range for a custom window, collapsing a single-day
      // window to one date — so it never doubles up (matches the Dashboard card).
      const range = p.from && p.to ? (p.from === p.to ? p.from : `${p.from} → ${p.to}`) : null;
      const whenText = p.label ? ` for ${p.label}` : (range ? ` (${range})` : '');
      return { title: '🏠 Away mode is on', tags: 'house', accent: AMBER,
        body: `Away mode is on${whenText}. Your lights will run a presence-simulated version of your schedule during Shabbos/Yom Tov, jittered, with shorter lit periods so the house looks lived-in. It turns off automatically after the window.` };
    }
    case 'away-mode-off':
      return { title: 'Away mode turned off', tags: 'house', accent: GREEN,
        body: 'The away window has passed, so away mode automatically switched off. Schedules are back to normal.' };
    case 'test-mode-auto-exit':
      return { title: 'Test mode auto-exited', tags: 'warning', accent: AMBER,
        body: 'A real Shabbos/Yom Tov schedule has come into effect, so test mode turned itself off and handed control to your real schedule.' };
    case 'update-available': {
      const cmd = 'docker compose pull &amp;&amp; docker compose up -d';
      return { title: `⭐ SmartOneg ${p.latest} is available`, tags: 'arrow_up', accent: AMBER,
        body: `A newer version (${p.latest}) is available, you're on ${p.current}.`
          + `${p.notes ? `\n\n${p.notes}` : ''}`
          + `\n\nUpdate from Settings → Software updates (one click if the Docker socket is mounted), or on the host run:\n  docker compose pull && docker compose up -d`
          + `${p.url ? `\n\nRelease notes: ${p.url}` : ''}`,
        html: `<p style="margin:0 0 10px;">A newer version <b>${escapeHtml(p.latest ?? '')}</b> is available, you're on ${escapeHtml(p.current ?? '')}.</p>`
          + `${p.notes ? `<p style="margin:0 0 10px;white-space:pre-wrap;">${escapeHtml(p.notes)}</p>` : ''}`
          + `<p style="margin:0 0 8px;">Update from <b>Settings → Software updates</b> (one click if the Docker socket is mounted), or on the host run:</p>`
          + `<pre style="background:#0c0a09;color:#e7e5e4;padding:10px 12px;border-radius:8px;overflow-x:auto;margin:0;">${cmd}</pre>`
          + `${p.url ? `<p style="margin:16px 0 0;"><a href="${escapeHtml(p.url)}" style="display:inline-block;background:#d97706;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:10px 20px;border-radius:10px;">Release notes</a></p>` : ''}` };
    }
    case 'test':
      return { title: 'SmartOneg test notification', tags: 'tada', accent: AMBER,
        body: 'If you can read this, this channel is configured correctly.' };
    default:
      return { title: `SmartOneg: ${event}`, accent: AMBER, body: JSON.stringify(p) };
  }
}
