import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BEHAVIOR_DIR_NAME,
  BEHAVIOR_KEEP_DAYS,
  BEHAVIOR_SAID_MAX,
  BEHAVIOR_SEEN_GAP_MS,
  createBehaviorLog,
  behaviorEndOf,
  parseBehaviorQuery,
  questionPickOf,
  approvalNoteOf,
  taskMoveNoteOf,
  callSettledNoteOf,
} from '../src/server/behaviorLog.ts'

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-behavior-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function lines(file: string): Record<string, unknown>[] {
  return readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
}

describe('行为账:追加写、按月分文件', () => {
  it('一条一行,落在 <年-月>.jsonl', async () => {
    const dir = tempDir()
    const now = new Date(2026, 9, 9, 10, 30)
    const log = createBehaviorLog({ dir, now: () => now })
    log.record({ 端: '电脑', 事: '拍板', 对象: 'ask-1', 结果: '方案 B', 推荐: '方案 A' })
    log.record({ 端: '手机', 事: '说', 对象: '对话', 结果: '收到', 原话: '这个先放一放' })
    await log.flush()
    const rows = lines(join(dir, '2026-10.jsonl'))
    expect(rows).toHaveLength(2)
    expect(rows[0]).toEqual({ at: now.toISOString(), 端: '电脑', 事: '拍板', 对象: 'ask-1', 结果: '方案 B', 推荐: '方案 A' })
    expect(rows[1]).toMatchObject({ 端: '手机', 原话: '这个先放一放' })
    expect(rows[1]).not.toHaveProperty('推荐')
  })

  it('目录名是「行为账」', () => {
    expect(BEHAVIOR_DIR_NAME).toBe('行为账')
  })

  it('写失败不抛、不影响调用方', async () => {
    const dir = tempDir()
    // 把「目录」占成一个文件,mkdir / append 都会失败
    const blocked = join(dir, 'blocked')
    writeFileSync(blocked, 'x')
    const errors: string[] = []
    const log = createBehaviorLog({ dir: blocked, log: line => errors.push(line) })
    expect(() => log.record({ 端: '电脑', 事: '拍板', 对象: 'a', 结果: 'b' })).not.toThrow()
    await expect(log.flush()).resolves.toBeUndefined()
    expect(errors.length).toBeGreaterThan(0)
  })

  it('原话里的密钥形状擦掉、过长截断', async () => {
    const dir = tempDir()
    const log = createBehaviorLog({ dir, now: () => new Date(2026, 9, 9) })
    log.record({ 端: '电脑', 事: '说', 对象: '对话', 结果: '收到', 原话: `key 是 sk-abcdefghijklmnop ${'长'.repeat(BEHAVIOR_SAID_MAX + 50)}` })
    await log.flush()
    const [row] = lines(join(dir, '2026-10.jsonl'))
    expect(String(row!.原话)).not.toContain('sk-abcdefghijklmnop')
    expect(String(row!.原话).length).toBeLessThanOrEqual(BEHAVIOR_SAID_MAX + 1)
  })

  it('空原话不写这一格;端不认得的整条不记', async () => {
    const dir = tempDir()
    const log = createBehaviorLog({ dir, now: () => new Date(2026, 9, 9) })
    log.record({ 端: '电脑', 事: '说', 对象: '对话', 结果: '收到', 原话: '   ' })
    log.record({ 端: '平板' as never, 事: '说', 对象: '对话', 结果: '收到' })
    await log.flush()
    const rows = lines(join(dir, '2026-10.jsonl'))
    expect(rows).toHaveLength(1)
    expect(rows[0]).not.toHaveProperty('原话')
  })
})

describe('行为账:留 90 天,过期整月文件删掉', () => {
  it('整月都过了 90 天的文件删掉,还有一天在期内的留着', async () => {
    const dir = tempDir()
    mkdirSync(dir, { recursive: true })
    for (const month of ['2026-05', '2026-06', '2026-07', '2026-08']) writeFileSync(join(dir, `${month}.jsonl`), '')
    writeFileSync(join(dir, 'notes.txt'), '别人的文件不碰')
    // 10-09 往前 90 天是 07-11:6 月整月过期,7 月还有几天在期内
    const log = createBehaviorLog({ dir, now: () => new Date(2026, 9, 9, 12) })
    log.record({ 端: '电脑', 事: '露面', 对象: '工作台', 结果: '在' })
    await log.flush()
    expect(readdirSync(dir).sort()).toEqual(['2026-07.jsonl', '2026-08.jsonl', '2026-10.jsonl', 'notes.txt'])
    expect(BEHAVIOR_KEEP_DAYS).toBe(90)
  })

  it('读的时候也不给出 90 天以前的', async () => {
    const dir = tempDir()
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '2026-07.jsonl'), [
      JSON.stringify({ at: new Date(2026, 6, 1).toISOString(), 端: '电脑', 事: '拍板', 对象: 'old', 结果: 'x' }),
      JSON.stringify({ at: new Date(2026, 6, 20).toISOString(), 端: '电脑', 事: '拍板', 对象: 'new', 结果: 'x' }),
      '坏行',
    ].join('\n') + '\n')
    const log = createBehaviorLog({ dir, now: () => new Date(2026, 9, 9) })
    const rows = await log.read({})
    expect(rows.map(r => r.对象)).toEqual(['new'])
  })
})

