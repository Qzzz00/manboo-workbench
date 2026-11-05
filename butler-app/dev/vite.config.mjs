import { defineConfig } from 'vite';

// 只为本机跑通那一遍:把 dev/ 当成一个独立的小站点起在 4181,
// 免得和手机那一页(4180)抢同一个根路径。
export default defineConfig({ root: 'dev', server: { port: 4181, host: '127.0.0.1', strictPort: true } });
