// Playwright config — Next.js project.
//
// testDir and reporter are HARDCODED on purpose — the harness verifies
// these fields are unchanged after the QA agent runs. If the QA agent
// flips `reporter` to `['html']`, the pipeline hangs forever waiting on
// the HTML-report server.
//
// webServer runs `next dev` (port 3000) so tests can hit localhost:3000
// without the human starting it manually.

import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tasks',
  testMatch: '**/e2e/**/*.spec.ts',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [['list']],
  timeout: 30_000,
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'npm run dev',
    cwd: '..',
    url: 'http://localhost:3000',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
