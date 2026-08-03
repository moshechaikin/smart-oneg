import { test, expect } from '@playwright/test';
import { ACCOUNT } from './account.js';

// Depends on 00-wizard.spec.js (desktop project) having created the account
// and imported the Lutron report. Runs on desktop AND mobile projects.

let pageErrors;
test.beforeEach(async ({ page }) => {
  pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  await page.addInitScript(() => localStorage.setItem('pwa-install-dismissed', '1'));
  // API login: the session cookie lands in the shared context, so the page
  // opens straight onto the dashboard. The login FORM has its own test below.
  const res = await page.request.post('/api/auth/login', { data: ACCOUNT });
  expect(res.ok()).toBe(true);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible({ timeout: 15_000 });
});
test.afterEach(() => expect(pageErrors ?? [], 'no uncaught frontend errors').toEqual([]));

test('login form signs in and out', async ({ page }) => {
  await page.getByRole('button', { name: 'Log out' }).or(page.getByRole('button', { name: 'More' })).first().click();
  // mobile: logout lives in the More sheet
  const sheetLogout = page.locator('.fixed').getByRole('button', { name: 'Log out' });
  if (await sheetLogout.isVisible({ timeout: 1000 }).catch(() => false)) await sheetLogout.click();
  await expect(page.getByPlaceholder('you@example.com')).toBeVisible();
  await page.getByPlaceholder('you@example.com').fill(ACCOUNT.email);
  await page.locator('input[type="password"]').fill(ACCOUNT.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible({ timeout: 15_000 });
});

test('devices page groups by room, distinguishes dimmers, and lists the report', async ({ page }) => {
  await page.goto('/#/devices');
  await expect(page.getByRole('heading', { name: 'Devices' })).toBeVisible();
  // room grouping
  await expect(page.getByRole('heading', { name: /Basement Sitting Area/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: /^Kitchen/ })).toBeVisible();
  // 9 device cards from the real integration report
  await expect(page.locator('.card', { hasText: 'LIP' })).toHaveCount(9);
  await expect(page.getByText('LIP 8')).toBeVisible();
  // dimmable badge appears (default true for Lutron imports)
  await expect(page.getByText('Dimmer').first()).toBeVisible();
});

test('mark a device as non-dimmable: slider disappears', async ({ page }) => {
  await page.goto('/#/devices');
  const card = page.locator('.card', { hasText: 'LIP 8' }).first();
  await expect(card.locator('input[type=range]')).toHaveCount(1);
  await card.getByTitle('Edit device').click();
  const dlg = page.locator('#modal-root .card');
  await dlg.getByText('Dimmer (supports brightness levels)').click(); // uncheck
  await dlg.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('.card', { hasText: 'LIP 8' }).first().getByText('On/Off switch')).toBeVisible();
  await expect(page.locator('.card', { hasText: 'LIP 8' }).first().locator('input[type=range]')).toHaveCount(0);
  // restore
  await page.locator('.card', { hasText: 'LIP 8' }).first().getByTitle('Edit device').click();
  await page.locator('#modal-root .card').getByText('Dimmer (supports brightness levels)').click();
  await page.locator('#modal-root .card').getByRole('button', { name: 'Save' }).click();
});

test('add and remove a manual device', async ({ page }) => {
  await page.goto('/#/devices');
  await page.getByRole('button', { name: 'Add devices' }).click();
  await page.getByRole('button', { name: /Manual device/ }).click();
  await page.getByPlaceholder('e.g. Porch light').fill('E2E Test Lamp');
  await page.getByRole('button', { name: 'Add device', exact: true }).click();
  await expect(page.getByText('Device added')).toBeVisible();
  const card = page.locator('.card', { hasText: 'E2E Test Lamp' }).first();
  await expect(card.getByText('Manual')).toBeVisible();
  // remove it again
  await card.getByTitle('Edit device').click();
  await page.locator('#modal-root .card').getByRole('button', { name: 'Remove device' }).click();
  await expect(page.getByText('Device removed')).toBeVisible();
});

test('create a scene and see it resolved', async ({ page }, testInfo) => {
  const NAME = `Mealtime E2E ${testInfo.project.name}`;
  await page.goto('/#/scenes');
  await page.getByRole('button', { name: 'New scene' }).click();
  const dlg = page.locator('#modal-root .card');
  await dlg.getByPlaceholder('Scene name').fill(NAME);
  const checkboxes = dlg.locator('input[type="checkbox"]');
  await checkboxes.nth(0).click();
  await checkboxes.nth(1).click();
  await dlg.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Scene saved')).toBeVisible();
  await expect(page.getByText(NAME, { exact: true })).toBeVisible();
});

test('extend a scene: inherits parent zones, additions stick', async ({ page }, testInfo) => {
  const NAME = `Mealtime E2E ${testInfo.project.name}`;
  await page.goto('/#/scenes');
  const card = page.locator('.card', { hasText: NAME }).first();
  await card.getByTitle('Extend scene').click();
  const dlg = page.locator('#modal-root .card');
  await expect(dlg.getByPlaceholder('Scene name')).toHaveValue(/custom/);
  await expect(dlg.getByText('inherited from the base scene')).toBeVisible();
  const deviceChecks = dlg.locator('input[type="checkbox"]:not([data-testid])');
  expect(await dlg.locator('input[type="checkbox"]:checked').count()).toBe(2);
  await deviceChecks.nth(2).click(); // add a third device (row redraws; count assertion below)
  await expect(dlg.locator('input[type="checkbox"]:checked')).toHaveCount(3);
  await dlg.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Scene saved')).toBeVisible();
  const childCard = page.locator('.card', { hasText: `extends ${NAME}` }).first();
  // each resolved device row carries an on/off state badge
  await expect(childCard.locator('.badge-on, .badge-off')).toHaveCount(3);
});

