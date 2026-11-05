// 用户层真跑的页面(2026-10-21,卡「分层第一刀」)。写法照抄 dev/readability-sample/vite.config.mjs,
// 多一条代理:`/wb/*` → server.ts 起的那台真服务(WB_PORT,缺省 4291)。在 workbench-plugin 下
//   node node_modules/.pnpm/vite@8.2.1_@types+node@22.20.1/node_modules/vite/bin/vite.js --config dev/user-layer-run/vite.config.mjs
// 宿主主题令牌读 deepseek-harness 那份 design-platform.css,与插件 link: 依赖走同一个相对位置。
//
// 两个环境变量(「现在 / A」对照要起两份,见 shoot.sh):
//   PORT=4197             换端口(缺省 4198)
//   FIG_REF=<提交>        `src/` 整个从那个提交读(`git show`),不读工作区 —— 「数字格换画法」A 版还没合进 main 时,
//                         A 那一侧用它的提交(与 main 同底),四个数字格就是那张卡的真组件,不在这里另抄一份。
import { execFileSync } from 'node:child_process'
import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
const here = dirname(fileURLToPath(import.meta.url))
const plugin = resolve(here, '..', '..')
const repo = resolve(plugin, '..')
const nm = name => resolve(plugin, 'node_modules', name)

function srcFromRef(ref) {
  const git = args => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const srcDir = resolve(plugin, 'src')
  const tracked = new Set(git(['ls-tree', '-r', '--name-only', ref, 'workbench-plugin/src']).split('\n').filter(Boolean))
  const inRef = abs => tracked.has(relative(repo, abs).split(sep).join('/'))
  return {
    name: 'src-from-ref',
    enforce: 'pre',
    resolveId(source, importer) {
      if (importer === undefined || !source.startsWith('.')) return null
      const abs = resolve(dirname(importer.split('?')[0]), source)
      return abs.startsWith(srcDir) && inRef(abs) ? abs : null
    },
    load(id) {
      const abs = id.split('?')[0]
      if (!abs.startsWith(srcDir) || !inRef(abs)) return null
      return git(['show', `${ref}:${relative(repo, abs).split(sep).join('/')}`])
    },
  }
}

const ref = process.env.FIG_REF
export default {
  root: here,
  plugins: ref ? [srcFromRef(ref)] : [],
  server: {
    port: Number(process.env.PORT ?? 4298), strictPort: true, host: '127.0.0.1', fs: { strict: false },
    proxy: { '/wb': { target: `http://127.0.0.1:${process.env.WB_PORT ?? 4291}`, rewrite: path => path.replace(/^\/wb/, '') } },
  },
  resolve: { alias: [
    { find: /^react\/jsx-runtime$/, replacement: nm('react/jsx-runtime.js') },
    { find: /^react\/jsx-dev-runtime$/, replacement: nm('react/jsx-dev-runtime.js') },
    { find: /^react-dom\/client$/, replacement: nm('react-dom/client.js') },
    { find: /^react-dom$/, replacement: nm('react-dom/index.js') },
    { find: /^react$/, replacement: nm('react/index.js') },
  ] },
  esbuild: { jsx: 'automatic' },
}
