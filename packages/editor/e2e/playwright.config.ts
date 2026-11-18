import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const PORT = 4174;
const packageRoot = fileURLToPath(new URL('..', import.meta.url));

/**
 * Runs against the production build (`vite preview`) so the service worker
 * and offline behaviour are exercised for real. Build first (`pnpm build`).
 *
 * Locally, reuse an installed browser: PW_CHANNEL=msedge pnpm test:e2e
 */
export default defineConfig({
  testDir: '.',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: `http://localhost:${String(PORT)}`,
    trace: 'retain-on-failure',
    viewport: { width: 1440, height: 900 },
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
        channel: process.env.PW_CHANNEL,
      },
    },
  ],
  webServer: {
    command: `pnpm exec vite preview --port ${String(PORT)} --strictPort`,
    cwd: packageRoot,
    url: `http://localhost:${String(PORT)}`,
    reuseExistingServer: !process.env.CI,
  },
});
