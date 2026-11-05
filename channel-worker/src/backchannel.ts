/**
 * **他说话时她的应声** —— 「嗯」「嗯哼」「对」(2026-10-02,卡「声音与形象跟着话走」第 5 件)。
 *
 * (这个文件里 **他** = 举着听筒的那个人,**她** = 事务官 —— 与隔壁 filler.ts / agent.ts 同一个口径。
 * 卡上写的「她说话时」说的是**人在说话**的那一侧,就是这里的「他」。)
 *
 * ## 为什么要它
 *
 * 业界量活人感的那几条里有一条是**听的人要出声**(livekit-backchannel 的口径,
 * 见 docs/设计-活人感标准与前端差距-2026-10-02 第一节):他连着说两三秒而对面一声不出,
 * 听着就像电话断了。我们现在**一声都没有** —— 垫场那七句只在他说完之后才垫。
 *
 * ## 阈值(照 livekit-backchannel,卡里点名的那四个数)
 *
 *   · 他连续说 ≥ {@link ACK_AFTER_MS}(2.4 秒);
 *   · 而且**还没到句尾**(最近那段中间结果不以句末标点收尾);
 *   · 距上一声 ≥ {@link ACK_GAP_MS}(4.5 秒);
 *   · 一轮最多 {@link ACK_MAX_PER_TURN}(1 次;2026-10-12 从 3 次降下来,维护者嫌电话啰嗦)。
 *
 * ## 为什么阈值在工人、声音在手机
 *
 * 和垫场同一条账(filler.ts 的文件头):`session.say()` 排的是和回答同一条发言队列,
 * 插不进去;而这一声**要在他还说着的时候**出来,比垫场更急。所以工人只广播一条
 * 极小的信号(`{type:'backchannel', round, at, line?}`),手机拿**预先合成好、打在包里**
 * 的那几声本地放 —— 一分钱合成费都不花,也不占火山一次并发。
 *
 * ## 两条纪律
 *
 *   ① **他一停就不发**。计时器挂在「他正说着」这件事上,`userSpeaking(false)` 当场撤掉。
 *      信号已经在路上的那一下由手机那头再挡一道(他停了就不放)。
 *   ② **不对着一声应声再应一声**。他说的本来就只是「嗯 / 对 / 好」({@link isBackchannelOnly}),
 *      那不是一段话,应回去就成了互相哼。
 *
 * ## 顺带:打断那一条的口径(barge-in)
 *
 * {@link isBackchannelOnly} 同时是「这一句算不算打断」的判据:业界的要求是
 * **「嗯 / 对 / 好」不算打断**(hamming.ai、voice-agent-barge-in-tests),真打断要 ≤300ms 停。
 * 回归用例在 tests/barge-in-1002.test.ts。
 *
 * ⚠️ **框架自带的那道闸对中文没用**:`@livekit/agents` 的
 * `turnHandling.interruption.minWords` 数的是 `splitWords()`(`/\S+/g`,按空白切),
 * 中文一整句也只算**一个词** —— 设成 2 会把他每一次真打断都挡掉。
 * 2026-10-03(决策记录 ④甲)把那道闸**关上**、判法整个接到我们这边:
 * 见 bargeIn.ts。那一头判「这是不是只一声应声」用的就是这个文件里的
 * {@link ACK_WORDS} 与 {@link makeIsBackchannelOnly} —— **词表只有这一份**。
 *
 * 纯的:不认识 LiveKit、不认识房间。计时器与时钟都注入。
 */

/** 他连续说多久才值得应一声。 */
export const ACK_AFTER_MS = 2400

/** 两声之间至少隔多久。 */
export const ACK_GAP_MS = 4500

/** 一轮最多应几声。 */
export const ACK_MAX_PER_TURN = 1

/**
 * 那几声的 id。**与 butler-app/src/call/fillerLines.json 里 `kind:'ack'` 那几条逐字相同**
 * (工人从来不念这几声,它只是在信号里点名这一次该用哪一条 —— 好让「连着两声不一样」
 * 有一个说了算的地方;认不得这一格的一端照旧自己挑)。
 */
export const ACK_LINE_IDS: readonly string[] = ['ack-1', 'ack-2', 'ack-3', 'ack-4']

/**
 * 只是一声应声、不是一段话。**这是全仓唯一一份应声词表**
 * (应声那一头与打断那一头吃的都是它,有用例扫 `src/` 钉着别处没有第二份)。
 *
 * **只收真见过的那几个**(Air 诊断包 488 回合里他说过的):不做近义词推断 ——
 * 把一句真话误判成应声,代价是她不停下来听他说,那比多应一声严重得多。
 *
 * 运营那层要加几个她常说的(「嗯呐」「好嘞」),走配置
 * `WORKBENCH_CHANNEL_ACK_WORDS`(见 {@link ackWordsWith} 与 config.ts),**不改这里**。
 */
