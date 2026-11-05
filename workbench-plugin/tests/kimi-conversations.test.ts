// @vitest-environment node
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createKimiConversationReader,
  defaultKimiConversationsDb,
  type KimiConversationIo,
} from '../src/server/kimiConversations.ts'

const KEY_A = 'agent:main:main:conversation:a13f32e4-2696-4fe9-81e7-172158e8f21e'
const KEY_B = 'agent:main:main:conversation:1897193f-2629-4b64-bfb6-3e7eac88bcd6'
const KEY_C = 'agent:main:main:conversation:966a2674-a16e-4019-9fee-4fdb7aff4372'

/** 与真库(daimon 0.5.65,2026-09-09 真机 `sqlite_master`)同构的最小子集:STRICT、同名同约束。 */
const SCHEMA = `
CREATE TABLE schema_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE conversations (
  agent_id TEXT NOT NULL,
  conversation_key TEXT NOT NULL,
  session_key TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  origin TEXT NOT NULL,
  workspace_path TEXT,
  title TEXT NOT NULL,
  title_status TEXT NOT NULL,
  created_at TEXT NOT NULL, created_at_ms INTEGER NOT NULL,
  updated_at TEXT NOT NULL, updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (agent_id, conversation_key)
) STRICT;
`

interface Row { key: string, title: string, titleStatus: string, workspace: string | null }

const cleanups: Array<() => void> = []
afterEach(() => { while (cleanups.length > 0) cleanups.pop()!() })

/** 目录名故意带空格:真路径是 `Application Support`,URI 那条路必须扛得住。 */
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kimi conv-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
  return dir
}

/**
 * 造一份库。`keepOpen` 模拟 Kimi.app 运行中:daimon 的写连接一直开着、WAL 从不 checkpoint,
 * `-wal`/`-shm` 常驻;关掉写连接则 better-sqlite3/node:sqlite 都会 checkpoint 并删掉这两个文件。
 */
function makeDb(dir: string, rows: Row[], options: { schemaVersion?: string, keepOpen?: boolean, noMetadata?: boolean } = {}): { path: string, writer: DatabaseSync } {
  const path = join(dir, 'conversations.sqlite')
  const writer = new DatabaseSync(path)
  writer.exec('PRAGMA journal_mode = WAL;')
  writer.exec(SCHEMA)
  if (options.noMetadata === true) writer.exec('DROP TABLE schema_metadata;')
  else writer.prepare('INSERT INTO schema_metadata VALUES (?, ?)').run('schema_version', options.schemaVersion ?? '1')
  const insert = writer.prepare(`INSERT INTO conversations
    (agent_id, conversation_key, session_key, conversation_id, origin, workspace_path, title, title_status,
     created_at, created_at_ms, updated_at, updated_at_ms)
    VALUES ('main', ?, 'agent:main:main', ?, 'client', ?, ?, ?, '2026-09-09T00:00:00Z', 0, '2026-09-09T00:00:00Z', 0)`)
  for (const row of rows) insert.run(row.key, row.key.split(':').pop()!, row.workspace, row.title, row.titleStatus)
  if (options.keepOpen === true) cleanups.push(() => { try { writer.close() } catch { /* 已关 */ } })
  else writer.close()
  return { path, writer }
}

const ROWS: Row[] = [
  { key: KEY_A, title: 'Aiboo项目梳理与可行性调研', titleStatus: 'generated', workspace: '/Users/example/Documents/GitHub/Echo/echo' },
  { key: KEY_B, title: '', titleStatus: 'pending', workspace: '/Users/example/Documents/GitHub/Echo/echo' },
  { key: KEY_C, title: '无工作区的纯问答', titleStatus: 'generated', workspace: null },
]

