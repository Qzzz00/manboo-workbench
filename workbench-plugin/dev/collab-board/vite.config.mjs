// 协作区的看样页(2026-10-21):在 workbench-plugin 下 `node_modules/.bin/vite --config dev/collab-board/vite.config.mjs`。
// 假数据、假服务端(页面里拦 fetch),不连 8791、不读写任何真文件。react 与画布库一律指向插件自己的 node_modules。
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const here = dirname(fileURLToPath(import.meta.url))
const plugin = resolve(here, '..', '..')
const nm = name => resolve(plugin, 'node_modules', name)
export default {
  root: here,
  server: { port: 4199, strictPort: true, host: '127.0.0.1', fs: { allow: [plugin] } },
  resolve: { alias: [
    { find: /^react\/jsx-runtime$/, replacement: nm('react/jsx-runtime.js') },
    { find: /^react\/jsx-dev-runtime$/, replacement: nm('react/jsx-dev-runtime.js') },
    { find: /^react-dom\/client$/, replacement: nm('react-dom/client.js') },
    { find: /^react-dom$/, replacement: nm('react-dom/index.js') },
    { find: /^react$/, replacement: nm('react/index.js') },
  ] },
  esbuild: { jsx: 'automatic' },
}
