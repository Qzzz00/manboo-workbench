/**
 * 「关于我自己」那段话(2026-09-23,Ben 第四通真机问「你跑在哪个模型上、thinking 开没开」,
 * 她答「我这边拿不到」)。
 *
 * 钉三件:**拼出来的那几行来自真值**、**缺的那一项写「我没拿到」而不是留空或编一个**、
 * **thinking 是从交给模型的参数里读出来的**(不是写死一个「没开」)。
 */
import { describe, expect, it } from 'vitest'
import { SELF_MISSING, describeSelf, lastTurnText, thinkingOf, type SelfFacts } from '../src/selfBrief.ts'

/**
 * 一份齐全的 facts,`patch` 里给 undefined 就是**那一项没拿到**。
 * 真的接线里缺席就是不写这个键(`exactOptionalPropertyTypes`),所以这里也把 undefined 删掉 ——
 * 用例要跟真调用方同一个形状。
 */
type FactsPatch = { [K in keyof SelfFacts]?: SelfFacts[K] | undefined }

function facts(patch: FactsPatch = {}): SelfFacts {
  const merged: Record<string, unknown> = { ...full(), ...patch }
  for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key]
  return merged as SelfFacts
}

function full(): SelfFacts {
  return {
    llmModel: 'deepseek-v4-flash',
    llmRoute: 'relay',
    llmBaseUrl: 'https://api.aibooo.cn/v1',
    thinking: false,
    asr: 'volc-streaming',
    ttsUrl: 'http://127.0.0.1:8792',
    ttsScene: 'chat',
    ttsVoice: 'zh_female_wanwan',
    workbenchVersion: '0.2.65',
    deviceName: 'Ben 的 MacBook Pro',
    answeredOn: 'handset',
    lastTurn: { round: 3, total_ms: 2130, asr_ms: 620, llm_first_ms: 890, tts_first_ms: 410 },
  }
}

describe('describeSelf:她被问到自己怎么跑的时候照着答的那几行', () => {
  it('每一行都是真值,不是一句「得去电脑那端看」', () => {
    const text = describeSelf(facts())
    expect(text).toContain('deepseek-v4-flash')
    expect(text).toContain('走我们自己的中转')
    expect(text).toContain('https://api.aibooo.cn/v1')
    expect(text).toContain('火山流式识别(volc-streaming)')
    expect(text).toContain('http://127.0.0.1:8792')
    expect(text).toContain('zh_female_wanwan')
    expect(text).toContain('0.2.65')
    expect(text).toContain('Ben 的 MacBook Pro')
    expect(text).toContain('座机上那只树莓派话筒')
    expect(text).toContain('2130 毫秒')
    // 那几行里**一处**「没拿到」都不该有:这一份 facts 每一格都给了。
    // (末尾那句约束里会提到这五个字,那是给模型的规矩,不是某一项的内容。)
    expect(text.split('\n').filter(line => line.startsWith('- ') && line.includes(SELF_MISSING))).toEqual([])
  })

  it('thinking 没开时如实说「参数里没有这一项」,而不是含糊过去', () => {
    expect(describeSelf(facts({ thinking: false }))).toContain('这一轮给模型的参数里没有这一项')
    expect(describeSelf(facts({ thinking: true }))).toContain('开着(给模型的参数里有这一项)')
  })

  it('缺的那几项写「这一项我没拿到」——不留空、不编一个', () => {
    const text = describeSelf(facts({
      workbenchVersion: undefined,
      ttsVoice: undefined,
      lastTurn: undefined,
      llmRoute: undefined,
    }))
    expect(text).toContain(`- 工作台版本:${SELF_MISSING}`)
    expect(text).toContain(`- 模型走哪条路:${SELF_MISSING}`)
    expect(text).toContain(`- 上一回合的延迟:${SELF_MISSING}`)
    // 音色那一项是拼在「我怎么出声」那一行里的,同样要如实说没拿到。
    expect(text).toContain(`音色 ${SELF_MISSING}`)
    // 版本不在手上时绝不把上一份的版本号顺手写上去。
    expect(text).not.toContain('0.2.65')
  })

  it('一格都没有时整段照样拼得出来,而且每一行都说「没拿到」', () => {
    const text = describeSelf({})
    expect(text).toContain('——— 关于我自己 ———')
    expect(text.split('\n').filter(line => line.includes(SELF_MISSING)).length).toBeGreaterThanOrEqual(8)
  })

  it('末尾那句约束在:照着答、拿不到就说没拿到、密钥一个字不说', () => {
    const text = describeSelf(facts())
    expect(text).toContain('别推、别猜')
    expect(text).toContain('不要改口说「得去电脑那端看」')
    expect(text).toContain('密钥')
  })

  it('直连与「按环境变量指过去」各有各的说法', () => {
    expect(describeSelf(facts({ llmRoute: 'own' }))).toContain('直连模型厂商')
    expect(describeSelf(facts({ llmRoute: 'env' }))).toContain('按这台机器上的环境变量指到')
  })
})

describe('thinkingOf:从真交给模型的那几个参数里读', () => {
  it('参数里没有那几个键 = 没开(而不是「不知道」)', () => {
    expect(thinkingOf({ model: 'deepseek-v4-flash', apiKey: 'sk-xxx', baseURL: 'https://x' })).toBe(false)
  })

  it('哪天参数里多一项 thinking,答案自己就变了 —— 这段话不是写死的', () => {
    expect(thinkingOf({ model: 'm', thinking: true })).toBe(true)
    expect(thinkingOf({ model: 'm', reasoning: { effort: 'high' } })).toBe(true)
    expect(thinkingOf({ model: 'm', enable_thinking: true })).toBe(true)
  })

  it('明着关掉的几种写法都算关', () => {
    expect(thinkingOf({ thinking: false })).toBe(false)
    expect(thinkingOf({ reasoning_effort: 'none' })).toBe(false)
    expect(thinkingOf({ enable_thinking: 'off' })).toBe(false)
  })

  it('压根没有参数对象 = 这一项没拿到', () => {
    expect(thinkingOf(undefined)).toBeUndefined()
  })
})

describe('lastTurnText:上一回合的延迟', () => {
  it('有的段说,没测到的段不提', () => {
    expect(lastTurnText({ total_ms: 2000, asr_ms: 600, llm_first_ms: null, tts_first_ms: null }))
      .toBe('他说完到我出声 2000 毫秒(识别 600 毫秒)')
  })

  it('一个数都没测到 → 整行缺席(而不是写一串 null)', () => {
    expect(lastTurnText({ total_ms: null, asr_ms: null, llm_first_ms: null, tts_first_ms: null })).toBeUndefined()
    expect(lastTurnText(undefined)).toBeUndefined()
  })

  it('总数没测到、分段测到了 → 如实说那一段没测到,不拿分段去凑一个总数', () => {
    const text = lastTurnText({ total_ms: null, asr_ms: 500 })
    expect(text).toContain('他说完到我出声那一段没测到')
    expect(text).toContain('识别 500 毫秒')
  })
})
