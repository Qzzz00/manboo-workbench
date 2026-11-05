/**
 * 进度靠证据 —— **服务那一半**(2026-09-25,卡 N;设计 docs/设计-谁来做与进度靠证据-2026-09-25.md 第一节第 5 条)。
 *
 * 每张卡「现在到哪 · 依据 · 什么时候看的」由证据得出,不照引导里的口述。三个时机:
 *
 * | 时机 | 谁叫 | 核哪几张 |
 * |---|---|---|
 * | 每天早报之前一次 | 例程 `progressBeforeMorning` | 看板上该核的全部(在办的、这三天办完的);早报只念**变了的** |
 * | 他问「XX 到哪了」 | `/progress/ask`(打字 / 电话 / 事务官会话) | 他说的那几张,当场核 |
 * | 派出去的活回来了 | 负责人驱动看到卡上交回来的话 | 那一张 |
 * | 派活之前 | 负责人驱动 | 那一张(按证据写指令,不照旧话) |
 *
 * 纪律:
 * - **不编**:模型写的每一句都要附原文摘录,逐字核过才留(progressEvidence.verifyJudgement);一条都核不上 = 「还没看到进展,要你说一句」。
 * - **有上限**:每跑一轮算「一件事」,模型花费不超过「每件事上限」(与卡 O 同一套设置,缺省 0.5 元);一天所有评估不超过两倍。
 *   到了就只用规则(只摘原话,不写原话里没有的字),卡上与早报如实写。没变的证据不重问模型(24 小时内)。
 * - **只读**:仓库、会话、文档一概只读;会话正文要授权表 `read_session_content` 是「可以」—— 「要问」时问他一次
 *  (外层提问,卡 M 那一套:{@link ACCESS_QUESTION}),等他答之前只看仓库与看板。存下来的只有核过的一两句摘录,不存会话原文。
 * - **证据里冒出来的下一步**自动成卡(「待排」、`origin:'evidence'`),在「等你确认」里问他要不要加;提过的不再提。
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type {
  ProgressRunStateView, ProgressTrigger, SprintView, BoardModule, TaskAssignee, TaskProgressView, TaskStatus, TaskView, TasksState,
} from '../protocol.ts'
import { PROGRESS_NONE_LINE, isTrackedItem, progressNoneHint, statusPathTo } from '../protocol.ts'
import type { Candidate, EvalCard, EvidenceItem, Judgement, ProposedStep } from './progressEvidence.ts'
import {
  buildJudgePrompt, cardSubject, clip, coverage, judgementsFromModel, salvageJudgeItems, namedSessionsIn, normalizeText, pickCandidates, progressView,
  peopleText, proposalsFrom, rulesJudge, shortAt, shownQuote, createScoreCache,
} from './progressEvidence.ts'
import type { ProjectRef, SaidEntry, SessionCache, SourceDeps } from './progressSources.ts'
import { boardEvidence, claudeEvidence, codexEvidence, isTestItem, pruneSessionCache, repoEvidence, saidEvidence } from './progressSources.ts'

// ———————————————————————————— 落盘 ————————————————————————————

export function defaultProgressFile(home = process.env.HOME ?? ''): string {
  return `${home}/.dsh/workbench/progress.json`
}

interface StoredProgress extends TaskProgressView {
  /** 这一次交给判断的那几条证据的指纹(没变就不重问模型)。 */
  key?: string
}

interface RunRecord {
  at: string
  trigger: ProgressTrigger
  cards: number
  spend_cny: number
  by: 'model' | 'rules'
  note?: string
}

interface ProposedRecord {
  title: string
  task_id?: string
  from_task: string
  at: string
}

/**
 * 挂在外层等他答的一问(2026-09-26,卡 U8)。
 *
 * **为什么要落盘**:0.4.1 → 0.4.2 热更新重启之后,球下的「等你」从 6 变 4 —— 少的正是两条
 * 「『XX』问你:进度要你说一句」。提问经纪人(卡 M 的 `questionBroker`)只在内存里,
 * 重启就空了;而这几问原来只会在**下一轮进度核对**(早报前、他手动点、派活前)才重新挂上,
 * 那可能是十几个小时以后。**「他之前看到的问题不能凭空消失」** —— 所以挂了哪几问记在这里,
 * 起服务时照这一份原样挂回去(`resume`);答掉 / 撤掉就删。
 *
 * 顺带说清另一件事:同一时刻挂着的三条派活审批(卡 N 驱动问的「这张派给 X 开工?」)
 * 之所以「跨过了重启」,不是因为审批落了盘 —— 审批经纪人也只在内存里 —— 而是因为
 * **驱动 30 秒一拍会照 drive.json 重新问一遍**(itemDriver 的 `reconcile`)。
 * 这里做的是同一件事的同一种做法:账在自己的文件里,起来照账挂回。
 */
interface AskRecord {
  /** 挂出去的**原话**(重启后照它挂回,不重算 —— 措辞变了他会以为是另一问)。 */
  question: string
  /** 第一次问他是什么时候(挂回去也用它:那一问不该看起来像刚问的)。 */
  at: string
}

/** 「看各家的对话」那一问在账上的键(别的键都是事项 id)。 */
export const ACCESS_ASK_KEY = 'access'

export interface ProgressFile {
  version: 1
  cards: Record<string, StoredProgress>
  runs: RunRecord[]
  said: Record<string, SaidEntry[]>
  proposed: ProposedRecord[]
  /** 上一次早报时每张卡那一句(早报只念变了的)。 */
  morning: Record<string, string>
  /** 这会儿挂在外层等他答的那几问(键:事项 id,或 {@link ACCESS_ASK_KEY})。见 {@link AskRecord}。 */
  asks: Record<string, AskRecord>
  /** 今天一共花了多少(元)。换了一天清零。 */
  day?: { date: string, spend_cny: number }
}

