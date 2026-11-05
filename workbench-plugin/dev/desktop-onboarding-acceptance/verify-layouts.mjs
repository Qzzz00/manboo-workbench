/** Compile both actual checkout layouts without writing to either checkout or starting a listener. */
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveAcceptanceDependencies } from './dependencies.mjs'
const worktree = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const primary = dirname(realpathSync(join(worktree, 'node_modules')))
for (const plugin of [...new Set([worktree, primary])]) {
  const dependencies = resolveAcceptanceDependencies(plugin)
  const { build } = await import(dependencies.viteEntry)
  const nm = name => join(plugin, 'node_modules', name)
  const bundle = await build({ root: join(plugin, 'dev/desktop-onboarding-acceptance'), configFile: false,
    cacheDir: mkdtempSync(join(tmpdir(), 'c03125-layout-build-')),
    resolve: { alias: [
      { find: /^react\/jsx-runtime$/, replacement: nm('react/jsx-runtime.js') },
      { find: /^react-dom\/client$/, replacement: nm('react-dom/client.js') },
      { find: /^react-dom$/, replacement: nm('react-dom/index.js') },
      { find: /^react$/, replacement: nm('react/index.js') },
      { find: /^@deepseek-ai\/dsh-client-store$/, replacement: dependencies.storeSource },
    ] },
    define: { __WORKBENCH_VERSION__: '"c03125-layout-check"', __WORKBENCH_BUILD_RELAY_URL__: '""', __WORKBENCH_BUILD_UPDATE_MANIFEST_URL__: '""' },
    oxc: { jsx: { runtime: 'automatic' } },
    build: { write: false, minify: false }, logLevel: 'error',
  })
  const chunks = (Array.isArray(bundle) ? bundle : [bundle]).flatMap(result => result.output).filter(part => part.type === 'chunk')
  const code = chunks.map(part => part.code).join('\n')
  assert.ok(code.includes('ben-wb__topgear'), 'production WorkbenchOverlay must be present in output')
  console.log(JSON.stringify({ javascriptBytes: Buffer.byteLength(code), plugin, storeSource: dependencies.storeSource, browserBundle: 'passed', write: false }))
}
