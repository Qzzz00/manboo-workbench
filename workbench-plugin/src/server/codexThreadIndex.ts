/**
 * Codex 自己那张对话总表:最近有动静的对话写在哪个 rollout 文件里(2026-10-08)。
 *
 * rollout 按**对话开始那天**落日期目录、之后一直往同一个文件里追加。按目录日期回看,开得早的对话
 * (她 10-08 晚上用的那条是 08-20 开的)今天接着用就整条看不见。Codex Desktop 在 `state_<N>.sqlite`
 * 的 `threads` 表里记着每条对话的 `rollout_path` 与最后更新时刻,按它找才准。
 *
 * 纪律同 kimiConversations:只读打开;`-wal` 在时直开(App 在跑时行在 WAL 里),不在时用 immutable,
 * 不给 Codex 的目录添 `-shm`。库缺席、读坏、表的样子不对一律回空 —— 调用方照旧按日期目录找。
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const STATE_DB = /^state_(\d+)\.sqlite$/
/** 一轮最多给这么多条(sweep 每条还要 stat 一次)。 */
const MAX_ROWS = 50

/** 版本号最大的那份 `state_<N>.sqlite`(Codex 换存储格式时会升这个号)。 */
function newestStateDb(codexHome: string): string | undefined {
  let best: { n: number, name: string } | undefined
  let names: string[]
  try { names = readdirSync(codexHome) }
  catch { return undefined }
  for (const name of names) {
    const m = STATE_DB.exec(name)
    if (m === null) continue
    const n = Number(m[1])
    if (best === undefined || n > best.n) best = { n, name }
  }
  return best === undefined ? undefined : join(codexHome, best.name)
}

function toImmutableUri(path: string): string {
  return `file:${path.split('/').map(segment => encodeURIComponent(segment)).join('/')}?immutable=1`
}

/** `sinceMs` 之后更新过、没归档的对话的 rollout 路径(新的在前)。 */
export function codexActiveRollouts(input: { codexHome: string, sinceMs: number }): string[] {
  const dbPath = newestStateDb(input.codexHome)
  if (dbPath === undefined) return []
  let db: DatabaseSync
  try {
    db = existsSync(`${dbPath}-wal`)
      ? new DatabaseSync(dbPath, { readOnly: true })
      : new DatabaseSync(toImmutableUri(dbPath), { readOnly: true })
  }
  catch { return [] }
  try {
    const rows = db.prepare(
      `SELECT rollout_path FROM threads
       WHERE archived = 0 AND COALESCE(updated_at_ms, updated_at * 1000) >= ?
       ORDER BY COALESCE(updated_at_ms, updated_at * 1000) DESC LIMIT ${MAX_ROWS}`,
    ).all(input.sinceMs) as Array<Record<string, unknown>>
    return rows.map(row => row.rollout_path).filter((p): p is string => typeof p === 'string' && p.endsWith('.jsonl'))
  }
  catch { return [] }
  finally {
    try { db.close() }
    catch { /* 关不上不改这一轮的结果 */ }
  }
}

/** 按已登记会话号查原件；不枚举其它线程或读取它们的内容。 */
export function codexRolloutForSession(codexHome: string, sessionId: string): string | undefined {
  const dbPath = newestStateDb(codexHome)
  if (dbPath === undefined) return undefined
  let db: DatabaseSync | undefined
  try {
    db = existsSync(`${dbPath}-wal`)
      ? new DatabaseSync(dbPath, { readOnly: true })
      : new DatabaseSync(toImmutableUri(dbPath), { readOnly: true })
    const row = db.prepare('SELECT rollout_path FROM threads WHERE id = ?').get(sessionId)
    return typeof row?.rollout_path === 'string' ? row.rollout_path : undefined
  } catch { return undefined }
  finally { db?.close() }
}

/** A single execution observation queries exact linked ids against one read-only index snapshot. */
export function createCodexRolloutLookup(codexHome: string): { get: (sessionId: string) => string | undefined, close: () => void } {
  let db: DatabaseSync | undefined
  let statement: ReturnType<DatabaseSync['prepare']> | undefined
  let attempted = false
  return {
    get(sessionId) {
      if (!attempted) {
        attempted = true
        const dbPath = newestStateDb(codexHome)
        if (dbPath !== undefined) try {
          db = existsSync(`${dbPath}-wal`)
            ? new DatabaseSync(dbPath, { readOnly: true })
            : new DatabaseSync(toImmutableUri(dbPath), { readOnly: true })
          statement = db.prepare('SELECT rollout_path FROM threads WHERE id = ?')
        } catch {
          try { db?.close() } catch { /* broken index stays unavailable */ }
          db = undefined
        }
      }
      try {
        const row = statement?.get(sessionId)
        return typeof row?.rollout_path === 'string' ? row.rollout_path : undefined
      } catch { return undefined }
    },
    close() { try { db?.close() } catch { /* read-only snapshot is already unusable */ }
      db = undefined; statement = undefined },
  }
}
