import type { EventReason } from '../protocol.ts'

const INTERACTIVE_SOURCES = new Set(['cli', 'vscode', 'appServer'])

export interface CodexRolloutEvent {
  type: 'running' | 'done' | 'error'
  reason?: Extract<EventReason, 'interrupted'>
  ts?: number
}

export interface CodexRolloutSnapshot {
  id: string
  cwd?: string
  fallbackTitle?: string
  event?: CodexRolloutEvent
  /**
   * **这份记录里最新一条带时刻的记录是几点**(2026-09-27,卡 LK)。
   *
   * 真机根因(维护者 21:2x「他现在跑的是整理 Sportlight 参赛材料与网页」→ 事务官答「226 分钟没动静」):
   * 「最后一次动静」原来取的是 {@link CodexRolloutEvent.ts} —— 而那是**生命周期事件**
   * (`task_started` / `task_complete` / `turn_aborted`)的时刻,一个回合里只在开头出现一次。
   * 他那条 09-27 17:37 开的对话 21:30 还在一条条写 `item_completed`,`task_started` 却停在 17:38,
   * 于是 `/state.sessions` 的 updated_at 四个小时一动不动,电话里听到的就是「快四个小时没动静」。
   *
   * 现在另记一格:**任何一条能解析出时刻的记录**都算动静(`item_completed`、`token_count`、
   * `response_item`……)。状态照旧只认生命周期事件,时刻这一格归它自己 —— 两件事本来就不是一件事。
   */
  lastTs?: number
  /**
   * 这个 `event` 是**缺口之前**(头那一段)读到的(2026-09-27,卡 LK)。
   *
   * 大文件是头 256KB + 尾 256KB 拼起来读的(见 `defaultCodexSessionFeedDeps.readRollout`),
   * 中间那一大段根本没读。他那条 23MB 的对话里最后一次 `task_started` 离文件尾 4.1MB ——
   * 落在缺口里,于是拿到的是**开头**那一条(17:38 那一下)。状态碰巧还对(都是在跑),
   * 但哪天缺口前最后一条是 `task_complete`,真在跑的对话就会被说成「说完了」。
   * 所以这里明说一句「这个状态是从头上捡的、不可靠」,由调用方拿上一次已知状态盖过去。
   */
  eventFromHead?: true
}

/**
 * 头尾拼读时**中间缺了一段**的记号(2026-09-27,卡 LK)。
 *
 * `readRollout` 对大文件只读头尾两段,原来直接用 `\n` 拼 —— 解析那一头看不出中间少了东西,
 * 于是把头上那条生命周期事件当成「最后一条」。现在两段之间插这一行:解析看见它就知道
 * 「上面是头、下面是尾,中间的不知道」。它自己是一行合法 JSON(解析器逐行 `JSON.parse`),
 * `type` 不是任何已知记录类型,所以旧版解析器读到它也只是跳过。
 */
export const ROLLOUT_GAP_LINE = '{"type":"__rollout_gap__"}'

export function isInteractiveCodexSource(source: unknown): boolean {
  return typeof source === 'string' && INTERACTIVE_SOURCES.has(source)
}

/**
 * 这份 rollout 是不是「他自己的一条对话」(2026-09-27,卡 CX)。
 *
 * 真机根因:Codex Desktop 新版把子会话的 `source` 从字符串换成了对象
 * (`{ subagent: { other: 'guardian' } }`,09-27 当天目录里 5 个文件有 4 个是这形状),
 * 同时多了两格更直白的证据:`thread_source`(他自己那条是 `'user'`,审查子会话是
 * `'guardian_review'`)与 `parent_thread_id`(子会话指向父对话)。
 *
 * 只按「是不是子会话」排除,不按「是不是 'user'」挑:顶层对话的 `thread_source` 还有
 * `chatgpt_handoff`(从 ChatGPT 接过来)、`agent_created_thread`(Codex 另开一条)等,
 * 以后还会有新的,白名单一漏就整条消失(10-08 真机)。判断:
 * - 有父对话 → 子会话;
 * - `thread_source` 是已知的子会话种类,或 `source` 是 `{ subagent }` → 子会话;
 * - 剩下的:`source` 还是老的三个字符串就认;形状变了的只在 `thread_source` 明写了时认
 *   (认对话的凭据是线程本身,不是 source 的写法)。
 */
