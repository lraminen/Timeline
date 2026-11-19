import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';

export const WP_PORT = 9411;
export const CHRONICLE_PORT = 3998;
const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const serverRoot = fileURLToPath(new URL('../../server', import.meta.url));

/**
 * Real WordPress (WordPress Playground: PHP in WebAssembly with SQLite, no
 * Docker or MySQL needed) with the plugin mounted from plugin/, talking to a
 * real Chronicle server on a fresh in-memory database.
 *
 * Run `pnpm build` first. The first run downloads WordPress, so it is slow.
 */
export default defineConfig({
  testDir: '.',
  // One WordPress site and one settings page: the tests build on each other.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${String(WP_PORT)}`,
    trace: 'retain-on-failure',
    viewport: { width: 1440, height: 900 },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
  ],
  webServer: [
    {
      command: 'node dist/main.js',
      cwd: serverRoot,
      url: `http://127.0.0.1:${String(CHRONICLE_PORT)}/healthz`,
      reuseExistingServer: !process.env.CI,
      env: {
        NODE_ENV: 'test',
        HOST: '127.0.0.1',
        PORT: String(CHRONICLE_PORT),
        PUBLIC_URL: `http://127.0.0.1:${String(CHRONICLE_PORT)}`,
        LOG_LEVEL: 'warn',
        AUTH_RATE_LIMIT_PER_MINUTE: '1000',
        RATE_LIMIT_PER_MINUTE: '5000',
        STORAGE_DIR: 'e2e-storage',
      },
    },
    {
      command: `node scripts/playground-server.mjs ${String(WP_PORT)}`,
      cwd: packageRoot,
      url: `http://127.0.0.1:${String(WP_PORT)}/wp-login.php`,
      reuseExistingServer: !process.env.CI,
      timeout: 600_000,
    },
  ],
});
