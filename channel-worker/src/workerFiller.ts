/**
 * 缓冲语 —— **第三版:由电脑上的工人用当前音色说**(2026-09-23 晚,维护者拍板)。
 *
 * ## 为什么又改
 *
 * 第二版(filler.ts 头注释)是「工人只发信号,手机 / 派各自放本地那份 wav」。
 * 那几份 wav 是**固定音色**的:音色一换,她的回答是新嗓子、「我想想」还是旧嗓子 ——
 * 一通电话两个嗓子,维护者 09-23 下午点过名的那件事。手机那一份虽然按音色缓存,
 * 派上那一份是铺卡时拷进去的死文件,跟不了。
 *
 * 这一版:**工人自己说**,用的是开场白 / 先应那一句同一张预合成缓存(tts/greeting.ts 的
 * `GreetingCache`),换音色整张作废重合 —— 所以垫场永远是她此刻的嗓子;
 * **缓存没命中就不垫**(宁可不垫,也不放旧音色、也不现合成去撞她的真回答)。
 *
 * ## 怎么插进去而不排在回答后面(这是整件事的难点)
 *
 * `session.say()` **不行**:框架的发言队列是**串行**的(`agent_activity.mainTask` 一次只放一条,
 * 当前这条的整段生成完才轮到下一条),而这一轮的回答在回合提交那一刻就已经是「当前这一条」了 ——
 * 700ms 之后再 `say` 注定排在回答**后面**。09-20 第一版逐字踩过(filler.ts 头注释 ①)。
 * 提高优先级也没用:优先级只决定**下一条**是谁,插不进正在放的这一条。
 *
 * 所以垫场**做成回答本身的前几百毫秒**:
 *
 *   1. `llmNode` 外面包一层({@link withFillerKick}):到点了、模型还一个字都没吐,
 *      就往文字流里塞一个**空串**。空串让框架当场开一段(`produceSegments` → `startSegment`
 *      → 调 `ttsNode`),而它**不改变任何文字**:`generatedText += ''`、字幕 / 对话历史里的
 *      那条 assistant 消息都只由真文字组成(`forwardedText` 是空的就不写历史)。
 *   2. `ttsNode` 外面包一层({@link withFillerFrames}):这一段的音频流先吐垫场那句的帧,
 *      **真声的第一帧一到就不再吐垫场**,之后原样转交真声。帧是一帧一帧被拉走的
 *      (音频输出那头有背压),所以「立刻停」的误差是输出队列那 ~200ms,不是整句。
 *
 * 取舍(写清楚,可推翻):
 *   · 垫场是回答的一部分,**他一开口打断,垫场与回答一起停** —— 这正是想要的;
 *   · 它**不进对话历史、不进字幕、不进纪要**(见上第 1 条),也就不会被模型当成自己说过的话;
 *   · 框架看见第一帧就把状态切到 `speaking` —— 所以垫场那一轮的 `speaking` 是垫场出声那一刻,
 *     latency.ts 那一行的 `publish_ms` / `mouth_ms` 在垫过的回合里量到的是垫场,不是真声
 *     (那一行会带 `filler:true`,读的人分得清);
 *   · 垫场放完、真声还没来的那段,每 {@link FILLER_KEEPALIVE_MS} 补一帧 20ms 静音 ——
 *     框架对「出过声之后 10 秒没新帧」会当 TTS 卡死强行收掉这一段(`ttsReadIdleTimeout`),
 *     慢工具(`wb_ask_butler` 最长 12 秒)正好会撞上;
 *   · 打开「抢跑合成」(`WORKBENCH_CHANNEL_PREEMPTIVE_TTS=on`)时,被作废的那一版抢跑回答
 *     可能先把垫场领走,那一回合就垫不上 —— 少一句,不会多一句。
 *
 * ## 2026-10-03:垫的那一句可以是**这一回合现生的首句**(卡「首声提速」乙)
 *
 * 维护者:「多数回合先『我想想』垫场,再等好几秒」。所以这一版多了两个口子 ——
 * {@link WorkerFiller.expectFirstVoice}(这一回合会有一句首句,到点时愿意多等一小截)与
 * {@link WorkerFiller.offerFirstVoice}(首句合好了,就垫它、不垫「我想想」)。
 *
 * **插进去的路一个字没改**:首句同样是一份 `FillerClip`,同样从 `ttsNode` 那一层
 * 当成回答的前几百毫秒吐出去。所以它也**不进对话历史、不进字幕**,也同样「她一开口就停」。
 * 来晚了(已经垫过 / 已经出过真声)就**扔掉**,绝不在后面补一句 —— 两句话打架比一句固定话糟。
 *
 * 纯的:不认识 LiveKit 房间、不认识 `session`,帧的类型是泛型,单测里用数字就能跑完。
 */

