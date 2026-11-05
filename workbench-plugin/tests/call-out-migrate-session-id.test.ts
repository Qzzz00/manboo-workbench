// @vitest-environment node
/**
 * ★ **座机台账里那些老的会话事项 id 迁一次**(2026-10-03,卡「两条接缝」;
 * 决策记录 10-03 早 ⑦ 第二条;审计第二表第 15 条)。
 *
 * 夹具是**真实形状**的 `~/.dsh/workbench/call-out.json`(`emptyCallOutFile` 的四格 +
 * 真台账里那种 `queued` 行 + `merged` 并进来的那几条),外加卡里点名要的三种:
 * 「已经迁过」「空文件」「坏行」。守:
 * ① 认得出家的那几行改成 `session:<家>/<会话 id>`(窗口型那种自带冒号的会话 id 照旧拆得对);
 * ② 认不出家的**原样留着**,数出来有几行(D13:查不到不等于可以猜一个家名);
 * ③ 幂等:同一份再跑一遍一个字不动;文件里那个标记挡住第二遍;
 * ④ 先备份到 `*.bak-<日期>`,同一天跑两次不覆盖最早那份原文;
 * ⑤ 读不出来 / 不在 / 已经迁过:三句话各不相同,**一个字节都不写**;
 * ⑥ 迁完的台账 `loadCallOutFile` 读得回来,新的 id 一字不差,标记保得住(下次保存不会抹掉它)。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { emptyCallOutFile, loadCallOutFile, saveCallOutFile } from '../src/server/callOut.ts'
import {
  CALL_OUT_MIGRATION_SESSION_JOB_ID,
  migrateCallOutSessionIds,
  runCallOutSessionIdMigration,
  sessionFamilyMap,
} from '../src/server/callOutMigrate.ts'
import { sessionJobId } from '../src/server/jobKey.ts'

const TODAY = '2026-10-03'
const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true }) })

function dir(): string {
  const made = mkdtempSync(join(tmpdir(), 'wb-callout-migrate-'))
  dirs.push(made)
  return made
}

/** 真台账里那种一行(2026-09-28 卡 WQ 之后 `call-out.json` 的形状)。 */
function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'c-1',
    key: 'ask:session:d777:2026-10-02T11:00:00.000Z',
    reason: 'ask',
    item_id: 'session:d777',
    title: 'Claude 在等你选:今天的模型额度只剩 0.58 元',
    note: '选项:加额度 / 先停',
    at: '2026-10-02T11:00:00.000Z',
    state: 'queued',
    silent: false,
    queued_at: '2026-10-02T11:00:01.000Z',
    due_at: '2026-10-02T11:00:01.000Z',
    ...over,
  }
}

/** 真实形状的一份:两行老格式(一行认得出家、一行认不出)+ 一行已经是新格式 + merged 两条。 */
function realFile(): Record<string, unknown> {
  return {
    ...emptyCallOutFile(),
    seen: ['ask:session:d777:2026-10-02T11:00:00.000Z', 'confirm:t-export'],
    log: [
      row(),
      // 窗口型那一条:会话 id 自己带冒号(豆包办公那扇窗) —— 冒号那一版正是在这里拆错的。
      row({ id: 'c-2', item_id: 'session:window:825f1900', title: '豆包办公 在等你点头:要不要发出去?' }),
      // 从来没上过任何一张卡的那一条:家名认不出来。
      row({ id: 'c-3', item_id: 'session:ghost-9', title: '某一家在等你' }),
      // 已经是新格式的那一行(迁过一半的情形):一个字都不该动。
      row({ id: 'c-4', item_id: sessionJobId('codex', 'c-777') }),
      // 「一通并了几件」那种:merged 里也是事项 id。
      row({
        id: 'c-5',
        item_id: 'session:d778',
        merged: [{ item_id: 'session:d779', title: '另一问' }, { item_id: 't-export', title: '导出 PDF' }],
      }),
    ],
  }
}

