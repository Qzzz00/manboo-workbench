/**
 * 一回合的计时(2026-09-23,Ben 真机第一次整条线通:「延迟有点高」)。
 *
 * ## 为什么先做这个,不先改
 *
 * 那天的 `~/.dsh/workbench/logs/channel-worker.log` 里,我们自己写的每一行**都没有时间戳**
 * (只有框架 pino 那几行有)。于是「慢在哪一段」这件事在证据上**整个不存在** ——
 * 能说的只有 Ben 的体感。这个文件就是来补那份证据的:一回合一行,毫秒,
 * 没测到的那一段**写 null**,不拿别的段的数去凑一个好看的总数。
 *
 * ## 量的是哪几段
 *
 *   user_end        他说完了(VAD 判停 → 框架把 user_state 落回 listening)
 *   stt_final       识别的最终文本到手
 *   committed       回合提交,她开始想(agent_state → thinking)
 *   llm_first       模型的第一段字到嘴边(第一次 pushText 进句子切分器)
 *   tts_request     第一句开始合成(向 8792 发 POST 的那一刻)
 *   tts_first_audio 第一句的音频合好、进音频队列
 *   speaking        框架开始把音频发进房(agent_state → speaking)
 *   llm_done        整段回答生成完(ConversationItemAdded/assistant)
 *   tts_done        最后一句也合完了
 *
 * **`speaking` 不是「派上出声」**。从这一刻起还有:Opus 编码 → 阿里云 LiveKit →
 * 派 → 派的抖动缓冲 → aplay 的 ALSA 缓冲。那几段在派上,工人这边量不到 ——
 * 所以 `total_ms` 只敢叫「停说 → 首包发进房」,派端那一截由 phone-bridge 自己记
 * (见 phone-bridge/filler.py 里的「真声到」那一行)。
 *
 * ## 一个回合里 thinking↔speaking 会来回好几次
 *
 * 模型每调一次工具,框架就在这两个状态之间来回一次(filler.ts 头注释里那一段账)。
 * 所以这里和 FillerSignaller 用**同一条规矩**:`thinking` 开回合、`speaking` 不算结束、
 * 回到 `listening`/`idle` 才收尾。收尾时吐一条,之后再来 `thinking` 就是新的一回合。
 *
 * 纯数据结构:不认识 LiveKit、不认识 fetch、不认识时钟(now 可注入)。接线在 agent.ts。
 */

/** 能打的点。顺序就是一回合里正常发生的顺序。 */
export const TURN_MARKS = [
  'user_end',
  'stt_final',
  'committed',
  'llm_first',
  'tts_request',
  'tts_first_audio',
  'speaking',
  'llm_done',
  'tts_done',
] as const

export type TurnMark = typeof TURN_MARKS[number]

/** 一回合里各点的**绝对**毫秒。没打到的缺席 —— 缺席就是缺席,不补 0。 */
export type TurnMarks = Partial<Record<TurnMark, number>>

/**
 * 一回合的成绩单。**每一段都可能是 null**:两头有一头没打到,这一段就是没测到。
 * 读的人(体检页、统筹)看见 null 要当成「这一次没量到」,不是「0 毫秒」。
 */
