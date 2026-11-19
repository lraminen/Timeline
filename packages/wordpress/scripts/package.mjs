// Builds the installable plugin zip: dist/chronicle-timeline-<version>.zip,
// containing a single chronicle-timeline/ folder (what Plugins → Add New →
// Upload and wordpress.org expect). Run `pnpm build` first.
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';

const root = fileURLToPath(new URL('..', import.meta.url));
const pluginDir = join(root, 'plugin');
const SLUG = 'chronicle-timeline';

function fail(message) {
  console.error(`package: ${message}`);
  process.exit(1);
}

// The version is written in four places; they must agree.
const main = readFileSync(join(pluginDir, `${SLUG}.php`), 'utf8');
const readme = readFileSync(join(pluginDir, 'readme.txt'), 'utf8');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const versions = {
  'plugin header': /^\s*\*\s*Version:\s*(\S+)/m.exec(main)?.[1],
  CHRONICLE_TIMELINE_VERSION: /define\(\s*'CHRONICLE_TIMELINE_VERSION',\s*'([^']+)'/.exec(
    main,
  )?.[1],
  'readme Stable tag': /^Stable tag:\s*(\S+)/m.exec(readme)?.[1],
  'package.json': pkg.version,
};
const version = pkg.version;
for (const [where, v] of Object.entries(versions)) {
  if (v !== version) fail(`${where} says ${String(v)}, package.json says ${version}`);
}

for (const required of ['build/editor.js', 'build/chronicle-timeline.js']) {
  try {
    statSync(join(pluginDir, required));
  } catch {
    fail(`${required} is missing: run pnpm build first`);
  }
}

const files = {};
function add(dir) {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (name.startsWith('.')) continue;
    if (statSync(path).isDirectory()) {
      add(path);
    } else {
      const inZip = `${SLUG}/${relative(pluginDir, path).split(sep).join('/')}`;
      files[inZip] = [readFileSync(path), { mtime: new Date('2026-01-01T00:00:00Z') }];
    }
  }
}
add(pluginDir);

mkdirSync(join(root, 'dist'), { recursive: true });
const out = join(root, 'dist', `${SLUG}-${version}.zip`);
writeFileSync(out, zipSync(files, { level: 9 }));
console.log(`${relative(root, out)}: ${String(Object.keys(files).length)} files`);
for (const name of Object.keys(files)) console.log(`  ${name}`);
