/**
 * DSH 自家会话接入(2026-09-09):把 DSH 进程内的原生会话事件与投影值,
 * 翻成工作台的 `agent:'dsh'` 事件与会话行上的三个数字。
 *
 * 这是全局梳理 §2.5 记了很久的缺口——在此之前全仓库没有一行代码产出 `agent:'dsh'` 的会话事件,
 * 四家里唯独 DSH 自己没有白/黄/蓝点。
 *
 * **取数方式全部实测过**,见 docs/superpowers/research/2026-09-09-DSH会话投影可读性.md。
 * 那份调研里三条硬约束直接决定了这个文件的写法:
 *
 * 1. **不轮询**。事件是 `ctx.on('session/event')` 推过来的,数字是 `sessionProjections.onChanged`
 *    推过来的。这里只有纯函数与一张内存表,没有任何定时器。
 * 2. **生产形态下 dsh-context 的 `contextTimeline` 是瘦头**——`fileOps` 不在里面(它走 detail RPC,
 *    那条通道是给正在看 Context 标签的浏览器客户端用的,host 侧不碰)。所以「改了 n 个文件」
 *    只能自己从 `tool/call` 数,见 foldDshEvent 里那一段。
 * 3. **DSH 没有「等你下一句」这一档**。turn 结束一律是 completed,它不区分"答完了"和"在等你说下一句"。
 *    所以 DSH 会话只有红点(等审批)/绿点(在跑)/蓝点(刚完成),不补假的 idle_prompt——
 *    同 hooks.ts 对 Codex「没有 Notification 就不假造等你确认」的处理。
 *    等待原因分类(2026-09-09 拍板第 4 条)同理:DSH 能可靠给出的只有**等审批**(approval/asked)
 *    与**出错**(turn/end 的 error / max-tokens);aborted 是他自己按的停止,一个字都不填。
 *
 * 还有一条纪律来自 dsh-context 的教训(它的 logShapes.ts 顶部写了整段告诫):投影注册表驱动 fold 时
 * **没有错误边界**,一次抛出会卡死该会话的推送。我们是订阅侧,同理——所有入口对坏数据都必须是
 * "当没看见",绝不抛。
 */
import { dshSubagentOf } from '../dshSessionFile.ts'
import type { EventReason, SessionStatus, WaitReason, WorkbenchEvent } from '../protocol.ts'
import type { SessionActivity, SessionMetrics, SessionTurn } from '../protocol.ts'
import { ACTIVITY_MAX, activityOfTool, humanize } from './sessionDigest.ts'

/** 我们认得的那部分 DSH 事件信封。DSH 的事件词表由各插件合并而成,这里只做结构性读取。 */
export interface DshEventLike {
  type: string
  seq?: number
  data?: unknown
}

/**
 * 一条 `user/message` 到底是谁说的(2026-09-25,卡 U3:升到 0.1.7)。
 *
 * **为什么必须分**:`user/message` 是「模型可见的用户角色消息」这一格,人真说的一句和上游各个
 * 插件往上下文里塞的东西**共用这一个事件类型**,只有 `source` 能把它们分开(上游
 * `core/session/src/types.ts` 的 `'user/message'` 注释原话:三者都逐字投影 content,`source` 告诉你谁是谁)。
 * 0.1.7 的默认 web 组合比 0.1.2 多塞了好几种(后台任务做完的 notice、定时任务提醒、时间上下文、
 * 子代理结算……),认不出来就会被当成「他说了一句」进「她说了什么」、进气泡、进计数——
 * 那是第六节验收第 6 条明令禁止的。
 *
 * **两代的写法不一样,两代都要认**:
 * - 0 代(0.1.2-rc.1)插件塞的是 `{ kind: 'plugin', plugin: 'time-context' }`;
 * - 4 代(0.1.7-rc.2)拆平成生产者自己的 kind:`{ kind: 'time-context' }`
 *   (上游 `session-format-v3-to-v4/src/sources.ts` 的 `rewritePluginSource`,
 *   并在 `message-sources.ts` 里**硬拒**再出现 `kind: 'plugin'`)。
 *
 * 所以判据只有一条、两代同时成立:**`kind === 'user'` 才是人说的**,其余一律不是。
 * 这是白名单而不是黑名单——上游以后再加一种生产者,我们默认把它当系统消息滤掉,
 * 而不是漏进「他说了一句」(宁可少认,不可错认,D13)。
 */
export type DshMessageAuthor =
  /** 人真说的一句(`kind === 'user'`)。 */
  | { kind: 'human' }
  /**
   * 后台任务做完了,把会话唤醒的那条 notice ——**评估第四节里唯一要接的上游功能**。
   * 判据:`source.kind === 'tool-jobs'` 且 `source.form === 'notice'`
   * (上游 `jobs/tool-jobs/src/index.ts` 的 `createUserMessage({ source: { kind:'tool-jobs', form:'notice', summary } })`)。
   * 它**不是他说的话**(不进「她说了什么」、不进气泡、不进回合列表),但要认出来:
   * 这条 notice 之后 DSH 会照常开一个回合(idle 时 `followup` 开新回合、busy 时 `inject` 进下一步),
   * 回合结束仍然走 `turn/end` → `onSessionEnd` → 事项转态 / 进「等你确认」,那条路一个字没变。
   */
  | { kind: 'job-notice', summary?: string }
  /** 上游别的插件塞进来的系统消息(定时任务、时间上下文、子代理结算、规矩表……)。整条丢掉。 */
  | { kind: 'system', producer: string }

