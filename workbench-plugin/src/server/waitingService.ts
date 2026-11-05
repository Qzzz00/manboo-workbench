/**
 * 「在等你」的那一半 I/O(2026-09-25,卡 T):读会话、拿不准时问一次模型、叠到会话表上。判断本身只在 waitingForYou.ts。
 *
 * 怎么跑(同 claudeSessionRecover / codex reconcile:**请求驱动 + 限频**,不是常驻轮询 —— 没人看工作台就一次都不读):
 * 1. 各家接入读会话文件时都登记进了 sessionDigest(卡 P 那张登记表)。这里按登记表走一遍,**文件没动就一个字节都不读**;
 *    动了的读尾巴一段(`readSessionTurns`,有上限),算出事实({@link factsOf})记在内存里,原文当场扔掉;
 * 2. Claude 子任务的会话(`<主会话>/subagents/agent-*.jsonl`)只看最近动过的几份,在跑 → 主会话算在跑(子任务不单算一条);
 * 3. Claude 自己记的「此刻在等什么」(`~/.claude/sessions/<pid>.json` 的 `waitingFor`)读一遍 —— 权限弹窗、提问弹窗;
 * 4. 规则拿不准的,**授权表允许读会话正文**(`read_session_content`,卡 N 的那一项)、今天还没花到上限时,问一次便宜的模型
 *    (`deepseek-v4-flash`,关掉「先想一遍」),**按消息的哈希缓存**:同一段话只问一次。花费记在 `~/.dsh/workbench/waiting.json`
 *    (只记哪天、花了多少、问了几次,不记内容),一天的上限读 `~/.dsh/workbench/budget.json` 的 `cny`(与卡 O「每件事上限」、
 *    卡 N 进度评估同一份设置)。
 * 5. 出 /state 时叠一层({@link overlayWaiting}):在等你 > 在跑 > 空闲;不写进会话记录,答了 / 又跑起来的下一拍自己消失。
 * 6. **读窗口读出来的那几家**(2026-09-26,卡 WS):没有会话文件,只有壳读回来的「最新那句」——
 *    当成一条只有最后一段回话的会话({@link WindowWaitRef}),过**同一份** `factsOf` / `decide` / 同一个模型上限,
 *    出来的 `ask` 由登记表挂到那条窗口会话上({@link WaitingService.askOf})。窗口这一路**永远不改运行状态**。
 *
 * 纪律:只读(会话文件、Claude 的会话记录 `.json`;同目录的 `.key` 一个字节不碰);原文不进 /state、不落盘;
 * 送去模型的只有最后一来一回(截过),而且要他在授权表里点过头。
 */
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { SessionAskView, SessionStatus, SessionView } from '../protocol.ts'
import type { ClaudeLiveSession } from './claudeSessionRecover.ts'
import { readSessionTurns, type DigestFormat, type SessionTurns } from './sessionDigest.ts'
import {
  askViewOf, childWaitOf, decide, factsOf, heavier, modelExchangeOf, overlayWaiting, parseWaitModelReply, waitMessageKey, waitModelPrompt, withChildWait,
  WAIT_MAX_AGE_MS, type AskReply, type ChildTask, type SessionLoad, type WaitFacts, type WaitModelExchange, type WaitSignals, type WaitVerdict,
} from './waitingForYou.ts'

/** 登记表里的一条(sessionDigest 的登记:哪一家、哪条会话、哪个文件、什么格式)。 */
export interface SessionFileRef {
  agent: string
  session_id: string
  file: string
  format: DigestFormat
  name?: string
}

/**
 * **读窗口读出来的那条会话**(2026-09-26,卡 WS)。窗口型 Agent(Grok Bot、Antigravity、Muse……)没有会话文件,
 * 只有壳读回来的「最新那句」—— 把它当一条**只有最后一段回话**的会话,过**同一份**内容判断
 * (`waitingForYou.ts` 的 rules / model,同一个花费上限、同一套缓存),不另起一套。
 *
 * 三条纪律:
 * - **只判它刚说完的那句**(`answered`):他自己在那扇窗里说的话不判(见 agentWindowModel 的 `answered`);
 * - **只有 `by:'rules'|'model'`**:窗口这一路读不出形式信号(没有弹窗可读),所以**永远不改运行状态** ——
 *   `ask` 挂上去、`status` 原样(白还是白、蓝还是蓝),那一问走 `src/waiting.ts` 的 `waitingOnHim`;
 * - **他在那扇窗里回了话**(`latest` 变了)→ 这一条重判,`answered` 也随之翻掉 → 那一问自动撤。
 */
export interface WindowWaitRef {
  /** 登记表里的 id(有专门读法的几家是 claude / codex / kimi,别的是包标识)。 */
  agent: string
  /** `agentRegistry.windowSessionId(last)` 算出来的那一个 —— 两边必须同一个 id。 */
  session_id: string
  /** 最新那句(壳读回来、截过的;`WindowAgentState.latest`)。缺席就不判。 */
  latest?: string
  /** 那句话什么时候变成这样的(`changed_at ?? at`)。 */
  at: string
  /** 那家此刻的运行状态(窗口那一路:在跑 / 做完了 / App 没开)。 */
  status: SessionStatus
  /** 最新那句是它刚说完的回话。不是(他刚说的 / 第一次读)就不判。 */
  answered?: boolean
  /** 那家叫什么(问题里用)。 */
  name?: string
}

