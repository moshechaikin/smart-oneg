import { defineConfig, devices } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Fresh data dir per run; mock mode so no hardware is touched. Anchored to this
// config's directory (not process.cwd()) so it never writes outside the project.
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(ROOT, 'test-results/e2e-data');
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
  schemaVersion: 1,
  lutron: { mock: true },
}));

export default defineConfig({
  testDir: 'tests/e2e',
  outputDir: path.join(ROOT, 'test-results/output'), // keep artifacts inside the project
  workers: 1,             // specs share one server + one wizard-created account
  fullyParallel: false,
  timeout: 30_000,
  use: {
    baseURL: 'http://127.0.0.1:8123',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1366, height: 850 } } },
    // the wizard runs once (desktop); mobile re-runs the app suite at phone size
    { name: 'mobile', use: { ...devices['iPhone 13'] }, testIgnore: /00-wizard/ },
  ],
  webServer: {
    command: 'node server/index.js',
    env: { PORT: '8123', DATA_DIR: dataDir },
    url: 'http://127.0.0.1:8123/api/health',
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
