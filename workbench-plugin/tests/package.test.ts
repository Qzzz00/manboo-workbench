import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('package manifest', () => {
  it('exposes its manifest so DSH can discover the browser bundle', () => {
    const manifest = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as {
      exports?: Record<string, unknown>
    }

    expect(manifest.exports?.['./package.json']).toBe('./package.json')
  })
})
