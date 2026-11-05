/**
 * 火山**流式** ASR 接进 LiveKit Agents 的那一层:边说边出字。
 *
 * 与 segmentedStt.ts 的差别只有一处,但那一处就是全部:它不用等他说完。
 * 中间结果走 `INTERIM_TRANSCRIPT`(框架据此做打断与抢答),**判停**走 `FINAL_TRANSCRIPT`。
 *
 * ## 2026-09-18:「引导不理我」的根因就在这一层(交接-0918-引导不理人)
 *
 * 框架**只把 `FINAL_TRANSCRIPT` 累进 `audioTranscript`**;回合提交那一步看见空的
 * `audioTranscript` 就 `skipping EOU detection` 直接返回 —— debug 级,warn 日志里一个字都没有。
 * 而这里原来只有一条出 FINAL 的路:收到 `FLUSH_SENTINEL` → `session.finish()` → 最后一包 → 收尾。
 * 可 LiveKit Agents **从不给流式 STT 发 flush**(`voice/audio_recognition.js` 里只有 `vadStream.flush()`)。
 * 于是真机上的样子正是 Ben 说的那一句:她把每个字都听清了(字幕上一字不差),**就是不接话**。
 *
 * 现在 FINAL 由**火山的判停**给(开场帧带 `end_window_size`,见 volcProtocol.ts);
 * flush 那条路留着 —— 它仍然是「这条流要收了」的正解,只是电话里没人会走。
 *
 * 2026-09-18 起这条链路**真接火山跑过**(Ben 的凭证、本机假手机走完一遍引导),
 * 不再是「只验了帧编解码」的状态。
 */
import { asLanguageCode, stt } from '@livekit/agents'
import { pcmOfInt16 } from '../audio/wav.ts'
import type { VolcAsrCreds, VolcAsrSession } from './volcSession.ts'
import { openVolcAsrSession } from './volcSession.ts'

export interface VolcStreamingSttOptions {
  url: string
  creds: VolcAsrCreds
  hotwords?: readonly string[]
  /**
   * 火山报错时往哪儿说(2026-09-18)。缺省 `console.warn` —— 但那一行不带
   * `[channel-worker]` 前缀,在混着框架 pino 日志的那份 log 里很容易被当成框架自己的噪音。
   * 工人会把自己的 `log()` 传进来,于是「她为什么听不见」在同一条日志线上看得见。
   */
  onError?: (message: string) => void
  /**
   * 不是错、但值得进日志的那几句(2026-09-25):断了重连补发了多少音频、换了带上下文的连接。
   * 缺省 `console.log`。
   */
  onNote?: (message: string) => void
  /** 多久没有音频进来就把火山那条连接收掉。见 {@link VOLC_IDLE_CLOSE_MS}。测试调小。 */
  idleCloseMs?: number
  /** 测试注入一个假会话;缺省开真的 WebSocket。 */
  openSession?: typeof openVolcAsrSession
}

/**
 * **空闲多久就把火山会话收掉**(2026-09-18)。
 *
 * 为什么需要它:框架**不会**因为挂断/换人就重建 STT 流 —— 本机实测,同一条
 * `VolcSpeechStream` 活到工人退出为止,帧号从第一通电话一路数到第十通。
 * 于是那条火山 WebSocket 也一直开着,而 `volc.bigasr.sauc.duration` 是**按时长计费**的那个。
 *
 * 10 秒:通话中音频是**连续**的(她说话时框架也只是把帧换成静音,不是停),
 * 所以在一通电话里永远不会触发;只有房里没人、音频真的断了才会。
 */
export const VOLC_IDLE_CLOSE_MS = 10_000

/**
 * **断了重连时补发多少「还没听完」的音频**(2026-09-25,卡 fix/call-under-load-and-name)。
 *
 * 09-24 晚引导:这台 Mac 忙到工人主线程卡了半分钟,火山等不到包回了 45000081 断开。
 * 卡住那半分钟里他说的话,在主线程缓过来的那一刻才一股脑推进**那条已经死了的连接** —— 全丢了,
 * 下一帧重开的新连接只听得见之后的话。
 *
 * 现在每条连接都记着「上一次判停之后推过的音频」;这条连接**因为出错**断了,
 * 下一条新连接开场先把这一截补发过去。一截最多这么长(超了丢最旧的);
 * 这一截里一点人声都没有(全是静音)就不补 —— 火山按时长计费,补静音是白花钱。
 */
