import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const PORT = 4174;
export const API_PORT = 3999;
const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const serverRoot = fileURLToPath(new URL('../../server', import.meta.url));

/**
 * Runs against the production builds (`pnpm build` first):
 * - the editor via `vite preview` (service worker + offline are real), and
 * - the Chronicle server on a fresh in-memory database, for the cloud tests.
 *
 * Both use 127.0.0.1 so they are the same *site*: the refresh cookie is
 * SameSite=Strict, and localhost vs 127.0.0.1 would count as cross-site.
 *
 * Locally, reuse an installed browser only if it matches Playwright's
 * version: PW_CHANNEL=msedge pnpm test:e2e
 */
export default defineConfig({
  testDir: '.',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${String(PORT)}`,
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
  webServer: [
    {
      command: `pnpm exec vite preview --host 127.0.0.1 --port ${String(PORT)} --strictPort`,
      cwd: packageRoot,
      url: `http://127.0.0.1:${String(PORT)}`,
      reuseExistingServer: !process.env.CI,
    },
    {
      command: 'node dist/main.js',
      cwd: serverRoot,
      url: `http://127.0.0.1:${String(API_PORT)}/healthz`,
      reuseExistingServer: !process.env.CI,
      env: {
        NODE_ENV: 'test',
        HOST: '127.0.0.1',
        PORT: String(API_PORT),
        PUBLIC_URL: `http://127.0.0.1:${String(API_PORT)}`,
        CORS_ORIGINS: `http://127.0.0.1:${String(PORT)}`,
        LOG_LEVEL: 'warn',
        AUTH_RATE_LIMIT_PER_MINUTE: '1000',
        RATE_LIMIT_PER_MINUTE: '5000',
        // No DATA_DIR: in-memory database, fresh for every run.
        STORAGE_DIR: 'e2e-storage',
      },
    },
  ],
});
