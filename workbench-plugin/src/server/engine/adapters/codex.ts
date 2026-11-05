/**
 * Codex 这一家走**协议**(2026-10-02,卡「Codex 协议适配器」;契约见 `../adapter.ts`,
 * 修法见 `docs/设计-一条引擎替八条管线-2026-10-02.md` 第二节 Codex 那一行)。
 *
 * ## 为什么是协议,不是窗口
 *
 * 「往别家 AI 送一句话、把回答拿回来」本质是和另一个程序的会话通信,通道从稳到脆:
 * **协议 > 命令行 > 文件 > 窗口**。10-01 晚四版都在修同一个「找不到窗口」,
 * 而 Codex 桌面版一直有 `codex app-server`(stdio JSON-RPC,走 ChatGPT 桌面 App 自己的登录态)——
 * 10-02 端到端验通:开一条线程、发「只回复两个字:收到」→ 回「收到」,全程没碰窗口。
 * 所以这一家窗口只用来**给她看**(深链 `codex://threads/<id>`),送话一律走这儿。
 *
 * ## 一句话对一条动作
 *
 * | 她要什么 | 这里怎么做 | 什么算送到 |
 * |---|---|---|
 * | `answer` / `relay`(替她答 / 捎话) | `thread/resume {threadId}` + `turn/start` | `expect:'reply'` 等 `turn/completed` 收 agentMessage;`expect:'ack'` 收到 `turn/started` 就算 |
 * | `dispatch`(派活) | `target.new` → `thread/start {cwd,approvalPolicy,sandbox}` → `thread/name/set`(名字 = 卡标题)→ `turn/start`。回 `sessionId = threadId` | 同上 |
 * | `stop` | `turn/interrupt {threadId,turnId}` | 回包就是回执 |
 * | `press` / `write_ask` | 做不了:`unsupported:true`,引擎据此换窗口那条路 | — |
 *
 * ## 登记表里那个 id 和这里的 threadId 是不是一个
 *
 * **是同一个**(10-02 本机核过):`thread/list` 回的每条线程里 `id === sessionId`,
 * 而 `~/.codex/sessions/<年>/<月>/<日>/rollout-<时刻>-<UUID>.jsonl` 文件名上那个 UUID
 * 与它逐字相同(核的那条:`01a0fc96-f6ac-78c1-a3e6-76e7ba72d97f`)。
 * 所以 `codexRollout.ts` / `codexThreads.ts` 认出来的会话 id 可以直接当 `threadId` 用,不用映射。
 *
 * ## 权限那一档(照搬现有口径,不自己放宽)
 *
 * - **派活**是我们起的活,权限由卡说:允许改文件 → `workspace-write`,否则 `read-only`
 *   (与 `agentDispatch.ts` 的 `codex exec -C <目录> -s workspace-write` 同一个分寸);
 * - **替她答 / 捎话**是往她自己那条对话里补一句,**一个字都不改那条对话的权限档**(不带 `sandbox`、不带 `approvalPolicy`);
 * - `approvalPolicy` 永远是 `never`:她不在电脑前,**不是**放开权限,而是「不许它问人,也不许它越出沙箱」——
 *   问了没人点只会挂在那儿(与 Claude 那条 `--permission-prompts none` 同一个分寸)。
 *   `danger-full-access` 不许出现在这个文件里。
 */
import { existsSync } from 'node:fs'
import type { Adapter, AdapterCapabilities, AdapterReadResult, Job, JobResult } from '../adapter.ts'
import { RetryableError } from '../adapter.ts'
import type { CodexAppServerConnection, CodexAppServerLink, CodexNotification } from './codexAppServerClient.ts'
import {
  CODEX_APP_BUNDLE_BINARY,
  CODEX_TIMEOUT_MS,
  CodexAppServerGone,
  codexAppServerLink,
  spawnCodexAppServerPeer,
} from './codexAppServerClient.ts'

/** 家族目录里这一家叫什么。 */
export const CODEX_FAMILY = 'codex'

/**
 * 无人值守的审批口径。`never` **不是**放开:它是「不许它问人、越不出沙箱就直接失败」。
 * 放开的那一档(`danger-full-access`)不许出现在这条路上 —— 派一次活不该顺手把整台电脑交出去。
 */
export const CODEX_APPROVAL_POLICY = 'never'
/** 卡上允许改文件时的沙箱档:只能改那个工作目录。 */
export const CODEX_SANDBOX_WRITES = 'workspace-write'
/** 卡上不允许改文件时的沙箱档。 */
export const CODEX_SANDBOX_READ_ONLY = 'read-only'