export const VOLC_REPLAY_MAX_MS = 12_000
const VOLC_REPLAY_MAX_BYTES = 16000 * 2 * (VOLC_REPLAY_MAX_MS / 1000)
/** 一截里有没有人声:峰值过这个数就算有(16 位 PCM;静音与底噪远在它之下)。 */
const VOICE_PEAK = 1000

function hasVoice(pcm: Buffer): boolean {
  for (let offset = 0; offset + 1 < pcm.length; offset += 16) {
    if (Math.abs(pcm.readInt16LE(offset)) > VOICE_PEAK) return true
  }
  return false
}

/**
 * 同一条错误连着来时,日志只写一行 + 一个数(2026-09-20)。
 *
 * Ben 那一通里连着 17 条一模一样的 `火山 ASR 错误(45000081)`,占满了那一段日志,
 * 而它们说的是同一件事。第一条照写(要的就是它的时间点),后面的攒着;
 * 换了一条别的、或者这条流结束时,再补一句「上面那条又连着来了 N 次」。
 * **一条都不丢**,只是不重复十七遍。
 */
export class RepeatCollapser {
  readonly #write: (line: string) => void
  #last: string | undefined
  #repeats = 0

  constructor(write: (line: string) => void) { this.#write = write }

  say(line: string): void {
    if (line === this.#last) { this.#repeats += 1; return }
    this.flush()
    this.#last = line
    this.#write(line)
  }

  /** 把攒着的那个数写出去。流结束、或者换了一条别的错误时调。 */
  flush(): void {
    if (this.#repeats > 0) this.#write(`上面那条「${this.#last ?? ''}」又连着来了 ${this.#repeats} 次。`)
    this.#repeats = 0
    this.#last = undefined
  }
}

export class VolcStreamingStt extends stt.STT {
  label = 'butler.VolcStreamingStt'

  readonly options: VolcStreamingSttOptions
  #dialog: readonly string[] | undefined
  /**
   * 识别热词(2026-10-02,卡「电话里像个活人」)。构造时给一份,**每通电话现取人设时还能换**
   * ——「她最近说过的专有词」会变,家名也会变(她装了新的一家)。
   * 和对话上下文一样只在**开场帧**里,所以换了要让流换一条新连接(靠 {@link contextVersion})。
   */
  #hotwords: readonly string[] | undefined
  #contextVersion = 0
  /**
   * 火山**不认**对话上下文(带着它开的连接一上来就回「请求参数无效」)。这件事官方文档里写着支持,
   * 但本机没有真凭证验过(交接-0925 写明),所以留一条退路:认定一次,这个进程以后开连接就不带了,
   * 没听完的那一截照样补发 —— 宁可少一个上下文,也不能让她在问称呼那一段整段听不见。
   */
  #dialogRejected = false
  /** 活着的那几条流(框架通常只开一条,换活动时会短暂两条)。{@link quiet} 要挨个收。 */
  readonly #streams = new Set<VolcSpeechStream>()

  constructor(options: VolcStreamingSttOptions) {
    super({ streaming: true, interimResults: true })
    this.options = options
    this.#hotwords = options.hotwords === undefined || options.hotwords.length === 0 ? undefined : [...options.hotwords]
  }

  /**
   * **挂断了:火山那条连接当场断**(2026-09-25,卡 fix/evening-gaps 第 1 条)。
   *
   * 以前只有「10 秒没有音频进来」才收({@link VOLC_IDLE_CLOSE_MS}),而常驻房间的手机挂断后
   * 那条静音轨道还一直出帧 —— 连接就一直开着,按时长计费。现在工人的收音闸一关就调这里:
   * 每条流当场断开火山连接、丢掉没听完的那一截(挂了的电话不补发)。流本身不关 ——
   * 下一通第一帧音频进来会照常开一条新连接。回收掉了几条连接。
   */
  quiet(): number {
    let closed = 0
    for (const stream of this.#streams) if (stream.quiet()) closed += 1
    return closed
  }

  /** @internal 流开始 / 结束时登记。 */
  trackStream(stream: VolcSpeechStream, alive: boolean): void {
    if (alive) this.#streams.add(stream)
    else this.#streams.delete(stream)
  }

  /** 此刻要带给火山的对话上下文(见 volcProtocol.ts 的 buildCorpus)。没有、或者火山不认,就是 undefined。 */
  get dialog(): readonly string[] | undefined { return this.#dialogRejected ? undefined : this.#dialog }
  /** 认定火山不认对话上下文。回 true = 这是第一次认定(该记一行日志)。 */
  rejectDialog(): boolean {
    if (this.#dialogRejected) return false
    this.#dialogRejected = true
    return true
  }
  /** 上下文换过几次。流里的连接据此知道「该换一条带新上下文的了」。 */
  get contextVersion(): number { return this.#contextVersion }

  /** 此刻要带给火山的热词(见 volcProtocol.ts 的 buildCorpus:单字会被挑掉)。一个都没有就 undefined。 */
  get hotwords(): readonly string[] | undefined { return this.#hotwords }

  /**
   * 换热词(2026-10-02):每通电话现取人设时把这台机器上的词表交进来。
   * 和 {@link setDialogContext} 同一个机制 —— 热词只在开场帧里,换了之后流会在下一帧
   * 把连接换成一条新的。和现在一样就什么都不做,回 false。
   */
  setHotwords(words: readonly string[] | undefined): boolean {
    const next = words === undefined || words.length === 0 ? undefined : [...words]
    if ((this.#hotwords ?? []).join('\n') === (next ?? []).join('\n')) return false
    this.#hotwords = next
    this.#contextVersion += 1
    return true
  }

  /**
   * 换对话上下文(2026-09-25):问称呼那一轮带上她那句问话,问完就撤。
   * 火山的上下文**只在开场帧里**,所以换了之后,流会在下一帧把连接换成一条新的
   * (没听完的那一截带过去,见 {@link VOLC_REPLAY_MAX_MS})。和现在一样就什么都不做,回 false。
   */
  setDialogContext(dialog: readonly string[] | undefined): boolean {
    const next = dialog === undefined || dialog.length === 0 ? undefined : [...dialog]
    if ((this.#dialog ?? []).join('\n') === (next ?? []).join('\n')) return false
    this.#dialog = next
    this.#contextVersion += 1
    return true
  }

  override get model(): string { return 'volc-bigasr-sauc' }
  override get provider(): string { return 'volcengine' }

  /**
   * 一次性识别一整段。流式这条路上用不到它,但基类要求有 —— 实现成「开一条流、全推进去、
   * 等最终结果」比抛异常好:将来 `stt.FallbackAdapter` 之类的地方会调它。
   */
  protected async _recognize(): Promise<stt.SpeechEvent> {
    throw new Error('VolcStreamingStt 只走流式:用 stream()')
  }

  stream(): stt.SpeechStream {
    const stream = new VolcSpeechStream(this)
    this.trackStream(stream, true)
    return stream
  }
}

export class VolcSpeechStream extends stt.SpeechStream {
  label = 'butler.VolcSpeechStream'

  readonly #stt: VolcStreamingStt
  /** run() 里接上:当场收掉这条流此刻的火山连接。回 true = 真的有一条被收掉。 */
  #quiet: (() => boolean) | undefined

  constructor(owner: VolcStreamingStt) {
    // 16k:火山只吃这一个采样率,基类会替我们重采样。
    super(owner, 16000)
    this.#stt = owner
  }

  /** 见 {@link VolcStreamingStt.quiet}。流还没跑起来 / 已经结束时什么都不做。 */
  quiet(): boolean {
    return this.#quiet?.() ?? false
  }

  protected async run(): Promise<void> {
    const owner = this.#stt
    const options = owner.options
    const open = options.openSession ?? openVolcAsrSession
    /**
     * 这一通电话的会话。**一条连接管很多句** —— 火山按判停自己分句(`definite`),
     * 不用一句一条(2026-09-18 改;以前那句「火山一条连接只认一句」的注释是错的,
     * 它正是「电话里永远等不到最后一包」那个坑的来源)。
     * 断了(出错、服务端收尾)才置空,下一帧音频重开一条。
     */
    let session: VolcAsrSession | undefined
    /** 这条连接开场时用的是第几版上下文。 */
    let sessionVersion = owner.contextVersion
    /** 已经发出去的最后一条中间结果,避免同一句重复 push。 */
    let lastInterim = ''
    const errors = new RepeatCollapser(options.onError ?? ((line: string) => console.warn(`[channel-worker] ${line}`)))
    const note = options.onNote ?? ((line: string) => console.log(`[channel-worker] ${line}`))

    /**
     * 「上一次判停之后推过的音频」(2026-09-25)。连接因为出错断了,新连接开场先把这一截补过去。
     * 见 {@link VOLC_REPLAY_MAX_MS}。
     */
    const unheard: Buffer[] = []
    let unheardBytes = 0
    let unheardVoiced = false
    let replayPending = false
    const remember = (pcm: Buffer): void => {
      unheard.push(Buffer.from(pcm))
      unheardBytes += pcm.length
      if (!unheardVoiced && hasVoice(pcm)) unheardVoiced = true
      while (unheardBytes > VOLC_REPLAY_MAX_BYTES && unheard.length > 1) unheardBytes -= (unheard.shift() as Buffer).length
    }
    const forget = (): void => {
      unheard.length = 0
      unheardBytes = 0
      unheardVoiced = false
    }

    const emit = (event: stt.SpeechEvent): void => {
      if (this.closed) return
      this.queue.put(event)
    }

    const ensure = (): VolcAsrSession => {
      if (session !== undefined) return session
      lastInterim = ''
      emit({ type: stt.SpeechEventType.START_OF_SPEECH })
      /** 这一条连接自己。handlers 只认自己那一条 —— 换连接之后旧那条的尾巴不许动新那条。 */
      let mine: VolcAsrSession | undefined
      let errored = false
      /** 这条连接回过识别结果没有。带着上下文开的连接**一个结果都没回就报参数错**,认定火山不认上下文。 */
      let heardBack = false
      const dialog = owner.dialog
      // 热词**从 owner 现取**(2026-10-02):每通电话换人设时会换,构造时那一份只是起点。
      const hotwords = owner.hotwords
      const opened = open({
        url: options.url,
        creds: options.creds,
        ...(hotwords === undefined ? {} : { hotwords }),
        ...(dialog === undefined ? {} : { dialog }),
        handlers: {
          onInterim: (text) => {
            if (session !== mine) return
            heardBack = true
            if (text === lastInterim) return
            lastInterim = text
            emit({
              type: stt.SpeechEventType.INTERIM_TRANSCRIPT,
              alternatives: [{ language: asLanguageCode('zh-CN'), text, startTime: 0, endTime: 0, confidence: 0 }],
            })
          },
          /**
           * 一句说完了。**这一条是她能不能接话的全部** —— 框架只认 FINAL:
           * `audioTranscript` 只从 FINAL 累积,空的就 `skipping EOU detection`。
           * 判停之后连接照旧用着,所以这里只清中间结果的去重底,不碰 session。
           * 这一句已经听完了:补发那一截从这里重新攒。
           */
          onFinal: (text) => {
            if (session !== mine) return
            heardBack = true
            lastInterim = ''
            forget()
            emit({
              type: stt.SpeechEventType.FINAL_TRANSCRIPT,
              alternatives: [{ language: asLanguageCode('zh-CN'), text, startTime: 0, endTime: 0, confidence: 1 }],
            })
          },
          onError: (message) => {
            // 一句没听清不该把通话带走:如实记一条,这一轮当作没说话。
            // 交给工人自己那条日志(带 [channel-worker] 前缀),没接就退回 console。
            // 连着来的同一条只写一行 + 一个数(见 RepeatCollapser)。
            errored = true
            errors.say(message)
            if (dialog !== undefined && !heardBack && /45000001|参数/.test(message) && owner.rejectDialog()) {
              note('火山不认这条连接开场带的对话上下文(一个结果没回就报参数错):这个进程以后开连接不带上下文了,没听完的照样补发')
            }
          },
          onClose: () => {
            if (session !== mine || mine === undefined) return
            emit({ type: stt.SpeechEventType.END_OF_SPEECH })
            session = undefined
            // **因为出错**断的:下一条连接开场先补发没听完的那一截(正常收尾、空闲收掉都不补)。
            if (errored) replayPending = true
          },
        },
      })
      mine = opened
      session = opened
      sessionVersion = owner.contextVersion
      if (replayPending) {
        replayPending = false
        if (unheardVoiced && unheardBytes > 0) {
          opened.push(Buffer.concat(unheard))
          note(`火山识别断了又连上,把没听完的 ${(unheardBytes / 32000).toFixed(1)} 秒补发过去了(那一截里有他的声音)`)
        }
      }
      return opened
    }

    /**
     * 这条流不要了(通话结束、被打断重建)→ **把 WebSocket 真的断掉**(2026-09-18)。
     * 以前只 `finish()`:那只是「我不发了」,连接还挂着,而火山那个 resource 是**按时长计费**的,
     * 一条忘了关的会话会一直算。断了没有坏处 —— 走到这儿这一通已经结束了。
     */
    const closeSession = (): void => {
      if (idleTimer !== undefined) { clearTimeout(idleTimer); idleTimer = undefined }
      const current = session
      session = undefined
      current?.finish()
      current?.close()
    }
    this.abortSignal.addEventListener('abort', closeSession, { once: true })

    /**
     * 空闲计时。**一通电话里永远不会响** —— 通话中音频是连续的(她说话时框架只是把帧换成静音);
     * 只有房里没人、音频真的断了才会走到这儿,那时候把连接收掉(见 VOLC_IDLE_CLOSE_MS)。
     * `unref()`:这根计时器不该拦着进程退出。
     */
    const idleMs = options.idleCloseMs ?? VOLC_IDLE_CLOSE_MS
    let idleTimer: ReturnType<typeof setTimeout> | undefined
    const touch = (): void => {
      if (idleTimer !== undefined) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        closeSession()
        // 真的没人了:攒着的那一截不必再补。
        forget()
      }, idleMs)
      idleTimer.unref?.()
    }

    /**
     * 收音闸关了(挂断 / 不在通话里,2026-09-25):当场断连接,没听完的那一截也不留 ——
     * 挂了的电话不补发,下一通从干净的开始。连接断在这里不算「出错」,不会触发补发。
     */
    this.#quiet = (): boolean => {
      const had = session !== undefined
      closeSession()
      forget()
      replayPending = false
      lastInterim = ''
      if (had) emit({ type: stt.SpeechEventType.END_OF_SPEECH })
      return had
    }

    try {
      for await (const item of this.input) {
        if (item === stt.SpeechStream.FLUSH_SENTINEL) {
          // 框架其实从不给流式 STT 发这个(FINAL 由火山判停给,见文件头),但它来了就是「收了这条」。
          session?.finish()
          continue
        }
        touch()
        /**
         * **上下文换了**(问称呼那一轮带上问话 / 问完撤掉):火山的上下文只在开场帧里,
         * 所以把这条连接换成一条新的,没听完的那一截带过去 —— 他要是正说到一半,一个字都不丢。
         */
        if (session !== undefined && sessionVersion !== owner.contextVersion) {
          const old = session
          session = undefined
          old.close()
          emit({ type: stt.SpeechEventType.END_OF_SPEECH })
          replayPending = true
          note(`火山识别换了一条连接:${owner.dialog === undefined ? '撤掉对话上下文' : `带上对话上下文(${owner.dialog.length} 条)`}`)
        }
        const pcm = pcmOfInt16(item.data)
        ensure().push(pcm)
        remember(pcm)
      }
    }
    finally {
      this.abortSignal.removeEventListener('abort', closeSession)
      this.#quiet = undefined
      owner.trackStream(this, false)
      closeSession()
      errors.flush()
      this.queue.close()
    }
  }
}
