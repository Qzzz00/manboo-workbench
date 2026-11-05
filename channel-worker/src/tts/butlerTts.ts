/**
 * 事务官的嘴:文字 → 火山 TTS(经 8792 `/api/tts`)→ 房间里的音频。
 *
 * **音色不由工人挑**。8792 那条接口自己解析「形象在该场景绑定的音色」(avatarVoiceStore.resolveVoice),
 * 工作台设置里选的是哪个,电话里就是哪个 —— 工人只传 scene,连 voiceId 都只在配置显式指定时才传。
 * 这样「手机上听到的声音」和「Mac 上试听的声音」永远是同一个,不会分叉。
 *
 * 容器:优先要 `wav`(2026-09-17 给 8792 加的 encoding 透传)——WAV 自带采样率,截掉头就是 PCM,
 * 直接进房。**正在跑的那台 8792 还是旧的**,不认 encoding,会回 mp3;这时候退回 ffmpeg 解一次码,
 * 并且**只在第一次退回时**记一条日志(说清楚怎么让它变快)。ffmpeg 也没有的话如实报错,不出声总比
 * 出一段噪音好。
 *
 * 流式:`/api/tts` 是一次性出整段音频的 HTTP 接口,没有流式面。所以这里只实现 `synthesize()`
 * (ChunkedStream),流式那一面交给框架的 `tts.StreamAdapter(this, 句子切分器)` —— 模型吐一句、
 * 合一句、说一句,首字延迟等于**第一句**的合成时间,不是整段的。
 */
import { speakableSpeech } from './speakable.ts'
import { stripToneTags, type Tone } from './tone.ts'
import { spawn } from 'node:child_process'
import { AudioFrame } from '@livekit/rtc-node'
import { AudioByteStream, tts } from '@livekit/agents'
import type { APIConnectOptions } from '@livekit/agents'
import { Gate, TTS_MAX_CONCURRENT } from './gate.ts'
import { createFrameReader, evenSamples } from './streamFrames.ts'
import { SpeechOrder } from './speechOrder.ts'
import type { TurnMark } from '../latency.ts'

/** 进房间的采样率。LiveKit 全链路用 48k,一次重采样在 rtc 那边做。 */
export const TTS_SAMPLE_RATE = 24000

/**
 * 连着这么多句合不出声,才在字幕里说一句实话(见 {@link ButlerTtsOptions.onDegraded})。
 * 3:一段话常被切成三四小块,整段都哑了才值得惊动人;偶尔一句没出声不必说。
 */
export const TTS_DEGRADE_AFTER = 3

/**
 * 连着哑掉之后说的那一句 —— **兜底版**,只在真不知道为什么的时候说。
 * **一次降级只说一次**,合出一句声音就重新计数。
 */
export const TTS_DEGRADED_TEXT = '语音后端这会儿有点问题,我先用字幕跟你说,你照样说话就行。'

/**
 * 知道为什么的时候说的那一句(2026-09-27,卡 VO 第 ③ 件)。
 *
 * 在这之前不管什么原因都只有上面那一句「有点问题」。可这三件事该做的完全不一样:
 * 「这一档没开通」要去控制台开一档、「额度用完」要续费、「太挤」等一会儿就好 ——
 * 她在电话里说「有点问题」,他挂了电话也不知道该干嘛(决策记录 2026-09-26 18:20 那条
 * 就是这么卡了一整天)。原因由 8792 分好格送来(`cause.human`,见 routes/api/tts.cjs)。
 *
 * **只念 human,不念 action**:字幕里塞一整段火山控制台路径没人看,
 * action 进工人日志(failed() 那一行的 detail 里带着)。
 */
export function degradedTextOf(reason?: string): string {
  const said = (reason ?? '').trim()
  return said === ''
    ? TTS_DEGRADED_TEXT
    : `我这会儿出不了声:${said}。我先用字幕跟你说,你照样说话就行。`
}