/** 看板上那几张卡(落了盘的证据:卡认下的那条对话、挂着的那几条、事务官那条)。 */
const BOARD = [
  { client_dispatch: { family: 'claude', session_id: 'd777' } },
  { links: [{ agent: 'doubao', session_id: 'window:825f1900' }] },
  { conversation: { agent: 'dsh', session_id: 'd778' } },
  { links: [{ agent: 'codex', session_id: 'd779' }] },
]
const familyOf = (sessionId: string): string | undefined => sessionFamilyMap(BOARD).get(sessionId)

describe('纯函数那一半', () => {
  it('★ 认得出家的改成一种格式(窗口型那种自带冒号的也拆得对);认不出的原样留着并数出来', () => {
    const out = migrateCallOutSessionIds({ file: realFile(), familyOf })
    const log = out.file.log as Record<string, unknown>[]
    expect(log[0]?.item_id).toBe('session:claude/d777')
    expect(log[1]?.item_id).toBe('session:doubao/window:825f1900')
    // ★ 认不出是哪一家 → 不猜,原样。
    expect(log[2]?.item_id).toBe('session:ghost-9')
    // 已经是新格式的那一行一个字没动。
    expect(log[3]?.item_id).toBe('session:codex/c-777')
    expect(log[4]?.item_id).toBe('session:dsh/d778')
    expect(log[4]?.merged).toEqual([
      { item_id: 'session:codex/d779', title: '另一问' },
      // 事项 id(不是会话键)一个字都不碰。
      { item_id: 't-export', title: '导出 PDF' },
    ])
    expect({ changed: out.changed, unresolved: out.unresolved }).toEqual({ changed: 4, unresolved: 1 })
    // `seen` 里放的是事件 key(`ask:session:<会话 id>:<时刻>`),这张卡没动它 —— 原样。
    expect(out.file.seen).toEqual(['ask:session:d777:2026-10-02T11:00:00.000Z', 'confirm:t-export'])
    expect(out.file.migrated).toEqual([CALL_OUT_MIGRATION_SESSION_JOB_ID])
  })

  it('★ 幂等:迁过的那一份再跑一遍一个字不动', () => {
    const once = migrateCallOutSessionIds({ file: realFile(), familyOf })
    const twice = migrateCallOutSessionIds({ file: once.file, familyOf })
    expect(twice.file).toEqual(once.file)
    expect({ changed: twice.changed, unresolved: twice.unresolved }).toEqual({ changed: 0, unresolved: 1 })
  })

  it('★ 空文件:四格原样,只多一个标记', () => {
    const out = migrateCallOutSessionIds({ file: { ...emptyCallOutFile() }, familyOf })
    expect(out.changed).toBe(0)
    expect(out.file.log).toEqual([])
    expect(out.file.migrated).toEqual([CALL_OUT_MIGRATION_SESSION_JOB_ID])
  })

  it('★ 坏行:原样留着(读台账那一处自己会丢掉它),别的行照迁', () => {
    const broken = { ...emptyCallOutFile(), log: [null, '一串字', { id: 'c-x' }, row()] as unknown[] }
    const out = migrateCallOutSessionIds({ file: broken, familyOf })
    const log = out.file.log as unknown[]
    expect(log[0]).toBeNull()
    expect(log[1]).toBe('一串字')
    expect(log[2]).toEqual({ id: 'c-x' })
    expect((log[3] as Record<string, unknown>).item_id).toBe('session:claude/d777')
    expect(out.changed).toBe(1)
  })

  it('★ 家名只认落了盘的证据;一条会话被两张卡记成两家时取先遇到的那一条', () => {
    const map = sessionFamilyMap([
      { client_dispatch: { family: 'claude', session_id: 'd1' } },
      { client_dispatch: { family: 'codex', session_id: 'd1' } },
      // 没有会话 id / 没有家名的那几格一条都不进。
      { client_dispatch: { family: 'kimi' } },
      { links: [{ session_id: 'd2' }, { agent: '   ', session_id: 'd3' }] },
    ])
    expect(map.get('d1')).toBe('claude')
    expect(map.has('d2')).toBe(false)
    expect(map.has('d3')).toBe(false)
  })
})

