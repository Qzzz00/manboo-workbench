// @vitest-environment node
import { describe, expect, it } from 'vitest'
import * as surface from '../src/client/surface.ts'

/**
 * 2026-09-27(维护者对着截图红框:「就在红框内,线很细,但是是能看到的」)。
 * 顶栏四周那一圈细线:皮肤层把 `.ben-wb__topbar` 的 **border-color 四边一起**上了色(基础样式只打算画底边),
 * 于是顶栏变成一个圆角细框。顶栏现在就是窗口的标题栏,不许有框。
 */
describe('顶栏没有那一圈细框', () => {
  it('皮肤层给顶栏的边框色是透明的(不四边描线)', () => {
    const css = Object.values(surface).filter((v): v is string => typeof v === 'string').join('\n')
    const rule = css.match(/\.ben-wb \.ben-wb__topbar\{([^}]*)\}/)?.[1] ?? ''
    expect(rule).not.toBe('')
    expect(rule).not.toMatch(/border-color:var\(--wb-surface-line\)/)
    expect(rule).toMatch(/border-color:transparent/)
  })
})