/** 等多久还没出声才垫。与手机那侧 `FILLER_WAIT_MS`、派上那份**同一个数**(维护者没改这个数)。 */
export const FILLER_WAIT_MS = 700

/** 垫场放完、真声还没到时,多久补一帧静音(见文件头「取舍」第 4 条)。比框架那 10 秒短一半。 */
export const FILLER_KEEPALIVE_MS = 5_000

/**
 * **到点了,但这一回合的「首句」还在合着** —— 最多再等这么久(毫秒,2026-10-03,
 * 卡「首声提速」乙)。
 *
 * 为什么要这一格:首句是**现生现合**的(小模型一句话 + 8792 合成),
 * 合好大致要 0.6–1.2 秒,而垫场那道门是 {@link FILLER_WAIT_MS}(700ms)——
 * 不多等一点,首句十次有八次赶不上,这一回合照旧是「我想想」。
 *
 * 代价**说清楚**:首句最后没合出来的那几个回合,她比以前多沉默这么久
 * (然后才垫「我想想」)。所以这个数是可配的,`WORKBENCH_CHANNEL_FIRST_VOICE_GRACE_MS=0`
 * = 一点都不多等(首句只在 700ms 之内赶上才算)。
 */
export const FIRST_VOICE_GRACE_MS = 400

/**
 * 那五句「想一下」的原文。**id 与 butler-app/src/call/fillerLines.json 逐字相同**,
 * 文字也相同 —— 信号里点名的 `line` 就是这些 id(filler.ts 的 `THINKING_LINE_IDS`)。
 * 工具专用那两句(`tool-*`)这一版工人不说:**一轮最多垫一次**,那一次就是这里。
 */
export const THINKING_LINE_TEXTS: Readonly<Record<string, string>> = {
  'think-1': '我想想。',
  'think-2': '稍等一下。',
  'think-3': '让我看看。',
  'think-4': '嗯,我想一下。',
  'think-5': '等我一下。',
}

/** 要预热进 GreetingCache 的那几句(换音色跟着整张重合)。 */
export const FILLER_LINES: readonly string[] = [...new Set(Object.values(THINKING_LINE_TEXTS))]

/** 一句垫场:原文(日志用)+ 帧。 */
export interface FillerClip<F> {
  text: string
  frames: readonly F[]
  /**
   * **这一句不许被掐断**(2026-10-03,卡「首声提速」乙)。
   *
   * 固定那几句只有三四个字(「我想想。」约 0.8 秒),真声一到就停,听着像正常的接话;
   * 而现生的首句有十来个字(约两秒),真声多半在它说到一半时到 —— 按老规矩就会出现
   * 「好,我这就去问豆」然后硬切。**吞字是这个项目点过名的毛病**
   * (维护者 09-27:「一上来就听到『吩咐』两个字,『吩』字还是尾巴」),
   * 比多等几百毫秒糟得多。所以带这一格的那一句**放完为止**,真回答排在它后面。
   */
  whole?: true
}

/**
 * 按点名挑一句**缓存里有的**。点名那句没有就挑别的一句缓存里有的(都是当前音色 ——
 * 换音色时缓存整张作废);一句都没有 → undefined(**不垫**)。
 */