export interface ButlerTtsOptions {
  /** butler-server 的地址,例如 http://127.0.0.1:8792。 */
  butlerUrl: string
  scene: string
  voiceId?: string
  fetchImpl?: typeof fetch
  /** ffmpeg 可执行文件。只有 8792 回 mp3 时才用得上。 */
  ffmpegPath?: string
  /**
   * 这一句**这会儿开始出声**(2026-09-18)。字幕接的是它,而不是模型「这句话生成完了」那个事件:
   * 合成要几百毫秒,先推字幕就会出现 Ben 09-18 指出的毛病——「文字先出来、闪一下,过一阵才有声音」。
   * 合成失败也调一次(`ok:false`):没声音至少还有字,总比屏幕上什么都不发生强。
   *
   * **按播放顺序调**,不是按合成完成的顺序(见 speechOrder.ts:几小块是并发合成的,
   * 最短那句往往最先合完 —— 本机实测出现过「字幕先出现最后一句」)。
   *
   * `tone`(2026-10-02):这一句的语气意图(tone.ts 的短列表)。**字幕上不显示它** ——
   * 它顺着字幕那条通道广播出去,手机拿它驱动 Live2D 的表情。模型没写就缺席。
   */
  onSpeech?: (text: string, ok: boolean, tone?: Tone) => void
  /**
   * **连着哑了这么多句**之后说的那一句(2026-09-20)。字幕接它。
   *
   * 为什么不是每句都说:一段话被切成三四小块,8792 一哑就是一连串 —— 每块都在字幕里
   * 道一次歉,屏幕上会变成一串「语音后端有问题」,比没声音更吵。所以攒到
   * {@link TTS_DEGRADE_AFTER} 说一次,**说完就不再说**,直到真的合出一句声音为止。
   */
  onDegraded?: (text: string) => void
  /**
   * **这一句是「这个嗓子念不了这段字」哑的**(2026-09-28,卡 VC)。8792 分的那一类
   * `cause.kind === 'text_rejected'`,真机原话 `code=3011 TTSInvalidText: unsupported language`。
   *
   * 每一句这样的失败都通报一次,**数几句、换回哪一个由 voiceRescue.ts 管** ——
   * 嘴这一侧不认识音色单,也不该由它去 PUT 换音色。
   */
  onLanguageMismatch?: () => void
  /** 同一时刻最多几条合成。缺省 {@link TTS_MAX_CONCURRENT}。见 gate.ts 里那段 429 的账。 */
  maxConcurrent?: number
  /** 连着哑几句才说那一句。缺省 {@link TTS_DEGRADE_AFTER}。 */
  degradeAfter?: number
  /**
   * **流式合成**(2026-09-23)。缺省**开**,开关 `WORKBENCH_CHANNEL_TTS_STREAM=off`。
   *
   * 开着就先走 8792 的 `/api/tts/stream`:它边向火山要、边把音频帧发回来,
   * 第一包通常 200~400ms 就到手,而不是「整句合完才给」的 1.4~1.6 秒
   * (Ben 2026-09-23 真机第一批的 `tts_first_ms`)。
   *
   * **默认开是安全的**:那条路走不通(老 8792 没有这条路由 → 404、连不上、回了错帧)
   * 一律**当场回退**到老的 `/api/tts`,代价只有一次回环往返;而且回退过一次之后
   * 这个进程里就不再试(见 {@link ButlerTts.noteStreamOff}),不会每句都白试一次。
   */
  stream?: boolean
  /**
   * 计时打点(2026-09-23)。嘴这一侧只打三个:
   * `tts_request` 向 8792 发出 POST 的那一刻、`tts_first_audio` 这一句的音频进队列、
   * `tts_done` 这一句合完(一回合里最后一次为准)。
   *
   * **先到先得由时间线那边管**(latency.ts):这里每一句都照打,
   * 一回合只留第一句那一下是 `TurnTimeline.mark` 的规矩,不是这里的。
   * 缺席时一行都不多跑 —— 不量延迟的场合(单测、别的机器)这一层等于不存在。
   */
  onMark?: (name: TurnMark) => void
}

/**
 * 8792 回的错误体 → 一句能进日志的上游原话。**绝不抛**,读不懂就回空串。
 *
 * 为什么非要这一手(2026-09-20):工人日志里只有 `合成失败(502)`,真正的原因
 * (`volcengine TTS HTTP 429 code=3001 quota exceeded for types: concurrency`)
 * 躺在**另一台进程**的 stderr 里。两条日志对不上时间就等于没有证据。
 * 8792 那条路由从这一版起把脱敏后的上游原话放进 `detail`,这里原样带回工人日志。
 */
export interface UpstreamFailure {
  /** 一句能直接进字幕的短话(8792 的 `cause.human`)。8792 没给就是空串。 */
  human: string
  /**
   * 8792 分好的那一类(`cause.kind`)。**只照抄,不在这头再判一次**。
   * `text_rejected` = 「这个嗓子念不了这段字」(多半语种对不上)—— 2026-09-28 卡 VC
   * 的兜底就接在它上面。老 8792 没有这一格 → 缺席。
   */
  kind?: string
  /** 进日志的那一长串(`error;detail`,与从前一个字不差)。 */
  joined: string
}

