/** @vitest-environment node */
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
const source = new URL('../../docs/prototypes/swarm-v4/', import.meta.url)
const generated = new URL('../src/client/swarm/', import.meta.url)
it('生成的静态模块同步当前原型哈希，包含可被打包保留的完整MIT授权', () => {
  const manifest = JSON.parse(readFileSync(new URL('source-manifest.json', generated), 'utf8')) as { files: Record<string, string> }
  for (const [name, hash] of Object.entries(manifest.files)) expect(createHash('sha256').update(readFileSync(new URL(name, source))).digest('hex')).toBe(hash)
  const core = readFileSync(new URL('core.js', generated), 'utf8')
  expect(core).toContain('/*!\nTabler Icons')
  expect(core).toContain('Permission is hereby granted, free of charge')
  expect(core).not.toMatch(/\beval\s*\(|new\s+Function\b|class IconPicker|class TaskScene|4177/)
})
