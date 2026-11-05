import { describe, expect, it } from 'vitest'
import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

// The comparison must keep the whole prior UI, not old CSS around newly changed React markup.
async function artifacts(root: string): Promise<Record<string, Buffer>> {
  const files: Record<string, Buffer> = {}
  async function walk(directory: string, relative = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const key = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isDirectory()) await walk(resolve(directory, entry.name), key)
      else files[key] = await readFile(resolve(directory, entry.name))
    }
  }
  await walk(root)
  return files
}

describe('整屏前后对照的旧版保留', () => {
  it('before 完整保留已交付的二轮版本，不混入新版组件或样式', async () => {
    const root = resolve(import.meta.dirname, '../../docs/prototypes/workbench-visual')
    const expected = await artifacts(resolve(root, 'baseline-v2'))
    const actual = await artifacts(resolve(root, 'before'))
    expect(Object.keys(actual).sort()).toEqual(Object.keys(expected).sort())
    for (const key of Object.keys(expected)) expect(actual[key]?.equals(expected[key]!)).toBe(true)
  })
})
