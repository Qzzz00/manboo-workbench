// @vitest-environment node
/**
 * **到上限了怎么办:一处规则**(2026-10-02 起;2026-10-04「上限只看钱」重写)。
 *
 * ## 这一份用例钉的事(2026-10-04 维护者拍板,经工作台捎话「开」)
 *
 * ① **只剩钱这一条线**,步数那条整条去掉(`BUTLER_STEP_LIMIT` 没了);
 * ② 时间那条线**保留现状**,而且**去掉它只改一处**({@link BUDGET_MINUTES_LINE});
 * ③ 问她那一句里有**卡在哪**与**已经花了多少钱**;事务官没报卡在哪就照实说,**不编**;
 * ④ 同一类事反复撞线,日结里提一句「这类事常撞线,缺一个正规做法」,**不自动调高线**。
 *
 * ## 为什么(10-04 早那次事故,事项 `t-63a9291b`)
 *
 * 维护者在手机上让事务官发一份文件:第一轮 14 步 grep 源码找路、第 15 步撞 `BUTLER_STEP_LIMIT = 15` 停了;
 * 她点继续 → 30 步又撞;再点 → 45 步才办完。**钱远没到,是步数线先到的**。她看到的是「中间阻塞了两次」。
 * 维护者 09-23 的尺子:「用户不在乎一通电话花了多少 Tokens,只在乎花了多少钱」。
 *
 * 10-02 那条「问她那一句不念消耗额度」留着一半:分钟与步数照旧不念,**钱改成要念**
 * (10-04 维护者改口 —— 她在乎的正是那个数)。自动续那一套**没有**回来。
 */
import { describe, expect, it } from 'vitest'
import {
  BUDGET_LINE_TITLES, BUDGET_MINUTES_LINE, BUDGET_REPEAT_MIN, BUDGET_STUCK_UNKNOWN,
  budgetAskLine, budgetRepeatLine, yuan,
} from '../src/server/budgetPolicy.ts'

describe('★ 只剩钱与时间两条线;自动续没有回来', () => {
  it('这个文件里没有「步数」那一套,也没有自动续那一套', async () => {
    const policy = await import('../src/server/budgetPolicy.ts')
    const names = Object.keys(policy)
    expect(names).not.toContain('BUTLER_STEP_LIMIT')
    expect(names.some(one => /step|STEP|autoExtend|AUTO_EXTEND/.test(one))).toBe(false)
    // 还剩的两条线只有这两个名字(新加一条线要先有人拍板)。
    expect(Object.keys(BUDGET_LINE_TITLES)).toEqual(['money', 'time'])
  })

  it('★时间那条线保留现状,而且「去掉它只改一处」(这一处就是 BUDGET_MINUTES_LINE)', () => {
    expect(BUDGET_MINUTES_LINE).toBe(true)
    // 写成 boolean(不是字面量 true):改这一个字的那天不会连带报一串「这个条件恒真」。
    expect(typeof BUDGET_MINUTES_LINE).toBe('boolean')
  })
})

describe('问她那一句:卡在哪 + 已经花了多少钱 + 让她挑', () => {
  it('★事务官报了卡在哪 → 原样放进那一问,并带上已经花了多少元', () => {
    const line = budgetAskLine({
      title: '把官网逐字稿发到手机上',
      stuck: '我在找把文件发到手机上的那条路,试了翻源码、读技能,还差一条现成的接口',
      spentCny: 0.13,
    })
    expect(line).toContain('我在找把文件发到手机上的那条路')
    expect(line).toContain('已经花了 0.13 元')
    expect(line).toContain('接着做')
    expect(line).toContain('停掉这一件')
    // 分钟与步数照旧不念(10-02 她的原话:每一步设置得太细)。
    expect(line).not.toMatch(/分钟|步/)
  })

  it('★事务官没报 → 照实说「它没说卡在哪」,不编一个原因', () => {
    const line = budgetAskLine({ title: '修首页球的显示问题', spentCny: 0.52 })
    expect(line).toContain(BUDGET_STUCK_UNKNOWN)
    expect(line).toContain('已经花了 0.52 元')
    // 空字符串 / 只有空格一律当没报。
    expect(budgetAskLine({ title: 'X', stuck: '   ' })).toContain(BUDGET_STUCK_UNKNOWN)
  })

  it('钱还没算出来 → 如实说,不写 0 元', () => {
    const line = budgetAskLine({ title: 'X' })
    expect(line).toContain('花了多少还没算出来')
    expect(line).not.toContain('0.00 元')
  })

  it('有能换的那一家时多一个选项,还是一句话', () => {
    const line = budgetAskLine({ title: '修首页球的显示问题', candidateTitle: 'Claude', stuck: '卡在登录', spentCny: 0.5 })
    expect(line).toContain('换 Claude 来做')
    expect([...line].filter(one => one === '?' || one === '?').length).toBe(1)
  })

  it('钱的写法与卡上那一句同一个(到分;不到一分如实说)', () => {
    expect(yuan(0.5)).toBe('0.50')
    expect(yuan(0.004)).toBe('不到 0.01')
  })
})

describe('★ 同一类事反复撞线 → 日结里一句话(不自动调高线)', () => {
  it(`同一类事撞够 ${BUDGET_REPEAT_MIN} 次才说;不够就整句缺席`, () => {
    expect(BUDGET_REPEAT_MIN).toBe(3)
    expect(budgetRepeatLine([])).toBeUndefined()
    expect(budgetRepeatLine([{ kind: 'desk' }, { kind: 'desk' }])).toBeUndefined()
    const line = budgetRepeatLine([{ kind: 'desk' }, { kind: 'desk' }, { kind: 'desk' }])
    expect(line).toContain('这类事常撞线,缺一个正规做法')
    expect(line).toContain('要在你电脑上动手')
    expect(line).toContain('3 次')
  })

  it('哪类事数不出来的那几条不并成一类(不知道是哪类,就说不出「这类事」)', () => {
    expect(budgetRepeatLine([{}, {}, {}, {}])).toBeUndefined()
    expect(budgetRepeatLine([{ kind: '' }, { kind: '' }, { kind: '' }])).toBeUndefined()
  })

  it('多类都够 → 次数多的排前面', () => {
    const line = budgetRepeatLine([
      { kind: 'chat' }, { kind: 'chat' }, { kind: 'chat' },
      { kind: 'code' }, { kind: 'code' }, { kind: 'code' }, { kind: 'code' },
    ])
    expect(line?.indexOf('写代码')).toBeLessThan(line?.indexOf('聊天') as number)
  })
})
