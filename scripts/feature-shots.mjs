// Marketing feature screenshots: boots the real app (mock integrations) with the
// curated DEMO_SEED config and captures tight, feature-focused element crops in
// BOTH light and dark themes for smartoneg.com's "See it in action" section.
//
// Run: node scripts/feature-shots.mjs
// Output: smartoneg.com/assets/screenshots/features/<name>.png (+ -dark.png)
import { chromium } from '@playwright/test';
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import { DEMO_SEED } from '../smartoneg.com/demo/demo-seed.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'smartoneg.com/assets/screenshots/features');
const PORT = 8132;
const PASSWORD = 'demo-password-1';
const dataDir = path.join(ROOT, 'test-results/feature-shot-data');

// ---- build a bootable config from DEMO_SEED --------------------------------
const config = JSON.parse(JSON.stringify(DEMO_SEED));
// fill the __SET__ secret placeholders
config.auth.passwordHash = bcrypt.hashSync(PASSWORD, 10);
config.auth.sessionSecret = 'feature-shot-session-secret';
// keep only the integrations that have a working mock; disable the ones that
// would spawn real network pollers to 192.168.x hosts (and show as offline)
config.lutron.mock = true;
config.envisalink.mock = true;
config.hubitat.enabled = false;
config.homeassistant.enabled = false;
config.ecobee.enabled = false;
config.homebridge.enabled = false;
config.matter.enabled = false;
// blank any remaining secret placeholders so schema validation is happy
const scrub = (o) => {
  for (const k of Object.keys(o)) {
    if (o[k] === '__SET__') o[k] = '';
    else if (o[k] && typeof o[k] === 'object') scrub(o[k]);
  }
};
scrub(config);
config.setupComplete = true;

// give one Shabbos-day rule a populated seasonal condition so the schedule
// editor's "Seasonal conditions" card has something to show when captured
try {
  const dayRules = config.schedules.shabbos.default.rules;
  const target = dayRules.find((r) => /seudah shlishis/i.test(r.label)) ?? dayRules.find((r) => r.trigger?.day === 'day');
  if (target) {
    target.trigger.conditions = [{
      if: { zman: 'sunset', cmp: 'after', time: '19:00', day: target.trigger.day },
      then: { kind: 'fixed', time: '18:00', day: target.trigger.day },
    }];
  }
  // add a Flash (reminder) rule so the "flash reminder" feature has a card
  dayRules.unshift({
    id: 'r-flash-demo', label: 'Mincha reminder', enabled: true,
    action: { type: 'flash', zone: 3, zones: [3, 4], times: 1 },
    trigger: { kind: 'fixed', time: '14:10', nextDay: false, day: 'day', clamp: {}, conditions: [] },
  });
} catch { /* seed shape changed — editor shots just won't show these */ }

fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify(config, null, 2));
fs.mkdirSync(OUT, { recursive: true });

