/**
 * 各家最近的对话,**从各家的会话记录文件读**(2026-10-01,手机读对话卡 A)。
 *
 * 原来手机「最近的对话」取的是会话表(这次开机以来钩子报过到的),关掉的会话一条都不列,每家往往只剩一条。
 * 这里换成看文件:Claude `~/.claude/projects/<目录>/<id>.jsonl`、Codex `~/.codex/sessions/<年>/<月>/<日>/rollout-*.jsonl`、
 * Kimi 桌面版(conversations.sqlite 里登记的 wire.jsonl)、以及各家接入登记过的文件(自动发现的那一家也在内)。
 * 窗口型那几家(豆包 / Manus / Muse…)没有记录文件,只列会话表里那一条,标 `window_only`。
 *
 * - 先只 `stat`(按修改时刻排、分页),只有落在这一页的才读头尾各一小段(标题、最后一句、是不是自检 / 子任务);
 * - 读出来的人话只在内存里按 (文件, 修改时刻, 大小) 记一份,不落盘;
 * - **不收路径**:`locate` 只认 id(不带斜杠、不带 `..`),按各家目录找文件。
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import {
  SESSION_HISTORY_DAYS,
  SESSION_HISTORY_LIMIT,
  isSelfcheckAsk,
  isSelfcheckCwd,
  type SessionActivity,
  type SessionHistoryItem,
  type SessionHistoryView,
  type SessionStatus,
} from '../protocol.ts'
import { selfcheckOfTail } from './claudeSessionRecover.ts'
import { codexActiveRollouts } from './codexThreadIndex.ts'
import { parseSessionIndex } from './codexThreads.ts'
import type { KimiConversation } from './kimiConversations.ts'
import { digestOf, humanizeText, readHeadTail, turnsOf, type DigestFormat } from './sessionDigest.ts'

/** 一条会话记录文件。 */
export interface SessionFileRef {
  agent: string
  session_id: string
  file: string
  format: DigestFormat
  /** 那家自己叫它什么(Claude 桌面 App 的会话名、Codex thread_name、Kimi 生成好的标题)。 */
  name?: string
}

/** 会话表里的一条(只用到这几格)。 */
export interface HistoryLiveSession {
  agent: string
  session_id: string
  status: SessionStatus
  title?: string
  project?: string
  updated_at: string
  activity?: SessionActivity
  selfcheck?: unknown
}

export interface SessionHistoryDeps {
  claudeHome?: string
  codexHome?: string
  /** Kimi 桌面版的会话(conversations.sqlite;kimiConversations.ts 的 lookup)。 */
  kimiConversations?: () => ReadonlyMap<string, KimiConversation> | undefined
  /** 各家接入登记过的文件(sessionDigestService.files())。 */
  registered?: () => readonly SessionFileRef[]
  /** 会话表(/state.sessions):带上状态、项目、标题。 */
  liveSessions?: () => readonly HistoryLiveSession[]
  /** 窗口型那几家此刻的会话(没有记录文件)。 */
  windowSessions?: () => readonly HistoryLiveSession[]
  /** Claude 桌面 App 的会话名(`~/.claude/sessions/*.json`,会话 id → 名字)。 */
  claudeNames?: () => Promise<ReadonlyMap<string, string> | undefined>
  resolveProject?: (cwd: string) => Promise<string | undefined>
  /** 不列的那几家(事务官自己)。默认 `dsh`。 */
  hidden?: readonly string[]
  now?: () => number
  days?: number
}

export interface SessionHistoryQuery {
  agent?: string | undefined
  before?: string | undefined
  limit?: number | undefined
  /**
   * **每家最多这么多条**(2026-10-03,卡「手机各家最近会话固定入口」)。给了它就是另一档:
   * 各家各取最近这么多条、一次全给(手机那个常驻入口要按家、按项目分组,拿不到整份没法分组),
   * 于是 `before` / `limit` 在这一档不起作用、`next` 缺席,回包里多一格 `per_family` 说清用上的是几。
   * 夹在 1…{@link PER_FAMILY_MAX} 之间。
   */
  per_family?: number | undefined
}

