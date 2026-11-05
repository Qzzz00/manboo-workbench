// @vitest-environment node
/**
 * **千问办公在跑 / 做完以它自己的对话库为准**(2026-10-08 真机)。
 *
 * 它被窗口槽藏起来后辅助功能树不刷新,读屏读到的是藏起那一刻(「规划中 ... 13.7s」挂着不动)。
 * 它的 `agents.db` 里记着每条对话(`chats`)与每一句(`messages`,回答那一行 `metadata.status`
 * 出字时是 streaming、出完 completed、她停掉 cancelled)。夹具的表结构照本机那份(只留用到的列)。
 */
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { QWENWORK_STALL_MS, latestLine, readQwenWorkRecords, readQwenWorkReply } from '../src/server/qwenWorkRecords.ts'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

const NOW = Date.parse('2026-10-08T12:01:00Z')
const sec = (ms: number): number => Math.floor(ms / 1000)

interface Msg {
  role: 'user' | 'assistant'
  at: number
  moved?: number
  status?: string
  /** 她那句话(user)/ 回答最后那一块字(assistant)。 */
  text?: string
  /** 回答里排在工具调用前面的那一块字(「我先搜一下」那种)。 */
  before?: string
}
interface Chat { id: string, name: string, msgs: Msg[], archived?: boolean, deleted?: boolean }

function makeDb(chats: Chat[], opts: { wal?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'qwenwork-'))
  dirs.push(dir)
  const path = join(dir, 'agents.db')
  const db = new DatabaseSync(path)
  db.exec(`CREATE TABLE chats (id text PRIMARY KEY NOT NULL, name text, project_id text NOT NULL, created_at integer, updated_at integer, archived_at integer, deleted_at integer)`)
  db.exec(`CREATE TABLE sub_chats (id text PRIMARY KEY NOT NULL, name text, chat_id text NOT NULL, created_at integer, updated_at integer, stream_id text)`)
  db.exec(`CREATE TABLE messages (id text PRIMARY KEY NOT NULL, message_id text NOT NULL, chat_id text NOT NULL, sub_chat_id text NOT NULL, sequence integer NOT NULL, role text NOT NULL, parts text DEFAULT '[]' NOT NULL, metadata text DEFAULT '{}' NOT NULL, created_at integer, updated_at integer)`)
  for (const chat of chats) {
    const first = chat.msgs[0]?.at ?? NOW
    const lastMoved = Math.max(...chat.msgs.map(m => m.moved ?? m.at), first)
    db.prepare('INSERT INTO chats VALUES (?, ?, ?, ?, ?, ?, ?)').run(chat.id, chat.name, 'p', sec(first), sec(lastMoved), chat.archived === true ? sec(NOW) : null, chat.deleted === true ? sec(NOW) : null)
    db.prepare('INSERT INTO sub_chats VALUES (?, ?, ?, ?, ?, ?)').run(`${chat.id}-s`, chat.name, chat.id, sec(first), sec(first), null)
    chat.msgs.forEach((m, i) => {
      const parts = m.role === 'assistant'
        ? [
            ...(m.before === undefined ? [] : [{ type: 'text', id: 'b', text: m.before }]),
            { type: 'tool-Thinking', toolCallId: 't', input: {}, output: '想一想(这不是回答)' },
            ...(m.text === undefined ? [] : [{ type: 'text', id: 'x', text: m.text }]),
          ]
        : [{ type: 'text', text: m.text ?? '她说的话' }]
      const meta = m.role === 'assistant'
        ? { status: m.status ?? 'completed', ...(m.text === undefined ? {} : { finalTextId: 'x' }) }
        : { source: 'sdk-projection' }
      db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(`${chat.id}-${i}`, `${chat.id}-${i}`, chat.id, `${chat.id}-s`, i, m.role, JSON.stringify(parts), JSON.stringify(meta), sec(m.at), sec(m.moved ?? m.at))
    })
  }
  if (opts.wal === true) db.exec('PRAGMA journal_mode = WAL')
  db.close()
  return path
}

