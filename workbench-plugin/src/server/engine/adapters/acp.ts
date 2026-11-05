/**
 * Codex 这一家走 **ACP 客户端**(2026-10-19,实验卡「ACP 客户端替 app-server 直连」;契约见 `../adapter.ts`,
 * 协议在 `./acpClient.ts`,经过、真机数字与结论见 `docs/交接-1019-ACP客户端实验.md`)。
 *
 * ★ **这是实验件,没登记进引擎**(维护者 10-19 下午定:纯实验,不开工、不求可合并)。
 * 没有任何生产代码 import 它;只有 `tests/engine-acp-adapter.test.ts`(假 ACP 代理)与
 * `scripts/probe-acp-compare.ts`(真机对比)用它。契约 `adapter.ts` 一个字没动,登记表、抽屉真路、`/asks/answer` 都没碰。
 *
 * ## 这一条与今天 `codex.ts`(app-server 直连)的差别只有一处
 *
 * **它问人的那一下接得住。** app-server 那条 `approvalPolicy: never` + 一律 `decline`,Codex 一要批准整件就挂;
 * 这一条把 `session/request_permission` 变成一条「它在问她」({@link AcpCodexAdapter.asks},形状见 {@link AcpAskView}:
 * 就是抽屉那一堆要的那几格),答它走契约里既有的 `press` 那一样(`run({kind:'press', text:<她点的那一项>})`→ 回 `selected{optionId}`),
 * 它接着跑。所以这一条的 `capabilities().press` 是 **true**(app-server 那条是 false)。
 *
 * ## 一句话对一条动作
 *
 * | 她要什么 | 这里怎么做 | 什么算送到 |
 * |---|---|---|
 * | `dispatch`(派活) | `session/new {cwd}` → `session/set_mode`(卡许改文件 = `workspace-write`,否则 `read-only`)→ `session/prompt` | `reply` 等它回 `{stopReason}`;`ack` 等第一个动静;`none` 发出去就算 |
 * | `answer` / `relay` | 这条进程里见过那一段就直接 `session/prompt`;没见过先 `session/load {sessionId, cwd}` | 同上 |
 * | `press` | 答挂着的那一问:`selected{optionId}`;**只认它给的那几项**,放宽那一项不摆也不按 | 回了就是回执 |
 * | `stop` | `session/cancel`;挂着的那一问按协议回 `cancelled` | 发了就是回执 |
 * | `write_ask` | 做不了:`unsupported`,引擎换窗口那条路 | — |
 *
 * `read` 只读**这条进程记着的**那一轮(在跑 → `busy`;说完 → 回话);工作台重启过 / 报的不是这一轮 → `unsupported`,
 * 引擎换下一条(app-server 那条 `thread/resume` 读得到:ACP 的 sessionId 就是 Codex 的 threadId,真机核过)。
 *
 * ## 权限那一档
 *
 * - 派活按卡:许改文件 → `workspace-write`,否则 `read-only`;两档的 approval 都是 `on-request`(它要问就问,问到抽屉里来);
 * - 替她答 / 捎话**不**动她那条对话的档(不调 `set_mode`);
 * - `agent-full-access`(= `never` + `danger-full-access`)**不许出现在这个文件里**;
 * - 她答之前这一轮就停在那儿等(与她在 Codex App 里不点一样);她不答要不要打电话由座机那套规矩定
 *   (`sessionAskCalls.ts`:`by:'form'`、挂满 20 秒、不超过一天)—— 接上去之后才生效,本卡没接。
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import type { WorkbenchEvent } from '../../../protocol.ts'
import type { SessionAskFullView, SessionAskKind, SessionAskOption } from '../../../protocol.ts'
import type { Adapter, AdapterCapabilities, AdapterReadResult, Job, JobResult } from '../adapter.ts'
import { RetryableError } from '../adapter.ts'
import type { AcpAgentLink, AcpConnection, AcpNotification } from './acpClient.ts'
import {
  ACP_AUTH_REQUIRED,
  ACP_METHODS,
  ACP_NOT_OURS,
  ACP_TIMEOUT_MS,
  AcpAgentGone,
  AcpRefused,
  AcpRequestError,
  CODEX_ACP_MODES,
  acpAgentLink,
  spawnCodexAcpPeer,
} from './acpClient.ts'
import { CODEX_FAMILY, CODEX_NO_DRAFT_WHY, type CodexWorkdir, findCodexBinary } from './codex.ts'

/** 抽屉里那一问的 `rule`(排查用;`by` 永远是 `form`:它真停在那儿等)。 */
export const ACP_RULE = 'form:acp'

