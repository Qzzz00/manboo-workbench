// 来源:Aiboo origin/main 1f430c3f admin-ui/vitest.config.ts
import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';

// Test config is kept separate from vite.config.ts: vitest bundles its own
// (older) vite type defs, which clash with the project's vite 6 plugin types.
// The unit tests here are plain TS (no JSX rendering), so no React plugin is needed.
export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
  },
});
