/**
 * 开场白被吃掉开头(2026-09-27,卡 CL)。
 *
 * 维护者 21:3x 手机打过去:「一上来就听到『吩咐』两个字,『吩』字还是尾巴,前面估计被吃了。」
 * 工人一帧都没少发 —— 吃掉那半秒的是对端起播那一下(手机那个 `<audio>` 从暂停里 `play()`
 * 回来要重开 AudioTrack;座机那一路是订阅刚落地那一瞬)。
 *
 * 这一组钉四件:
 *   ① **对端没订上工人音轨就不发开场白**,订上了才发;
 *   ② **等到点(缺省 1.5s)照旧发** —— 不许因为等而让他举着一只安静的听筒;
 *   ③ **等的那一段里挂断 = 这一句掐掉**,不在空听筒里响、更不串进下一通;
 *   ④ **命中缓存的那一条前面垫一段静音**(缺省 260ms):被吃掉的是静音,第一个字整着到;
 *      通话中途那句「先应」不垫(那一条在 agent.ts 里明着传 0)。
 */
import { describe, expect, it } from 'vitest'
import {
  GreetingCache,
  OPENER_LEAD_SILENCE_MS,
  OpeningDelay,
  openerSpeech,
  silencePcm,
} from '../src/tts/greeting.ts'
import { OPENER_SUBSCRIBE_WAIT_MS, audioPublicationOf, createOpenerGate } from '../src/tts/openerGate.ts'

/** 一个能手动拨到点的假定时器(与 greeting.test.ts 那一份同一套)。 */
function fakeTimer() {
  const queued: { fn: () => void, ms: number, canceled: boolean }[] = []
  const setTimer = (fn: () => void, ms: number): (() => void) => {
    const one = { fn, ms, canceled: false }
    queued.push(one)
    return () => { one.canceled = true }
  }
  const fire = (): void => { for (const one of [...queued]) { if (!one.canceled) one.fn() } }
  return { queued, setTimer, fire }
}

/** 一段能听出长短的假 PCM。 */
function fakePcm(samples: number): Buffer {
  const out = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i += 1) out.writeInt16LE(((i % 1000) - 500), i * 2)
  return out
}

/** 一张只有一句的缓存(不向任何后端要东西)。 */
async function cacheWith(text: string, samples = 8000): Promise<GreetingCache> {
  const cache = new GreetingCache({
    synthesize: async () => ({ pcm: fakePcm(samples), sampleRate: 16_000 }),
    lines: () => [text],
  })
  await cache.warm()
  return cache
}

/** 把一条 ReadableStream 读干净。 */
async function drain<T>(stream: ReadableStream<T>): Promise<T[]> {
  const out: T[] = []
  const reader = stream.getReader()
  for (;;) {
    const got = await reader.read()
    if (got.done) return out
    out.push(got.value)
  }
}

describe('① 对端订上工人音轨了再开口', () => {
  it('★ 没订上之前一个字都不发,订上那一刻才发', async () => {
    const timer = fakeTimer()
    let subscribed = (): void => {}
    const publication = {
      kind: 1,
      waitForSubscription: async () => { await new Promise<void>((resolve) => { subscribed = resolve }) },
    }
    const gate = createOpenerGate({ publication: () => publication, setTimer: timer.setTimer })
    const said: string[] = []
    const opening = new OpeningDelay({ delayMs: 700, setTimer: timer.setTimer, ready: gate })
    opening.schedule(() => said.push('老板,有什么吩咐?'))
    timer.queued[0]?.fn() // 700ms 到了
    await Promise.resolve()
    expect(said).toEqual([]) // 还没订上:一个字都没发
    expect(opening.pending).toBe(true)
    subscribed()
    await new Promise<void>((done) => { setTimeout(done, 0) })
    expect(said).toEqual(['老板,有什么吩咐?'])
    expect(opening.pending).toBe(false)
  })

  it('★ 等到点(缺省 1.5s)照旧开口:不能因为等而让他举着一只安静的听筒', async () => {
    expect(OPENER_SUBSCRIBE_WAIT_MS).toBe(1500)
    const timer = fakeTimer()
    const gate = createOpenerGate({
      publication: () => ({ kind: 1, waitForSubscription: () => new Promise<void>(() => {}) }),
      setTimer: timer.setTimer,
    })
    const outcome = gate()
    expect(timer.queued[0]?.ms).toBe(1500)
    timer.queued[0]?.fn()
    expect((await outcome).how).toBe('timeout')
  })

  it('还没发布音轨(工人刚起来那一瞬)= 不等,照旧开口', async () => {
    const gate = createOpenerGate({ publication: () => undefined })
    expect((await gate()).how).toBe('skipped')
  })

  it('上限设成 0 = 一下都不等(逐字回到 09-23 那一版)', async () => {
    let asked = 0
    const gate = createOpenerGate({
      timeoutMs: 0,
      publication: () => { asked += 1; return { kind: 1, waitForSubscription: async () => {} } },
    })
    expect((await gate()).how).toBe('skipped')
    expect(asked).toBe(0)
  })

  it('等订阅那一下抛了也照旧开口(SDK 换了行为、房间断了)', async () => {
    const gate = createOpenerGate({
      publication: () => ({ kind: 1, waitForSubscription: () => Promise.reject(new Error('房间断了')) }),
    })
    expect((await gate()).how).toBe('skipped')
  })

  it('本地发布里挑音轨那一条:视频那条不算,取不到就 undefined', () => {
    const audio = { kind: 1, waitForSubscription: async () => {} }
    expect(audioPublicationOf([{ kind: 2, waitForSubscription: async () => {} }, audio])).toBe(audio)
    expect(audioPublicationOf([{ kind: 1 }])).toBeUndefined() // 没有那个能力的 SDK
    expect(audioPublicationOf(undefined)).toBeUndefined()
  })
})

