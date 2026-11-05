/**
 * **分流守住「能办对」**(2026-10-03,卡 fix/voice-route-zh;审计
 * `docs/审计材料/2026-10-03/voice.md` 第 1、2 条)。
 *
 * 这份用例钉两件事,两件都是**离线能数出来**的:
 *
 *   ① **全角标点也算标点**。她的 ASR 与事务官的嘴里出来的都是全角
 *      「?」「!」「,」,而判「上一句是不是问句」那几条正则当时只认 ASCII ——
 *      于是事务官问完「我帮你取消吗?」,她那句「好的」被当成应答、零工具,
 *      听着像「口头应承、实际没动」;
 *   ② **寒暄 / 纠正的前缀不许盖过明确的动作**。「嗯,取消吧」「不对,删除这条」
 *      「我的意思是换成女声」里真正要办的事在后半句,而短句寒暄(②)与闲聊词(③)
 *      排在动作词(④)前面,先返回了 chat。**她在回答事务官挂着的那一问时同理** ——
 *      那时候「好的」「不对」都是对那一问的答复,要工具。
 *
 * 两件都不改词表、不改词表顺序(`tests/turn-route.test.ts` 逐字钉着摊平后的表)。
 */
import { describe, expect, it } from 'vitest'
import { cleanFirstVoice } from '../src/firstVoice.ts'
import { looksLikeAsking, routeByRules } from '../src/turnRoute.ts'

describe('★★ 全角标点也算标点(审计第 1 条)', () => {
  it('★ 全角问号:事务官问完一句,她那句「好的」是批准,不是应答', () => {
    // 审计反例:这一行当时是 false,于是下面那一句整个走错路。
    expect(looksLikeAsking('我帮你取消吗？')).toBe(true)
    expect(looksLikeAsking('我帮你取消吗?')).toBe(true)
    // 串起来:上一句 → pendingAsk → 这一句带不带工具
    const asked = looksLikeAsking('我帮你取消吗？')
    expect(routeByRules('好的', { pendingAsk: asked }).route).toBe('act')
  })

  it('句尾「吗 / 呢 / 吧」后面跟着全角标点也算问', () => {
    expect(looksLikeAsking('要我现在就派吗！')).toBe(true)
    expect(looksLikeAsking('那我先放着呢，')).toBe(true)
    expect(looksLikeAsking('我把那条改成取消——行不？')).toBe(true)
    expect(looksLikeAsking('要我再问一遍好不好！')).toBe(true)
  })

  it('报结果的那一句照旧不算问(这一条一个字没动)', () => {
    expect(looksLikeAsking('派出去了，豆包那边新开了一条。')).toBe(false)
    expect(looksLikeAsking('问到了：Codex 那边本周还剩大概三成额度。')).toBe(false)
    expect(looksLikeAsking('')).toBe(false)
    expect(looksLikeAsking(undefined)).toBe(false)
  })

  it('★ 首句那一层的反问检查同样认全角(审计「同类旁证」)', () => {
    // 审计反例:这一句当时 ok:true,于是她先反问一句、紧接着自己答。
    expect(cleanFirstVoice('要我问豆包？')).toEqual({ ok: false, why: 'asking' })
    expect(cleanFirstVoice('要我问豆包?')).toEqual({ ok: false, why: 'asking' })
    expect(cleanFirstVoice('这样行吗！')).toEqual({ ok: false, why: 'asking' })
    // 不反问的那一句照旧过关(这一条一个字没动)
    expect(cleanFirstVoice('好，我这就去问豆包。')).toEqual({ ok: true, text: '好，我这就去问豆包。' })
  })
})

describe('★★ 寒暄 / 纠正的前缀不许盖过明确的动作(审计第 2 条)', () => {
  /** 审计反例那三句:动作在后半句,前缀是寒暄或纠正。 */
  const 带动作的前缀: [string, string, string][] = [
    ['嗯，取消吧', 'operate', '短句寒暄「嗯」当时先返回了 chat'],
    ['不对，删除这条', 'operate', '闲聊词「不对」当时先返回了 chat'],
    ['我的意思是换成女声', 'change', '闲聊词「我的意思是」当时先返回了 chat'],
  ]
  for (const [text, intent, why] of 带动作的前缀) {
    it(`「${text}」→ 要办事(${why})`, () => {
      const hit = routeByRules(text)
      expect(hit.route).toBe('act')
      expect(hit.intent).toBe(intent)
    })

    it(`「${text}」→ 事务官刚问完一句时也一样`, () => {
      expect(routeByRules(text, { pendingAsk: true }).route).toBe('act')
      expect(routeByRules(text, { previous: 'act', pendingAsk: true }).route).toBe('act')
    })
  }

  it('★ 她在回答事务官挂着的那一问:寒暄 / 闲聊那两条也不算数(那是对那一问的答复)', () => {
    // 「好的」「不对」本来就在应答那张表里(③' 早就有这道闸);这几句是 ② 与 ③ 那两条。
    for (const said of ['嗯', '哦', '谢谢', '不对', '不是的']) {
      expect(routeByRules(said, { pendingAsk: true }).route).toBe('act')
    }
  })

  it('★ 没有动作词、也没挂着一问:寒暄与闲聊一个字没变', () => {
    for (const said of ['喂', '你好', '嗯', '哦', '谢谢', '辛苦了', 'hello']) {
      expect(routeByRules(said).route).toBe('chat')
    }
    for (const said of ['你是谁？', '不是的，不是的。', '先这样吧，挂了。', '你讲。']) {
      expect(routeByRules(said).route).toBe('chat')
    }
    // 承接那一条照旧:上一回合在办事、这一句什么都没要求 → 闲聊
    expect(routeByRules('明白。', { previous: 'act', fallback: 'chat' }).route).toBe('chat')
    expect(routeByRules('怎么都是女的？', { previous: 'act', fallback: 'chat' }).route).toBe('chat')
  })

  it('★ 她在试线那一条照旧排在最前,不受这两道闸影响', () => {
    for (const said of ['听到吗？', '你能听到我说话吗？', '有声音吗？']) {
      expect(routeByRules(said, { pendingAsk: true }).route).toBe('chat')
      expect(routeByRules(said, { previous: 'act' }).route).toBe('chat')
    }
  })

  it('动作词藏在寒暄短句里也认得出来(「嗯,打开」四个字)', () => {
    const hit = routeByRules('嗯，打开')
    expect(hit.route).toBe('act')
    expect(hit.word).toBe('打开')
  })
})
