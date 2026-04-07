import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { crx } from '@crxjs/vite-plugin';
import manifest from './manifest.json';
import { resolve } from 'path';
import { readFileSync, writeFileSync, existsSync } from 'fs';

/**
 * Post-build plugin: wraps the auto-generated service-worker-loader.js
 * in a try/catch async IIFE so that top-level module errors don't crash the SW.
 *
 * @crxjs/vite-plugin generates:
 *   import './assets/service-worker.ts-HASH.js';
 *
 * We transform it to:
 *   (async () => {
 *     try { await import('./assets/service-worker.ts-HASH.js'); }
 *     catch (e) { console.error('SW bootstrap error:', e); }
 *   })();
 */
function safeSwLoader(): Plugin {
  return {
    name: 'safe-sw-loader',
    writeBundle() {
      const loaderPath = resolve(__dirname, 'dist/service-worker-loader.js');
      if (!existsSync(loaderPath)) return;

      const content = readFileSync(loaderPath, 'utf-8');
      // Match static import of the SW bundle (e.g. import './assets/service-worker.ts-D4BeNRk-.js';)
      const staticImportRe = /^import\s+['"](\.[^'"]+)['"]\s*;?\s*$/m;
      const match = content.match(staticImportRe);
      if (!match) return; // already patched or unexpected format

      const modulePath = match[1];
      const patched = `(async () => {
  try {
    await import('${modulePath}');
  } catch (e) {
    console.error('SW bootstrap error:', e);
  }
})();
`;
      writeFileSync(loaderPath, patched, 'utf-8');
    },
  };
}

export default defineConfig({
  plugins: [
    react(),
    crx({ manifest }),
    safeSwLoader(),
  ],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './src/test-setup.ts',
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
});
