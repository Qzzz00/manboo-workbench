import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PLUGIN_VERSION } from '../src/version.ts'

describe('插件版本号(构建时注入)', () => {
  it('PLUGIN_VERSION 等于 package.json 的 version(vitest 与 tsdown 各自从同一份 package.json 注入)', () => {
    const manifest = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as { version?: unknown }
    expect(typeof manifest.version).toBe('string')
    expect(PLUGIN_VERSION).toBe(manifest.version)
  })
})
