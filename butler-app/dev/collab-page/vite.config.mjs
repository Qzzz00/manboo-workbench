import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 「完整手机协作下级页」验收 harness(2026-10-24,小K):真 CollabPage + 真 StateFeed(轮询)
// + 真待发箱(localStorage kv,重开仍在账上)+ 本轮隔离 core(代理同源)。
// 不设配对、不进首页 —— 首页保护由 App 级用例(tests/collabAppNav.test.tsx)钉。
const target = process.env.WB_TARGET ?? 'http://127.0.0.1:10091';
export default defineConfig({
  root: '.',
  plugins: [react()],
  server: {
    port: Number(process.env.WB_COLLAB_PORT ?? 4293),
    host: '127.0.0.1',
    strictPort: true,
    proxy: {
      '/state': target,
      '/live': { target, ws: true },
      '/task': target,
      '/collab': target,
      '/sessions': target,
      '/butler': target,
    },
  },
});