export const ACK_WORDS: readonly string[] = [
  '嗯', '嗯嗯', '嗯哼', '哼',
  '对', '对对', '对的', '对啊',
  '好', '好的', '好吧', '好好',
  '是', '是的', '是啊',
  '哦', '噢', '欧',
  'ok', 'okay', '行', '行吧',
]

/** 判断之前先把标点与空白去掉(「嗯。」「嗯，」都是同一声)。 */
const TRIM_PUNCT = /[\s,.!?;:、，。！？；：…~～\-—]+/g

/**
 * 她加进来的那几个词(配置)。`add` = 添在 {@link ACK_WORDS} 后面,`replace` = 整张换掉。
 * 解析在 config.ts 的 `ackWordsOf`;**合成在这里**,免得「缺省那份 + 她那几个」
 * 在两个文件里各拼一次。
 */
export interface AckWordsOverride {
  mode: 'add' | 'replace'
  words: readonly string[]
}

/** 这一跑真正用的那张表。不配就是缺省那份,一个字不差。 */
export function ackWordsWith(override: AckWordsOverride | undefined): readonly string[] {
  if (override === undefined || override.words.length === 0) return [...ACK_WORDS]
  return override.mode === 'replace' ? [...override.words] : [...ACK_WORDS, ...override.words]
}

/**
 * 按一张表造一把「这一段整段就只是一声应声吗」的判子。**判法只有这一份实现**
 * ({@link isBackchannelOnly} 就是拿缺省那张表造出来的那一把)。
 *
 * 也收「嗯嗯嗯」「对对对」这种拖长的(同一个字重复),因为那和「嗯」是同一件事。
 *
 * 字数上限**跟着表走**(至少 4 个字,与 10-02 那一版逐字相同):
 * 表里最长那个词有多长就收到多长 —— 否则运营加一个「好的好的呀」进去,
 * 加了也判不出来,那种「配了不生效」最费时间。
 */
export function makeIsBackchannelOnly(words: readonly string[]): (text: string) => boolean {
  const set = new Set(words.map(one => one.toLowerCase()))
  const cap = Math.max(4, ...words.map(one => one.length))
  return (text: string): boolean => {
    const said = (text ?? '').replace(TRIM_PUNCT, '').toLowerCase()
    if (said === '' || said.length > cap) return false
    if (set.has(said)) return true
    // 一个字重复到底(嗯嗯嗯 / 对对对 / 好好好)。
    const first = said[0]!
    if ([...said].every(one => one === first) && set.has(first)) return true
    return false
  }
}

/** 这一段话**整段**就只是一声应声吗(他说的那一段)。缺省那张表那一把。 */
export const isBackchannelOnly: (text: string) => boolean = makeIsBackchannelOnly(ACK_WORDS)

/** 这一句算不算**真打断**(barge-in)。应声不算;空的也不算。 */
export function isRealInterruption(text: string): boolean {
  const said = (text ?? '').trim()
  if (said === '') return false
  return !isBackchannelOnly(said)
}

/** 句末标点。到了句尾就别插话 —— 那是他说完了,该轮到她答。 */
const SENTENCE_END = /[。!?！?；;…]\s*$/

/** 最近这段中间结果到句尾了没有。 */
export function endsSentence(text: string): boolean {
  return SENTENCE_END.test((text ?? '').trim())
}

/** 工人 → 房间的那条信号。**故意小**:它和字幕、垫场信号共用一条通道。 */
export interface BackchannelSignal {
  type: 'backchannel'
  /** 第几轮(与垫场信号同一个轮号)。手机据此分辨批次。 */
  round: number
  /** 工人发它的那一刻(毫秒)。只用来量延迟、写日志。 */
  at: number
  /** 这一次点名放哪一声(轮着来,见 {@link ACK_LINE_IDS})。认不得就忽略,自己挑。 */
  line?: string
}

/** 信号 → 一行 JSON(走 `wb.rpc`,和字幕、垫场同一条通道)。 */
export function encodeBackchannelSignal(signal: BackchannelSignal): string {
  return JSON.stringify(signal)
}

export interface BackchannelOptions {
  send: (signal: BackchannelSignal) => void
  /** 这会儿第几轮(接 FillerSignaller 的 `round`)。 */
  round: () => number
  now?: () => number
  /** 定时器(测试注入)。回一个「取消它」的函数。 */
  setTimer?: (fn: () => void, ms: number) => () => void
  afterMs?: number
  gapMs?: number
  maxPerTurn?: number
  /** 轮着点名的那几声。缺省 {@link ACK_LINE_IDS};空数组 = 不点名。 */
  lines?: readonly string[]
  /**
   * 「这一段整段只是一声应声吗」那把判子。缺省 {@link isBackchannelOnly}。
   * 接出来只为一件事:运营那层改过词表时,**应声这一头与打断那一头吃的是同一把**
   * (agent.ts 里造一次,两边都传这一把)。
   */
  isAck?: (text: string) => boolean
  log?: (line: string) => void
}

