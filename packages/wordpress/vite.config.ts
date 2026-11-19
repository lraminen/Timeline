import { defineConfig } from 'vite';

/**
 * React and the @wordpress/* packages are provided by WordPress as globals
 * (`React`, `ReactJSXRuntime`, `wp.blockEditor`…) and declared as script
 * dependencies in PHP, so they are never bundled.
 */
function wordpressGlobal(id: string): string {
  if (id === 'react') return 'React';
  if (id === 'react/jsx-runtime') return 'ReactJSXRuntime';
  const name = id
    .replace(/^@wordpress\//, '')
    .replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
  return `wp.${name}`;
}

const isExternal = (id: string) =>
  id === 'react' || id === 'react/jsx-runtime' || id.startsWith('@wordpress/');

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  build: {
    outDir: 'plugin/build',
    emptyOutDir: false,
    target: 'es2020',
    // Readable output: wordpress.org requires it, and its translation tools scan for __() calls.
    minify: false,
    lib: {
      entry: 'src/index.tsx',
      formats: ['iife'],
      name: 'chronicleTimelineBlock',
      fileName: () => 'editor.js',
    },
    rollupOptions: {
      external: isExternal,
      output: { globals: wordpressGlobal },
    },
  },
});
