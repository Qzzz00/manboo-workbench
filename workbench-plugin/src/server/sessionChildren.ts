/**
 * 后台任务挂在主会话上(2026-09-25,卡 Q;设计第六节)。
 *
 * 维护者:「这种后台任务,事务官是看不到的,我其实也不建议分开展示,卡片会非常多,事务官的卡片里可以改成一张卡片里有
 * 后台任务的说明,就是多一层的意思」。证据:统筹那条 Claude 会话底下同时跑着 7 个子代理,工作台只看得到统筹那一条。
 *
 * 这里把各家的子任务认出来,挂在主会话的 `children` 上(同一个形状 {@link SessionChildView}),不写死家名:
 *
 * | 哪一种 | 从哪读 |
 * |---|---|
 * | Claude 的子代理 | 主会话记录文件旁边那个目录:`<会话>.jsonl` → `<会话>/subagents/agent-<id>.meta.json`(派它时的描述)+ `agent-<id>.jsonl`(它自己的记录) |
 * | **DSH(事务官自己)的子代理** | **会话头上 `origin: 'subagent'` + `parentSession`**(卡 U3,2026-09-25) |
 * | 事务官派出去的活 | 看板上挂在那条事务官会话上的事项(`conversation.session_id`)的 `dispatch` / `client_dispatch` |
 * | Codex 的子任务 | 形状留好了;这台机器上还没有 Codex 子任务的样本(父子怎么连对不上真数据),读法没接 |
 *
 * **只读**(`readdir` / `stat` / 读文件头尾各一段);不经模型;十几秒一拍,文件没动就不重读。
 * 子任务**不单独成一条会话**,只挂在主会话上 ——「执行 n」只算主会话一次(protocol 的 `sessionBusy`)。
 *
 * **DSH 子代理这一条(卡 U3,升到 0.1.7 时补上;评估第四节说它「现在没接」)**:
 * 0.1.7 里子代理**就是一条普通会话** —— 没有 Claude 那种 `subagents/` 目录,认它只靠会话头上
 * `origin: 'subagent'` 与 `parentSession` 两个字段一起出现(判据在 `src/dshSessionFile.ts` 的
 * `dshSubagentOf`;上游自己也是这么找的 —— `session-persistence-jsonl` 里那句
 * `header.origin === 'subagent' && header.parentSession === id`)。
 * 正因为它是一条普通会话,**这一家不读文件**:状态、标题、在做什么在会话表里全是现成的
 * (DSH 会话 feed 已经按 `session/event` 折出来了),这里只做两件事 ——
 * ① 把它改挂成父会话底下的一项;② **把它自己那一行从会话表里摘掉**。
 * ② 就是卡 Q 那条「子任务不单独成一条会话」,也是维护者当初的原话「卡片会非常多」:
 * 一条会话底下同时跑七个子代理时,不摘掉就是一屏七张看不懂的卡,而它们已经在父卡那一行
 * 「内含 N 项后台任务」里数过了 —— 留着那几行等于同一件事在屏幕上出现两次。
 * (「执行 n」那个数不受影响:卡 V 的 `src/running.ts` 本来就不数 `agent === 'dsh'` 的散会话。)
 * `attach` 是 `/state.sessions` 与登记表的唯一出口,所以摘在这里就到处都一致。
 */
