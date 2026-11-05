/**
 * 按中文断句(2026-09-18)。
 *
 * 为什么要自己写:框架自带的 `tokenize.basic.SentenceTokenizer` 是按英文断的 —— 它认的是
 * `. ! ?` 加空格,**中文的句号一个都不认**。本机实测:把「你好,这是第一句。这是第二句。」
 * 交给它,回来的是**一整块**。于是整段话要合成完才有第一个音,首字延迟 = 整段的合成时间。
 * Ben 09-18 说的「开场白等了十秒」里,有两秒多是这么来的(开场白是一百字的一整句)。
 *
 * 断在哪:句末标点(。!?;…)后面一定断;够长了(`SOFT_BREAK_AT`)在逗号、顿号、冒号后面也断 ——
 * 一句话说到逗号处停一下是正常的语流,而多断一刀就少等几百毫秒。
 * 太短的碎片(`MIN_PIECE`)并进后面一块:「好。」单独合成一次不值得,还会听出接缝。
 *
 * 纯函数,不认识 LiveKit;接进框架的那一小层在文件末尾。
 */
import { tokenize } from '@livekit/agents'

/** 句末标点:这些后面一定断。 */
const HARD_ENDS = new Set(['。', '!', '?', ';', '!', '?', ';', '…', '\n'])

/** 软断点:够长了才在这些后面断。 */
const SOFT_ENDS = new Set([',', ',', '、', ':', ':', '——'])

/** 攒到这么多字之后,遇到软断点就断。太小会把一句话切碎,太大等于没断。 */
export const SOFT_BREAK_AT = 18

/**
 * **一回合的第一块**用的软断点门槛(2026-09-23)。比 {@link SOFT_BREAK_AT} 小。
 *
 * 为什么只对第一块小:等待路径上只有它。第一块出声之后,后面几块的合成全藏在前一块的播放里
 * (gate.ts 那段账),断得长一点反而更连贯。而第一块每短一个字,
 * 他就早听见一点 —— 老路(非流式)上合成时间大体随字数走,18 字砍到 10 字是实打实的几百毫秒。
 *
 * **代价说清楚**:多切一刀 = 多一次火山合成(多一点钱),而且第一块与第二块之间多一道接缝。
 * 但这一刀只落在**逗号/顿号/冒号**上 —— 那本来就是人换气的地方,接缝落在这儿最不显。
 * 不想要就 `WORKBENCH_CHANNEL_TTS_FIRST_BREAK=18`(与 SOFT_BREAK_AT 一样 = 逐字回到从前)。
 */
export const FIRST_SOFT_BREAK_AT = 10

/** 比这还短的一块并进后面那块(单独合成一次不值得,也会听出接缝)。 */
export const MIN_PIECE = 6

/**
 * 一段话 → 几句。空白与标点**原样留在句子里**(TTS 要靠它们决定语气与停顿)。
 * 一个字都不丢:把结果接起来等于原文去掉首尾空白。
 */
export function splitChineseSentences(text: string, softBreakAt: number = SOFT_BREAK_AT): string[] {
  const source = text.trim()
  if (source === '') return []
  const threshold = Number.isFinite(softBreakAt) && softBreakAt >= 1 ? Math.floor(softBreakAt) : SOFT_BREAK_AT
  const pieces: string[] = []
  let current = ''
  for (const char of source) {
    current += char
    const hard = HARD_ENDS.has(char)
    const soft = SOFT_ENDS.has(char) && current.trim().length >= threshold
    if (!hard && !soft) continue
    const piece = current.trim()
    if (piece !== '') pieces.push(piece)
    current = ''
  }
  const tail = current.trim()
  if (tail !== '') pieces.push(tail)

  // 太短的并进**后面**那块:「好。」后面跟着正文时,合起来念更自然;末尾那块就并进前面。
  const merged: string[] = []
  let pending = ''
  for (const piece of pieces) {
    const next = pending === '' ? piece : `${pending}${piece}`
    if (next.length < MIN_PIECE) { pending = next; continue }
    merged.push(next)
    pending = ''
  }
  if (pending !== '') {
    const last = merged.pop()
    merged.push(last === undefined ? pending : `${last}${pending}`)
  }
  return merged
}

/**
 * 接进框架的那一层:`tts.StreamAdapter(火山那份, 这个)` —— 模型吐一句就合一句、说一句,
 * 首字延迟等于**第一小块**的合成时间,不是整段的。
 */