export interface TurnLatency {
  /** 第几回合。从 1 开始,工人这一轮进程内计数。 */
  round: number
  /** 这一回合工人垫过一句(见 {@link TurnRouteNote.filler})。没垫就缺席。与插件那份同形(`filler?: true`)。 */
  filler?: true
  /** 回合起点的绝对毫秒(第一个打到的点)。体检页按它排序、显示「几分钟前」。 */
  at: number
  /** 他说完 → 识别最终文本。 */
  asr_ms: number | null
  /** 识别最终文本 → 回合提交(端点检测那一段固定等待就藏在这里)。 */
  commit_ms: number | null
  /** 回合提交 → 模型第一段字(中转 + deepseek 的首字)。 */
  llm_first_ms: number | null
  /** 模型第一段字 → 整段生成完。 */
  llm_gen_ms: number | null
  /** 第一句开始合成 → 第一句音频到手(8792 + 火山的首句合成)。 */
  tts_first_ms: number | null
  /** 第一句音频到手 → 框架开始发包进房。 */
  publish_ms: number | null
  /** 第一句开始合成 → 最后一句合完(整段合成的全程,只作参考,不在等待路径上)。 */
  tts_all_ms: number | null
  /** 模型第一段字 → 首包发进房。**「字幕已出 → 该出声了」那一段在工人这边的部分。** */
  mouth_ms: number | null
  /** 他说完 → 首包发进房。**派上真出声还要再加一截网络与缓冲,这里量不到。** */
  total_ms: number | null
  /**
   * 这一回合走的哪条路(2026-09-23,turnRoute.ts):`chat` = 没带工具、没垫场;
   * `act` = 带了全套工具、垫了场。**缺席 = 这一回合没判过**(开场白那种没有识别结果的)。
   *
   * 为什么它要挤进这一行:分流到底省没省,看的就是「chat 那几行的 `llm_first_ms` 是不是真短了」。
   * 没有这一格,两种回合在 `GET /channel/latency` 上混成一堆,省下来的那一秒说不清是哪来的。
   */
  route?: 'chat' | 'act'
  /** 谁判的(`rules` / `jev` / `none`)。换实现之后,一眼看得出这一批数是哪一件判出来的。 */
  router?: string
  /**
   * ——— 2026-10-03 多的四格(卡「首声提速」)———
   *
   * 为什么要挤进这一行:下一份诊断包要能**按同一口径**量出「甲乙到底省没省」,
   * 而唯一跨得过真机的那把尺子就是日志里的 `回合计时` 那一行
   * (`tests/air-1002-replay.test.ts` 的夹具正是从它摘出来的)。
   *
   * **8791 那一头一个字都不用改**:`channelLatency.ts` 的 `parseTurnLatency`
   * 只认它那张字段表、多出来的格原样丢掉 —— 所以体检页与
   * `GET /channel/latency` 的形状一字没动(接缝没碰)。
   */
  /** 办的是哪件事(turnRoute 判出来的意图 id)。缺席 = 认不出意图 → 那一回合带的是全套工具。 */
  intent?: string
  /** 这一回合**真送给模型几件工具**。0 = 闲聊路;缺席 = 没记到。 */
  tools?: number
  /** 这一回合首句的结局(`said` / `late` / `failed` / `rejected` / `unvoiced`;缺席 = 没开首句)。 */
  first_voice?: string
  /** 从「开始问首句」到「结局落定」多久(毫秒)。 */
  first_voice_ms?: number
  /**
   * 这一回合**人设交出去多少字**(2026-10-03,卡「人设按意图裁」)。
   * 缺席 = 没裁(整份 —— 开关关着、老工作台没下发分段,或者下发的形状认不出来)。
   * 发版后按它量 chat 路那一半:`grep 回合计时 | jq 'select(.route=="chat").persona'`。
   */
  persona?: number
}

/** 两点之差。有一头缺席就是 null(而且负数也算没测到:时钟倒退比错数据好发现)。 */
export function spanOf(marks: TurnMarks, from: TurnMark, to: TurnMark): number | null {
  const a = marks[from]
  const b = marks[to]
  if (a === undefined || b === undefined) return null
  const span = b - a
  return span < 0 ? null : span
}

/** 这一回合的分流(哪条路、谁判的)。两格都可能缺席 —— 缺席就是没判过,不猜一个。 */
export interface TurnRouteNote {
  route?: 'chat' | 'act'
  router?: string
  /**
   * 这一回合**工人垫过一句**(2026-09-23 晚,workerFiller.ts)。垫场是回答的前几百毫秒,
   * 框架看见它的第一帧就切 `speaking` —— 所以这一回合的 `speaking` 是垫场出声那一刻,
   * `publish_ms` / `mouth_ms` / `total_ms` 量到的是垫场,不是真声。带着这一格,读的人分得清。
   */
  filler?: boolean
  /** 办的是哪件事(2026-10-03,见 {@link TurnLatency.intent})。 */
  intent?: string
  /** 这一回合真送给模型几件工具(2026-10-03)。0 也算数,所以判的是 `undefined`。 */
  tools?: number
  /** 首句的结局与耗时(2026-10-03)。 */
  firstVoice?: string
  firstVoiceMs?: number
  /** 这一回合人设交出去多少字(2026-10-03,见 {@link TurnLatency.persona})。 */
  persona?: number
}