import { open, readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { SessionChildStatus, SessionChildView, SessionView, TaskView } from '../protocol.ts'
import { activityOfTool, humanizeText } from './sessionDigest.ts'

/** 一条主会话最多挂几项(在跑的在前,再是最近办完的)。 */
export const CHILDREN_MAX = 30
/** 办完 / 出错的那几项留多久(再早的不再挂着 —— 「内含 N 项」说的是这一阵的,不是有史以来的)。 */
export const CHILD_DONE_KEEP_MS = 12 * 60 * 60_000
/** 子代理的记录多久没动、又没说完 —— 当它停了(不再算在跑)。 */
export const CHILD_STALE_MS = 60 * 60_000
/**
 * **主会话自己也这么久没动**时,子代理这么久没动又没说完就当它停了(2026-09-26 晚,统筹)。
 * 维护者关掉旧统筹窗口,它派的卡 AC 跟着被掐,记录停在一次工具调用上;原来要等满 {@link CHILD_STALE_MS},
 * 那一小时里旧统筹那张卡一直「在跑 1」。主会话还在动就照旧等一小时(它可能在等一个长任务)。
 */
export const CHILD_ORPHAN_MS = 20 * 60_000
/** 多久看一遍。 */
export const CHILDREN_REFRESH_MS = 15_000
/** 主会话多久没动就不再去看它底下的子代理(在跑 / 等你的照看)。 */
export const PARENT_RECENT_MS = 6 * 60 * 60_000
/** 一项的描述、在做什么最多几个字。 */
const TITLE_MAX = 40
const ACTIVITY_MAX = 48
/** 子代理记录的尾巴读多少(最近那几条就够)。 */
const TAIL_BYTES = 64 * 1024
const HEAD_BYTES = 16 * 1024

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function lines(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const parsed: unknown = JSON.parse(line)
      if (isRecord(parsed)) out.push(parsed)
    }
    catch { /* 头尾截断的那一行 */ }
  }
  return out
}

function contentBlocks(row: Record<string, unknown>): Record<string, unknown>[] {
  const message = isRecord(row.message) ? row.message : undefined
  const content = message?.content
  if (Array.isArray(content)) return content.filter(isRecord)
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return []
}

/**
 * 一个 Claude 子代理的记录(头一段 + 尾一段)→ 一项后台任务。纯函数,时刻由调用方给。
 *
 * - 状态:最后一条对话(不算附件)是它说完的那一句(`stop_reason: end_turn`,没有要跑的工具)→ 办完了;
 *   接口报错 → 出错了;否则记录一小时内动过 → 在跑;再久没动、又没说完 → 当它停了(办完了,不再算在跑)。
 * - 在做什么:最后一段它说的话(人话,截短);没说话就看它最后在用什么工具(「在跑测试」「在改文件」……)。
 * - 描述:派它时写的那一句(meta 里的 description);没有就用它收到的第一句要求。
 */
export function claudeChild(input: {
  id: string
  parent: string
  meta?: Record<string, unknown>
  head: string
  tail: string
  mtimeMs: number
  nowMs: number
  /** 主会话那份记录最后一次被写的时刻;不知道就只按 {@link CHILD_STALE_MS}。 */
  parentMtimeMs?: number
}): SessionChildView {
  const headRows = lines(input.head)
  const tailRows = lines(input.tail)
  const first = headRows.find(row => typeof row.timestamp === 'string')
  const talk = tailRows.filter(row => row.type === 'assistant' || row.type === 'user')
  const last = talk.at(-1)
  const lastAt = [...tailRows].reverse().find(row => typeof row.timestamp === 'string')?.timestamp as string | undefined

  let status: SessionChildStatus
  const lastMessage = last !== undefined && isRecord(last.message) ? last.message : undefined
  const lastBlocks = last === undefined ? [] : contentBlocks(last)
  const said = last?.type === 'assistant' && lastMessage?.stop_reason === 'end_turn' && !lastBlocks.some(block => block.type === 'tool_use')
  const failed = last?.isApiErrorMessage === true
  if (failed) status = 'error'
  else if (said) status = 'done'
  else status = input.nowMs - input.mtimeMs < childStaleMs(input.nowMs, input.parentMtimeMs) ? 'running' : 'done'

  // 在做什么:从后往前,第一段它说的话;没有就看它最后用的工具。
  let activity: SessionChildView['activity']
  for (const row of [...talk].reverse()) {
    if (row.type !== 'assistant') continue
    const at = typeof row.timestamp === 'string' ? row.timestamp : undefined
    const blocks = contentBlocks(row)
    const text = blocks.filter(block => block.type === 'text' && typeof block.text === 'string').map(block => block.text as string).join('\n')
    const line = text === '' ? undefined : humanizeText(text, ACTIVITY_MAX)
    if (line !== undefined) { activity = { line, at: at ?? lastAt ?? new Date(input.mtimeMs).toISOString() }; break }
    const tool = [...blocks].reverse().find(block => block.type === 'tool_use')
    if (tool !== undefined) {
      activity = { line: activityOfTool(tool.name, tool.input), at: at ?? lastAt ?? new Date(input.mtimeMs).toISOString() }
      break
    }
  }

  const model = [...talk].reverse().map(row => (isRecord(row.message) ? row.message.model : undefined)).find((one): one is string => typeof one === 'string' && one !== '' && !one.startsWith('<'))
  const described = typeof input.meta?.description === 'string' ? input.meta.description.trim() : ''
  const firstAsk = headRows.find(row => row.type === 'user')
  const askText = firstAsk === undefined ? '' : contentBlocks(firstAsk).filter(block => block.type === 'text' && typeof block.text === 'string').map(block => block.text as string).join('\n')
  const title = (described !== '' ? humanizeText(described, TITLE_MAX, 1) : undefined)
    ?? (askText === '' ? undefined : humanizeText(askText, TITLE_MAX))
    ?? '一项后台任务'
  const startedAt = typeof first?.timestamp === 'string' ? first.timestamp : undefined
  return {
    id: input.id,
    parent_session_id: input.parent,
    title,
    status,
    ...(activity === undefined ? {} : { activity }),
    ...(startedAt === undefined ? {} : { started_at: startedAt }),
    ...(status === 'running' || lastAt === undefined ? {} : { ended_at: lastAt }),
    ...(model === undefined ? {} : { model }),
  }
}

