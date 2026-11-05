/**
 * 每轮最多几句(2026-09-24 晚,卡 K;src/sentenceCap.ts)。他的规矩 ④「电话每轮不超过两句」在流上掐。
 *
 * 钉四件:
 *   ① 一段五句的回答只放出前两句(到第二个句末标点为止);
 *   ② 一个回合一份预算:模型调完工具再开口,用同一回合剩下的额度;他再说一句(reset)才重来;
 *   ③ 工具调用、没字的块原样过(掐字不掐事);
 *   ④ 上限缺席 = 不掐(他把那条规矩删了)。
 */
import { describe, expect, it } from 'vitest'
import { SentenceBudget, withSentenceCap } from '../src/sentenceCap.ts'

function streamOf<T>(chunks: readonly T[]): ReadableStream<T> {
  return new ReadableStream<T>({ start(controller) { for (const one of chunks) controller.enqueue(one); controller.close() } })
}

async function collect<T>(stream: ReadableStream<T>): Promise<T[]> {
  const out: T[] = []
  const reader = stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return out
    out.push(value)
  }
}

describe('每轮最多几句', () => {
  it('① 五句只放前两句', async () => {
    const budget = new SentenceBudget()
    const long = ['好的,我说一下。', '首页现在有三处问题:球太小', ',光效看不见。第三处是输入框', '的加号不弹。要我先派谁?', '还是你先看?']
    const out = (await collect(withSentenceCap(streamOf(long), budget, 2))).join('')
    expect(out).toBe('好的,我说一下。首页现在有三处问题:球太小,光效看不见。')
  })

  it('② 一个回合一份预算:工具之后再开口用剩下的;reset 才重来', async () => {
    const budget = new SentenceBudget()
    expect((await collect(withSentenceCap(streamOf(['好,我记一下。']), budget, 2))).join('')).toBe('好,我记一下。')
    expect((await collect(withSentenceCap(streamOf(['记下了。已经派出去了。等它做完告诉你。']), budget, 2))).join('')).toBe('记下了。')
    budget.reset()
    expect((await collect(withSentenceCap(streamOf(['第一句。第二句。第三句。']), budget, 2))).join('')).toBe('第一句。第二句。')
  })

  it('③ 工具调用原样过;到顶之后没字的块照样过', async () => {
    const budget = new SentenceBudget()
    const chunks = [
      { delta: { content: '好。我去办。再说一句。' } },
      { delta: { content: '', toolCalls: [{ name: 'wb_dispatch_item' }] } },
      { delta: { content: '还有。', toolCalls: [{ name: 'wb_list_doing' }] } },
      { usage: { tokens: 3 } },
    ]
    const out = await collect(withSentenceCap(streamOf(chunks as unknown[]), budget, 2))
    expect(out).toEqual([
      { delta: { content: '好。我去办。' } },
      { delta: { content: '', toolCalls: [{ name: 'wb_dispatch_item' }] } },
      { delta: { content: '', toolCalls: [{ name: 'wb_list_doing' }] } },
      { usage: { tokens: 3 } },
    ])
  })

  it('④ 上限缺席 = 不掐', async () => {
    const budget = new SentenceBudget()
    const out = (await collect(withSentenceCap(streamOf(['一。二。三。']), budget, undefined))).join('')
    expect(out).toBe('一。二。三。')
  })
})
