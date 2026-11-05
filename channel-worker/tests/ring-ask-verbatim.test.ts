/**
 * **别家窗口里那道题:接起来就逐字念**(2026-10-12,周三演示那条路)。
 *
 * 豆包问「你喜欢喝什么饮料？」带三个选项 → 座机响 → 她拿起来听到的就是那道题和那几个选项,
 * 不是「老板,有件事要问你一下」再等模型转述。8791 在台账那一条上带 `ask`(谁在问 / 问题 / 选项);
 * 老 8791 不带,照旧那一句。
 */
import { describe, expect, it } from 'vitest'
import { parseRingCall, ringInstructions, ringOpener, type RingCall } from '../src/callOut.ts'

const ASK = { from: '豆包', question: '你喜欢喝什么饮料？', options: ['可乐', '绿茶', '美式咖啡'] }

function call(patch: Partial<RingCall> = {}): RingCall {
  return { id: 'c1', reason: 'ask', item_id: 'session:doubao/window:饮料', title: '豆包 在等你选:你喜欢喝什么饮料？', at: '2026-10-12T02:00:00.000Z', silent: false, ...patch }
}

describe('台账那一条带着原题', () => {
  it('★读得出 ask(谁在问 / 问题 / 选项)', () => {
    const got = parseRingCall({ ...call(), ask: ASK })
    expect(got?.ask).toEqual(ASK)
  })
  it('缺格 / 格式不对 → 当没有(不抛)', () => {
    expect(parseRingCall(call())?.ask).toBeUndefined()
    expect(parseRingCall({ ...call(), ask: { from: '豆包' } })?.ask).toBeUndefined()
    expect(parseRingCall({ ...call(), ask: { from: '豆包', question: '  ', options: [] } })?.ask).toBeUndefined()
  })
})

describe('开场那一句', () => {
  it('★有原题:称呼 + 谁在问 + 问题原话 + 每个选项', () => {
    const line = ringOpener(call({ ask: ASK }), { address: '老板' })
    expect(line.startsWith('老板,豆包在问你:你喜欢喝什么饮料？')).toBe(true)
    for (const one of ASK.options) expect(line).toContain(one)
    expect(line).toContain('你选哪个')
  })
  it('没有选项(自由回答)→ 念完问题问她怎么答', () => {
    const line = ringOpener(call({ ask: { ...ASK, options: [] } }), { address: '老板' })
    expect(line).toBe('老板,豆包在问你:你喜欢喝什么饮料？你怎么回它?')
  })
  it('问题原话没有问号结尾 → 补一个句读,不把选项粘在问题后面', () => {
    expect(ringOpener(call({ ask: { ...ASK, question: '选一种饮料' } }), { address: '老板' })).toContain('选一种饮料。有这几个:')
  })
  /*
   * 2026-10-13:老 8791 不带原题的时候,开场那一句也**从标题拼人话**(维护者收回 09-23 那一套
   * 「只说一句没有内容的话」)。标题本身就是一句人话(`sessionAskRowText`),所以不再后接「等你一句话」。
   */
  it('老 8791 不带原题 → 从标题拼一句人话(不再是「有件事要问你一下」)', () => {
    const line = ringOpener(call(), { address: '老板' })
    expect(line).toBe('老板,豆包 在等你选:你喜欢喝什么饮料？')
    expect(line).not.toBe('老板,有件事要问你一下。')
  })
})

describe('接起来之后的提示词', () => {
  it('★有原题:说清题和选项已经念过,她说哪个就原话交上去,不再转述', () => {
    const text = ringInstructions('我是事务官。', call({ ask: ASK }))
    expect(text).toContain('已经把')
    expect(text).toContain('wb_answer_ask')
    expect(text).not.toContain('用**一句人话**说清这件事')
  })
})
