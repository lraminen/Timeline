#!/usr/bin/env node
/**
 * Chronicle CLI: validate timelines, convert TimelineJS files, and export
 * self-contained static sites. Run `chronicle --help` for usage.
 */
import { run } from './run.js';

run(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  cwd: process.cwd(),
  env: process.env,
  fetch,
}).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  },
);
