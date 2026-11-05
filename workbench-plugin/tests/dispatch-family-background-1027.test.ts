// @vitest-environment node
/**
 * `dispatchFamilyOf` 背景不误拆(2026-10-27,卡 `t-bd1c04ed` 第一批;
 * 交接 `docs/交接-1027-委托派发机制第一批.md` 设计第 2 条)。
 *
 * 现场(任务书 10-27 节):一段交代里**背景**提到别家 AI(「之前是让 Claude 做的」
 * 「Codex 代维护者观察」),旧判据 `before.includes(verb)` 只要求动词在名字前**任意处**,
 * 把背景当指派;`indexOf` 又只查第一处出现,背景里的名字还会挡掉后面真正的指派
 * (「Kimi 派发 409,让 Kimi 处理机制任务」认不出来)。
 *
 * 新判据(与既有「宁可漏认不可错认」同向):指派动词必须与名字**同句且紧邻**
 * (允许「派给 / 交给 / 给到」类介词与空白引号);两类守卫 —— 否定(别 / 不 / 勿紧邻动词前)
 * 与背景(动词前是「是 / 由 / 归 / 被 / 已经 / 之前 / 原先」等)。同一名字多处出现逐个查,
 * 取最早合法命中。
 */
import { describe, expect, it } from 'vitest'
import { dispatchFamilyOf, mentionsDispatchFamily } from '../src/server/agentDispatch.ts'

describe('认出「让谁做」:背景与否定不再误拆(2026-10-27)', () => {
  it('「之前是让 X 做的」是背景,不是这次指派;同句里真正的「交给 Y」算数', () => {
    expect(dispatchFamilyOf('这个任务之前是让 Claude 做的,这次交给 Kimi')).toBe('kimi')
    expect(dispatchFamilyOf('这个 bug 是让 Kimi 修的')).toBeUndefined()
  })

  it('「已经让 X 在观察了」这类现状描述不算新派活', () => {
    expect(dispatchFamilyOf('卡已经让 Codex 在观察了,统筹的活不要拆出去')).toBeUndefined()
  })

  it('否定守卫:「别找 X」「不派给 X」不是指派;同句另一个指派算数', () => {
    expect(dispatchFamilyOf('让 Codex 做,别找 Claude')).toBe('codex')
    expect(dispatchFamilyOf('别派给 Claude,这次交给 Kimi')).toBe('kimi')
  })

  it('同一名字多处出现逐个查:背景里那处没动词,不挡后面真正的「让 X」', () => {
    expect(dispatchFamilyOf('Kimi 派发 409,让 Kimi 处理机制任务')).toBe('kimi')
    expect(dispatchFamilyOf('Codex 额度健康,叫 Codex 出一份只读报告')).toBe('codex')
  })

  it('背景里提到别家、完全没有指派动词 → 不派(照旧)', () => {
    expect(dispatchFamilyOf('Codex 代维护者观察事务官如何处理事务,Claude 通道失败')).toBeUndefined()
    expect(dispatchFamilyOf('Codex 那边额度还剩多少')).toBeUndefined()
  })

  it('指派形状照旧认得(紧邻动词,介词 / 空白都行)', () => {
    expect(dispatchFamilyOf('让 Codex 把首页改了')).toBe('codex')
    expect(dispatchFamilyOf('叫 claude 看看这个报错')).toBe('claude')
    expect(dispatchFamilyOf('让 KIMI 写个文案')).toBe('kimi')
    expect(dispatchFamilyOf('这件交给 Codex')).toBe('codex')
    expect(dispatchFamilyOf('派给 Kimi 处理')).toBe('kimi')
    expect(dispatchFamilyOf('交给 doubao 改一版')).toBe('doubao')
    expect(dispatchFamilyOf('没点名的一件事')).toBeUndefined()
  })
})

/**
 * 退修批(2026-10-27 二批,root 直接 import 真实 `agentDispatch.ts` 复现的 5 个错判):
 * 「不要让 Claude 处理,这次交给 Kimi」「不能让 Claude 改代码」「昨天让 Claude 做了,今天交给 Kimi」
 * 「是否让 Claude 来做?先给我方案」「不要再交给 Claude」—— 全部错认 Claude。
 *
 * 语义分类(不是逐句加例外):命令 / 否定 / 询问 / 背景,四个闭类:
 * - **否定**:指派动词紧邻窗口(前 4 字)内出现否定字(不/没/未/别/勿/毋/莫/甭/休/无/非/否);
 * - **询问**:整句含疑问短语(是否/要不要/能不能/还是…)—— 询问与取舍不自动派;
 * - **背景**:名字紧跟完成体(了/过/的/来着),或动词紧邻过去时副词(昨天/之前/已经…);
 * - **命令**:以上都不沾,才是一次指派。
 * 混合 / 沾不上的 → 不派(事务官自己办),**绝不把不确定话语兜底成一次派发**。
 */