/**
 * 8792 的错误体 → `{ human, joined }`(2026-09-27)。
 *
 * `human` 只认 8792 **分好格**的那一份(`cause.human`)。为什么不在工人这头再解析一次
 * 火山原话:那就成了同一张错误码表抄两份,两份迟早对不上 —— 表在 8792
 * (butler-server/server/services/volcTtsErrors.cjs),这头只负责念。
 * 老的 8792 没有 `cause` 这一格 → `human` 是空串 → 降级那句话照旧是兜底版。
 */
export async function upstreamFailureOf(res: Response): Promise<UpstreamFailure> {
  let text: string
  try { text = await res.text() }
  catch { return { human: '', joined: '' } }
  if (text.trim() === '') return { human: '', joined: '' }
  try {
    const body = JSON.parse(text) as Record<string, unknown>
    const cause = body.cause as Record<string, unknown> | undefined
    const human = typeof cause?.human === 'string' ? cause.human.trim() : ''
    const kind = typeof cause?.kind === 'string' && cause.kind.trim() !== '' ? cause.kind.trim() : undefined
    const detail = typeof body.detail === 'string' ? body.detail.trim() : ''
    const error = typeof body.error === 'string' ? body.error.trim() : ''
    const joined = [error, detail].filter(part => part !== '').join(';')
    return { human, ...(kind === undefined ? {} : { kind }), joined: joined === '' ? text.slice(0, 200) : joined }
  }
  catch {
    return { human: '', joined: text.slice(0, 200) }
  }
}

export async function upstreamDetailOf(res: Response): Promise<string> {
  let text: string
  try { text = await res.text() }
  catch { return '' }
  if (text.trim() === '') return ''
  try {
    const body = JSON.parse(text) as Record<string, unknown>
    const detail = typeof body.detail === 'string' ? body.detail.trim() : ''
    const error = typeof body.error === 'string' ? body.error.trim() : ''
    const joined = [error, detail].filter(part => part !== '').join(';')
    return joined === '' ? text.slice(0, 200) : joined
  }
  catch {
    // 不是 JSON(反代的 HTML 错误页之类):截一段,够认出是谁在回话就行。
    return text.slice(0, 200)
  }
}

/** WAV → { pcm, sampleRate, channels }。不是 RIFF 就当作裸 PCM,按调用方给的参数解释。 */
export function pcmOfWav(buf: Buffer): { pcm: Buffer, sampleRate: number, channels: number } {
  if (buf.length > 44 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE') {
    let sampleRate = TTS_SAMPLE_RATE
    let channels = 1
    let p = 12
    while (p + 8 <= buf.length) {
      const id = buf.toString('ascii', p, p + 4)
      const size = buf.readUInt32LE(p + 4)
      if (id === 'fmt ' && p + 8 + 16 <= buf.length) {
        channels = buf.readUInt16LE(p + 10)
        sampleRate = buf.readUInt32LE(p + 12)
      }
      if (id === 'data') return { pcm: buf.subarray(p + 8, p + 8 + size), sampleRate, channels }
      p += 8 + size + (size & 1)
    }
  }
  return { pcm: buf, sampleRate: TTS_SAMPLE_RATE, channels: 1 }
}

/** mp3 → 16 位小端单声道 PCM。要 ffmpeg;没有就抛,由调用方变成一条日志。 */
export function decodeMp3(buf: Buffer, ffmpegPath: string, sampleRate = TTS_SAMPLE_RATE): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error',
      '-i', 'pipe:0',
      '-f', 's16le', '-acodec', 'pcm_s16le', '-ar', String(sampleRate), '-ac', '1',
      'pipe:1',
    ])
    const out: Buffer[] = []
    let failed: Error | undefined
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk))
    child.on('error', (err) => { failed = new Error(`ffmpeg 起不来(${err.message})`) })
    child.on('close', (code) => {
      if (failed !== undefined) { reject(failed); return }
      if (code !== 0) { reject(new Error(`ffmpeg 退出码 ${code ?? '?'}`)); return }
      resolve(Buffer.concat(out))
    })
    child.stdin.on('error', () => { /* ffmpeg 起不来时 stdin 会 EPIPE,交给 error/close 收尾 */ })
    child.stdin.end(buf)
  })
}

export class ButlerTts extends tts.TTS {
  label = 'butler.ButlerTts'

