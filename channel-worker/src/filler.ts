/**
 * 缓冲语 —— **工人这一侧只发一个信号,一个字都不合成**
 * (2026-09-20 第二版,Ben:「缓冲语可以存到手机里啊,不能每次都去 TTS 合成吧」)。
 *
 * ## 第一版错在哪(0.2.46,已作废)
 *
 * 第一版是工人调 `session.say('我想想。')`。两个毛病,都在实测里现了形:
 *   ① **排不上队**:`say()` 排进的是**同一条发言队列**(`agent_activity.scheduleSpeech`,
 *      优先级一律 NORMAL),而这一轮的回答在**用户回合提交那一刻**就已经排进去了 ——
 *      等 700ms 再 say 的那一句注定排在回答**后面**。本机实测就是「先出回答、1.4 秒后补一句稍等」。
 *   ② **每一轮都去合成一句定死的话**:火山那边一次并发、几百毫秒、还要钱,
 *      换来的是同样那几句话里的一句。Ben 一句话点破了这件事。
 *
 * ## 这一版怎么做
 *
 * 工人在**回合提交**(`agent_state_changed → thinking`)和**开始调一件慢工具**那一刻,
 * 往 `wb.rpc` 上广播一条极小的信号 `{type:'filler', kind, tool?, round, at}`。
 * **该说哪句、等多久、放不放**全在手机那一侧(butler-app/src/call/fillerAudio.ts):
 * 那几句话是**预先合成好、打进安装包**的,它 700ms 内没等到她的真声就本地放一句,
 * 她的真声一到就掐掉。
 *
 * 这样三件事同时成立:声音永远赶在回答前面(不经发言队列)、一分钱合成费都不花、
 * 答完之后绝不会再冒出一句「稍等一下」。
 *
 * ## 这个文件里钉住的三条
 *
 *   ① **一轮只发一次 `thinking`**。她想得久不该变成一串信号 —— 手机那边每收到一条就会重新计时。
 *   ② **同一件工具一轮只发一次**。模型在一轮里连调两次 `scan_projects` 不该垫两句。
 *   ③ **只有真的慢的工具才值得垫**({@link SLOW_TOOLS})。`record_answer` 最多等 400ms,
 *      给它垫一句只会在她马上要开口时插一句废话。**这是一张白名单,不是黑名单** ——
 *      新工具默认不垫,想垫要自己写进来,因为「这件事要多久」只有写它的人知道。
 *
 * 纯数据结构:不认识 LiveKit,不认识 `session`。接线在 agent.ts,线上那条消息的形状在 rpc.ts。
 */

/**
 * 值得垫一句的慢工具。
 *
 * - `scan_projects`:去读他硬盘上那几个仓库目录,实测几秒。
 * - `read_project`(2026-09-24,已有项目拉齐):读一个项目的说明、最近的设计与交接、最近的提交,
 *   几百毫秒到几秒(整份上限 5 秒)。手机那边没有它专用的一句,垫的是通用那句「我查一下,稍等。」。
 * - `wb_ask_butler`(2026-09-23):**把问题转给事务官本尊**,要等 DSH 一个来回
 *   (上限 12 秒,见 workbench.ts 的 `BUTLER_ANSWER_TIMEOUT_MS`)。这条路慢是明着换来的 ——
 *   换的是「她答的是真话」而不是照一份旧快照编(D13)。这几秒必须有人垫着。
 *
 * - `setup_preview` / `setup_apply`(2026-09-24 晚,引导落地):排单子要读存档、看板、项目区(还可能等一次模型),
 *   落单子要建十来张卡、改例程、开一条事务官会话 —— 一两秒到十几秒,这几秒得有人垫着。
 *
 * - `wb_relay_to_session`(2026-09-26,卡 BR):往那条会话的窗口里捎一句话 —— 把那家叫到前面、
 *   深链开到那一段(1.5 秒)、在窗口里认那段对话(`read_reply` 上限 20 秒)、再打字发送。
 *   几秒到二十几秒,这几秒必须有人垫着。手机那边没有它专用的一句,垫的是通用那句。
 *
 * `record_answer` **故意不在这里**:它最多等 400ms(onboarding.ts 的 `RECORD_WAIT_MS`),
 * 垫一句「我查一下」会正好插在她要开口的前面。
 */
