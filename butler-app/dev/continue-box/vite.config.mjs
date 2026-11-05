import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 协作A「继续这件事」手机真浏览器验收页:真 ItemContinueBox 对隔离/验收实例(代理同源)。
const target = process.env.WB_TARGET ?? 'http://127.0.0.1:8993';
export default defineConfig({
  root: '.',
  plugins: [react()],
  server: {
    port: Number(process.env.WB_BOX_PORT ?? 4332),
    host: '127.0.0.1',
    strictPort: true,
    proxy: {
      '/butler': target,
      '/sessions': target,
      '/task': target,
      '/state': target,
    },
  },
});