describe('行为账:读', () => {
  it('按 since 与 事 筛,按时间先后', async () => {
    const dir = tempDir()
    let t = new Date(2026, 8, 30, 9).getTime()
    const log = createBehaviorLog({ dir, now: () => new Date(t) })
    log.record({ 端: '电脑', 事: '拍板', 对象: 'a', 结果: '1' })
    t = new Date(2026, 9, 2, 9).getTime()
    log.record({ 端: '手机', 事: '派活', 对象: 'b', 结果: 'codex', 推荐: 'claude' })
    t = new Date(2026, 9, 3, 9).getTime()
    log.record({ 端: '电脑', 事: '拍板', 对象: 'c', 结果: '2' })
    await log.flush()
    expect((await log.read({})).map(r => r.对象)).toEqual(['a', 'b', 'c'])
    expect((await log.read({ since: new Date(2026, 9, 1).toISOString() })).map(r => r.对象)).toEqual(['b', 'c'])
    expect((await log.read({ 事: '拍板' })).map(r => r.对象)).toEqual(['a', 'c'])
    expect((await log.read({ limit: 1 })).map(r => r.对象)).toEqual(['c'])
  })

  it('目录不在就是空账', async () => {
    const log = createBehaviorLog({ dir: join(tempDir(), 'nope') })
    expect(await log.read({})).toEqual([])
  })

  it('查询串解析:since 不是时间就 400', () => {
    expect(parseBehaviorQuery(new URLSearchParams('since=2026-10-01&事=拍板&limit=5'))).toEqual({
      ok: true, query: { since: new Date('2026-10-01').toISOString(), 事: '拍板', limit: 5 },
    })
    expect(parseBehaviorQuery(new URLSearchParams('since=hello')).ok).toBe(false)
    expect(parseBehaviorQuery(new URLSearchParams('')).ok).toBe(true)
  })
})

describe('行为账:露面', () => {
  it('同一端隔不到一刻钟不重记,换一端照记', async () => {
    const dir = tempDir()
    let t = new Date(2026, 9, 9, 8).getTime()
    const log = createBehaviorLog({ dir, now: () => new Date(t) })
    log.seen('电脑')
    t += 60_000
    log.seen('电脑')
    log.seen('手机')
    t += BEHAVIOR_SEEN_GAP_MS
    log.seen('电脑')
    await log.flush()
    const rows = lines(join(dir, '2026-10.jsonl'))
    expect(rows.map(r => `${r.端}${r.事}`)).toEqual(['电脑露面', '手机露面', '电脑露面'])
  })

  it('当天第一次那一下结果写「当天第一次」', async () => {
    const dir = tempDir()
    let t = new Date(2026, 9, 9, 23, 50).getTime()
    const log = createBehaviorLog({ dir, now: () => new Date(t) })
    log.seen('电脑')
    t = new Date(2026, 9, 10, 7, 5).getTime()
    log.seen('电脑')
    t += BEHAVIOR_SEEN_GAP_MS
    log.seen('电脑')
    await log.flush()
    const rows = lines(join(dir, '2026-10.jsonl'))
    expect(rows.map(r => r.结果)).toEqual(['当天第一次', '当天第一次', '在'])
  })
})

// 只读权限下的目录:mkdir 已在、append 失败
describe('行为账:目录只读', () => {
  it('不抛', async () => {
    const dir = tempDir()
    chmodSync(dir, 0o500)
    const log = createBehaviorLog({ dir, log: () => {} })
    log.record({ 端: '电脑', 事: '拍板', 对象: 'a', 结果: 'b' })
    await expect(log.flush()).resolves.toBeUndefined()
    chmodSync(dir, 0o700)
  })
})

describe('行为账:哪一端', () => {
  it('页面 / 壳 = 电脑;配对的手机 = 手机;座机话筒与电话工人 = 电话;事务官、别家、认不出的不记', () => {
    expect(behaviorEndOf({ asker: 'page' })).toBe('电脑')
    expect(behaviorEndOf({ asker: 'device', deviceKind: 'phone' })).toBe('手机')
    expect(behaviorEndOf({ asker: 'device', deviceKind: 'handset' })).toBe('电话')
    expect(behaviorEndOf({ asker: 'worker' })).toBe('电话')
    // 出门时手机的请求由工人在房间里代发:同时带着设备头和工人那把令牌 —— 认出了设备就按设备算
    expect(behaviorEndOf({ asker: 'worker', deviceKind: 'phone' })).toBe('手机')
    expect(behaviorEndOf({ asker: 'butler' })).toBeUndefined()
    expect(behaviorEndOf({ asker: 'unknown' })).toBeUndefined()
  })
})

