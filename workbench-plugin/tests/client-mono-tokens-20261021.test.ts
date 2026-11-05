/**
 * 工作台视觉 A · Mono 的令牌(2026-10-21,以全局 UI 视觉 A 最新稿为准:`codex/collaboration-visual-a@0cf75042` 的
 * `docs/设计-全局UI视觉-A-2026-10-21.md`「令牌与提示文字」;协作区专有的几档取协作区视觉 A)。钉住:
 * ① 暗亮两套同一组名字,值取自设计稿;协作区那几种类型色也在同一处;
 * ② 一处定义在 `:root[data-theme=…]`,没挂主题时按暗版;
 * ③ 宿主令牌在工作台里重指到这套;受保护的光效(粒子球、输入框、气泡、小智能体、开屏)换回宿主原值;
 * ④ 根元素的主题跟着宿主 `body[data-ds-dark-theme]` 走。
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  HOST_REMAP,
  MONO_DARK,
  MONO_LIGHT,
  PROTECTED_ROOTS,
  TOKENS_STYLE,
  hostTheme,
  syncRootTheme,
} from '../src/client/tokens.ts'

describe('Mono 令牌', () => {
  it('暗亮两套同名,纸面、字、线按设计稿', () => {
    expect(Object.keys(MONO_LIGHT).sort()).toEqual(Object.keys(MONO_DARK).sort())
    expect(MONO_DARK['--wb-paper']).toBe('#1c1c1c')
    expect(MONO_DARK['--wb-back']).toBe('#111111')
    expect(MONO_DARK['--wb-ink']).toBe('#eeeeee')
    expect(MONO_DARK['--wb-sub']).toBe('#aaaaaa')
    expect(MONO_DARK['--wb-line']).toBe('#383838')
    expect(MONO_LIGHT['--wb-paper']).toBe('#f3f3f3')
    expect(MONO_LIGHT['--wb-back']).toBe('#dedede')
    expect(MONO_LIGHT['--wb-ink']).toBe('#1c1c1c')
    expect(MONO_LIGHT['--wb-sub']).toBe('#626262')
    expect(MONO_LIGHT['--wb-line']).toBe('#d4d4d4')
  })

  it('外围令牌只有灰;颜色只给协作区的事项类型', () => {
    for (const set of [MONO_DARK, MONO_LIGHT]) {
      for (const [name, value] of Object.entries(set)) {
        if (name.startsWith('--wb-type-') || name.startsWith('--wb-card-')) continue
        const [r, g, b] = [1, 3, 5].map(at => parseInt(value.slice(at, at + 2), 16))
        expect(r === g && g === b, `${name} ${value}`).toBe(true)
      }
      for (const type of ['meeting', 'dev', 'content', 'routine']) expect(set[`--wb-type-${type}`]).toMatch(/^#[0-9a-f]{6}$/)
    }
    expect(MONO_DARK['--wb-type-meeting']).toBe('#ebd4c1')
    expect(MONO_LIGHT['--wb-type-meeting']).toBe('#fff0e3')
  })

  it('一处定义在 :root[data-theme],没挂主题按暗版', () => {
    expect(TOKENS_STYLE).toContain(':root,:root[data-theme=dark]{')
    expect(TOKENS_STYLE).toContain(':root[data-theme=light]{')
    expect(TOKENS_STYLE).toContain('--wb-paper:#1c1c1c')
    expect(TOKENS_STYLE).toContain('--wb-paper:#f3f3f3')
    // 字号、圆角、发丝线与主题无关,只写一次
    expect(TOKENS_STYLE.match(/--wb-r-card:/g)).toHaveLength(1)
    expect(TOKENS_STYLE).toContain('--wb-r-card:16px')
    expect(TOKENS_STYLE).toContain('--wb-hair:1px')
  })

  it('宿主令牌在工作台里重指到这套,受保护的光效换回宿主原值', () => {
    expect(HOST_REMAP['--dsw-alias-bg-base']).toBe('var(--wb-back)')
    expect(HOST_REMAP['--dsw-alias-label-primary']).toBe('var(--wb-ink)')
    for (const name of Object.keys(HOST_REMAP)) {
      expect(TOKENS_STYLE).toContain(`--wb-host${name.slice(1)}:var(${name})`)
      expect(TOKENS_STYLE).toContain(`${name}:var(--wb-host${name.slice(1)})`)
    }
    for (const root of ['.ben-wb__particle-orb', '.ben-fx', '.wb-cmp', '.ben-wb__task-constellation', '.ben-wb__agenticon', '.ben-wb__brand-hero', '.ben-wb__onb-orb', '.ben-wb__orb']) {
      expect(PROTECTED_ROOTS).toContain(root)
    }
    // 语义色(红 / 琥珀 / 绿)不重指
    expect(Object.keys(HOST_REMAP).some(name => /state-(error|warn|success)/.test(name))).toBe(false)
  })
})

describe('根元素主题跟宿主走', () => {
  afterEach(() => {
    document.body.removeAttribute('data-ds-dark-theme')
    delete document.documentElement.dataset.theme
  })

  it('宿主挂了暗色属性就是 dark,否则 light', () => {
    expect(hostTheme(document)).toBe('light')
    document.body.setAttribute('data-ds-dark-theme', '')
    expect(hostTheme(document)).toBe('dark')
  })

  it('同步一次并跟着宿主换', async () => {
    document.body.setAttribute('data-ds-dark-theme', '')
    const stop = syncRootTheme(document)
    expect(document.documentElement.dataset.theme).toBe('dark')
    document.body.removeAttribute('data-ds-dark-theme')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(document.documentElement.dataset.theme).toBe('light')
    stop()
    document.body.setAttribute('data-ds-dark-theme', '')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(document.documentElement.dataset.theme).toBe('light')
  })
})