export const SLOW_TOOLS: readonly string[] = ['scan_projects', 'read_project', 'wb_ask_butler', 'wb_relay_to_session', 'setup_preview', 'setup_apply']

/**
 * 垫场那几句的 id(2026-09-23,Ben:「现在不管说什么都要说『我想想』」)。
 *
 * **句子的源在 `butler-app/src/call/fillerLines.json`**(那里也是合成音频的源),
 * 这里抄的只有 id —— 工人从来不念这几句话,它只是在信号里**点名这一回合该用哪一条**,
 * 好让「连着两回合不用同一句」有一个说了算的地方:手机自己有一副洗好的牌
 * (`FillerBag`),而派上(phone-bridge)只有一个 wav —— 两头各挑各的,
 * 在派上听到的就永远是同一句「我想想」,那正是 Ben 这次说的那件事。
 *
 * **认不得这一格的一端照旧自己挑**:两头的解析器都只读自己认识的字段
 * (phone-bridge/filler.py 只读 round,butler-app 只读 kind/tool/round),多一格不会出错。
 * 真按它去挑句子是手机与派上那两张卡的事;这张卡先把「该说哪一句」定下来。
 */
export const THINKING_LINE_IDS: readonly string[] = ['think-1', 'think-2', 'think-3', 'think-4', 'think-5']

/** 工人 → 房间的那条信号。**故意小**:它一轮要发一两条,而房间里还跑着音频。 */
export interface FillerSignal {
  type: 'filler'
  /**
   * `thinking` = 回合提交,她开始想;`tool` = 开始调一件慢工具;
   * `tool_done` = 那件慢工具跑完了**而且她跑之前说的那几句也放完了**(2026-09-24 傍晚,见 {@link FillerSignaller.toolsDone})。
   * 手机拿 `tool` / `tool_done` 管引导里「她在找你的项目」那一整段球的执行中样子;老手机认不得 `tool_done` 就丢掉(解析器只认前两种)。
   */
  kind: 'thinking' | 'tool' | 'tool_done'
  /** 哪件工具(`kind:'tool'` / `'tool_done'` 有)。手机据此挑那句工具专用的话。 */
  tool?: string
  /**
   * 这一回合点名用哪一句垫场(只有 `kind:'thinking'` 有,见 {@link THINKING_LINE_IDS})。
   * **轮着来,连着两回合不会是同一条。** 认不得就忽略它,自己挑。
   */
  line?: string
  /** 第几轮。手机据此分辨「同一轮的第二条信号」和「新的一轮」。从 1 开始。 */
  round: number
  /** 工人发它的那一刻(毫秒)。**只用来量延迟、写日志**,不参与手机那边的计时。 */
  at: number
  /**
   * **垫场由工人自己说**(2026-09-23 晚,workerFiller.ts)。带着它的信号,手机**不再放本地那份**
   * (那份是固定音色,音色一换就是两个嗓子);老工人不带,手机照老行为自己垫。
   */
  voiced_by?: 'worker'
}

/** 信号 → 一行 JSON(走 `wb.rpc`,和字幕同一条通道)。 */
export function encodeFillerSignal(signal: FillerSignal): string {
  return JSON.stringify(signal)
}

export interface FillerSignallerOptions {
  /** 把一条信号发进房间。接线时接 agent.ts 里那条广播。 */
  send: (signal: FillerSignal) => void
  /** 现在几点。测试注入。 */
  now?: () => number
  /** 哪些工具值得垫。缺省 {@link SLOW_TOOLS}。 */
  slowTools?: readonly string[]
  /** 轮着点名的那几句。缺省 {@link THINKING_LINE_IDS};给空数组 = 不点名(信号里没有 `line`)。 */
  thinkingLines?: readonly string[]
  /** 垫场由工人自己说(信号上带 `voiced_by:'worker'`,手机据此不放本地那份)。缺省关 = 老行为。 */
  workerVoiced?: boolean
}

/**
 * 「她开始想了 / 她开始查东西了」→ 往房间里说一声。
 *
 * 用法(agent.ts):`agent_state_changed` 到 `thinking` 调 {@link FillerSignaller.thinking};
 * 到别的状态调 {@link FillerSignaller.endRound};工具开跑调 {@link FillerSignaller.toolStarted}。
 */