/**
 * 上游 `tool-jobs` 那条「后台任务做完」notice 的生产者 kind。
 * 与上游 `RELEASED_SAME_NAME_PRODUCERS` 里的那一个字逐字一致。
 */
const JOB_NOTICE_KIND = 'tool-jobs'

/**
 * `user/message` 的 `source` → 谁说的。两代都认(见 {@link DshMessageAuthor})。
 *
 * `source` 缺席或形状不对时当**人说的**:0 代早期的真文件里有过不带 source 的 user/message,
 * 那时候只有人能往这一格写;把它判成系统消息会把他真说过的话吞掉。
 */
export function authorOfUserMessage(source: unknown): DshMessageAuthor {
  const record = asRecord(source)
  const kind = record?.kind
  if (typeof kind !== 'string' || kind === '' || kind === 'user') return { kind: 'human' }
  // 0 代的老写法:真正的生产者在 `plugin` 里。4 代已经拆平,`kind: 'plugin'` 被上游硬拒。
  const producer = kind === 'plugin' && typeof record?.plugin === 'string' && record.plugin !== ''
    ? record.plugin
    : kind
  if (producer === JOB_NOTICE_KIND && record?.form === 'notice') {
    const summary = record.summary
    return { kind: 'job-notice', ...(typeof summary === 'string' && summary.trim() !== '' ? { summary: summary.trim() } : {}) }
  }
  return { kind: 'system', producer }
}

/** 一条 DSH 会话在我们这边的累计状态。纯数据,便于单测。 */
export interface DshFoldState {
  /** `session/title` 给的标题(先是首句截断的 fallback,几秒后被模型生成的顶掉)。 */
  readonly title?: string
  /** 被写类工具改过的文件路径,去重。 */
  readonly writtenPaths: ReadonlySet<string>
  /** writtenPaths.size 的快照,给视图用。 */
  readonly filesChanged: number
  /**
   * 最近一个结束了的回合里,模型最后一段给人看的文字(2026-09-15,手机端事务官朗读的就是它)。
   * 只在 turn/end 时写;turn/start **不清空**——手机上要留着上一句,直到新回复来。
   */
  readonly summary?: string
  /** 本回合里到目前为止最后一段 assistant 文字;turn/end 时结算成 summary,turn/start 时清掉。 */
  readonly pendingAssistant?: string
}

/**
 * 一条会话的一个 turn 怎么结束的(2026-09-16 事项生命周期闭环)。给 butlerLifecycle 用:
 * done → 事项进「等我确认」;error → 阻塞;aborted → 回待办。`detail` 是 DSH 给的出错原话
 * (`reason.error.message`),没有就没有——不编原因。
 */
export interface DshSessionEnd {
  kind: 'done' | 'error' | 'aborted'
  /** DSH turn/end 那一刻(Unix 秒,取自 feed 的时钟)。事项那边拿它跟卡的 updated_at 比:人在这之后改过的以人为准。 */
  ts: number
  detail?: string
  /**
   * 这条会话到此刻用**写类工具**改过几个文件(`DshFoldState.filesChanged`,2026-09-25 卡 Y)。
   *
   * 给「随手问一句不算一件事」那条判据用(`casualAsk.ts`):办完没派出去、**没改文件**、没有要交回的东西
   * → 这张卡自己收掉。`bash` 改的文件数不出来(见 `isWriteTool` 那一段:从命令行里猜不出改了哪个),
   * 所以这个数**只会少不会多** —— 判据那边知道这一条,交接里也写着。
   */
  filesChanged?: number
}

/** 一次状态变化。wait_reason 只在能可靠判定时出现(见 protocol.ts 的 WaitReason)。 */
export interface DshStatusChange {
  type: SessionStatus
  reason?: EventReason
  wait_reason?: WaitReason
  /** turn/end 才有:这个 turn 是怎么结束的(不进 WorkbenchEvent,只给会话结束端口)。 */
  ended?: Omit<DshSessionEnd, 'ts'>
}

export interface DshFoldResult {
  state: DshFoldState
  /** 这条事件引起的状态变化;没有变化时缺省。 */
  event?: DshStatusChange
  /** 这条事件带来的一个回合(人说的一句 / 模型答的一段),给回合列表用;不是回合时缺省。 */
  turn?: { role: SessionTurn['role'], text: string }
  /**
   * 上游塞进来的一条**要认出来、但不算他说的话**的系统消息(2026-09-25,卡 U3)。
   * 目前只有一种:`job-done` —— 后台任务做完把会话唤醒的那条 notice(评估第四节唯一要接的)。
   * 与 `turn` **互斥**:有 notice 就一定没有 turn,所以它进不了回合列表、进不了 summary、进不了计数。
   */
  notice?: { kind: 'job-done', summary?: string }
}

export function emptyDshFold(): DshFoldState {
  return { writtenPaths: new Set(), filesChanged: 0 }
}