export function isOwnCodexThread(payload: Record<string, unknown>): boolean {
  const parent = payload.parent_thread_id
  if (typeof parent === 'string' && parent !== '') return false
  const threadSource = payload.thread_source
  if (typeof threadSource === 'string' && CHILD_THREAD_SOURCES.has(threadSource)) return false
  const source = asRecord(payload.source)
  if (source !== undefined && 'subagent' in source) return false
  if (isInteractiveCodexSource(payload.source)) return true
  return source !== undefined && typeof threadSource === 'string' && threadSource !== ''
}

const CHILD_THREAD_SOURCES = new Set(['guardian_review', 'subagent'])

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? value as Record<string, unknown>
    : undefined
}

function eventForType(type: unknown): CodexRolloutEvent | undefined {
  if (type === 'task_started') return { type: 'running' }
  if (type === 'task_complete') return { type: 'done' }
  if (type === 'turn_aborted') return { type: 'error', reason: 'interrupted' }
  return undefined
}

function timestampOf(row: Record<string, unknown>, payload: Record<string, unknown>): number | undefined {
  const timestamp = typeof row.timestamp === 'string'
    ? row.timestamp
    : typeof payload.timestamp === 'string' ? payload.timestamp : undefined
  if (timestamp === undefined) return undefined
  const parsed = Date.parse(timestamp)
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : undefined
}

export function parseCodexRollout(text: string): CodexRolloutSnapshot | undefined {
  let meta: CodexRolloutSnapshot | undefined
  let lastEvent: CodexRolloutEvent | undefined
  /** 生命周期事件是在缺口**之前**读到的吗(缺口之后又读到就翻回 false)。 */
  let eventBeforeGap = false
  let sawGap = false
  let lastTs: number | undefined

  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let row: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(line)
      const record = asRecord(parsed)
      if (record === undefined) continue
      row = record
    }
    catch {
      continue
    }

    if (row.type === '__rollout_gap__') {
      sawGap = true
      if (lastEvent !== undefined) eventBeforeGap = true
      continue
    }

    const payload = asRecord(row.payload)

    // 「最后一次动静」:任何一条能解析出时刻的记录都算(见 CodexRolloutSnapshot.lastTs)。
    {
      const ts = timestampOf(row, payload ?? {})
      if (ts !== undefined && (lastTs === undefined || ts > lastTs)) lastTs = ts
    }

    if (row.type === 'session_meta' && payload !== undefined && meta === undefined) {
      const id = payload.id ?? payload.session_id
      if (!isOwnCodexThread(payload) || typeof id !== 'string' || id === '') return undefined
      const cwd = payload.cwd
      meta = {
        id,
        ...(typeof cwd === 'string' && cwd !== '' ? { cwd } : {}),
      }
    }

    if (row.type === 'event_msg' && payload !== undefined) {
      const event = eventForType(payload.type)
      if (event !== undefined) {
        const ts = timestampOf(row, payload)
        lastEvent = {
          ...event,
          ...(ts === undefined ? {} : { ts }),
        }
        eventBeforeGap = false
      }
    }

    if (row.type === 'event_msg' && payload?.type === 'user_message'
      && meta !== undefined && meta.fallbackTitle === undefined
      && typeof payload.message === 'string' && payload.message.trim() !== '') {
      const fallbackTitle = payload.message.replace(/\s+/g, ' ').trim().slice(0, 80)
      meta.fallbackTitle = fallbackTitle
    }
  }

  if (meta === undefined) return undefined
  return {
    ...meta,
    ...(lastEvent === undefined ? {} : { event: lastEvent }),
    ...(lastTs === undefined ? {} : { lastTs }),
    ...(sawGap && eventBeforeGap ? { eventFromHead: true as const } : {}),
  }
}
