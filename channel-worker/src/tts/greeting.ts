/**
 * 提机那一刻先问的那一句:**预先合成好、按称呼放在内存里**(2026-09-23)。
 *
 * ## Ben 的原话(12:xx)
 *
 * > 「我拿起电话到说话中间可能间隔有一两秒吧,所以最好事务官能先问一句:
 * > 『老板,有什么吩咐?』还蛮重要的。」
 *
 * 那一两秒是真的:提机 → `call/start` 到工人 → `session.say()` → 8792 → 火山合成 →
 * 音频回来 → 进房 → 派上出声。光合成那一段,09-23 真机第一批量到的是 1.4~1.6 秒
 * (流式首包也要 200~400ms)。而他这会儿正把听筒举在耳朵边上,听筒里一片安静。
 *
 * ## 这一份怎么做
 *
 * 那一句话是**定死的**(`<称呼>,有什么吩咐?`),称呼来自人设里那张表(address.ts),
 * 所以整通电话里唯一能提前知道的就是它。于是:
 *
 *   - **工人一启动就合成**(和换音色之后),一个称呼一句,结果按**原文**存在内存里;
 *   - 提机的 `start` 一到,直接把缓存那段 PCM 切成帧交给 `session.say(text, { audio })`
 *     —— 框架看见 `audio` 就**整条跳过 TTS**(`agent_activity.ttsTask` 里那个 `if (!audio)`),
 *     不等模型、不等 8792;
 *   - 缓存没命中(还没合完、8792 那会儿不在)时**照样说这一句**,只是退回现合成。
 *     一句话都不少,只是慢回从前那个样子。
 *
 * ## 三条纪律
 *
 *   ① **绝不抛**。预热跑在工人启动那一段,它自己把进程带走就太蠢了 ——
 *      合不出来就是「这一句没缓存」,提机照样能打通。
 *   ② **按原文存,不按称呼存**。同一句话谁要都能取(来电那句 `ringOpener` 因此
 *      不用改一个字就能吃这份缓存,只要有人把它预热进来)。
 *   ③ **换音色要整张作废**。缓存的是**声音**,不是文字:不清掉的话,他刚换完嗓子、
 *      下一通提机听见的还是旧的那一个 —— 09-20 那个「一通电话里两个嗓子」的老毛病。
 *
 * 这个文件不认识 LiveKit 的房间、不认识 `session`:合成走注入的一个函数,
 * 接线在 agent.ts。
 */
import { speakableText } from './speakable.ts'
import { AudioFrame } from '@livekit/rtc-node'
import { AudioByteStream } from '@livekit/agents'
import { TTS_SAMPLE_RATE, decodeMp3, pcmOfWav, upstreamDetailOf } from './butlerTts.ts'

/**
 * 提机那一句的后半截。**定死一句**(预合成要一份确定的文字,花样多一句就多一份缓存)。
 *
 * ——— 2026-10-02 从「,有什么吩咐?」改成「,我在。」(卡「电话里像个活人」)———
 *
 * Air 那几通里「{称呼},有什么吩咐?」出现 **22 次**,而且那阵子称呼表里存的是她的整句话
 * (「以后叫小笨蛋」),于是每次接起来都是一模一样的
 * 「以后叫小笨蛋,有什么吩咐?」—— 维护者:「肯定是机械化,没有活人感」。
 *
 * 两处病:**一句问话**(接起来先被问一句,人要先想想答什么)和**一个模板**。
 * 「我在」把问话换成了应答:她接起来就知道通了、该她说。
 * 称呼仍然按天轮换(address.ts),所以隔天听到的不是同一句。
 */
export const OFFHOOK_GREETING_TAIL = ',我在。'

/** 提机那一句。称呼由 address.ts 的轮换表给。 */
export function offhookGreeting(address: string): string {
  const who = address.trim()
  return `${who === '' ? '老板' : who}${OFFHOOK_GREETING_TAIL}`
}