export interface WaitModelDeps {
  /** 与事务官同一套模型服务(modelService.endpoint())。 */
  endpoint: () => Promise<{ ready: boolean, baseUrl: string, key?: string }>
  fetchImpl?: typeof fetch
  /** 能不能把会话的最后一来一回送去模型(授权表 `read_session_content` 是「可以」)。 */
  allowed: () => Promise<boolean>
  /** 一天最多花多少(元)。缺省读 `~/.dsh/workbench/budget.json` 的 `cny`(见 {@link readBudgetCny})。 */
  budgetCny: () => Promise<number>
  /**
   * 模型名,缺省 {@link WAIT_MODEL}。可以是静态串,也可以是**现取**的函数 ——
   * own 档他自己填的模型名(index.ts 从 modelService.endpoint().model 取来,2026-10-23 卡「事务官换Key」);
   * 现取不到就回缺省。
   */
  model?: string | (() => Promise<string | undefined>)
  timeoutMs?: number
}

/** 模型名解析:静态串照用;函数现取,取不到/取失败回缺省(判「在等你」这一路不该因此抛)。 */
export async function resolveWaitModelName(
  source: WaitModelDeps['model'],
  fallback: string,
): Promise<string> {
  if (source === undefined) return fallback
  if (typeof source === 'string') return source
  try { return (await source()) ?? fallback }
  catch { return fallback }
}

export interface WaitingServiceDeps {
  /** 此刻的会话表(还没叠「在等你」的那一份)。 */
  sessions: () => readonly SessionView[]
  /** 登记过的会话文件。 */
  files: () => readonly SessionFileRef[]
  /**
   * 读窗口读出来的那几条(2026-09-26,卡 WS;`agentDiscovery.windows()`)。缺席 = 没接窗口那一路,
   * 别的一字不变。**不碰盘、不碰网**:这一份是登记表内存里现成的。
   */
  windows?: () => readonly WindowWaitRef[]
  readTurns?: (ref: { format: DigestFormat, file: string }) => Promise<SessionTurns | undefined>
  statMtimeMs?: (file: string) => Promise<number | undefined>
  /** Claude 自己记的此刻开着的会话(sessionId → 忙闲 / 在等什么)。 */
  claudeLive?: () => Promise<ReadonlyMap<string, ClaudeLiveSession> | undefined>
  /**
   * 一条主会话底下的子任务(后台任务)。**这是给卡 Q 的口子**:设计第六节「会话形状加一层 children」由卡 Q 做,
   * 合进来之后这里接 Q 的 children(照 {@link ChildTask} 那几格换一下形状),不另读一遍。
   * Q 合进来之前缺省用 {@link createClaudeChildren}:只认 Claude 的子任务文件(`<主会话>/subagents/agent-*.jsonl` + `.meta.json`)。
   */
  childrenOf?: (main: SessionFileRef) => Promise<readonly ChildTask[]>
  now?: () => Date
  /** 两轮扫描的最短间隔,缺省 10 秒。 */
  minIntervalMs?: number
  model?: WaitModelDeps
  /**
   * 这一份的小账本(`~/.dsh/workbench/waiting.json`):今天问模型花了多少、他点过「不用管这条」的是哪几条会话的哪一句。
   * **不记任何内容**(只有日期、钱、次数、会话 id 与那句话的时刻)。缺席 = 只在内存里(重启就忘)。
   */
  stateFile?: string
  /** 某一条的判断变了(推一份快照)。 */
  onChange?: () => void
  /** 那一家叫什么(问题里用)。 */
  agentName?: (agent: string) => string
  /** 答了往哪送(`SessionAskView.reply` / `where`,sessionAnswer.ts 定)。 */
  replyOf?: (view: SessionView, ask: Pick<WaitVerdict, 'by' | 'child' | 'kind' | 'since' | 'quote'>) => AskReply | undefined
}

export interface WaitingService {
  /** 请求驱动的一次扫描(内部限频,失败静默)。 */
  pump: () => void
  /** 立刻扫一遍并等它扫完(用例与首次启动用)。 */
  scanNow: () => Promise<void>
  /** 出 /state 时叠一层。 */
  overlay: (views: readonly SessionView[], nowSec: number) => SessionView[]
  /**
   * 读窗口那条会话此刻有没有一问在等他(2026-09-26,卡 WS;登记表出视图时问一声)。
   * **只回 `ask`,不回状态** —— 窗口这一路永远是内容判出来的,按 09-26 的口径不许改运行状态。
   */
  askOf: (agent: string, sessionId: string) => SessionAskView | undefined
  /** 某一条此刻的判断(按它此刻的状态)。 */
  verdictOf: (agent: string, sessionId: string) => WaitVerdict | undefined
  /** 当它「这一轮说完了」时算不算在等他(Claude 那一路不回放说完了的会话 —— 在等他的要回放,不然看不见)。 */
  waitingIfIdle: (agent: string, sessionId: string) => boolean
  /** 今天问模型花了多少(排查用)。 */
  spend: () => { date: string, cny: number, calls: number }
  /** 这条会话从哪儿开的(读会话时记下的 Claude `entrypoint` / Codex `source`):答了往哪送看它。 */
  entryOf: (agent: string, sessionId: string) => string | undefined
  /** 这条会话在 Claude 桌面 App 里的编号(`local_…`,「去回答」的深链用);没见过就缺席。 */
  hostIdOf: (agent: string, sessionId: string) => string | undefined
  /**
   * 他点了「不用管这条」:按内容判出来的这一问(那家最后那句话)不再算在等他;那家说了新的一句就重新判。
   * 弹窗那种(权限、提问)点不掉 —— 那家真停着。回 false = 这条眼下没在等他(或只是弹窗)。
   */
  dismiss: (agent: string, sessionId: string) => Promise<boolean>
}

