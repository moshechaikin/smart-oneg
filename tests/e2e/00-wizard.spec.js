import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { ACCOUNT } from './account.js';

// Runs first (00- prefix, single worker) and only on the desktop project:
// it creates the account + imports devices that app.spec.js relies on.

let pageErrors;
test.beforeEach(async ({ page }) => {
  pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  await page.addInitScript(() => localStorage.setItem('pwa-install-dismissed', '1'));
});
test.afterEach(() => expect(pageErrors ?? [], 'no uncaught frontend errors').toEqual([]));

test('setup wizard end-to-end (ecosystem-first flow)', async ({ page }) => {
  await page.goto('/');

  // step 0: welcome
  await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible();
  await page.getByRole('button', { name: 'Start setup' }).click();

  // step 1: role
  await expect(page.getByRole('heading', { name: 'What is this instance?' })).toBeVisible();
  await page.getByRole('button', { name: /Primary/ }).click();
  await page.getByRole('button', { name: 'Continue' }).click();

  // step 2: location
  await page.getByPlaceholder('10952').fill('10952');
  await expect(page.getByText(/Monsey, NY/)).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();

  // step 3: ecosystem picker -> Lutron setup
  await expect(page.getByRole('heading', { name: 'What runs your lights?' })).toBeVisible();
  await page.getByRole('button', { name: /Lutron Caséta bridge/ }).click();
  await expect(page.getByText('Telnet Support')).toBeVisible();
  await expect(page.getByText('Send Integration Report')).toBeVisible();
  const report = fs.readFileSync(new URL('../../lutron-integration-report.json', import.meta.url), 'utf8');
  await page.getByPlaceholder(/integration report JSON/i).fill(report);
  await page.getByRole('button', { name: 'Save Lutron setup' }).click();

  // back on the picker: Lutron marked configured; continue
  await expect(page.getByText('Configured — tap to edit')).toBeVisible();
  await page.getByRole('button', { name: 'Continue setup' }).click();

  // step 4: account
  await page.getByPlaceholder('you@example.com').fill(ACCOUNT.email);
  await page.getByPlaceholder(/At least 8 characters/).fill(ACCOUNT.password);
  await page.getByRole('button', { name: 'Continue' }).click();

  // step 5: notifications — skip
  await page.getByRole('button', { name: 'Skip' }).click();

  // step 6: enforcement — leave off, finish
  await expect(page.getByText(/never on weekdays/i)).toBeVisible();
  await page.getByRole('button', { name: 'Finish setup' }).click();

  // done -> dashboard
  await page.getByRole('link', { name: 'Open the dashboard' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Connected')).toBeVisible(); // mock bridge
});
