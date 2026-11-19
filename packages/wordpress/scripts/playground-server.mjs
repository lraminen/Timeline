// Starts WordPress (via WordPress Playground) with the plugin mounted and
// activated, on a fresh database, for the E2E tests or for trying the
// plugin by hand:
//
//   node scripts/playground-server.mjs [port]     # default 9400
//
// Sign in at /wp-login.php as admin / password.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('..', import.meta.url));
const cli = require
  .resolve('@wp-playground/cli/package.json')
  .replace(/package\.json$/, 'wp-playground.js');

const port = Number(process.argv[2] ?? 9400);
const php = process.env.WP_PHP ?? '8.3';
const wp = process.env.WP_VERSION ?? '7.1';
const site = `${root}.playground/server-php${php}-wp${wp}`;
const fresh = !existsSync(`${site}/wp-load.php`);
mkdirSync(site, { recursive: true });
rmSync(`${site}/wp-content/database`, { recursive: true, force: true });

const blueprint = `${root}.playground/blueprint.json`;
writeFileSync(
  blueprint,
  JSON.stringify({
    steps: [
      { step: 'activatePlugin', pluginPath: 'chronicle-timeline/chronicle-timeline.php' },
      // Plain permalinks (?p=123): with pretty ones, Playground's CLI server sent
      // every post URL to the home page in our runs (Windows, CLI 3.1.65).
      { step: 'setSiteOptions', options: { permalink_structure: '' } },
    ],
  }),
);

const child = spawn(
  process.execPath,
  [
    cli,
    'server',
    `--port=${String(port)}`,
    `--site-url=http://127.0.0.1:${String(port)}`,
    `--php=${php}`,
    `--wp=${wp}`,
    '--mount-dir-before-install',
    site,
    '/wordpress',
    `--wordpress-install-mode=${fresh ? 'download-and-install' : 'install-from-existing-files'}`,
    '--mount-dir',
    `${root}plugin`,
    '/wordpress/wp-content/plugins/chronicle-timeline',
    `--blueprint=${blueprint}`,
  ],
  { cwd: root, stdio: 'inherit' },
);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    child.kill(signal);
  });
}
child.on('exit', (code) => {
  process.exit(code ?? 0);
});