/** summary 的长度上限(字)。手机上一口气念的一段,200 字够说清"做到哪了"。 */
export const SUMMARY_MAX = 200
/** 回合列表里单条正文的长度上限(字)。 */
export const TURN_TEXT_MAX = 2000
/** 一条会话在内存里最多留几个回合。手机只要最近 20 条,留 200 条已经绰绰有余,再多就是白占内存。 */
const TURNS_KEPT = 200

/**
 * 围栏代码块:从 ``` 起到下一个 ``` 止,整段去掉;没闭合的一直去到末尾
 * (半截代码比没有更误导——念出来是一串符号)。
 */
const FENCED_CODE = /```[\s\S]*?(?:```|$)/g

/**
 * 消息正文(Message.content 那组块)→ 给人看的纯文本。
 *
 * 只取 `text` 块:`reasoning` 不是给人看的,`tool-call` / `tool-result` 是机器之间的话。
 * 文本里的围栏代码块整段去掉。什么都不剩时返回 undefined——**不给空串**,
 * 调用方据此"不填",而不是填一个空的 summary 把上一句擦掉。
 */
export function plainTextOf(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined
  const parts: string[] = []
  for (const block of content) {
    const record = asRecord(block)
    if (record === undefined || record.type !== 'text' || typeof record.text !== 'string') continue
    const stripped = record.text.replace(FENCED_CODE, '')
      .split('\n').map(line => line.trimEnd()).filter(line => line.trim() !== '').join('\n')
    if (stripped !== '') parts.push(stripped)
  }
  if (parts.length === 0) return undefined
  const joined = parts.join('\n').trim()
  return joined === '' ? undefined : joined
}

/** 截到 max 字,超出的尾部加「…」。按码点数,一个汉字、一个 emoji 都算一个字。 */
export function clipText(text: string, max: number): string {
  const trimmed = text.trim()
  const chars = Array.from(trimmed)
  return chars.length <= max ? trimmed : `${chars.slice(0, max).join('')}…`
}

/** summary 的截断:200 字 + 「…」。 */
export function summarizeText(text: string): string {
  return clipText(text, SUMMARY_MAX)
}

/**
 * 写类工具白名单(与 dsh-context 的 shared/fileOps.ts 同一份判断)。
 * `bash` 故意不在其中:它可能改文件,但从命令行里猜不出改了哪个,宁可少数也不猜(D13)。
 */
const WRITE_TOOLS: ReadonlySet<string> = new Set(['write', 'edit', 'str_replace_editor'])