/**
 * codex-acp 那几项怎么念(按 `optionId`;2.2.2 的 `ApprovalOptionId`)。
 * **只给三种**:批准这一次 / 两种不批。放宽那一种(`allow_for_session`,kind `allow_always`)**不在表里、不摆、不按** ——
 * 与窗口那条路「本次会话都允许」不替她按同一个分寸(决策记录待拍板那一条)。
 */
export const ACP_OPTION_LABELS: Readonly<Record<'allow_once' | 'decline' | 'cancel', string>> = {
  allow_once: '批准这一次',
  decline: '不批,让它跳过这一步',
  cancel: '不批,我另有交代',
}

/** 按 `optionId` 查那张表(表里没有的回 undefined,由调用方退回它的英文原字)。 */
export function acpOptionLabel(optionId: string): string | undefined {
  return (ACP_OPTION_LABELS as Readonly<Record<string, string | undefined>>)[optionId]
}

/** 这几种 kind 的选项不摆(放宽往后的权限)。 */
export const ACP_HIDDEN_OPTION_KINDS: readonly string[] = ['allow_always']

/** 它这一步是哪一类(ACP `ToolKind`)→ 人话。 */
const TOOL_VERB: Readonly<Record<string, string>> = {
  execute: '跑一条命令',
  edit: '改文件',
  delete: '删文件',
  move: '挪文件',
  fetch: '上网取东西',
  read: '读文件',
  search: '搜东西',
}

/** 人话问题最多多少字(与 `SessionAskView.question` 同一条「截 60 字」)。 */
const QUESTION_MAX = 60