test('scene custom end levels round-trip', async ({ page }, testInfo) => {
  const NAME = `Mealtime E2E ${testInfo.project.name}`;
  await page.goto('/#/scenes');
  await page.locator('.card', { hasText: NAME }).first().getByTitle('Edit', { exact: true }).click();
  const dlg = page.locator('#modal-root .card');
  await dlg.locator('[data-testid=custom-end]').click();
  const endSelects = dlg.locator('select');
  await endSelects.first().selectOption('level');
  await dlg.locator('input[type=number]:visible').first().fill('40');
  await dlg.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Scene saved')).toBeVisible();
  const scenes = await (await page.request.get('/api/scenes')).json();
  const meal = scenes.find((s) => s.name === NAME);
  expect(meal.endActions.some((a) => a.level === 40)).toBe(true);
});


/** Overview -> Shabbos day editor. */
async function openShabbosEditor(page) {
  await page.goto('/#/schedules');
  await expect(page.getByRole('heading', { name: 'Schedules' })).toBeVisible();
  // click the Shabbos DAY row (not the card's "Edit" overview button)
  await page.locator('.card', { hasText: 'Shabbos' }).first().locator('button:has-text("Shabbos")').first().click();
  await expect(page.getByText('Erev Shabbos (Friday)')).toBeVisible();
}

test('build a Shabbos rule and preview resolves times', async ({ page }, testInfo) => {
  await openShabbosEditor(page);
  await page.getByRole('button', { name: 'Add rule' }).last().click();
  await page.getByPlaceholder(/Name this rule/).last().fill(`Basement on before sunset ${testInfo.project.name}`);
  await page.getByRole('button', { name: 'Save schedule' }).click();
  await expect(page.getByText('Schedule saved')).toBeVisible();
  await expect(page.getByText(/resolved for its next occurrence/)).toBeVisible({ timeout: 15_000 });
});

test('fixed-time mode shows no zman/offset controls (and vice versa)', async ({ page }) => {
  await openShabbosEditor(page);
  await page.getByRole('button', { name: 'Add rule' }).last().click();
  const rule = page.locator('.card', { hasText: 'When' }).last();
  // zman mode: offset + before/after + zman select present, no time input in WHEN row
  await expect(rule.getByRole('spinbutton').last()).toBeVisible();
  // switch to fixed time: offset controls must disappear entirely
  await rule.locator('select').filter({ hasText: 'Relative to a zman' }).first().selectOption('fixed');
  await expect(rule.getByText('minutes', { exact: true })).toHaveCount(0);
  await expect(rule.locator('input[type=time]:visible')).toHaveCount(1);
  await expect(rule.getByText('after midnight (next day)')).toBeVisible();
});

test('rule with an early-Shabbos condition round-trips through the UI', async ({ page }, testInfo) => {
  const LABEL = `Pinned early shabbos ${testInfo.project.name}`;
  await openShabbosEditor(page);
  await page.getByRole('button', { name: 'Add rule' }).last().click();
  const rule = page.locator('.card', { hasText: 'Fine-tuning' }).last();
  await rule.getByPlaceholder(/Name this rule/).last().fill(LABEL);
  await rule.getByText('Fine-tuning').click();
  await rule.getByRole('button', { name: 'Add condition' }).click();
  const cond = rule.locator('.rounded-xl.border', { hasText: 'then fire' }).first();
  await cond.locator('input[type=time]').nth(0).fill('19:15');
  await cond.locator('input[type=time]').nth(1).fill('17:45');
  await page.getByRole('button', { name: 'Save schedule' }).click();
  await expect(page.getByText('Schedule saved')).toBeVisible();

  const saved = await (await page.request.get('/api/schedules/shabbos/default')).json();
  const mine = saved.rules.find((r) => r.label === LABEL);
  expect(mine.trigger.conditions).toHaveLength(1);
  expect(mine.trigger.conditions[0].if).toMatchObject({ zman: 'sunset', cmp: 'after', time: '19:15' });
  expect(mine.trigger.conditions[0].then).toMatchObject({ kind: 'fixed', time: '17:45' });
  const cal = await (await page.request.get('/api/calendar')).json();
  const tl = await (await page.request.get(`/api/timeline?date=${cal[0].days[0].date}`)).json();
  expect(tl.actions.some((a) => a.source.label === LABEL)).toBe(true);
});

test('calendar shows erev days and upcoming clusters', async ({ page }) => {
  await page.goto('/#/calendar');
  await expect(page.getByRole('heading', { name: 'Calendar' })).toBeVisible();
  await expect(page.getByText('Erev — candle lighting')).toBeVisible(); // legend
  // erev cells carry aria-labels (mobile shows only the candle icon)
  await expect(page.locator('[aria-label="Erev Shabbos"]').first()).toBeVisible();
  await expect(page.locator('[aria-label="Shabbos"]').first()).toBeVisible();
  await expect(page.getByText('Upcoming')).toBeVisible();
});

test('settings shows instance banner and header export/import', async ({ page }) => {
  await page.goto('/#/settings');
  await expect(page.getByText(/You are looking at the PRIMARY instance/)).toBeVisible();
  await expect(page.getByRole('link', { name: 'Export' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Import' })).toBeVisible();
});

test('logs page renders and offers download', async ({ page }) => {
  await page.goto('/#/logs');
  await expect(page.getByRole('heading', { name: 'Logs' })).toBeVisible();
  await expect(page.getByRole('link', { name: /Download/ })).toBeVisible();
});