export function pickFillerClip<F>(
  line: string | undefined,
  lookup: (text: string) => readonly F[] | undefined,
): FillerClip<F> | undefined {
  const named = line === undefined ? undefined : THINKING_LINE_TEXTS[line]
  const order = named === undefined ? FILLER_LINES : [named, ...FILLER_LINES.filter(one => one !== named)]
  for (const text of order) {
    const frames = lookup(text)
    if (frames !== undefined && frames.length > 0) return { text, frames }
  }
  return undefined
}

export interface WorkerFillerOptions<F> {
  /** 按点名取一句(见 {@link pickFillerClip})。 */
  clip: (line: string | undefined) => FillerClip<F> | undefined
  waitMs?: number
  /** 首句还在合着时最多多等多久。缺省 {@link FIRST_VOICE_GRACE_MS};0 = 不多等。 */
  firstVoiceGraceMs?: number
  /** 定时器(测试注入)。回一个「取消它」的函数。 */
  setTimer?: (fn: () => void, ms: number) => () => void
  log?: (line: string) => void
  /** 真垫出去了(被领走那一下)。agent.ts 拿它给这一回合的计时记一笔 `filler:true`。 */
  onPlay?: (clip: FillerClip<F>) => void
}

/**
 * `grace` 是 2026-10-03 加的一格:到点了、但这一回合**说好了会有一句首句**
 * ({@link WorkerFiller.expectFirstVoice}),于是再等 {@link FIRST_VOICE_GRACE_MS}。
 */
type Phase = 'idle' | 'armed' | 'grace' | 'wanted' | 'playing' | 'spent'

/**
 * 一轮一次的那个开关。接线:
 *   · 垫场闸门按下(filler.ts 的 `applyAgentState` → gate → emit)时 {@link arm};
 *   · 回合真结束(`listening` / `idle`)时 {@link endRound};
 *   · `ttsNode` 那一层每看见一帧**真声**就 {@link realVoice};
 *   · `llmNode` 那一层 {@link onWanted} 订阅「该垫了」,`ttsNode` 那一层 {@link take} 领走那一句。
 */
export class WorkerFiller<F> {
  readonly #options: WorkerFillerOptions<F>
  readonly #waitMs: number
  readonly #graceMs: number
  readonly #setTimer: (fn: () => void, ms: number) => () => void
  readonly #log: (line: string) => void
  #phase: Phase = 'idle'
  #cancelTimer: (() => void) | undefined
  #pending: FillerClip<F> | undefined
  /** 这一轮已经出过真声(之后再到点也不垫:她已经在说了)。 */
  #voiced = false
  /** 这一轮**说好了会有一句首句**(2026-10-03):到点时允许多等 {@link #graceMs}。 */
  #expectFirstVoice = false
  /** 首句合好了、还没被领走的那一句。 */
  #firstVoice: FillerClip<F> | undefined
  readonly #wantedListeners = new Set<() => void>()

