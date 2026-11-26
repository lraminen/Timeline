import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Each test file gets its own in-memory PGlite database; Argon2 hashing
    // makes auth-heavy tests a little slower than typical unit tests.
    testTimeout: 20_000,
    // Each file boots its own PGlite (Postgres in WebAssembly); too many at once
    // exhausts memory on smaller machines and every test then times out.
    poolOptions: { forks: { maxForks: 4, minForks: 1 } },
    hookTimeout: 30_000,
    server: {
      deps: {
        // @chronicle/collab is a workspace package that vitest transforms; load
        // Yjs the same way so there is a single copy (Yjs relies on instanceof).
        inline: ['yjs', 'y-protocols', 'lib0'],
      },
    },
  },
});
