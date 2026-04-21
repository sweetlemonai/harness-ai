// Playwright config — React + Vite project.
//
// testDir and reporter are HARDCODED on purpose — the harness verifies
// these fields are unchanged after the QA agent runs. If the QA agent
// flips `reporter` to `['html']`, the pipeline hangs forever waiting on
// the HTML-report server.
//
// webServer runs the repo-root Vite dev server (port 5173) so tests can
// hit http://localhost:5173 without the human starting it manually.

import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  // e2e tests live inside each task's folder:
  //   harness/tasks/<project>/<task>/e2e/*.spec.ts
  testDir: './tasks',
  testMatch: '**/e2e/**/*.spec.ts',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [['list']],
  timeout: 30_000,
  use: {
    baseURL: 'http://localhost:5173',
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
    url: 'http://localhost:5173',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