/**
 * **给新线程起名的那一问**(2026-10-03,卡「Codex 线程起名」;维护者 10-03 早拍板 ③甲)。
 *
 * 方法名与参数形状不是凭记忆写的,是**查实**的:codex-cli 0.159.2 自己的协议定义
 * (`codex app-server generate-ts` → `ClientRequest.ts` 里 `{"method":"thread/name/set", params: ThreadSetNameParams}`、
 * `v2/ThreadSetNameParams.ts` 里 `{threadId: string, name: string}`,回包 `ThreadSetNameResponse = Record<string, never>`
 * —— 空对象,所以**回包里没什么可读的**,成了就是成了)。
 *
 * 为什么非起不可:`~/.codex/session_index.jsonl` 每行带 `thread_name`,**只记有名字的线程**;
 * 她的 ChatGPT App 侧栏与 `codexThreads.ts` 都按它找。10-02 协议开的两条没名字,
 * 于是派出去的活在 App 里找不着(交接「桌面 App 里能不能看到新线程」那一节)。
 */
export const CODEX_NAME_METHOD = 'thread/name/set'
/** 查不到卡时,拿交代第一行最多截这么多字当名字。 */
export const CODEX_NAME_FALLBACK_MAX = 30

/**
 * `submit:false`(「只填不发 / 先问我」)协议做不了(2026-10-03,统筹裁定;契约 `Job.submit` 那一段):
 * `turn/start` 一调就是发了。如实回 `unsupported`,引擎换窗口那条路 —— 字进框,她自己按。
 */
export const CODEX_NO_DRAFT_WHY = 'Codex 走的是协议这条路,做不了「只填不发」—— 字进框她自己按,要走窗口'
/** 这一轮还在跑(`turn.status === 'inProgress'`):有过场话也不算结果。 */
export const CODEX_TURN_RUNNING_WHY = '它这一轮还在跑,先不拿半截当结果'
/** 这一轮收了场(完成 / 被打断 / 失败)却一句话都没说。 */
export const CODEX_TURN_SILENT_WHY = '它这一轮一个字都没说'
/** 送那一刻报过的轮号,在它那条对话里找不着了(线程被清 / 分页之外):读不到,**不是**它还没回。 */
export const CODEX_TURN_NOT_FOUND_WHY = '它那条对话里找不到我们送进去的那一轮,先不拿别的轮次顶'

/**
 * ★ **「这条线程已经有一个写入方」:协议这条路此刻做不了**(2026-10-04,
 * 卡「Codex 线程被占时换路」;查实与量数 `docs/交接-1004-Codex线程被占时换路.md` 第二节)。
 *
 * ## 这到底是什么
 *
 * `codex app-server` 对每条线程有一把**跨进程文件锁**:`~/.codex/thread-writer-locks/<threadId>.lock`
 * (本机 strings 查到 `thread-store/src/local/live_writer.rs`、「failed to acquire thread writer lock」
 * 那一串)。谁加载了那条线程,谁就一直握着它;别的进程 `thread/resume` 同一条就回这句原话,
 * JSON-RPC 的 code 是通用的 `-32600`(分不出来,**只能认原话**)。
 *
 * 本机 10-04 量过(交接第二节有原始输出):
 * - **同一条连接**对同一条线程重复 `thread/resume` **不冲突** → 不是我们自己没放手;
 * - 另起一个进程 resume 同一条 → 逐字就是这一句;握着的那个进程一退,锁当场放;
 * - 10-04 10:18 那条线程(`01a0ccd1-…`)的锁:`lsof` 指着 pid 39260 ——
 *   她的 Codex / ChatGPT 桌面 App 自己那个 app-server(命令行带 `features.code_mode_host=true`、
 *   `--analytics-default-enabled`,我们起的那条只有 `app-server` 一个参数),10-03 10:40 起到现在没退。
 *
 * ## 所以这一下回 `unsupported`,不回「失败」
 *
 * 她的 App 开着那条对话时,协议这条路**一个字都送不进去**(`turn/start` 不先 resume 只回
 * 「thread not found」,也量过)。那是「这条通道此刻办不了这一样」,契约里就是 `unsupported` ——
 * 引擎按既有规矩换到窗口那只手(深链 `codex://threads/<id>` 开到那条对话、往它自己的输入框里送),
 * 锁着屏就排进 `lockQueue` 等解锁。回成普通失败就是 10-04 那五次:不重试、不换路,她那句话丢了。
 */
export const CODEX_BUSY_WRITER_MARKS: readonly string[] = ['already has an active writer', 'already has a live local writer']

