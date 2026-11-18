import { defineConfig } from 'vite';

/**
 * Self-contained browser bundles for <script>-tag / CDN use.
 *
 * `tsc` still emits `dist/` (types + unbundled ESM for consumers with their
 * own bundler). This config emits `dist/cdn/` with every dependency inlined:
 *
 *   chronicle-timeline.js       ES module   <script type="module" src="…">
 *   chronicle-timeline.umd.cjs  UMD         require() / AMD / global
 *   chronicle-timeline.iife.js  IIFE        classic <script src="…">
 *
 * Importing any of them registers the <chronicle-timeline> element.
 */
export default defineConfig({
  build: {
    outDir: 'dist/cdn',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: true,
    lib: {
      entry: 'src/index.ts',
      name: 'Chronicle',
      formats: ['es', 'umd', 'iife'],
      fileName: (format) =>
        format === 'es'
          ? 'chronicle-timeline.js'
          : format === 'umd'
            ? 'chronicle-timeline.umd.cjs'
            : `chronicle-timeline.${format}.js`,
    },
  },
  server: {
    open: '/demo/index.html',
  },
});
