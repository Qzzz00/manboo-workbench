// @vitest-environment node
/**
 * ★ **受保护的卡名来源**(2026-10-23,卡 A `t-0c770bc0`;需求 3.6「会话改名、事项名和目标名各有归属」)。
 *
 * 方向只有一条:**借源会话名的卡,随来源改名;用户手动改过卡名,从此不再覆盖**。
 * 与 211d2977d 那一条(没名字的会话借卡标题)方向相反、**两条都保留**:
 *   - 会话没名字 → 会话借卡的标题(老规矩,`withCardTitles`);
 *   - 卡名借自会话(placeSession 建卡时带了会话名,`title_from:'session'`)→ 会话改名,卡跟着改;
 *   - 用户改名(`/task/update` 带 title)→ `title_from:'custom'`,同步从此跳过这张。
 *
 * 防双向覆盖:卡名只由「服务端同步」这一个写口从会话名写(会话名非空且确实变了才写);
 * 会话名**从来不**从卡名落盘 —— `withCardTitles` 那个借名是视图层的变换,不落盘,构不成循环。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionView, TaskView } from '../src/protocol.ts'
import { createTasksService, type TasksService } from '../src/server/tasks.ts'
import { placeSession } from '../src/server/collabRoutes.ts'
import { syncBorrowedCardTitles, withCardTitles } from '../src/server/sessionTitleFallback.ts'

const NOW_S = Math.floor(Date.parse('2026-10-23T07:00:00.000Z') / 1000)

const dirs: string[] = []
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

function tempTasks(): { tasks: TasksService, ids: Generator<string> } {
  const dir = mkdtempSync(join(tmpdir(), 'wb-title-source-'))
  dirs.push(dir)
  let n = 0
  const ids = (): Generator<string> => (function* () { for (;;) yield `t-${++n}` })()
  const seq = ids()
  return { tasks: createTasksService({ file: join(dir, 'tasks.json'), now: () => NOW_S, newId: () => seq.next().value as string }), ids: seq }
}

function session(over: Partial<SessionView> = {}): SessionView {
  return { agent: 'codex', session_id: 'x-1', title: '梳理报告', ...over } as SessionView
}

describe('title_from:借名 / 自定 的落盘与读取', () => {
  it('建卡带 titleFrom → 落盘、重读还在', async () => {
    const { tasks } = tempTasks()
    const created = await tasks.create({ title: '梳理报告', titleFrom: 'session', source: { kind: 'session', ref: 'codex:x-1' }, links: [{ agent: 'codex', session_id: 'x-1' }] })
    expect(created.ok).toBe(true)
    const card = (await tasks.list()).tasks[0] as TaskView
    expect(card.title_from).toBe('session')
  })

  it('认不出的值挑掉这个字段(卡本身留着)', async () => {
    const { tasks } = tempTasks()
    await tasks.create({ title: '梳理报告' })
    // @ts-expect-error 用例故意写坏值,体检要把它挑掉
    await tasks.update((await tasks.list()).tasks[0]?.id as string, { titleFrom: 'borrowed' })
    expect(((await tasks.list()).tasks[0])?.title_from).toBeUndefined()
  })

  it('★/task/update 改标题 → title_from 变 custom(用户的手盖过来源)', async () => {
    const { tasks } = tempTasks()
    await tasks.create({ title: '梳理报告', titleFrom: 'session', source: { kind: 'session', ref: 'codex:x-1' } })
    const id = (await tasks.list()).tasks[0]?.id as string
    expect(await tasks.update(id, { title: '我自己的名字' })).toBe(true)
    const card = (await tasks.list()).tasks[0] as TaskView
    expect(card.title).toBe('我自己的名字')
    expect(card.title_from).toBe('custom')
  })

  it('内部同步那一档(titleFrom:session)不盖成 custom —— 不然同步一次就把自己焊死', async () => {
    const { tasks } = tempTasks()
    await tasks.create({ title: '梳理报告', titleFrom: 'session', source: { kind: 'session', ref: 'codex:x-1' } })
    const id = (await tasks.list()).tasks[0]?.id as string
    await tasks.update(id, { title: '梳理报告 v2', titleFrom: 'session' })
    expect(((await tasks.list()).tasks[0])?.title_from).toBe('session')
  })
})

describe('syncBorrowedCardTitles:借名的卡随来源改名', () => {
  it('★会话改名 → 跟着改;再改 → 再跟', async () => {
    const { tasks } = tempTasks()
    await placeSession(tasks, { agent: 'codex', sessionId: 'x-1', body: { title: '梳理报告' } })
    const id = (await tasks.list()).tasks[0]?.id as string
    expect(await syncBorrowedCardTitles(tasks, [session({ title: '梳理报告 v2' })])).toBe(1)
    expect(((await tasks.list()).tasks[0])?.title).toBe('梳理报告 v2')
    expect(await syncBorrowedCardTitles(tasks, [session({ title: '梳理报告 v3' })])).toBe(1)
    expect(((await tasks.list()).tasks[0])?.title).toBe('梳理报告 v3')
    // 事项 ID 稳定:跟名不换卡。
    expect(((await tasks.list()).tasks[0])?.id).toBe(id)
  })

  it('★用户改过的卡(custom)不再被来源覆盖', async () => {
    const { tasks } = tempTasks()
    await placeSession(tasks, { agent: 'codex', sessionId: 'x-1', body: { title: '梳理报告' } })
    const id = (await tasks.list()).tasks[0]?.id as string
    await tasks.update(id, { title: '我自己的名字' })
    expect(await syncBorrowedCardTitles(tasks, [session({ title: '梳理报告 v2' })])).toBe(0)
    expect(((await tasks.list()).tasks[0])?.title).toBe('我自己的名字')
  })

  it('会话标题空着 → 不动(不拿卡名回填会话,那是另一条方向的老规矩)', async () => {
    const { tasks } = tempTasks()
    await placeSession(tasks, { agent: 'codex', sessionId: 'x-1', body: { title: '梳理报告' } })
    expect(await syncBorrowedCardTitles(tasks, [session({ title: '' })])).toBe(0)
    expect(((await tasks.list()).tasks[0])?.title).toBe('梳理报告')
  })

  it('标题没变 → 不写盘(0 次,幂等;每秒一拍拼 /state 不能变成每秒一写)', async () => {
    const { tasks } = tempTasks()
    await placeSession(tasks, { agent: 'codex', sessionId: 'x-1', body: { title: '梳理报告' } })
    expect(await syncBorrowedCardTitles(tasks, [session()])).toBe(0)
  })

  it('★手改名先落盘,迟到的借名同步在同一个写事务里被拦下(不得盖回来源名;2026-10-23 复审 Important 4)', async () => {
    const { tasks } = tempTasks()
    await placeSession(tasks, { agent: 'codex', sessionId: 'x-1', body: { title: '梳理报告' } })
    const id = (await tasks.list()).tasks[0]?.id as string
    // 用户的手先到:改成 custom。
    expect(await tasks.update(id, { title: '我自己的名字' })).toBe(true)
    // 迟到的同步(拿着旧快照,还以为这张卡 title_from:'session'):同一写事务复核 → 不覆盖。
    expect(await tasks.update(id, { title: '梳理报告 v2', titleFrom: 'session', titleSyncFrom: 'codex:x-1' })).toBe(true)
    const card = (await tasks.list()).tasks[0] as TaskView
    expect(card.title).toBe('我自己的名字')
    expect(card.title_from).toBe('custom')
    // 对照:卡仍借名、来源未变时,同步照常生效(这一档没被误伤)。
    const { tasks: other } = tempTasks()
    await placeSession(other, { agent: 'codex', sessionId: 'x-1', body: { title: '梳理报告' } })
    const otherId = (await other.list()).tasks[0]?.id as string
    expect(await other.update(otherId, { title: '梳理报告 v2', titleFrom: 'session', titleSyncFrom: 'codex:x-1' })).toBe(true)
    expect(((await other.list()).tasks[0])?.title).toBe('梳理报告 v2')
  })

  it('来源对不上的卡(不是从会话借的名)不跟着动', async () => {
    const { tasks } = tempTasks()
    await tasks.create({ title: '我自己起的', source: { kind: 'manual' } })
    await tasks.create({ title: '借来的', titleFrom: 'session', source: { kind: 'session', ref: 'codex:x-1' } })
    expect(await syncBorrowedCardTitles(tasks, [session({ title: '新名字' })])).toBe(1)
    const cards = (await tasks.list()).tasks
    expect(cards.find(one => one.title === '我自己起的')?.title).toBe('我自己起的')
    expect(cards.find(one => one.source.ref === 'codex:x-1')?.title).toBe('新名字')
  })
})

describe('placeSession:建卡时把来源记在卡上', () => {
  it('带了会话名建的卡 → title_from:session(借名,随来源)', async () => {
    const { tasks } = tempTasks()
    const placed = await placeSession(tasks, { agent: 'codex', sessionId: 'x-1', body: { title: '梳理报告' } })
    expect(placed.ok).toBe(true)
    const card = (await tasks.list()).tasks[0] as TaskView
    expect(card.title_from).toBe('session')
  })

  it('没带名(空标题会话)→ 不借名(会话以后借卡名,211d 那一条照旧)', async () => {
    const { tasks } = tempTasks()
    await placeSession(tasks, { agent: 'codex', sessionId: 'x-1', body: {} })
    expect(((await tasks.list()).tasks[0])?.title_from).toBeUndefined()
  })

  it('已经有卡连着这条会话 → 原样回,不重新借名', async () => {
    const { tasks } = tempTasks()
    await placeSession(tasks, { agent: 'codex', sessionId: 'x-1', body: { title: '梳理报告' } })
    const again = await placeSession(tasks, { agent: 'codex', sessionId: 'x-1', body: { title: '另一个名' } })
    expect(again).toMatchObject({ ok: true, already: true })
    expect((await tasks.list()).tasks).toHaveLength(1)
  })
})

describe('两条方向相反的借名并存,互不覆盖', () => {
  it('会话没名字照旧借卡名;卡名借自会话时,这个借名是视图变换、不落盘', async () => {
    const { tasks } = tempTasks()
    // 空标题会话挂进来:卡不借名(标题是「codex 的会话」),以后会话借卡名 —— 211d 那一条。
    await placeSession(tasks, { agent: 'codex', sessionId: 'y-2', body: {} })
    // 用户给卡起了名。
    const id = (await tasks.list()).tasks[0]?.id as string
    await tasks.update(id, { title: '我自己的名字' })
    // 没名字的会话 y-2 借到卡名(视图层);卡上的名没动。
    const titled = withCardTitles([session({ session_id: 'y-2', title: '' })], (await tasks.list()).tasks)
    expect(titled.find(one => one.session_id === 'y-2')?.title).toBe('我自己的名字')
    expect(((await tasks.list()).tasks[0])?.title).toBe('我自己的名字')
    // 它自己有了名,就用自己的,不再借。
    const own = withCardTitles([session({ session_id: 'y-2', title: '梳理报告' })], (await tasks.list()).tasks)
    expect(own.find(one => one.session_id === 'y-2')?.title).toBe('梳理报告')
  })
})
