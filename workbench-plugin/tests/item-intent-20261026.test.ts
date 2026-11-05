// @vitest-environment node
/**
 * 同事项四意图(2026-10-26,卡「事务官机制A:同事项补充改向加速撤回真实接续」;
 * 依据 docs/设计-事务官通用规划与分工机制-2026-10-26.md 缺口表第 4 行):
 * 同一事项上区分 **补充 / 改方向 / 加速 / 撤回**,使过期方案不再挡住新交代。
 *
 * 纯核三件的钉子和边界:
 *   - parseItemSayIntent:不带 = 补充(旧调用逐字兼容);带错 = 拒(不静默当补充);
 *   - intentPlanOf:补充 = 原话直发 queue;改方向 / 加速 = steer(打断正在跑的轮次);
 *     撤回 = 先 cancel 停轮 + 清掉这条事项的排队旧句、**不进会话**(交代只落卡)——
 *     真打断/真停由 DSH `prompt({mode:'steer'})`(`agent.steer`,next-step 注入)与
 *     `sessionController.cancel`(keepInbox)兑现;
 *   - 回执模板:在跑 / 没在跑、停住 / 停不住、作废几句各说各的话,不编。
 */
import { describe, expect, it } from 'vitest'
import {
  CONTINUE_FACTS,
  intentPlanOf,
  intentReceiptOf,
  parseItemSayIntent,
} from '../src/server/itemContinue.ts'
import type { ItemSayIntent } from '../src/protocol.ts'

describe('parseItemSayIntent:认意图,不认错', () => {
  it('缺席 = 补充(旧调用不传 intent,行为逐字不变)', () => {
    expect(parseItemSayIntent(undefined)).toEqual({ ok: true, intent: 'supplement' })
  })

  it.each<[string, ItemSayIntent]>([
    ['supplement', 'supplement'],
    ['redirect', 'redirect'],
    ['hurry', 'hurry'],
    ['recall', 'recall'],
  ])('%s 原样认', (raw, intent) => {
    expect(parseItemSayIntent(raw)).toEqual({ ok: true, intent })
  })

  it('认不出的值拒掉,不静默当补充(改向被当普通补话 = 过期方案继续跑)', () => {
    expect(parseItemSayIntent('urgent').ok).toBe(false)
    expect(parseItemSayIntent('').ok).toBe(false)
    expect(parseItemSayIntent(42).ok).toBe(false)
  })
})

describe('intentPlanOf:四种意图各自的路', () => {
  it('补充 = 原话直发 queue,不加任何框、不动队列、不碰轮次(与卡 A 之前逐字一致)', () => {
    const plan = intentPlanOf('supplement')
    expect(plan.mode).toBe('queue')
    expect(plan.fallbackQueueWhenIdle).toBe(false)
    expect(plan.cancelFirst).toBe(false)
    expect(plan.clearFirst).toBe(false)
    expect(plan.noSay).toBe(false)
    expect(plan.frame('t-1', '顺便把 X 也办了')).toBeUndefined()
  })

  it('改方向 = steer(没在跑退 queue) + 先清旧队列 + 有会话句', () => {
    const plan = intentPlanOf('redirect')
    expect(plan.mode).toBe('steer')
    expect(plan.fallbackQueueWhenIdle).toBe(true)
    expect(plan.cancelFirst).toBe(false)
    expect(plan.clearFirst).toBe(true)
    expect(plan.noSay).toBe(false)
    const framed = plan.frame('t-9', '别走那条路了,改用手动的')
    expect(framed).toContain('改方向')
    expect(framed).toContain('t-9')
    expect(framed).toContain('别走那条路了,改用手动的')
    expect(framed).toContain('作废')
    expect(framed).toContain('别派第二路')
    expect(framed).toContain('做完的保留')
  })

  it('加速 = steer(没在跑退 queue),不动队列 —— 计划不变,催完它接着干', () => {
    const plan = intentPlanOf('hurry')
    expect(plan.mode).toBe('steer')
    expect(plan.fallbackQueueWhenIdle).toBe(true)
    expect(plan.clearFirst).toBe(false)
    const framed = plan.frame('t-9', '今天就要')
    expect(framed).toContain('加速')
    expect(framed).toContain('今天就要')
    expect(framed).toContain('别干等')
  })

  it('撤回 = 先停轮 + 清旧队列,但**不进会话**(递了等于又把它叫醒);框只落卡', () => {
    const plan = intentPlanOf('recall')
    expect(plan.mode).toBe('queue')
    expect(plan.cancelFirst).toBe(true)
    expect(plan.clearFirst).toBe(true)
    expect(plan.noSay).toBe(true)
    const framed = plan.frame('t-9', '先不做了')
    expect(framed).toContain('撤回')
    expect(framed).toContain('别再办')
    expect(framed).toContain('先不做了')
  })

  it('撤回不带原话也能交代(框自足)', () => {
    const framed = intentPlanOf('recall').frame('t-9', '')
    expect(framed).toContain('撤回')
    expect(framed).toContain('t-9')
  })
})

