import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// 真 App 的通话代码在无头 Chrome 里打一通电话(2026-09-25,卡 fix/evening-gaps 返工)。
// 由 channel-worker/dev/load-call.ts --phone app 起,端口由它给(--port … --strictPort);不单独用。
const here = fileURLToPath(new URL('.', import.meta.url));
const app = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig({
  root: here,
  logLevel: 'warn',
  clearScreen: false,
  server: { host: '127.0.0.1', fs: { allow: [app] } },
  // 只为这一页:别去扫整个 App 的依赖图。
  optimizeDeps: { entries: [`${here}main.ts`] },
  // 那一页从 `app-src/…` 引 App 的代码:缺省就是 butler-app/src;量「改前」时由 load-call 用 APP_CALL_SRC 指到
  // 解出来的另一份(放在 butler-app 里面,依赖照样从 butler-app/node_modules 解析)。
  resolve: { alias: { 'app-src': process.env.APP_CALL_SRC ?? `${app}src` } },
});
