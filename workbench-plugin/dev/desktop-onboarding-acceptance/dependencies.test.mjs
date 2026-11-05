import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, realpathSync, readFileSync, mkdtempSync, mkdirSync } from 'node:fs'
import { dirname, resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { resolveAcceptanceDependencies } from './dependencies.mjs'
const plugin = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const primary = dirname(realpathSync(join(plugin, 'node_modules')))
test('installed exports resolve identically from worktree and primary checkout', () => {
  const worktree = resolveAcceptanceDependencies(plugin)
  const main = resolveAcceptanceDependencies(primary)
  assert.equal(worktree.storeSource, main.storeSource)
  assert.equal(worktree.viteEntry, main.viteEntry)
  assert.ok(existsSync(worktree.storeSource))
  assert.match(readFileSync(worktree.storeSource, 'utf8'), /export function defineStore/)
  assert.ok(existsSync(worktree.viteEntry))
  assert.ok(worktree.fsAllow.includes(worktree.storeRoot))
})
test('missing installed dependency fails clearly before browser startup', () => {
  const absent = mkdtempSync(join(tmpdir(), 'c03125-missing-deps-'))
  mkdirSync(join(absent, 'plugin'))
  assert.throws(() => resolveAcceptanceDependencies(join(absent, 'plugin')), /installed.*dependencies/i)
})