export function emptyProgressFile(): ProgressFile {
  return { version: 1, cards: {}, runs: [], said: {}, proposed: [], morning: {}, asks: {} }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 容错读:文件坏了当空(看板照旧,只是还没核过)。 */
export function parseProgressFile(value: unknown): ProgressFile {
  if (!isRecord(value)) return emptyProgressFile()
  const cards: Record<string, StoredProgress> = {}
  if (isRecord(value.cards)) {
    for (const [id, raw] of Object.entries(value.cards)) {
      if (!isRecord(raw) || typeof raw.line !== 'string' || typeof raw.checked_at !== 'string') continue
      const state = raw.state === 'found' || raw.state === 'none' || raw.state === 'mismatch' ? raw.state : 'none'
      cards[id] = {
        line: raw.line,
        state,
        basis: Array.isArray(raw.basis) ? raw.basis.filter(isRecord).map(b => ({
          kind: (typeof b.kind === 'string' ? b.kind : 'item') as TaskProgressView['basis'][number]['kind'],
          source: typeof b.source === 'string' ? b.source : '',
          ...(typeof b.ref === 'string' ? { ref: b.ref } : {}),
          ...(typeof b.at === 'string' ? { at: b.at } : {}),
          ...(typeof b.quote === 'string' ? { quote: b.quote } : {}),
        })) : [],
        checked_at: raw.checked_at,
        ...(raw.waiting_on === 'me' || raw.waiting_on === 'agent' || raw.waiting_on === 'others' || raw.waiting_on === 'nobody' ? { waiting_on: raw.waiting_on } : {}),
        ...(typeof raw.mismatch === 'string' ? { mismatch: raw.mismatch } : {}),
        by: raw.by === 'model' ? 'model' : 'rules',
        ...(typeof raw.key === 'string' ? { key: raw.key } : {}),
      }
    }
  }
  const said: Record<string, SaidEntry[]> = {}
  if (isRecord(value.said)) {
    for (const [id, raw] of Object.entries(value.said)) {
      if (!Array.isArray(raw)) continue
      const list = raw.filter(isRecord).filter(one => typeof one.text === 'string' && typeof one.at === 'string').map(one => ({ text: one.text as string, at: one.at as string }))
      if (list.length > 0) said[id] = list.slice(-5)
    }
  }
  const runs = Array.isArray(value.runs) ? value.runs.filter(isRecord).filter(one => typeof one.at === 'string').map(one => ({
    at: one.at as string,
    trigger: (typeof one.trigger === 'string' ? one.trigger : 'manual') as ProgressTrigger,
    cards: typeof one.cards === 'number' ? one.cards : 0,
    spend_cny: typeof one.spend_cny === 'number' ? one.spend_cny : 0,
    by: (one.by === 'model' ? 'model' : 'rules') as 'model' | 'rules',
    ...(typeof one.note === 'string' ? { note: one.note } : {}),
  })) : []
  const proposed = Array.isArray(value.proposed) ? value.proposed.filter(isRecord).filter(one => typeof one.title === 'string' && typeof one.at === 'string').map(one => ({
    title: one.title as string,
    ...(typeof one.task_id === 'string' ? { task_id: one.task_id } : {}),
    from_task: typeof one.from_task === 'string' ? one.from_task : '',
    at: one.at as string,
  })) : []
  const morning: Record<string, string> = {}
  if (isRecord(value.morning)) for (const [id, line] of Object.entries(value.morning)) if (typeof line === 'string') morning[id] = line
  // 挂着的那几问(卡 U8)。少一格就不挂那一问 —— 挂一问空话回去比不挂更糟。
  const asks: Record<string, AskRecord> = {}
  if (isRecord(value.asks)) {
    for (const [key, raw] of Object.entries(value.asks)) {
      if (!isRecord(raw) || typeof raw.question !== 'string' || raw.question === '' || typeof raw.at !== 'string') continue
      asks[key] = { question: raw.question, at: raw.at }
    }
  }
  const day = isRecord(value.day) && typeof value.day.date === 'string' && typeof value.day.spend_cny === 'number'
    ? { date: value.day.date, spend_cny: value.day.spend_cny }
    : undefined
  return { version: 1, cards, runs: runs.slice(-30), said, proposed: proposed.slice(-200), morning, asks, ...(day === undefined ? {} : { day }) }
}

// ———————————————————————————— 花费 ————————————————————————————

/**
 * 价目(元 / 百万 token:缓存命中、未命中、输出)。与中转 `relay/server/pricing.cjs` 同一张表、同一条口径:
 * 按高峰价记;认不出的 DeepSeek 模型名(deepseek-chat 这种)按 Pro 那一档 —— 宁可多算。
 */
export function priceOf(model: string): { hit: number, miss: number, output: number } {
  if (/flash/i.test(model)) return { hit: 0.04, miss: 2, output: 8 }
  return { hit: 0.3, miss: 9, output: 27 }
}

/** 问之前估一次:字数 × 0.8(中文一个字约一个 token,宁可多估)全按未命中算,再加满额输出。 */
export function estimateCny(model: string, promptChars: number, maxTokens: number): number {
  const price = priceOf(model)
  return (Math.ceil(promptChars * 0.8) * price.miss + maxTokens * price.output) / 1_000_000
}

export function usageCny(model: string, usage: Record<string, unknown> | undefined, fallback: number): number {
  if (usage === undefined) return fallback
  const price = priceOf(model)
  const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
  const prompt = num(usage.prompt_tokens)
  const hit = num(usage.prompt_cache_hit_tokens)
  const miss = typeof usage.prompt_cache_miss_tokens === 'number' ? num(usage.prompt_cache_miss_tokens) : Math.max(0, prompt - hit)
  const out = num(usage.completion_tokens)
  if (prompt === 0 && out === 0) return fallback
  return (hit * price.hit + miss * price.miss + out * price.output) / 1_000_000
}

// 上限那份设置(`budget.json`)全仓只有一份:卡 O 的 `itemBudget.ts`(合并卡 W 09-25 收成一份)。
// 这里原样转出去 —— 卡 N 读的是同一个文件、同一个键 `cny`,行为一字不变。
export { defaultBudgetFile, readBudgetCny } from './itemBudget.ts'

// ———————————————————————————— 问模型 ————————————————————————————

export interface ProgressModel {
  endpoint: () => Promise<{ ready: boolean, baseUrl: string, key?: string }>
  fetchImpl?: typeof fetch
  /**
   * 模型名,缺省 {@link PROGRESS_MODEL}。可以是静态串,也可以是**现取**的函数 ——
   * own 档他自己填的模型名(index.ts 从 modelService.endpoint().model 取来,2026-10-23 卡「事务官换Key」);
   * 现取不到就回缺省。
   */
  model?: string | (() => Promise<string | undefined>)
  timeoutMs?: number
  maxTokens?: number
}

/** 模型名解析:静态串照用;函数现取,取不到/取失败回缺省(不问模型那一路不该因此抛)。 */
export async function resolveProgressModelName(
  source: ProgressModel['model'],
  fallback: string,
): Promise<string> {
  if (source === undefined) return fallback
  if (typeof source === 'string') return source
  try { return (await source()) ?? fallback }
  catch { return fallback }
}

/**
 * 判进度用哪个模型:**V4 Flash、关掉「先想一遍」**(中转的标准名,`dshModelSettings.RELAY_STANDARD_MODELS`)。
 *
 * 真看板副本上都试过(2026-09-25):
 * - `deepseek-chat`:中转把这个老名字转给了 Flash(回包里写的是 deepseek-flash)、不想,判得可以;但记账按「认不出的名字一律按 Pro 价」记 ——
 *   花 Pro 的钱、拿 Flash 的判断;
 * - `deepseek-v4-pro` / `deepseek-v4-flash` 不带参数:默认先想一遍,两千个 token 全花在「想」上、正文一个字没回(finish_reason length),
 *   全批退回规则;
 * - `deepseek-v4-flash` + `thinking: { type: 'disabled' }`(askModel 里带着):几秒回、按 Flash 价记,一轮十几张卡约三分钱。
 *   它会犯的错(把设计稿当进展、摘录抄标题行、JSON 漏括号)由这边的核对兜住
 *  (逐字核摘录、摘录要说到这件事、说的是别的卡就不算、坏了的那一件单独退回规则)。
 */
export const PROGRESS_MODEL = 'deepseek-v4-flash'
export const PROGRESS_MAX_TOKENS = 2000
/** 一批最多几张卡(提示词别太长,一批失败只丢这几张)。 */
export const PROGRESS_BATCH = 5

interface ModelReply { json?: unknown, usage?: Record<string, unknown>, error?: string }

async function askModel(model: ProgressModel, prompt: { system: string, user: string }): Promise<ModelReply> {
  let endpoint: { ready: boolean, baseUrl: string, key?: string }
  try { endpoint = await model.endpoint() }
  catch (error) { return { error: `模型服务查不到(${error instanceof Error ? error.message : String(error)})` } }
  if (!endpoint.ready) return { error: '模型服务还没接上' }
  const fetchImpl = model.fetchImpl ?? fetch
  const name = await resolveProgressModelName(model.model, PROGRESS_MODEL)
  const call = async (strict: boolean): Promise<{ status: number, body?: Record<string, unknown>, error?: string }> => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), model.timeoutMs ?? 60_000)
    ;(timer as { unref?: () => void }).unref?.()
    try {
      const response = await fetchImpl(`${endpoint.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(endpoint.key === undefined ? {} : { authorization: `Bearer ${endpoint.key}` }) },
        body: JSON.stringify({
          model: name,
          messages: [{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }],
          temperature: 0,
          max_tokens: model.maxTokens ?? PROGRESS_MAX_TOKENS,
          // V4 那几档默认先「想」一遍:想的字也算输出、也占 max_tokens,两千个全花在想上、正文一个字不回(真看板副本上撞到过)。
          // 判进度要的是照证据填表,不要想;中转照转这一格(2026-09-25 实测:关掉后 reasoning 0、正文照回)。
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
  const usage = isRecord(reply.body.usage) ? reply.body.usage : undefined
  const choices = reply.body.choices as { message?: { content?: unknown } }[] | undefined
  const content = choices?.[0]?.message?.content
  if (typeof content !== 'string' || content.trim() === '') return { error: '模型没回内容', ...(usage === undefined ? {} : { usage }) }
  const text = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
  let json: unknown
  try { json = JSON.parse(text) }
  catch {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    try { json = start >= 0 && end > start ? JSON.parse(text.slice(start, end + 1)) : undefined }
    catch { json = undefined }
    // 整份解析不了:一件一件捞,坏的那一件丢掉(它退回规则),好的照用。
    if (json === undefined) json = salvageJudgeItems(text)
  }
  if (json === undefined) return { error: '模型回的不是 JSON', ...(usage === undefined ? {} : { usage }) }
  return { json, ...(usage === undefined ? {} : { usage }) }
}

// ———————————————————————————— 服务 ————————————————————————————

/** 卡 M 的外层提问(可选)。形状照 `QuestionBroker.ask` 抄,不 import 它的文件。 */
export interface OuterQuestionPort {
  /** `at`:这一问第一次问他是什么时候(只有重启后挂回来的那几问传它,卡 U8)。 */
  ask: (req: { sessionId: string, questions: readonly unknown[], signal?: AbortSignal, at?: string }) => {
    id: string
    answer: Promise<{ kind: 'answer', answers: readonly { id: string, selected: readonly string[], custom?: string }[] } | { kind: 'cancelled' }>
  }
}

export type SessionAccess = 'allowed' | 'ask' | 'denied'

/** 「看各家的对话」那一问里的两个选项(原样的 label 交回来,按它认)。 */
export const ACCESS_ALLOW = '可以,以后都这样看'
export const ACCESS_DENY = '不行'

/**
 * 「看各家的对话」那一问(2026-09-25 卡 N;维护者:「从常规用户的第一次使用角度」)。引导里没问到的(老用户、跳过了)第一次要读时问一次。
 * **走外层提问(卡 M 的 QuestionBroker),不走审批**:审批那一行的键是「允许这一次」,而这一问答了是**以后都算**(记进授权表)——
 * 键上写「这一次」、实际一直有效,是在骗他。提问能摆两个说清后果的选项。
 * 为什么要看、看了他得到什么、不同意会怎样都说到;不说「会话」「授权表」「证据」这些词;发给模型的事照实说。
 */
export const ACCESS_QUESTION = {
  id: 'access',
  header: '看各家的对话',
  question: '看板上每件事做到哪了,我想照你在 Codex、Claude 里跟这件事有关的对话来写 —— 这样不用你一件件告诉我。可以吗?',
  detail: '只看跟看板上这几件事有关的对话的最后几句,不改、不存原话;判断的时候会把相关的几句发给 AI 看一眼。',
  options: [
    { label: ACCESS_ALLOW, description: '以后看板上的「现在到哪」照对话写' },
    { label: ACCESS_DENY, description: '只看项目文件夹和看板,看不出来的再问你' },
  ],
} as const

export interface ProgressServiceDeps {
  file: string
  now: () => Date
  tasks: {
    list: () => Promise<TasksState>
    create: (input: { title: string, desc?: string, status?: TaskStatus, projectId?: string, moduleId?: string, assignee?: TaskAssignee, origin?: 'evidence', source?: { kind: 'manual', ref?: string } }) => Promise<{ ok: boolean, id?: string, reason?: string }>
    move: (id: string, status: TaskStatus) => Promise<{ ok: boolean, reason?: string }>
  }
  /** 他确认过的项目(项目区里的,带目录)。 */
  projects: () => Promise<readonly ProjectRef[]>
  sources: SourceDeps
  codexHome?: string
  claudeHome?: string
  /** 授权表 `read_session_content`。缺席 = 不读会话正文(只看仓库与看板)。 */
  sessionAccess?: () => Promise<SessionAccess>
  /** 「要问」时他在外层那一问({@link ACCESS_QUESTION},走 `questions`)里答了 → 记进授权表。 */
  setSessionAccess?: (allowed: boolean) => Promise<void>
  /** 问模型(与事务官同一套模型服务)。缺席 = 只用规则。 */
  model?: ProgressModel
  /** 「每件事上限」(元)。缺省 0.5。 */
  budgetCny?: () => Promise<number>
  /** 卡 M 的外层提问(「要你说一句」)。缺席 = 只在卡上 / 早报里写,卡上的输入框答。 */
  questions?: OuterQuestionPort
  /** 证据里冒出来的下一步要不要真建卡(缺省建;测试 / 预览时可关)。 */
  createProposals?: boolean
  onChanged?: () => void
}

export interface EvaluateInput {
  trigger: ProgressTrigger
  /** 只核这几张;缺席 = 看板上该核的全部。 */
  taskIds?: readonly string[]
  /** 证据没变也重判(他当场问的时候)。 */
  force?: boolean
}

export interface EvaluateResult {
  cards: number
  spend_cny: number
  by: 'model' | 'rules'
  note?: string
  /** 这一轮每张卡的结论。 */
  results: { task_id: string, title: string, progress: TaskProgressView }[]
  /** 这一轮建的「证据里冒出来的下一步」。 */
  proposed: { task_id: string, title: string, from_task: string, quote: string, source: string }[]
}

export interface AskResult {
  ok: boolean
  /** 念给他听 / 摆在对话里的那一句。 */
  line: string
  results: EvaluateResult['results']
}

export interface ProgressService {
  load: () => Promise<void>
  /**
   * 起服务时把重启前挂着的那几问原样挂回外层(2026-09-26,卡 U8)。**不问模型、不采证据**,
   * 只读自己那本账(progress.json 的 `asks`)与看板一眼。跑一次就够,叫第二次是空操作。
   */
  resume: () => Promise<void>
  evaluate: (input: EvaluateInput) => Promise<EvaluateResult>
  ask: (query: string) => Promise<AskResult>
  said: (taskId: string, text: string) => Promise<{ ok: boolean, note: string, progress?: TaskProgressView }>
  cardViews: () => ReadonlyMap<string, TaskProgressView>
  runState: () => ProgressRunStateView
  /** 早报之前:跑一轮,回要念的那几行(只念变了的)。 */
  beforeMorning: () => Promise<{ lines: string[], note?: string }>
}

/** 办完之后还核几天(办完的卡证据里常冒出「还差 X」—— 参赛网页那张就是)。 */
export const DONE_LOOKBACK_MS = 3 * 86_400_000
/** 一轮最多核几张。 */
export const MAX_CARDS_PER_RUN = 16
/** 看板一轮看多远的证据;单张卡当场问看得更远。 */
export const BOARD_WINDOW_MS = 72 * 3_600_000
export const CARD_WINDOW_MS = 7 * 86_400_000
/** 证据没变时,模型那一句沿用多久。 */
export const REUSE_MS = 24 * 3_600_000
/** 同一时刻最多挂几问「要你说一句」。 */
export const MAX_OPEN_QUESTIONS = 2

const STATUS_ORDER: Readonly<Record<TaskStatus, number>> = { doing: 0, confirm: 1, blocked: 2, todo: 3, backlog: 4, done: 5, canceled: 6 }

/** 看板上该核哪几张:事项(有负责人 / 他交代的)、引导排的;在办的与这三天办完的;不核通话纪要、测试留下的、选题。 */
export function cardsToCheck(tasks: readonly TaskView[], now: Date): TaskView[] {
  const nowMs = now.getTime()
  return tasks
    .filter((task) => {
      if (task.kind === 'topic' || task.origin === 'call' || isTestItem(task)) return false
      // 证据里冒出来、还等他点头的那几张:它们本身就是这一轮的结论,不再核一遍。
      if (task.origin === 'evidence' && task.status === 'backlog') return false
      if (!isTrackedItem(task) && task.origin !== 'onboarding') return false
      if (task.status === 'canceled') return false
      if (task.status === 'done') {
        const doneAt = Date.parse(task.done_at ?? task.updated_at)
        return Number.isFinite(doneAt) && nowMs - doneAt <= DONE_LOOKBACK_MS
      }
      return true
    })
    .sort((a, b) => {
      const pa = a.priority === 'high' ? 0 : a.priority === 'low' ? 2 : 1
      const pb = b.priority === 'high' ? 0 : b.priority === 'low' ? 2 : 1
      if (pa !== pb) return pa - pb
      if (STATUS_ORDER[a.status] !== STATUS_ORDER[b.status]) return STATUS_ORDER[a.status] - STATUS_ORDER[b.status]
      return b.updated_at.localeCompare(a.updated_at)
    })
    .slice(0, MAX_CARDS_PER_RUN)
}

/** 卡 → 拿去核的样子(项目 / 冲刺 / 模块叫什么,挂着哪几条会话,交代里点名的会话)。 */
export function evalCardOf(task: TaskView, board: Pick<TasksState, 'sprints' | 'modules'>, projects: readonly ProjectRef[]): EvalCard {
  const module = board.modules.find((one: BoardModule) => one.id === task.module_id)
  const sprint = module === undefined ? undefined : board.sprints.find((one: SprintView) => one.id === module.sprint_id)
  const project = projects.find(one => one.id === task.project_id)
  const context = [project?.name, project?.id, sprint?.name, module?.name].filter((one): one is string => one !== undefined && one !== '')
  const sessionIds = [...(task.links ?? []).map(link => link.session_id), ...(task.conversation === undefined ? [] : [task.conversation.session_id])]
  return {
    id: task.id,
    title: task.title,
    ...(task.desc === undefined ? {} : { desc: task.desc }),
    status: task.status,
    ...(task.assignee === undefined ? {} : { assignee: task.assignee }),
    ...(task.assignee_note === undefined ? {} : { assignee_note: task.assignee_note }),
    ...(task.due === undefined ? {} : { due: task.due }),
    ...(task.project_id === undefined ? {} : { project_id: task.project_id }),
    context,
    sessionIds,
    namedSessions: namedSessionsIn([task.desc, task.client_dispatch?.text]),
    updated_at: task.updated_at,
    ...(task.done_at === undefined ? {} : { done_at: task.done_at }),
  }
}

/**
 * 这几天的总账(给模型判「新的说法推翻了旧的」):这一批卡所在项目的最新三版发版记录、最新四份交接 / 验收、最近八条提交。
 * 一批一份,每条已截短;不看项目的卡(没挂项目)用全部项目的。
 */
export function recentOf(evidence: readonly EvidenceItem[], cards: readonly EvalCard[]): EvidenceItem[] {
  const projects = new Set(cards.map(card => card.project_id).filter((id): id is string => id !== undefined))
  const mine = evidence.filter(ev => projects.size === 0 || ev.project === undefined || projects.has(ev.project))
  const newest = (kind: EvidenceItem['kind'], n: number, extra?: (ev: EvidenceItem) => boolean): EvidenceItem[] => mine
    .filter(ev => ev.kind === kind && (extra?.(ev) ?? true))
    .sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''))
    .slice(0, n)
  const shortened = (ev: EvidenceItem): EvidenceItem => ({ ...ev, text: clip(ev.text, ev.kind === 'release' ? 200 : 120) })
  // 发版记录:昨天到今天发的每一版都进总账(「昨晚到今早」的真实进展大多写在这里;一晚上能发十几版)。
  const releases = mine.filter(ev => ev.kind === 'release').sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''))
  const lastDay = releases[0]?.at
  const floor = lastDay === undefined ? '' : isoDayBefore(lastDay)
  const recentReleases = releases.filter(ev => (ev.at ?? '') >= floor).slice(0, LEDGER_RELEASES)
  return [
    ...(recentReleases.length >= 3 ? recentReleases : releases.slice(0, 3)),
    // 交接与验收记录同提交一样,只看主线上的(别的卡的分支上的交接是那边在做的活,不是「现在是什么样」——
    // 09-25 晚几张卡同时在跑,六个位子全被分支交接占了,模型把它们「还没并进正式版」的标签套到了别的卡上);一条都没有就全看。
    ...(mine.some(ev => ev.kind === 'handoff' && (ev.doc === 'handoff' || ev.doc === 'acceptance') && ev.unmerged !== true)
      ? newest('handoff', 6, ev => (ev.doc === 'handoff' || ev.doc === 'acceptance') && ev.unmerged !== true)
      : newest('handoff', 6, ev => ev.doc === 'handoff' || ev.doc === 'acceptance')),
    // 提交只看主线上的(别的分支上还没合进来的不算「现在是什么样」);一条都没认出主线就全看。
    ...(mine.some(ev => ev.kind === 'commit' && ev.main === true) ? newest('commit', 8, ev => ev.main === true) : newest('commit', 8)),
  ].map(shortened)
}

function fingerprint(card: EvalCard, candidates: readonly Candidate[]): string {
  const hash = createHash('sha1')
  hash.update(JSON.stringify([card.title, card.status, card.desc ?? '', card.assignee ?? '']))
  for (const one of candidates) hash.update(`\n${one.ev.id}\n${one.ev.at ?? ''}\n${one.ev.text}`)
  return hash.digest('hex').slice(0, 16)
}

/** 总账里最多摆几版发版记录(昨天到今天的)。 */
export const LEDGER_RELEASES = 16

/** 「2026-09-25」→「2026-09-24」(发版记录的日子只到天)。 */
function isoDayBefore(day: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(day)
  if (match === null) return day
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) - 86_400_000)
  return date.toISOString().slice(0, 10)
}

/** 问「XX 到哪了」时去掉的那几个字。 */
const QUESTION_WORDS = /到哪了|到哪儿了|到哪|做到哪|进度|进展|怎么样了?|现在|目前|那件|那张|那个|这件|这个|呢|吗|了|啊|呀|[?\uFF1F。,\uFF0C!\uFF01\s]/g

/** 他那句话说的是哪几张卡(标题与他的话互相覆盖得够多)。 */
export function matchCards(query: string, tasks: readonly TaskView[], contextOf: (task: TaskView) => readonly string[]): TaskView[] {
  const said = normalizeText(query).replace(QUESTION_WORDS, '')
  if ([...said].length < 2) return []
  const scored = tasks
    .filter(task => task.status !== 'canceled' && task.origin !== 'call' && !isTestItem(task) && task.kind !== 'topic')
    .map((task) => {
      const titleInQuery = coverage(cardSubject(task.title, contextOf(task)), said)
      const queryInTitle = coverage(cardSubject(said, []), normalizeText(task.title))
      return { task, score: Math.max(titleInQuery, queryInTitle) }
    })
    .filter(one => one.score >= 0.5)
    .sort((a, b) => b.score - a.score || STATUS_ORDER[a.task.status] - STATUS_ORDER[b.task.status])
  if (scored.length === 0) return []
  const best = (scored[0] as { score: number }).score
  return scored.filter(one => one.score >= best - 0.15).slice(0, 3).map(one => one.task)
}

/** 「不做了」「做完了」这两句会动卡(他说的);别的只记下来。 */
function saidMove(text: string): TaskStatus | undefined {
  if (/不做了|不做|算了|取消|不要了/.test(text)) return 'canceled'
  if (/做完了|做完|完成了|搞定了|已经好了|弄好了/.test(text)) return 'done'
  return undefined
}

export function createProgressService(deps: ProgressServiceDeps): ProgressService {
  let data: ProgressFile = emptyProgressFile()
  let loaded = false
  let running = 0
  let chain: Promise<unknown> = Promise.resolve()
  const cache: SessionCache = new Map()
  /** (卡, 证据) 打分缓存(8791 第四轮):指纹没变的对不再重调 scoreEvidence。 */
  const scoreCache = createScoreCache()
  const openQuestions = new Map<string, AbortController>()
  let accessAsked = false
  /** 起服务时那一趟「把重启前挂着的几问挂回来」跑过没有(卡 U8;只跑一次)。 */
  let resumed = false
  /** 最近一轮读到的授权与上限(runState 要同步给出,而这两样是异步读的)。 */
  let lastAccess: SessionAccess | undefined
  let lastBudget = 0.5

  async function load(): Promise<void> {
    try { data = parseProgressFile(JSON.parse(await readFile(deps.file, 'utf8'))) }
    catch { data = emptyProgressFile() }
    loaded = true
  }

  async function save(): Promise<void> {
    await mkdir(dirname(deps.file), { recursive: true })
    const tmp = `${deps.file}.${randomUUID()}.tmp`
    await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
    await rename(tmp, deps.file)
  }

  function today(): string {
    const at = deps.now()
    return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`
  }

  function todaySpend(): number {
    return data.day?.date === today() ? data.day.spend_cny : 0
  }

  function addSpend(cny: number): void {
    const date = today()
    data.day = { date, spend_cny: (data.day?.date === date ? data.day.spend_cny : 0) + cny }
  }

  async function access(): Promise<SessionAccess> {
    if (deps.sessionAccess === undefined) return 'denied'
    try { return await deps.sessionAccess() }
    catch { return 'denied' }
  }

  /**
   * 「要问」:在外层问他一次({@link ACCESS_QUESTION};这个进程里只问一次)。他点了哪个就记进授权表,允许了再核一轮。
   * 他没点选项、自己写了一句:不猜,这个进程里不再问(下次起服务再问);那一问被撤了(没答成)下一轮再挂。
   */
  function maybeAskAccess(at?: string): void {
    if (accessAsked || deps.questions === undefined) return
    accessAsked = true
    let asked: ReturnType<OuterQuestionPort['ask']>
    try { asked = deps.questions.ask({ sessionId: 'progress:access', questions: [ACCESS_QUESTION], ...(at === undefined ? {} : { at }) }) }
    catch { accessAsked = false; return }
    // 挂上了就记在账上(重启后照它挂回,卡 U8)。
    noteAsk(ACCESS_ASK_KEY, ACCESS_QUESTION.question, at)
    void asked.answer.then(async (outcome) => {
      forgetAsk(ACCESS_ASK_KEY)
      if (outcome.kind !== 'answer') { accessAsked = false; return }
      const picked = outcome.answers.find(one => one.id === ACCESS_QUESTION.id)?.selected ?? []
      const allowed = picked.includes(ACCESS_ALLOW) ? true : picked.includes(ACCESS_DENY) ? false : undefined
      if (allowed === undefined) return
      await deps.setSessionAccess?.(allowed)
      if (allowed) await evaluate({ trigger: 'manual', force: true })
    }).catch(() => { accessAsked = false })
  }

  /**
   * 挂出去的那一问记在账上 / 从账上划掉(2026-09-26,卡 U8;账在 progress.json 的 `asks` 里)。
   *
   * 落盘是**排在后面自己去写的**:这两处都在「挂一问」「他答了」的路上,不该为了写一个文件
   * 让他多等;写不成也只是这一问下次重启后挂不回来,不影响此刻(同 approval-grants 的写法)。
   */
  function noteAsk(key: string, question: string, at?: string): void {
    const record = { question, at: at ?? deps.now().toISOString() }
    if (data.asks[key]?.question === record.question && data.asks[key]?.at === record.at) return
    data.asks[key] = record
    void save().catch(() => {})
  }

  function forgetAsk(key: string): void {
    if (data.asks[key] === undefined) return
    delete data.asks[key]
    void save().catch(() => {})
  }

  async function collect(cards: readonly TaskView[], board: TasksState, projects: readonly ProjectRef[], windowMs: number, sessions: boolean): Promise<EvidenceItem[]> {
    const now = deps.now()
    const since = new Date(now.getTime() - windowMs)
    const wanted = new Set(cards.map(card => card.project_id).filter((id): id is string => id !== undefined))
    // 没挂项目的卡:按他确认过的全部项目找(他交代的一句话常常没归项目)。
    const scoped = wanted.size === 0 || cards.some(card => card.project_id === undefined) ? projects : projects.filter(one => wanted.has(one.id))
    const out: EvidenceItem[] = []
    for (const project of scoped) {
      try { out.push(...await repoEvidence(project, since, now, deps.sources)) }
      catch { /* 一个仓库读不了不连累别的 */ }
    }
    out.push(...boardEvidence(board.tasks))
    out.push(...saidEvidence(data.said))
    if (sessions) {
      const liveIds = board.tasks.filter(task => task.status !== 'canceled' && !isTestItem(task)).map(task => task.id)
      /**
       * 这一轮碰到的会话文件(2026-10-19):两家扫完收一次缓存 —— 碰到的一条不丢,别的按最老进表的先丢。
       * 缓存从前只进不出,它按路径存整条会话的回合文字,进程跑几天就是这几天扫过的每一条会话。
       */
      const touched = new Set<string>()
      if (deps.codexHome !== undefined) {
        try { out.push(...await codexEvidence({ codexHome: deps.codexHome, projects, since, now, taskIds: liveIds, deps: deps.sources, cache, touched })) }
        catch { /* Codex 读不了不连累别的 */ }
      }
      if (deps.claudeHome !== undefined) {
        try { out.push(...await claudeEvidence({ claudeHome: deps.claudeHome, projects, since, deps: deps.sources, cache, touched })) }
        catch { /* 同上 */ }
      }
      pruneSessionCache(cache, touched)
    }
    return out
  }

  async function run(input: EvaluateInput): Promise<EvaluateResult> {
    if (!loaded) await load()
    const now = deps.now()
    const checkedAt = now.toISOString()
    const board = await deps.tasks.list()
    const projects = await deps.projects()
    const picked = input.taskIds === undefined
      ? cardsToCheck(board.tasks, now)
      : board.tasks.filter(task => input.taskIds?.includes(task.id) === true)
    if (picked.length === 0) return { cards: 0, spend_cny: 0, by: 'rules', results: [], proposed: [] }

    const sessionAccess = await access()
    lastAccess = sessionAccess
    if (sessionAccess === 'ask') maybeAskAccess()
    const windowMs = input.taskIds === undefined ? BOARD_WINDOW_MS : CARD_WINDOW_MS
    const evidence = await collect(picked, board, projects, windowMs, sessionAccess === 'allowed')
    const cards = picked.map(task => evalCardOf(task, board, projects))
    const candidates = pickCandidates(cards, evidence, { scoreCache })
    // 看板上别的还开着的卡(认「模型写的其实是另一张卡的事」用);这一轮核的那几张已经在 cards 里。
    const coreIds = new Set(cards.map(card => card.id))
    const boardCards = [...cards, ...board.tasks
      .filter(task => !coreIds.has(task.id) && task.status !== 'canceled' && task.kind !== 'topic' && !isTestItem(task))
      .map(task => evalCardOf(task, board, projects))]
    // 总账每一批都一样(模型那头的前缀缓存吃得到):按这一轮全部的卡取一次。
    const ledger = recentOf(evidence, cards)

    const judgements = new Map<string, Judgement>()
    const keys = new Map<string, string>()
    const needModel: EvalCard[] = []
    for (const card of cards) {
      const list = candidates.get(card.id) ?? []
      const key = fingerprint(card, list)
      keys.set(card.id, key)
      if (list.length === 0) {
        judgements.set(card.id, { taskId: card.id, state: 'none', line: PROGRESS_NONE_LINE, basis: [], next: [], by: 'rules' })
        continue
      }
      const stored = data.cards[card.id]
      const fresh = stored !== undefined && stored.key === key && stored.by === 'model' && now.getTime() - Date.parse(stored.checked_at) < REUSE_MS
      if (fresh && input.force !== true) continue
      needModel.push(card)
    }

    let spend = 0
    let by: 'model' | 'rules' = needModel.length === 0 ? 'model' : 'rules'
    const notes: string[] = []
    // 这几句会进回执与早报:说人话(不说「仓库」「按规则」「模型这一批」)。
    if (sessionAccess === 'ask') notes.push('你还没点头让我看各家的对话,这次只看了项目文件夹和看板')
    if (needModel.length > 0) {
      const budget = await (deps.budgetCny?.() ?? Promise.resolve(0.5)).catch(() => 0.5)
      lastBudget = budget
      const dailyCap = budget * 2
      const modelName = await resolveProgressModelName(deps.model?.model, PROGRESS_MODEL)
      const maxTokens = deps.model?.maxTokens ?? PROGRESS_MAX_TOKENS
      let modelUsed = false
      for (let i = 0; i < needModel.length; i += PROGRESS_BATCH) {
        const batch = needModel.slice(i, i + PROGRESS_BATCH)
        let answered: Map<string, Judgement> | undefined
        if (deps.model === undefined) {
          if (notes.every(one => !one.includes('模型服务'))) notes.push('模型服务没接上,这次只摘了原话,没细判')
        }
        else {
          const prompt = buildJudgePrompt({ now, cards: batch, candidates, recent: ledger })
          const estimate = estimateCny(modelName, prompt.system.length + prompt.user.length, maxTokens)
          if (spend + estimate > budget || todaySpend() + estimate > dailyCap) {
            if (notes.every(one => !one.includes('上限'))) notes.push(`核进度的花费到了上限(一次 ${budget} 元、一天 ${dailyCap} 元),剩下的这次只摘了原话`)
          }
          else {
            const reply = await askModel(deps.model, prompt)
            const cost = usageCny(modelName, reply.usage, reply.json === undefined && reply.usage === undefined ? 0 : estimate)
            spend += cost
            addSpend(cost)
            if (reply.json !== undefined) answered = judgementsFromModel(reply.json, batch, prompt.keys, candidates, boardCards)
            if (answered === undefined && notes.every(one => !one.includes('没答上来'))) notes.push(`有几件模型没答上来(${reply.error ?? '回的不像样'}),这次只摘了原话`)
            if (answered !== undefined) modelUsed = true
          }
        }
        for (const card of batch) {
          const judged = answered?.get(card.id)
          judgements.set(card.id, judged ?? rulesJudge(card, candidates.get(card.id) ?? []))
        }
      }
      by = modelUsed ? 'model' : 'rules'
    }

    // 落到卡上:没重判的沿用上一次(只把「看的时刻」挪到这一轮)。
    const results: EvaluateResult['results'] = []
    const steps: ProposedStep[] = []
    for (const card of cards) {
      const stored = data.cards[card.id]
      const judged = judgements.get(card.id)
      let view: StoredProgress
      if (judged === undefined && stored !== undefined) {
        view = { ...stored, checked_at: checkedAt, changed: false }
      }
      else {
        const judgement = judged ?? { taskId: card.id, state: 'none' as const, line: PROGRESS_NONE_LINE, basis: [], next: [], by: 'rules' as const }
        view = { ...progressView(judgement, checkedAt, stored), key: keys.get(card.id) as string }
        steps.push(...judgement.next)
      }
      // 这一轮看没看各家的对话(没看到进展时「我在哪儿找过」照它说,不说没看的地方)。
      view = { ...view, read_sessions: sessionAccess === 'allowed' }
      data.cards[card.id] = view
      const { key: _key, ...shown } = view
      results.push({ task_id: card.id, title: card.title, progress: shown })
    }

    // 证据里冒出来的下一步 → 「待排」卡,「等你确认」里问他要不要加。
    const proposed: EvaluateResult['proposed'] = []
    // 只从「活的」证据里提下一步(会话里说的、派出去的活交回来的话、他说的):交接、决策记录、发版记录里的「还差」
    // 写下来那一刻就开始过时,拿它们建卡会建出早就做完的事(验收时撞见的:「统筹装一次插件 + 壳」「把八步接进 index.ts」)。
    const live = steps.filter(step => step.ev.kind === 'session' || step.ev.kind === 'dispatch' || step.ev.kind === 'item' || step.ev.kind === 'said')
    if (deps.createProposals !== false && live.length > 0) {
      const contextOf = (taskId: string): readonly string[] => cards.find(one => one.id === taskId)?.context ?? []
      const fresh = proposalsFrom(live, board.tasks, data.proposed.map(one => one.title), 3, [...new Set(live.flatMap(step => contextOf(step.fromTask)))])
      for (const step of fresh) {
        const from = board.tasks.find(task => task.id === step.fromTask)
        const when = shortAt(step.ev.at)
        const title = peopleText(step.title) || step.title
        const quote = shownQuote(step.quote)
        const made = await deps.tasks.create({
          title,
          // 给人看的一句:哪段对话里提到的、原话是什么(不带文件名、路径)。
          desc: `${step.ev.kind === 'said' ? '你说过' : `${peopleText(step.ev.source) || step.ev.source}里提到`}还要做这件${when === '' ? '' : `(${when})`}${quote === '' ? '' : `:「${quote}」`}\n要加上就点「加上」,不要就点「不要」。`,
          status: 'backlog',
          ...(from?.project_id === undefined ? {} : { projectId: from.project_id }),
          ...(from?.module_id === undefined ? {} : { moduleId: from.module_id }),
          ...(step.owner === undefined ? {} : { assignee: step.owner }),
          origin: 'evidence',
          source: { kind: 'manual', ref: '进度核对' },
        }).catch(() => ({ ok: false as const }))
        data.proposed.push({ title: step.title, ...(made.ok && made.id !== undefined ? { task_id: made.id } : {}), from_task: step.fromTask, at: checkedAt })
        if (made.ok && made.id !== undefined) proposed.push({ task_id: made.id, title, from_task: step.fromTask, quote, source: peopleText(step.ev.source) || step.ev.source })
      }
    }

    /*
     * 证据摆在那儿就**自己把状态推过去、留依据**,不来问他(2026-09-27,卡 WY;设计第五节 B)。
     *
     * 09-26 那 9 条「等你」里有两条是「『X』问你:进度要你说一句」—— 进度核对**已经拿到证据**看到它在动,
     * 卡上却还是「待办」,于是回过头来问他。维护者 09-27:「等你」只放他不点头就卡住的事;这一件不是。
     * 依据不另存:这一轮算出来的 `progress`(「现在到哪 + 出处 + 时刻」)就落在卡上,他要撤自己拖回去。
     * 只推**待排 / 待办 → 在办**这一步:往后的几格(办完、等我确认)得有人验收,代码不替他判。
     */
    for (const result of results) {
      if (result.progress.state !== 'found') continue
      const task = board.tasks.find(one => one.id === result.task_id)
      if (task === undefined || (task.status !== 'backlog' && task.status !== 'todo')) continue
      if (task.origin === 'evidence') continue
      const moved = await deps.tasks.move(task.id, 'doing').catch(() => ({ ok: false }))
      if (moved.ok !== true) continue
      /*
       * 自己改了状态就**把指纹一起改过去**:指纹里有卡的状态(见 {@link fingerprint}),
       * 不改的话下一轮会觉得「这张卡变了」再问一次模型 —— 我们自己动的一下不该让他花这笔钱。
       */
      const card = cards.find(one => one.id === task.id)
      const stored = data.cards[task.id]
      if (card === undefined || stored === undefined) continue
      data.cards[task.id] = { ...stored, key: fingerprint({ ...card, status: 'doing' }, candidates.get(card.id) ?? []) }
    }

    // 「要你说一句」:外层问(卡 M 那一套),同一时刻最多两问;找到证据的那几张把问撤掉。
    if (deps.questions !== undefined) {
      for (const result of results) {
        const open = openQuestions.get(result.task_id)
        if (result.progress.state === 'found') { open?.abort(); continue }
        if (open !== undefined || openQuestions.size >= MAX_OPEN_QUESTIONS) continue
        const task = board.tasks.find(one => one.id === result.task_id)
        if (task === undefined || task.status === 'done') continue
        askWord(task, result.progress)
      }
    }

    const note = notes.length === 0 ? undefined : notes.join(';')
    data.runs.push({ at: checkedAt, trigger: input.trigger, cards: cards.length, spend_cny: Math.round(spend * 10_000) / 10_000, by, ...(note === undefined ? {} : { note }) })
    data.runs = data.runs.slice(-30)
    await save()
    deps.onChanged?.()
    return { cards: cards.length, spend_cny: spend, by, ...(note === undefined ? {} : { note }), results, proposed }
  }

  function askWord(task: TaskView, progress: TaskProgressView): void {
    // 说人话(不说「仓库」「会话」「证据」);我在哪儿找过照实说。
    const question = progress.state === 'mismatch'
      ? `「${clip(task.title, 20)}」卡上写的和我看到的对不上:${progress.mismatch ?? ''}。现在到底到哪了?`
      : `「${clip(task.title, 20)}」现在到哪了?${progressNoneHint(progress).replace(/。$/, '')},你说一句我记下来。`
    putWord(task.id, question)
  }

  /**
   * 「进度要你说一句」真挂到外层去(卡 M 那一套),并记在账上。
   *
   * 两处叫它:这一轮核出来没看到进展({@link askWord}),和**起服务时照账挂回**({@link resume})。
   * 挂回来的那一问连原话带第一次问的时刻一起,所以他看到的与重启前是同一问,不是一条新的。
   */
  function putWord(taskId: string, question: string, at?: string): void {
    if (deps.questions === undefined) return
    const controller = new AbortController()
    openQuestions.set(taskId, controller)
    let asked: ReturnType<OuterQuestionPort['ask']>
    try {
      asked = deps.questions.ask({
        sessionId: `progress:${taskId}`,
        questions: [{ id: 'said', header: '进度要你说一句', question, options: [{ label: '还没开始' }, { label: '在做' }, { label: '做完了' }, { label: '不做了' }] }],
        signal: controller.signal,
        ...(at === undefined ? {} : { at }),
      })
    }
    catch { openQuestions.delete(taskId); return }
    noteAsk(taskId, question, at)
    void asked.answer.then(async (outcome) => {
      openQuestions.delete(taskId)
      // 答掉、撤掉(找到进展了、卡收了)都从账上划掉:重启后不该再问一遍他已经答过的。
      forgetAsk(taskId)
      if (outcome.kind !== 'answer') return
      const one = outcome.answers.find(item => item.id === 'said')
      const text = [...(one?.selected ?? []), one?.custom ?? ''].filter(Boolean).join(';')
      if (text !== '') await said(taskId, text)
    }).catch(() => { openQuestions.delete(taskId) })
  }

  /**
   * 起服务时把重启前挂着的那几问**原样挂回**(2026-09-26,卡 U8)。
   *
   * 0.4.1 → 0.4.2 热更新重启后「等你」从 6 变 4,少的就是这两问 —— 提问经纪人只在内存里,
   * 而这几问原来只在下一轮进度核对(早报前 / 他手动点 / 派活前)才会重新挂上。
   * 按「第一次用的人」看:重启不该让他之前看到的问题凭空消失。
   *
   * 这一趟**一个模型都不问、一条证据都不采**:只读自己那本账 + 看板一眼,所以起服务时白跑一趟也不花钱。
   * 顺手清账:卡办完 / 取消 / 不在看板上了、授权他已经定了 —— 那几问作废,账上也删掉。
   * 只跑一次(`resumed`);哪儿出了岔子都不拦起服务(最坏是这几问等下一轮核对时重新挂)。
   */
  async function resume(): Promise<void> {
    if (resumed) return
    resumed = true
    if (deps.questions === undefined) return
    if (!loaded) await load()
    const keys = Object.keys(data.asks)
    if (keys.length === 0) return
    let board: TasksState
    try { board = await deps.tasks.list() }
    catch { return }
    let dropped = false
    for (const key of keys) {
      const record = data.asks[key] as AskRecord
      if (key === ACCESS_ASK_KEY) {
        // 授权那一问:他已经定了「可以 / 不可以」就不再问(账上那一条作废)。
        if (await access() !== 'ask') { delete data.asks[key]; dropped = true; continue }
        maybeAskAccess(record.at)
        continue
      }
      const task = board.tasks.find(one => one.id === key)
      if (task === undefined || task.status === 'done' || task.status === 'canceled') { delete data.asks[key]; dropped = true; continue }
      // 同一时刻最多挂几问照旧(不一下子涌一屏);挂不上的留在账上,下一轮核对时再挂。
      if (openQuestions.size >= MAX_OPEN_QUESTIONS) continue
      putWord(key, record.question, record.at)
    }
    if (dropped) await save().catch(() => {})
  }

  function evaluate(input: EvaluateInput): Promise<EvaluateResult> {
    // 一次只跑一轮(读盘、问模型都排队):两轮同时写 progress.json 会丢一轮。
    const next = chain.then(async () => {
      running += 1
      try { return await run(input) }
      finally { running -= 1 }
    })
    chain = next.catch(() => undefined)
    return next
  }

  async function said(taskId: string, text: string): Promise<{ ok: boolean, note: string, progress?: TaskProgressView }> {
    const trimmed = text.replace(/\s+/g, ' ').trim()
    if (trimmed === '') return { ok: false, note: '要说一句到哪了' }
    const board = await deps.tasks.list()
    const task = board.tasks.find(one => one.id === taskId)
    if (task === undefined) return { ok: false, note: '没有这张卡' }
    if (!loaded) await load()
    const at = deps.now().toISOString()
    data.said[taskId] = [...(data.said[taskId] ?? []), { text: clip(trimmed, 300), at }].slice(-5)
    await save()
    let moved = ''
    const target = saidMove(trimmed)
    if (target !== undefined && task.status !== target && task.status !== 'done') {
      const route = statusPathTo(task.status, target)
      if (route !== undefined) {
        for (const step of route) {
          const result = await deps.tasks.move(taskId, step)
          if (!result.ok) break
        }
        moved = target === 'canceled' ? ',卡改成「取消」了(不删)' : ',卡挪到「完成」了'
      }
    }
    // 他那句话挂在这张卡上,当场核一次(证据里多了一条他说的)。
    const result = await evaluate({ trigger: 'ask', taskIds: [taskId], force: true })
    const progress = result.results[0]?.progress
    return { ok: true, note: `记下了${moved}。`, ...(progress === undefined ? {} : { progress }) }
  }

  async function ask(query: string): Promise<AskResult> {
    const board = await deps.tasks.list()
    const projects = await deps.projects()
    const contextOf = (task: TaskView): readonly string[] => evalCardOf(task, board, projects).context
    const matched = matchCards(query, board.tasks, contextOf)
    if (matched.length === 0) {
      return { ok: false, line: `看板上没认出你说的是哪一件 —— 换个说法,或者说卡上的名字。`, results: [] }
    }
    const result = await evaluate({ trigger: 'ask', taskIds: matched.map(task => task.id), force: true })
    const lines = result.results.map(({ title, progress }) => {
      const basis = progress.basis[0]
      const when = shortAt(basis?.at)
      return progress.state === 'none'
        ? `「${title}」:${PROGRESS_NONE_LINE}`
        : `「${title}」:${progress.line}${basis === undefined ? '' : `(依据:${basis.source}${when === '' ? '' : ` · ${when}`})`}${progress.mismatch === undefined ? '' : ` —— 和卡上写的对不上:${progress.mismatch}`}`
    })
    return { ok: true, line: lines.join('\n'), results: result.results }
  }

  async function beforeMorning(): Promise<{ lines: string[], note?: string }> {
    const result = await evaluate({ trigger: 'morning' })
    const lines: string[] = []
    const changed: string[] = []
    const none: string[] = []
    const mismatch: string[] = []
    for (const { task_id, title, progress } of result.results) {
      const before = data.morning[task_id]
      if (progress.state === 'none') { none.push(title); continue }
      if (progress.state === 'mismatch') mismatch.push(`「${clip(title, 16)}」${progress.mismatch ?? ''}`)
      if (before !== progress.line) {
        const basis = progress.basis[0]
        changed.push(`「${clip(title, 16)}」${progress.line}${basis === undefined ? '' : `(${basis.source})`}`)
      }
    }
    if (changed.length > 0) lines.push(`进度有变化的:${changed.slice(0, 4).join(';')}${changed.length > 4 ? `;另外 ${changed.length - 4} 件` : ''}`)
    if (mismatch.length > 0) lines.push(`和卡上写的对不上、要你看一眼:${mismatch.slice(0, 2).join(';')}`)
    if (result.proposed.length > 0) lines.push(`对话里提到还要做的,等你点头加不加:${result.proposed.map(one => one.title).join('、')}`)
    if (none.length > 0) lines.push(`还有 ${none.length} 件我没看到进展,要你说一句:${none.slice(0, 4).map(one => clip(one, 12)).join('、')}${none.length > 4 ? ' 等' : ''}`)
    for (const { task_id, progress } of result.results) data.morning[task_id] = progress.line
    await save()
    return { lines, ...(result.note === undefined ? {} : { note: `核进度:${result.note}` }) }
  }

  return {
    load,
    resume,
    evaluate,
    ask,
    said,
    cardViews: () => {
      const out = new Map<string, TaskProgressView>()
      for (const [id, stored] of Object.entries(data.cards)) {
        const { key: _key, ...view } = stored
        out.set(id, view)
      }
      return out
    },
    runState: () => {
      const last = data.runs[data.runs.length - 1]
      return {
        running: running > 0,
        ...(last === undefined ? {} : { last }),
        today_cny: Math.round(todaySpend() * 10_000) / 10_000,
        cap_cny: lastBudget,
        sessions: deps.sessionAccess === undefined ? 'denied' : (lastAccess ?? 'ask'),
      }
    },
    beforeMorning,
  }
}