/** 拿不准时问哪个模型:V4 Flash、关掉「先想一遍」(同卡 N 进度评估的实测:几秒回、按 Flash 价记)。 */
export const WAIT_MODEL = 'deepseek-v4-flash'
const WAIT_MODEL_MAX_TOKENS = 400
/** 子任务多久没动就不算在跑。 */
const CHILD_ACTIVE_MS = 10 * 60_000
/** 同一段话问模型失败(连不上、核不上)之后多久再试。 */
const MODEL_RETRY_MS = 10 * 60_000
/** 模型判断最多记多少段。 */
const MODEL_CACHE_MAX = 500

/**
 * 价目(元 / 百万 token:缓存命中、未命中、输出),与中转 `relay/server/pricing.cjs` 同一张表、同一条口径:按高峰价记,
 * 名字里有 flash 的按 Flash,别的按 Pro —— 宁可多算。(卡 N、卡 O 各有一份同样的,合并时收成一份。)
 */
export function waitPriceOf(model: string): { hit: number, miss: number, output: number } {
  return /flash/i.test(model) ? { hit: 0.04, miss: 2, output: 8 } : { hit: 0.3, miss: 9, output: 27 }
}

/** 问之前估一次(字数 × 0.8 全按未命中,再加满额输出):估出来超上限就不问。 */
export function estimateWaitCny(model: string, promptChars: number, maxTokens = WAIT_MODEL_MAX_TOKENS): number {
  const price = waitPriceOf(model)
  return (Math.ceil(promptChars * 0.8) * price.miss + maxTokens * price.output) / 1_000_000
}

export function usageWaitCny(model: string, usage: unknown, fallback: number): number {
  if (typeof usage !== 'object' || usage === null) return fallback
  const raw = usage as Record<string, unknown>
  const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
  const prompt = num(raw.prompt_tokens)
  const hit = num(raw.prompt_cache_hit_tokens)
  const miss = typeof raw.prompt_cache_miss_tokens === 'number' ? num(raw.prompt_cache_miss_tokens) : Math.max(0, prompt - hit)
  const out = num(raw.completion_tokens)
  if (prompt === 0 && out === 0) return fallback
  const price = waitPriceOf(model)
  return (hit * price.hit + miss * price.miss + out * price.output) / 1_000_000
}

// 上限那份设置(`budget.json`)全仓只有一份:卡 O 的 `itemBudget.ts`。这里原样转出去,老的 import 照旧能用(合并卡 W,09-25)。
export { defaultBudgetFile, readBudgetCny } from './itemBudget.ts'

export function defaultWaitingLedgerFile(home: string): string {
  return join(home, '.dsh', 'workbench', 'waiting.json')
}

interface Ledger { date: string, cny: number, calls: number }

/** 小账本:今天的花费 + 「不用管这条」(会话 key → 那句话的时刻)。 */
interface WaitingState {
  ledger: Ledger
  dismissed: Map<string, string>
  /** 账本在盘上却读不出来(不是不存在):这一趟只记在内存里,不拿空账去盖它(2026-10-21)。 */
  readOnly?: boolean
}