describe('命令/否定/询问/背景语义(root 复现的 5 个错判)', () => {
  it('1 「不要让 Claude 处理,这次交给 Kimi」→ kimi(否定只作用到它紧贴的那一动词)', () => {
    expect(dispatchFamilyOf('不要让 Claude 处理,这次交给 Kimi')).toBe('kimi')
  })

  it('2 「不能让 Claude 改代码」→ 不派(否定)', () => {
    expect(dispatchFamilyOf('不能让 Claude 改代码')).toBeUndefined()
  })

  it('3 「昨天让 Claude 做了,今天交给 Kimi」→ kimi(过去时背景 + 现在的命令)', () => {
    expect(dispatchFamilyOf('昨天让 Claude 做了,今天交给 Kimi')).toBe('kimi')
  })

  it('4 「是否让 Claude 来做?先给我方案」→ 不派(询问)', () => {
    expect(dispatchFamilyOf('是否让 Claude 来做?先给我方案')).toBeUndefined()
  })

  it('5 「不要再交给 Claude」→ 不派(否定)', () => {
    expect(dispatchFamilyOf('不要再交给 Claude')).toBeUndefined()
  })
})

describe('语义分类:未参与实现的表达变式', () => {
  it('否定变式:别 / 勿 / 不用 / 别再 / 没有 / 未 / 不能', () => {
    expect(dispatchFamilyOf('别叫 Codex 碰这个')).toBeUndefined()
    expect(dispatchFamilyOf('不用找 Claude 了')).toBeUndefined()
    expect(dispatchFamilyOf('别再把活交给 Claude,让 Kimi 接手')).toBe('kimi')
    expect(dispatchFamilyOf('这次没让 Claude 去,交给 Kimi')).toBe('kimi')
    expect(dispatchFamilyOf('尚未派给 Kimi,先别动')).toBeUndefined()
    expect(dispatchFamilyOf('不能让 Codex 改,交给 Kimi')).toBe('kimi')
  })

  it('询问变式:要不要 / 能不能 / 还是(取舍)', () => {
    expect(dispatchFamilyOf('要不要让 Kimi 来做?')).toBeUndefined()
    expect(dispatchFamilyOf('能不能让 Claude 看看这个?')).toBeUndefined()
    expect(dispatchFamilyOf('让 Claude 做还是 Kimi 做?')).toBeUndefined()
    expect(dispatchFamilyOf('交给 Kimi 好吗?')).toBeUndefined()
  })

  it('背景变式:完成体(了/过/的)与过去时副词', () => {
    expect(dispatchFamilyOf('前天交给 Kimi 的那版呢')).toBeUndefined()
    expect(dispatchFamilyOf('已经让 Kimi 处理过了')).toBeUndefined()
    expect(dispatchFamilyOf('之前派给 Codex 的活还没回')).toBeUndefined()
    expect(dispatchFamilyOf('上次让 Kimi 做的方案留下了吗')).toBeUndefined()
  })

  it('命令形状仍然认得(否定 / 询问 / 背景都不沾)', () => {
    expect(dispatchFamilyOf('把这件事交给 Kimi 办')).toBe('kimi')
    expect(dispatchFamilyOf('现在让 Claude 看一眼')).toBe('claude')
    expect(dispatchFamilyOf('麻烦交给 Codex 处理')).toBe('codex')
    expect(dispatchFamilyOf('接下来派 Kimi 出方案')).toBe('kimi')
  })

  it('多句各算各的:前句背景 / 否定,后句命令照旧派', () => {
    expect(dispatchFamilyOf('之前是让 Claude 做的。这次交给 Kimi')).toBe('kimi')
    expect(dispatchFamilyOf('别让 Claude 动。让 Kimi 来')).toBe('kimi')
  })
})

describe('mentionsDispatchFamily:只回答「提到没有」(2026-10-27 三批)', () => {
  it('提到了家就是 true(不猜是不是指派;派发决定只由理解中枢给出)', () => {
    expect(mentionsDispatchFamily('请不要再把这个任务交给 Claude,改由 Kimi 处理')).toBe(true)
    expect(mentionsDispatchFamily('你上回说交给 Kimi 的,做完了吗')).toBe(true)
    expect(mentionsDispatchFamily('今天天气不错')).toBe(false)
  })

  it('名单从登记表来,不写死家名', () => {
    const targets = [{ id: 'agent-x', title: '某某', aliases: [], from_registry: true } as never]
    expect(mentionsDispatchFamily('别让某某动手', targets)).toBe(true)
  })
})