/**
 * 开场那一句**晚多久再出口**(毫秒)。
 *
 * ## 维护者 2026-09-23 14:20 真机原话(0.2.71)
 *
 * > 「拿起电话之后,我放到耳边,一听到『吩咐』两个字,很明显说的太早了」
 *
 * 也就是说**上一版那句话本身是成功的 —— 它快过了头**:叉簧一抬工人就发帧,
 * 而他这会儿还在把听筒从座上举到耳边。这一段路 0.5–1 秒,期间听筒贴在半空,
 * 「老板,有什么吩咐?」念完一半才到他耳朵,他听见的就只有后两个字。
 *
 * 700ms 是那段路的中位:更短他还没贴上,更长就回到「拿起电话之后一片安静」——
 * 那正是上一张卡在治的毛病。要在真机上试别的值:`WORKBENCH_CHANNEL_GREETING_DELAY_MS`
 * (设 `0` = 逐字回到 09-23 下午那一版的行为)。
 */
export const DEFAULT_GREETING_DELAY_MS = 700

export interface OpeningDelayOptions {
  /** 晚多久。`<= 0` = 当场说(不排定时器)。 */
  delayMs: number
  /** 定时器(测试注入)。回一个「取消它」的函数。 */
  setTimer?: (fn: () => void, ms: number) => () => void
  /**
   * 排到点之后**还要等这一下**(2026-09-27,卡 CL):对端订上工人音轨了没有
   * (tts/openerGate.ts 的 `createOpenerGate`)。缺席 = 不等,逐字回到上一版。
   *
   * **等的这一段里挂断照样掐得住**:`cancel()` 之后这一句不许再出口 ——
   * 更要紧的是不许串进下一通(那一条与定时器那一条同一个道理,见类注 ①)。
   * 它自己不许抛、不许吊死:最坏也是到点照旧开口(openerGate 里那条纪律)。
   */
  ready?: () => Promise<unknown>
}

/**
 * 「这一句晚一点再说」(2026-09-23 下午第二版)。
 *
 * 为什么要单独一个小东西而不是在 agent.ts 里写一行 `setTimeout`:
 *
 *   ① **挂断要来得及拦住它**。他提机之后 0.3 秒又放下(拨错了、改主意了),
 *      那一句不该在空听筒里响 —— 更要紧的是**不该在下一通里冒出来**;
 *   ② **两处共用**(提机的 `greet` 与来电接起的 `onAnswered`),两处的行为必须一模一样;
 *   ③ agent.ts 那一段要真起一个 LiveKit 会话才跑得到,**延后与取消这两条就没有用例看着**
 *      —— 上一张卡的洞正是出在这种地方。
 *
 * **排第二次会把第一次取消掉**:一通电话只有一句开场白。
 */
export class OpeningDelay {
  readonly #delayMs: number
  readonly #setTimer: (fn: () => void, ms: number) => () => void
  readonly #ready: (() => Promise<unknown>) | undefined
  #cancel: (() => void) | undefined
  /**
   * 第几句。`cancel()` / 再排一次都 +1:**等订阅那一段里挂断**之后,
   * 那趟还在等的 promise 回来时对不上号就一个字都不说(定时器能 `clearTimeout`,
   * 一个已经在飞的 await 只能这样拦)。
   */
  #generation = 0
  /** 排着 / 正在等订阅(两样都算「这一句还没出口但已经在路上」)。 */
  #waiting = false

