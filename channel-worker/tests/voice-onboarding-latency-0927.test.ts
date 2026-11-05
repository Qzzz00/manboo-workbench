/**
 * 语音引导「等了很久都没声音」(2026-09-27,卡 fix/voice-onboarding-latency)。
 *
 * 现场:全新 MacBook Air、新注册账号、0.4.49,手机小米免提放在房间里进「语音引导」,
 * 34 秒才听见第一句。诊断包里的账(channel-worker.log):
 *
 *   · 回合计时 #1:`tts_first_ms: 737, publish_ms: 33291` ——
 *     第一句的音频 0.7 秒就合好了,**33 秒没发进房**。慢的不是模型、不是合成,是「发不出去」;
 *   · 框架那一段:`ttsTask` 在转发第一帧之前调 `reconcilePlayoutPause()`,
 *     只要「这一句允许被打断 + 这会儿不在说话 + 用户不是静音态」,它就**先把播出暂停**
 *     (@livekit/agents 1.9 `agent_activity.js`)。免提放在房间里,VAD 一直听见人声/环境声,
 *     `userSilenceEvent` 一直是清的 —— 于是固定开场白被按在那儿,直到手机挂断才放出来;
 *   · `开场白预合成:8792 回了 503` ×12:工人比事务官后端先起来,那一趟预热全落空,之后没有人再补。
 *
 * 所以这一份钉三件事:
 *   ① 开场第一句**不排在模型后面、也不许被那道暂停按住**(`allowInterruptions: false`),
 *      而且只有**第一小句**这样 —— 整段一百字全不可打断,他想插话就插不进去了;
 *   ② 8792 还没起来时的预热**要等它起来再补**,不是一趟失败就算了;
 *   ③ 「模型首段 N 字」那一行要分清是谁推的 —— 09-27 那份日志里的「85 字」根本不是模型,
 *      是 `session.say()` 把固定开场白整句推进了同一个切分器,害我们先去查了中转的流式。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  ONBOARDING_OPENING_LINE,
  ONBOARDING_PREWARM_LINES,
  openingPieces,
  speakOpeningLine,
} from '../src/onboarding.ts'
import { GreetingCache, warmWhenReady } from '../src/tts/greeting.ts'

describe('① 开场第一句:立刻出声、不被「用户在说话」按住', () => {
  it('切成「第一小句 + 剩下的」:拼回去一个字不差,第一小句短到几秒能念完', () => {
    const pieces = openingPieces(ONBOARDING_OPENING_LINE)
    expect(pieces.length).toBe(2)
    expect(pieces.join('')).toBe(ONBOARDING_OPENING_LINE)
    expect([...(pieces[0] as string)].length).toBeLessThanOrEqual(30)
    expect(pieces[0]).toBe('你好,很高兴认识你,我是你的专属事务官。')
  })

  it('一句话的开场白不用切(切出来就一块,不能凭空多一句空话)', () => {
    expect(openingPieces('老板,我在。')).toEqual(['老板,我在。'])
    expect(openingPieces('  ')).toEqual([])
  })

  it('第一小句 allowInterruptions:false(不然框架会在发第一帧之前把播出暂停),剩下的照旧可打断', () => {
    const said: { text: string, allowInterruptions?: boolean }[] = []
    speakOpeningLine(ONBOARDING_OPENING_LINE, (text, options) => { said.push({ text, ...options }) })
    expect(said.length).toBe(2)
    expect(said[0]!.allowInterruptions).toBe(false)
    expect(said[0]!.text).toBe('你好,很高兴认识你,我是你的专属事务官。')
    expect(said[1]!.allowInterruptions).toBe(true)
    expect(said.map(one => one.text).join('')).toBe(ONBOARDING_OPENING_LINE)
  })

  it('第一小句说不出去(抛了),剩下的照样说 —— 少半句也比一片安静强', () => {
    const said: string[] = []
    let first = true
    speakOpeningLine(ONBOARDING_OPENING_LINE, (text) => {
      if (first) { first = false; throw new Error('说不出去') }
      said.push(text)
    })
    expect(said.length).toBe(1)
  })
})

describe('② 8792 还没起来:预热要等它起来再补', () => {
  it('前两趟连不上,起来之后自己补齐(等多久由注入的钟说,用例里不真睡)', async () => {
    let up = false
    const waits: number[] = []
    const logs: string[] = []
    const cache = new GreetingCache({
      synthesize: async () => (up ? { pcm: Buffer.alloc(480), sampleRate: 24000 } : undefined),
      lines: () => ['一句话', '两句话'],
      log: line => logs.push(line),
    })
    const done = warmWhenReady(cache, {
      attempts: 5,
      delayMs: 1000,
      wait: async (ms) => {
        waits.push(ms)
        // 第二次等完的时候 8792 起来了。
        if (waits.length >= 2) up = true
      },
      log: line => logs.push(line),
    })
    await expect(done).resolves.toBe(2)
    expect(cache.size).toBe(2)
    expect(waits.length).toBe(2)
    expect(logs.join('\n')).toContain('8792')
  })

  it('一直起不来:试够了就收手,留一行人话,不无限转下去', async () => {
    const logs: string[] = []
    const cache = new GreetingCache({
      synthesize: async () => undefined,
      lines: () => [...ONBOARDING_PREWARM_LINES],
      log: () => {},
    })
    const got = await warmWhenReady(cache, {
      attempts: 3,
      delayMs: 5,
      wait: async () => {},
      log: line => logs.push(line),
    })
    expect(got).toBe(0)
    expect(logs.join('\n')).toContain('提机时现合成')
  })

  it('一趟就齐了:不等、不重试', async () => {
    const waits: number[] = []
    const cache = new GreetingCache({
      synthesize: async () => ({ pcm: Buffer.alloc(480), sampleRate: 24000 }),
      lines: () => ['一句话'],
    })
    await warmWhenReady(cache, { attempts: 3, delayMs: 1000, wait: async ms => void waits.push(ms) })
    expect(waits).toEqual([])
  })

  it('每一趟都等得久一点(退避),但不超过上限', async () => {
    const waits: number[] = []
    const cache = new GreetingCache({ synthesize: async () => undefined, lines: () => ['一句话'] })
    await warmWhenReady(cache, { attempts: 6, delayMs: 1000, maxDelayMs: 4000, wait: async ms => void waits.push(ms) })
    expect(waits).toEqual([1000, 2000, 4000, 4000, 4000])
  })
})

describe('③ 「模型首段 N 字」那一行要分清是谁推的', () => {
  it('固定句(say)推进去的那一段不许写成「模型首段」—— 09-27 就是被它带偏的', async () => {
    const { readFile } = await import('node:fs/promises')
    const agent = await readFile(new URL('../src/agent.ts', import.meta.url), 'utf8')
    expect(agent).toContain('首段')
    // 那一行现在要带上「这一段是谁推的」,不能再只说「模型」。
    expect(agent).toContain('firstTextSource')
  })
})

describe('回归:引导开场仍然不经模型、不发预合成帧', () => {
  it('speakOpeningLine 只管说字,一个 audio 都不带(预合成那条 09-24 真机上被截断过)', () => {
    const calls: Record<string, unknown>[] = []
    speakOpeningLine(ONBOARDING_OPENING_LINE, (text, options) => { calls.push({ text, ...options }) })
    for (const call of calls) expect(call.audio).toBeUndefined()
  })

  it('说的就是那一句,和工作台那份逐字相同(拼回去对一遍)', () => {
    const spy = vi.fn()
    speakOpeningLine(ONBOARDING_OPENING_LINE, spy)
    expect(spy.mock.calls.map(call => call[0]).join('')).toBe(ONBOARDING_OPENING_LINE)
  })
})
