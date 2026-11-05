/**
 * 千问办公自己的对话库:有哪些对话、在不在跑、最新一句、做完没有(2026-10-08,根治方案第三节第 3 条)。
 *
 * 它是 Electron/Chromium 程序,窗口被窗口槽藏起来后辅助功能树停在藏起那一刻 —— 读屏判不准在跑 / 做完。
 * 它在 `~/Library/Application Support/QwenWorkCN/data/agents.db`(SQLite,WAL)里记着每条对话,真机量过:
 *
 * - `chats` 一行 = 侧栏(坞上)的一条对话:`name` 就是侧栏标题;`archived_at` / `deleted_at` 有值的不算;
 * - `sub_chats` 挂在对话下面(本机每条对话一个),`stream_id` 出字时有值、出完清空 —— **中断的会一直挂着**
 *   (本机 13:41 那条「总结一下」停在 streaming 上再没动过),所以不拿它判在跑;
 * - `messages` 每一句一行(`sequence` 递增),回答那一行 `metadata.status` 是 `streaming` / `completed` / `cancelled`,
 *   出字期间 `updated_at` 跟着往前走(秒)—— 在跑 = 最新那句回答还在 streaming、而且最近还动过;
 *   最新一句 = 最新那句回答里最后一块 `text`。
 *
 * 纪律同 kimiConversations / codexThreadIndex:只读打开;`-wal` 在时直开,不在时 immutable,不给它的目录添文件;
 * 表的样子不对、状态出现没见过的字 → 整份回 undefined(调用方退回读屏),不抛。
 * 只取标题、最新一句(截短)、时刻、状态,不存聊天内容。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { AgentRecordChat, AgentRecordRead, AgentRecordReply } from './agentRecords.ts'

export const QWENWORK_BUNDLE_ID = 'cn.qwenwork.desktop.mac'

/**
 * 回答还标着 streaming、却这么久没动 = 中断了(App 关掉 / 崩了 / 断网),不算在跑。
 * 真机量:出字期间 `updated_at` 至少几秒一动;跑工具(搜网页、读文件)时最长停多久见交接。
 */
export const QWENWORK_STALL_MS = 5 * 60_000
/** 一次最多给几条对话(同登记表侧栏标题最多 8 条)。 */
const MAX_CHATS = 8
/** 最新一句最长几个字(同登记表存的最新一句)。 */
const LATEST_MAX = 120

const REQUIRED_COLUMNS: Record<string, readonly string[]> = {
  chats: ['id', 'name', 'created_at', 'updated_at', 'archived_at', 'deleted_at'],
  sub_chats: ['id', 'chat_id', 'updated_at'],
  messages: ['id', 'sub_chat_id', 'sequence', 'role', 'parts', 'metadata', 'created_at', 'updated_at'],
}
const RUNNING_STATUS = 'streaming'
const FINISHED_STATUS = new Set(['completed', 'cancelled'])

export function defaultQwenWorkDb(home: string): string {
  return join(home, 'Library', 'Application Support', 'QwenWorkCN', 'data', 'agents.db')
}

function toImmutableUri(path: string): string {
  return `file:${path.split('/').map(segment => encodeURIComponent(segment)).join('/')}?immutable=1`
}

function iso(sec: unknown): string | undefined {
  return typeof sec === 'number' && Number.isFinite(sec) && sec > 0 ? new Date(sec * 1000).toISOString() : undefined
}