  constructor(options: WorkerFillerOptions<F>) {
    this.#options = options
    this.#waitMs = options.waitMs ?? FILLER_WAIT_MS
    this.#graceMs = options.firstVoiceGraceMs ?? FIRST_VOICE_GRACE_MS
    this.#setTimer = options.setTimer ?? ((fn, ms) => {
      const handle = setTimeout(fn, ms)
      return () => clearTimeout(handle)
    })
    this.#log = options.log ?? (() => {})
  }

  /** 此刻在哪一格(测试与日志用)。 */
  get phase(): Phase { return this.#phase }

  /** 这一回合要垫(闸门已经按下)。**一轮只认第一次**;这一轮已经出过真声就不再垫。 */
  arm(line?: string): void {
    if (this.#phase !== 'idle') return
    if (this.#voiced) { this.#phase = 'spent'; return }
    this.#phase = 'armed'
    this.#cancelTimer = this.#setTimer(() => this.#fire(line), this.#waitMs)
  }

  /**
   * **这一回合会有一句首句**(2026-10-03,卡「首声提速」乙)。在开判那一刻置上
   * (act 路 + 首句开着),于是到点时这一轮愿意多等 {@link FIRST_VOICE_GRACE_MS}。
   * 不置 = 一点都不多等,与这一版之前**一字不差**。
   */
  expectFirstVoice(): void {
    if (this.#phase === 'idle' || this.#phase === 'armed') this.#expectFirstVoice = true
  }

  /** 这一回合在等首句吗(日志与用例用)。 */
  get expectingFirstVoice(): boolean { return this.#expectFirstVoice }

  /**
   * **首句合好了**(2026-10-03)。真 = 这一回合垫的会是它。
   *
   * 三种时机:
   *   · 还没到点(`armed`)→ **当场就垫**,不等满那 700ms(首句早一点出口是白赚的);
   *   · 到点了正在多等(`grace`)→ 当场垫;
   *   · 已经垫过 / 已经出过真声(`wanted` / `playing` / `spent`)→ 回 `false`,
   *     这一句**扔掉**:她已经听过一句了,再补一句就是两句话打架。
   */
  offerFirstVoice(clip: FillerClip<F>): boolean {
    if (this.#phase !== 'armed' && this.#phase !== 'grace') return false
    if (clip.frames.length === 0) return false
    this.#cancelTimer?.()
    this.#cancelTimer = undefined
    this.#firstVoice = clip
    // 接下了 = 这一句已经在垫场那条路上(等着被领走,或者当场就被领走了)。
    return this.#fireNow(undefined)
  }

  #fire(line: string | undefined): void {
    this.#cancelTimer = undefined
    if (this.#phase !== 'armed') return
    /*
     * 到点了,可是这一回合说好了会有一句首句、它还没合好 —— 再等一小截(文件头与
     * {@link FIRST_VOICE_GRACE_MS})。多等的这一截里她是沉默的,所以它可配、可关。
     */
    if (this.#expectFirstVoice && this.#firstVoice === undefined && this.#graceMs > 0) {
      this.#phase = 'grace'
      this.#log(`[channel-worker] 到点还没出声,这一回合的首句还在合 —— 再等 ${this.#graceMs}ms`)
      this.#cancelTimer = this.#setTimer(() => {
        this.#cancelTimer = undefined
        if (this.#phase !== 'grace') return
        this.#log('[channel-worker] 首句没赶上,这一回合照旧垫固定那一句')
        this.#fireNow(line)
      }, this.#graceMs)
      return
    }
    this.#fireNow(line)
  }

  /** 真的把一句交出去(回 `true` = 交出去了:在等人领,或者当场就被领走了)。 */
  #fireNow(line: string | undefined): boolean {
    if (this.#phase !== 'armed' && this.#phase !== 'grace') return false
    let clip: FillerClip<F> | undefined = this.#firstVoice
    if (clip === undefined) {
      try { clip = this.#options.clip(line) }
      catch { clip = undefined }
    }
    if (clip === undefined) {
      this.#phase = 'spent'
      this.#log(`[channel-worker] 到点没出声,但垫场那几句还没按当前音色合好(或刚换过音色),这一回合不垫`)
      return false
    }
    this.#pending = clip
    this.#phase = 'wanted'
    for (const listener of [...this.#wantedListeners]) {
      try { listener() }
      catch { /* 一个订阅者坏了不许带走别的 */ }
    }
    return true
  }

  /** 此刻是不是「该垫了、还没人领走」。 */
  get wanted(): boolean { return this.#phase === 'wanted' }

  /** 订阅「该垫了」。已经是这个状态就当场叫一声。回一个退订函数。 */
  onWanted(listener: () => void): () => void {
    this.#wantedListeners.add(listener)
    if (this.#phase === 'wanted') {
      try { listener() }
      catch { /* 同上 */ }
    }
    return () => { this.#wantedListeners.delete(listener) }
  }

  /** 领走那一句(**只有一个人领得到**)。没到点 / 已经领走 / 已经出声 → undefined。 */
  take(): FillerClip<F> | undefined {
    if (this.#phase !== 'wanted' || this.#pending === undefined) return undefined
    const clip = this.#pending
    this.#pending = undefined
    this.#phase = 'playing'
    this.#log(`[channel-worker] 到点还没出声,垫了一句「${clip.text}」(当前音色,走同一条音轨)`)
    try { this.#options.onPlay?.(clip) }
    catch { /* 记一笔失败不许把垫场弄没 */ }
    return clip
  }

  /** 真声出来了。还没到点的计时器取消;这一轮不会再垫。 */
  realVoice(): void {
    this.#voiced = true
    if (this.#phase === 'armed' || this.#phase === 'grace' || this.#phase === 'wanted') {
      this.#cancelTimer?.()
      this.#cancelTimer = undefined
      this.#pending = undefined
      this.#firstVoice = undefined
      this.#phase = 'spent'
    }
  }

  /** 这一轮结束了(回到听 / 闲下来)。 */
  endRound(): void {
    this.#cancelTimer?.()
    this.#cancelTimer = undefined
    this.#pending = undefined
    this.#firstVoice = undefined
    this.#expectFirstVoice = false
    this.#phase = 'idle'
    this.#voiced = false
  }
}

/** 这一块是不是**真文字**(会开一段、会进字幕的那种)。 */
export function carriesText(chunk: unknown): boolean {
  if (typeof chunk === 'string') return chunk.length > 0
  if (typeof chunk !== 'object' || chunk === null) return false
  const delta = (chunk as { delta?: { content?: unknown } }).delta
  return typeof delta?.content === 'string' && delta.content.length > 0
}

/**
 * 包 `llmNode` 的输出:模型还没吐出真文字之前,「该垫了」一响就塞一个**空串**进去 ——
 * 只为让框架当场开一段、调 `ttsNode`(见文件头第 1 条)。一段只塞一次;真文字过了就不再塞。
 */
export function withFillerKick<T>(
  base: ReadableStream<T>,
  filler: Pick<WorkerFiller<unknown>, 'onWanted'>,
  kick: T,
): ReadableStream<T> {
  const reader = base.getReader()
  let done = false
  let off: (() => void) | undefined
  const stop = (): void => { done = true; off?.(); off = undefined }
  return new ReadableStream<T>({
    start(controller) {
      off = filler.onWanted(() => {
        if (done) return
        stop()
        try { controller.enqueue(kick) }
        catch { /* 流已经关了 */ }
      })
    },
    async pull(controller) {
      const next = await reader.read()
      if (next.done) { stop(); controller.close(); return }
      if (carriesText(next.value)) stop()
      controller.enqueue(next.value)
    },
    async cancel(reason) {
      stop()
      await reader.cancel(reason)
    },
  })
}

/** 文字流里去掉 {@link withFillerKick} 塞进来的空串(别让它当成「模型首字」进计时)。 */
export function dropEmptyText(input: ReadableStream<string>): ReadableStream<string> {
  return input.pipeThrough(new TransformStream<string, string>({
    transform(chunk, controller) { if (chunk !== '') controller.enqueue(chunk) },
  }))
}

export interface FillerFramesOptions<F> {
  filler: Pick<WorkerFiller<F>, 'onWanted' | 'take' | 'realVoice'>
  /** 20ms 静音一帧(保活用,见文件头「取舍」第 4 条)。 */
  silence: () => F
  keepaliveMs?: number
}

/**
 * 包 `ttsNode` 的输出:真声还没来时,「该垫了」就领走那一句、一帧一帧吐;
 * **真声第一帧一到就不再吐垫场**,之后原样转交真声。真声流没有(null)就原样 null。
 *
 * 出流是**按需**的(`highWaterMark: 0`):帧只在消费者来取时才出,不预取。
 * 这条是 2026-10-22 卡「工人垫场帧竞态」定的:默认水位下,`enqueue` 满足了一个
 * pending read 后流会**立即再调一次 `pull`**(Node 26.12 起这一步抢在了生产者的
 * 后续微任务前面),预取出去的那一帧垫场可能在「真声帧已经进了真声流」之后才出流 ——
 * 真声到了还多吐一帧垫场。按需出帧后,出帧那一刻「真声到没到」已经由
 * {@link realArrived} / 队列定死,与微任务调度顺序无关。
 */
export function withFillerFrames<F>(
  real: ReadableStream<F>,
  options: FillerFramesOptions<F>,
): ReadableStream<F> {
  const { filler, silence } = options
  const keepaliveMs = options.keepaliveMs ?? FILLER_KEEPALIVE_MS
  const reader = real.getReader()
  const queue: F[] = []
  let realDone = false
  let realError: unknown
  /**
   * 真声**已到**:真声帧一进 {@link queue} 就置上(读循环里置,不等到 `pull` 取出)。
   * 「真声已到」的判定以进队那一刻为准,与 `pull` 何时被调度无关。
   */
  let realArrived = false
  /** 已按「真声到了」收过一轮尾(退订、清垫场、`realVoice` 叫过一声);只做一次。 */
  let realStarted = false
  let fillerFrames: F[] = []
  let fillerPlayed = false
  /** 领到的那一句**不许被掐断**(首句;见 {@link FillerClip.whole})。 */
  let fillerWhole = false
  let wake: (() => void) | undefined
  const poke = (): void => { const w = wake; wake = undefined; w?.() }
  let off: (() => void) | undefined
  let cancelled = false

  void (async () => {
    try {
      for (;;) {
        const next = await reader.read()
        if (next.done) break
        realArrived = true
        queue.push(next.value)
        poke()
      }
    }
    catch (err) { realError = err }
    realDone = true
    poke()
  })()

  return new ReadableStream<F>({
    start() {
      off = filler.onWanted(() => {
        if (realArrived || fillerPlayed || fillerFrames.length > 0) return
        const clip = filler.take()
        if (clip === undefined) return
        fillerFrames = [...clip.frames]
        fillerWhole = clip.whole === true
        fillerPlayed = true
        poke()
      })
    },
    async pull(controller) {
      for (;;) {
        if (cancelled) return
        /*
         * **不许被掐断的那一句先放完**(2026-10-03,首句;见 {@link FillerClip.whole})。
         * 真声照旧在这一刻就算「到了」(这一轮不会再垫、`realVoice` 照样叫一声),
         * 只是它的帧排在首句后面 —— 她听到的是「好,我这就去问豆包。」+ 真回答,
         * 而不是「好,我这就去问豆」被硬切。
         */
        if (fillerWhole && fillerFrames.length > 0) {
          if (realArrived && !realStarted) {
            realStarted = true
            off?.()
            off = undefined
            filler.realVoice()
          }
          controller.enqueue(fillerFrames.shift() as F)
          return
        }
        if (queue.length > 0) {
          if (!realStarted) {
            realStarted = true
            // 真声到了:垫场剩下的一帧都不再吐,这一轮也不会再垫。
            fillerFrames = []
            off?.()
            off = undefined
            filler.realVoice()
          }
          controller.enqueue(queue.shift() as F)
          return
        }
        if (fillerFrames.length > 0) {
          controller.enqueue(fillerFrames.shift() as F)
          return
        }
        if (realDone) {
          off?.()
          off = undefined
          if (realError !== undefined) controller.error(realError)
          else controller.close()
          return
        }
        // 等:真声来 / 真声流完 / 该垫了。垫过之后还在等真声的,到点补一帧静音保活。
        const woke = await new Promise<boolean>((resolve) => {
          wake = () => resolve(true)
          if (fillerPlayed && !realStarted) setTimeout(() => { if (wake !== undefined) { wake = undefined; resolve(false) } }, keepaliveMs)
        })
        if (!woke && !realStarted && queue.length === 0 && !realDone) {
          controller.enqueue(silence())
          return
        }
      }
    },
    async cancel(reason) {
      cancelled = true
      off?.()
      off = undefined
      poke()
      await reader.cancel(reason).catch(() => {})
    },
  }, { highWaterMark: 0 })
}
