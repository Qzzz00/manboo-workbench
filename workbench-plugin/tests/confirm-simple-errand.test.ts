/**
 * **简单的事不念经**(2026-09-28,卡 CF 第 6 条)。
 *
 * 维护者第二通电话原话:「太啰嗦了,我只是提交了一个简单的事情,确认一次……念了一遍经书」。
 * 那一次他说的是「让豆包工作帮我查一下国庆节放几天假」—— 点了名、一句话说得清、查一个数,
 * 她却念了三条确认点(「这件事归谁办、动的是哪一处」「这一版要做到哪儿为止」「怎么算做完」)。
 *
 * 规矩:**点了名 + 一句话说得清的打听** → 确认只有一句;含糊的、要动东西的活照旧三条。
 */
import { describe, expect, it } from 'vitest'
import { buildConfirmPoints, formatConfirmBlock, isSimpleErrand, spokenConfirmBlock, spokenSimpleConfirm } from '../src/server/confirmPoints.ts'

describe('哪一件算「简单的事」', () => {
  it('点了名、一句话、只是查一个数 → 简单', () => {
    expect(isSimpleErrand({ need: '帮我查一下国庆放几天假', who: '豆包办公' })).toBe(true)
    expect(isSimpleErrand({ need: '问一下明天上海天气', who: '豆包办公' })).toBe(true)
  })

  it('没点名 → 不算(不知道谁办本身就是要确认的事)', () => {
    expect(isSimpleErrand({ need: '帮我查一下国庆放几天假' })).toBe(false)
  })

  it('要动东西的活、或者一长段话 → 照旧三条', () => {
    expect(isSimpleErrand({ need: '加一个导出 PDF 的功能', who: 'Codex' })).toBe(false)
    expect(isSimpleErrand({ need: '把参赛网页的首页重做一版,顺便把三幕那一段改成视频,然后把发布流程也走一遍看看有没有问题', who: 'Codex' })).toBe(false)
  })
})

describe('那一句确认长什么样', () => {
  it('一句话:谁、办什么、对吧', () => {
    const said = spokenSimpleConfirm({ understanding: '帮我查一下国庆放几天假', who: '豆包办公' })
    expect(said).toBe('让 豆包办公 帮我查一下国庆放几天假,对吧?对我就开工。')
    expect(said).not.toContain('①')
    expect(said).not.toContain('要确认的')
  })

  it('他那句话里已经有那一家了就不再说一遍名字', () => {
    expect(spokenSimpleConfirm({ understanding: '让豆包办公查国庆放几天假', who: '豆包办公' }))
      .toBe('让豆包办公查国庆放几天假,对吧?对我就开工。')
  })

  /*
   * ★★ 2026-10-02(卡「电话里像个活人」):**嘴里一律只问一句** —— 大活小活都一样。
   *
   * 09-28 这张卡分出了「简单的事只确认一句」,把三条那一段留给了大活;Air 10-02 那几通
   * 量出来的后果是「要你确认三点 / 跟你核三条」仍然 8 次(连「派 Codex 修小组件」也是)。
   * 现在电话里只念最要紧的那一条,**屏幕上**那一段(formatConfirmBlock)照旧列条。
   */
  it('★大的活在电话里也只问一句(不列条、不复述);屏幕上那一段照旧列条', () => {
    const points = buildConfirmPoints({ need: '加一个导出 PDF 的功能', who: 'Codex' })
    const spoken = spokenConfirmBlock({ understanding: '加一个导出 PDF 的功能', points })
    expect(spoken).not.toContain('①')
    expect(spoken).not.toContain('我理解的是')
    expect(spoken).not.toContain('要确认的')
    expect(spoken.split('\n')).toHaveLength(1)
    // 屏幕上那一段仍然是列表(卡面看得过来,嘴里念不过来)
    expect(formatConfirmBlock({ understanding: '加一个导出 PDF 的功能', points })).toContain('①')
  })
})
