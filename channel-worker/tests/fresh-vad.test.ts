/**
 * VAD 只听最近的(2026-09-25,卡 fix/call-under-load-and-name)。
 *
 * 钉住三件事:
 *   ① 账本:不超就不丢;超了从**最旧**的那头丢,留最新的;一次最多喂 feedAhead 给 Silero;
 *   ② 包起来之后框架看见的事件与里面那一层一模一样(START / INFERENCE_DONE / END 原样转出);
 *   ③ 主线程卡了一大段、帧一股脑涌进来时,真正交给里面那一层的只有最近那一小截 ——
 *      09-24 晚那种「VAD 落后 31 秒、把半分钟前的话当成刚开口」不会再有。
 */
import { AudioFrame } from '@livekit/rtc-node'
import { VAD, VADEventType, VADStream, type VADEvent } from '@livekit/agents'
import { describe, expect, it } from 'vitest'
import { FreshVAD, FreshnessLedger } from '../src/audio/freshVad.ts'

describe('账本(FreshnessLedger)', () => {
  it('落后没超上限:一帧不丢', () => {
    const ledger = new FreshnessLedger<number>({ maxLagMs: 1000, keepMs: 300, feedAheadMs: 100 })
    for (let i = 0; i < 50; i += 1) expect(ledger.add(i, 10).droppedMs).toBe(0)
    expect(ledger.lagMs).toBe(500)
  })

  it('超了:从最旧的那头丢,只留最近的 keepMs', () => {
    const ledger = new FreshnessLedger<number>({ maxLagMs: 1000, keepMs: 300, feedAheadMs: 100 })
    let dropped = 0
    for (let i = 0; i < 200; i += 1) dropped += ledger.add(i, 10).droppedMs
    // 两秒进来,留下的不超过一秒,其余都是从最旧那头丢的。
    expect(ledger.lagMs).toBeLessThanOrEqual(1000)
    expect(dropped + ledger.lagMs).toBe(2000)
    expect(ledger.droppedMs).toBe(dropped)
    // 喂出去的第一帧是**最近**那一截里的(不是 0 号那种两秒前的旧帧)。
    const fed = ledger.takeFeed()
    expect(fed[0]).toBeGreaterThanOrEqual(100)
  })

  it('一次最多喂 feedAheadMs;Silero 算完一截才接着喂', () => {
    const ledger = new FreshnessLedger<number>({ maxLagMs: 10_000, keepMs: 300, feedAheadMs: 100 })
    for (let i = 0; i < 30; i += 1) ledger.add(i, 10)
    expect(ledger.takeFeed()).toHaveLength(10)
    expect(ledger.takeFeed()).toHaveLength(0)
    ledger.inferred(32)
    expect(ledger.takeFeed()).toHaveLength(4)
  })

  it('分段边界(flush):排着的不要了,账从头记,不会因为 Silero 丢了尾巴就永远喂不进去', () => {
    const ledger = new FreshnessLedger<number>({ maxLagMs: 10_000, keepMs: 300, feedAheadMs: 100 })
    for (let i = 0; i < 30; i += 1) ledger.add(i, 10)
    ledger.takeFeed()
    ledger.reset()
    expect(ledger.lagMs).toBe(0)
    ledger.add(99, 10)
    expect(ledger.takeFeed()).toEqual([99])
  })
})

/**
 * 一个假的「里面那一层」:每收到一帧就回一条 INFERENCE_DONE(带着这一帧),第一帧之前先回一条
 * START_OF_SPEECH;每算完一帧让出一拍(像 Silero 那样 `setImmediate`)。收到过哪些帧都记着。
 */
class SlowInnerStream extends VADStream {
  received: AudioFrame[] = []
  constructor(vad: VAD) {
    super(vad)
    void this.run()
  }

  async run(): Promise<void> {
    while (!this.closed) {
      const { done, value } = await this.inputReader.read()
      if (done) break
      if (typeof value === 'symbol') continue
      this.received.push(value)
      const base = { samplesIndex: 0, timestamp: 0, speechDuration: 0, silenceDuration: 0, probability: 0.9, inferenceDuration: 1, speaking: true, rawAccumulatedSilence: 0, rawAccumulatedSpeech: 0 }
      if (this.received.length === 1) this.sendVADEvent({ ...base, type: VADEventType.START_OF_SPEECH, frames: [] })
      this.sendVADEvent({ ...base, type: VADEventType.INFERENCE_DONE, frames: [value] })
      await new Promise(resolve => setImmediate(resolve))
    }
  }
}

class SlowInnerVAD extends VAD {
  label = 'test.SlowInner'
  last: SlowInnerStream | undefined
  constructor() { super({ updateInterval: 32 }) }
  override get minSilenceDuration(): number { return 550 }
  stream(): VADStream {
    this.last = new SlowInnerStream(this)
    return this.last
  }
}

function tenMs(index: number): AudioFrame {
  const data = new Int16Array(160)
  data[0] = index // 记下这是第几帧
  return new AudioFrame(data, 16000, 1, 160)
}

async function collect(stream: VADStream, count: number, timeoutMs = 2000): Promise<VADEvent[]> {
  const events: VADEvent[] = []
  const until = Date.now() + timeoutMs
  while (events.length < count && Date.now() < until) {
    const next = await Promise.race([
      stream.next(),
      new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), 50)),
    ])
    if (next === 'timeout') continue
    if (next.done === true) break
    events.push(next.value)
  }
  return events
}

describe('包起来之后(FreshVAD)', () => {
  it('框架看见的还是那几样:minSilenceDuration 照原样,事件原样转出', async () => {
    const inner = new SlowInnerVAD()
    const vad = new FreshVAD(inner)
    expect(vad.minSilenceDuration).toBe(550)
    const stream = vad.stream()
    stream.pushFrame(tenMs(1))
    stream.pushFrame(tenMs(2))
    const events = await collect(stream, 3)
    expect(events.map(event => event.type)).toEqual([VADEventType.START_OF_SPEECH, VADEventType.INFERENCE_DONE, VADEventType.INFERENCE_DONE])
    stream.close()
  })

  it('主线程卡了 5 秒、帧一股脑涌进来:交给里面那一层的只有最近那一小截,而且是最新的', async () => {
    const inner = new SlowInnerVAD()
    const lines: string[] = []
    const vad = new FreshVAD(inner, { maxLagMs: 1000, keepMs: 300, feedAheadMs: 100, log: line => lines.push(line) })
    const stream = vad.stream()
    // 5 秒的音频在同一刻涌进来(同步推,中间一次都不让出事件循环 —— 正是卡住又放开的样子)。
    for (let i = 0; i < 500; i += 1) stream.pushFrame(tenMs(i))
    await collect(stream, 60, 1500)
    const got = inner.last?.received ?? []
    expect(got.length).toBeLessThan(60)
    // 第一帧就已经是最近那 0.3~1 秒里的,不是 5 秒前的 0 号。
    expect(got[0]?.data[0]).toBeGreaterThan(400)
    expect(lines.join('\n')).toContain('VAD 落后')
    expect(lines.join('\n')).toContain('送识别的那一路一帧不丢')
    stream.close()
  })
})
