import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const plugin = resolve(here, '..', '..')
const nm = name => resolve(plugin, 'node_modules', name)

// deepseek-harness 在本机的两个可能位置:主检出布局(仓库与 harness 同级)与
// worktree 布局(.claude/worktrees/<名>/ 下,要再多往上几级才到同级目录)。
const dsh = [
  resolve(here, '..', '..', '..', '..', 'deepseek-harness'),
  resolve(here, '..', '..', '..', '..', '..', '..', 'deepseek-harness'),
].find(p => existsSync(p))
if (dsh === undefined) throw new Error('找不到 deepseek-harness 仓库,无法构建看样台')

export default {
  root: here,
  server: { port: 4200, strictPort: true, host: '127.0.0.1', fs: { allow: [plugin, resolve(plugin, '..', '..'), dsh] } },
  resolve: {
    alias: [
      // 看样台要引 harness 的 ui-theme 底样;统一走别名,相对路径在 worktree 里够不到
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