  readonly options: ButlerTtsOptions
  /** 只在第一次退回 mp3 时说一句,不要每句话都刷屏。 */
  warnedMp3 = false
  /** 字幕按播放顺序出的那条队列(见 speechOrder.ts)。 */
  readonly order: SpeechOrder
  /** 合成的并发闸(见 gate.ts)。火山的并发配额是按账号算的,我们自己先排好队。 */
  readonly gate: Gate
  /** 连着哑了几句。合出一句声音就归零。 */
  failureStreak = 0
  /** 这一轮降级的那句话说过了没有。合出一句声音就翻回 false。 */
  saidDegraded = false
  /**
   * 最近一次合成失败的**原因**(8792 分好格的那一句)。降级那句话念它。
   * 合出一句声音就清掉 —— 上一次的原因不能拿来解释下一次的沉默。
   */
  lastReason: string | undefined
  /**
   * 流式那条路在这个进程里**别再试了**。回退发生过一次就翻成 true ——
   * 老 8792 没有 `/api/tts/stream`,每句先白试一次会**比从前更慢**,而不是一样慢。
   * 重启工人就重新试一次(这是状态,不是配置)。
   */
  streamOff = false

  constructor(options: ButlerTtsOptions) {
    // streaming: false —— 它没有流式面,如实声明;流式由 tts.StreamAdapter 补。
    super(TTS_SAMPLE_RATE, 1, { streaming: false })
    this.options = options
    this.gate = new Gate(options.maxConcurrent ?? TTS_MAX_CONCURRENT)
    this.order = new SpeechOrder((text, ok, tone) => {
      try { options.onSpeech?.(text, ok, tone) } catch { /* 字幕丢一条不该拦住声音 */ }
    })
  }

  /** 打一个计时点。**绝不抛**:量延迟出错不该把这一句话弄哑。 */
  mark(name: TurnMark): void {
    try { this.options.onMark?.(name) }
    catch { /* 见上 */ }
  }

  /**
   * 流式那条路走不通:记一行(**只一行**),这个进程里从此走老路。
   * 说清楚「为什么」和「怎么让它变快」——看见这一行的人下一步就是去重启 8792。
   */
  noteStreamOff(why: string): void {
    if (this.streamOff) return
    this.streamOff = true
    console.warn(
      `[channel-worker] 流式合成走不通(${why}),这一轮起回到老的 /api/tts。`
      + '首包会慢回 1.4 秒上下;统筹会话把 butler-server 升到带 /api/tts/stream 的那版再重启工人就好。',
    )
  }

  /** 这一句真的出声了:把「连着哑了几句」归零,降级那句话下次还能再说。 */
  noteSpoken(): void {
    this.failureStreak = 0
    this.saidDegraded = false
    this.lastReason = undefined
  }

  /**
   * 这一次是为什么哑的(8792 给的 `cause.human`)。空串当没给。
   *
   * `kind` 是 8792 分好的那一类:`text_rejected`(这个嗓子念不了这段字)就顺手通报一声,
   * 兜底那一头攒够两句会自己把音色换回来(2026-09-28,卡 VC)。**通报失败不出声**。
   */
  noteReason(reason: string | undefined, kind?: string): void {
    const said = (reason ?? '').trim()
    this.lastReason = said === '' ? undefined : said
    if (kind !== 'text_rejected') return
    try { this.options.onLanguageMismatch?.() }
    catch { /* 兜底失手不该再把这一句话弄得更糟 */ }
  }

  /**
   * 这一句哑了。攒够 {@link TTS_DEGRADE_AFTER} 就在字幕里说一次实话 —— **只一次**。
   * 会话照旧活着(见 ButlerTtsChunkedStream.failed 里那一段)。
   */
  noteFailed(): void {
    this.failureStreak += 1
    const after = this.options.degradeAfter ?? TTS_DEGRADE_AFTER
    if (this.saidDegraded || this.failureStreak < after) return
    this.saidDegraded = true
    try { this.options.onDegraded?.(degradedTextOf(this.lastReason)) }
    catch { /* 这一句本来就是安慰,发不出去不值得再出一个错 */ }
  }

  synthesize(text: string, connOptions?: APIConnectOptions, abortSignal?: AbortSignal): tts.ChunkedStream {
    return new ButlerTtsChunkedStream(text, this, connOptions, abortSignal)
  }

  stream(): tts.SynthesizeStream {
    throw new Error('ButlerTts 不能直接 stream():用 tts.StreamAdapter(它, 句子切分器) 包一层')
  }
}

export class ButlerTtsChunkedStream extends tts.ChunkedStream {
  label = 'butler.ButlerTtsChunkedStream'

