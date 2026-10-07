import { defineConfig, devices } from '@playwright/test';

/**
 * The resilience suite (Appendix G). It drives the `pharos-e2e` container (http://127.0.0.1:8081, built with the
 * test hooks, with /ws going through Toxiproxy) and needs the core and resilience compose profiles:
 *   docker compose --profile core --profile resilience up -d --build
 * One worker, no retries: each scenario owns the whole stack while it runs, and a retry would hide flakiness.
 */
export default defineConfig({
  testDir: './tests/resilience',
  testMatch: '**/*.e2e.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 40 * 60_000,
  expect: { timeout: 30_000 },
  reporter: [['list']],
  outputDir: 'test-results/resilience',
  globalTeardown: './support/global-teardown.ts',
  use: {
    baseURL: process.env['RESILIENCE_BASE_URL'] ?? 'http://127.0.0.1:8081',
    viewport: { width: 1600, height: 900 },
    trace: 'off',
    screenshot: 'off',
  },
  projects: [{ name: 'resilience', use: { ...devices['Desktop Chrome'], viewport: { width: 1600, height: 900 } } }],
});
