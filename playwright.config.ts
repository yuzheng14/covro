import { defineConfig, devices } from '@playwright/test';
const origin = `http://127.0.0.1:${process.env.E2E_PORT ?? 8788}`;

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [['list'], ['json', { outputFile: 'test-results/report.json' }]]
    : 'list',
  use: {
    baseURL: origin,
    locale: 'zh-CN',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node --import tsx scripts/test-server.ts',
    url: `${origin}/api/health`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