describe('启动时那一下', () => {
  it('★ 先备份再改;迁完的那一份 loadCallOutFile 读得回来,标记保得住', async () => {
    const home = dir()
    const path = join(home, 'call-out.json')
    writeFileSync(path, `${JSON.stringify(realFile(), null, 2)}\n`)
    const before = readFileSync(path, 'utf8')
    const run = await runCallOutSessionIdMigration({
      path,
      today: TODAY,
      familyOf,
      write: async (at, text) => { await writeFile(at, text, 'utf8') },
    })
    expect(run.ran).toBe(true)
    expect(run.changed).toBe(4)
    expect(run.unresolved).toBe(1)
    expect(run.note).toContain(`call-out.json.bak-${TODAY}`)
    // 备份就是**改之前那一份原文**。
    expect(readFileSync(`${path}.bak-${TODAY}`, 'utf8')).toBe(before)
    const loaded = await loadCallOutFile(path)
    expect(loaded.log.map(one => one.item_id)).toEqual([
      'session:claude/d777', 'session:doubao/window:825f1900', 'session:ghost-9', 'session:codex/c-777', 'session:dsh/d778',
    ])
    expect(loaded.migrated).toEqual([CALL_OUT_MIGRATION_SESSION_JOB_ID])
    // ★ 下一次保存不会把标记抹掉 —— 不然每次启动都要迁一遍。
    await saveCallOutFile(path, loaded)
    expect((await loadCallOutFile(path)).migrated).toEqual([CALL_OUT_MIGRATION_SESSION_JOB_ID])
  })

  it('★ 已经迁过 / 文件不在 / 读不出来:三句话各不相同,一个字节都不写', async () => {
    const home = dir()
    const path = join(home, 'call-out.json')
    const writes: string[] = []
    const write = async (at: string): Promise<void> => { writes.push(at) }

    const missing = await runCallOutSessionIdMigration({ path, today: TODAY, familyOf, write })
    expect(missing).toMatchObject({ ran: false })
    expect(missing.note).toContain('还没有这个文件')

    writeFileSync(path, '{ 这不是 JSON')
    const broken = await runCallOutSessionIdMigration({ path, today: TODAY, familyOf, write })
    expect(broken).toMatchObject({ ran: false })
    expect(broken.note).toContain('读不出来')

    writeFileSync(path, JSON.stringify({ ...emptyCallOutFile(), migrated: [CALL_OUT_MIGRATION_SESSION_JOB_ID] }))
    const already = await runCallOutSessionIdMigration({ path, today: TODAY, familyOf, write })
    expect(already).toMatchObject({ ran: false })
    expect(already.note).toContain('早就迁过了')

    expect(writes).toEqual([])
  })

  it('★ 同一天跑两次:最早那份原文不被覆盖', async () => {
    const home = dir()
    const path = join(home, 'call-out.json')
    writeFileSync(path, `${JSON.stringify(realFile(), null, 2)}\n`)
    const original = readFileSync(path, 'utf8')
    const write = async (at: string, text: string): Promise<void> => { await writeFile(at, text, 'utf8') }
    await runCallOutSessionIdMigration({ path, today: TODAY, familyOf, write })
    // 标记去掉、再跑一遍(模拟「同一天里文件又被换过一版」)。
    const second = { ...JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown> }
    delete second.migrated
    writeFileSync(path, `${JSON.stringify(second, null, 2)}\n`)
    await runCallOutSessionIdMigration({ path, today: TODAY, familyOf, write })
    expect(readFileSync(`${path}.bak-${TODAY}`, 'utf8')).toBe(original)
  })

  it('★ 备份不成就什么都不动(原文一个字节不改)', async () => {
    const home = dir()
    const path = join(home, 'call-out.json')
    const text = `${JSON.stringify(realFile(), null, 2)}\n`
    writeFileSync(path, text)
    const run = await runCallOutSessionIdMigration({
      path,
      today: TODAY,
      familyOf,
      write: async () => { throw new Error('不该走到这一步') },
      backup: async () => { throw new Error('磁盘满了') },
    })
    expect(run.ran).toBe(false)
    expect(run.note).toContain('备份不成')
    expect(readFileSync(path, 'utf8')).toBe(text)
  })
})