/**
 * 会话状态 → 一项后台任务的状态(卡 U3)。
 *
 * `offline` 记 `done`:DSH 会话被收掉(`session/disposed`)时我们报的就是 offline,
 * 对「内含 N 项」来说它已经不在跑了;**不记 error** —— 会话正常结束后被收掉是常态,
 * 报成「出错了」会在卡上凭空多出一条红的(D13:不编)。
 */
export function childStatusOfSession(status: SessionView['status']): SessionChildStatus {
  if (status === 'running') return 'running'
  if (status === 'waiting') return 'waiting'
  if (status === 'error') return 'error'
  return 'done'
}

/**
 * 一条 DSH 子代理会话 → 挂在派它的那条会话底下的一项(卡 U3)。
 *
 * 描述那一句按「派它时写的那一句」的同一条口径取:先 `title`(DSH 的 `session/title`,
 * 几秒后会被模型生成的标题顶掉),没有就退到它最近说的那一段。都取不到才写兜底的那句话 ——
 * 不留空(空标题在卡上是一行看不懂的空白)。
 */
export function dshSubagentChild(session: SessionView, parent: string): SessionChildView {
  const title = humanizeText(session.title, TITLE_MAX, 1)
    ?? humanizeText(session.summary, TITLE_MAX)
    ?? '一项后台任务'
  const status = childStatusOfSession(session.status)
  return {
    id: session.session_id,
    parent_session_id: parent,
    title,
    status,
    // 「在做什么」用会话行上现成的那一格(卡 P 已经把它变成人话了),没有就缺席,不编。
    ...(session.activity === undefined ? {} : { activity: session.activity }),
    ...(status === 'running' || status === 'waiting' ? {} : { ended_at: session.updated_at }),
  }
}

