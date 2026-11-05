/**
 * **打断那条路,换成认中文的判法**(2026-10-03,卡「嗯 / 对 / 好 真的不打断她」,决策记录 ④甲)。
 *
 * (这个文件里 **他** = 举着听筒的那个人,**她** = 事务官 —— 与 backchannel.ts / filler.ts 同一个口径。)
 *
 * ## 为什么要它
 *
 * 业界的尺子(docs/设计-活人感标准与前端差距-2026-10-02 第一节):他一开口她就得停、成功率 >90%,
 * 但**「嗯 / 对 / 好」这类应声不算打断,不能停**。今天她一听见一声「嗯」就把话掐在半句上。
 *
 * ## 框架给的口子只有一个,而且是反着用的(查实见下)
 *
 * `@livekit/agents@1.9.0` 的打断闸全在 `turnHandling.interruption` 这一格里:
 * `enabled` / `mode`(adaptive 要 LiveKit 云端推理)/ `minDuration`(毫秒)/ `minWords` /
 * `falseInterruptionTimeout` / `resumeFalseInterruption` / `backchannelBoundary`
 * (`dist/voice/turn_config/interruption.d.ts`)。**没有自定义分词器那一格**,
 * 上游自己也写明了这件事:
 *
 * > The CJK/Thai alternation emulates Python's `split_words(..., split_character=True)`, which
 * > splits those scripts per character; **the JS tokenizer does not expose that option.**
 * > —— `dist/voice/agent_activity.d.ts` 第 29–30 行
 *
 * 而 `minWords` 数的是 `splitWords()`(`/\S+/g`,按空白切,`dist/tokenize/basic/word.js`):
 * 中文「等一下」与一声「嗯」在这把尺子下**都是一个词**,分不开 —— 所以它不能按本意用。
 *
 * **但它可以当一个开关用**(这就是这一卡走的路)。框架读它的只有两处,
 * 而且两处都**只在她正说着话的时候**才生效(`dist/voice/agent_activity.js`):
 *
 *   · 第 1383–1389 行 `interruptByAudioActivity()`:词数不够 → 当场 `return`,**不掐**;
 *   · 第 1698–1711 行 `onEndOfTurn()`:`this._currentSpeech && !interrupted` 且词数不够
 *     → `cancelPreemptiveGeneration()` + 回 `false`,**这一回合整个不要**(不调模型、不进上下文)。
 *
 * 把 {@link WORD_GATE_SHUT} 填进去,这两处就恒为真:她说话时框架**自己一次都不掐、也不开新回合**,
 * 判断整个归我们。该停的时候我们自己调 `session.interrupt()`(把 `_currentSpeech.interrupted` 置上)——
 * 上面两道门立刻让路,于是**停**,而且这一回合照旧提交、照旧回答。
 *
 * 三样白得的好处(所以没有去自己接端点检测、也没动 `enabled`):
 *   ① `interruption.enabled` 保持 `true` → 每一句发言照旧 `allowInterruptions`,
 *      于是 `interrupt()` **不用 `force`** —— 不清发言队列、不取消在跑的工具步
 *      (`force:true` 会 `task.cancel()` 一片,见 `agent_activity.js` 第 2020–2027 行);
 *   ② `discardAudioIfUninterruptible` 那一条也不用动:它只在「这一句不许打断」时丢麦克风音频
 *      (第 1084–1086 行)—— 我们没把发言设成不许打断,所以**她说话时我们照旧听得见他**。
 *      反过来走 `enabled:false` 那条路就必须同时关掉它,否则正是「她一开口就聋」;
 *   ③ 她**手上没有话**的时候一个字都没变:两道门都要求 `_currentSpeech` 活着。
 *      所以他那一声「好」在她说完之后仍然是**一句答复**,照旧进回合(用例钉着)。
 *
 * ## ⚠️ 「她手上有话」不等于「她正在出声」(踩到过的那一脚)
 *
 * 框架那两道门认的是 `_currentSpeech` —— 它在**发言排进队那一刻**就挂上了
 * (`agent_activity.js` 第 1827 行 `this._currentSpeech = speechHandle`,
 * 第 1842 行播完才摘),而那时候模型的第一个字还没出来(act 那条路中位 8.2 秒)。
 * 所以 {@link BargeIn.agentHasFloor} 收的是 `speaking` **与 `thinking` 两种状态**,
 * 不是只有 `speaking`:只认 `speaking` 的话,他在那八秒里说的一整句会被框架
 * 当成「她手上有话、词数不够」整段丢掉 —— 他说了一句话,一个回音都没有,
 * 比掐断更吓人。`listening` / 闲下来才算她手上没话。
 *
 * ## 判法(一处:{@link judgeBargeIn})
 *
 *   · 整段只是一声应声 → `ack`:**不停**。判子就是 backchannel.ts 的
 *     {@link makeIsBackchannelOnly}(10-02 那份词表,全仓只有那一份);
 *   · 说定了的那一句不是应声 → `stop`:一个字也算(「停」);
 *   · 中间结果:按**字数**数到 {@link BARGE_IN_MIN_CHARS} 个才停 —— 一个字先等着,
 *     因为「嗯」的第一帧和「等一下」的第一帧长得一样;
 *   · 一个字都没识别出来、而他连着说了 {@link BARGE_IN_DEADLINE_MS} → **照样停**。
 *     这一条是兜底:ASR 哑了 / 他说的是方言,也绝不能出现「怎么都掐不住她」。
 *     凭据是时长本身 —— 预合成那四声应声量到的是 205–534ms(交接-1002 第一节),
 *     没有人把一声「嗯」拖满一秒二。
 *
 * 纯的:不认识 LiveKit、不认识房间。时钟与计时器都注入。
 */
