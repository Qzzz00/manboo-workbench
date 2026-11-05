import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const plugin = resolve(here, '..', '..')
const nm = name => resolve(plugin, 'node_modules', name)

const dsh = [
  resolve(process.env.HOME || '/Users/example', 'Documents', 'GitHub', 'deepseek-harness'),
  resolve(here, '..', '..', '..', '..', 'deepseek-harness'),
  resolve(here, '..', '..', '..', '..', '..', '..', 'deepseek-harness'),
].find(p => existsSync(p))
if (dsh === undefined) throw new Error('找不到 deepseek-harness 仓库,无法构建看样台')

export default {
  root: here,
  server: { port: 3593, strictPort: true, host: '127.0.0.1', fs: { allow: [plugin, resolve(plugin, '..', '..'), dsh] } },
  resolve: {
    alias: [
      { find: 'dsh-ui-theme', replacement: resolve(dsh, 'packages/client/ui-theme/src/styles') },
      { find: /^react\/jsx-runtime$/, replacement: nm('react/jsx-runtime.js') },
      { find: /^react\/jsx-dev-runtime$/, replacement: nm('react/jsx-dev-runtime.js') },
      { find: /^react-dom\/client$/, replacement: nm('react-dom/client.js') },
      { find: /^react-dom$/, replacement: nm('react-dom/index.js') },
      { find: /^react$/, replacement: nm('react/index.js') },
    ],
  },
  esbuild: { jsx: 'automatic' },
}