  readonly #tts: ButlerTts
  /** 这一块在播放顺序里的位置(**创建时**就占好,那时的顺序就是将来播放的顺序)。 */
  readonly #slot: number
  /**
   * 这一句的语气(2026-10-02)。构造时就从句首标签上摘下来 ——
   * 字幕那一份(slot)与送合成那一份(run)都要用它,摘两遍迟早对不上。
   */
  #tone: Tone | undefined
  /** 那一句 ≤20 字的自然语言语气指令(模型写了才有)。只往 8792 传,不进字幕。 */
  #toneNote: string | undefined

  constructor(text: string, tts: ButlerTts, connOptions?: APIConnectOptions, abortSignal?: AbortSignal) {
    super(text, tts, connOptions, abortSignal)
    this.#tts = tts
    // **字幕里不许出现标签**:这一份过 stripToneTags(语气本身另走 slot 的第二格)。
    this.#slot = tts.order.slot(stripToneTags(text).trim(), speakableSpeech(text).tone)
    // 被打断/取消:这一块不会播了,把位置让出来,否则后面的字幕全卡在它后面。
    abortSignal?.addEventListener('abort', () => this.#tts.order.drop(this.#slot), { once: true })
  }

  /**
   * 这一句没合成出来。记日志 + 发事件,**不抛**(理由见 run() 里那一段)。
   * 事件只在真有人听的时候发:EventEmitter 上没人听 'error' 会直接把进程掀翻。
   *
   * ## `recoverable: true` —— 这一个字就是「十分钟断线」的解药(2026-09-20)
   *
   * Ben 真机第二轮,`~/.dsh/workbench/logs/channel-worker.log` 里那条铁证:
   *
   *     AgentSession is closing due to an unrecoverable error … type tts_error
   *     Error: 合成失败(502):8792 的 /api/tts 没给音频
   *
   * 框架那一头逐字长这样(`node_modules/@livekit/agents/dist/voice/agent_session.js` 的 `_onError`):
   *
   *     if (this.closingTask || error.recoverable) return
   *     … else if (error.type === "tts_error") {
   *         this.ttsErrorCounts += 1
   *         if (this.ttsErrorCounts <= this._connOptions.maxUnrecoverableErrors) return   // 缺省 3
   *     }
   *     this.logger.error(error, "AgentSession is closing due to an unrecoverable error")
   *
   * 而那个计数器**只在 `_updateAgentState('speaking')` 里归零** —— 合成一直失败就永远到不了
   * `speaking`。一段话被中文断句器切成四小块 = 一次回答就攒够四条 `tts_error`,
   * 于是 8792 哑掉的**那一秒**整条会话就关了。Ben 听见的「不理我」不是慢,是电话被挂了。
   *
   * 所以这里如实标 `recoverable: true`:**合成失败对这条链路本来就是可恢复的** ——
   * 字幕照出、下一句照常再要一次音频,8792 好了自己就有声音(run() 里没有任何「坏了」的缓存)。
   * 标成 true 之后框架在第一行就 return,既不计数也不关会话;
   * `agent_activity.onError` 里那条 `AgentSessionEventTypes.Error` 照样发出去(它在 `_onError`
   * **之前**),该知道的人一个都没少知道。
   *
   * 「那什么时候才告诉人?」—— 见 {@link ButlerTts.noteFailed}:连着哑够三句,
   * 字幕里说一句「语音后端有问题,先用字幕」。那是一句人话,不是把电话挂掉。
   */
  failed(error: Error): void {
    console.warn(`[channel-worker] ${error.message}`)
    // 出不了声也要让字幕有东西:他至少知道她说了什么(2026-09-18)。
    this.#tts.order.ready(this.#slot, false)
    this.#tts.noteFailed()
    if (this.#tts.listenerCount('error') > 0) {
      this.#tts.emit('error', { type: 'tts_error', timestamp: Date.now(), label: this.#tts.label, error, recoverable: true })
    }
  }

  /**
   * **排队再合成**(2026-09-20)。闸在 gate.ts,那里写着 429 的账。
   * 空串与「已经被打断」这两种不占名额:它们一个字节都不发出去。
   */
  protected async run(): Promise<void> {
    // 2026-09-24:送去合成的那一份清掉破折号、引号、括号、拆开的字母(speakable.ts);字幕那一份(slot)照原文。
    // 2026-10-02:同一层把句首那个语气标签摘走并剥掉 —— 不剥的话「关心」两个字会被念出来。
    const piece = speakableSpeech(this.inputText.trim())
    const text = piece.text
    this.#tone = piece.tone
    this.#toneNote = piece.note
    if (text === '') { this.#tts.order.drop(this.#slot); this.queue.close(); return }
    if (this.abortSignal?.aborted === true) { this.#tts.order.drop(this.#slot); this.queue.close(); return }
    const release = await this.#tts.gate.acquire()
    try { await this.#synthesize(text) }
    finally { release() }
  }

  /**
   * 流式合成这一句(2026-09-23)。**走通了回 true,该回退回 false。**
   *
   * ## 它省下的是什么
   *
   * 老路(`/api/tts`)是:8792 向火山要一次整句 → 火山把整句合完 → base64 塞进 JSON →
   * 8792 把整段 body 发过来 → 这里 `arrayBuffer()` 读完整段 → 切帧。
   * 「第一个字的声音」要等「最后一个字合完」,一句话越长等得越久。
   * 流式是:火山边合边推 → 8792 边收边发帧 → 这里**收到一帧就切一帧进队列**。
   * 第一包音频到手的时刻从「整句合成时间」变成「火山的首包时间」(官方量级 200~400ms)。
   *
   * ## 三条纪律
   *
   * 1. **一包音频都没拿到就失败 → 回退**(回 false),老路照跑,声音一句都不少;
   * 2. **已经出过声再断 → 不回退**(回 true):前半段已经在他耳朵里,重播会结巴。
   *    如实记一行「这一句只合了一半」,字幕照出;
   * 3. **最后一帧要标 `final`**,所以这里留一帧的前瞻(`pending`):
   *    收到下一帧才把上一帧发出去,末了那一帧才知道自己是最后一帧。
   */
  async #streamSynthesize(text: string): Promise<boolean> {
    const options = this.#tts.options
    const doFetch = options.fetchImpl ?? fetch

    let res: Response
    try {
      res = await doFetch(`${options.butlerUrl}/api/tts/stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text,
          scene: options.scene,
          ...(options.voiceId === undefined ? {} : { voiceId: options.voiceId }),
          /**
           * 语气(2026-10-02)。**认不得的 8792 自己退回中性**,所以这里原样发、不预先过滤。
           * 老 8792 不认这两格 → 多余字段被它的路由丢掉,行为逐字回到 10-01(没传过语气那样)。
           */
          ...(this.#tone === undefined ? {} : { tone: this.#tone }),
          ...(this.#toneNote === undefined ? {} : { toneNote: this.#toneNote }),
        }),
        signal: this.abortSignal,
      })
    }
    catch (err) {
      // 被打断:这一块本来就不该再出声,收摊,**不回退**(回退只会再白跑一次)。
      if (this.abortSignal?.aborted === true) {
        this.#tts.order.drop(this.#slot)
        this.queue.close()
        return true
      }
      // 连不上:交给老路去说那句人话(它那段注释里写着 8792 没起来时该怎么办)。
      this.#tts.noteStreamOff(`连不上 ${options.butlerUrl}/api/tts/stream`)
      return false
    }

    if (!res.ok || res.body === null) {
      // 404 = 正在跑的那台 8792 还是旧的,没有这条路由。这是**最常见**的一种,说清楚。
      this.#tts.noteStreamOff(res.status === 404 ? '8792 还是旧的,没有 /api/tts/stream' : `8792 回了 ${res.status}`)
      try { await res.arrayBuffer() }
      catch { /* 身子读不完也无所谓,这一次本来就要走老路 */ }
      return false
    }

    const sampleRate = Number(res.headers.get('x-tts-sample-rate')) || TTS_SAMPLE_RATE
    const reader = createFrameReader()
    const bytes = new AudioByteStream(sampleRate, 1, Math.round(sampleRate / 50)) // 20ms 一帧
    let odd: Buffer<ArrayBufferLike> = Buffer.alloc(0)
    /** 前瞻的那一帧:收到下一帧才把它发出去,好让真正的最后一帧带上 final。 */
    let pending: AudioFrame | undefined
    let got = 0
    let broken: string | undefined

    const put = (frame: AudioFrame, final: boolean): void => {
      this.queue.put({ frame, requestId: '', segmentId: '', final })
    }
    const offer = (frames: AudioFrame[]): void => {
      for (const frame of frames) {
        if (pending !== undefined) put(pending, false)
        pending = frame
      }
    }
    const firstAudio = (): void => {
      if (got > 0) return
      got = 1
      // 音频这会儿进队列 = 这一句马上要出声。字幕就在这一刻放行(与老路同一条规矩)。
      this.#tts.order.ready(this.#slot, true)
      this.#tts.mark('tts_first_audio')
      this.#tts.noteSpoken()
    }

    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        for (const frame of reader.push(Buffer.from(chunk))) {
          if (frame.kind === 'audio') {
            const [usable, rest] = evenSamples(odd.length === 0 ? frame.audio : Buffer.concat([odd, frame.audio]))
            odd = rest
            if (usable.length === 0) continue
            const produced = [...bytes.write(usable.buffer.slice(usable.byteOffset, usable.byteOffset + usable.byteLength))]
            if (produced.length > 0) firstAudio()
            offer(produced as AudioFrame[])
            continue
          }
          if (frame.kind === 'end') continue
          broken = frame.kind === 'error' ? frame.message : frame.message
        }
      }
      for (const frame of reader.end()) {
        if (frame.kind === 'broken') broken = frame.message
      }
    }
    catch (err) {
      if (this.abortSignal?.aborted === true) {
        this.#tts.order.drop(this.#slot)
        this.queue.close()
        return true
      }
      broken = (err as Error)?.message ?? '没说原因'
    }

    if (got === 0) {
      // 一包都没拿到:**回退**,让老路去合这一句。队列还没关,位置也还占着 —— 老路会接着用。
      this.#tts.noteStreamOff(broken === undefined ? '8792 没给音频' : broken)
      return false
    }

    // 收尾:把 AudioByteStream 里剩下的不满一帧补齐,最后一帧带 final。
    offer([...bytes.flush()] as AudioFrame[])
    if (pending !== undefined) put(pending, true)
    this.#tts.mark('tts_done')
    if (broken !== undefined) {
      // 已经出过声了,不回退(重播会结巴)。如实记一行:这一句只说了一半。
      console.warn(`[channel-worker] 流式合成这一句只合了一半(${broken});字幕照出,声音断在这儿。`)
    }
    this.queue.close()
    return true
  }

  async #synthesize(text: string): Promise<void> {
    const options = this.#tts.options
    const doFetch = options.fetchImpl ?? fetch

    // 计时:**这一刻**才是「开始合成」——闸(gate.ts)排的队已经排完了,后面就是 8792 与火山。
    // 打在两条路(流式 / 老路)之前:走哪条都从这一刻算起,前后对比才对得上。
    this.#tts.mark('tts_request')

    /**
     * 先试流式(2026-09-23)。走通了这一句就到此为止;**没走通就往下走老路** ——
     * 回退的代价只有一次回环往返,而且只白试一次(noteStreamOff)。
     */
    if (options.stream === true && !this.#tts.streamOff) {
      if (await this.#streamSynthesize(text)) return
    }

    /**
     * **连不上也只是「这一句没出声」**(2026-09-18,Ben 真机:8792 没起来时工人一启动就崩)。
     *
     * 以前这一行 `await doFetch(...)` 在 try 外面:8792 没在跑时 `fetch` 直接 reject,
     * 而框架起 mainTask 时没有接住拒绝(理由见下面那一段),于是变成一条**未处理的 Promise 拒绝**,
     * 整个工人进程被掀翻 —— 插件一秒拉起一次,日志里全是 `connect ECONNREFUSED 127.0.0.1:8792`。
     * 现在与「回了错误码」走同一条路:记一句、字幕照推、队列空着关掉,进程活着。
     * 8792 起来之后**下一句自己就有声音**:这条路上没有任何缓存的「坏了」状态。
     */
    let res: Response
    try {
      res = await doFetch(`${options.butlerUrl}/api/tts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text,
          scene: options.scene,
          encoding: 'wav',
          ...(options.voiceId === undefined ? {} : { voiceId: options.voiceId }),
          // 语气同上:**两条路都发**,否则流式熔断之后她的语气就不见了(那种分叉最难查)。
          ...(this.#tone === undefined ? {} : { tone: this.#tone }),
          ...(this.#toneNote === undefined ? {} : { toneNote: this.#toneNote }),
        }),
        signal: this.abortSignal,
      })
    }
    catch (err) {
      // 被打断(abort)也落在这儿:那时候这一块本来就不该再出声,把位置让出来即可,不报错。
      if (this.abortSignal?.aborted === true) {
        this.#tts.order.drop(this.#slot)
        this.queue.close()
        return
      }
      this.failed(new Error(
        `合成失败:连不上 ${options.butlerUrl}/api/tts(${(err as Error)?.message ?? '没说原因'});`
        + '字幕照出,这一句没有声音 —— 8792 起来之后下一句自己就有。',
      ))
      this.queue.close()
      return
    }
    if (!res.ok) {
      // 503 = 没配语音供应商密钥;502 = 火山那边失败。两种都**不出声**——
      // 挤出半段噪音比什么都不说更糟。
      //
      // 为什么不 `throw`:框架的 ChunkedStream 起 mainTask 时没有接住拒绝
      // (dist/tts/tts.js 里 `ThrowsPromise.resolve().then(() => this.mainTask()…)`,
      // 没有 catch),run() 抛出去会变成一条**未处理的 Promise 拒绝**——在工人进程里
      // 那是会把整个通话带走的。所以这里自己记一条日志、自己发那条 error 事件、
      // 把队列空着关掉:该知道的都知道了,进程还活着。
      //
      // **把上游原话带回来**(2026-09-20):以前这一行只有 `合成失败(502)`,
      // 真正的原因(`volcengine TTS HTTP 429 code=3001 quota exceeded for types: concurrency`)
      // 躺在 8792 自己的 stderr 里 —— 两份日志对不上时间就等于没有证据。
      const failure = await upstreamFailureOf(res)
      // 为什么哑的:记下来,攒够三句时降级那句话就念它(而不是那句万能的「有点问题」)。
      this.#tts.noteReason(failure.human, failure.kind)
      this.failed(new Error(
        `合成失败(${res.status}):8792 的 /api/tts 没给音频${failure.joined === '' ? '' : ` —— ${failure.joined}`}`,
      ))
      this.queue.close()
      return
    }
    const contentType = res.headers.get('content-type') ?? ''
    // 读身子也可能断在半路(8792 正好被杀)。同一条纪律:变成「这一句没出声」,不掀翻进程。
    let body: Buffer
    try { body = Buffer.from(await res.arrayBuffer()) }
    catch (err) {
      if (this.abortSignal?.aborted === true) {
        this.#tts.order.drop(this.#slot)
        this.queue.close()
        return
      }
      this.failed(new Error(`合成失败:音频没收完(${(err as Error)?.message ?? '没说原因'});字幕照出,这一句没有声音。`))
      this.queue.close()
      return
    }

    let pcm: Buffer
    let sampleRate = TTS_SAMPLE_RATE
    if (contentType.includes('audio/mpeg')) {
      if (!this.#tts.warnedMp3) {
        this.#tts.warnedMp3 = true
        console.warn(
          '[channel-worker] 8792 回的是 mp3(那台还是旧的,不认 encoding=wav),这一路要多解一次码。'
          + '统筹会话重启 butler-server 之后就会直接回 wav,首字能快一点。',
        )
      }
      try {
        pcm = await decodeMp3(body, options.ffmpegPath ?? 'ffmpeg', TTS_SAMPLE_RATE)
      }
      catch (err) {
        // ffmpeg 没装:如实说一句「这一句出不了声」,并给出能照着做的两条路。
        this.failed(new Error(
          `mp3 解不开(${(err as Error)?.message ?? '没说原因'}):要么装 ffmpeg,`
          + '要么重启 butler-server 让它直接回 wav',
        ))
        this.queue.close()
        return
      }
    }
    else {
      const decoded = pcmOfWav(body)
      pcm = decoded.pcm
      sampleRate = decoded.sampleRate
    }

    if (pcm.length === 0) { this.#tts.order.drop(this.#slot); this.queue.close(); return }

    /**
     * **必须切成小帧**。整段塞一帧进去,LiveKit 的 AudioSource 会直接
     * `InvalidState - failed to capture frame`(2026-09-17 实测:一句 4 秒的话就崩)。
     * AudioByteStream 按固定样本数切,剩下不满一帧的由 flush() 补齐。
     */
    const stream = new AudioByteStream(sampleRate, 1, Math.round(sampleRate / 50)) // 20ms 一帧
    const frames = [...stream.write(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength)), ...stream.flush()]
    // 音频这会儿进队列 = 这一句马上要出声。字幕就在这一刻放行(2026-09-18:字幕与声音同时出现);
    // 前面还有没合完的块时先排着 —— 顺序以**播放**为准,不是以谁先合完为准。
    this.#tts.order.ready(this.#slot, true)
    // 计时:音频到手了(第一句的这一下就是「合成首包」;最后一句的这一下是「合成完成」)。
    this.#tts.mark('tts_first_audio')
    this.#tts.mark('tts_done')
    // 真的出声了:把「连着哑了几句」归零,下次再哑才重新攒。
    this.#tts.noteSpoken()
    for (let i = 0; i < frames.length; i += 1) {
      this.queue.put({
        frame: frames[i] as AudioFrame,
        requestId: '',
        segmentId: '',
        final: i === frames.length - 1,
      })
    }
    this.queue.close()
  }
}