import { isBackchannelOnly } from './backchannel.ts'

/**
 * 把框架那道词数闸**关上**用的数(填给 `turnHandling.interruption.minWords`)。
 *
 * 为什么不是「某个大一点的数」:框架比的是 `splitWords(text).length < minWords`,
 * 而他一句话里的空白分段数没有上界(中英混排、报一串号码)。取安全整数的上限,
 * 这个比较就**恒为真**,判断整个落在 {@link judgeBargeIn} 这一处 —— 不留一条
 * 「说得够长就又被框架掐了」的暗路。
 */
export const WORD_GATE_SHUT = Number.MAX_SAFE_INTEGER

/** 中间结果里数到几个字才算「他要说话」。 */
export const BARGE_IN_MIN_CHARS = 2

/** 一个字都没识别出来,连着说这么久也照样停(兜底,理由见文件头)。 */
export const BARGE_IN_DEADLINE_MS = 1200

/** 最多攒几段「被丢掉的应声」({@link BargeIn.droppedAcks})。见那一处的注释。 */
export const DROPPED_ACKS_MAX = 8

/** 中日韩的字(含扩展区与兼容区)。一个字算一个词。 */
const CJK = /[㐀-䶿一-鿿豈-﫿぀-ヿ]/
/** 不算字的:空白与中西标点。 */
const NOT_A_WORD = /[\s,.!?;:'"()[\]{}<>/\\|@#$%^&*+=~`、，。！？；：…～—－·「」『』（）《》【】]/

/**
 * 一句话里有**几个说出来的字**。中文一个字算一个,西文连着的一串算一个,标点与空白不算。
 *
 * 这就是「按字数不按词数」那一句的落点 —— 框架那把 `splitWords` 只会按空白切
 * (于是中文一整句算一个),上游明说它不给 `split_character` 那一格(见文件头)。
 */
export function countSpokenChars(text: string): number {
  let count = 0
  let inLatin = false
  for (const one of (text ?? '')) {
    if (NOT_A_WORD.test(one)) { inLatin = false; continue }
    if (CJK.test(one)) { count += 1; inLatin = false; continue }
    // 西文 / 数字:连着的一串算一个词(和框架同口径)。
    if (!inLatin) count += 1
    inLatin = true
  }
  return count
}

/**
 * **把开头那几段应声从交给模型的文本里剥掉**(2026-10-03,维护者拍板「抹掉」;
 * 来处是交接-1003-中文打断判法第六节第 2 条那条待拍板)。
 *
 * ## 为什么要剥
 *
 * 判成 `ack` 的那一段工人这边**整段不进回合**(agent.ts 那一处 `return`),可框架那一头
 * 仍然把它攒着:`onEndOfTurn` 回 `false` 时 `audioTranscript` 不清
 * (`dist/voice/audio_recognition.js` 第 1266–1275 行),而下一句最终转写照旧
 * `audioTranscript += ' ' + transcript` 再 `trimStart()`(第 862–863 行)。
 * 于是真交给模型的那份文本是「嗯 帮我把这条派给 Codex」——
 * 工人日志里的「他说」是干净的,模型看见的不是。
 *
 * 上游**没有**「这一段别攒」的口子(整格口子表见文件头与交接-1003 第一节),
 * 所以剥在我们这一侧的回合入口(`Agent.onUserTurnCompleted`,调模型与进对话历史之前)。
 *
 * ## 两条分寸
 *
 *   · **只剥判定命中的那一截**:`dropped` 是 {@link BargeIn} 真丢掉的那几段原文
 *     (只记 final —— 框架也只把 final 攒进 `audioTranscript`),按顺序从开头往下剥。
 *     不在开头的不剥(不猜它去哪儿了);一段对不上就当场停手(后面那几段也不再剥);
 *   · **剥到一个字都不剩就退回原文**。「嗯」单独那一段在她手上还有话时压根不是一个回合,
 *     可她手上的话一说完,框架那道门就让路、把攒着的那一声「嗯」提交上来 ——
 *     那时候它是**他的一句答复**(与 turnRoute.ts 的 `ANSWER_WORDS` 同一条口径),
 *     交一句空话上去才是错的。
 */
export function stripLeadingAcks(
  text: string,
  dropped: readonly string[],
): { text: string, stripped: readonly string[] } {
  const stripped: string[] = []
  let rest = text ?? ''
  for (const one of dropped) {
    const ack = one.trim()
    if (ack === '') continue
    if (!rest.startsWith(ack)) break
    rest = rest.slice(ack.length).replace(/^\s+/, '')
    stripped.push(ack)
  }
  // 剥完什么都不剩:原样交上去(见文件头第二条分寸)。
  if (rest.trim() === '') return { text: text ?? '', stripped: [] }
  return { text: rest, stripped }
}

/** 这一段话该怎么办。 */
export type BargeInVerdict =
  /** 真打断:当场把她掐住。 */
  | 'stop'
  /** 只是一声应声:不掐她,这一段也不进回合。 */
  | 'ack'
  /** 还看不出来(字太少 / 一个字都没识别出来):先不动。 */
  | 'wait'
  /** 她手上没话:这是正常的一回合,一个字都不特殊对待。 */
  | 'turn'

export interface BargeInJudgeOptions {
  /** 这一段是说定了的(final)还是中间结果。 */
  isFinal: boolean
  /** 数到几个字才停(中间结果才用得上)。缺省 {@link BARGE_IN_MIN_CHARS}。 */
  minChars?: number
  /** 「整段只是一声应声吗」。缺省 {@link isBackchannelOnly}(10-02 那份词表)。 */
  isAck?: (text: string) => boolean
}

/**
 * **她手上有话的时候**,他这一段话算不算打断。判法只有这一处。
 *
 * 顺序是死的:**先看是不是应声,再看字够不够**。倒过来的话「好的」两个字就够了,
 * 一声应声会被当成打断 —— 那正是这张卡要治的那个毛病。
 */
export function judgeBargeIn(text: string, options: BargeInJudgeOptions): 'stop' | 'ack' | 'wait' {
  const said = (text ?? '').trim()
  if (said === '') return 'wait'
  const isAck = options.isAck ?? isBackchannelOnly
  if (isAck(said)) return 'ack'
  if (options.isFinal) return 'stop'
  return countSpokenChars(said) >= (options.minChars ?? BARGE_IN_MIN_CHARS) ? 'stop' : 'wait'
}

export interface BargeInOptions {
  /** 真打断:把她掐住(接 `session.interrupt()`)。`why` 只进日志。 */
  stop: (why: string) => void
  now?: () => number
  /** 定时器(测试注入)。回一个「取消它」的函数。 */
  setTimer?: (fn: () => void, ms: number) => () => void
  minChars?: number
  deadlineMs?: number
  isAck?: (text: string) => boolean
  log?: (line: string) => void
}

/**
 * 打断那道闸。接线(agent.ts):
 *   · `agent_state_changed`:`speaking` / `thinking` → {@link agentHasFloor}(true),
 *     回到 `listening` / 闲下来 → false(**为什么 thinking 也算,见文件头那段⚠️**);
 *   · `user_state_changed → speaking` / 别的 → {@link userSpeaking};
 *   · 每条转写(中间结果与 final 都要)→ {@link heard},**按它的回值决定这一段进不进回合**。
 */
export class BargeIn {
  readonly #options: BargeInOptions
  readonly #now: () => number
  readonly #setTimer: (fn: () => void, ms: number) => () => void
  readonly #minChars: number
  readonly #deadlineMs: number
  readonly #isAck: (text: string) => boolean
  #cancel: (() => void) | undefined
  /** 她这会儿手上有没有话(排上队的、在想的、在念的都算 —— 见文件头那段⚠️)。 */
  #agent = false
  /** 他这会儿正说着话吗。 */
  #user = false
  /** 他这一段里已经掐过了没有。 */
  #stopped = false
  /** 他这一段开口的那一刻(0 = 还没开口)。量「他开口到她停」那几毫秒用的就是它。 */
  #userAt = 0
  /** 判成应声、被丢掉的那几段原文(见 {@link droppedAcks})。 */
  readonly #dropped: string[] = []

  constructor(options: BargeInOptions) {
    this.#options = options
    this.#now = options.now ?? (() => Date.now())
    this.#setTimer = options.setTimer ?? ((fn, ms) => {
      const handle = setTimeout(fn, ms)
      handle.unref?.()
      return () => clearTimeout(handle)
    })
    this.#minChars = options.minChars ?? BARGE_IN_MIN_CHARS
    this.#deadlineMs = options.deadlineMs ?? BARGE_IN_DEADLINE_MS
    this.#isAck = options.isAck ?? isBackchannelOnly
  }

  /** 他这一段里掐过了没有(日志与用例用)。 */
  get stopped(): boolean { return this.#stopped }

  /**
   * 判成应声、**被丢掉**的那几段原文(按听见的顺序)。
   *
   * 框架那一头照旧把它们攒在 `audioTranscript` 里(文件头那条),所以回合提交前要照着
   * 这一份把开头剥干净({@link stripLeadingAcks})。**只记 final**:框架也只把 final
   * 攒进去,中间结果那几条它自己会清掉。
   */
  get droppedAcks(): readonly string[] { return [...this.#dropped] }

  /** 取走这一份并清空(一回合算一次账,接在 `onUserTurnCompleted` 那一处)。 */
  takeDroppedAcks(): readonly string[] {
    const out = [...this.#dropped]
    this.#dropped.length = 0
    return out
  }

  /**
   * 她手上有话 / 没话了(`speaking` 与 `thinking` 都算有,见文件头那段⚠️)。
   * 没话了就没有东西可掐,兜底那只手当场收回。
   */
  agentHasFloor(on: boolean): void {
    if (on === this.#agent) return
    this.#agent = on
    if (!on) { this.#clear(); this.#stopped = false }
  }

  /**
   * 他开口 / 停口。
   *
   * **只在「她手上有话、他才开口」这一下挂兜底计时器** —— 反过来(他先说、她后接手)
   * 不挂:他那一段早就在识别了,判法有字可依,而那时挂一只手等于她刚开口就被掐。
   */
  userSpeaking(on: boolean): void {
    if (on === this.#user) return
    this.#user = on
    if (!on) { this.#clear(); this.#stopped = false; this.#userAt = 0; return }
    this.#userAt = this.#now()
    if (this.#agent) this.#arm()
  }

  /**
   * 听见他说的一段(中间结果或 final)。
   *
   * 回 `ack` 的那一段**不进回合** —— 框架那边本来就会把它丢掉(文件头第 1698 行那道门),
   * 工人这边也要跟着丢,否则一声「嗯」照旧去跑分流、先应那一句、记一行「他说」。
   *
   * 丢掉的那一段(final)**记在 {@link droppedAcks} 里** —— 框架攒着它、回合提交时会把它
   * 接在下一句前面一起交给模型,所以回合入口要照这一份剥掉开头(2026-10-03,维护者拍板「抹掉」)。
   */
  heard(text: string, isFinal: boolean): BargeInVerdict {
    if (!this.#agent) return 'turn'
    if (this.#stopped) return 'stop'
    const verdict = judgeBargeIn(text, { isFinal, minChars: this.#minChars, isAck: this.#isAck })
    if (verdict === 'stop') this.#fire(`他说的是「${text.trim().slice(0, 20)}」`)
    if (verdict === 'ack' && isFinal) {
      this.#dropped.push(text)
      // 上限只为「万一没人来取」:发言队列正在排空(挂断那几拍)时框架自己就回 true、
      // 不走 `onUserTurnCompleted`,这一份就没人清。剥是**前缀比对**,对不上一个字都不动,
      // 所以留着不会剥错 —— 但也不该无限涨。
      while (this.#dropped.length > DROPPED_ACKS_MAX) this.#dropped.shift()
    }
    return verdict
  }

  #clear(): void {
    this.#cancel?.()
    this.#cancel = undefined
  }

  #arm(): void {
    this.#clear()
    this.#cancel = this.#setTimer(() => {
      this.#cancel = undefined
      if (!this.#agent || !this.#user || this.#stopped) return
      this.#fire(`他连着说了 ${this.#deadlineMs}ms,一个字都没识别出来`)
    }, this.#deadlineMs)
  }

  /**
   * 掐。`why` 里带上**他开口到这一下隔了多少毫秒** —— 业界那把尺子(真打断 ≤300ms 停)
   * 在真机上只有这一个数可量:日志里一行一行捞出来就是它,不用再加一条接口。
   */
  #fire(why: string): void {
    if (this.#stopped) return
    this.#stopped = true
    this.#clear()
    const since = this.#userAt === 0 ? undefined : this.#now() - this.#userAt
    const line = since === undefined ? why : `他开口 ${since}ms 之后,${why}`
    this.#options.log?.(`[channel-worker] 真打断,把她掐住(${line})`)
    this.#options.stop(line)
  }
}
