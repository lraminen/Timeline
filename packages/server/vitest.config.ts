import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Each test file gets its own in-memory PGlite database; Argon2 hashing
    // makes auth-heavy tests a little slower than typical unit tests.
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