export interface ChineseSentenceTokenizerOptions {
  /**
   * 软断点的门槛,缺省 {@link SOFT_BREAK_AT}。调小 = 第一句更短 = 更早出声,
   * 代价是断得碎、接缝多。接线在 agent.ts,开关是 `WORKBENCH_CHANNEL_TTS_SOFT_BREAK`。
   */
  softBreakAt?: number
  /**
   * **一回合第一块**的软断点门槛,缺省 {@link FIRST_SOFT_BREAK_AT}。
   * 设成与 `softBreakAt` 一样 = 没有「第一块特别短」这回事。
   * 开关:`WORKBENCH_CHANNEL_TTS_FIRST_BREAK`。
   */
  firstSoftBreakAt?: number
  /**
   * **模型的第一段字到嘴边了**(2026-09-23,给计时用)。
   *
   * 为什么钩在这里:框架把模型吐出来的每一小段 `pushText` 进这条流,所以第一次
   * pushText 就是「模型首字」在我们这条链路上**唯一**能拿到的那一刻 ——
   * 不必去包 LLM,也不必猜。一条流只叫一次;缺席时这一层等于不存在。
   *
   * **带着那一段字**(2026-09-23 加的参数):第一次 pushText 里有多少字是一条要紧的证据 ——
   * 一个字就是真流式,一整句就说明这条链路上有人在攒 buffer(中转、反代、SDK,总有一个)。
   * 真机第一批里 `llm_first → tts_request` 一次是 189ms、一次是 10ms,10ms 那次很可疑。
   */
  onFirstText?: (text: string) => void
}

export class ChineseSentenceTokenizer extends tokenize.SentenceTokenizer {
  readonly #options: ChineseSentenceTokenizerOptions

  constructor(options: ChineseSentenceTokenizerOptions = {}) {
    super()
    this.#options = options
  }

  tokenize(text: string): string[] {
    return splitChineseSentences(text, this.#options.softBreakAt ?? SOFT_BREAK_AT)
  }

  stream(): tokenize.SentenceStream {
    // minTokenLength = MIN_PIECE:比它短的由缓冲层再并一次(和上面那条规矩同一个门槛)。
    // minContextLength = 1:不为了「等更多上下文」压着不发 —— 这条链路上早一点出声就是早一点。
    const threshold = this.#options.softBreakAt ?? SOFT_BREAK_AT
    const firstThreshold = this.#options.firstSoftBreakAt ?? FIRST_SOFT_BREAK_AT
    const stream = new tokenize.BufferedSentenceStream(
      firstChunkSplitter(threshold, firstThreshold), MIN_PIECE, 1,
    )
    const onFirstText = this.#options.onFirstText
    if (onFirstText === undefined) return stream
    return new FirstTextStream(stream, onFirstText)
  }
}

/**
 * 「第一块短一点」的那把刀(2026-09-23)。
 *
 * 框架的 `BufferedSentenceStream` 会拿**整个还没切完的缓冲**反复调切分函数,
 * 一旦切出两块以上就把第一块发出去。所以这里的状态只有一条:
 * **只要切出过两块以上,就说明第一块已经出门了**,从此换回平时的门槛。
 *
 * 这是个近似:切出两块、而第一块短到被缓冲层又并了一次时,它会提前换挡。
 * 那种情况下第一块本来就已经很短,换不换挡都不影响「早点出声」这件事 ——
 * 为这点精确度去改框架的缓冲层不值得。
 *
 * **一条流一个**(一条流 = 一回合她说的一段话)。
 */
export function firstChunkSplitter(softBreakAt: number, firstSoftBreakAt: number): (text: string) => string[] {
  let first = true
  return (text: string): string[] => {
    const pieces = splitChineseSentences(text, first ? firstSoftBreakAt : softBreakAt)
    if (pieces.length > 1) first = false
    return pieces
  }
}

/**
 * 套在句子流外面的一层薄壳:**只为了知道第一段字什么时候来的**。
 * 一个字都不改、一个字都不吞 —— 除了第一次 pushText 时叫一声,其余全部原样转交。
 */
class FirstTextStream extends tokenize.SentenceStream {
  readonly #inner: tokenize.SentenceStream
  readonly #onFirstText: (text: string) => void
  #told = false

  constructor(inner: tokenize.SentenceStream, onFirstText: (text: string) => void) {
    super()
    this.#inner = inner
    this.#onFirstText = onFirstText
  }

  override pushText(text: string): void {
    if (!this.#told) {
      this.#told = true
      try { this.#onFirstText(text) }
      catch { /* 打一个计时点失败不该把她的话吞掉 */ }
    }
    this.#inner.pushText(text)
  }

  override flush(): void { this.#inner.flush() }
  override endInput(): void { this.#inner.endInput() }
  override close(): void { super.close(); this.#inner.close() }
  override next(): Promise<IteratorResult<tokenize.TokenData>> { return this.#inner.next() }
}
