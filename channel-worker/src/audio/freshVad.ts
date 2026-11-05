/**
 * VAD **只听最近的**:落后了就把最旧的音频丢掉,不排着队补作业(2026-09-25,卡 fix/call-under-load-and-name)。
 *
 * ## 为什么
 *
 * 框架里判「他开口了 / 说完了」的是 Silero VAD。它跑在工人的主线程上(onnxruntime 的 `run()`
 * 是 `setImmediate` 里同步算的),一窗 32ms 音频正常只要一两毫秒。这台 Mac 一忙,主线程抢不到 CPU,
 * 音频帧就在框架的 tee 分支里排起队 —— **它会把排着的每一帧都补算一遍**:
 *
 *   - 09-24 晚引导:落后 31 秒(`VAD inference is slower than realtime · delay 31106`),
 *     她把他半分钟前的话当成「刚开口」;
 *   - 同晚 19:07–19:19(没在通话,手机挂在房里,静音帧照样进来):落后一路涨到 741 秒,
 *     下一通电话一接起来,VAD 还在算十二分钟前的静音;
 *   - 这张卡的压测(两份全量 vitest):落后 121 秒。
 *
 * 落后的 VAD 判出来的东西全是过时的:半分钟前的「他开口了」会去打断她现在的话,
 * 真正「他说完了」要等它把前面的旧账算完才轮得到。旧音频对 VAD **没有任何价值**。
 *
 * ## 怎么做
 *
 * 包一层,框架看见的仍是一个 `VAD`(同一套事件、同一个 `minSilenceDuration`):
 *   - **收**:从框架那条输入里一有帧就拿走,放进自己的小队列;
 *   - **丢**:队列 + 已交给 Silero 还没算完的,合计超过 {@link FRESH_VAD_MAX_LAG_MS},
 *     就从**最旧的**那头丢,丢到只剩 {@link FRESH_VAD_KEEP_MS};
 *   - **喂**:每次最多先给 Silero {@link FRESH_VAD_FEED_AHEAD_MS} —— 喂多了它自己的队列又会攒起来;
 *     它每算完一窗(INFERENCE_DONE)就接着喂。
 *
 * **只丢 VAD 那一路**:送火山识别的是框架 tee 出去的另一路,一帧不丢 —— 他说的每个字照样识别。
 * Silero 的状态机不重置(重置会吞掉一次「说完了」,框架就一直以为他在说),只是跳过了一段。
 * 代价:落后时 VAD 攒的那段「他这句话的音频」会缺一截 —— 只有分段识别(没配火山时的兜底)用它。
 */
import type { AudioFrame } from '@livekit/rtc-node'
import { VAD, VADEventType, VADStream } from '@livekit/agents'

/** 落后超过这么多(毫秒)就开始丢。1 秒:比一次正常的「说完了」判定(550ms 静音)长一点。 */
export const FRESH_VAD_MAX_LAG_MS = 1000
/** 丢到只剩最近这么多(毫秒)。 */
export const FRESH_VAD_KEEP_MS = 300
/** 一次最多先喂给 Silero 这么多(毫秒)。 */
export const FRESH_VAD_FEED_AHEAD_MS = 100
/** 「VAD 落后」那一行日志最密多久一条(毫秒)。 */
export const FRESH_VAD_LOG_EVERY_MS = 5000

export interface FreshVadOptions {
  maxLagMs?: number
  keepMs?: number
  feedAheadMs?: number
  /** 丢了音频时说一句(已经按 {@link FRESH_VAD_LOG_EVERY_MS} 限过频)。 */
  log?: (line: string) => void
  now?: () => number
}

function frameMs(frame: AudioFrame): number {
  return frame.sampleRate > 0 ? (frame.samplesPerChannel / frame.sampleRate) * 1000 : 0
}

/**
 * 「现在落后多少、该丢多少」的账本。**纯数据结构**,不认识 Silero —— 用例直接拿它验丢法。
 */
export class FreshnessLedger<T> {
  readonly maxLagMs: number
  readonly keepMs: number
  readonly feedAheadMs: number
  #queue: { item: T, ms: number }[] = []
  #queuedMs = 0
  #pushedMs = 0
  #inferredMs = 0
  /** 一共丢了多少毫秒(给日志与用例)。 */
  droppedMs = 0

  constructor(options: { maxLagMs?: number, keepMs?: number, feedAheadMs?: number } = {}) {
    this.maxLagMs = options.maxLagMs ?? FRESH_VAD_MAX_LAG_MS
    this.keepMs = options.keepMs ?? FRESH_VAD_KEEP_MS
    this.feedAheadMs = options.feedAheadMs ?? FRESH_VAD_FEED_AHEAD_MS
  }