/**
 * 他说话时那几声。接线(agent.ts):
 *   · `user_state_changed → speaking` / 回到别的状态 → {@link userSpeaking};
 *   · 每条**中间结果**(`user_input_transcribed`,`isFinal:false`)→ {@link heard};
 *   · 这一句说定了(final)→ {@link heard} + {@link endTurn}。
 */
export class Backchannel {
  readonly #options: BackchannelOptions
  readonly #now: () => number
  readonly #setTimer: (fn: () => void, ms: number) => () => void
  readonly #afterMs: number
  readonly #gapMs: number
  readonly #maxPerTurn: number
  readonly #lines: readonly string[]
  readonly #isAck: (text: string) => boolean
  #cancel: (() => void) | undefined
  #speaking = false
  /** 最近一段中间结果(判「到没到句尾」「是不是只有一声嗯」)。 */
  #latest = ''
  #sentThisTurn = 0
  #lastAt = 0
  #lineAt = 0

  constructor(options: BackchannelOptions) {
    this.#options = options
    this.#now = options.now ?? (() => Date.now())
    this.#setTimer = options.setTimer ?? ((fn, ms) => {
      const handle = setTimeout(fn, ms)
      handle.unref?.()
      return () => clearTimeout(handle)
    })
    this.#afterMs = options.afterMs ?? ACK_AFTER_MS
    this.#gapMs = options.gapMs ?? ACK_GAP_MS
    this.#maxPerTurn = options.maxPerTurn ?? ACK_MAX_PER_TURN
    this.#lines = options.lines ?? ACK_LINE_IDS
    this.#isAck = options.isAck ?? isBackchannelOnly
  }

  /** 这一轮已经应了几声(日志与用例用)。 */
  get sent(): number { return this.#sentThisTurn }

  /** 他开口 / 停口。**停口当场撤掉计时器**(纪律 ①)。 */
  userSpeaking(on: boolean): void {
    if (on === this.#speaking) return
    this.#speaking = on
    if (!on) { this.#clear(); return }
    this.#latest = ''
    this.#arm(this.#afterMs)
  }

  /** 听见他说的一段(中间结果或定稿)。只记最近这一段,不攒。 */
  heard(text: string): void {
    this.#latest = (text ?? '').trim()
  }

  /** 这一回合完了:计数归零,下一回合重新算三声。 */
  endTurn(): void {
    this.#clear()
    this.#speaking = false
    this.#latest = ''
    this.#sentThisTurn = 0
  }

  #clear(): void {
    this.#cancel?.()
    this.#cancel = undefined
  }

  #arm(ms: number): void {
    this.#clear()
    this.#cancel = this.#setTimer(() => {
      this.#cancel = undefined
      this.#fire()
    }, ms)
  }

  #fire(): void {
    if (!this.#speaking) return
    const why = this.#blockedBy()
    if (why !== undefined) {
      this.#options.log?.(`[channel-worker] 这会儿不应声(${why})`)
      // 没应成也要接着看:他可能正说到句尾、下一段又接着说。
      this.#arm(this.#afterMs)
      return
    }
    const line = this.#takeLine()
    this.#sentThisTurn += 1
    this.#lastAt = this.#now()
    this.#options.send({
      type: 'backchannel',
      round: this.#options.round(),
      at: this.#lastAt,
      ...(line === undefined ? {} : { line }),
    })
    this.#options.log?.(`[channel-worker] 应了一声(这一轮第 ${this.#sentThisTurn} 声${line === undefined ? '' : `,点名 ${line}`})`)
    if (this.#sentThisTurn >= this.#maxPerTurn) return
    this.#arm(this.#gapMs)
  }

  /** 这会儿为什么不该应。能应就回 undefined。 */
  #blockedBy(): string | undefined {
    if (this.#sentThisTurn >= this.#maxPerTurn) return `这一轮已经应了 ${this.#maxPerTurn} 声`
    if (this.#lastAt !== 0 && this.#now() - this.#lastAt < this.#gapMs) return '距上一声不到间隔'
    if (endsSentence(this.#latest)) return '他这一句到句尾了'
    if (this.#latest !== '' && this.#isAck(this.#latest)) return '他说的本来就只是一声应声'
    return undefined
  }

  #takeLine(): string | undefined {
    if (this.#lines.length === 0) return undefined
    const line = this.#lines[this.#lineAt % this.#lines.length]
    this.#lineAt = (this.#lineAt + 1) % this.#lines.length
    return line
  }
}