function localDate(now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

async function readWaitingState(file: string | undefined, today: string): Promise<WaitingState> {
  const empty: WaitingState = { ledger: { date: today, cny: 0, calls: 0 }, dismissed: new Map() }
  if (file === undefined) return empty
  let text: string
  try { text = await readFile(file, 'utf8') }
  catch (error) {
    return (error as { code?: string }).code === 'ENOENT' ? empty : { ...empty, readOnly: true }
  }
  try {
    const raw = JSON.parse(text) as { day?: { date?: unknown, spend_cny?: unknown, calls?: unknown }, dismissed?: unknown }
    const day = raw.day
    const ledger = day !== undefined && day.date === today && typeof day.spend_cny === 'number'
      ? { date: today, cny: day.spend_cny, calls: typeof day.calls === 'number' ? day.calls : 0 }
      : empty.ledger
    const dismissed = new Map<string, string>()
    if (typeof raw.dismissed === 'object' && raw.dismissed !== null) {
      for (const [key, at] of Object.entries(raw.dismissed as Record<string, unknown>)) if (typeof at === 'string') dismissed.set(key, at)
    }
    return { ledger, dismissed }
  }
  catch {
    // 写坏了:原本挪到一边留着(今天花了多少、哪几条点过「不用管」都在里面),再从空账记。
    // 挪不动就只记内存,同样不盖它。
    const kept = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`
    return await rename(file, kept).then(() => empty, () => ({ ...empty, readOnly: true }))
  }
}

async function writeWaitingState(file: string | undefined, state: WaitingState): Promise<void> {
  if (file === undefined || state.readOnly === true) return
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.${randomUUID()}.tmp`
  const body = {
    day: { date: state.ledger.date, spend_cny: Math.round(state.ledger.cny * 1e6) / 1e6, calls: state.ledger.calls },
    // 只留最近的几百条(老会话早不在表里了)。
    dismissed: Object.fromEntries([...state.dismissed.entries()].slice(-300)),
  }
  await writeFile(tmp, `${JSON.stringify(body, null, 2)}\n`, 'utf8')
  await rename(tmp, file)
}

/** 问一次模型。**不抛**:任何失败都回 `{ error }`(这一段话先当判不出,过一阵再试)。 */
export async function askWaitModel(
  deps: Pick<WaitModelDeps, 'endpoint' | 'fetchImpl' | 'model' | 'timeoutMs'>,
  exchange: WaitModelExchange,
  agentName?: string,
): Promise<{ verdict?: WaitVerdict, usage?: unknown, error?: string }> {
  let endpoint: { ready: boolean, baseUrl: string, key?: string }
  try { endpoint = await deps.endpoint() }
  catch (error) { return { error: `模型服务查不到(${error instanceof Error ? error.message : String(error)})` } }
  if (!endpoint.ready) return { error: '模型服务还没接上' }
  const prompt = waitModelPrompt(exchange, agentName)
  const fetchImpl = deps.fetchImpl ?? fetch
  const call = async (strict: boolean): Promise<{ status: number, body?: Record<string, unknown>, error?: string }> => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? 30_000)
    ;(timer as { unref?: () => void }).unref?.()
    try {
      const response = await fetchImpl(`${endpoint.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(endpoint.key === undefined ? {} : { authorization: `Bearer ${endpoint.key}` }) },
        body: JSON.stringify({
          model: await resolveWaitModelName(deps.model, WAIT_MODEL),
          messages: [{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }],
          temperature: 0,
          max_tokens: WAIT_MODEL_MAX_TOKENS,
          // V4 默认先「想」一遍,想的字也占 max_tokens(卡 N 实测:全花在想上、正文一个字不回)。判这个不用想。
          thinking: { type: 'disabled' },
          ...(strict ? { response_format: { type: 'json_object' } } : {}),
        }),
        signal: controller.signal,
      })
      if (!response.ok) return { status: response.status, error: `模型服务回了 ${response.status}` }
      return { status: 200, body: await response.json() as Record<string, unknown> }
    }
    catch (error) {
      const aborted = error instanceof Error && error.name === 'AbortError'
      return { status: 0, error: aborted ? '模型超时' : `连不上模型服务(${error instanceof Error ? error.message.split('\n')[0] : String(error)})` }
    }
    finally { clearTimeout(timer) }
  }
  let reply = await call(true)
  if (reply.status === 400) reply = await call(false)
  if (reply.body === undefined) return { error: reply.error ?? '模型没回' }
  const usage = reply.body.usage
  const choices = reply.body.choices as { message?: { content?: unknown } }[] | undefined
  const content = choices?.[0]?.message?.content
  if (typeof content !== 'string' || content.trim() === '') return { error: '模型没回内容', usage }
  const text = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
  let json: unknown
  try { json = JSON.parse(text) }
  catch {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    try { json = start >= 0 && end > start ? JSON.parse(text.slice(start, end + 1)) : undefined }
    catch { json = undefined }
  }
  const verdict = parseWaitModelReply(json, exchange)
  if (verdict === undefined) return { error: '模型回的依据在原话里对不上', usage }
  return { verdict, usage }
}

/**
 * Q 的 children 合进来之前的那一份(先留口子):Claude 主会话的子任务 —— `<主会话文件去掉 .jsonl>/subagents/agent-*.jsonl`,
 * 说明从同名 `.meta.json` 的 `description` 读(只读那一格)。只看最近 10 分钟动过的;文件没动不重读(`cache`)。
 * 状态:挂着提问 / 批计划 → 在等他;最后一句是它这一轮的最终回答 → 做完了;其余 → 在跑。
 */
export function createClaudeChildren(options: { now?: () => Date, readTurns?: (ref: { format: DigestFormat, file: string }) => Promise<SessionTurns | undefined> } = {}): (main: SessionFileRef) => Promise<ChildTask[]> {
  const now = options.now ?? (() => new Date())
  const readTurns = options.readTurns ?? (ref => readSessionTurns(ref, { headBytes: 16 * 1024, maxHeadBytes: 16 * 1024, tailBytes: 96 * 1024 }))
  const cache = new Map<string, { mtimeMs: number, child: ChildTask }>()
  return async (main) => {
    if (main.format !== 'claude-transcript') return []
    const dir = join(main.file.replace(/\.jsonl$/, ''), 'subagents')
    let names: string[]
    try { names = await readdir(dir) }
    catch { return [] }
    const nowMs = now().getTime()
    const out: ChildTask[] = []
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue
      const file = join(dir, name)
      let mtimeMs: number
      try { mtimeMs = (await stat(file)).mtimeMs }
      catch { continue }
      if (nowMs - mtimeMs > CHILD_ACTIVE_MS) { cache.delete(file); continue }
      const known = cache.get(file)
      if (known !== undefined && known.mtimeMs === mtimeMs) { out.push(known.child); continue }
      const turns = await readTurns({ format: 'claude-transcript', file }).catch(() => undefined)
      let title: string | undefined
      try {
        const meta = JSON.parse(await readFile(file.replace(/\.jsonl$/, '.meta.json'), 'utf8')) as { description?: unknown }
        if (typeof meta.description === 'string' && meta.description.trim() !== '') title = meta.description.trim().slice(0, 60)
      }
      catch { /* 没有说明就不写 */ }
      const last = turns?.turns[turns.turns.length - 1]
      const pending = turns?.pending
      const status: ChildTask['status'] = pending?.kind === 'question' || pending?.kind === 'plan'
        ? 'waiting'
        : last !== undefined && last.k === 'reply' && last.final === true ? 'done' : 'running'
      const child: ChildTask = {
        id: name.replace(/\.jsonl$/, ''),
        ...(title === undefined ? {} : { title }),
        status,
        ...(pending === undefined ? {} : { pending }),
        updated_at: new Date(mtimeMs).toISOString(),
      }
      cache.set(file, { mtimeMs, child })
      out.push(child)
    }
    return out
  }
}

interface Cached {
  mtime: number
  /**
   * 读窗口那一路的「变没变」(卡 WS):没有文件可 stat,拿「那句话 + 它的时刻」当指纹 ——
   * 一样就不重判(同「文件没动一个字节都不读」那条纪律)。
   */
  stamp?: string
  /** 上一次真读这份文件的时刻(毫秒)。 */
  readAt: number
  facts: WaitFacts
  entry?: string
  /** 规则拿不准、等着问模型的那一段(问完就扔)。 */
  exchange?: WaitModelExchange
  messageKey?: string
}

export function createWaitingService(deps: WaitingServiceDeps): WaitingService {
  const now = deps.now ?? (() => new Date())
  const minIntervalMs = deps.minIntervalMs ?? 10_000
  // 头上只要开头几条(是不是子任务、挂在谁下面、从哪开的),16KB 足够;在问他的话都在尾巴上。
  const readTurns = deps.readTurns ?? (ref => readSessionTurns(ref, { headBytes: 16 * 1024, maxHeadBytes: 16 * 1024, tailBytes: 192 * 1024 }))
  const statMtime = deps.statMtimeMs ?? (async (file: string) => {
    try { return (await stat(file)).mtimeMs }
    catch { return undefined }
  })
  const childrenOf = deps.childrenOf ?? createClaudeChildren({ now, readTurns })
  const cache = new Map<string, Cached>()
  /** 主会话 key → 它的子任务里最重的那个(在跑的子任务让空闲的主会话算在跑)。 */
  let childLoads = new Map<string, SessionLoad>()
  /** 主会话 key → 它底下的子任务(子任务在等他时冒到主会话上)。 */
  let childrenByKey = new Map<string, readonly ChildTask[]>()
  let live: ReadonlyMap<string, ClaudeLiveSession> | undefined
  /** Claude 会话 id → 桌面 App 里的编号(进程退了也记着:那段对话在 App 里还在)。 */
  const hostIds = new Map<string, string>()
  /** 按消息哈希缓存的模型判断('failed' = 问过没问成,过一阵再试)。 */
  const modelCache = new Map<string, { verdict?: WaitVerdict, failedAt?: number }>()
  const modelQueue: { key: string, exchange: WaitModelExchange, agent: string }[] = []
  let modelBusy = false
  let state: WaitingState = { ledger: { date: localDate(now()), cny: 0, calls: 0 }, dismissed: new Map() }
  let stateLoaded = false
  let lastRunAt = 0
  let scanning: Promise<void> | undefined
  /** 上一次叠出来的判断的指纹(变了才推快照)。 */
  let lastFingerprint = ''

  const keyOf = (agent: string, sessionId: string): string => `${agent}:${sessionId}`
  const nameOf = (agent: string): string => deps.agentName?.(agent) ?? agent

  function signalsOf(view: { agent: string, session_id: string, status: SessionView['status'], reason?: SessionView['reason'], wait_reason?: SessionView['wait_reason'], formal_wait?: SessionView['formal_wait'], elapsed_sec: number }, nowSec: number): WaitSignals {
    const liveInfo = view.agent === 'claude' ? live?.get(view.session_id) : undefined
    return {
      status: view.status,
      ...(view.reason === undefined ? {} : { reason: view.reason }),
      ...(view.wait_reason === undefined ? {} : { wait_reason: view.wait_reason }),
      // 记录里明写着的那一条待批/待答(卡 KM):`form:blocked` 那一支只认它,没有它就不算形式上的在等你。
      ...(view.formal_wait === undefined ? {} : { formal_wait: view.formal_wait }),
      status_since: new Date((nowSec - view.elapsed_sec) * 1000).toISOString(),
      ...(liveInfo?.alive === true && liveInfo.waitingFor !== undefined ? { waiting_for: liveInfo.waitingFor } : {}),
      now: new Date(nowSec * 1000).toISOString(),
      agent_name: nameOf(view.agent),
    }
  }

  /** 事实 × 状态 → 判断;规则拿不准时看模型那一格。 */
  function verdictFor(key: string, signals: WaitSignals): WaitVerdict {
    const cached = cache.get(key)
    const facts = cached?.facts ?? { hisTurn: false }
    const dismissed = withDismissed(key, facts, decide(facts, signals))
    const own = dismissed.rule === 'dismissed' ? dismissed : withModel(cached, facts, dismissed)
    // 子任务在等他:冒到主会话上(主会话关了就不算)。
    if (signals.status === 'offline') return own
    const children = childrenByKey.get(key)
    return children === undefined || children.length === 0 ? own : withChildWait(own, facts, childWaitOf(children, signals))
  }

  /** 他点过「不用管这条」、那家还没说新的一句:按内容判出来的不算(弹窗那种照算)。 */
  function withDismissed(key: string, facts: WaitFacts, verdict: WaitVerdict): WaitVerdict {
    const at = state.dismissed.get(key)
    if (at === undefined || at !== (facts.answerAt ?? '') || verdict.by === 'form') return verdict
    return { waiting: false, certainty: 'sure', by: verdict.by, rule: 'dismissed' }
  }

  function withModel(cached: Cached | undefined, facts: WaitFacts, verdict: WaitVerdict): WaitVerdict {
    if (verdict.waiting || verdict.certainty !== 'unsure' || cached?.messageKey === undefined) return verdict
    const asked = modelCache.get(cached.messageKey)?.verdict
    if (asked === undefined) return verdict
    if (!asked.waiting) return { ...asked, rule: 'model:no' }
    return { ...asked, ...(facts.answerAt === undefined ? {} : { since: facts.answerAt }) }
  }

  /** 读一次小账本;换了一天,花费从 0 记(「不用管这条」留着)。 */
  async function ensureState(): Promise<void> {
    const today = localDate(now())
    if (!stateLoaded) {
      state = await readWaitingState(deps.stateFile, today)
      stateLoaded = true
    }
    if (state.ledger.date !== today) state = { ...state, ledger: { date: today, cny: 0, calls: 0 } }
  }

  async function drainModel(): Promise<void> {
    const model = deps.model
    if (model === undefined || modelBusy) return
    modelBusy = true
    try {
      while (modelQueue.length > 0) {
        const job = modelQueue.shift()!
        if (modelCache.get(job.key)?.verdict !== undefined) continue
        let allowed = false
        try { allowed = await model.allowed() }
        catch { allowed = false }
        if (!allowed) { modelQueue.length = 0; return }
        await ensureState()
        const cap = await model.budgetCny().catch(() => 0.5)
        const name = await resolveWaitModelName(model.model, WAIT_MODEL)
        const prompt = waitModelPrompt(job.exchange, nameOf(job.agent))
        const estimate = estimateWaitCny(name, prompt.system.length + prompt.user.length)
        if (state.ledger.cny + estimate > cap) { modelQueue.length = 0; return }
        const result = await askWaitModel(model, job.exchange, nameOf(job.agent))
        const spent = result.usage === undefined && result.error !== undefined && result.error.startsWith('连不上') ? 0 : usageWaitCny(name, result.usage, estimate)
        state = { ...state, ledger: { date: state.ledger.date, cny: state.ledger.cny + spent, calls: state.ledger.calls + 1 } }
        await writeWaitingState(deps.stateFile, state).catch(() => {})
        modelCache.set(job.key, result.verdict === undefined ? { failedAt: now().getTime() } : { verdict: result.verdict })
        // 只留最近的几百段(同一段话只问一次;老的会话早就不在表里了)。
        while (modelCache.size > MODEL_CACHE_MAX) {
          const oldest = modelCache.keys().next().value
          if (oldest === undefined) break
          modelCache.delete(oldest)
        }
        if (result.verdict !== undefined) notifyIfChanged()
      }
    }
    finally { modelBusy = false }
  }

  function queueModel(key: string, exchange: WaitModelExchange, agent: string): void {
    if (deps.model === undefined) return
    const known = modelCache.get(key)
    if (known?.verdict !== undefined) return
    if (known?.failedAt !== undefined && now().getTime() - known.failedAt < MODEL_RETRY_MS) return
    if (modelQueue.some(job => job.key === key)) return
    modelQueue.push({ key, exchange, agent })
  }

  function fingerprint(): string {
    const nowSec = Math.floor(now().getTime() / 1000)
    const parts: string[] = []
    for (const view of deps.sessions()) {
      const verdict = verdictFor(keyOf(view.agent, view.session_id), signalsOf(view, nowSec))
      parts.push(`${view.agent}:${view.session_id}:${verdict.waiting ? `${verdict.kind}|${verdict.question}` : '-'}`)
    }
    // 读窗口那几条(卡 WS):那一问变了也要推一份快照(否则「等你 n」要等下一次轮询才动)。
    for (const win of deps.windows?.() ?? []) {
      const verdict = windowVerdict(win)
      parts.push(`${win.agent}:${win.session_id}:${verdict?.waiting === true ? `${verdict.kind}|${verdict.question}` : '-'}`)
    }
    for (const [key, load] of childLoads) parts.push(`${key}>${load}`)
    for (const [key, children] of childrenByKey) parts.push(`${key}>${children.map(child => `${child.id}:${child.status}:${child.pending?.kind ?? ''}`).join(',')}`)
    return parts.sort().join('\n')
  }

  function notifyIfChanged(): void {
    const next = fingerprint()
    if (next === lastFingerprint) return
    lastFingerprint = next
    deps.onChange?.()
  }

  async function scan(): Promise<void> {
    await ensureState()
    const nowMs = now().getTime()
    try { live = await deps.claudeLive?.() }
    catch { live = undefined }
    for (const [sessionId, info] of live ?? []) {
      if (info.hostSessionId !== undefined) hostIds.set(sessionId, info.hostSessionId)
    }
    while (hostIds.size > 500) {
      const oldest = hostIds.keys().next().value
      if (oldest === undefined) break
      hostIds.delete(oldest)
    }
    const seen = new Set<string>()
    const nextChildren = new Map<string, SessionLoad>()
    const nextChildrenByKey = new Map<string, readonly ChildTask[]>()
    /** 那家自己报的状态(没叠过的那一份),这一轮只取一次。 */
    const rawStatusOf = new Map(deps.sessions().map(one => [keyOf(one.agent, one.session_id), one.status]))
    for (const ref of deps.files()) {
      if (ref.agent === 'dsh') continue
      const key = keyOf(ref.agent, ref.session_id)
      seen.add(key)
      const mtime = await statMtime(ref.file)
      if (mtime === undefined || nowMs - mtime > WAIT_MAX_AGE_MS) { cache.delete(key); continue }
      const before = cache.get(key)
      // 正在跑、文件一直在长的那几条(统筹那条 40MB、每秒都在写):一分钟最多读一回 —— 它在跑时判不出「在等你」,
      // 停下来那一刻文件就不长了,下一拍照常读。
      const rawStatus = rawStatusOf.get(key)
      const busyGrowing = before !== undefined && before.mtime !== mtime && rawStatus === 'running' && nowMs - before.readAt < 60_000
      if ((before === undefined || before.mtime !== mtime) && !busyGrowing) {
        const turns = await readTurns({ format: ref.format, file: ref.file }).catch(() => undefined)
        if (turns === undefined) { cache.delete(key); continue }
        const facts = factsOf(turns)
        const entry: Cached = { mtime, readAt: nowMs, facts, ...(turns.entry === undefined ? {} : { entry: turns.entry }) }
        if (facts.content?.certainty === 'unsure' && !facts.content.waiting) {
          const exchange = modelExchangeOf(turns)
          if (exchange !== undefined) {
            entry.exchange = exchange
            entry.messageKey = waitMessageKey(exchange)
          }
        }
        cache.set(key, entry)
      }
      const entry = cache.get(key)
      // 拿不准、这会儿它又没在跑 / 没关:排队问一次模型(按消息哈希,问过的不再问)。
      if (entry?.exchange !== undefined && entry.messageKey !== undefined) {
        const status = rawStatus ?? 'done'
        if (status !== 'running' && status !== 'offline') queueModel(entry.messageKey, entry.exchange, ref.agent)
      }
      // 子任务(后台任务):挂在主会话下 —— 在跑的让主会话算在跑,在等他的冒到主会话上(不单算一条)。
      const children = await childrenOf(ref).catch(() => [] as readonly ChildTask[])
      if (children.length > 0) {
        nextChildrenByKey.set(key, children)
        const load = children.reduce<SessionLoad>((heaviest, child) => heavier(heaviest, child.status === 'running' ? 'running' : 'idle'), 'idle')
        if (load !== 'idle') nextChildren.set(key, load)
      }
    }
    scanWindows(seen)
    for (const key of [...cache.keys()]) if (!seen.has(key)) cache.delete(key)
    childLoads = nextChildren
    childrenByKey = nextChildrenByKey
    notifyIfChanged()
    void drainModel().catch(() => {})
  }

  /**
   * 读窗口读出来的那几条(卡 WS):把「最新那句」当**只有最后一段回话**的一条会话,过同一份 `factsOf`。
   * 不碰盘、不碰网;那句话没变过就不重判(`stamp`);规则拿不准的照旧排队问一次模型(同一个上限、同一份缓存)。
   */
  function scanWindows(seen: Set<string>): void {
    for (const win of deps.windows?.() ?? []) {
      if (win.agent === 'dsh') continue
      const key = keyOf(win.agent, win.session_id)
      seen.add(key)
      // 没读到那句话、或者那句话不是它刚说完的(他刚说的、第一次读)→ 不判,把上一次的也忘掉。
      if (win.latest === undefined || win.latest.trim() === '' || win.answered !== true) { cache.delete(key); continue }
      const stamp = windowStamp(win)
      const before = cache.get(key)
      if (before?.stamp === stamp) continue
      const turns: SessionTurns = { format: 'claude-transcript', turns: [{ k: 'reply', text: win.latest, at: win.at, final: true }] }
      const facts = factsOf(turns)
      const entry: Cached = { mtime: 0, stamp, readAt: now().getTime(), facts }
      if (facts.content?.certainty === 'unsure' && !facts.content.waiting) {
        const exchange = modelExchangeOf(turns)
        if (exchange !== undefined) {
          entry.exchange = exchange
          entry.messageKey = waitMessageKey(exchange)
        }
      }
      cache.set(key, entry)
      if (entry.exchange !== undefined && entry.messageKey !== undefined && win.status !== 'running' && win.status !== 'offline') {
        queueModel(entry.messageKey, entry.exchange, win.agent)
      }
    }
  }

  /** 读窗口那一条的状态信号(窗口这一路读不出形式信号 —— 没有 `waiting_for`、没有弹窗)。 */
  function windowSignals(win: WindowWaitRef): WaitSignals {
    return {
      status: win.status,
      status_since: win.at,
      now: now().toISOString(),
      agent_name: win.name ?? win.agent,
    }
  }

  function windowRef(agent: string, sessionId: string): WindowWaitRef | undefined {
    return deps.windows?.().find(one => one.agent === agent && one.session_id === sessionId)
  }

  /** 读窗口那一条那句话的指纹(「变没变」拿它比,顶替文件那边的 mtime)。 */
  function windowStamp(win: WindowWaitRef): string {
    return `${win.at}\u0000${win.latest ?? ''}`
  }

  /**
   * 读窗口那一条此刻的判断。**只对「已经判过的那一句」下结论**:
   * 没扫过、不是它刚说完的、或者那句话已经变了(他在那扇窗里回了话,而这一拍还没扫)→ 缺席。
   * 这一条让那一问**当场就撤**,不用等下一次扫(限频 10 秒)。
   */
  function windowVerdict(win: WindowWaitRef): WaitVerdict | undefined {
    if (win.answered !== true) return undefined
    const cached = cache.get(keyOf(win.agent, win.session_id))
    if (cached === undefined || cached.stamp !== windowStamp(win)) return undefined
    return verdictFor(keyOf(win.agent, win.session_id), windowSignals(win))
  }

  function verdictOfSession(agent: string, sessionId: string): WaitVerdict | undefined {
    const view = deps.sessions().find(one => one.agent === agent && one.session_id === sessionId)
    // 会话表里没有 → 也许是读窗口读出来的那一条(卡 WS):按窗口那一路问一遍,
    // 「不用管这条」这类操作对两路一视同仁。
    if (view === undefined) {
      const win = windowRef(agent, sessionId)
      return win === undefined ? undefined : windowVerdict(win)
    }
    return verdictFor(keyOf(agent, sessionId), signalsOf(view, Math.floor(now().getTime() / 1000)))
  }

  function runScan(): Promise<void> {
    if (scanning !== undefined) return scanning
    lastRunAt = now().getTime()
    scanning = scan().catch(() => {}).finally(() => { scanning = undefined })
    return scanning
  }

  return {
    pump() {
      if (scanning !== undefined || now().getTime() - lastRunAt < minIntervalMs) return
      void runScan()
    },
    scanNow: runScan,
    overlay(views, nowSec) {
      const verdicts = new Map<string, WaitVerdict>()
      for (const view of views) {
        if (view.agent === 'dsh') continue
        verdicts.set(keyOf(view.agent, view.session_id), verdictFor(keyOf(view.agent, view.session_id), signalsOf(view, nowSec)))
      }
      return overlayWaiting(views, verdicts, childLoads, { nowSec, ...(deps.replyOf === undefined ? {} : { replyOf: deps.replyOf }) })
    },
    askOf(agent, sessionId) {
      const win = windowRef(agent, sessionId)
      if (win === undefined) return undefined
      const verdict = windowVerdict(win)
      if (verdict === undefined || !verdict.waiting) return undefined
      /**
       * 窗口这一路**只挂 `ask`**(09-26 口径):`by` 必然是 `rules` / `model`,
       * `overlayWaiting` 那边同样的 `by !== 'form'` 分支也是只挂 ask、不改状态。
       * 万一哪天读出了形式信号,这里也不替它改状态 —— 改状态得走会话那条路,别在这儿开第二个口子。
       *
       * **不带「去哪儿答」**(`reply` / `where`):那一套(`sessionAnswer`)认的是 `/state.sessions` 里的会话,
       * 窗口读出来的这一条不在那份表里,`POST /sessions/answer` 会 404。他就在那扇窗里说一句 ——
       * 说了 `latest` 就变了,这一问下一拍自己撤掉。替它编一个「去回答」的入口反而是骗他点。
       */
      return askViewOf(verdict, win.at)
    },
    verdictOf: verdictOfSession,
    waitingIfIdle(agent, sessionId) {
      const key = keyOf(agent, sessionId)
      if (!cache.has(key)) return false
      const nowSec = Math.floor(now().getTime() / 1000)
      return verdictFor(key, signalsOf({ agent, session_id: sessionId, status: 'done', elapsed_sec: 0 }, nowSec)).waiting
    },
    spend() {
      return { date: state.ledger.date, cny: state.ledger.cny, calls: state.ledger.calls }
    },
    entryOf(agent, sessionId) {
      return cache.get(keyOf(agent, sessionId))?.entry
    },
    hostIdOf(agent, sessionId) {
      return agent === 'claude' ? hostIds.get(sessionId) : undefined
    },
    async dismiss(agent, sessionId) {
      await ensureState()
      const key = keyOf(agent, sessionId)
      const verdict = verdictOfSession(agent, sessionId)
      if (verdict === undefined || !verdict.waiting || verdict.by === 'form') return false
      state.dismissed.set(key, cache.get(key)?.facts.answerAt ?? '')
      await writeWaitingState(deps.stateFile, state).catch(() => {})
      notifyIfChanged()
      return true
    },
  }
}
