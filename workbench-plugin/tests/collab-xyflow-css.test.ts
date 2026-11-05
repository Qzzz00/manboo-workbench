// @vitest-environment node
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { XYFLOW_BASE_CSS } from '../src/client/collab/xyflowCss.ts'
import { neutralizeTintedLiterals } from '../src/client/collab/cssNeutral.ts'

describe('React Flow 的基础样式:与 pin 住的那一版逐字相同', () => {
  it('src 里抄的那份 = node_modules/@xyflow/react/dist/base.css 过一遍「偏紫换灰」', () => {
    const source = readFileSync(new URL('../node_modules/@xyflow/react/dist/base.css', import.meta.url), 'utf8')
    expect(XYFLOW_BASE_CSS).toBe(neutralizeTintedLiterals(source))
  })
  it('偏紫换灰:只换偏紫的,蓝的、灰的不动', () => {
    expect(neutralizeTintedLiterals('a{color:#b1b1b7;background:#3367d9;border-color:#555;fill:rgba(150, 150, 180, 0.1)}'))
      .toBe('a{color:#b3b3b3;background:#3367d9;border-color:#555;fill:rgba(160, 160, 160, 0.1)}')
  })
  it('package.json 里 pin 的就是注释里写的那一版', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { devDependencies: Record<string, string> }
    expect(pkg.devDependencies['@xyflow/react']).toBe('12.11.6')
  })
})