/** 这句原话是不是「那条线程被别的进程占着」。认原话是因为它的 JSON-RPC code 是通用的 -32600。 */
export function codexThreadTaken(message: string): boolean {
  const said = message.toLowerCase()
  return CODEX_BUSY_WRITER_MARKS.some(one => said.includes(one))
}

/**
 * 被占时跟她说的那一句(**人话,不许把英文原句甩给她**;卡第 3 条)。
 * 一处写:手机上那张卡、账上那一行、日志里都是它。
 */
export const CODEX_THREAD_TAKEN_WHY = 'Codex 那条对话正被 Codex App 自己占着(一条对话同一时刻只许一个写入方)—— 协议这条路送不进,我改从它自己的窗口送'

/**
 * 这条新线程该叫什么。
 *
 * 规则(卡上写死,**不编、不加前缀**):
 * ① 有卡标题就用卡标题,**原样**(她在侧栏里认的就是看板上那一行字,改一个字她就对不上了);
 * ② 查不到卡 → 交代的第一行(空白行跳过),最多 {@link CODEX_NAME_FALLBACK_MAX} 字;
 * ③ 两样都没有 → 缺席。宁可那条线程没名字,也不拿「派活」「新任务」这种我们自己想的词去填。
 *
 * 为什么卡标题不截:它本来就是她自己写的一行字,截了就不是她那一行了;
 * 截 30 字只是「拿一大段交代凑个名字」时的分寸。
 */
export function codexThreadNameOf(text: string, cardTitle?: string): string | undefined {
  const fromCard = cardTitle?.trim()
  if (fromCard !== undefined && fromCard !== '') return fromCard
  const firstLine = text.split('\n').map(one => one.trim()).find(one => one !== '')
  if (firstLine === undefined) return undefined
  return firstLine.slice(0, CODEX_NAME_FALLBACK_MAX)
}

/**
 * 派活要知道「在哪个目录干、许不许改文件」——
 * `Job`(契约,锁死)里没有这两格,所以由宿主按 `job.itemId` 现查。
 */
export interface CodexWorkdir {
  /** 绝对路径。缺席 = 不指定,让 Codex 用它自己的默认(**不硬造一个路径**)。 */
  cwd?: string
  /** 这张卡允许改文件吗(写代码的活 = true)。决定沙箱那一档。 */
  writes: boolean
}

export interface CodexAdapterDeps {
  /** 那一条长连接。缺席 = 自己起一条(真机用法)。 */
  link?: CodexAppServerLink
  /** 这台机器上的 `codex` 在哪;找不到回 undefined。缺席 = 现查 PATH 与 ChatGPT.app。 */
  binary?: () => string | undefined
  /** 这张卡在哪个目录干、许不许改文件。缺席 = 不指定目录、不许改文件(最保守那一档)。 */
  workdir?: (job: Job) => CodexWorkdir | Promise<CodexWorkdir>
  /**
   * **这件活的卡标题**(宿主按 `job.itemId` 查卡;与 {@link workdir} 同一条「向宿主现问」的接缝 ——
   * `Job` 是锁死的契约,卡上那几格不在里头)。缺席 / 查不到 = 退回交代第一行(见 {@link codexThreadNameOf})。
   */
  title?: (job: Job) => string | undefined | Promise<string | undefined>
  /** 现在几点(算 `deadline` 用;测试注入)。 */
  now?: () => number
  /** 记一行日志(起名没成时那一行)。缺席 = `console.log`,与引擎那一处同一个默认。 */
  warn?: (line: string) => void
}

/**
 * 这台机器上能用的 `codex` 在哪(**能不能用**:找不到就回 undefined)。
 *
 * 与 `codexAppServerClient.ts` 的 `resolveCodexBinary`(**spawn 哪个**:找不到也回 `'codex'`,
 * 让 ENOENT 照常走调用方的退路)是两件事,别混用。
 */
export function findCodexBinary(pathEnv: string | undefined, exists: (file: string) => boolean): string | undefined {
  for (const dir of (pathEnv ?? '').split(':')) {
    if (dir !== '' && exists(`${dir}/codex`)) return `${dir}/codex`
  }
  if (exists(CODEX_APP_BUNDLE_BINARY)) return CODEX_APP_BUNDLE_BINARY
  return undefined
}

const NOTHING: AdapterCapabilities = {
  open: false, send: false, read: false, press: false, approve: false, writeAsk: false, stop: false, openSession: false,
}