/** 一回合的点 → 成绩单。纯函数,给用例直接喂点。 */
export function latencyOf(round: number, marks: TurnMarks, note: TurnRouteNote = {}): TurnLatency {
  const at = TURN_MARKS.map(name => marks[name]).find(value => value !== undefined) ?? 0
  return {
    round,
    at,
    ...(note.route === undefined ? {} : { route: note.route }),
    ...(note.router === undefined || note.router === '' ? {} : { router: note.router }),
    ...(note.filler === true ? { filler: true } : {}),
    ...(note.intent === undefined || note.intent === '' ? {} : { intent: note.intent }),
    ...(note.tools === undefined ? {} : { tools: note.tools }),
    ...(note.firstVoice === undefined || note.firstVoice === '' ? {} : { first_voice: note.firstVoice }),
    ...(note.firstVoiceMs === undefined ? {} : { first_voice_ms: note.firstVoiceMs }),
    ...(note.persona === undefined ? {} : { persona: note.persona }),
    asr_ms: spanOf(marks, 'user_end', 'stt_final'),
    commit_ms: spanOf(marks, 'stt_final', 'committed'),
    llm_first_ms: spanOf(marks, 'committed', 'llm_first'),
    llm_gen_ms: spanOf(marks, 'llm_first', 'llm_done'),
    tts_first_ms: spanOf(marks, 'tts_request', 'tts_first_audio'),
    publish_ms: spanOf(marks, 'tts_first_audio', 'speaking'),
    tts_all_ms: spanOf(marks, 'tts_request', 'tts_done'),
    mouth_ms: spanOf(marks, 'llm_first', 'speaking'),
    total_ms: spanOf(marks, 'user_end', 'speaking'),
  }
}

/**
 * 一行日志。**前缀是人话,后面是一坨 JSON** —— 人扫一眼能看懂,
 * 统筹想算平均值时 `grep 回合计时 | sed 's/.*计时 //' | jq` 就能直接吃。
 */
export function formatTurnLatency(latency: TurnLatency): string {
  return `回合计时 #${latency.round} ${JSON.stringify(latency)}`
}

export interface TurnTimelineOptions {
  /** 一回合收尾时调一次。接线里在这儿写日志 + 报给 8791。 */
  onTurn: (latency: TurnLatency) => void
  /** 现在几点。测试注入。 */
  now?: () => number
}

/**
 * 一条正在走的回合。用法见文件头;所有方法都**不抛**(计时出错不该把电话带走)。
 *
 * 打点的规矩:
 *   · **先到先得**。同一个点一回合只记第一次 —— `tts_request` 一回合有好几句,
 *     要的是第一句那一下;`tts_done` 是唯一的例外(要最后一次)。
 *   · **没开回合也能打点**。招呼、来电开场白那几句没有 `user_end`,
 *     第一个打到的点就把回合开起来,成绩单里前面那几段如实是 null。
 */
export class TurnTimeline {
  readonly #onTurn: (latency: TurnLatency) => void
  readonly #now: () => number
  #round = 0
  #open = false
  #marks: TurnMarks = {}
  #note: TurnRouteNote = {}

  constructor(options: TurnTimelineOptions) {
    this.#onTurn = options.onTurn
    this.#now = options.now ?? (() => Date.now())
  }