  /** 交给 Silero 了、它还没算完的那一截。 */
  get inflightMs(): number { return Math.max(0, this.#pushedMs - this.#inferredMs) }
  /** 此刻落后多少:排着的 + 在算的。 */
  get lagMs(): number { return this.#queuedMs + this.inflightMs }
  get queued(): number { return this.#queue.length }

  /** 收一帧。超了就从最旧的那头丢;回这一下丢了多少毫秒(0 = 没丢)与丢之前落后多少。 */
  add(item: T, ms: number): { droppedMs: number, lagBeforeMs: number } {
    this.#queue.push({ item, ms })
    this.#queuedMs += ms
    const lagBeforeMs = this.lagMs
    if (lagBeforeMs <= this.maxLagMs) return { droppedMs: 0, lagBeforeMs }
    let dropped = 0
    // 至少留最新的那一帧;丢到「排着的 + 在算的」不超过 keepMs。
    while (this.#queue.length > 1 && this.#queuedMs + this.inflightMs > this.keepMs) {
      const head = this.#queue.shift() as { item: T, ms: number }
      this.#queuedMs -= head.ms
      dropped += head.ms
    }
    this.droppedMs += dropped
    return { droppedMs: dropped, lagBeforeMs }
  }

  /** 该喂 Silero 的那几帧(最多喂到 feedAheadMs 在算)。 */
  takeFeed(): T[] {
    const out: T[] = []
    while (this.#queue.length > 0 && this.inflightMs < this.feedAheadMs) {
      const head = this.#queue.shift() as { item: T, ms: number }
      this.#queuedMs -= head.ms
      this.#pushedMs += head.ms
      out.push(head.item)
    }
    return out
  }

  /** Silero 算完了这么多(INFERENCE_DONE 带回来的那一截音频的时长)。 */
  inferred(ms: number): void { this.#inferredMs += ms }

  /** 分段边界(框架的 flush):排着的不要了,账从头记。 */
  reset(): void {
    this.#queue = []
    this.#queuedMs = 0
    this.#pushedMs = 0
    this.#inferredMs = 0
  }
}

/** 包在 Silero 外面的那一层。框架拿它当普通的 VAD 用。 */
export class FreshVAD extends VAD {
  label = 'butler.FreshVAD'
  readonly #inner: VAD
  readonly #options: FreshVadOptions

  constructor(inner: VAD, options: FreshVadOptions = {}) {
    super({ updateInterval: inner.capabilities.updateInterval })
    this.#inner = inner
    this.#options = options
  }

  override get minSilenceDuration(): number | null {
    return this.#inner.minSilenceDuration
  }

  stream(): VADStream {
    return new FreshVADStream(this, this.#inner.stream(), this.#options)
  }

  override async close(): Promise<void> {
    await this.#inner.close()
  }
}

export class FreshVADStream extends VADStream {
  readonly #inner: VADStream
  readonly #ledger: FreshnessLedger<AudioFrame>
  readonly #log: ((line: string) => void) | undefined
  readonly #now: () => number
  #lastLogAt = -Infinity
  /** 上一条日志之后又丢了多少、最落后到多少。 */
  #pendingDroppedMs = 0
  #pendingMaxLagMs = 0

  constructor(vad: VAD, inner: VADStream, options: FreshVadOptions) {
    super(vad)
    this.#inner = inner
    this.#ledger = new FreshnessLedger<AudioFrame>(options)
    this.#log = options.log
    this.#now = options.now ?? Date.now
    void this.#intake().catch(() => { /* 输入断了:框架那边在收场 */ })
    void this.#relay().catch(() => { /* 里面那一层关了 */ })
  }

  /** 此刻落后多少毫秒(给日志与体检)。 */
  get lagMs(): number { return this.#ledger.lagMs }

  async #intake(): Promise<void> {
    while (!this.closed) {
      const { done, value } = await this.inputReader.read()
      if (done) break
      if (typeof value === 'symbol') {
        // 分段边界:排着的旧帧不要了,原样转给 Silero(它会自己清状态)。
        this.#ledger.reset()
        try { this.#inner.flush() } catch { /* 里面已经关了 */ }
        continue
      }
      const { droppedMs, lagBeforeMs } = this.#ledger.add(value, frameMs(value))
      if (droppedMs > 0) this.#noteDrop(droppedMs, lagBeforeMs)
      this.#scheduleFeed()
    }
  }

  /**
   * **喂排到下一拍**(setImmediate),不在收帧的当下喂。主线程卡住又放开时,积压的帧是在同一串
   * 微任务里一口气涌进来的;当下就喂的话,最先喂进去的正是最旧的那几帧(可能正好把半分钟前的
   * 「他开口了」又判一遍)。排到下一拍,这一股先收完、丢完,喂进去的就是最新的。
   * 平时一帧一帧来,这一拍不到一毫秒。
   */
  #feedScheduled = false
  #scheduleFeed(): void {
    if (this.#feedScheduled) return
    this.#feedScheduled = true
    setImmediate(() => {
      this.#feedScheduled = false
      this.#feed()
    })
  }

  #feed(): void {
    for (const frame of this.#ledger.takeFeed()) {
      try { this.#inner.pushFrame(frame) }
      catch { return }
    }
  }

  async #relay(): Promise<void> {
    for await (const event of this.#inner) {
      if (event.type === VADEventType.INFERENCE_DONE) {
        this.#ledger.inferred(event.frames.reduce((sum, frame) => sum + frameMs(frame), 0))
        this.#feed()
      }
      if (!this.sendVADEvent(event)) break
    }
  }

  #noteDrop(droppedMs: number, lagBeforeMs: number): void {
    const now = this.#now()
    this.#pendingDroppedMs += droppedMs
    this.#pendingMaxLagMs = Math.max(this.#pendingMaxLagMs, lagBeforeMs)
    if (now - this.#lastLogAt < FRESH_VAD_LOG_EVERY_MS) return
    this.#lastLogAt = now
    this.#log?.(`[channel-worker] VAD 落后 ${Math.round(this.#pendingMaxLagMs)}ms(这台 Mac 太忙),丢掉最旧的 ${Math.round(this.#pendingDroppedMs)}ms 音频,只听最近的 ${this.#ledger.keepMs}ms —— 送识别的那一路一帧不丢。`)
    this.#pendingDroppedMs = 0
    this.#pendingMaxLagMs = 0
  }

  /**
   * 收场。里面那一层照框架收 Silero 的办法收(`detachInputStream` + `close`),
   * **不调 `endInput()`**:基类那一下去关一条被自己的 writer 锁着的流,回的是一个没人接的拒绝。
   */
  override close(): void {
    try { this.#inner.detachInputStream() } catch { /* 本来就没接 */ }
    try { this.#inner.close() } catch { /* 已经关了 */ }
    super.close()
  }
}