/** 它说的那一句(`item/completed` 与 `turn.items` 里的 `agentMessage`)。 */
interface AgentSaid {
  text: string
  /** `final_answer` = 收尾那句;`commentary` = 过场话;缺席 = 这个模型没报(照 schema:当「不知道」)。 */
  phase?: string
  /** 这句属于哪一轮(`thread/items/list` 的 `ThreadItemEntry.turnId`;`thread/resume` 那一路由 turn 本身分组,不带)。 */
  turnId?: string
}

function record(value: unknown): Record<string, unknown> | undefined {
  return (typeof value === 'object' && value !== null) ? value as Record<string, unknown> : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/**
 * 一条 `ThreadItem` 是不是它说的话;是就把话取出来。
 * `thread/items/list` 回的是 `ThreadItemEntry {turnId,item}`,**外面包了一层**,这里一并认。
 */
function agentSaidOf(value: unknown): AgentSaid | undefined {
  const outer = record(value)
  if (outer === undefined) return undefined
  const item = outer.type === undefined && outer.item !== undefined ? record(outer.item) : outer
  if (item === undefined || item.type !== 'agentMessage') return undefined
  const said = text(item.text)
  if (said === undefined) return undefined
  const turnId = text(outer.turnId)
  return { text: said, ...(typeof item.phase === 'string' ? { phase: item.phase } : {}), ...(turnId === undefined ? {} : { turnId }) }
}

/** 一条 `Turn` 里它说过的话(顺序照原样)。 */
function saidInTurn(value: unknown): AgentSaid[] {
  const items = record(value)?.items
  return (Array.isArray(items) ? items : [])
    .map(agentSaidOf)
    .filter((one): one is AgentSaid => one !== undefined)
}

/**
 * 哪一句算「它的回答」。
 *
 * 规则(照 schema 对 `MessagePhase` 的说明:`None` 要当「不知道」处理,不能当过场话):
 * 有收尾那句(`final_answer`)就只认收尾那句;没有就认没报 phase 的最后一句;
 * 两样都没有(只有过场话)就认最后那句过场话 —— **不编一句**,有什么说什么。
 */
export function pickCodexReply(said: readonly AgentSaid[]): string | undefined {
  const finals = said.filter(one => one.phase === 'final_answer')
  const unknowns = said.filter(one => one.phase === undefined)
  const pool = finals.length > 0 ? finals : (unknowns.length > 0 ? unknowns : said)
  return pool.at(-1)?.text.trim()
}

/** 它这一轮的结局。 */
interface TurnEnd {
  status: string
  reply?: string
  /** 失败 / 被打断 / 断线时的原话。 */
  why?: string
}

function errorTextOf(value: unknown): string | undefined {
  const holder = record(value)
  if (holder === undefined) return undefined
  const error = record(holder.error)
  return text(error?.message) ?? text(holder.message)
}

/**
 * 盯住某条线程的这一轮。**要在 `turn/start` 发出去之前挂上** ——
 * 它的事件可能比回包先到(真机上 `turn/started` 常常就是)。
 */
function watchTurn(connection: CodexAppServerConnection, threadId: string) {
  const said: AgentSaid[] = []
  const wakers = new Set<() => void>()
  let startedTurnId: string | undefined
  let end: TurnEnd | undefined

  const wake = (): void => { for (const waker of [...wakers]) waker() }
  const close = (next: TurnEnd): void => {
    if (end !== undefined) return
    end = next
    wake()
  }

  const take = (note: CodexNotification): void => {
    const params = note.params
    // 它同时可能在跑别的线程(她自己在桌面 App 里也在用);只收这一条的。
    if (typeof params.threadId === 'string' && params.threadId !== threadId) return
    if (note.method === 'turn/started') {
      startedTurnId ??= text(record(params.turn)?.id)
      wake()
      return
    }
    if (note.method === 'item/completed') {
      const one = agentSaidOf(params.item)
      if (one !== undefined) said.push(one)
      return
    }
    if (note.method === 'turn/completed') {
      const turn = record(params.turn)
      const items = Array.isArray(turn?.items) ? turn.items : []
      const all = [...said, ...items.map(agentSaidOf).filter((one): one is AgentSaid => one !== undefined)]
      const status = text(turn?.status) ?? 'completed'
      const reply = pickCodexReply(all)
      close({
        status,
        ...(reply === undefined ? {} : { reply }),
        ...(status === 'completed' ? {} : { why: errorTextOf(turn) ?? `它这一轮${status === 'interrupted' ? '被打断了' : '没跑成'}` }),
      })
      return
    }
    if (note.method === 'error') {
      // `willRetry:true` 那种它自己还会再来一次,不当结局。
      if (params.willRetry === true) return
      close({ status: 'failed', why: errorTextOf(params) ?? '它报了个错,没给原话' })
    }
  }

  const unwatch = connection.watch(take)
  const unmourn = connection.onGone((why) => { close({ status: 'failed', why: `和 Codex 的连接断了:${why}` }) })

  /** 等到 `test()` 成立,或到点。回「成立了没」。 */
  const until = async (test: () => boolean, ms: number): Promise<boolean> => {
    if (test()) return true
    if (ms <= 0) return false
    return await new Promise<boolean>((resolve) => {
      const waker = (): void => {
        if (!test()) return
        clearTimeout(timer)
        wakers.delete(waker)
        resolve(true)
      }
      const timer = setTimeout(() => { wakers.delete(waker); resolve(test()) }, ms)
      wakers.add(waker)
    })
  }

  return {
    /** 这一轮的 id(从 `turn/started` 认到的);`turn/start` 的回包里也有,由调用方补。 */
    turnId: () => startedTurnId,
    learnTurnId: (id: string | undefined) => { startedTurnId ??= id },
    /** 开跑了没。 */
    started: () => startedTurnId !== undefined,
    /** 等它开跑。 */
    waitStarted: async (ms: number) => await until(() => startedTurnId !== undefined, ms),
    /** 等它说完;到点回 undefined(**不编一个回答**)。 */
    waitEnd: async (ms: number): Promise<TurnEnd | undefined> => {
      await until(() => end !== undefined, ms)
      return end
    },
    stop: () => { unwatch(); unmourn() },
  }
}

/**
 * 这条路做不了 → 如实说,让引擎换窗口那条路。
 * `via:'none'` = **一条通道都没用上**(这一家没有一条能办这件事),不是「协议试了没成」。
 */
function unsupported(why: string): JobResult {
  return { delivered: 'not_sent', via: 'none', evidence: 'none', unsupported: true, why }
}

function notSent(why: string): JobResult {
  return { delivered: 'not_sent', via: 'protocol', evidence: 'none', why }
}

/**
 * Codex 协议适配器。一个实例 = 一条长连接(断了下一次自己重起)。
 */
export function codexAdapter(deps: CodexAdapterDeps = {}): Adapter & { close: () => void } {
  const link = deps.link ?? codexAppServerLink({
    clientName: 'desktop-workbench',
    spawnPeer: async () => await spawnCodexAppServerPeer(),
  })
  const binary = deps.binary ?? (() => findCodexBinary(process.env.PATH, existsSync))
  const workdir: NonNullable<CodexAdapterDeps['workdir']> = deps.workdir ?? (() => ({ writes: false }))
  const cardTitle: NonNullable<CodexAdapterDeps['title']> = deps.title ?? (() => undefined)
  const now = deps.now ?? (() => Date.now())
  const warn = deps.warn ?? ((line: string) => { console.log(line) })
  /** 我们起的那一轮,按线程记着 —— `stop` 要 `turnId`。说完了就忘掉(停一条已经完的会报错)。 */
  const lastTurn = new Map<string, string>()

  /** 拿一条活的连接。起不来 = 可重试(进程刚崩、刚被杀都算)。 */
  const connect = async (): Promise<CodexAppServerConnection> => {
    try { return await link.open() }
    catch (error) {
      const why = error instanceof Error ? error.message : String(error)
      throw new RetryableError(`codex app-server 这一下没起来:${why}`)
    }
  }

  /**
   * 它回错误 / 连接断了,翻成这一层的结局。连接断了是**可重试**的,别的不是。
   *
   * ★ 多一档(2026-10-04):**那条线程被别的进程占着**({@link codexThreadTaken})不是失败,
   * 是「这条通道此刻办不了」—— 回 `unsupported`,引擎换窗口那只手(见 {@link CODEX_THREAD_TAKEN_WHY})。
   * 送话、按停止都从这一处过,所以两路同一个判法,不另写一份。
   */
  const refused = (error: unknown): never | JobResult => {
    if (error instanceof CodexAppServerGone) throw new RetryableError(error.message)
    const said = error instanceof Error ? error.message : String(error)
    if (codexThreadTaken(said)) return unsupported(CODEX_THREAD_TAKEN_WHY)
    return notSent(said)
  }

  /** 派活才带权限那两格;替她答 / 捎话一个字都不改她那条对话的档。 */
  const policyFor = async (job: Job): Promise<Record<string, unknown>> => {
    if (job.kind !== 'dispatch') return {}
    const where = await workdir(job)
    return { approvalPolicy: CODEX_APPROVAL_POLICY, sandbox: where.writes ? CODEX_SANDBOX_WRITES : CODEX_SANDBOX_READ_ONLY }
  }

  /**
   * **给我们自己刚开的那条线程起个名字**(2026-10-03,卡「Codex 线程起名」)。
   *
   * 只对 `thread/start` 刚开出来的那条叫 —— **她自己那条对话的名字一个字都不改**
   * (`target.kind === 'session'` 那几路、替她答 / 捎话都不走这儿)。
   *
   * **起名失败不影响派活**:记一行人话,活照样送出去。理由:没名字只是「她的侧栏里得按时间找」,
   * 而把一件已经交代得出去的活判成失败,代价大得多。
   */
  const nameNewThread = async (connection: CodexAppServerConnection, threadId: string, job: Job): Promise<void> => {
    let name: string | undefined
    try { name = codexThreadNameOf(job.text, await cardTitle(job)) }
    catch (error) {
      warn(`Codex 新线程 ${threadId} 没起上名字:查这张卡的标题时出错(${error instanceof Error ? error.message : String(error)})—— 活照样派出去了`)
      return
    }
    if (name === undefined) {
      warn(`Codex 新线程 ${threadId} 没起上名字:这件活既查不到卡、交代里也没有一行字可用 —— 不编一个名字,活照样派出去了`)
      return
    }
    try { await connection.request(CODEX_NAME_METHOD, { threadId, name }) }
    catch (error) {
      warn(`Codex 新线程 ${threadId} 没起上名字「${name}」:${error instanceof Error ? error.message : String(error)} —— 活照样派出去了,只是她的 ChatGPT 侧栏里得按时间找`)
    }
  }

  /** 等多久(卡上带了 `deadline` 就听卡的)。 */
  const waitMs = (job: Job): number => {
    if (job.deadline === undefined) return CODEX_TIMEOUT_MS.turn
    const at = Date.parse(job.deadline)
    if (Number.isNaN(at)) return CODEX_TIMEOUT_MS.turn
    return Math.max(0, at - now())
  }

  /** 送一句进去(answer / relay / dispatch 同一条路)。 */
  const say = async (job: Job): Promise<JobResult> => {
    // 「只填不发」协议做不了:`turn/start` 一调就是发了。先于一切检查 —— 连线程都不开(2026-10-03,审计第二节第 4 条)。
    if (job.submit === false) return unsupported(CODEX_NO_DRAFT_WHY)
    if (job.kind !== 'dispatch' && job.target.kind !== 'session') {
      return notSent('不知道该往哪条对话里送 —— 替她答、捎话都要先认准那一段')
    }
    /*
     * 「它此刻正开着的那条」(契约 2026-10-02 加的 `target:'current'`):协议这一层认不出它
     * —— `thread/list` 看得到每一条线程,可**哪一条在桌面 App 前台**它不说。
     * 如实回「这一样我做不了」,引擎换窗口那条路(那一层本来就是对着前台那扇窗打字)。
     */
    if (job.target.kind === 'current') {
      return { delivered: 'not_sent', via: 'none', evidence: 'none', unsupported: true, why: '协议认不出它此刻开着的是哪一条对话' }
    }
    const connection = await connect()

    let threadId: string
    try {
      if (job.target.kind === 'session') {
        threadId = job.target.sessionId
        // 先把那条线程接起来(app-server 没加载过的线程不能直接 `turn/start`)。
        await connection.request('thread/resume', { threadId, ...(job.model === undefined ? {} : { model: job.model }), ...await policyFor(job) })
      }
      else {
        const where = await workdir(job)
        const started = await connection.request<{ thread?: { id?: unknown } }>('thread/start', {
          ...(where.cwd === undefined ? {} : { cwd: where.cwd }),
          ...(job.model === undefined ? {} : { model: job.model }),
          ...await policyFor(job),
        })
        const id = text(record(started?.thread)?.id)
        if (id === undefined) return notSent('Codex 开了一条新对话,但没告诉我它的 id —— 这一下不算送到')
        threadId = id
        // 开出来就起名(她的 ChatGPT App 侧栏按 `thread_name` 列);**没起上也照送**。
        await nameNewThread(connection, threadId, job)
      }
    }
    catch (error) { return refused(error) }

    // **先挂上再发**:`turn/started` 可能比 `turn/start` 的回包先到。
    const turn = watchTurn(connection, threadId)
    try {
      const response = await connection.request<{ turn?: { id?: unknown } }>('turn/start', {
        threadId,
        input: [{ type: 'text', text: job.text }],
        ...(job.model === undefined ? {} : { model: job.model }),
        ...(job.effort === undefined ? {} : { effort: job.effort }),
      })
      turn.learnTurnId(text(record(response?.turn)?.id))
    }
    catch (error) {
      turn.stop()
      return refused(error)
    }

    // 这一轮的 id 一并交出去(2026-10-03):消费方记在卡上 / 账上,读回话只认这一轮。回包里没有、`turn/started` 也没到就缺席,不编。
    const sent = (): JobResult => {
      const id = turn.turnId()
      return { delivered: 'confirmed', via: 'protocol', evidence: 'receipt', sessionId: threadId, ...(id === undefined ? {} : { turnId: id }) }
    }
    try {
      if (job.expect === 'none') return sent()

      if (job.expect === 'ack') {
        // 回包里带了这一轮、或 `turn/started` 到了,都是「它接下了」的回执。
        if (turn.started() || await turn.waitStarted(CODEX_TIMEOUT_MS.ack)) {
          const id = turn.turnId()
          if (id !== undefined) lastTurn.set(threadId, id)
          return sent()
        }
        return {
          delivered: 'unconfirmed', via: 'protocol', evidence: 'none', sessionId: threadId,
          why: 'turn/start 调出去了,但没等到它说「开跑了」—— 这一下不敢说成送到',
        }
      }

      const id = turn.turnId()
      if (id !== undefined) lastTurn.set(threadId, id)
      const end = await turn.waitEnd(waitMs(job))
      if (end === undefined) {
        return { ...sent(), why: '话送进去了,它还在做 —— 这一轮等到点了还没说完' }
      }
      lastTurn.delete(threadId)
      if (end.reply !== undefined && end.status === 'completed') return { ...sent(), reply: end.reply }
      return {
        ...sent(),
        ...(end.reply === undefined ? {} : { reply: end.reply }),
        why: end.why ?? '它这一轮一个字都没说',
      }
    }
    finally { turn.stop() }
  }

  /** 按停止。 */
  const stop = async (job: Job): Promise<JobResult> => {
    if (job.target.kind !== 'session') return notSent('不知道该停哪一条 —— 停一轮要先认准那一段')
    const threadId = job.target.sessionId
    const connection = await connect()

    let turnId = lastTurn.get(threadId)
    if (turnId === undefined) {
      // 不是我们起的那一轮(她自己在桌面 App 里发的,或工作台重启过):现查。
      try {
        const resumed = await connection.request<{ thread?: { turns?: unknown } }>('thread/resume', { threadId })
        const turns = record(resumed?.thread)?.turns
        const running = (Array.isArray(turns) ? turns : [])
          .map(record)
          .filter((one): one is Record<string, unknown> => one !== undefined && one.status === 'inProgress')
          .at(-1)
        turnId = text(running?.id)
      }
      catch (error) { return refused(error) }
    }
    if (turnId === undefined) return notSent('它那条对话现在没有在跑的一轮,没什么可停的')

    try { await connection.request('turn/interrupt', { threadId, turnId }) }
    catch (error) { return refused(error) }
    lastTurn.delete(threadId)
    return { delivered: 'confirmed', via: 'protocol', evidence: 'receipt', sessionId: threadId }
  }

  /**
   * **只读一眼**那一段此刻的回话:`thread/resume` 之后读它说过的最后一句,
   * **不开新 turn、不点任何东西、不叫窗口到台前**(「盯着等回话」那条巡检用它)。
   * 也**不带** `sandbox` / `approvalPolicy` —— 看一眼不该改她那条对话的权限档。
   */
  const read = async (job: Job): Promise<AdapterReadResult> => {
    if (job.target.kind !== 'session') {
      return { via: 'none', evidence: 'none', why: '不知道该看哪一段 —— 读一眼也要先认准那一段' }
    }
    if (binary() === undefined) {
      return { via: 'none', evidence: 'none', why: '这台机器上找不到 Codex 的命令行(ChatGPT 桌面版自带的那一份也没有),这条路走不了' }
    }
    const threadId = job.target.sessionId
    const connection = await connect()
    try {
      const resumed = await connection.request<{ thread?: { turns?: unknown } }>('thread/resume', { threadId })
      const turns = record(resumed?.thread)?.turns
      /*
       * ★ **只认最后一轮**(2026-10-03,审计第二节第 2 条)。从前把所有 turn 的话平铺、不读 `turn.status`:
       * 已有线程里追加一句、新一轮还在跑,读到的是**上一轮**的收尾句,两拍一字不差就被当成「它说完了」回电。
       * 还在跑 → `busy:true`、没有 `reply`(契约 `AdapterReadResult`:半截不算结果);收了场才挑这一轮里的话。
       */
      const all = (Array.isArray(turns) ? turns : []).map(record).filter((one): one is Record<string, unknown> => one !== undefined)
      /*
       * ★ **送那一刻报过轮号就只认那一轮**(`Job.turnId`;2026-10-03):她自己又在那条线程里发了一句,
       * 最后一轮是她那句、不是我们这件 —— 按号找才不会把她那一轮当成我们这件的结果。没报过号(老账 / 窗口型)才认最后一轮。
       */
      const wanted = job.turnId
      const picked = wanted === undefined ? all.at(-1) : all.find(one => text(one.id) === wanted)
      if (picked !== undefined) {
        if (picked.status === 'inProgress') return { via: 'protocol', evidence: 'none', busy: true, why: CODEX_TURN_RUNNING_WHY }
        const reply = pickCodexReply(saidInTurn(picked))
        if (reply === undefined) return { via: 'protocol', evidence: 'none', why: CODEX_TURN_SILENT_WHY }
        return { reply, evidence: 'transcript', via: 'protocol' }
      }
      // 报了号、而 resume 带回的 turns 里没有它(分页之外)→ 到 items/list 里按号找;turns 根本没带才退回「最新那一轮」。
      if (wanted !== undefined && all.length > 0) {
        return { via: 'protocol', evidence: 'none', why: CODEX_TURN_NOT_FOUND_WHY }
      }

      // 分页的老对话 resume 不再带全量 turns(schema 自己说的);倒着取一页。报了号按号认,没报号只认最新那一轮(第一条就是最新那轮的)。
      const listed = await connection.request<{ data?: unknown }>('thread/items/list', {
        threadId, sortDirection: 'desc', limit: 50,
      })
      const rows = Array.isArray(listed?.data) ? listed.data : []
      const newestTurn = text(record(rows[0])?.turnId)
      const turnWanted = wanted ?? newestTurn
      // 倒着取的,所以翻回正序再挑「最后那句」。
      const said = [...rows].reverse().map(agentSaidOf).filter((one): one is AgentSaid => one !== undefined)
      const mine = turnWanted === undefined ? said : said.filter(one => one.turnId === turnWanted)
      const reply = pickCodexReply(mine)
      if (reply === undefined) return { via: 'protocol', evidence: 'none', why: wanted === undefined ? '它那条对话里还没有它说的话' : CODEX_TURN_NOT_FOUND_WHY }
      return { reply, evidence: 'transcript', via: 'protocol' }
    }
    catch (error) {
      if (error instanceof CodexAppServerGone) throw new RetryableError(error.message)
      const said = error instanceof Error ? error.message : String(error)
      /*
       * ★ **被占着就读不了这一段**(2026-10-04):`thread/resume` 都进不去,这一轮说了什么协议这头看不见。
       * 回 `unsupported` 让引擎换读得到的下一条通道(读窗),**不说「它还没回」**(契约那条纪律)。
       */
      if (codexThreadTaken(said)) return { via: 'protocol', evidence: 'none', unsupported: true, why: CODEX_THREAD_TAKEN_WHY }
      return { via: 'protocol', evidence: 'none', why: said }
    }
  }

  return {
    family: CODEX_FAMILY,
    via: 'protocol',
    capabilities: async (): Promise<AdapterCapabilities> => {
      // 现查:二进制在不在、握手得上。报「能」然后到送话时才崩,比报「不能」更坏。
      if (binary() === undefined) return { ...NOTHING }
      try { await link.open() }
      catch { return { ...NOTHING } }
      return {
        open: true,
        send: true,
        read: true,
        // 协议点不了它框上的键 / 权限弹框 / 提问面板 —— 那三样让引擎换窗口那条路。
        press: false,
        approve: false,
        writeAsk: false,
        stop: true,
        // 有 threadId 就能接着那一段(还能给她深链 `codex://threads/<id>`)。
        openSession: true,
      }
    },
    run: async (job: Job): Promise<JobResult> => {
      if (job.kind === 'press') return unsupported('Codex 走的是协议这条路,点不了它框上的那一项 —— 这一下要走窗口')
      if (job.kind === 'write_ask') return unsupported('Codex 走的是协议这条路,往提问面板里写字要走窗口')
      if (binary() === undefined) {
        return notSent('这台机器上找不到 Codex 的命令行(ChatGPT 桌面版自带的那一份也没有),这条路走不了')
      }
      if (job.kind === 'stop') return await stop(job)
      return await say(job)
    },
    read,
    /** 工作台停的时候叫一次。 */
    close: () => { link.close() },
  }
}