describe('千问办公的对话库 → 有哪些对话、在不在跑、最新一句', () => {
  it('★出字中(streaming、刚动过)= 在跑;completed = 做完,最新一句取回答里最后一块字的最后一行', () => {
    const path = makeDb([
      { id: 'a', name: '起草众筹发货邮件', msgs: [
        { role: 'user', at: NOW - 60_000 },
        { role: 'assistant', at: NOW - 59_000, moved: NOW - 2000, status: 'streaming', text: '正在整理' },
      ] },
      { id: 'b', name: '审阅会议逐字稿', msgs: [
        { role: 'user', at: NOW - 3_600_000 },
        { role: 'assistant', at: NOW - 3_590_000, moved: NOW - 3_500_000, status: 'completed', text: '## 结论\n\n- **第一点**\n\n逐字稿看完了,有三处要改。' },
      ] },
    ])
    const read = readQwenWorkRecords({ dbPath: path, nowMs: NOW })
    expect(read?.chats.map(c => [c.title, c.status, c.latest])).toEqual([
      ['起草众筹发货邮件', 'running', '正在整理'],
      ['审阅会议逐字稿', 'done', '逐字稿看完了,有三处要改。'],
    ])
    expect(read?.chats[0]?.finished_at).toBeUndefined()
    expect(read?.chats[1]?.finished_at).toBe(new Date(sec(NOW - 3_500_000) * 1000).toISOString())
    expect(read?.chats[0]?.started_at).toBe(new Date(sec(NOW - 60_000) * 1000).toISOString())
  })

  it('★中断的(还标着 streaming、却好几分钟没动)不算在跑 —— 本机 13:41 那条「总结一下」', () => {
    const path = makeDb([{ id: 'c', name: '总结一下', msgs: [
      { role: 'user', at: NOW - QWENWORK_STALL_MS - 60_000 },
      { role: 'assistant', at: NOW - QWENWORK_STALL_MS - 1000, status: 'streaming' },
    ] }])
    expect(readQwenWorkRecords({ dbPath: path, nowMs: NOW })?.chats[0]?.status).toBe('done')
  })

  it('她刚说了一句、回答那一行还没建 → 在跑;她停掉的(cancelled)→ 这一轮收了', () => {
    const path = makeDb([
      { id: 'd', name: '刚问', msgs: [{ role: 'user', at: NOW - 1000 }] },
      { id: 'e', name: '停掉了', msgs: [{ role: 'user', at: NOW - 30_000 }, { role: 'assistant', at: NOW - 29_000, moved: NOW - 20_000, status: 'cancelled' }] },
    ])
    const read = readQwenWorkRecords({ dbPath: path, nowMs: NOW })
    expect(read?.chats.find(c => c.id === 'd')?.status).toBe('running')
    expect(read?.chats.find(c => c.id === 'e')?.status).toBe('done')
  })

  it('归档的、删掉的不算;一句话都没有的空对话不算', () => {
    const path = makeDb([
      { id: 'f', name: '归档', archived: true, msgs: [{ role: 'user', at: NOW }] },
      { id: 'g', name: '删了', deleted: true, msgs: [{ role: 'user', at: NOW }] },
      { id: 'h', name: '空的', msgs: [] },
    ])
    expect(readQwenWorkRecords({ dbPath: path, nowMs: NOW })?.chats).toEqual([])
  })

  it('★状态出现没见过的字 → 整份回 undefined(退回读屏),不猜', () => {
    const path = makeDb([{ id: 'i', name: 'x', msgs: [{ role: 'user', at: NOW }, { role: 'assistant', at: NOW, status: 'waiting_approval' }] }])
    expect(readQwenWorkRecords({ dbPath: path, nowMs: NOW })).toBeUndefined()
  })

  it('没有库、库坏了、表的样子不对 → undefined,不抛', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qwenwork-')); dirs.push(dir)
    expect(readQwenWorkRecords({ dbPath: join(dir, 'agents.db'), nowMs: NOW })).toBeUndefined()
    writeFileSync(join(dir, 'agents.db'), 'not a database')
    expect(readQwenWorkRecords({ dbPath: join(dir, 'agents.db'), nowMs: NOW })).toBeUndefined()
    const odd = join(dir, 'odd.db')
    const db = new DatabaseSync(odd); db.exec('CREATE TABLE chats (id TEXT)'); db.close()
    expect(readQwenWorkRecords({ dbPath: odd, nowMs: NOW })).toBeUndefined()
  })

  it('★不给它的目录添文件(-wal 不在时 immutable 打开,不生 -shm)', () => {
    const path = makeDb([{ id: 'j', name: 'x', msgs: [{ role: 'user', at: NOW }] }])
    const dir = join(path, '..')
    const before = readdirSync(dir).sort()
    expect(readQwenWorkRecords({ dbPath: path, nowMs: NOW })?.chats.length).toBe(1)
    expect(readdirSync(dir).sort()).toEqual(before)
    expect(existsSync(`${path}-shm`)).toBe(false)
  })

  it('WAL 库照样读得到', () => {
    const path = makeDb([{ id: 'k', name: 'wal', msgs: [{ role: 'user', at: NOW - 600_000 }, { role: 'assistant', at: NOW - 599_000, text: '好了' }] }], { wal: true })
    expect(readQwenWorkRecords({ dbPath: path, nowMs: NOW })?.chats[0]?.latest).toBe('好了')
  })
})