function clip(text: string, max: number): string {
  const chars = [...text]
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`
}

/**
 * 哪一段算「它的回答」:**最后那一段**(与 app-server 那条 `pickCodexReply` 认收尾那句同一个意思 ——
 * 真机 10-19 第一跑:ACP 把过场话「我会按工作偏好检查当前目录…」与收尾那句一起流回来,拼在一起就不是它的回答)。
 * 没报 messageId 的几截归在同一段。**不编一句**:一个字都没说就 undefined。
 */
export function acpReplyOf(said: readonly { id?: string, text: string }[]): string | undefined {
  const last = said.at(-1)?.text.trim()
  return last === undefined || last === '' ? undefined : last
}

/** 抽屉里那一句:「Codex 要跑一条命令,批不批:touch hello.txt」。一处写,电话里念的也是它。 */
export function acpQuestionOf(input: { who: string, title: string, kind?: string }): string {
  const verb = (input.kind === undefined ? undefined : TOOL_VERB[input.kind]) ?? '做一步'
  const head = `${input.who} 要${verb},批不批:`
  return clip(`${head}${input.title.trim()}`, QUESTION_MAX)
}

/** 挂着的一问(内部形状)。 */
interface PendingAsk {
  sessionId: string
  since: string
  title: string
  kind?: string
  detail?: string
  /** 摆给她的那几项(放宽那一种已经去掉)。 */
  options: readonly { optionId: string, name: string, kind: string, label: string }[]
  /** 答它:选了哪一项 / 撤了。 */
  settle: (outcome: { outcome: 'selected', optionId: string } | { outcome: 'cancelled' }) => void
}

interface TurnEnd {
  stopReason?: string
  /** 失败 / 被打断 / 断线时的人话。 */
  why?: string
  /** `session/prompt` 那一问本身被拒(它根本没开跑)。 */
  refused?: true
}

/** 它说的一段(按 `messageId` 分段;没报 id 的那几截归到同一段)。 */
interface Said {
  id?: string
  text: string
}

/** 这条进程记着的一轮。 */
interface Turn {
  id: string
  sessionId: string
  /** 它说过的几段话(顺序照原样)。 */
  said: Said[]
  /** 到了几个动静(任何 `session/update` / 它反过来问我们)。 */
  signals: number
  end?: TurnEnd
  wakers: Set<() => void>
}

export interface AcpAdapterDeps {
  /** 那一条长连接。缺席 = 自己起一条(真机用法)。 */
  link?: AcpAgentLink
  /** 这台机器上的 `codex` 在哪;找不到回 undefined。缺席 = 现查 PATH 与 ChatGPT.app。 */
  binary?: () => string | undefined
  /** 这张卡在哪个目录干、许不许改文件(与 `codex.ts` 同一只手:`wireHands.codexWorkdirOf`)。缺席 = 不许改。 */
  workdir?: (job: Job) => CodexWorkdir | Promise<CodexWorkdir>
  /** 这件活的卡标题(会话表上那一行用)。缺席 / 查不到 = 交代第一行。 */
  title?: (job: Job) => string | undefined | Promise<string | undefined>
  /**
   * **会话表的口**(`service.applyEvent`):派出去 → 在跑;它问她 → 等你批;答了 → 在跑;说完 → 做完。
   * 没有这一格 `/state.sessions` 里就没有这条会话,抽屉那一问也就没处挂。缺席 = 不报(用例)。
   */
  events?: (event: WorkbenchEvent) => void
  /** 抽屉那一堆变了(挂上一问 / 答了 / 撤了)→ 推一份快照。 */
  onChange?: () => void
  /** 这一家叫什么(问题里用)。缺席 = `Codex`。 */
  name?: string
  now?: () => number
  warn?: (line: string) => void
  /** 覆盖几样时限(用例用)。 */
  timeouts?: Partial<{ ack: number, turn: number, request: number }>
  /** 真机起进程那几样(`npx` 在哪、日志去哪)。 */
  spawn?: { npx?: string, logsDir?: string, stderr?: 'ignore' | 'inherit' | 'pipe', onStderr?: (chunk: string) => void }
}

/**
 * **「它在问她」那一问该长成什么形状**(抽屉那一堆要的那几格;与 `waitingForYou.WaitVerdict` 里 `by:'form'` 那一种一一对应)。
 * 接上去的那一步(待拍板)是:`waitingService.overlay` 多一格可选输入,把这几格叠成那条会话的 `ask`
 * —— 这样 `/state.waiting` 多一行 `session:codex/<threadId>`、`/asks/answer {choice}` 照旧走 `sessionJobs.press` → 引擎 `press`,一处都不用改。
 */
export interface AcpAskView {
  agent: string
  session_id: string
  kind: SessionAskKind
  /** 一句人话(≤60 字)。 */
  question: string
  /** 它给的那几项(放宽那一种已经去掉)。 */
  options: readonly SessionAskOption[]
  /** 原文(它的原话 + 命令原字)。 */
  full?: SessionAskFullView
  since: string
  quote?: string
  by: 'form'
  rule: string
}

export interface AcpCodexAdapter extends Adapter {
  /** 此刻挂着的那几问(抽屉那一堆该读的就是它)。 */
  asks: () => readonly AcpAskView[]
  /** 工作台停的时候叫一次。 */
  close: () => void
}

const NOTHING: AdapterCapabilities = {
  open: false, send: false, read: false, press: false, approve: false, writeAsk: false, stop: false, openSession: false,
}

function record(value: unknown): Record<string, unknown> | undefined {
  return (typeof value === 'object' && value !== null) ? value as Record<string, unknown> : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function unsupported(why: string): JobResult {
  return { delivered: 'not_sent', via: 'none', evidence: 'none', unsupported: true, why }
}

function notSent(why: string): JobResult {
  return { delivered: 'not_sent', via: 'protocol', evidence: 'none', why }
}

/** 它这一步的原字(命令 / 文件),给她点开看。 */
function detailOf(toolCall: Record<string, unknown> | undefined): string | undefined {
  const raw = record(toolCall?.rawInput)
  const command = raw?.command
  if (typeof command === 'string' && command.trim() !== '') return command
  if (Array.isArray(command)) return command.filter((one): one is string => typeof one === 'string').join(' ')
  const locations = Array.isArray(toolCall?.locations) ? toolCall.locations : []
  const paths = locations.map(one => text(record(one)?.path)).filter((one): one is string => one !== undefined)
  return paths.length === 0 ? undefined : paths.join(' ')
}

/**
 * ACP 客户端适配器(Codex)。一个实例 = 一条长连接(断了下一次自己重起)+ 这条进程记着的那几轮 / 那几问。
 */
export function acpCodexAdapter(deps: AcpAdapterDeps = {}): AcpCodexAdapter {
  const now = deps.now ?? (() => Date.now())
  const warn = deps.warn ?? ((line: string) => { console.log(line) })
  const who = deps.name ?? 'Codex'
  const binary = deps.binary ?? (() => findCodexBinary(process.env.PATH, existsSync))
  const workdir: NonNullable<AcpAdapterDeps['workdir']> = deps.workdir ?? (() => ({ writes: false }))
  const cardTitle: NonNullable<AcpAdapterDeps['title']> = deps.title ?? (() => undefined)
  const ackMs = deps.timeouts?.ack ?? ACP_TIMEOUT_MS.ack
  const turnMs = deps.timeouts?.turn ?? ACP_TIMEOUT_MS.turn

  /** 挂着的那几问(一条会话同一时刻只有一问:Codex 等答了才往下走)。 */
  const pending = new Map<string, PendingAsk>()
  /** 这条进程记着的最后一轮(按会话)。 */
  const turns = new Map<string, Turn>()
  /** 这条连接上开过 / 接上过的会话(重连就忘:新进程不认识它们,要 `session/load`)。 */
  const known = new Set<string>()
  /** 会话表上那一行叫什么。 */
  const titles = new Map<string, string>()
  let turnSeq = 0

  const changed = (): void => { try { deps.onChange?.() } catch { /* 看客的事 */ } }
  const emit = (sessionId: string, event: Omit<WorkbenchEvent, 'agent' | 'session_id' | 'ts'>): void => {
    if (deps.events === undefined) return
    const title = titles.get(sessionId)
    try {
      deps.events({
        agent: CODEX_FAMILY,
        session_id: sessionId,
        ...(title === undefined ? {} : { title }),
        ts: Math.floor(now() / 1000),
        ...event,
      })
    }
    catch (error) { warn(`ACP:会话表那一口抛了(${error instanceof Error ? error.message : String(error)})`) }
  }

  /** 答掉 / 撤掉一问(回它、从抽屉里拿掉、会话表改回在跑)。 */
  const settleAsk = (sessionId: string, outcome: Parameters<PendingAsk['settle']>[0]): boolean => {
    const ask = pending.get(sessionId)
    if (ask === undefined) return false
    pending.delete(sessionId)
    ask.settle(outcome)
    const turn = turns.get(sessionId)
    if (turn !== undefined && turn.end === undefined) emit(sessionId, { type: 'running' })
    changed()
    return true
  }

  /** 它反过来问我们:只接权限那一问,别的「没这个方法」。 */
  const onRequest = (method: string, params: Record<string, unknown>): Promise<unknown> => {
    if (method !== ACP_METHODS.requestPermission) throw new AcpRequestError(ACP_NOT_OURS, `工作台这条路不接 ${method}`)
    const sessionId = text(params.sessionId)
    if (sessionId === undefined) throw new AcpRequestError(-32602, '权限请求里没有 sessionId')
    const toolCall = record(params.toolCall)
    const title = text(toolCall?.title) ?? '一步没说明的操作'
    const kind = text(toolCall?.kind)
    const detail = detailOf(toolCall)
    const options = (Array.isArray(params.options) ? params.options : [])
      .map(record)
      .filter((one): one is Record<string, unknown> => one !== undefined)
      .map(one => ({ optionId: text(one.optionId) ?? '', name: text(one.name) ?? '', kind: text(one.kind) ?? '' }))
      .filter(one => one.optionId !== '' && !ACP_HIDDEN_OPTION_KINDS.includes(one.kind))
      .map(one => ({ ...one, label: acpOptionLabel(one.optionId) ?? one.name }))
    return new Promise<unknown>((resolve) => {
      // 同一条会话上一问还挂着(不该发生:它等答了才问下一句)→ 上一问按撤了算,不留两问。
      settleAsk(sessionId, { outcome: 'cancelled' })
      pending.set(sessionId, {
        sessionId,
        since: new Date(now()).toISOString(),
        title,
        ...(kind === undefined ? {} : { kind }),
        ...(detail === undefined ? {} : { detail }),
        options,
        settle: outcome => resolve({ outcome }),
      })
      const turn = turns.get(sessionId)
      if (turn !== undefined) { turn.signals += 1; for (const wake of [...turn.wakers]) wake() }
      emit(sessionId, { type: 'waiting', reason: 'permission_prompt', wait_reason: 'approval', formal_wait: 'approval' })
      changed()
    })
  }

  const link = deps.link ?? acpAgentLink({
    clientName: 'desktop-workbench',
    spawnPeer: async () => await spawnCodexAcpPeer({
      ...(binary() === undefined ? {} : { codexBinary: binary() as string }),
      ...(deps.spawn?.npx === undefined ? {} : { npx: deps.spawn.npx }),
      ...(deps.spawn?.logsDir === undefined ? {} : { logsDir: deps.spawn.logsDir }),
      ...(deps.spawn?.stderr === undefined ? {} : { stderr: deps.spawn.stderr }),
      ...(deps.spawn?.onStderr === undefined ? {} : { onStderr: deps.spawn.onStderr }),
    }),
  })
  /** 这条连接死了:在跑的每一轮收场、挂着的每一问撤掉、会话全忘。 */
  const mourn = (why: string): void => {
    for (const turn of turns.values()) {
      if (turn.end !== undefined) continue
      const gone = `和 ${who} 的连接断了:${why}`
      turn.end = { why: gone }
      for (const wake of [...turn.wakers]) wake()
      emit(turn.sessionId, { type: 'error', status_why: gone })
    }
    if (pending.size > 0) {
      for (const [sessionId, ask] of [...pending]) { pending.delete(sessionId); ask.settle({ outcome: 'cancelled' }) }
      changed()
    }
    known.clear()
  }

  const watched = new WeakSet<AcpConnection>()
  /** 拿一条活的连接。起不来 = 可重试(进程刚崩、刚被杀都算)。 */
  const connect = async (): Promise<AcpConnection> => {
    let connection: AcpConnection
    try { connection = await link.open() }
    catch (error) {
      const why = error instanceof Error ? error.message : String(error)
      throw new RetryableError(`codex-acp 这一下没起来:${why}`)
    }
    if (!watched.has(connection)) {
      watched.add(connection)
      connection.onGone(mourn)
      connection.watch(takeNote)
      connection.onRequest(onRequest)
    }
    return connection
  }

  /** 它吐出来的通知:只收 `session/update`,按会话记进那一轮。 */
  const takeNote = (note: AcpNotification): void => {
    if (note.method !== ACP_METHODS.update) return
    const sessionId = text(note.params.sessionId)
    if (sessionId === undefined) return
    const turn = turns.get(sessionId)
    if (turn === undefined || turn.end !== undefined) return
    const update = record(note.params.update)
    if (update?.sessionUpdate === 'agent_message_chunk') {
      const content = record(update.content)
      if (content?.type === 'text' && typeof content.text === 'string') {
        // 同一个 messageId 的几截拼成一段;id 变了就是新的一段(schema 上这么说;codex-acp 用 Codex 的 item.id)。
        const id = text(update.messageId)
        const last = turn.said.at(-1)
        if (last !== undefined && last.id === id) last.text += content.text
        else turn.said.push({ ...(id === undefined ? {} : { id }), text: content.text })
      }
    }
    turn.signals += 1
    for (const wake of [...turn.wakers]) wake()
  }

  /** 等到 `test()` 成立,或到点。回「成立了没」。 */
  const until = async (turn: Turn, test: () => boolean, ms: number): Promise<boolean> => {
    if (test()) return true
    if (ms <= 0) return false
    return await new Promise<boolean>((resolve) => {
      const waker = (): void => {
        if (!test()) return
        clearTimeout(timer)
        turn.wakers.delete(waker)
        resolve(true)
      }
      const timer = setTimeout(() => { turn.wakers.delete(waker); resolve(test()) }, ms)
      turn.wakers.add(waker)
    })
  }

  /**
   * 它回错误 / 连接断了,翻成这一层的结局。连接断了是**可重试**的;「没登录」要说人话;别的原话带上。
   */
  const refused = (error: unknown): JobResult => {
    if (error instanceof AcpAgentGone) throw new RetryableError(error.message)
    if (error instanceof AcpRefused && error.code === ACP_AUTH_REQUIRED) {
      return notSent(`这台的 ${who} 还没登录 —— 在 ChatGPT 桌面版里登一次就好(它说:${error.message})`)
    }
    return notSent(error instanceof Error ? error.message : String(error))
  }

  const waitMs = (job: Job): number => {
    if (job.deadline === undefined) return turnMs
    const at = Date.parse(job.deadline)
    if (Number.isNaN(at)) return turnMs
    return Math.max(0, at - now())
  }

  /** 这件活在哪个目录干 / 许不许改文件。**没有目录就不给写**(workspace-write 的 cwd 要是整个家目录,等于交出去了)。 */
  const placeOf = async (job: Job): Promise<{ cwd: string, writes: boolean }> => {
    const where = await workdir(job)
    const cwd = text(job.cwd) ?? text(where.cwd)
    if (cwd === undefined) return { cwd: homedir(), writes: false }
    return { cwd, writes: where.writes }
  }

  /** 送一句进去(answer / relay / dispatch 同一条路)。 */
  const say = async (job: Job): Promise<JobResult> => {
    if (job.submit === false) return unsupported(CODEX_NO_DRAFT_WHY)
    // 「它此刻正开着的那条」协议认不出(`thread/list` 不说哪条在前台)→ 换窗口那条路(那一层对着前台那扇窗打字)。
    if (job.target.kind === 'current') return unsupported('协议认不出它此刻开着的是哪一条对话')
    if (job.kind !== 'dispatch' && job.target.kind !== 'session') {
      return notSent('不知道该往哪条对话里送 —— 替她答、捎话都要先认准那一段')
    }
    const connection = await connect()

    let sessionId: string
    try {
      if (job.target.kind === 'session') {
        sessionId = job.target.sessionId
        if (!known.has(sessionId)) {
          // 这条进程没见过那一段:先接上(codex-acp 支持 `session/load`;要目录,用卡上的,没有就家目录;**不改它的权限档**)。
          const { cwd } = await placeOf(job)
          await connection.request(ACP_METHODS.loadSession, { sessionId, cwd, mcpServers: [] })
          known.add(sessionId)
        }
      }
      else {
        const { cwd, writes } = await placeOf(job)
        const made = await connection.request<{ sessionId?: unknown }>(ACP_METHODS.newSession, { cwd, mcpServers: [] })
        const id = text(made?.sessionId)
        if (id === undefined) return notSent(`${who} 开了一条新对话,但没告诉我它的 id —— 这一下不算送到`)
        sessionId = id
        // 权限档按卡钉死:钉不上就不跑(缺省那一档是它自己的「自动审」,不是卡说的那一档)。
        await connection.request(ACP_METHODS.setMode, { sessionId, modeId: writes ? CODEX_ACP_MODES.writes : CODEX_ACP_MODES.readOnly })
        known.add(sessionId)
      }
    }
    catch (error) { return refused(error) }

    try {
      const title = (await cardTitle(job))?.trim()
      const firstLine = job.text.split('\n').map(one => one.trim()).find(one => one !== '')
      const name = title !== undefined && title !== '' ? title : firstLine
      if (name !== undefined) titles.set(sessionId, name)
    }
    catch { /* 名字只是会话表上那一行,查不到就没有 */ }

    // **先挂上再发**:它的事件可能比回包先到。
    turnSeq += 1
    const turn: Turn = { id: `acp:${sessionId}:${turnSeq}`, sessionId, said: [], signals: 0, wakers: new Set() }
    turns.set(sessionId, turn)
    const finish = (end: TurnEnd): void => {
      if (turn.end !== undefined) return
      turn.end = end
      for (const wake of [...turn.wakers]) wake()
      const reply = acpReplyOf(turn.said) ?? ''
      if (end.refused !== true) {
        emit(sessionId, end.stopReason === 'end_turn' && end.why === undefined
          ? { type: 'done', ...(reply === '' ? {} : { summary: clip(reply, 80) }) }
          : { type: 'error', ...(end.why === undefined ? {} : { status_why: end.why }) })
      }
      // 这一轮收了场还挂着一问(不该有):撤掉,不留一条永远答不上的。
      settleAsk(sessionId, { outcome: 'cancelled' })
    }
    emit(sessionId, { type: 'running', ...(job.cwd === undefined ? {} : { cwd: job.cwd }) })
    connection.request<{ stopReason?: unknown }>(ACP_METHODS.prompt, {
      sessionId,
      prompt: [{ type: 'text', text: job.text }],
    }, ACP_TIMEOUT_MS.promptMax).then(
      (response) => {
        const stopReason = text(response?.stopReason) ?? 'end_turn'
        finish({
          stopReason,
          ...(stopReason === 'end_turn'
            ? {}
            : { why: stopReason === 'cancelled' ? '它这一轮被打断了' : `它这一轮没跑完(${stopReason})` }),
        })
      },
      (error: unknown) => {
        if (turn.end !== undefined) return
        const why = error instanceof AcpAgentGone ? `和 ${who} 的连接断了:${error.message}` : (error instanceof Error ? error.message : String(error))
        // 一个动静都没到就被拒 = 它根本没开跑;到过动静再出错 = 跑到一半坏了。
        finish(turn.signals === 0 && !(error instanceof AcpAgentGone) ? { why, refused: true } : { why })
      },
    )

    const sent = (): JobResult => ({ delivered: 'confirmed', via: 'protocol', evidence: 'receipt', sessionId, turnId: turn.id })
    const replyOf = (): string | undefined => acpReplyOf(turn.said)
    const ended = (end: TurnEnd): JobResult => {
      if (end.refused === true) return refused(new AcpRefused(end.why ?? '它拒了这一句'))
      const reply = replyOf()
      if (end.stopReason === 'end_turn' && end.why === undefined) {
        return reply === undefined ? { ...sent(), why: '它这一轮一个字都没说' } : { ...sent(), reply }
      }
      return { ...sent(), ...(reply === undefined ? {} : { reply }), why: end.why ?? '它这一轮一个字都没说' }
    }

    if (job.expect === 'none') return sent()
    if (job.expect === 'ack') {
      await until(turn, () => turn.signals > 0 || turn.end !== undefined, ackMs)
      if (turn.end !== undefined) return ended(turn.end)
      if (turn.signals > 0) return sent()
      return {
        delivered: 'unconfirmed', via: 'protocol', evidence: 'none', sessionId, turnId: turn.id,
        why: 'session/prompt 发出去了,但没等到它开跑 —— 这一下不敢说成送到',
      }
    }
    await until(turn, () => turn.end !== undefined, waitMs(job))
    if (turn.end === undefined) return { ...sent(), why: '话送进去了,它还在做 —— 这一轮等到点了还没说完' }
    return ended(turn.end)
  }

  /** 替她答挂着的那一问。 */
  const press = (job: Job): JobResult => {
    if (job.target.kind !== 'session') return notSent('不知道该答哪一条 —— 点那一项要先认准那一段')
    const ask = pending.get(job.target.sessionId)
    if (ask === undefined) return unsupported(`${who} 这一路此刻没有在等答的权限请求 —— 这一下要走窗口`)
    const wanted = job.text.trim()
    const option = ask.options.find(one => one.label === wanted || one.optionId === wanted || one.name === wanted)
    if (option === undefined) return notSent(`「${clip(wanted, 20)}」不是它给的那一项,一项都没替你答`)
    settleAsk(ask.sessionId, { outcome: 'selected', optionId: option.optionId })
    return { delivered: 'confirmed', via: 'protocol', evidence: 'receipt', sessionId: ask.sessionId }
  }

  /** 按停止。 */
  const stop = async (job: Job): Promise<JobResult> => {
    if (job.target.kind !== 'session') return notSent('不知道该停哪一条 —— 停一轮要先认准那一段')
    const sessionId = job.target.sessionId
    const turn = turns.get(sessionId)
    if (turn === undefined || turn.end !== undefined) return notSent('它那条对话现在没有在跑的一轮,没什么可停的')
    const connection = await connect()
    connection.notify(ACP_METHODS.cancel, { sessionId })
    // 协议:取消时挂着的权限请求**必须**回 cancelled。
    settleAsk(sessionId, { outcome: 'cancelled' })
    return { delivered: 'confirmed', via: 'protocol', evidence: 'receipt', sessionId }
  }

  /** 只读一眼这条进程记着的那一轮。 */
  const read = async (job: Job): Promise<AdapterReadResult> => {
    if (job.target.kind !== 'session') return { via: 'none', evidence: 'none', why: '不知道该看哪一段 —— 读一眼也要先认准那一段' }
    const turn = turns.get(job.target.sessionId)
    if (turn === undefined) {
      return { via: 'protocol', evidence: 'none', unsupported: true, why: `${who} 的 ACP 这一路没记着这一段(工作台重启过?)—— 换别的通道读` }
    }
    if (job.turnId !== undefined && job.turnId !== turn.id) {
      return { via: 'protocol', evidence: 'none', unsupported: true, why: '报的不是这一路记着的那一轮 —— 换别的通道读' }
    }
    if (turn.end === undefined) return { via: 'protocol', evidence: 'none', busy: true, why: '它这一轮还在跑,先不拿半截当结果' }
    const reply = acpReplyOf(turn.said) ?? ''
    if (reply === '') return { via: 'protocol', evidence: 'none', why: turn.end.why ?? '它这一轮一个字都没说' }
    return { reply, evidence: 'transcript', via: 'protocol' }
  }

  return {
    family: CODEX_FAMILY,
    via: 'protocol',
    capabilities: async (): Promise<AdapterCapabilities> => {
      if (binary() === undefined) return { ...NOTHING }
      try { await connect() }
      catch { return { ...NOTHING } }
      return {
        open: true,
        send: true,
        read: true,
        // ★ 与 app-server 那条的差别:它问人的那一下接得住(`press` 答的就是权限请求)。
        press: true,
        // 看 / 按它窗口上那个权限弹框、往提问面板里写字 —— 那两样是窗口的。
        approve: false,
        writeAsk: false,
        stop: true,
        openSession: true,
      }
    },
    run: async (job: Job): Promise<JobResult> => {
      if (job.kind === 'write_ask') return unsupported(`${who} 走的是 ACP 这条路,往提问面板里写字要走窗口`)
      if (binary() === undefined) {
        return notSent(`这台机器上找不到 ${who} 的命令行(ChatGPT 桌面版自带的那一份也没有),这条路走不了`)
      }
      if (job.kind === 'press') return press(job)
      if (job.kind === 'stop') return await stop(job)
      return await say(job)
    },
    read,
    asks: () => [...pending.values()].map((ask): AcpAskView => ({
      agent: CODEX_FAMILY,
      session_id: ask.sessionId,
      kind: 'choose',
      question: acpQuestionOf({ who, title: ask.title, ...(ask.kind === undefined ? {} : { kind: ask.kind }) }),
      options: ask.options.map(one => ({ label: one.label })),
      full: {
        question: ask.detail === undefined || ask.detail === ask.title ? ask.title : `${ask.title}\n${ask.detail}`,
        options: ask.options.map(one => ({ label: one.name })),
      },
      since: ask.since,
      quote: ask.title,
      by: 'form',
      rule: ACP_RULE,
    })),
    close: () => { link.close() },
  }
}