describe('② 等的那一段里挂断', () => {
  it('★ 挂断 = 这一句掐掉,订阅后来落地也不许再响(更不许串进下一通)', async () => {
    const timer = fakeTimer()
    let subscribed = (): void => {}
    const gate = createOpenerGate({
      publication: () => ({ kind: 1, waitForSubscription: async () => { await new Promise<void>((r) => { subscribed = r }) } }),
      setTimer: timer.setTimer,
    })
    const said: string[] = []
    const opening = new OpeningDelay({ delayMs: 700, setTimer: timer.setTimer, ready: gate })
    opening.schedule(() => said.push('老板,有什么吩咐?'))
    timer.queued[0]?.fn()
    await Promise.resolve()
    opening.cancel() // 他把听筒放回去了
    subscribed()
    await new Promise<void>((done) => { setTimeout(done, 0) })
    expect(said).toEqual([])
    expect(opening.pending).toBe(false)
  })

  it('不带这道闸时行为一字不差(逐字回到上一版:到点当场说)', () => {
    const timer = fakeTimer()
    const said: string[] = []
    const opening = new OpeningDelay({ delayMs: 700, setTimer: timer.setTimer })
    opening.schedule(() => said.push('老板,有什么吩咐?'))
    timer.fire()
    expect(said).toEqual(['老板,有什么吩咐?'])
  })
})

describe('③ 前导静音(被吃掉的是静音,第一个字整着到)', () => {
  it('缺省 260ms', () => {
    expect(OPENER_LEAD_SILENCE_MS).toBe(260)
    expect(silencePcm(260, 16_000).length).toBe(Math.round(16_000 * 0.26) * 2)
    expect(silencePcm(0, 16_000).length).toBe(0)
    expect(silencePcm(-5, 16_000).length).toBe(0)
  })

  it('★ 命中缓存那一条:音频前面多了一段静音,第一帧是听不见的底噪,原来那段一个采样点都没少', async () => {
    const line = '老板,有什么吩咐?'
    const cache = await cacheWith(line)
    const bare = openerSpeech(cache, line, { leadSilenceMs: 0 })
    const padded = openerSpeech(cache, line)
    expect(padded.leadSilenceMs).toBe(OPENER_LEAD_SILENCE_MS)
    const bareFrames = await drain(bare.audio as ReadableStream<{ data: Int16Array }>)
    const paddedFrames = await drain(padded.audio as ReadableStream<{ data: Int16Array }>)
    const samplesOf = (frames: { data: Int16Array }[]): number => frames.reduce((sum, one) => sum + one.data.length, 0)
    expect(samplesOf(paddedFrames) - samplesOf(bareFrames)).toBe(Math.round(16_000 * 0.26))
    // 开头那一帧整帧静音 —— 对端起播吃掉的就是它
    // 09-28 19:3x 起垫的是听不见的底噪(|样本| ≤ 3,见 silencePcm),不再是纯零
    expect([...paddedFrames[0]?.data ?? []].every(one => Math.abs(one) <= 3)).toBe(true)
    // 那句话本身一个采样点都没动:垫的只是前面
    const tail = paddedFrames.flatMap(one => [...one.data]).slice(Math.round(16_000 * 0.26))
    expect(tail.slice(0, 20)).toEqual(bareFrames.flatMap(one => [...one.data]).slice(0, 20))
  })

  it('没命中缓存 = 没有音频可垫(现合成那一两秒本身就是前导),但这一句照样说', () => {
    const speech = openerSpeech(undefined, '老板,有什么吩咐?')
    expect(speech).toEqual({ text: '老板,有什么吩咐?', cached: false, leadSilenceMs: 0 })
  })
})
