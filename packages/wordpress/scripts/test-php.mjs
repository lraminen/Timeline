// Runs the PHP tests inside real WordPress, using WordPress Playground
// (PHP compiled to WebAssembly), so no local PHP, MySQL or Docker is needed.
//
// Each combination gets a persistent WordPress install under .playground/
// (unpacking WordPress is the slow part); its database is deleted before
// every run, so each run starts from a fresh site.
//
//   node scripts/test-php.mjs            # all combinations
//   node scripts/test-php.mjs 8.3        # only the PHP 8.3 one
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('..', import.meta.url));
const cli = require
  .resolve('@wp-playground/cli/package.json')
  .replace(/package.json$/, 'wp-playground.js');

/** Oldest supported (plugin header) and current. */
const MATRIX = [
  { php: '8.3', wp: '7.1' },
  { php: '7.4', wp: '6.6' },
];

const only = process.argv[2];

function run(args) {
  return new Promise((resolve) => {
    let output = '';
    const child = spawn(process.execPath, [cli, ...args], { cwd: root });
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('data', (chunk) => {
        output += chunk;
        process.stdout.write(chunk);
      });
    }
    child.on('close', (code) => {
      resolve({ code, output });
    });
  });
}

let failed = false;
for (const { php, wp } of MATRIX.filter((m) => !only || m.php === only)) {
  console.log(`\n=== PHP ${php}, WordPress ${wp} ===`);
  const site = `${root}.playground/php${php}-wp${wp}`;
  const fresh = !existsSync(`${site}/wp-load.php`);
  mkdirSync(site, { recursive: true });
  rmSync(`${site}/wp-content/database`, { recursive: true, force: true });

  const { code, output } = await run([
    'php',
    `--php=${php}`,
    `--wp=${wp}`,
    '--verbosity=quiet',
    '--mount-dir-before-install',
    site,
    '/wordpress',
    `--wordpress-install-mode=${fresh ? 'download-and-install' : 'install-from-existing-files'}`,
    '--mount-dir',
    `${root}plugin`,
    '/wordpress/wp-content/plugins/chronicle-timeline',
    '--mount-dir',
    `${root}tests/php`,
    '/tests',
    // Loads the plugin at boot, like an active plugin.
    '--mount-dir',
    `${root}tests/php/mu-plugins`,
    '/wordpress/wp-content/mu-plugins',
    '--',
    '/tests/run.php',
  ]);
  // The exit code of the PHP script isn't always propagated; the summary line is.
  if (code !== 0 || !/^PHP TESTS PASSED/m.test(output)) failed = true;
}

if (failed) {
  console.error('\nPHP tests failed');
  process.exit(1);
}
