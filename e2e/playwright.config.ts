import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env['E2E_BASE_URL'] ?? 'http://localhost:8080';
const inCi = process.env['CI'] !== undefined && process.env['CI'] !== '';

/**
 * Runs against the containerised stack (docker compose --profile core up), by default at http://localhost:8080.
 * One worker: every test shares the one live server, and the order commands mutate its data.
 */
export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.e2e.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: inCi,
  retries: inCi ? 1 : 0,
  timeout: 90_000,
  expect: { timeout: 20_000 },
  reporter: inCi ? [['list'], ['html', { open: 'never' }]] : [['list']],
  outputDir: 'test-results',
  use: {
    baseURL,
    viewport: { width: 1600, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1600, height: 900 } } }],
});
