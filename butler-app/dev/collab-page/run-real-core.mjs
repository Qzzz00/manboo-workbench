/** 启动真实 core 供手机浏览器验收；不设控制路由、不写运行事件。 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const dir = process.env.WB_QA_DIR ?? mkdtempSync(join(tmpdir(), 'wb-mobile-real-core-'));
const sourceRoot = process.env.WB_QA_CORE_SOURCE ?? fileURLToPath(new URL('../../../workbench-plugin/src', import.meta.url));
const loader = await createServer({
  configFile: false,
  root: fileURLToPath(new URL('.', import.meta.url)),
  optimizeDeps: { noDiscovery: true },
  resolve: { alias: { '#qa-core': sourceRoot } },
  server: { middlewareMode: true, hmr: false },
  appType: 'custom',
});
const { startCollabQaCore } = await loader.ssrLoadModule(fileURLToPath(new URL('./realCore.ts', import.meta.url)));
const core = await startCollabQaCore({ dir, port: Number(process.env.WB_QA_PORT ?? 10092), realCodex: process.env.WB_QA_CODEX === '1' });
console.log(JSON.stringify({ kind: 'real-core-ready', port: core.port, dir, sourceRoot }));
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await core.close();
  await loader.close();
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void close().then(() => process.exit(0)); });