describe('intentReceiptOf:回执照实在跑 / 没在跑、停住 / 停不住各说各的', () => {
  it('改方向 · 正在跑 → 说打断,不说开工', () => {
    const note = intentReceiptOf('redirect', { wasRunning: true })
    expect(note).toContain('改方向')
    expect(note).toContain('打断')
    expect(note).not.toContain('开工')
  })

  it('改方向 · 没在跑 → 如实说没在跑,不假装打断', () => {
    const note = intentReceiptOf('redirect', { wasRunning: false })
    expect(note).toContain('没在跑')
    expect(note).not.toContain('打断')
  })

  it('加速 · 在跑 / 没在跑两分', () => {
    expect(intentReceiptOf('hurry', { wasRunning: true })).toContain('催')
    expect(intentReceiptOf('hurry', { wasRunning: false })).toContain('没在跑')
  })

  it('撤回 · 停住了:说挪回待排(不说「递进会话」)', () => {
    const note = intentReceiptOf('recall', { wasRunning: true, cancelled: { ok: true, running: true } })
    expect(note).toContain('撤回')
    expect(note).toContain('停住')
    expect(note).toContain('挪回待排')
    expect(note).not.toContain('递进')
  })

  it('撤回 · 没在跑,不用停:照样说挪回待排', () => {
    const note = intentReceiptOf('recall', { wasRunning: false, cancelled: { ok: true, running: false } })
    expect(note).toContain('没在跑')
    expect(note).toContain('挪回待排')
  })

  it('改方向 / 撤回 · 作废了排队旧句 → 说「一并作废,已留在卡上」', () => {
    const redirect = intentReceiptOf('redirect', { wasRunning: true, cleared: ['旧话一', '旧话二'] })
    expect(redirect).toContain('打断')
    expect(redirect).toContain('2 句旧话一并作废')
    expect(redirect).toContain('留在卡上')
    const recall = intentReceiptOf('recall', { wasRunning: false, cancelled: { ok: true, running: false }, cleared: ['旧话一'] })
    expect(recall).toContain('1 句旧话一并作废')
  })

  it('没作废旧句 → 回执不提前作废那半句', () => {
    expect(intentReceiptOf('redirect', { wasRunning: true })).not.toContain('作废,已留在卡上')
    expect(intentReceiptOf('hurry', { wasRunning: true })).not.toContain('旧话')
  })

  it('撤回 · 想停但停不住(老宿主没 cancel)→ 如实说,撤回不算办成', () => {
    const note = intentReceiptOf('recall', { wasRunning: true, cancelled: { ok: false, why: '这一版 DSH 停不了会话' } })
    expect(note).toContain('停不住')
  })
})

describe('CONTINUE_FACTS:事实档全集(没有 started,一如卡 A)', () => {
  it('全集 = 六旧 + redirected + recalled', () => {
    expect([...CONTINUE_FACTS].sort()).toEqual(
      ['failed', 'kept', 'pick', 'recalled', 'redirected', 'saved', 'sent', 'unsupported'].sort(),
    )
    expect(CONTINUE_FACTS).not.toContain('started')
  })
})
