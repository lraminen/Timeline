import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    // Offline support: Workbox precaches the app shell so the editor loads
    // with no network. Timeline drafts live in IndexedDB (src/lib/drafts.ts).
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: null, // registered explicitly in src/main.tsx
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'Chronicle Editor',
        short_name: 'Chronicle',
        description: 'Create and edit accessible, portable timelines.',
        theme_color: '#2563eb',
        background_color: '#f8fafc',
        display: 'standalone',
        start_url: '.',
        icons: [{ src: 'favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,woff2}'],
        navigateFallback: 'index.html',
        cleanupOutdatedCaches: true,
      },
      devOptions: { enabled: false },
    }),
  ],
  server: { port: 5174 },
  build: {
    target: 'es2022',
    sourcemap: true,
    // No manualChunks: hand-split vendor chunks (react / radix / tiptap) form
    // circular chunk imports that break init order at runtime ("reading
    // 'forwardRef' of undefined"). Rollup's automatic splitting plus the
    // lazy-loaded import dialog is safe; E2E tests guard this.
    chunkSizeWarningLimit: 1200,
  },
});