export class FillerSignaller {
  readonly #options: FillerSignallerOptions
  readonly #now: () => number
  readonly #slowTools: ReadonlySet<string>
  readonly #thinkingLines: readonly string[]
  /** 下一回合点名第几句(轮着来,见 {@link THINKING_LINE_IDS})。 */
  #lineAt = 0
  #round = 0
  /** 这一轮发过 `thinking` 没有。 */
  #thinkingSent = false
  /** 这一轮已经为哪几件工具发过信号。 */
  #toolsSent = new Set<string>()
  /** 这一轮开着没有。`thinking` 开新一轮;`endRound` 关掉它。 */
  #open = false

  constructor(options: FillerSignallerOptions) {
    this.#options = options
    this.#now = options.now ?? (() => Date.now())
    this.#slowTools = new Set(options.slowTools ?? SLOW_TOOLS)
    this.#thinkingLines = options.thinkingLines ?? THINKING_LINE_IDS
  }

  /** 这是第几轮(测试与日志用)。还没开过是 0。 */
  get round(): number { return this.#round }

  /**
   * 回合提交,她开始想。一轮只发一次。
   *
   * **只有「要办事」那种回合才该走到这里**(2026-09-23):闲聊回合由 agent.ts 那道闸
   * 在调模型之前就拦下了,见 {@link applyAgentState} 的 `gate`。
   * 信号里带一句**点名**(`line`):轮着来,连着两回合不是同一句。
   */
  thinking(): void {
    this.#openRound()
    if (this.#thinkingSent) return
    this.#thinkingSent = true
    const line = this.#takeLine()
    this.#emit({
      type: 'filler',
      kind: 'thinking',
      round: this.#round,
      at: this.#now(),
      ...(line === undefined ? {} : { line }),
    })
  }

  /** 取走下一句点名,并把指针往前拨一格。表是空的就没有(信号里也就没有 `line`)。 */
  #takeLine(): string | undefined {
    if (this.#thinkingLines.length === 0) return undefined
    const line = this.#thinkingLines[this.#lineAt % this.#thinkingLines.length]
    this.#lineAt = (this.#lineAt + 1) % this.#thinkingLines.length
    return line
  }