  constructor(options: OpeningDelayOptions) {
    this.#delayMs = options.delayMs
    this.#ready = options.ready
    this.#setTimer = options.setTimer ?? ((fn, ms) => {
      const timer = setTimeout(fn, ms)
      timer.unref?.()
      return () => { clearTimeout(timer) }
    })
  }

  /** 排着没有(测试与日志用)。等订阅那一段也算排着。 */
  get pending(): boolean { return this.#cancel !== undefined || this.#waiting }

  /** 这一通要等多久(毫秒)。 */
  get delayMs(): number { return this.#delayMs }

  /**
   * 排一句。`delayMs <= 0` 且不等订阅时**同步**就说了(逐字回到不延后那一版)。
   * 说出口时抛了不许把电话带走:那一通就是没开场白,不是出错。
   */
  schedule(speak: () => void): void {
    this.cancel()
    const mine = this.#generation
    if (this.#delayMs <= 0) { this.#afterDelay(speak, mine); return }
    const stop = this.#setTimer(() => { this.#cancel = undefined; this.#afterDelay(speak, mine) }, this.#delayMs)
    this.#cancel = stop
  }

  /** 别说了(挂断、他自己先开口了)。没排着就什么都不做。 */
  cancel(): void {
    this.#generation += 1
    this.#waiting = false
    const stop = this.#cancel
    this.#cancel = undefined
    if (stop === undefined) return
    try { stop() }
    catch { /* 取消一个定时器失败不值得再出一个错 */ }
  }

  /** 700ms 到了:先等对端订上音轨(没有这道闸就当场说)。 */
  #afterDelay(speak: () => void, mine: number): void {
    const ready = this.#ready
    if (ready === undefined) { this.#fire(speak); return }
    this.#waiting = true
    let waited: Promise<unknown>
    try { waited = ready() }
    catch { this.#waiting = false; this.#fire(speak); return }
    void Promise.resolve(waited)
      // 等不出结果(抛了)也照样说:这一句不许因为一道闸而丢掉。
      .catch(() => undefined)
      .then(() => {
        if (mine !== this.#generation) return // 等的这一段里挂了 / 又排了一句
        this.#waiting = false
        this.#fire(speak)
      })
  }

  #fire(speak: () => void): void {
    try { speak() }
    catch { /* 见上 */ }
  }
}

/**
 * 「这一句系统已经替你说过了」。开场之后换上的提示词里要有它,
 * 否则模型的第一句话十有八九是再问一遍「有什么吩咐」—— 他会以为她没听见自己刚说的话。
 */
export function greetedNote(line: string): string {
  return `开场那一句(「${line}」)**已经由系统念给他了**:不要重复它、不要再问一次「有什么吩咐」、`
    + '也不要自我介绍(这个电话只有你会接,他知道是你)。他接着说什么就应什么。'
}

/**
 * 底子 + 「已经开过口」那一行。`openedWith` 缺席(这一通还没开口 / 已经挂了)时
 * **一个字都不加** —— 平时那套提示词里凭空多一句「你已经打过招呼了」会让她连招呼都不打。
 *
 * **叠不起来**:同一份底子拼两次还是一句(提示词在一通电话里会换好几回:
 * 「关于我自己」现拼一次、换来电那套一次)。
 */
export function withGreetedNote(base: string, openedWith: string | undefined): string {
  if (openedWith === undefined || openedWith.trim() === '') return base
  const note = greetedNote(openedWith)
  return base.includes(note) ? base : `${base}\n\n${note}`
}

/**
 * 开场那一句交给 `session.say()` 时**固定带上这一条**(2026-09-27,卡 fix/voice-onboarding-latency)。
 *
 * `allowInterruptions: false` 不只是「不许打断」。@livekit/agents 1.9 的 `ttsTask` 在
 * **转发第一帧之前**会调 `reconcilePlayoutPause()`:只要「这一句允许被打断 + 这会儿不在说话 +
 * 用户不是静音态」,它就先把播出暂停,等「误判打断」那个定时器来放。免提摆在房间里、
 * 树莓派话筒摆在桌上,VAD 一直听见声音,那道暂停就一直不放 —— 09-27 现场因此
 * **音频 0.7 秒就合好了、33 秒没出房**(`tts_first_ms: 737, publish_ms: 33291`)。
 * 允许打断的那一支还会在合成之前先 `await userSilenceEvent`,同一个道理。
 *
 * 开场这一句是**整通电话里最不能被按住的一句**(他这会儿正把听筒贴在耳朵上),而且短 ——
 * 提机那句七个字、引导第一小句二十字。所以这一句按住不许暂停;接下来的话照旧可打断。
 */
export const OPENER_SAY_OPTIONS = { allowInterruptions: false } as const

/**
 * 开场那一句**前面垫多少静音**(毫秒,2026-09-27,卡 CL)。
 *
 * ## 维护者 21:3x 真机原话(手机打给事务官)
 *
 * > 「我打过去一上来就听到『吩咐』两个字,『吩』字还是尾巴,前面估计被吃了。」
 *
 * 工人一帧都没少发(日志:`普通通话招呼 ← 手机:说了` → 700ms → `她说:老板,有什么吩咐?`)。
 * 吃掉那半秒的是**对端起播那一下**:手机常驻房间时那个 `<audio>` 是暂停+静音的,
 * 接通才 `play()`,Android WebView 要重开一次 AudioTrack 才真出声,这期间到的帧
 * 在抖动缓冲里过期就丢了。座机那一路则是「订阅刚落地」那一瞬同理。
 *
 * 所以缓存那一条**在音频前面垫一段静音**:被吃掉的是这段静音,第一个字整着到。
 * 260ms 是「够兜住一次 AudioTrack 重开(实测几百毫秒里的常见值),又短过一个字」——
 * 再长他就会觉得「怎么停了一下才说话」,而 700ms 的延后已经在前面占过一段了。
 * 真机上要试别的值:`WORKBENCH_CHANNEL_OPENER_LEAD_MS`(设 0 = 逐字回到不垫那一版)。
 *
 * **只垫缓存那一条**:没命中缓存时那一句要现合成(1~2 秒),那一段本身就是最好的前导。
 */
export const OPENER_LEAD_SILENCE_MS = 260

/**
 * **手机拨出**那一通开场前垫的静音(2026-09-28 19:2x,统筹)。维护者 Pixel 真机:手机已报「在放了」、
 * 工人等了 0ms 开口,他照旧只听到「何吩咐」—— 前面约 0.8–1 秒被吃。手机那段烘热走的是媒体那一路,
 * 通话声音是另一路;最直接的一招是**顺着同一路通话音轨**先发这么长的静音帧把它冲开。
 * 座机话筒不吃字(树莓派 aplay 管子常开),照旧 {@link OPENER_LEAD_SILENCE_MS}。
 */
export const OPENER_LEAD_PHONE_SILENCE_MS = 1200

/** 这一通开场前垫多少:手机拨出用长的一档,座机话筒与认不出是谁的照旧。 */
export function openerLeadFor(kind: string | undefined, config: { openerLeadMs: number, openerLeadPhoneMs: number }): number {
  return kind === 'phone' ? config.openerLeadPhoneMs : config.openerLeadMs
}

/** 开场这一句怎么说:命中缓存就连音频一起给,没命中只给字(现合成)。 */
export interface OpenerSpeech {
  text: string
  /** 命中缓存时才有。`session.say(text, { audio })` 看见它就**整条跳过 TTS**。 */
  audio?: ReadableStream<AudioFrame>
  cached: boolean
  /** 这一条前面垫了多少毫秒静音(0 = 没垫;日志与用例看这一个)。 */
  leadSilenceMs: number
}

/**
 * 一段静音(16 位小端单声道,毫秒 → 字节)。`ms <= 0` 回空。
 * 采样点数按四舍五入:少一两个采样点没人听得出来,而对齐 2 字节是硬的。
 */
export function silencePcm(ms: number, sampleRate: number): Buffer {
  if (!(ms > 0)) return Buffer.alloc(0)
  const rate = sampleRate > 0 ? sampleRate : TTS_SAMPLE_RATE
  const samples = Math.round((rate * ms) / 1000)
  const out = Buffer.alloc(samples * 2)
  /*
   * **不是纯零,是一层听不见的底噪**(2026-09-28 19:3x,统筹):垫到 1200ms 他仍然只听到「有什么吩咐」。
   * 纯零那一段多半被通话编码当成「没声音」省掉不发(不连续发送),等于没垫。
   * ±3 以内的交替抖动约 -80dBFS,人耳听不见,但每一帧都是「有声音」,整段真的顺着通话音轨发过去。
   */
  for (let i = 0; i < samples; i += 1) out.writeInt16LE(((i * 7919) % 7) - 3, i * 2)
  return out
}

/**
 * 这一句该怎么送出去。**没命中不是错**:照样说,只是退回现合成(慢一两秒)。
 *
 * 抽成一个纯函数是为了让「命中直接发帧 / 没命中照样有这一句」两条**跑得到用例**
 * —— agent.ts 那一段要真起一个 LiveKit 会话才跑得到。
 */
export function openerSpeech(
  cache: GreetingCache | undefined,
  text: string,
  options: { leadSilenceMs?: number } = {},
): OpenerSpeech {
  const got = cache?.get(text)
  // 没命中就没有音频可垫:现合成那一两秒本身就是前导(见 OPENER_LEAD_SILENCE_MS)。
  if (got === undefined) return { text, cached: false, leadSilenceMs: 0 }
  const leadMs = Math.max(0, Math.floor(options.leadSilenceMs ?? OPENER_LEAD_SILENCE_MS))
  const lead = silencePcm(leadMs, got.sampleRate)
  const padded: GreetingAudio = lead.length === 0
    ? got
    : { ...got, pcm: Buffer.concat([lead, got.pcm]) }
  return { text, audio: audioStreamOf(greetingFrames(padded)), cached: true, leadSilenceMs: lead.length === 0 ? 0 : leadMs }
}

/** 一句缓存好的话。`pcm` 是 16 位小端单声道。 */
export interface GreetingAudio {
  text: string
  pcm: Buffer
  sampleRate: number
}

/** 合成一句 → PCM。合不出来回 undefined(**不抛**)。 */
export type GreetingSynthesize = (text: string) => Promise<{ pcm: Buffer, sampleRate: number } | undefined>

export interface GreetingCacheOptions {
  synthesize: GreetingSynthesize
  /** 要预热哪几句。agent.ts 给的是「称呼表里每个称呼的那一句」。 */
  lines: () => readonly string[]
  log?: (line: string) => void
}

/**
 * 预合成好的那几句话。**只认原文**(见文件头第 ② 条)。
 */
export class GreetingCache {
  readonly #options: GreetingCacheOptions
  readonly #log: (line: string) => void
  readonly #entries = new Map<string, GreetingAudio>()
  /** 正在预热的那一趟。**同一时刻只有一趟**:两趟并发等于把同几句话合两遍、付两次钱。 */
  #warming: { generation: number, run: Promise<number> } | undefined
  /**
   * 第几茬嗓子(2026-09-23 下午补的那个洞)。
   *
   * 原先 `revoice()` 是「清空 + 再 `warm()` 一次」,而 `warm()` 看见有一趟在飞就
   * **把那一趟原样返回**。于是:启动那趟预热还没跑完、他就在电话里换了音色 ——
   * 清空之后,**旧嗓子那几句会被那趟还在飞的预热原封不动写回缓存**,
   * 下一通提机听见的就是刚被换掉的那个人。维护者 2026-09-23 14:20 真机原话里
   * 「音色和最开始听到的『吩咐』二字不一致」正是这一类。
   *
   * 补法:每换一茬 +1;在飞的那趟每合完一句都对一次号,对不上就**一句都不写**、整趟作废,
   * 并且 `revoice()` **不会去搭那趟旧车**。宁可这几秒退回现合成(慢一两秒,嗓子是对的)。
   */
  #generation = 0
  /** 这一茬是哪个音色(日志与用例用;`revoice` 传进来什么就是什么,没传就是 undefined)。 */
  #voice: string | undefined

  constructor(options: GreetingCacheOptions) {
    this.#options = options
    this.#log = options.log ?? (() => {})
  }

  /** 缓存里有几句(日志与用例用)。 */
  get size(): number { return this.#entries.size }

  /** 这一茬嗓子的序号(0 = 启动那一茬)。换一次音色 +1。 */
  get generation(): number { return this.#generation }

  /** 这一茬缓存是按哪个音色合的(没换过音色时是 undefined)。 */
  get voice(): string | undefined { return this.#voice }

  /** 这一句有没有现成的。 */
  get(text: string): GreetingAudio | undefined { return this.#entries.get(text) }

  /**
   * 该有的还差几句(2026-09-27)。`warmWhenReady` 拿它认「8792 起来了没有」——
   * 差数为 0 才算补齐。`lines()` 抛了就当**不差**:取不到该有哪几句时反复重试没有意义。
   */
  pending(): number {
    let lines: readonly string[]
    try { lines = this.#options.lines() }
    catch { return 0 }
    const wanted = new Set(lines.map(one => one.trim()).filter(one => one !== ''))
    let missing = 0
    for (const text of wanted) if (!this.#entries.has(text)) missing += 1
    return missing
  }

  /**
   * 把该有的那几句补齐。**已经有的不重合**(省的正是钱与那一次并发配额)。
   * 回「这一趟之后缓存里有几句」。**绝不抛**。
   */
  async warm(): Promise<number> {
    const flying = this.#warming
    // 只搭**这一茬**的车。上一茬那趟正在飞的预热合的是旧嗓子,搭上去等于把旧的等回来。
    if (flying !== undefined && flying.generation === this.#generation) return await flying.run
    const generation = this.#generation
    const run = this.#warm(generation)
    this.#warming = { generation, run }
    try { return await run }
    finally { if (this.#warming?.run === run) this.#warming = undefined }
  }

  async #warm(generation: number): Promise<number> {
    let lines: readonly string[]
    try { lines = this.#options.lines() }
    catch { return this.#entries.size }
    let made = 0
    for (const raw of lines) {
      const text = raw.trim()
      if (text === '' || this.#entries.has(text)) continue
      let got: { pcm: Buffer, sampleRate: number } | undefined
      try { got = await this.#options.synthesize(text) }
      catch (err) {
        this.#log(`[channel-worker] 开场那一句预合成没成(${(err as Error)?.message ?? '没说原因'}):`
          + `「${text}」这一句提机时现合成,会慢一两秒。`)
        continue
      }
      // 这一句合着的时候他又换了一次嗓子:**这一段是旧音色**,一个字节都不许进缓存。
      if (generation !== this.#generation) {
        this.#log(`[channel-worker] 开场白预合成合到一半音色又变了,这一趟(第 ${generation} 茬)作废,不写回缓存。`)
        return this.#entries.size
      }
      if (got === undefined || got.pcm.length === 0) {
        this.#log(`[channel-worker] 开场那一句 8792 没给音频:「${text}」这一句提机时现合成,会慢一两秒。`)
        continue
      }
      this.#entries.set(text, { text, pcm: got.pcm, sampleRate: got.sampleRate })
      made += 1
    }
    if (made > 0) this.#log(`[channel-worker] 开场白备好了 ${made} 句(缓存里共 ${this.#entries.size} 句),提机就出声。`)
    return this.#entries.size
  }

  /**
   * 换音色了:**整张作废,重合成**。
   *
   * 为什么不是「留着旧的、等新的合好再换」:留着就意味着他换完嗓子、下一通提机
   * 听见的第一句还是旧的那个人 —— 而那一句正是他这通电话听见的第一件事。
   * 宁可这几秒里退回现合成(慢一两秒,但嗓子是对的)。
   *
   * 换茬号(`#generation`)在**清空之前**先加:上一茬那趟还在飞的预热看见号变了就整趟作废,
   * 一句旧嗓子都写不回来(见 {@link GreetingCache} 上那一段)。
   */
  async revoice(why?: string): Promise<number> {
    this.#invalidate(why)
    this.#log(`[channel-worker] 音色变了${why === undefined ? '' : `(${why})`},开场白那几句重新合成(第 ${this.#generation} 茬)。`)
    return await this.warm()
  }

  /**
   * **只作废,不重合成**(2026-09-23 下午)。
   *
   * 给「他正在电话里逐个试听音色」那一段用:试听一次 8792 那边的当前音色就真换一次,
   * 每次都重合五六句的话,通话中间会连着几十次合成排在 TTS 那道并发 1 的闸后面
   * (tts/gate.ts)—— 他要听的样音和她要说的话都得排在后面。
   *
   * 作废就够了:缓存空着的时候开场白与先应那一句**退回现合成 / 干脆不应**,
   * 绝不会放一句旧嗓子的。等他挑定了那一下再 `revoice()` 重合成。
   */
  invalidate(why?: string): void {
    this.#invalidate(why)
    this.#log(`[channel-worker] 音色临时变了${why === undefined ? '' : `(${why})`},开场白那几句先作废(第 ${this.#generation} 茬),挑定了再合。`)
  }

  #invalidate(why: string | undefined): void {
    this.#generation += 1
    this.#voice = why
    this.#entries.clear()
  }
}

export interface WarmWhenReadyOptions {
  /** 最多试几趟(含第一趟)。 */
  attempts?: number
  /** 第一次等多久,之后每趟翻倍。 */
  delayMs?: number
  /** 等的上限(翻到这里就不再翻)。 */
  maxDelayMs?: number
  /** 等一会儿(测试注入,用例里不真睡)。 */
  wait?: (ms: number) => Promise<void>
  log?: (line: string) => void
}

/** 缺省:0.5s / 1 / 2 / 4 / 8 / 16 / 30 / 30…,十趟合起来兜住「事务官后端比工人晚起两分钟」。 */
export const WARM_ATTEMPTS = 10
export const WARM_DELAY_MS = 500
export const WARM_MAX_DELAY_MS = 30_000

/**
 * **8792 还没起来就等它起来再补**(2026-09-27,卡 fix/voice-onboarding-latency)。
 *
 * 09-27 那台全新的 Air 上,工人比事务官后端先起来,启动那一趟预热
 * 12 句全是 `8792 回了 503 —— 连不上工作台,拿不到服务器下发的语音合成钥匙`,
 * **之后再没有人补过**:那一轮进程里每一句开场白都只能现合成,
 * 直到维护者自己重启了一次才看见「开场白备好了 12 句」。
 *
 * 所以这里按退避反复补,直到**该有的那几句都有了**;`GreetingCache.warm()` 自己不抛,
 * 这一层也不抛 —— 它跑在启动那一段,把进程带走就太蠢了(和 warm 同一条纪律)。
 * 每换一茬嗓子(`revoice`)走的仍是 `warm()`,不走这一条:那时 8792 显然是活着的。
 */
export async function warmWhenReady(cache: GreetingCache, options: WarmWhenReadyOptions = {}): Promise<number> {
  const attempts = Math.max(1, Math.floor(options.attempts ?? WARM_ATTEMPTS))
  const first = Math.max(0, Math.floor(options.delayMs ?? WARM_DELAY_MS))
  const max = Math.max(first, Math.floor(options.maxDelayMs ?? WARM_MAX_DELAY_MS))
  const log = options.log ?? (() => {})
  const wait = options.wait ?? (async (ms: number) => { await new Promise<void>((done) => { const t = setTimeout(done, ms); t.unref?.() }) })
  let delay = first
  for (let round = 1; round <= attempts; round += 1) {
    let size = 0
    try { size = await cache.warm() }
    catch { /* warm 自己就不抛,这一行只兜将来 */ }
    if (cache.pending() === 0) return size
    if (round === attempts) {
      log('[channel-worker] 开场白预合成试了 ' + String(attempts) + ' 趟还有 ' + String(cache.pending())
        + ' 句没合上(8792 一直没给音频):这几句提机时现合成,会慢一两秒。')
      return size
    }
    log('[channel-worker] 开场白预合成:8792 这会儿还答不上来(常见的是它比工人晚起),'
      + `等 ${delay}ms 再补第 ${round + 1} 趟。`)
    try { await wait(delay) }
    catch { /* 等不成就当等过了,下一趟照试 */ }
    delay = Math.min(max, delay * 2)
  }
  return cache.size
}

/**
 * 一段 PCM → 一串能直接进房的帧。
 *
 * **必须切成小帧**:整段塞一帧,LiveKit 的 AudioSource 会 `InvalidState - failed to capture frame`
 * (butlerTts.ts 里那段 09-17 实测的账,这里是同一条)。
 */
export function greetingFrames(audio: GreetingAudio): AudioFrame[] {
  const rate = audio.sampleRate > 0 ? audio.sampleRate : TTS_SAMPLE_RATE
  const stream = new AudioByteStream(rate, 1, Math.round(rate / 50)) // 20ms 一帧
  const pcm = audio.pcm
  return [
    ...stream.write(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength)),
    ...stream.flush(),
  ]
}

/**
 * 帧 → `session.say(text, { audio })` 吃的那种流。
 *
 * 一次性全推进去:这几句话总共一秒多,攒在队列里比边算边推稳 ——
 * 这条路上唯一要紧的是**第一帧什么时候到**。
 */
export function audioStreamOf(frames: readonly AudioFrame[]): ReadableStream<AudioFrame> {
  return new ReadableStream<AudioFrame>({
    start(controller) {
      for (const frame of frames) controller.enqueue(frame)
      controller.close()
    },
  })
}

export interface GreetingSynthesizerOptions {
  /** 例如 http://127.0.0.1:8792。 */
  butlerUrl: string
  scene: string
  voiceId?: string
  fetchImpl?: typeof fetch
  /** 只有 8792 回 mp3(那台还是旧的)时才用得上。 */
  ffmpegPath?: string
  log?: (line: string) => void
}

/**
 * 向 8792 要一句音频。**走老的 `/api/tts`,不走流式** ——
 * 预热不在任何人的耳朵前面,首包早晚一点没人听得出来;而老那条路一次回整段,
 * 少一个帧协议要对。
 *
 * 音色照旧**不由工人挑**:只传 scene,8792 自己解析「形象在该场景绑定的音色」
 * (与 butlerTts.ts 同一条规矩,两处不会分叉)。
 *
 * **绝不抛**:任何一步不顺就回 undefined,由 {@link GreetingCache} 记一行。
 */
export function createGreetingSynthesizer(options: GreetingSynthesizerOptions): GreetingSynthesize {
  const doFetch = options.fetchImpl ?? fetch
  const log = options.log ?? (() => {})
  return async (text: string) => {
    let res: Response
    try {
      res = await doFetch(`${options.butlerUrl}/api/tts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text: speakableText(text),
          scene: options.scene,
          encoding: 'wav',
          ...(options.voiceId === undefined ? {} : { voiceId: options.voiceId }),
        }),
      })
    }
    catch (err) {
      log(`[channel-worker] 开场白预合成:连不上 ${options.butlerUrl}/api/tts(${(err as Error)?.message ?? '没说原因'})`)
      return undefined
    }
    if (!res.ok) {
      const detail = await upstreamDetailOf(res)
      log(`[channel-worker] 开场白预合成:8792 回了 ${res.status}${detail === '' ? '' : ` —— ${detail}`}`)
      return undefined
    }
    let body: Buffer
    try { body = Buffer.from(await res.arrayBuffer()) }
    catch { return undefined }
    if (body.length === 0) return undefined
    if ((res.headers.get('content-type') ?? '').includes('audio/mpeg')) {
      try { return { pcm: await decodeMp3(body, options.ffmpegPath ?? 'ffmpeg', TTS_SAMPLE_RATE), sampleRate: TTS_SAMPLE_RATE } }
      catch (err) {
        log(`[channel-worker] 开场白预合成:mp3 解不开(${(err as Error)?.message ?? '没说原因'})`)
        return undefined
      }
    }
    const decoded = pcmOfWav(body)
    return { pcm: decoded.pcm, sampleRate: decoded.sampleRate }
  }
}