export function isWriteTool(name: string): boolean {
  return WRITE_TOOLS.has(name)
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** 工具入参是一段 JSON 字符串;解析不了就是"没有路径",不猜。 */
function parseArgs(raw: unknown): Record<string, unknown> | undefined {
  if (typeof raw !== 'string' || raw === '') return undefined
  try {
    return asRecord(JSON.parse(raw))
  }
  catch {
    return undefined
  }
}

/** 取工具入参里的目标路径。字段名顺序照抄 dsh-context 的 pathOfArgs。 */
function pathOfArgs(args: Record<string, unknown>): string | undefined {
  for (const key of ['file_path', 'filePath', 'path']) {
    const value = args[key]
    if (typeof value === 'string' && value !== '') return value
  }
  return undefined
}

/** turn 结束的成因 → 我们的状态。DSH 的 TurnEndReasonMap 有六种,只有两种算"出错"。 */
function fromTurnEnd(reason: Record<string, unknown> | undefined): DshStatusChange {
  const reasonKind = reason?.kind
  // 真出错了(含 max-tokens):等待原因分类里的「出错」那一档。
  // 原话:DSH 的 TurnEndReasonMap.error 带结构化的 `error: { message, code }`(LlmFailure),只取 message。
  if (reasonKind === 'error' || reasonKind === 'max-tokens') {
    const message = asRecord(reason?.error)?.message
    const detail = typeof message === 'string' && message.trim() !== '' ? message.trim() : undefined
    return { type: 'error', reason: 'error', wait_reason: 'error', ended: { kind: 'error', ...(detail === undefined ? {} : { detail }) } }
  }
  // aborted = 有人按了停止。界面上该说「已中断」而不是「出错了」,两者在 Ben 眼里不是一回事。
  // **不填 wait_reason**:它既不是出错,也不是在等谁——是他自己按的停止(D13)。
  if (reasonKind === 'aborted') return { type: 'error', reason: 'interrupted', ended: { kind: 'aborted' } }
  return { type: 'done', reason: 'stop', ended: { kind: 'done' } }
}

/** 去掉 pendingAssistant(exactOptionalPropertyTypes 下不能赋 undefined,只能整个字段不要)。 */
function withoutPending(state: DshFoldState): DshFoldState {
  const { pendingAssistant: _dropped, ...rest } = state
  return rest
}

/**
 * 一条 DSH 事件 → 新状态 + 可能的状态变化。
 *
 * 与投影单元同一条纪律:不关心的事件**返回同一个 state 引用**——上层据此判断"要不要写数字",
 * 每条 assistant/chunk 都造一个新对象等于把变化信号变成噪音。
 */
export function foldDshEvent(state: DshFoldState, event: DshEventLike): DshFoldResult {
  const data = asRecord(event.data)

  switch (event.type) {
    case 'turn/start':
      // 新回合开始:本回合的累计文字清零,但 **summary 不清**——手机上要留着上一句直到新回复来。
      return {
        state: state.pendingAssistant === undefined ? state : withoutPending(state),
        event: { type: 'running' },
      }

    case 'approval/asked':
      // 唯一一档"等你"。PRD §7.2:只有等审批这种到时才允许响铃。
      return { state, event: { type: 'waiting', reason: 'permission_prompt', wait_reason: 'approval' } }

    case 'approval/decided':
      // 你处理完了,它接着干。不管你是批还是拒,会话都回到"在跑"。
      return { state, event: { type: 'running' } }

    case 'turn/end': {
      const event = fromTurnEnd(asRecord(data?.reason))
      // 有话就结算成 summary;整个回合一个字都没说就**不动** summary(取不到就不填,不编,也不擦)。
      const pending = state.pendingAssistant
      if (pending === undefined) return { state, event }
      return { state: { ...withoutPending(state), summary: summarizeText(pending) }, event }
    }

    case 'user/message': {
      // data 就是 UserMessage。只认**人**说的,其余按来源分类丢掉(见 authorOfUserMessage)。
      const author = authorOfUserMessage(data?.source)
      // 后台任务做完唤醒:认出来往上报一条 notice,但**不当他说的话**——
      // 不进回合列表、不结算 summary、不动计数。之后那个回合照常走 turn/start → turn/end。
      if (author.kind === 'job-notice') return { state, notice: { kind: 'job-done', ...(author.summary === undefined ? {} : { summary: author.summary }) } }
      // 定时任务提醒、时间上下文、子代理结算、规矩表…… 整条丢掉,一个字都不留。
      if (author.kind === 'system') return { state }
      const text = plainTextOf(data?.content)
      if (text === undefined) return { state }
      return { state, turn: { role: 'user', text } }
    }

    case 'assistant/message': {
      // data 是 { turn, step, message: AssistantMessage }。一个回合可能有好几步,
      // 只有工具调用没有文字的那一步不算话,不覆盖前一步说的。
      const text = plainTextOf(asRecord(data?.message)?.content)
      if (text === undefined) return { state }
      return { state: { ...state, pendingAssistant: text }, turn: { role: 'assistant', text } }
    }

    case 'session/title': {
      const title = data?.title
      if (typeof title !== 'string' || title === '' || title === state.title) return { state }
      return { state: { ...state, title } }
    }

    case 'tool/call': {
      const name = data?.name
      if (typeof name !== 'string' || !isWriteTool(name)) return { state }
      const args = parseArgs(data?.arguments)
      if (args === undefined) return { state }
      // str_replace_editor 是唯一一个"用途看入参"的文件工具:view 是读,其余都是写。
      if (name === 'str_replace_editor' && args.command === 'view') return { state }
      const path = pathOfArgs(args)
      if (path === undefined || state.writtenPaths.has(path)) return { state }
      const writtenPaths = new Set(state.writtenPaths)
      writtenPaths.add(path)
      return { state: { ...state, writtenPaths, filesChanged: writtenPaths.size } }
    }

    default:
      return { state }
  }
}

/** token-meter 的 `tokenUsage` 投影值(实测形状)。 */
export interface DshTokenUsage {
  uncachedInputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

/** token-meter 的 `contextPressure` 投影值(实测形状)。 */
export interface DshContextPressure {
  pressureTokens?: number
  projectedTokens?: number
  contextWindow?: number
}

/** dsh-context 的 `contextTimeline` 投影值,我们只读这一个字段(其余是它自己界面的事)。 */
export interface DshContextTimeline {
  current?: { total?: number }
}

/**
 * 缓存命中率。口径与用量面板(UsagePanel 的 cacheHitRate)**逐字一致**:
 * 读 /(读 + 未命中输入),缓存写不进分母。两处口径不同的话,同一个屏幕上会出现两个"缓存命中",
 * 而它们谁也解释不了谁。
 *
 * 分母为 0 时返回 undefined——报 0% 会被读成"缓存一次没命中",而真相是"还没有可判断的请求"。
 */
export function cacheHitPct(usage: DshTokenUsage | undefined): number | undefined {
  if (usage === undefined) return undefined
  const read = typeof usage.cacheReadTokens === 'number' ? usage.cacheReadTokens : 0
  const input = typeof usage.uncachedInputTokens === 'number' ? usage.uncachedInputTokens : 0
  const denominator = read + input
  if (denominator <= 0) return undefined
  return Math.round((read / denominator) * 100)
}

export interface DshMetricsInput {
  // 显式带 undefined:tsconfig 开了 exactOptionalPropertyTypes,而这三样"还没到"是常态,
  // 调用方直接把 undefined 传进来比每次拼对象干净。
  tokenUsage: DshTokenUsage | undefined
  contextPressure: DshContextPressure | undefined
  contextTimeline: DshContextTimeline | undefined
  filesChanged: number
}

/**
 * 会话行上的三个数字。**每个都独立**:拿不到的那个整个不出现,不占位、不填 0(D13)。
 *
 * 上下文优先用 token-meter 的 `contextPressure.pressureTokens`——那是**厂商回报**的下一次请求
 * 占用量,比 dsh-context 的启发式估算准;dsh-context 的 `contextTimeline.current.total` 作后备
 * (它在 token-meter 缺席、或投影还没算出压力值时仍然有数)。
 */
export function metricsFrom(input: DshMetricsInput): SessionMetrics {
  const metrics: { context_tokens?: number, cache_hit_pct?: number, files_changed?: number } = {}

  const pressure = input.contextPressure?.pressureTokens
  const estimated = input.contextTimeline?.current?.total
  if (typeof pressure === 'number' && pressure > 0) metrics.context_tokens = pressure
  else if (typeof estimated === 'number' && estimated > 0) metrics.context_tokens = estimated

  const hit = cacheHitPct(input.tokenUsage)
  if (hit !== undefined) metrics.cache_hit_pct = hit

  // 0 个文件不显示:「改了 0 个文件」在行上占一格却什么也没说。
  if (input.filesChanged > 0) metrics.files_changed = input.filesChanged

  return metrics
}

export interface DshSessionFeedOptions {
  /** 吃进一条上报——生产传 `service.applyEvent`。 */
  applyEvent: (event: WorkbenchEvent) => void
  /** 写会话行上的三个数字。不产生状态变化,也就不触发广播(见下面 handleProjection 的注释)。 */
  setMetrics: (sessionId: string, metrics: SessionMetrics) => void
  /** 当前 Unix 秒。 */
  now?: () => number
  /** 按 cwd 找项目名(生产复用 resolveCodexProject——它本来就是通用的,名字里的 codex 只是出身)。 */
  resolveProject?: (cwd: string) => Promise<string | undefined>
  /**
   * 会话结束端口(2026-09-16 事项生命周期闭环):每条 turn/end 报一次它怎么结束的,
   * 事项那边(butlerLifecycle)据此把「我交给事务官」的卡从 doing 挪走。**只报一次**——
   * 项目名查到后的补报(resolveAndBackfill)不再走这里,免得同一条结束过渡两遍。
   * 实现方抛了也不能带走状态上报:这里兜 try/catch。
   */
  onSessionEnd?: (sessionId: string, end: DshSessionEnd) => void
  /**
   * 这条会话又动了一下(2026-09-25,卡 O「每件事花费 / 时长上限」):一回合开始、调一次模型、结束时各叫一次,
   * 上限那一层据此立刻看一眼花了多少(不用等下一拍)。实现方抛了也不连累上报。
   */
  onActivity?: (sessionId: string) => void
  /**
   * 最近在做什么(2026-09-25,卡 P):模型说了一段话 → 那段话的第一句人话;调了一个工具 → 按种类说一句
   * (「在改文件」)。不建行、不改状态(sessions.ts setDetail);**不推快照**(工具一秒能调好几次,
   * 界面本来就一秒一拍拉 /state,同 setMetrics 的纪律)。
   */
  setDetail?: (sessionId: string, detail: { activity: SessionActivity }) => void
}

/**
 * 一条会话到现在花了多少(2026-09-25,卡 O)。**全在内存里**:工作台重启之后从零数起
 * (钱那一半 token-meter 的投影会重新推过来,时间那一半只能从重启那一刻起算 —— 交接里写明)。
 */
export interface DshSessionUsage {
  /** 最近一次请求用的模型(`request/header` 里那个)。 */
  model?: string
  /** 调了几次模型(`step/start` 的次数)。 */
  steps: number
  /** **在跑**的毫秒数:每一回合 turn/start → turn/end 加起来(等他批 / 等他回话不算)。 */
  run_ms: number
  /** 此刻正在跑一回合。 */
  running: boolean
  tokenUsage?: DshTokenUsage
}

/**
 * 一条会话的出身(2026-09-25,卡 U3:接卡 Q 的 `children`)。
 *
 * 0.1.7 里**子代理就是一条普通会话**,没有 `subagents/` 目录(那是 Claude 的做法);
 * 认它靠会话头上 `origin: 'subagent'` + `parentSession` 两个字段一起出现。这两个字段
 * 在 `session/created` 送过来的 `session.header` 上就有(上游 `core/session/src/index.ts`
 * 的 `readonly header: SessionHeader`),与它落盘那份 `session.v4.jsonl` 的首行是同一份东西
 * (上游 `session-persistence-jsonl/src/format.ts` 的 `HeaderLine`),所以同一个判据
 * ({@link dshSubagentOf})两边都用得上。
 */
export interface DshSessionOrigin {
  cwd?: string
  /** 上游只有 `'subagent'` 这一个值;别的值当没有。 */
  origin?: string
  parentSession?: string
}

export interface DshSessionFeed {
  /** `session/created`:记住 cwd(项目归属的唯一依据)与出身(是不是谁派出去的子代理)。 */
  handleCreated: (sessionId: string, origin?: DshSessionOrigin | string) => void
  /**
   * 这条会话是谁派出去的子代理 → 父会话 id;不是子代理(或不认识它)→ undefined。
   * 给卡 Q 的 `children` 用(`server/sessionChildren.ts`)。
   */
  parentOf: (sessionId: string) => string | undefined
  /** `session/event`:状态与文件计数。 */
  handleEvent: (sessionId: string, event: DshEventLike) => void
  /** `sessionProjections.onChanged`:三个数字里的两个。 */
  handleProjection: (sessionId: string, key: string, value: unknown) => void
  /** `session/disposed`:会话没了,报离线并丢掉内存状态。 */
  handleDisposed: (sessionId: string) => void
  /**
   * 最近 limit 个回合(时间顺序)。会话不认识 → undefined(HTTP 层据此 404);
   * 认识但还没说过话 → 空数组。给 GET /butler/item/:id/turns 用。
   */
  turns: (sessionId: string, limit: number) => SessionTurn[] | undefined
  /** 当前记着几条会话(测试与自检用)。 */
  size: () => number
  /** 一条会话到现在花了多少(卡 O 的上限用)。不认识 → undefined。 */
  usage: (sessionId: string) => DshSessionUsage | undefined
  /**
   * 这条会话最近钉在哪一家、哪个模型(2026-10-23 运行时 P1:模型设置变更后,
   * 据这个把受控会话重指到新目标 —— 见 modelRetarget.ts)。不认识 → undefined。
   */
  selectionOf: (sessionId: string) => { provider?: string, model?: string } | undefined
  /** 在册会话各自的选择(2026-10-23 重指编排要枚举;没说过话的会话 provider/model 缺席)。 */
  selections: () => { sessionId: string, provider?: string, model?: string }[]
}

interface Tracked {
  fold: DshFoldState
  /**
   * 我们**真的替这条会话报过状态**了吗。
   *
   * 只在报过之后才允许发 offline:`session/created` 一来就建表,但 DSH 会新建一些
   * 从没走到 turn/start 的会话(实测:网页上光是点开输入框就会 created 两条),
   * 给它们补一条 offline 等于替一个界面上根本没出现过的东西宣布结束。
   */
  reported: boolean
  /** 这条会话的回合(人一句、模型一段),最多留 TURNS_KEPT 条。 */
  turns: SessionTurn[]
  cwd?: string
  project?: string
  tokenUsage?: DshTokenUsage
  contextPressure?: DshContextPressure
  contextTimeline?: DshContextTimeline
  /** 卡 O:模型、调了几次、在跑多久。 */
  model?: string
  /** 最近一次请求走哪一家(2026-10-23:`request/header` 的 config.provider,模型设置变更后重指受控会话用)。 */
  provider?: string
  /** DSH durable modelSelection 的 next；不把待选模型混进实际请求用量。 */
  nextSelection?: { provider: string, model: string }
  steps: number
  runMs: number
  runSince?: number | undefined
  /** 在一回合里(turn/start 之后、turn/end 之前);等他批的那一段计时停着,批完接着计。 */
  inTurn?: boolean
}

/**
 * 接线层:一张 sessionId → 状态的内存表,加四个入口。
 *
 * 状态只在内存里,与 service.ts 同一条纪律(PRD §2.2 不落库);DSH 重启即清空,
 * 而 DSH 重启时会话本来也没了,没有"重启后滞留的僵尸会话"这个问题
 * (那是 Claude 的 hook 才有的毛病,由 claudeSessionRecover 单独治)。
 */
/**
 * 哨兵(server/sentinel.ts)也往 `agent:'dsh'` 这个桶里写会话,它的 session_id 是
 * `sentinel:<监视项 id>`。真实 DSH 会话 id 是 UUID,撞不上;但两条线共用一个桶,
 * 边界要写死而不是靠"应该不会撞":带这个前缀的 id 一律不认,免得哪天谁改了 id 生成方式,
 * 我们把哨兵那行会话的状态覆盖掉(它是 waiting/idle_prompt,被覆盖成 running 就没人看得见了)。
 */
const SENTINEL_ID_PREFIX = 'sentinel:'

export function createDshSessionFeed(options: DshSessionFeedOptions): DshSessionFeed {
  const sessions = new Map<string, Tracked>()
  /**
   * 子代理 → 派它的那条会话(卡 U3)。**故意不和 `sessions` 放一起**:那张表在
   * `session/disposed` 时整条删掉,而会话表里那一行还留着(状态被我们报成 offline)。
   * 出身跟着删的话,子代理一办完就会从父卡底下掉出来、变成列表上凭空多出的一行 ——
   * 恰好是卡 Q 要避免的那种「卡片会非常多」。出身是**不会变的事实**,记住就不用忘:
   * 只在认出 `origin==='subagent'` 时才存一条(一条会话一个字符串),DSH 重启即清空。
   */
  const parents = new Map<string, string>()
  const now = options.now ?? (() => Math.floor(Date.now() / 1000))

  function trackedFor(sessionId: string): Tracked {
    let tracked = sessions.get(sessionId)
    if (tracked === undefined) {
      tracked = { fold: emptyDshFold(), reported: false, turns: [], steps: 0, runMs: 0 }
      sessions.set(sessionId, tracked)
    }
    return tracked
  }

  function pushMetrics(sessionId: string, tracked: Tracked): void {
    const metrics = metricsFrom({
      tokenUsage: tracked.tokenUsage,
      contextPressure: tracked.contextPressure,
      contextTimeline: tracked.contextTimeline,
      filesChanged: tracked.fold.filesChanged,
    })
    // 一个数字都没有就别写——空对象会把已有的数字擦掉。
    if (Object.keys(metrics).length === 0) return
    options.setMetrics(sessionId, metrics)
  }

  function emit(
    sessionId: string,
    tracked: Tracked,
    change: DshStatusChange,
  ): void {
    const base: WorkbenchEvent = {
      agent: 'dsh',
      session_id: sessionId,
      type: change.type,
      ts: now(),
      ...(change.reason === undefined ? {} : { reason: change.reason }),
      ...(change.wait_reason === undefined ? {} : { wait_reason: change.wait_reason }),
      ...(tracked.cwd === undefined ? {} : { cwd: tracked.cwd }),
      ...(tracked.project === undefined ? {} : { project: tracked.project }),
      ...(tracked.fold.title === undefined ? {} : { title: tracked.fold.title }),
      // 与 title 同一条路:sessions.ts 对没带 summary 的上报沿用上一次的值,带了就顶掉。
      ...(tracked.fold.summary === undefined ? {} : { summary: tracked.fold.summary }),
    }
    tracked.reported = true
    options.applyEvent(base)
  }

  /**
   * 项目归属要查 git,是异步的;状态变化不能等它。
   * 所以:先按已知信息报一条,查到项目名之后**再补报一条同状态的**——
   * applyEvent 对同状态重复上报是幂等的(sessions.ts 的 statusFingerprint 认成"没进入新状态",
   * 计时不会被打断),补报只是把 project 填上去。
   */
  function resolveAndBackfill(sessionId: string, tracked: Tracked, change: DshStatusChange): void {
    const cwd = tracked.cwd
    const resolve = options.resolveProject
    if (cwd === undefined || resolve === undefined || tracked.project !== undefined) return
    void Promise.resolve()
      .then(async () => resolve(cwd))
      .then((project) => {
        if (project === undefined || project === '') return
        tracked.project = project
        emit(sessionId, tracked, change)
      })
      // 查不到项目名不是错误(D13:宁可标未归类也不编),查询本身抛错更不能把上报带走。
      .catch(() => {})
  }

  return {
    // 第二个参数兼容老调用法(只给 cwd 一个字符串):接线处按会话头整个传进来,
    // 用例里还有直接给 cwd 的,两种都收。
    handleCreated(sessionId, origin) {
      if (sessionId.startsWith(SENTINEL_ID_PREFIX)) return
      const tracked = trackedFor(sessionId)
      const header: DshSessionOrigin = typeof origin === 'string' ? { cwd: origin } : origin ?? {}
      if (typeof header.cwd === 'string' && header.cwd !== '') tracked.cwd = header.cwd
      const lineage = dshSubagentOf({ ...header, id: sessionId, version: 0 })
      if (lineage !== undefined) parents.set(sessionId, lineage.parent)
    },

    parentOf(sessionId) {
      return parents.get(sessionId)
    },

    handleEvent(sessionId, event) {
      if (sessionId.startsWith(SENTINEL_ID_PREFIX)) return
      try {
        const tracked = trackedFor(sessionId)
        const activity = trackUsage(tracked, event)
        const result = foldDshEvent(tracked.fold, event)
        const changedFiles = result.state.filesChanged !== tracked.fold.filesChanged
        tracked.fold = result.state
        if (changedFiles) pushMetrics(sessionId, tracked)
        if (result.turn !== undefined) {
          tracked.turns.push({
            role: result.turn.role,
            text: clipText(result.turn.text, TURN_TEXT_MAX),
            at: new Date(now() * 1000).toISOString(),
          })
          if (tracked.turns.length > TURNS_KEPT) tracked.turns.splice(0, tracked.turns.length - TURNS_KEPT)
        }
        if (activity) {
          try { options.onActivity?.(sessionId) }
          catch { /* 上限那一层抛了不连累上报 */ }
        }
        // 最近在做什么(2026-09-25,卡 P):她说的那段话 / 她调的那个工具。说出来的话优先,工具只在没话时顶上。
        if (options.setDetail !== undefined) {
          const at = new Date(now() * 1000).toISOString()
          if (result.turn?.role === 'assistant') {
            const line = humanize(result.turn.text, ACTIVITY_MAX)
            if (line !== undefined) options.setDetail(sessionId, { activity: { line, at } })
          }
          else if (event.type === 'tool/call') {
            const data = asRecord(event.data)
            options.setDetail(sessionId, { activity: { line: activityOfTool(data?.name, parseArgs(data?.arguments)), at } })
          }
        }
        if (result.event === undefined) return
        emit(sessionId, tracked, result.event)
        resolveAndBackfill(sessionId, tracked, result.event)
        if (result.event.ended !== undefined && options.onSessionEnd !== undefined) {
          try {
            // 改了几个文件一起报上去(卡 Y):事项那边据此判「这一轮算不算一件事」。
            // 取的是**这一刻**的累计数(fold 已经算进 tracked.fold 了),不是这一个回合内的增量 ——
            // 一条会话里改过文件,整条会话就不是"随手问一句"。
            options.onSessionEnd(sessionId, { ...result.event.ended, ts: now(), filesChanged: tracked.fold.filesChanged })
          }
          catch {
            // 事项过渡失败不该让会话状态少报一条;它自己有落盘失败的兜底(butlerLifecycle)。
          }
        }
      }
      catch {
        // 事件回调里抛出会污染 DSH 自己的事件派发;宁可漏一条上报。
      }
    },

    handleProjection(sessionId, key, value) {
      if (sessionId.startsWith(SENTINEL_ID_PREFIX)) return
      try {
        const tracked = sessions.get(sessionId) ?? trackedFor(sessionId)
        const record = asRecord(value)
        if (record === undefined) return
        if (key === 'modelSelection') {
          const next = asRecord(record.next)
          if (next === undefined) delete tracked.nextSelection
          else if (typeof next.provider === 'string' && next.provider !== '' && typeof next.model === 'string' && next.model !== '') {
            tracked.nextSelection = { provider: next.provider, model: next.model }
          }
          return
        }
        if (key === 'tokenUsage') tracked.tokenUsage = record as DshTokenUsage
        else if (key === 'contextPressure') tracked.contextPressure = record as DshContextPressure
        else if (key === 'contextTimeline') tracked.contextTimeline = record as DshContextTimeline
        else return
        // **只写数字,不发状态事件**:投影每条事件都在变(实测一次三步会话变了三十多次),
        // 每次都当状态变化就等于把 WS 快照推成风暴。数字由界面下一次 GET /state 带走。
        pushMetrics(sessionId, tracked)
      }
      catch {
        // 同上:投影变化回调抛出会卡死该会话的推送(dsh-context logShapes.ts 的教训)。
      }
    },

    handleDisposed(sessionId) {
      if (sessionId.startsWith(SENTINEL_ID_PREFIX)) return
      try {
        const tracked = sessions.get(sessionId)
        if (tracked === undefined) return
        // 只收自己报过的那条(见 Tracked.reported)。这一条同时是与**哨兵**共用
        // `agent:'dsh'` 这个桶的边界:哨兵的会话(session_id 形如 `sentinel:<id>`)
        // 由它自己生灭,我们从没报过,也就永远不会被这里收掉。
        if (tracked.reported) emit(sessionId, tracked, { type: 'offline', reason: 'offline' })
        sessions.delete(sessionId)
      }
      catch {
        sessions.delete(sessionId)
      }
    },

    turns(sessionId, limit) {
      if (sessionId.startsWith(SENTINEL_ID_PREFIX)) return undefined
      const tracked = sessions.get(sessionId)
      if (tracked === undefined) return undefined
      const count = Math.max(0, Math.floor(limit))
      return count === 0 ? [] : tracked.turns.slice(-count)
    },

    size: () => sessions.size,

    usage(sessionId) {
      const tracked = sessions.get(sessionId)
      if (tracked === undefined) return undefined
      const nowMs = now() * 1000
      return {
        ...(tracked.model === undefined ? {} : { model: tracked.model }),
        steps: tracked.steps,
        run_ms: tracked.runMs + (tracked.runSince === undefined ? 0 : Math.max(0, nowMs - tracked.runSince)),
        running: tracked.runSince !== undefined,
        ...(tracked.tokenUsage === undefined ? {} : { tokenUsage: tracked.tokenUsage }),
      }
    },

    selectionOf(sessionId) {
      const tracked = sessions.get(sessionId)
      if (tracked === undefined) return undefined
      if (tracked.nextSelection !== undefined) return { ...tracked.nextSelection }
      return {
        ...(tracked.provider === undefined ? {} : { provider: tracked.provider }),
        ...(tracked.model === undefined ? {} : { model: tracked.model }),
      }
    },

    selections: () => [...sessions.entries()].map(([sessionId, tracked]) => ({
      sessionId,
      ...(tracked.provider === undefined ? {} : { provider: tracked.provider }),
      ...(tracked.model === undefined ? {} : { model: tracked.model }),
      ...tracked.nextSelection,
    })),
  }

  /** 卡 O:记模型、调用次数、在跑的时间。回 true = 这一条算「动了一下」(上限那一层要看一眼)。 */
  function trackUsage(tracked: Tracked, event: DshEventLike): boolean {
    const data = asRecord(event.data)
    const nowMs = now() * 1000
    switch (event.type) {
      case 'request/header': {
        const config = asRecord(asRecord(data?.header)?.config)
        const model = config?.model
        if (typeof model === 'string' && model !== '') tracked.model = model
        const provider = config?.provider
        if (typeof provider === 'string' && provider !== '') tracked.provider = provider
        return false
      }
      case 'step/start':
        tracked.steps += 1
        return true
      case 'turn/start':
        tracked.inTurn = true
        if (tracked.runSince === undefined) tracked.runSince = nowMs
        return true
      case 'approval/asked':
        // 等他批:这一段不算她在跑(设计第 6 条「时长」说的是她自己干活的时间)。
        if (tracked.runSince !== undefined) {
          tracked.runMs += Math.max(0, nowMs - tracked.runSince)
          tracked.runSince = undefined
        }
        return false
      case 'approval/decided':
        if (tracked.inTurn === true && tracked.runSince === undefined) tracked.runSince = nowMs
        return false
      case 'turn/end':
        tracked.inTurn = false
        if (tracked.runSince !== undefined) {
          tracked.runMs += Math.max(0, nowMs - tracked.runSince)
          tracked.runSince = undefined
        }
        return true
      default:
        return false
    }
  }
}
