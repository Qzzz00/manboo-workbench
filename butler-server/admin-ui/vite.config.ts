// 来源:Aiboo origin/main 1f430c3f admin-ui/vite.config.ts(base 改 /admin/,代理指向 butler-server 8792)
import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 开发态:5174 起 Vite,/admin /api /uploads 代理到本机 butler-server(缺省 8792,可用 BUTLER_PORT 覆盖)。
// 生产态:产物 dist/ 由 butler-server 托管在 /admin/,所以 base 是 /admin/。
const BACKEND_TARGET = `http://127.0.0.1:${process.env.BUTLER_PORT || 8792}`;

export default defineConfig({
  base: '/admin/',
  plugins: [react()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    port: 5174,
    proxy: {
      // 代理时要避开 /admin/ 自己(页面与 assets),只转 API 路径。
      '^/admin/(avatars|tts-models|tts-voices|rtc-providers)': { target: BACKEND_TARGET, changeOrigin: true },
      '/api': { target: BACKEND_TARGET, changeOrigin: true },
      '/uploads': { target: BACKEND_TARGET, changeOrigin: true },
    },
  },
});
