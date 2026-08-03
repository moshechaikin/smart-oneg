import { fileURLToPath } from 'node:url';

const APP_NAME = 'SmartOneg';
const TAGLINE = 'The Ultimate Shabbos & Yom Tov Smart Home Automation App';

// A small (192px, ~40KB) logo, embedded as a CID inline image so it renders in
// email clients without the app needing to be publicly hosted.
export const LOGO_PATH = fileURLToPath(new URL('../../public/icons/icon-192.png', import.meta.url));
export const LOGO_CID = 'smartoneg-logo';

export function logoAttachment() {
  return { filename: 'smartoneg.png', path: LOGO_PATH, cid: LOGO_CID };
}

/**
 * Wrap notification content in a branded, email-client-safe HTML layout
 * (table-based, inline styles). `accent` colors the title bar.
 */
export function emailShell({ title, innerHtml, accent = '#e0a63c' }) {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <!-- declare both schemes so clients (esp. iOS Mail) don't auto-invert into an
       odd half-dark look; the card stays light, and the area AROUND it uses the
       client's own page background instead of a forced-white strip -->
  <meta name="color-scheme" content="light dark" />
  <meta name="supported-color-schemes" content="light dark" />
</head>
<body style="margin:0;padding:0;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:0;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e7e5e4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
        <!-- header -->
        <tr><td style="background:#0b1220;padding:20px 24px;">
          <table role="presentation" cellpadding="0" cellspacing="0"><tr>
            <td style="padding-right:14px;" valign="middle">
              <img src="cid:${LOGO_CID}" width="48" height="48" alt="${APP_NAME}" style="display:block;border-radius:12px;" />
            </td>
            <td valign="middle">
              <div style="color:#ffffff;font-size:22px;font-weight:700;letter-spacing:-0.02em;line-height:1;">${APP_NAME}</div>
              <div style="color:#a8a29e;font-size:12px;margin-top:4px;">${TAGLINE}</div>
            </td>
          </tr></table>
        </td></tr>
        <!-- accent bar -->
        <tr><td style="height:4px;background:${accent};font-size:0;line-height:0;">&nbsp;</td></tr>
        <!-- body -->
        <tr><td style="padding:28px 24px;color:#292524;font-size:15px;line-height:1.55;">
          <h1 style="margin:0 0 16px;font-size:20px;font-weight:700;color:#1c1917;">${title}</h1>
          ${innerHtml}
        </td></tr>
        <!-- footer -->
        <tr><td style="padding:18px 24px;border-top:1px solid #f0efee;background:#fafaf9;color:#a8a29e;font-size:12px;">
          <b style="color:#78716c;">${APP_NAME}</b>, ${TAGLINE}<br/>
          You're receiving this because email notifications are enabled in Settings.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
