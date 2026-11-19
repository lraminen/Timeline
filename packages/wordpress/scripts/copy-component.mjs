// Copies the <chronicle-timeline> CDN bundle into the plugin, so the plugin
// serves it from the WordPress site by default (no third-party requests).
import { copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const source = require.resolve('@chronicle/web-component/cdn/iife');
const target = fileURLToPath(new URL('../plugin/build/chronicle-timeline.js', import.meta.url));

mkdirSync(fileURLToPath(new URL('../plugin/build/', import.meta.url)), { recursive: true });
copyFileSync(source, target);
console.log(`copied ${source} -> ${target}`);