export interface SessionHistory {
  page: (query: SessionHistoryQuery) => Promise<SessionHistoryView>
  /** 按 id 找这条会话的记录文件(先认登记过的,再按各家目录找)。认不出 → undefined。 */
  locate: (agent: string, sessionId: string) => Promise<SessionFileRef | undefined>
}

/** 会话 id 只认这些字(没有斜杠、不以点开头):拿来拼路径也跑不出那家的目录。 */
export function safeSessionId(id: string): boolean {
  return /^[A-Za-z0-9_][A-Za-z0-9._:-]{0,199}$/.test(id) && !id.includes('..')
}

/** Codex 会话按开始那天落目录、之后一直往同一个文件里写:往回看这么多天的目录(与 codexSessionFeed 同数)。 */
const CODEX_DISCOVER_DAYS = 30
/** Codex 对话总表里回看多久内有动静的对话(同 codexSessionFeed)。 */
const CODEX_ACTIVE_LOOKBACK_MS = 2 * 86_400_000
// 取文件名里**第一个**会话号:新版 Codex 的文件名是 `rollout-<时刻>-<对话号>_<另一个号>.jsonl`,后面那个不是这条对话。
export const CODEX_ID_RE = /^rollout-[^/]*?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:_[^/]*)?\.jsonl$/i

/** 列表上一条要读的那一小段(标题在头上、最后一句在尾上)。 */
const LIST_HEAD_BYTES = 64 * 1024
const LIST_TAIL_BYTES = 64 * 1024
const LAST_LINE_MAX = 60

interface Candidate {
  ref?: SessionFileRef
  live?: HistoryLiveSession
  agent: string
  session_id: string
  ms: number
  size: number
}

interface Summary {
  keep: boolean
  title?: string
  cwd?: string
  last_line?: { who: 'you' | 'ai', text: string }
}

const keyOf = (agent: string, id: string): string => `${agent}\u0000${id}`

function encodeCursor(candidate: Candidate): string {
  return Buffer.from(JSON.stringify([candidate.ms, candidate.agent, candidate.session_id])).toString('base64url')
}

function decodeCursor(cursor: string | undefined): [number, string, string] | undefined {
  if (cursor === undefined || cursor === '') return undefined
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (Array.isArray(value) && typeof value[0] === 'number' && typeof value[1] === 'string' && typeof value[2] === 'string') return [value[0], value[1], value[2]]
  }
  catch { /* 坏游标当没带 */ }
  return undefined
}

/** 排序:新的在前;同一刻按家、id 排(游标靠它不重不漏)。 */
/** 窗口型那几家每家在列表里最多几条(只看一家时不限)。 */
export const WINDOW_ONLY_PER_AGENT = 3

/**
 * `per_family` 夹到这么大(2026-10-03)。一家几十条就要读几十个记录文件的头尾,
 * 常驻入口一分钟问一次 —— 上限摆在这儿,免得一次请求把这台 Mac 的磁盘吃满。
 */
export const PER_FAMILY_MAX = 50

function compare(a: { ms: number, agent: string, session_id: string }, b: { ms: number, agent: string, session_id: string }): number {
  if (a.ms !== b.ms) return b.ms - a.ms
  if (a.agent !== b.agent) return a.agent < b.agent ? -1 : 1
  return a.session_id < b.session_id ? -1 : a.session_id > b.session_id ? 1 : 0
}

async function statOf(file: string): Promise<{ ms: number, size: number } | undefined> {
  try {
    const info = await stat(file)
    return info.isFile() ? { ms: info.mtimeMs, size: info.size } : undefined
  }
  catch {
    return undefined
  }
}

async function listDir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir)
  }
  catch {
    return []
  }
}