/** 一段回答 → 「最新一句」:最后一行有字的(去掉 Markdown 记号),截短。 */
export function latestLine(text: string): string | undefined {
  const lines = text.split(/\r?\n/u)
    .map(line => line.replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|>\s*|\d+[.)]\s+)/u, '').replace(/[*_`]+/gu, '').replace(/\s+/gu, ' ').trim())
    .filter(line => line !== '' && !/^[-|:\s]+$/u.test(line))
  const last = lines[lines.length - 1]
  if (last === undefined) return undefined
  const chars = [...last]
  return chars.length <= LATEST_MAX ? last : `${chars.slice(0, LATEST_MAX).join('')}…`
}

function hasColumns(db: DatabaseSync): boolean {
  for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
    const have = new Set((db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as Array<Record<string, unknown>>).map(row => row.name))
    if (columns.some(column => !have.has(column))) return false
  }
  return true
}

function metaStatus(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  try {
    const status = (JSON.parse(raw) as Record<string, unknown>).status
    return typeof status === 'string' ? status : undefined
  }
  catch { return undefined }
}

class Unfamiliar extends Error {}

function readChats(db: DatabaseSync, nowMs: number): AgentRecordChat[] {
  const chats = db.prepare(
    `SELECT id, name, updated_at FROM chats
     WHERE archived_at IS NULL AND deleted_at IS NULL
     ORDER BY updated_at DESC LIMIT ${MAX_CHATS * 2}`,
  ).all() as Array<Record<string, unknown>>
  const lastOf = db.prepare(
    `SELECT m.id, m.role, m.metadata, m.created_at, m.updated_at FROM messages m JOIN sub_chats s ON s.id = m.sub_chat_id
     WHERE s.chat_id = ? ORDER BY m.updated_at DESC, m.sequence DESC LIMIT 1`,
  )
  const lastReplyOf = db.prepare(
    `SELECT m.id, m.metadata, m.updated_at FROM messages m JOIN sub_chats s ON s.id = m.sub_chat_id
     WHERE s.chat_id = ? AND m.role = 'assistant' ORDER BY m.updated_at DESC, m.sequence DESC LIMIT 1`,
  )
  const lastAskOf = db.prepare(
    `SELECT m.created_at FROM messages m JOIN sub_chats s ON s.id = m.sub_chat_id
     WHERE s.chat_id = ? AND m.role = 'user' ORDER BY m.created_at DESC, m.sequence DESC LIMIT 1`,
  )
  // 只取 text 那几块的字(工具调用的输入输出一个字都不读进来)。
  const textOf = db.prepare(
    `SELECT json_extract(j.value, '$.text') AS t FROM messages m, json_each(m.parts) j
     WHERE m.id = ? AND json_extract(j.value, '$.type') = 'text' ORDER BY CAST(j.key AS INTEGER) DESC LIMIT 1`,
  )
  const out: AgentRecordChat[] = []
  for (const chat of chats) {
    if (out.length >= MAX_CHATS) break
    const id = chat.id
    if (typeof id !== 'string' || id === '') continue
    const last = lastOf.get(id) as Record<string, unknown> | undefined
    if (last === undefined) continue // 开了没说话的空对话
    const reply = lastReplyOf.get(id) as Record<string, unknown> | undefined
    const replyStatus = reply === undefined ? undefined : metaStatus(reply.metadata)
    if (replyStatus !== undefined && replyStatus !== RUNNING_STATUS && !FINISHED_STATUS.has(replyStatus)) throw new Unfamiliar(replyStatus)
    const movedMs = typeof last.updated_at === 'number' ? last.updated_at * 1000 : 0
    const fresh = nowMs - movedMs < QWENWORK_STALL_MS
    // 在跑:最新那句是回答、还在出字;或者她刚说了一句、回答那一行还没建出来。
    const running = fresh && (last.role === 'assistant' ? metaStatus(last.metadata) === RUNNING_STATUS : last.role === 'user')
    const text = reply === undefined ? undefined : (textOf.get(reply.id as string) as Record<string, unknown> | undefined)?.t
    const latest = typeof text === 'string' ? latestLine(text) : undefined
    const title = typeof chat.name === 'string' && chat.name.trim() !== '' ? chat.name.trim() : undefined
    const updatedAt = iso(last.updated_at) ?? iso(chat.updated_at) ?? new Date(nowMs).toISOString()
    const startedAt = iso((lastAskOf.get(id) as Record<string, unknown> | undefined)?.created_at)
    out.push({
      id,
      ...(title === undefined ? {} : { title }),
      status: running ? 'running' : 'done',
      ...(latest === undefined ? {} : { latest }),
      updated_at: updatedAt,
      ...(startedAt === undefined ? {} : { started_at: startedAt }),
      // 做完的时刻 = 回答最后一次写的时刻(判没看过的回复用)。中断的、她停掉的也算这一轮收了。
      ...(!running && last.role === 'assistant' ? { finished_at: updatedAt } : {}),
    })
  }
  return out
}

/** 只读打开它的库,读完就关。库缺席、打不开、表的样子不对、读的那一下抛了 → undefined。 */
function withDb<T>(dbPath: string, use: (db: DatabaseSync) => T): T | undefined {
  if (!existsSync(dbPath)) return undefined
  let db: DatabaseSync
  try {
    db = existsSync(`${dbPath}-wal`)
      ? new DatabaseSync(dbPath, { readOnly: true })
      : new DatabaseSync(toImmutableUri(dbPath), { readOnly: true })
  }
  catch { return undefined }
  try {
    if (!hasColumns(db)) return undefined
    return use(db)
  }
  catch { return undefined }
  finally {
    try { db.close() }
    catch { /* 关不上不改这一轮的结果 */ }
  }
}

/** 读一次。库缺席、打不开、表的样子不对、出现没见过的状态 → undefined(退回读屏)。 */
export function readQwenWorkRecords(input: { dbPath: string, nowMs: number }): AgentRecordRead | undefined {
  return withDb(input.dbPath, db => ({ chats: readChats(db, input.nowMs) }))
}

/** 认那一句的记号最短几个字(同读窗口那一路:不到 4 个字认不准)。 */
const MARKER_MIN_CHARS = 4

/**
 * **派活收回答**:按送进去那句里的记号找到那一轮,那一轮收了就回回答正文(2026-10-09)。
 *
 * - 那一句 = 她那一侧(`role='user'`)`text` 块里含记号的、最新的那一行(归档 / 删掉的对话不算);
 * - 那一轮的回答 = 同一个 `sub_chat` 里紧跟在它后面的第一行回答(她后来又问的那几轮不认);
 * - 回答正文 = `metadata.finalTextId` 指的那一块字,没有就取最后一块 `text`(工具调用、前面那块「我先看看」都不读);
 * - 还标着 streaming 且 {@link QWENWORK_STALL_MS} 内动过 = 在跑;回答行还没建、那一句刚送进去 = 在跑;
 *   cancelled = 她停掉了,有字给字、标 `stopped`;中断(streaming 却很久没动)= 收了、`stopped`,半截字不给。
 *
 * 库里还没有这一句 → `{found:false}`;读不了 / 没见过的状态 → undefined(调用方退回读窗口)。
 */
export function readQwenWorkReply(input: { dbPath: string, marker: string, nowMs: number }): AgentRecordReply | undefined {
  const marker = input.marker.trim()
  if ([...marker].length < MARKER_MIN_CHARS) return undefined
  return withDb(input.dbPath, (db): AgentRecordReply => {
    const ask = db.prepare(
      `SELECT m.sub_chat_id AS sub, m.sequence AS seq, m.created_at AS at FROM messages m JOIN chats c ON c.id = m.chat_id
       WHERE m.role = 'user' AND c.archived_at IS NULL AND c.deleted_at IS NULL
         AND EXISTS (SELECT 1 FROM json_each(m.parts) j WHERE json_extract(j.value, '$.type') = 'text' AND instr(json_extract(j.value, '$.text'), ?) > 0)
       ORDER BY m.created_at DESC, m.sequence DESC LIMIT 1`,
    ).get(marker) as Record<string, unknown> | undefined
    if (ask === undefined) return { found: false }
    const answer = db.prepare(
      `SELECT id, role, metadata, updated_at FROM messages WHERE sub_chat_id = ? AND sequence > ? ORDER BY sequence ASC LIMIT 1`,
    ).get(ask.sub as string, ask.seq as number) as Record<string, unknown> | undefined
    if (answer === undefined || answer.role !== 'assistant') {
      // 回答那一行还没建:刚送进去就是在跑;很久都没建 = 这一轮没起来(中断)。
      const askedMs = typeof ask.at === 'number' ? ask.at * 1000 : 0
      return input.nowMs - askedMs < QWENWORK_STALL_MS ? { found: true, status: 'running' } : { found: true, status: 'done', stopped: true }
    }
    const status = metaStatus(answer.metadata)
    if (status === undefined || (status !== RUNNING_STATUS && !FINISHED_STATUS.has(status))) throw new Unfamiliar(String(status))
    const movedMs = typeof answer.updated_at === 'number' ? answer.updated_at * 1000 : 0
    if (status === RUNNING_STATUS) {
      if (input.nowMs - movedMs < QWENWORK_STALL_MS) return { found: true, status: 'running' }
      // 标着 streaming 却很久没动 = 中断(或在等她批准一个工具,库里那一刻的样子还没量清):
      // 这一轮按收了算,但没写完的字不当回答交回去(`finalTextId` 只在 completed 时才有)。
      return { found: true, status: 'done', stopped: true }
    }
    const reply = finalTextOf(db, answer.id as string, answer.metadata)
    return {
      found: true,
      status: 'done',
      ...(reply === undefined ? {} : { reply }),
      ...(status === 'completed' ? {} : { stopped: true }),
    }
  })
}

/** 一行回答的正文:`finalTextId` 指的那一块字,没有就取最后一块 `text`。空白 → undefined。 */
function finalTextOf(db: DatabaseSync, messageId: string, metadata: unknown): string | undefined {
  let finalId: unknown
  try { finalId = typeof metadata === 'string' ? (JSON.parse(metadata) as Record<string, unknown>).finalTextId : undefined }
  catch { finalId = undefined }
  const rows = db.prepare(
    `SELECT json_extract(j.value, '$.id') AS id, json_extract(j.value, '$.text') AS t FROM messages m, json_each(m.parts) j
     WHERE m.id = ? AND json_extract(j.value, '$.type') = 'text' ORDER BY CAST(j.key AS INTEGER) ASC`,
  ).all(messageId) as Array<Record<string, unknown>>
  const picked = (typeof finalId === 'string' ? rows.find(one => one.id === finalId) : undefined) ?? rows[rows.length - 1]
  const text = picked?.t
  return typeof text === 'string' && text.trim() !== '' ? text.trim() : undefined
}