/** 事务官派出去的那一件 → 挂在派它的那条事务官会话底下的一项。 */
export function dispatchChild(task: Pick<TaskView, 'id' | 'title' | 'conversation' | 'dispatch' | 'client_dispatch'>): SessionChildView | undefined {
  const parent = task.conversation?.session_id
  if (parent === undefined || parent === '') return undefined
  const title = humanizeText(task.title, TITLE_MAX, 1) ?? '一件派出去的事'
  const cli = task.dispatch
  if (cli !== undefined) {
    const status: SessionChildStatus = cli.status === 'running' ? 'running' : cli.status === 'failed' ? 'error' : 'done'
    const line = cli.note === undefined ? undefined : humanizeText(cli.note, ACTIVITY_MAX)
    return {
      id: `dispatch:${task.id}`,
      parent_session_id: parent,
      title,
      status,
      ...(line === undefined ? {} : { activity: { line, at: cli.ended_at ?? cli.started_at } }),
      started_at: cli.started_at,
      ...(cli.ended_at === undefined ? {} : { ended_at: cli.ended_at }),
    }
  }
  const window = task.client_dispatch
  if (window !== undefined) {
    const replied = window.reply_at !== undefined || (window.reply !== undefined && window.reply !== '')
    /**
     * `typed` = 字写进框里了、没发出去(2026-09-28,卡 WR):**不是在跑**(它压根没收到这句话),
     * 按 `error` 算 —— 和 `failed` 一样是「这一次没成,要他动一下手」。
     */
    const status: SessionChildStatus = window.status === 'failed' || window.status === 'typed'
      ? 'error'
      : replied ? 'done' : 'running'
    const reply = window.reply === undefined ? undefined : humanizeText(window.reply, ACTIVITY_MAX)
    return {
      id: `client_dispatch:${task.id}`,
      parent_session_id: parent,
      title,
      status,
      ...(reply === undefined ? {} : { activity: { line: reply, at: window.reply_at ?? window.at } }),
      started_at: window.at,
      ...(status === 'running' ? {} : { ended_at: window.reply_at ?? window.at }),
    }
  }
  return undefined
}

/**
 * 挑出要挂的那几项、排一排:在跑 / 等你的全留、排在前面;办完 / 出错的只留 {@link CHILD_DONE_KEEP_MS} 以内的,按开始时刻从新到旧;
 * 最多 {@link CHILDREN_MAX} 项(主卡上「内含 N 项」数的就是挂着的这几项)。
 */
export function orderChildren(children: readonly SessionChildView[], nowMs?: number): SessionChildView[] {
  const busy = (one: SessionChildView): number => (one.status === 'running' || one.status === 'waiting' ? 0 : 1)
  const recent = (one: SessionChildView): boolean => {
    if (busy(one) === 0 || nowMs === undefined) return true
    const at = Date.parse(one.ended_at ?? one.started_at ?? '')
    return !Number.isFinite(at) || nowMs - at <= CHILD_DONE_KEEP_MS
  }
  return children
    .filter(recent)
    .sort((a, b) => busy(a) - busy(b) || (b.started_at ?? '').localeCompare(a.started_at ?? ''))
    .slice(0, CHILDREN_MAX)
}

async function readSlice(file: string, fromEnd: boolean, bytes: number): Promise<string> {
  const handle = await open(file, 'r')
  try {
    const size = (await handle.stat()).size
    const length = Math.min(bytes, size)
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, fromEnd ? size - length : 0)
    return buffer.subarray(0, bytesRead).toString('utf8')
  }
  finally {
    await handle.close()
  }
}

/** 一条 Claude 主会话的子代理(读文件的那一半)。目录不在 / 读不了 → 空。 */
/** 子代理多久没动算停了:主会话也停了 → {@link CHILD_ORPHAN_MS},否则 {@link CHILD_STALE_MS}。 */
function childStaleMs(nowMs: number, parentMtimeMs: number | undefined): number {
  return parentMtimeMs !== undefined && nowMs - parentMtimeMs >= CHILD_ORPHAN_MS ? CHILD_ORPHAN_MS : CHILD_STALE_MS
}