describe('createKimiConversationReader(daimon 的 conversations.sqlite 只读)', () => {
  it('默认库路径指向 Kimi 桌面版 daimon 的 hosted-logical 目录', () => {
    expect(defaultKimiConversationsDb('/Users/example')).toBe(
      '/Users/example/Library/Application Support/kimi-desktop/daimon-share/daimon/agents/main/sessions/hosted-logical/conversations.sqlite',
    )
  })

  it('★App 运行中(-wal 常驻):readOnly 打开能看到 WAL 里的行;标题只在 title_status=generated 时给;没工作区就没 cwd', () => {
    const dir = tempDir()
    const { path } = makeDb(dir, ROWS, { keepOpen: true })
    expect(existsSync(`${path}-wal`)).toBe(true)

    const reader = createKimiConversationReader({ dbPath: path })
    const map = reader.lookup()
    expect(map).toBeDefined()
    expect(map!.get(KEY_A)).toEqual({ title: 'Aiboo项目梳理与可行性调研', cwd: '/Users/example/Documents/GitHub/Echo/echo' })
    expect(map!.get(KEY_B)).toEqual({ cwd: '/Users/example/Documents/GitHub/Echo/echo' }) // 标题没生成好,不猜
    expect(map!.get(KEY_C)).toEqual({ title: '无工作区的纯问答' })
    // 读完不给 Kimi 目录添任何文件
    expect(readdirSync(dir).sort()).toEqual(['conversations.sqlite', 'conversations.sqlite-shm', 'conversations.sqlite-wal'])
  })

  it('★App 没开(-wal 不在):照样读得到,且读完目录里没多出 -wal/-shm(不碰 Kimi 的目录)', () => {
    const dir = tempDir()
    const { path } = makeDb(dir, ROWS)
    expect(readdirSync(dir)).toEqual(['conversations.sqlite'])

    const map = createKimiConversationReader({ dbPath: path }).lookup()
    expect(map?.get(KEY_A)?.title).toBe('Aiboo项目梳理与可行性调研')
    expect(readdirSync(dir)).toEqual(['conversations.sqlite'])
  })

  it('不持锁:读过之后 daimon 继续写,下一次读(过了限频窗)能看到新行', () => {
    const dir = tempDir()
    const { path, writer } = makeDb(dir, [ROWS[0]!], { keepOpen: true })
    let nowMs = 1_000_000
    const reader = createKimiConversationReader({ dbPath: path, minIntervalMs: 30_000, now: () => nowMs })
    expect(reader.lookup()?.size).toBe(1)

    writer.prepare(`INSERT INTO conversations
      (agent_id, conversation_key, session_key, conversation_id, origin, workspace_path, title, title_status,
       created_at, created_at_ms, updated_at, updated_at_ms)
      VALUES ('main', ?, 'agent:main:main', 'c', 'client', '/tmp/x', '新会话', 'generated', 'a', 0, 'a', 0)`).run(KEY_C)
    nowMs += 30_000
    expect(reader.lookup()?.get(KEY_C)).toEqual({ title: '新会话', cwd: '/tmp/x' })
  })

  it('★限频:窗内重复 lookup 只开一次库;窗过了才重开(请求驱动,不轮询)', () => {
    const dir = tempDir()
    const { path } = makeDb(dir, ROWS, { keepOpen: true })
    let nowMs = 5_000_000
    const opens: string[] = []
    const io: KimiConversationIo = {
      fileExists: existsSync,
      openReadOnly: (p, mode) => {
        opens.push(mode)
        const db = new DatabaseSync(p, { readOnly: true })
        return { all: sql => db.prepare(sql).all(), close: () => db.close() }
      },
    }
    const reader = createKimiConversationReader({ dbPath: path, minIntervalMs: 30_000, now: () => nowMs, io })
    reader.lookup()
    reader.lookup()
    nowMs += 29_999
    reader.lookup()
    expect(opens).toEqual(['wal'])
    nowMs += 1
    reader.lookup()
    expect(opens).toEqual(['wal', 'wal'])
  })

  it('打开方式二选一:-wal 在 → wal(readOnly);不在 → immutable', () => {
    const dir = tempDir()
    const { path } = makeDb(dir, ROWS)
    const opens: string[] = []
    const io: KimiConversationIo = {
      fileExists: existsSync,
      openReadOnly: (_p, mode) => { opens.push(mode); throw new Error('stub') },
    }
    createKimiConversationReader({ dbPath: path, minIntervalMs: 0, io }).lookup()
    expect(opens).toEqual(['immutable'])
  })

  it('库不存在 → undefined,不抛(没装桌面版 / 路径变了)', () => {
    const reader = createKimiConversationReader({ dbPath: join(tempDir(), 'missing.sqlite') })
    expect(reader.lookup()).toBeUndefined()
  })

  it('★schema_version 不是 1 → 整份 undefined(退回现状,不猜列名)', () => {
    const { path } = makeDb(tempDir(), ROWS, { schemaVersion: '2', keepOpen: true })
    expect(createKimiConversationReader({ dbPath: path }).lookup()).toBeUndefined()
  })

  it('schema_metadata 表都没有 → undefined,不抛', () => {
    const { path } = makeDb(tempDir(), ROWS, { noMetadata: true, keepOpen: true })
    expect(createKimiConversationReader({ dbPath: path }).lookup()).toBeUndefined()
  })

  it('不是 SQLite 的文件 → undefined,不抛', () => {
    const dir = tempDir()
    const path = join(dir, 'conversations.sqlite')
    writeFileSync(path, 'not a database')
    expect(createKimiConversationReader({ dbPath: path }).lookup()).toBeUndefined()
  })

  it('读失败也走限频缓存:窗内不反复开库', () => {
    const dir = tempDir()
    const path = join(dir, 'conversations.sqlite')
    let nowMs = 0
    const openReadOnly = vi.fn((): never => { throw new Error('busy') })
    const reader = createKimiConversationReader({
      dbPath: path, minIntervalMs: 30_000, now: () => nowMs,
      io: { fileExists: () => true, openReadOnly },
    })
    expect(reader.lookup()).toBeUndefined()
    expect(reader.lookup()).toBeUndefined()
    expect(openReadOnly).toHaveBeenCalledTimes(1)
    nowMs += 30_000
    reader.lookup()
    expect(openReadOnly).toHaveBeenCalledTimes(2)
  })
})

describe('记录文件那一列(2026-09-25,卡 P)', () => {
  it('有 kernel_records_path 就带上;老库没有这一列时标题与归属照旧(单独查、查不到不丢别的)', () => {
    const old = makeDb(tempDir(), ROWS, { keepOpen: true })
    const oldMap = createKimiConversationReader({ dbPath: old.path }).lookup()
    expect(oldMap?.get(KEY_A)).toEqual({ title: 'Aiboo项目梳理与可行性调研', cwd: '/Users/example/Documents/GitHub/Echo/echo' })

    const fresh = makeDb(tempDir(), ROWS, { keepOpen: true })
    fresh.writer.exec('ALTER TABLE conversations ADD COLUMN kernel_records_path TEXT')
    fresh.writer.prepare('UPDATE conversations SET kernel_records_path = ? WHERE conversation_key = ?').run('/k/wire.jsonl', KEY_A)
    const map = createKimiConversationReader({ dbPath: fresh.path }).lookup()
    expect(map?.get(KEY_A)).toEqual({ title: 'Aiboo项目梳理与可行性调研', cwd: '/Users/example/Documents/GitHub/Echo/echo', records: '/k/wire.jsonl' })
    expect(map?.get(KEY_C)?.records).toBeUndefined()
  })
})
