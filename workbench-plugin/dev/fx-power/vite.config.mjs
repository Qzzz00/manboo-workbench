// 起试验页:在 workbench-plugin/dev/fx-power 下 `../../../butler-app/node_modules/.bin/vite --config vite.config.mjs`
// (插件自己没有 vite;借手机端那一份)。react 与三个动效库一律指向插件自己的 node_modules。
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const here = dirname(fileURLToPath(import.meta.url))
const plugin = resolve(here, '..', '..')
const nm = name => resolve(plugin, 'node_modules', name)
export default {
  root: here,
  server: { port: 4198, strictPort: true, host: '127.0.0.1', fs: { allow: [plugin] } },
  resolve: { alias: [
    { find: /^react\/jsx-runtime$/, replacement: nm('react/jsx-runtime.js') },
    { find: /^react\/jsx-dev-runtime$/, replacement: nm('react/jsx-dev-runtime.js') },
    { find: /^react-dom\/client$/, replacement: nm('react-dom/client.js') },
    { find: /^react-dom$/, replacement: nm('react-dom/index.js') },
    { find: /^react$/, replacement: nm('react/index.js') },
    { find: /^border-beam$/, replacement: nm('border-beam/dist/index.es.js') },
    { find: /^thinking-orbs$/, replacement: nm('thinking-orbs') },
    { find: /^bot-avatars$/, replacement: nm('bot-avatars') },
  ] },
  esbuild: { jsx: 'automatic' },
}
