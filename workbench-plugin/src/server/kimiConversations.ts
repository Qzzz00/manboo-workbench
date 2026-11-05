/**
 * Kimi 桌面版会话的标题与工作区——只读 daimon 的 conversations.sqlite(2026-09-09)。
 *
 * 出处:docs/superpowers/research/2026-09-09-Kimi桌面版标题与归属.md。桌面版把状态写在
 * kimi-agent/*.json(kimiSessionFeed 读的那两份),标题与 cwd 却在随 App 同包的 daimon
 * 运行时写的一份 SQLite 里:`conversations` 表的 `conversation_key` 与 statuses/usage 的键
 * 一模一样,同行有 `title`/`title_status`/`workspace_path`。用 Node 内建 `node:sqlite`
 * 只读打开(DSH 自带的 node 24.19 免 flag 可用),零新依赖,不改 Kimi 任何文件。
 *
 * 四条纪律,每条都有用例钉着:
 * 1. **readOnly,且 `-wal` 在时绝不用 immutable=1**:App 运行期间 daimon 从不 checkpoint,
 *    主文件是 9/4 的空库、行全在 WAL 里,immutable 绕过 WAL 只会读到 0 行。
 * 2. **`-wal` 不在时用 immutable=1**:这时 readOnly 打开 WAL 库会由 SQLite 新建一个 `-shm`,
 *    等于给 Kimi 的目录添文件。App 关闭时 daimon 已 checkpoint 回主文件,immutable 读得全。
 * 3. **先看 `schema_metadata.schema_version`**,不是 '1' 就整份退回(不抛、不猜列名)——
 *    这份库 9/4 才从 sessions.v2.json 迁来,daimon 一周内换过一次存储格式,再换的概率不低。
 * 4. **`title_status` 不是 generated 就不给标题**(D13 不猜);`updated_at_ms` 是标题生成时刻
 *    不是最后活动时刻,新鲜度仍由 kimiSessionFeed 按 usage 文件的 updatedAt 判,这里不碰。
 *
 * 请求驱动 + 限频:没有定时器,谁要谁调 `lookup()`,窗内(默认 30 秒)复用上一次结果,
 * 读失败同样缓存——库真坏了也不会每条会话都去撞一次。打不开、读坏一律 undefined,
 * 调用方按"这轮没拿到"处理,会话照旧显示短 id、归「未归类」。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export interface KimiConversation {
  /** 生成好的标题;`title_status` 不是 generated 时缺席。 */
  title?: string
  /** `workspace_path`,交给项目归属解析;空/NULL 时缺席。 */
  cwd?: string
  /**
   * `kernel_records_path`:这条会话的记录文件(wire.jsonl),读「最近在做什么」用(2026-09-25,卡 P)。
   * 老版本库没有这一列 → 缺席(单独查、查不到不影响标题与归属)。
   */
  records?: string
}

/** 一次性只读句柄:读完就关。 */
export interface KimiSqliteHandle {
  all: (sql: string) => Array<Record<string, unknown>>
  close: () => void
}

export interface KimiConversationIo {
  fileExists: (path: string) => boolean
  /** `wal`:readOnly 直开;`immutable`:URI + immutable=1,不产生 -wal/-shm。抛错即"这轮没读到"。 */
  openReadOnly: (path: string, mode: 'wal' | 'immutable') => KimiSqliteHandle
}

export interface KimiConversationReaderOptions {
  dbPath: string
  /** 限频窗,默认 30 秒(kimiSessionFeed 60 秒一轮,每轮至多开一次库)。 */
  minIntervalMs?: number
  /** 当前毫秒。 */
  now?: () => number
  io?: KimiConversationIo
}

export interface KimiConversationReader {
  /** conversation_key → 标题/工作区。库缺席、版本不对、读坏 → undefined。 */
  lookup: () => ReadonlyMap<string, KimiConversation> | undefined
}

const SUPPORTED_SCHEMA_VERSION = '1'

function toUri(path: string): string {
  // 真路径带空格(Application Support),按段编码;SQLite 自己解 %XX。
  return `file:${path.split('/').map(segment => encodeURIComponent(segment)).join('/')}?immutable=1`
}

export const defaultKimiConversationIo: KimiConversationIo = {
  fileExists: existsSync,
  openReadOnly(path, mode) {
    const db = mode === 'wal'
      ? new DatabaseSync(path, { readOnly: true })
      : new DatabaseSync(toUri(path), { readOnly: true })
    return {
      all: sql => db.prepare(sql).all() as Array<Record<string, unknown>>,
      close: () => db.close(),
    }
  },
}

function readOnce(dbPath: string, io: KimiConversationIo): ReadonlyMap<string, KimiConversation> | undefined {
  if (!io.fileExists(dbPath)) return undefined
  const mode = io.fileExists(`${dbPath}-wal`) ? 'wal' : 'immutable'
  let handle: KimiSqliteHandle
  try {
    handle = io.openReadOnly(dbPath, mode)
  }
  catch {
    return undefined
  }
  try {
    const meta = handle.all(`SELECT value FROM schema_metadata WHERE key = 'schema_version'`)
    if (meta[0]?.value !== SUPPORTED_SCHEMA_VERSION) return undefined

    const rows = handle.all('SELECT conversation_key, title, title_status, workspace_path FROM conversations')
    const map = new Map<string, KimiConversation>()
    for (const row of rows) {
      const key = row.conversation_key
      if (typeof key !== 'string' || key === '') continue
      const info: KimiConversation = {}
      const title = row.title
      if (row.title_status === 'generated' && typeof title === 'string' && title.trim() !== '') info.title = title
      const cwd = row.workspace_path
      if (typeof cwd === 'string' && cwd.trim() !== '') info.cwd = cwd
      map.set(key, info)
    }
    // 记录文件那一列单独查:老版本库没有这一列,查不到不能连标题与归属一起丢。
    try {
      for (const row of handle.all('SELECT conversation_key, kernel_records_path FROM conversations')) {
        const key = row.conversation_key
        const records = row.kernel_records_path
        if (typeof key !== 'string' || typeof records !== 'string' || records.trim() === '') continue
        const info = map.get(key)
        if (info !== undefined) info.records = records
      }
    }
    catch {
      // 这一版库没有记录文件那一列:「在做什么」读不到,标题与归属照旧。
    }
    return map
  }
  catch {
    return undefined
  }
  finally {
    try {
      handle.close()
    }
    catch {
      // 关不上也不影响这轮结果。
    }
  }
}

export function createKimiConversationReader(options: KimiConversationReaderOptions): KimiConversationReader {
  const minIntervalMs = options.minIntervalMs ?? 30_000
  const now = options.now ?? (() => Date.now())
  const io = options.io ?? defaultKimiConversationIo
  let cached: { at: number, value: ReadonlyMap<string, KimiConversation> | undefined } | undefined

  return {
    lookup() {
      const at = now()
      if (cached !== undefined && at - cached.at < minIntervalMs) return cached.value
      const value = readOnce(options.dbPath, io)
      cached = { at, value }
      return value
    },
  }
}

/** 默认库路径:~/Library/Application Support/kimi-desktop/daimon-share/daimon/agents/main/sessions/hosted-logical/conversations.sqlite。 */
export function defaultKimiConversationsDb(home: string): string {
  return join(
    home, 'Library', 'Application Support', 'kimi-desktop',
    'daimon-share', 'daimon', 'agents', 'main', 'sessions', 'hosted-logical', 'conversations.sqlite',
  )
}