export async function readClaudeChildren(
  transcript: string,
  parent: string,
  nowMs: number,
  cache: Map<string, { mtimeMs: number, child: SessionChildView }> = new Map(),
): Promise<SessionChildView[]> {
  const dir = join(transcript.replace(/\.jsonl$/, ''), 'subagents')
  let names: string[]
  try { names = await readdir(dir) }
  catch { return [] }
  let parentMtimeMs: number | undefined
  try { parentMtimeMs = (await stat(transcript)).mtimeMs }
  catch { parentMtimeMs = undefined }
  const out: SessionChildView[] = []
  for (const name of names) {
    const match = /^agent-(.+)\.jsonl$/.exec(name)
    if (match === null) continue
    const id = match[1] as string
    const file = join(dir, name)
    let mtimeMs: number
    try { mtimeMs = (await stat(file)).mtimeMs }
    catch { continue }
    const cached = cache.get(file)
    if (cached !== undefined && cached.mtimeMs === mtimeMs) {
      // 文件没动:只按时刻重算「在跑」有没有过期。
      const child = cached.child
      const stale = child.status === 'running' && nowMs - mtimeMs >= childStaleMs(nowMs, parentMtimeMs)
      out.push(stale ? { ...child, status: 'done' } : child)
      continue
    }
    let meta: Record<string, unknown> | undefined
    try {
      const parsed: unknown = JSON.parse(await readFile(join(dir, `agent-${id}.meta.json`), 'utf8'))
      if (isRecord(parsed)) meta = parsed
    }
    catch { meta = undefined }
    let head: string
    let tail: string
    try {
      head = await readSlice(file, false, HEAD_BYTES)
      tail = await readSlice(file, true, TAIL_BYTES)
    }
    catch { continue }
    const child = claudeChild({ id, parent, ...(meta === undefined ? {} : { meta }), head, tail, mtimeMs, nowMs, ...(parentMtimeMs === undefined ? {} : { parentMtimeMs }) })
    cache.set(file, { mtimeMs, child })
    out.push(child)
  }
  return orderChildren(out, nowMs)
}

/**
 * 卡 T 判出来「在等他的其实是底下哪一个子任务」(`session.ask.child`)→ 那一项记成「等你」(主卡那一行的「等你 y」跟着对)。
 * 卡 T 那边的 id 是子任务文件名(`agent-<id>`),这边是 `<id>`,两种都认。
 */
export function withAskedChild(children: readonly SessionChildView[], askedId: string | undefined): readonly SessionChildView[] {
  if (askedId === undefined) return children
  return children.map(child => ((child.id === askedId || `agent-${child.id}` === askedId) && child.status === 'running' ? { ...child, status: 'waiting' as const } : child))
}

export interface SessionChildrenDeps {
  /** 此刻的会话表(`service.getState().sessions`)。 */
  sessions: () => readonly SessionView[]
  /** 那一条会话的记录文件在哪(卡 P 的会话登记:sessionDigestService.fileOf)。 */
  fileOf: (agent: string, sessionId: string) => string | undefined
  /** 看板上的事项(事务官派出去的活)。 */
  tasks?: () => Promise<readonly TaskView[]>
  /**
   * 这条 DSH 会话是谁派出去的子代理 → 父会话 id(卡 U3;生产传 `dshSessionFeed.parentOf`)。
   * 不是子代理(或这一版 DSH 不给出身)→ undefined,那这一家就一项都不挂,与从前一样。
   */
  dshParentOf?: (sessionId: string) => string | undefined
  now?: () => Date
  setInterval?: (fn: () => void, ms: number) => unknown
  clearInterval?: (handle: unknown) => void
  /** 有变化(推一份快照)。 */
  onChanged?: () => void
}

export interface SessionChildren {
  start: () => void
  stop: () => void
  /** 看一遍(定时器每 {@link CHILDREN_REFRESH_MS} 一次;用例直接调)。绝不抛。 */
  refresh: () => Promise<void>
  /** 给会话表挂上后台任务(同步,读的是上一遍看到的)。 */
  attach: <T extends SessionView>(sessions: readonly T[]) => T[]
}

