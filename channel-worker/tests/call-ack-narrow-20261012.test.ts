/**
 * 电话先应收窄(2026-10-12,维护者:「跟事务官电话真的好啰嗦」的第二步)。
 *
 * 先应「好,我去安排。」只在**真要动手、而且要等好几秒**的意图上说(派活、换音色、捎话);
 * 查东西、问状态、记一笔、改称呼这类马上能答的,**不先应、不现生首句、不垫场**,交给模型直接答。
 * 一句里只要夹着一件会慢的事,就照旧先应那件慢事。
 */
import { describe, expect, it } from 'vitest'
import { fillerGateVerdict } from '../src/filler.ts'
import { ACK_LINES, QUICK_INTENTS, RulesTurnRouter, describeDecision, isQuickTurn, routeByRules, turnOpening } from '../src/turnRoute.ts'

describe('哪几个意图算「马上能答」', () => {
  it('查东西、问状态、记一笔、改称呼', () => {
    expect([...QUICK_INTENTS].sort()).toEqual(['address', 'find', 'lookup', 'remember', 'status'])
  })

  it('一句里全是快的才算快;夹着一件慢事、或者认不出意图,都不算', () => {
    expect(isQuickTurn(['lookup', 'status'])).toBe(true)
    expect(isQuickTurn(['lookup', 'operate'])).toBe(false)
    expect(isQuickTurn([])).toBe(false)
    expect(isQuickTurn(undefined)).toBe(false)
  })
})

describe('★ 每个意图开口怎么开(改后)', () => {
  /** [他说的, 意图, 开口:ack 先应 / filler 固定垫场 / none 直接交给模型, 先应那一句] */
  const 表: [string, string, 'ack' | 'filler' | 'none', string | undefined][] = [
    // 会慢的:照旧先应
    ['派一张需求卡,加个导出 PDF', 'dispatch', 'ack', '好,我去安排。'],
    ['这件事交给事务官', 'dispatch', 'ack', '好,我去安排。'],
    ['你能不能换音色?', 'voice', 'ack', '好,我挑几个给你听。'],
    ['给 Codex 那条会话发个信息,说先别动', 'relay', 'ack', '我看一眼。'],
    // 马上能答的:一个字都不先说
    ['把这个事情记下来', 'remember', 'none', undefined],
    ['什么事啊?', 'lookup', 'none', undefined],
    // 「那个项目现在进度怎么样了」不再按 butlerRoute 的问事项词表判(A2 拆了 ITEM_WORDS),交给模型。
    ['帮我搜一下上周那篇稿子', 'find', 'none', undefined],
    ['额度还剩多少', 'status', 'none', undefined],
    ['以后叫我小王', 'address', 'none', undefined],
    // 动手但没有先应句的:照旧现生首句
    ['把文件发给我', 'file', 'filler', undefined],
    ['把那个窗口关掉', 'operate', 'filler', undefined],
  ]
  for (const [text, intent, opening, ack] of 表) {
    it(`「${text}」→ ${intent},${opening}`, async () => {
      const decision = await new RulesTurnRouter().route(text)
      expect(decision.route).toBe('act')
      expect(decision.intent).toBe(intent)
      expect(decision.ack).toBe(ack)
      expect(turnOpening(decision)).toBe(opening)
    })
  }

  it('闲聊回合:none', async () => {
    expect(turnOpening(await new RulesTurnRouter().route('你是谁?'))).toBe('none')
  })

  /*
   * 2026-10-13(卡「三个入口一套管线」):没有先应句的 act 回合从「现生首句」改成**固定的中性垫场**
   * —— 现生那一句许的愿常常没发生(10-13 早真机三次「我这就去…」)。
   */
  it('认不出意图的长句:固定垫场(不再现生首句)', () => {
    const hit = routeByRules('这个东西我可能要给你换一桶,我也说不太清到底该怎么弄才好')
    expect(hit.quick).toBeUndefined()
    expect(turnOpening({ route: hit.route })).toBe('filler')
  })

  it('★ 一句里夹着一件慢事:先应那件慢事(记一笔排在表最前面也不抢)', () => {
    const hit = routeByRules('换个音色,再帮我记一下明天开会')
    expect(hit.intent).toBe('remember')
    expect(hit.ack).toBe('好,我挑几个给你听。')
    expect(hit.quick).toBeUndefined()
  })

  it('★ 查完还要动手的:不算快', () => {
    const hit = routeByRules('看一下进度,然后把那个窗口关掉')
    expect(hit.quick).toBeUndefined()
  })

  it('日志那一行说得出「马上能答」', async () => {
    const decision = await new RulesTurnRouter().route('额度还剩多少')
    expect(decision.quick).toBe(true)
    expect(describeDecision(decision)).toContain('马上能答')
  })
})

describe('马上能答的回合也不垫场', () => {
  it('quick → 不垫;不 quick 照旧', () => {
    expect(fillerGateVerdict('act', { quick: true }).fill).toBe(false)
    expect(fillerGateVerdict('act', { quick: true }).why).toContain('马上能答')
    expect(fillerGateVerdict('act', { quick: false }).fill).toBe(true)
  })
})

describe('要预合成的先应句少了一句', () => {
  it('「好,我记一下。」不再预合成', () => {
    expect(ACK_LINES).toEqual(['好,我去安排。', '好,我挑几个给你听。', '我看一眼。'])
  })
})