describe('行为账:拍板那一问选了哪个、推荐的是哪个', () => {
  const questions = [{
    id: 'q1',
    question: '先做哪一版?',
    options: [{ label: '简版' }, { label: '完整版 (Recommended)' }, { label: '先不做' }],
  }]
  it('选的与推荐的都按原样的选项名', () => {
    expect(questionPickOf(questions, [{ id: 'q1', selected: ['简版'] }])).toEqual({
      对象: '先做哪一版?', 结果: '简版', 推荐: '完整版 (Recommended)',
    })
  })
  it('自己写的那句也算结果;没有推荐项就缺席', () => {
    const plain = [{ id: 'q1', question: '叫什么?', options: [{ label: 'A' }, { label: 'B' }] }]
    expect(questionPickOf(plain, [{ id: 'q1', selected: [], custom: '都不要' }])).toEqual({ 对象: '叫什么?', 结果: '自己写:都不要' })
  })
})

describe('行为账:等你确认那一条批没批', () => {
  it('派活那一种:事 = 派活,推荐 = 当时问的那一家', () => {
    const view = { session_id: 'dispatch:t1', tool: 'dispatch', say: '这张派给 Codex 开工?', options: [{ family: 'codex', title: 'Codex', chosen: true }, { family: 'claude', title: 'Claude' }] }
    expect(approvalNoteOf(view, true)).toEqual({ 事: '派活', 对象: '这张派给 Codex 开工?', 结果: '同意', 推荐: 'Codex' })
    expect(approvalNoteOf(view, false).结果).toBe('不同意')
  })
  it('别的:事 = 拍板', () => {
    expect(approvalNoteOf({ session_id: 's1', tool: 'Bash', reason: '要删 build 目录' }, true)).toEqual({ 事: '拍板', 对象: '要删 build 目录', 结果: '同意' })
  })
})

describe('行为账:看板上挪一格', () => {
  const card = { id: 't1', title: '导出 PDF', status: 'confirm' as const }
  it('等我确认 → 完成 = 通过;→ 在办 = 打回;→ 取消 = 取消', () => {
    expect(taskMoveNoteOf(card, 'done')).toEqual({ 事: '审', 对象: 't1 导出 PDF', 结果: '通过' })
    expect(taskMoveNoteOf(card, 'doing')?.结果).toBe('打回')
    expect(taskMoveNoteOf(card, 'canceled')?.结果).toBe('取消')
  })
  it('随口问的那张从办完拖回来 = 替她答的那个答案被她改掉', () => {
    expect(taskMoveNoteOf({ ...card, status: 'done', casual: true }, 'doing')).toEqual({ 事: '改替她答', 对象: 't1 导出 PDF', 结果: '拖回去重办' })
  })
  it('别的挪动不记', () => {
    expect(taskMoveNoteOf({ ...card, status: 'todo' }, 'doing')).toBeUndefined()
    expect(taskMoveNoteOf({ ...card, status: 'done' }, 'doing')).toBeUndefined()
  })
})

describe('行为账:事务官打来的那一通接没接', () => {
  const entry = { id: 'c1', reason: 'ask', title: '导出 PDF 等你选', state: 'answered', silent: false }
  it('接了 / 没接记在电话那一端;只发通知的、没打出去的不记', () => {
    expect(callSettledNoteOf(entry)).toEqual({ 端: '电话', 事: '来电', 对象: 'ask · 导出 PDF 等你选', 结果: '接了' })
    expect(callSettledNoteOf({ ...entry, state: 'missed' })?.结果).toBe('没接')
    expect(callSettledNoteOf({ ...entry, state: 'notified' })).toBeUndefined()
    expect(callSettledNoteOf({ ...entry, state: 'missed', silent: true })).toBeUndefined()
  })
})

describe('行为账:隔了多久才理', () => {
  it('带上那件事摆到她面前的时刻,记成隔了几分钟;时刻坏了就不写这一格', async () => {
    const dir = tempDir()
    const now = new Date(2026, 9, 9, 10, 0)
    const log = createBehaviorLog({ dir, now: () => now })
    log.record({ 端: '手机', 事: '拍板', 对象: 'a', 结果: 'x', 起: new Date(2026, 9, 9, 8, 30).toISOString() })
    log.record({ 端: '手机', 事: '拍板', 对象: 'b', 结果: 'x', 起: '坏的' })
    await log.flush()
    const rows = lines(join(dir, '2026-10.jsonl'))
    expect(rows[0]).toMatchObject({ 隔了: 90 })
    expect(rows[0]).not.toHaveProperty('起')
    expect(rows[1]).not.toHaveProperty('隔了')
  })
})