export function createSessionChildren(deps: SessionChildrenDeps): SessionChildren {
  const now = deps.now ?? (() => new Date())
  const setIntervalFn = deps.setInterval ?? ((fn: () => void, ms: number) => { const h = setInterval(fn, ms); h.unref?.(); return h })
  const clearIntervalFn = deps.clearInterval ?? ((h: unknown) => clearInterval(h as ReturnType<typeof setInterval>))
  const byKey = new Map<string, readonly SessionChildView[]>()
  const fileCache = new Map<string, { mtimeMs: number, child: SessionChildView }>()
  /** 上一遍认出来的 DSH 子代理会话 id:`attach` 据此把它们自己那一行从会话表里摘掉(卡 U3)。 */
  let dshSubagentIds: ReadonlySet<string> = new Set()
  let timer: unknown
  let busy = false
  const key = (agent: string, sessionId: string): string => `${agent}:${sessionId}`

  async function refresh(): Promise<void> {
    if (busy) return
    busy = true
    try {
      const nowMs = now().getTime()
      const next = new Map<string, readonly SessionChildView[]>()
      for (const session of deps.sessions()) {
        if (session.agent !== 'claude') continue
        const recent = session.status === 'running' || session.status === 'waiting' || nowMs - Date.parse(session.updated_at) < PARENT_RECENT_MS
        if (!recent) continue
        const file = deps.fileOf(session.agent, session.session_id)
        if (file === undefined) continue
        const children = await readClaudeChildren(file, session.session_id, nowMs, fileCache)
        if (children.length > 0) next.set(key(session.agent, session.session_id), children)
      }
      // DSH 那一格底下两种来源(它自己的子代理会话 + 事务官派出去的活)挂在同一个 key 上,
      // 所以先攒到一张表里再一次写进去 —— 分两次 set 会让后写的那一种把前一种整个顶掉。
      const dshByParent = new Map<string, SessionChildView[]>()
      const addDsh = (child: SessionChildView): void => {
        const group = dshByParent.get(child.parent_session_id) ?? []
        group.push(child)
        dshByParent.set(child.parent_session_id, group)
      }
      // DSH 自己的子代理(卡 U3):会话头上 origin+parentSession 认出来的那几条,不读文件。
      const subagentIds = new Set<string>()
      if (deps.dshParentOf !== undefined) {
        for (const session of deps.sessions()) {
          if (session.agent !== 'dsh') continue
          const parent = deps.dshParentOf(session.session_id)
          if (parent === undefined || parent === '' || parent === session.session_id) continue
          subagentIds.add(session.session_id)
          addDsh(dshSubagentChild(session, parent))
        }
      }
      if (deps.tasks !== undefined) {
        let list: readonly TaskView[] = []
        try { list = await deps.tasks() }
        catch { list = [] }
        for (const task of list) {
          const child = dispatchChild(task)
          if (child !== undefined) addDsh(child)
        }
      }
      for (const [parent, group] of dshByParent) next.set(key('dsh', parent), orderChildren(group, nowMs))
      const before = JSON.stringify([...byKey])
      byKey.clear()
      for (const [k, v] of next) byKey.set(k, v)
      dshSubagentIds = subagentIds
      if (JSON.stringify([...byKey]) !== before) {
        try { deps.onChanged?.() } catch { /* 推快照失败不连累 */ }
      }
    }
    catch { /* 这一遍没看成,下一遍再看 */ }
    finally { busy = false }
  }

  return {
    start() {
      if (timer === undefined) timer = setIntervalFn(() => { void refresh() }, CHILDREN_REFRESH_MS)
      void refresh()
    },
    stop() {
      if (timer !== undefined) { clearIntervalFn(timer); timer = undefined }
    },
    refresh,
    attach(sessions) {
      if (byKey.size === 0 && dshSubagentIds.size === 0) return [...sessions]
      return sessions
        // DSH 子代理已经挂在父会话底下了,它自己那一行摘掉(卡 Q:子任务不单独成一条会话)。
        // 摘的只有「认出了父亲的」那几条 —— 找不到父亲的照旧自己站一行,
        // 宁可多一行也不让一条会话凭空消失。
        .filter(session => !(session.agent === 'dsh' && dshSubagentIds.has(session.session_id)))
        .map((session) => {
          const children = byKey.get(key(session.agent, session.session_id))
          return children === undefined ? session : { ...session, children: withAskedChild(children, session.ask?.child?.id) }
        })
    },
  }
}
