import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { cp, mkdtemp, readFile, rename, stat } from 'node:fs/promises'

const root = dirname(fileURLToPath(import.meta.url))
const repo = resolve(root, '../../..')
const require = createRequire(resolve(repo, 'workbench-plugin/package.json'))
const vitestRequire = createRequire(require.resolve('vitest/package.json'))
const { build } = await import(vitestRequire.resolve('vite'))
const stage = await mkdtemp(resolve(root, '.build-'))

for (const version of ['before', 'after']) {
  const before = version === 'before'
  // Keep the complete second-round delivery: old CSS with current JSX is not a valid comparison.
  if (before) await cp(resolve(root, 'baseline-v2'), resolve(stage, version), { recursive: true })
  else await build({
    configFile: false, root, base: './', logLevel: 'warn',
    resolve: { alias: { react: dirname(require.resolve('react/package.json')), 'react-dom': dirname(require.resolve('react-dom/package.json')) } },
    define: { __WORKBENCH_VERSION__: JSON.stringify('visual-preview'), __PREVIEW_BEFORE__: JSON.stringify(before) },
    build: { outDir: resolve(stage, version), emptyOutDir: false, sourcemap: false, chunkSizeWarningLimit: 900 },
  })
  const html = await readFile(resolve(stage, version, 'index.html'), 'utf8')
  if (!html.includes("connect-src 'none'") || !html.includes('type="module"')) throw new Error(`${version}: missing CSP or module`)
  for (const [, asset] of html.matchAll(/(?:src|href)="(\.\/assets\/[^"\s]+)"/g)) await stat(resolve(stage, version, asset))
}
// 两份产物都验证后再落地；仅移动本构建拥有的预览目录，旧预览保留在 staging 中可恢复。
for (const version of ['before', 'after']) {
  const destination = resolve(root, version)
  try { await rename(destination, resolve(stage, `${version}-previous`)) } catch (error) { if (error.code !== 'ENOENT') throw error }
  await rename(resolve(stage, version), destination)
}
console.log('Preview verified: /workbench-visual/after/ and /workbench-visual/before/')