describe('最新一句', () => {
  it('去掉 Markdown 记号与表格分隔线,太长截短', () => {
    expect(latestLine('| a | b |\n|---|---|')).toBe('| a | b |')
    expect(latestLine('1. **第一步**')).toBe('第一步')
    expect(latestLine('   \n\n')).toBeUndefined()
    expect([...(latestLine('字'.repeat(200)) ?? '')].length).toBe(121)
  })
})

describe('派活收回答:按送进去那句里的记号,在它库里找那一轮(2026-10-09)', () => {
  const MARK = '工作台派活 abc123'
  const said = `【${MARK}】帮我把发货邮件改短一点\n\n(规矩:先给结论)`

  it('★那一轮 completed → 回最后那一块字的全文(不截、不去记号;工具调用与前面那块「我先看看」都不要)', () => {
    const path = makeDb([{ id: 'a', name: '发货邮件', msgs: [
      { role: 'user', at: NOW - 120_000, text: said },
      { role: 'assistant', at: NOW - 119_000, moved: NOW - 60_000, status: 'completed', before: '我先看看原稿', text: '## 改好了\n\n- 第一段删掉客套\n- 结尾留联系方式' },
    ] }])
    expect(readQwenWorkReply({ dbPath: path, marker: MARK, nowMs: NOW })).toEqual({
      found: true, status: 'done', reply: '## 改好了\n\n- 第一段删掉客套\n- 结尾留联系方式',
    })
  })

  it('★那一轮还在 streaming、刚动过 → 在跑(不给半截);她刚送进去、回答行还没建 → 也是在跑', () => {
    const path = makeDb([
      { id: 'a', name: '发货邮件', msgs: [
        { role: 'user', at: NOW - 30_000, text: said },
        { role: 'assistant', at: NOW - 29_000, moved: NOW - 2000, status: 'streaming', text: '正在写' },
      ] },
      { id: 'b', name: '另一件', msgs: [{ role: 'user', at: NOW - 1000, text: '【工作台派活 zzz999】看一下' }] },
    ])
    expect(readQwenWorkReply({ dbPath: path, marker: MARK, nowMs: NOW })).toEqual({ found: true, status: 'running' })
    expect(readQwenWorkReply({ dbPath: path, marker: '工作台派活 zzz999', nowMs: NOW })).toEqual({ found: true, status: 'running' })
  })

  it('★只认我们那一轮:同一条对话里她后来又问了一句,回那一轮的回答,不回最后那一轮', () => {
    const path = makeDb([{ id: 'a', name: '发货邮件', msgs: [
      { role: 'user', at: NOW - 600_000, text: said },
      { role: 'assistant', at: NOW - 599_000, moved: NOW - 590_000, status: 'completed', text: '我们那一轮的答' },
      { role: 'user', at: NOW - 30_000, text: '她自己又问的' },
      { role: 'assistant', at: NOW - 29_000, moved: NOW - 1000, status: 'streaming', text: '她那一轮' },
    ] }])
    expect(readQwenWorkReply({ dbPath: path, marker: MARK, nowMs: NOW })).toEqual({ found: true, status: 'done', reply: '我们那一轮的答' })
  })

  it('她停掉的(cancelled)→ 这一轮收了,有字给字、标 stopped;中断的(streaming 却好几分钟没动)→ 收了,但半截字不当回答', () => {
    const path = makeDb([
      { id: 'a', name: '停掉', msgs: [
        { role: 'user', at: NOW - 60_000, text: said },
        { role: 'assistant', at: NOW - 59_000, moved: NOW - 50_000, status: 'cancelled', text: '写到一半' },
      ] },
      { id: 'b', name: '中断', msgs: [
        { role: 'user', at: NOW - QWENWORK_STALL_MS - 60_000, text: '【工作台派活 old000】x' },
        // 等她批准一个工具时多半也长这样(还没量清):前面那块「我先看看」不许当成回答交回去。
        { role: 'assistant', at: NOW - QWENWORK_STALL_MS - 50_000, status: 'streaming', before: '我先看看' },
      ] },
    ])
    expect(readQwenWorkReply({ dbPath: path, marker: MARK, nowMs: NOW })).toEqual({ found: true, status: 'done', reply: '写到一半', stopped: true })
    expect(readQwenWorkReply({ dbPath: path, marker: '工作台派活 old000', nowMs: NOW })).toEqual({ found: true, status: 'done', stopped: true })
  })

  it('库里还没有这一句 → found:false(调用方退回读窗口);记号太短不认', () => {
    const path = makeDb([{ id: 'a', name: 'x', msgs: [{ role: 'user', at: NOW, text: '别的话' }] }])
    expect(readQwenWorkReply({ dbPath: path, marker: MARK, nowMs: NOW })).toEqual({ found: false })
    expect(readQwenWorkReply({ dbPath: path, marker: '别的', nowMs: NOW })).toBeUndefined()
  })

  it('★没见过的状态、没有库、表不对 → undefined(退回读窗口),不抛;读完不给它的目录添文件', () => {
    const odd = makeDb([{ id: 'a', name: 'x', msgs: [{ role: 'user', at: NOW, text: said }, { role: 'assistant', at: NOW, status: 'waiting_approval' }] }])
    expect(readQwenWorkReply({ dbPath: odd, marker: MARK, nowMs: NOW })).toBeUndefined()
    const dir = mkdtempSync(join(tmpdir(), 'qwenwork-')); dirs.push(dir)
    expect(readQwenWorkReply({ dbPath: join(dir, 'agents.db'), marker: MARK, nowMs: NOW })).toBeUndefined()
    const path = makeDb([{ id: 'a', name: 'x', msgs: [{ role: 'user', at: NOW, text: said }] }])
    const before = readdirSync(join(path, '..')).sort()
    readQwenWorkReply({ dbPath: path, marker: MARK, nowMs: NOW })
    expect(readdirSync(join(path, '..')).sort()).toEqual(before)
  })

  it('归档 / 删掉的对话里的那一句不认', () => {
    const path = makeDb([{ id: 'a', name: 'x', deleted: true, msgs: [{ role: 'user', at: NOW, text: said }] }])
    expect(readQwenWorkReply({ dbPath: path, marker: MARK, nowMs: NOW })).toEqual({ found: false })
  })
})