  /** 这是第几回合(测试与日志用)。还没开过是 0。 */
  get round(): number { return this.#round }

  /** 这会儿有没有一条回合在走。 */
  get open(): boolean { return this.#open }

  /**
   * 打一个点。`at` 不给就用现在。
   *
   * 两个例外:
   *   · `tts_done` **后到的盖掉先到的**:一段话切成三四小块,要的是最后一块合完那一下;
   *   · `user_end` 在「这一回合还只有 user_end 一个点」时也盖掉先到的 ——
   *     他说了一句她没接话(没听清、只是清嗓子),那一句的停说时刻不该拿去当下一句的起点,
   *     否则算出来的 `total_ms` 会把两句之间发呆的时间也算进延迟里。
   */
  mark(name: TurnMark, at: number = this.#now()): void {
    if (!this.#open) {
      this.#round += 1
      this.#open = true
      this.#marks = {}
      this.#note = {}
    }
    if (name === 'tts_done') { this.#marks[name] = at; return }
    if (name === 'user_end' && this.#onlyUserEnd()) { this.#marks[name] = at; return }
    if (this.#marks[name] !== undefined) return
    this.#marks[name] = at
  }

  /**
   * 记下这一回合的分流(2026-09-23)。**先到先得**:一个回合里模型调完工具会再判一次的话,
   * 要的是第一次那个 —— 成绩单上那一行说的是「这一回合是按什么走的」。
   * 没开回合也能记(判定比框架的 `thinking` 先到),它会把回合开起来。
   */
  note(note: TurnRouteNote): void {
    if (!this.#open) {
      this.#round += 1
      this.#open = true
      this.#marks = {}
      this.#note = {}
    }
    if (note.route !== undefined && this.#note.route === undefined) this.#note.route = note.route
    if (note.router !== undefined && this.#note.router === undefined) this.#note.router = note.router
    if (note.filler === true) this.#note.filler = true
    // 2026-10-03 那四格也是「先到先得」(同 route:成绩单上说的是这一回合**按什么走的**)。
    if (note.intent !== undefined && this.#note.intent === undefined) this.#note.intent = note.intent
    if (note.tools !== undefined && this.#note.tools === undefined) this.#note.tools = note.tools
    if (note.firstVoice !== undefined && this.#note.firstVoice === undefined) this.#note.firstVoice = note.firstVoice
    if (note.firstVoiceMs !== undefined && this.#note.firstVoiceMs === undefined) this.#note.firstVoiceMs = note.firstVoiceMs
    if (note.persona !== undefined && this.#note.persona === undefined) this.#note.persona = note.persona
  }

  /** 这一回合到目前为止只打到过 `user_end`。 */
  #onlyUserEnd(): boolean {
    const names = Object.keys(this.#marks)
    return names.length === 0 || (names.length === 1 && names[0] === 'user_end')
  }

  /**
   * 这一回合结束了(回到听、会话闲下来)。**一个点都没打过就什么都不吐** ——
   * 房里没人时框架也会在状态之间晃,不该因此往日志里刷空行。
   */
  end(): void {
    if (!this.#open) return
    this.#open = false
    const marks = this.#marks
    const note = this.#note
    this.#marks = {}
    this.#note = {}
    if (Object.keys(marks).length === 0 && Object.keys(note).length === 0) return
    const latency = latencyOf(this.#round, marks, note)
    try { this.#onTurn(latency) }
    catch { /* 记一条计时失败不值得再出一个错 */ }
  }
}

/**
 * 框架那条 `agent_state_changed` → 这条时间线上的哪一下。
 *
 * 和 `filler.ts` 的 `applyAgentState` **同一条规矩**(两处都写一遍是故意的:
 * 它们将来可能因为不同的理由各自变,合成一个函数会让「改一处坏两处」变得容易)。
 */
export function applyAgentStateToTimeline(timeline: TurnTimeline, newState: string): void {
  if (newState === 'thinking') { timeline.mark('committed'); return }
  if (newState === 'speaking') { timeline.mark('speaking'); return }
  timeline.end()
}

/**
 * 最近几条成绩单。8791 的 `GET /channel/latency` 与体检页读的就是它的一份拷贝。
 * **只在内存里**:它是给人看的最近记录,不是账本,工人重启就该从头来。
 */
export const LATENCY_KEEP = 20

export class LatencyLog {
  readonly #keep: number
  #rows: TurnLatency[] = []

  constructor(keep: number = LATENCY_KEEP) {
    this.#keep = Number.isFinite(keep) && keep >= 1 ? Math.floor(keep) : LATENCY_KEEP
  }

  add(latency: TurnLatency): void {
    this.#rows.push(latency)
    if (this.#rows.length > this.#keep) this.#rows = this.#rows.slice(-this.#keep)
  }

  /** 最近的在前。回的是拷贝 —— 读的人改不动这份记录。 */
  recent(): readonly TurnLatency[] {
    return [...this.#rows].reverse()
  }
}
