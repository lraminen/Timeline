import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const PORT = 5180;
const packageRoot = fileURLToPath(new URL('..', import.meta.url));

/**
 * E2E + accessibility tests against the built demo (run `pnpm build` first).
 *
 * Locally you can reuse an installed browser instead of downloading one:
 *   PW_CHANNEL=msedge pnpm --filter @chronicle/web-component test:e2e
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
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], channel: process.env.PW_CHANNEL },
    },
    {
      name: 'mobile',
      use: { ...devices['Pixel 7'], channel: process.env.PW_CHANNEL },
    },
  ],
  webServer: {
    command: `pnpm exec vite --port ${String(PORT)} --strictPort --open false`,
    cwd: packageRoot,
    url: `http://localhost:${String(PORT)}/demo/index.html`,
    reuseExistingServer: !process.env.CI,
  },
});