  /**
   * 一件工具开跑了。不在白名单里的**一声不吭**;同一件工具一轮只发一次。
   * 回的是「发没发」,agent.ts 据此决定要不要记一行日志。
   */
  toolStarted(name: string): boolean {
    const tool = name.trim()
    if (tool === '' || !this.#slowTools.has(tool)) return false
    // 工具在回合里面跑,所以正常情况下这里不会开新一轮;真遇上「没有 thinking 就来了工具」
    // (框架换了实现、工具由别处触发)也要有一个轮号,不然手机分不清批次。
    this.#openRound()
    if (this.#toolsSent.has(tool)) return false
    this.#toolsSent.add(tool)
    this.#emit({ type: 'filler', kind: 'tool', tool, round: this.#round, at: this.#now() })
    return true
  }

  /**
   * 这一步的工具都跑完了(框架的 `function_tools_executed`,2026-09-24 傍晚,卡 fix/scan-orb-working-whole-wait)。
   * 白名单里的慢工具每件发一条 `tool_done`(不按轮去重:同一轮里第二次调、开跑那条被去重掉的,跑完这条照样要有)。
   *
   * **为什么接这个事件、不在工具自己的 execute 末尾发**:手机要的是「她下一次开口就是在说结果」那一刻。
   * 模型常常先说一句「我看一下」再调工具,这句和工具**同时**在跑(`@livekit/agents` 边放边执行工具);
   * 工具跑完那一刻这句可能还没出声,手机要是那时候就开始等「她开口」,等到的是「我看一下」,球就提前回去了。
   * 框架在**这一段话放完、工具也都回来之后**才发 `function_tools_executed`(agent_activity 的 pipelineReplyTask:
   * 先等整段 playout,再等工具,再发事件,再去生成下一段)—— 在这之后她说的每一句都是看完之后说的。
   *
   * 回的是「发没发」(agent.ts 据此记一行日志)。还没开过轮就不发(没有轮号可带)。
   */
  toolsDone(names: readonly string[]): boolean {
    if (this.#round === 0) return false
    let sent = false
    for (const raw of names) {
      const tool = raw.trim()
      if (tool === '' || !this.#slowTools.has(tool)) continue
      this.#emit({ type: 'filler', kind: 'tool_done', tool, round: this.#round, at: this.#now() })
      sent = true
    }
    return sent
  }

  /**
   * 这一轮结束了(回到听、会话闲下来)。下一次 `thinking` 就是新的一轮。
   *
   * **「结束」里不包括「她开口了」**(2026-09-22 改,Ben 真机:「在生成回复之前,
   * 它一次念了好几句」)。一个回合里模型每调一次工具,框架就在 `speaking ↔ thinking`
   * 之间来回一次;把 `speaking` 也当成结束的话,**同一个回合会被切成好几轮**,
   * 手机那边每个新轮号都以为「他又说了一句」,于是一句接一句地垫。接线与出处见 agent.ts。
   */
  endRound(): void {
    this.#open = false
  }

  #openRound(): void {
    if (this.#open) return
    this.#round += 1
    this.#open = true
    this.#thinkingSent = false
    this.#toolsSent = new Set()
  }

  /** 这一轮点名的那一句(没点名就 undefined)。工人自己垫的时候照它挑(workerFiller.ts)。 */
  get line(): string | undefined { return this.#line }
  #line: string | undefined

  #emit(signal: FillerSignal): void {
    if (signal.kind === 'thinking') this.#line = signal.line
    const out: FillerSignal = this.#options.workerVoiced === true ? { ...signal, voiced_by: 'worker' } : signal
    // 发一个信号是好意,发不出去不该再出一个错(和第一版同一条规矩)。
    try { this.#options.send(out) }
    catch { /* 见上 */ }
  }
}

/**
 * 框架那条 `agent_state_changed` → 这个信号器上的哪一下(2026-09-22)。
 *
 * **单独抽出来是为了能用例钉住**:接线在 agent.ts,而那一整段要真起一个 LiveKit 会话才跑得到,
 * 于是「哪个状态算回合结束」这件事从第一版起就没有一条用例看着 —— 它也正是这次出问题的地方。
 *
 * 三条:
 *   · `thinking` = 她开始想 → 开一轮(一轮只发一条);
 *   · **`speaking` 什么都不做**。它是同一个回合里的一段:模型每调一次工具,
 *     `@livekit/agents` 就在 `speaking ↔ thinking` 之间来回一次(`agent_activity.js`)。
 *     把它当结束的话,**一个回合会被切成好几轮**,手机那边就会在同一次等待里一句接一句地垫
 *     (Ben 2026-09-22 真机:「在生成回复之前,它一次念了好几句」);
 *   · 其余(`listening` / `idle` / `initializing`)= 这一轮真的结束了。
 */
export function applyAgentState(signaller: FillerSignaller, newState: string, gate?: FillerGate): void {
  if (newState === 'thinking') {
    if (gate === undefined) { signaller.thinking(); return }
    // 闸门可能要等一拍(分流判定还在路上),所以是「给你一个开关,想发的时候按」。
    try { gate(() => signaller.thinking()) }
    catch { /* 闸门坏了不许把回合带走:那一回合就是不垫,不是出错 */ }
    return
  }
  if (newState === 'speaking') return
  signaller.endRound()
}

/**
 * 「这一回合到底垫不垫」的闸门(2026-09-23)。
 *
 * 拿到的是一个**开关**而不是一个布尔:分流判定可能还在路上(Jev 要一次 HTTP),
 * 闸门可以等它回来再按。不按 = 这一回合一个字都不垫 —— 闲聊回合就是不按。
 *
 * 为什么闸门不写在这个文件里:它要认识分流(turnRoute.ts)与这一回合的轮号,
 * 而这里只管信号。接线与那几条规矩在 agent.ts。
 */
export type FillerGate = (emit: () => void) => void

/**
 * 「这一回合到底垫不垫」那一条判断**本身**(2026-09-23 下午)。
 *
 * 抽成纯函数的理由和 {@link applyAgentState} 一模一样:接线在 agent.ts,
 * 而那一整段要真起一个 LiveKit 会话才跑得到 —— 判断本身必须有用例看着。
 *
 * 四条:
 *   · 闲聊回合不垫(2026-09-23 上午那张卡);
 *   · **已经按意图先应过一句的回合不垫**(2026-09-23 下午):他刚听见
 *     「好,我挑几个给你听」,0.7 秒后再补一句「我想想」就是两句话打架 ——
 *     而那一句正是维护者 这次点名要去掉的那一句;
 *   · **马上能答的回合不垫**(2026-10-12,turnRoute.ts 的 `QUICK_INTENTS`);
 *   · 其余照垫(认不出意图的办事回合,行为与从前一字不差)。
 */
export function fillerGateVerdict(
  route: string,
  options: { acked?: string, quick?: boolean } = {},
): { fill: boolean, why: string } {
  if (route !== 'act') return { fill: false, why: '这一回合是闲聊' }
  // 2026-10-12(电话先应收窄):查一眼、记一笔这类马上能答的,不垫「我想想」。
  if (options.quick === true) return { fill: false, why: '这一回合马上能答' }
  const acked = options.acked?.trim() ?? ''
  if (acked !== '') return { fill: false, why: `这一回合已经先应过「${acked}」` }
  return { fill: true, why: '要办事,而且没应过' }
}

// ———————————————————————— 音色换了 ————————————————————————

/**
 * 工人 → 手机,**广播**:事务官的音色换了(2026-09-22)。
 *
 * 手机上那七句缓冲语从这一版起是**按音色缓存在本地**的
 * (butler-app/src/call/fillerVoiceCache.ts)。人在 Mac 的配置后台里换了音色之后,
 * 她的回答立刻是新嗓子,而垫场那几句还是旧的 —— 电话里于是有两个嗓子。
 * 那个洞 `docs/交接-0920-缓冲语本地播放.md` 第六节第 1 条如实记着,这条信号就是来补它的。
 *
 * **手机收到不当场重合成**(七条 `/api/tts` 一起打出去正是 09-20 那次 502 的病根),
 * 只记一笔,下次进房按新音色重取。
 */
export interface FillerVoiceSignal {
  type: 'filler_voice_changed'
  /** 现在是哪个音色(8792 的 `/health.voice`)。手机拿它当缓存键的前半截。 */
  voice: string
  at: number
}

export function encodeFillerVoiceSignal(signal: FillerVoiceSignal): string {
  return JSON.stringify(signal)
}

export interface VoiceWatcherOptions {
  /** 问一句现在是哪个音色(8791 的 `GET /butler/status` → `voice`)。问不到回 undefined。 */
  read: () => Promise<string | undefined>
  send: (signal: FillerVoiceSignal) => void
  now?: () => number
  log?: (line: string) => void
}

/**
 * 盯着音色变没变。**只在"变了"那一下发一条**。
 *
 * 三条纪律:
 *
 *   ① **第一次问到的那个值不算"变了"**。工人重启时手机那边的缓存一个字都没动,
 *      拿"我刚知道"当"它刚变"去广播,等于每次重启工人都让手机重合成七句。
 *   ② **问不到就当没发生**(8792 没跑、这一拍超时)。把"问不到"当成"换成了空"去广播,
 *      手机会按一个空名字去建缓存 —— 那不是任何一个音色。
 *   ③ **绝不抛**。这根节拍跑在通话进行时,一次异常就能把工人带走。
 */
export class VoiceWatcher {
  readonly #options: VoiceWatcherOptions
  readonly #now: () => number
  readonly #log: (line: string) => void
  #known: string | undefined
  #busy = false

  constructor(options: VoiceWatcherOptions) {
    this.#options = options
    this.#now = options.now ?? (() => Date.now())
    this.#log = options.log ?? (() => {})
  }

  /** 这会儿记着的那个音色(测试与日志用)。还没问到过是 undefined。 */
  get known(): string | undefined { return this.#known }

  /** 问一拍。回「发没发」。**上一拍还没回来就跳过这一拍**(不排队)。 */
  async tick(): Promise<boolean> {
    if (this.#busy) return false
    this.#busy = true
    try {
      let voice: string | undefined
      try { voice = await this.#options.read() }
      catch { return false }
      if (voice === undefined || voice.trim() === '') return false
      const next = voice.trim()
      if (this.#known === undefined) { this.#known = next; return false }
      if (this.#known === next) return false
      this.#known = next
      try { this.#options.send({ type: 'filler_voice_changed', voice: next, at: this.#now() }) }
      catch { return false }
      this.#log(`[channel-worker] 事务官音色换成了 ${next},已告诉房里的手机(它下次进房重取缓冲语)`)
      return true
    }
    finally { this.#busy = false }
  }
}