// ---- boot the server -------------------------------------------------------
const server = spawn('node', ['server/index.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });

await new Promise((resolve, reject) => {
  const t0 = Date.now();
  const poll = async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/health`);
      if (res.ok) return resolve();
    } catch { /* not up yet */ }
    if (Date.now() - t0 > 15000) return reject(new Error(`server never came up.\n${serverLog}`));
    setTimeout(poll, 250);
  };
  poll();
});
console.log('server up on', PORT);

// ---- shot definitions ------------------------------------------------------
// Each shot: navigate to `route`, run optional `prep`, then crop `target(page)`.
const base = `http://127.0.0.1:${PORT}`;
const card = (page, text) => page.locator('.card', { hasText: text }).first();

const SHOTS = [
  {
    name: 'status-tiles', route: '#/dashboard',
    target: (page) => page.locator('main .grid').first(),
  },
  {
    // the vertical rail with yellow dots (bullets) + times + the scene block.
    // The dots are absolutely positioned LEFT of the rail's box (-left-1.65rem),
    // so screenshotting the rail alone clips them — wrap it with left padding.
    name: 'timeline', route: '#/dashboard',
    prep: async (page) => {
      await page.evaluate(() => {
        const rail = [...document.querySelectorAll('.border-l-2')].find((e) => /Scene Start: Evening lights/.test(e.textContent));
        if (rail && !rail.closest('[data-shot="timeline"]')) {
          const w = document.createElement('div');
          w.setAttribute('data-shot', 'timeline');
          w.style.display = 'inline-block';
          w.style.paddingLeft = '30px';
          rail.parentNode.insertBefore(w, rail);
          w.appendChild(rail);
        }
      });
      await page.locator('[data-shot="timeline"]').waitFor({ timeout: 6000 });
    },
    target: (page) => page.locator('[data-shot="timeline"]'),
  },
  {
    name: 'guest-away', route: '#/dashboard',
    target: (page) => page.locator('main .grid').nth(1),
  },
  {
    name: 'device-childlock', route: '#/devices',
    target: (page) => card(page, 'Dining Room Main Lights'),
  },
  {
    name: 'scene-contents', route: '#/scenes',
    target: (page) => card(page, 'Evening lights'),
  },
  {
    name: 'location-settings', route: '#/settings',
    target: (page) => card(page, 'Location & halachic times'),
  },
  {
    // advance a few months so the shot shows a generic month, not today's
    name: 'calendar-month', route: '#/calendar',
    prep: async (page) => {
      for (let i = 0; i < 3; i++) { await page.getByRole('button', { name: 'Next month' }).click(); await page.waitForTimeout(150); }
      await page.waitForTimeout(300);
    },
    target: (page) => page.locator('main .card').first(),
  },
  {
    // the test-mode card loads async (fetches the calendar), so wait for its
    // loaded section title before cropping
    name: 'test-mode', route: '#/settings',
    prep: async (page) => {
      await openSettingsTab(page, 'system');
      // two cards mention "test mode", so mark the exact one by its section title
      await page.locator('.section-title', { hasText: 'Test mode' }).first().waitFor({ timeout: 10000 });
      await page.evaluate(() => {
        const t = [...document.querySelectorAll('.section-title')].find((e) => /test mode/i.test(e.textContent));
        const c = t?.closest('.card');
        if (c) c.setAttribute('data-shot', 'testmode');
      });
      await page.waitForTimeout(400);
    },
    target: (page) => page.locator('[data-shot="testmode"]'),
  },
  {
    // desktop width renders each rule as an inline editor card (no modal)
    name: 'zman-rule', route: '#/schedules',
    prep: (page) => enterShabbosEditor(page),
    target: (page) => page.locator('.card', { hasText: 'Fine-tuning' }).first(),
  },
  {
    // the seed injects one seasonal condition, so that rule's Fine-tuning
    // auto-expands and shows the "Seasonal conditions" block. Mark that exact
    // rule card by its name-input value (hasText can't match input values).
    name: 'seasonal-conditions', route: '#/schedules',
    prep: async (page) => {
      await enterShabbosEditor(page);
      await page.evaluate(() => {
        const c = [...document.querySelectorAll('.card')]
          .find((el) => el.querySelector('input')?.value?.includes('seudah shlishis'));
        if (c) c.setAttribute('data-shot', 'seasonal');
      });
      await page.locator('[data-shot="seasonal"]').getByText('Seasonal conditions').first().waitFor({ timeout: 6000 });
    },
    target: (page) => page.locator('[data-shot="seasonal"]'),
  },
  {
    name: 'flash-reminder', route: '#/schedules',
    prep: (page) => enterShabbosEditor(page),
    target: (page) => page.locator('.card', { hasText: 'Flash (reminder)' }).first(),
  },
  {
    name: 'situations', route: '#/schedules',
    prep: (page) => enterShabbosEditor(page),
    target: (page) => page.locator('.card', { hasText: 'After Friday Yom Tov' }).first(),
  },
  {
    name: 'copy-rules', route: '#/schedules',
    prep: async (page) => {
      await enterShabbosEditor(page);
      await page.getByRole('button', { name: /Copy from/ }).first().click();
      await page.locator('#modal-root').getByText('Copy rules from').first().waitFor({ timeout: 6000 });
      await page.waitForTimeout(300);
    },
    target: (page) => page.locator('#modal-root .card').first(),
  },
  {
    name: 'backup-restore', route: '#/settings',
    prep: (page) => openSettingsTab(page, 'system'),
    target: (page) => card(page, 'Backup & Restore'),
  },
  {
    name: 'instance-failover', route: '#/settings',
    prep: (page) => openSettingsTab(page, 'system'),
    target: (page) => card(page, 'Primary & Backup Instance'),
  },
  {
    name: 'printable-shabbos', route: '#/schedules',
    prep: (page) => openHolidayOverview(page, 'Shabbos'),
    target: (page) => card(page, 'Printable Shabbos times'),
  },
  {
    name: 'festival-overview', route: '#/schedules',
    prep: (page) => openHolidayOverview(page, 'Sukkos'),
    target: (page) => page.locator('main .card').first(),
  },
];

async function enterShabbosEditor(page) {
  const shCard = page.locator('.card', { hasText: 'Shabbos' }).first();
  await shCard.getByRole('button').filter({ hasText: 'Evening lights before candle lighting' }).first().click();
  await page.getByText('The day itself').first().waitFor({ timeout: 6000 });
  await page.waitForTimeout(700);
}

async function openSettingsTab(page, tabId) {
  // the settings page restores its active tab from localStorage, so select the
  // tab that way (clicking the pill row is flaky at some widths)
  await page.evaluate((id) => localStorage.setItem('settings-tab', id), tabId);
  await page.reload();
  await page.waitForTimeout(1200);
}

async function openHolidayOverview(page, groupName) {
  const cardEl = page.locator('.card', { hasText: groupName }).first();
  await cardEl.getByRole('button', { name: /View/ }).first().click();
  await page.waitForTimeout(900);
}

// ---- capture ---------------------------------------------------------------
// ONLY=name1,name2 limits the run to those feature crops (see SHOTS[].name).
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(',').map((s) => s.trim())) : null;
const browser = await chromium.launch();

async function login(page) {
  await page.goto(`${base}/`);
  await page.waitForSelector('form', { timeout: 8000 });
  await page.fill('input[type=email]', config.auth.email);
  await page.fill('input[type=password]', PASSWORD);
  await page.click('button[type=submit]');
  await page.waitForSelector('main', { timeout: 8000 });
}

async function session(theme) {
  const ctx = await browser.newContext({
    viewport: { width: 1200, height: 1400 },
    deviceScaleFactor: 2,
    colorScheme: theme,
  });
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    localStorage.setItem('pwa-install-dismissed', '1');
    const hide = () => { const s = document.createElement('style'); s.textContent = '[aria-label="Back to top"]{display:none!important}'; document.head.appendChild(s); };
    if (document.head) hide(); else document.addEventListener('DOMContentLoaded', hide);
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await login(page);

  const suffix = theme === 'dark' ? '-dark' : '';
  for (const shot of SHOTS) {
    if (ONLY && !ONLY.has(shot.name)) continue;
    try {
      // full reload each time: hash-only navigations don't reboot the SPA, so a
      // modal or editor state left by the previous shot would leak into this one
      await page.goto(`${base}/${shot.route}`);
      await page.reload();
      await page.waitForTimeout(1400);
      if (shot.prep) await shot.prep(page);
      const el = shot.target(page);
      await el.waitFor({ state: 'visible', timeout: 6000 });
      await el.scrollIntoViewIfNeeded();
      await page.waitForTimeout(250);
      await el.screenshot({ path: `${OUT}/${shot.name}${suffix}.png` });
      console.log(`  ok  ${shot.name}${suffix}`);
    } catch (e) {
      console.log(`  FAIL ${shot.name}${suffix}: ${String(e).split('\n')[0]}`);
    }
  }

  if (errors.length) console.log(`[${theme}] PAGE ERRORS:\n  ${errors.join('\n  ')}`);
  await ctx.close();
}

// Hero shot for the marketing site: an above-the-fold dashboard at the same
// 1360x900@2x framing as the existing assets/screenshots/dashboard.png.
async function heroShot(theme) {
  const ctx = await browser.newContext({
    viewport: { width: 1360, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: theme,
  });
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    localStorage.setItem('pwa-install-dismissed', '1');
    const hide = () => { const s = document.createElement('style'); s.textContent = '[aria-label="Back to top"]{display:none!important}'; document.head.appendChild(s); };
    if (document.head) hide(); else document.addEventListener('DOMContentLoaded', hide);
  });
  await login(page);
  await page.goto(`${base}/#/dashboard`);
  await page.waitForTimeout(2000);
  const suffix = theme === 'dark' ? '-dark' : '';
  await page.screenshot({ path: `${ROOT}/smartoneg.com/assets/screenshots/dashboard${suffix}.png` });
  console.log(`  ok  hero dashboard${suffix}`);
  await ctx.close();
}

// Server-generated PDFs: fetch (authenticated) and rasterize the first page to
// a trimmed PNG. Documents are white, so there's no dark variant.
async function pdfShot(page, urlPath, outName) {
  try {
    const res = await page.request.get(`${base}${urlPath}`);
    if (!res.ok()) { console.log(`  FAIL pdf ${outName}: HTTP ${res.status()}`); return; }
    const pdfPath = `${dataDir}/${outName}.pdf`;
    fs.writeFileSync(pdfPath, await res.body());
    execSync(`pdftoppm -png -r 150 -f 1 -l 1 -singlefile "${pdfPath}" "${OUT}/${outName}"`);
    execSync(`magick "${OUT}/${outName}.png" -trim +repage -bordercolor white -border 28 "${OUT}/${outName}.png"`);
    console.log(`  ok  pdf ${outName}`);
  } catch (e) {
    console.log(`  FAIL pdf ${outName}: ${String(e).split('\n')[0]}`);
  }
}

async function pdfSession() {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await login(page);
  const today = new Date().toISOString().slice(0, 10);
  await pdfShot(page, '/api/pdf/yomtov/rosh-hashanah', 'rosh-hashanah-pdf');
  await pdfShot(page, '/api/pdf/yomtov/yom-kippur', 'yom-kippur-pdf');
  await pdfShot(page, '/api/pdf/yomtov/sukkos', 'sukkos-pdf');
  await pdfShot(page, '/api/pdf/yomtov/pesach', 'pesach-pdf');
  await pdfShot(page, '/api/pdf/yomtov/shavuos', 'shavuos-pdf');
  await pdfShot(page, `/api/pdf/omer?from=${today}`, 'omer-pdf');
  await pdfShot(page, `/api/pdf/shabbos-year?from=${today}`, 'shabbos-pdf');
  await ctx.close();
}

// HERO_ONLY=1: just the marketing dashboard hero (light+dark), nothing else —
// what the release workflow runs so the site's hero reflects the current design
// and the just-bumped version, without spending time on the feature crops/PDFs.
// PDF_ONLY=1: just the PDFs. HERO_PDF=1: hero shots + PDFs (skip feature crops).
// ONLY=name1,name2: regenerate just those feature crops (light+dark), nothing else.
if (process.env.HERO_ONLY) {
  await heroShot('light');
  await heroShot('dark');
} else if (ONLY) {
  await session('light');
  await session('dark');
} else {
  if (!process.env.PDF_ONLY && !process.env.HERO_PDF) {
    await session('light');
    await session('dark');
  }
  if (!process.env.PDF_ONLY) {
    await heroShot('light');
    await heroShot('dark');
  }
  await pdfSession();
}

await browser.close();
server.kill();
console.log('done; wrote shots to', OUT);