export function createSessionHistory(deps: SessionHistoryDeps): SessionHistory {
  const now = deps.now ?? (() => Date.now())
  const days = deps.days ?? SESSION_HISTORY_DAYS
  const hidden = new Set(deps.hidden ?? ['dsh'])
  /** 读过的那一小段(只在内存):文件没动就不再读。 */
  const summaries = new Map<string, { stamp: string, summary: Summary }>()

  async function claudeRefs(): Promise<SessionFileRef[]> {
    if (deps.claudeHome === undefined) return []
    const root = join(deps.claudeHome, 'projects')
    const names = await deps.claudeNames?.().catch(() => undefined)
    const out: SessionFileRef[] = []
    for (const dir of await listDir(root)) {
      for (const name of await listDir(join(root, dir))) {
        if (!name.endsWith('.jsonl')) continue
        const id = name.slice(0, -'.jsonl'.length)
        if (!safeSessionId(id)) continue
        const label = names?.get(id)
        out.push({ agent: 'claude', session_id: id, file: join(root, dir, name), format: 'claude-transcript', ...(label === undefined ? {} : { name: label }) })
      }
    }
    return out
  }

  async function codexNames(): Promise<Map<string, string>> {
    const out = new Map<string, string>()
    if (deps.codexHome === undefined) return out
    try {
      for (const row of parseSessionIndex(await readFile(join(deps.codexHome, 'session_index.jsonl'), 'utf8'))) out.set(row.id, row.title)
    }
    catch { /* 没有索引:标题退回第一句 */ }
    return out
  }

  async function codexRefs(): Promise<SessionFileRef[]> {
    if (deps.codexHome === undefined) return []
    const names = await codexNames()
    const out: SessionFileRef[] = []
    const t = now()
    for (let offset = 0; offset < CODEX_DISCOVER_DAYS; offset += 1) {
      const d = new Date(t - offset * 86_400_000)
      const dir = join(deps.codexHome, 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'))
      for (const name of await listDir(dir)) {
        const id = CODEX_ID_RE.exec(name)?.[1]
        if (id === undefined) continue
        const label = names.get(id)
        out.push({ agent: 'codex', session_id: id, file: join(dir, name), format: 'codex-rollout', ...(label === undefined ? {} : { name: label }) })
      }
    }
    // 开得比 30 天还早、今天接着用的那条(10-08 真机)—— 按 Codex 自己的对话总表补上。
    for (const file of codexActiveRollouts({ codexHome: deps.codexHome, sinceMs: t - CODEX_ACTIVE_LOOKBACK_MS })) {
      if (out.some(ref => ref.file === file)) continue
      const id = CODEX_ID_RE.exec(basename(file))?.[1]
      if (id === undefined) continue
      const label = names.get(id)
      out.push({ agent: 'codex', session_id: id, file, format: 'codex-rollout', ...(label === undefined ? {} : { name: label }) })
    }
    return out
  }

  function kimiRefs(): SessionFileRef[] {
    const map = deps.kimiConversations?.()
    if (map === undefined) return []
    const out: SessionFileRef[] = []
    for (const [key, info] of map) {
      if (info.records === undefined) continue
      const id = key.split(':').pop() ?? key
      out.push({ agent: 'kimi', session_id: id, file: info.records, format: 'kimi-wire', ...(info.title === undefined ? {} : { name: info.title }) })
    }
    return out
  }

  /** 各家的记录文件(同一条只留一份:登记过的那份带的名字更准,优先)。 */
  async function allRefs(agent?: string): Promise<SessionFileRef[]> {
    const want = (one: string): boolean => agent === undefined || agent === one
    const out = new Map<string, SessionFileRef>()
    for (const ref of deps.registered?.() ?? []) if (want(ref.agent)) out.set(keyOf(ref.agent, ref.session_id), ref)
    const lists = await Promise.all([
      want('claude') ? claudeRefs() : [],
      want('codex') ? codexRefs() : [],
      want('kimi') ? kimiRefs() : [],
    ])
    for (const list of lists) {
      for (const ref of list) {
        const key = keyOf(ref.agent, ref.session_id)
        const prior = out.get(key)
        if (prior === undefined) out.set(key, ref)
        else if (prior.name === undefined && ref.name !== undefined) out.set(key, { ...prior, name: ref.name })
      }
    }
    return [...out.values()].filter(ref => !hidden.has(ref.agent))
  }

  async function summarize(ref: SessionFileRef, ms: number, size: number): Promise<Summary> {
    const stamp = `${ms}:${size}:${ref.name ?? ''}`
    const cached = summaries.get(ref.file)
    if (cached !== undefined && cached.stamp === stamp) return cached.summary
    const read = await readHeadTail({ format: ref.format, file: ref.file }, { headBytes: LIST_HEAD_BYTES, maxHeadBytes: 1024 * 1024, tailBytes: LIST_TAIL_BYTES })
    let summary: Summary = { keep: false }
    if (read !== undefined) {
      const input = { ...read, ...(ref.name === undefined ? {} : { name: ref.name }) }
      const turns = turnsOf(ref.format, input)
      const digest = digestOf(ref.format, { ...input, rounds: 1 })
      const selfcheck = isSelfcheckAsk(turns.first_ask) || isSelfcheckCwd(turns.cwd)
        || (ref.format === 'claude-transcript' && selfcheckOfTail(read.head, turns.cwd) !== undefined)
      const said = turns.turns.length > 0 || turns.first_ask !== undefined
      const last = [...turns.turns].reverse().find(turn => turn.text.trim() !== '' || turn.image === true)
      const lastText = last === undefined ? undefined : humanizeText(last.text, LAST_LINE_MAX, last.k === 'ask' ? 1 : 3) ?? (last.image === true ? '发来一张图片' : undefined)
      const round = digest.rounds[digest.rounds.length - 1]
      const fallback = round?.reply !== undefined ? { who: 'ai' as const, text: round.reply } : round?.ask !== undefined ? { who: 'you' as const, text: round.ask } : undefined
      summary = {
        keep: said && turns.subagent !== true && !selfcheck,
        ...(digest.title === undefined ? {} : { title: digest.title }),
        ...(turns.cwd === undefined ? {} : { cwd: turns.cwd }),
        ...(last !== undefined && lastText !== undefined ? { last_line: { who: last.k === 'ask' ? 'you' as const : 'ai' as const, text: lastText } } : fallback === undefined ? {} : { last_line: fallback }),
      }
    }
    summaries.set(ref.file, { stamp, summary })
    if (summaries.size > 500) {
      const oldest = summaries.keys().next().value
      if (oldest !== undefined) summaries.delete(oldest)
    }
    return summary
  }

  return {
    async page(query) {
      const limit = Math.max(1, Math.min(50, query.limit ?? SESSION_HISTORY_LIMIT))
      /** 另一档:每家各取最近这么多条、一次全给(见 {@link SessionHistoryQuery.per_family})。 */
      const perFamily = query.per_family === undefined ? undefined : Math.max(1, Math.min(PER_FAMILY_MAX, Math.floor(query.per_family)))
      const since = now() - days * 86_400_000
      const live = new Map<string, HistoryLiveSession>()
      for (const one of deps.liveSessions?.() ?? []) live.set(keyOf(one.agent, one.session_id), one)
      const candidates: Candidate[] = []
      const refs = await allRefs(query.agent)
      const stats = await Promise.all(refs.map(ref => statOf(ref.file)))
      refs.forEach((ref, index) => {
        const info = stats[index]
        if (info === undefined || info.ms < since) return
        const liveOne = live.get(keyOf(ref.agent, ref.session_id))
        candidates.push({ ref, agent: ref.agent, session_id: ref.session_id, ms: info.ms, size: info.size, ...(liveOne === undefined ? {} : { live: liveOne }) })
      })
      /*
       * ★ 窗口型那几家(2026-10-01 维护者在外面:「最近10个全是 manus 的」)。会话表里它们的 `updated_at`
       * 是**工作台读窗口的时刻**(几秒刷一次),不是那条对话真的最后动静 —— 拿它排序,Manus 侧栏里 8 条老对话
       * 永远排最前。真实时间读不到就缺席(不编一个数):排序时间记 0,排在有记录文件的后面,不带 `last_at`;
       * 每家最多 {@link WINDOW_ONLY_PER_AGENT} 条(侧栏读到几条列几条,别让一家占满一页)。
       */
      /*
       * `per_family` 那一档把这个上限抬到 `per_family`(2026-10-03):列表按家分好组之后,
       * 「一家刷屏」这件事本身没了 —— Manus 的几条待在 Manus 自己那一组里,挡不着 Claude。
       * 时间读不到照旧缺席、照旧排在有记录文件的后面:那一条规矩没动。
       */
      const windowCap = perFamily ?? WINDOW_ONLY_PER_AGENT
      const perAgent = new Map<string, number>()
      for (const one of deps.windowSessions?.() ?? []) {
        if (hidden.has(one.agent) || (query.agent !== undefined && query.agent !== one.agent) || one.selfcheck !== undefined) continue
        const count = perAgent.get(one.agent) ?? 0
        if (query.agent === undefined && count >= windowCap) continue
        perAgent.set(one.agent, count + 1)
        candidates.push({ live: one, agent: one.agent, session_id: one.session_id, ms: 0, size: 0 })
      }
      candidates.sort(compare)
      if (perFamily !== undefined) {
        /*
         * 一次全给:从新往旧扫,每家数到 `per_family` 条就不再读那家后面的文件
         * (读头尾那一下只花在真要列出来的那几条上)。不分页 —— 手机要整份才分得了组。
         */
        const kept = new Map<string, number>()
        const items: SessionHistoryItem[] = []
        for (const one of candidates) {
          if ((kept.get(one.agent) ?? 0) >= perFamily) continue
          const item = await itemOf(one)
          if (item === undefined) continue
          kept.set(one.agent, (kept.get(one.agent) ?? 0) + 1)
          items.push(item)
        }
        return { items, days, read_at: new Date(now()).toISOString(), per_family: perFamily }
      }
      const cursor = decodeCursor(query.before)
      let start = 0
      if (cursor !== undefined) {
        const [ms, agent, id] = cursor
        start = candidates.findIndex(one => compare(one, { ms, agent, session_id: id }) > 0)
        if (start === -1) start = candidates.length
      }
      const items: SessionHistoryItem[] = []
      let index = start
      for (; index < candidates.length && items.length < limit; index += 1) {
        const one = candidates[index]!
        const item = await itemOf(one)
        if (item !== undefined) items.push(item)
      }
      const last = candidates[index - 1]
      return {
        items,
        ...(index < candidates.length && last !== undefined ? { next: encodeCursor(last) } : {}),
        days,
        read_at: new Date(now()).toISOString(),
      }
    },

    async locate(agent, sessionId) {
      if (!safeSessionId(sessionId) || agent === '') return undefined
      const registered = (deps.registered?.() ?? []).find(ref => ref.agent === agent && ref.session_id === sessionId)
      if (registered !== undefined) return registered
      if (agent === 'claude' && deps.claudeHome !== undefined) {
        const root = join(deps.claudeHome, 'projects')
        for (const dir of await listDir(root)) {
          const file = join(root, dir, `${sessionId}.jsonl`)
          if (await statOf(file) !== undefined) return { agent, session_id: sessionId, file, format: 'claude-transcript' }
        }
        return undefined
      }
      const refs = agent === 'codex' ? await codexRefs() : agent === 'kimi' ? kimiRefs() : []
      return refs.find(ref => ref.session_id === sessionId)
    },
  }

  async function itemOf(one: Candidate): Promise<SessionHistoryItem | undefined> {
    const liveOne = one.live
    if (one.ref === undefined) {
      // 窗口型:会话表里那一条就是全部。
      if (liveOne === undefined) return undefined
      return {
        agent: one.agent,
        session_id: one.session_id,
        ...(liveOne.title === undefined ? {} : { title: liveOne.title }),
        ...(liveOne.project === undefined ? {} : { project: liveOne.project }),
        ...(liveOne.activity === undefined ? {} : { last_line: { who: 'ai' as const, text: liveOne.activity.line } }),
        status: liveOne.status,
        window_only: true,
      }
    }
    if (liveOne?.selfcheck !== undefined) return undefined
    const summary = await summarize(one.ref, one.ms, one.size)
    if (!summary.keep) return undefined
    const project = liveOne?.project ?? (summary.cwd === undefined ? undefined : await deps.resolveProject?.(summary.cwd).catch(() => undefined))
    const title = liveOne?.title ?? summary.title
    return {
      agent: one.agent,
      session_id: one.session_id,
      ...(title === undefined ? {} : { title }),
      ...(project === undefined ? {} : { project }),
      last_at: new Date(one.ms).toISOString(),
      ...(summary.last_line === undefined ? {} : { last_line: summary.last_line }),
      ...(liveOne === undefined ? {} : { status: liveOne.status }),
    }
  }
}

