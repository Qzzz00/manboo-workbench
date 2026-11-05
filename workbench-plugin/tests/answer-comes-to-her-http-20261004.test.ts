// @vitest-environment node
/**
 * 卡 `claude/answer-comes-to-her`(2026-10-04,随 0.4.98)—— **接口那一层**。
 *
 * 纯函数那一层在 `answer-comes-to-her-20261004.test.ts`;这一份钉 8791 上真跑起来的那几条:
 *   - `/state.answers` / `/state.fresh_results` 两格真的发下去了(两端只显示的前提);
 *   - `POST /task/seen-result` 把那张卡从「刚办完」里收掉,**而状态还是 `done`**
 *     (它不是改状态那条路,2026-09-09 那张七态表一个字没动);
 *   - `POST /answers/seen` 认不出 id 时**如实回 404 + 原因**,不假装成功(D13);
 *   - **两端同步**:记的是服务端那一格,所以下一次 `GET /state` 两端拿到的是同一个结论。
 *
 * 做法与 `server-tasks-http.test.ts` 逐字同一套(临时 tasks.json、`port: 0`、收摊时关掉)。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkbenchServer } from '../src/server/http.ts'
import type { WorkbenchState } from '../src/protocol.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createTasksService } from '../src/server/tasks.ts'

const NOW_SEC = Math.floor(Date.parse('2026-10-04T18:00:00Z') / 1000)

const started: WorkbenchServer[] = []
const dirs: string[] = []

afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

async function post(url: string, path: string, body: unknown): Promise<{ status: number, body: Record<string, unknown> }> {
  const res = await fetch(`${url}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

async function serve(): Promise<{ url: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'wb-answer-http-'))
  dirs.push(dir)
  let n = 0
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService({ now: () => NOW_SEC }),
    tickIntervalMs: 0,
    tasks: createTasksService({ file: join(dir, 'tasks.json'), now: () => NOW_SEC, newId: () => `t-${++n}` }),
    // 家目录指到临时目录:那本回答账落在它底下,不碰真机的 `~/.dsh`。
    paths: { home: dir },
  } as never)
  started.push(server)
  return { url: server.url }
}

async function state(url: string): Promise<WorkbenchState> {
  return await (await fetch(`${url}/state`)).json() as WorkbenchState
}

describe('两格真的发下去了(两端只显示的前提)', () => {
  it('一张卡都没有时:`answers` 空、`fresh_results` 空 —— 两格在,不是缺席', async () => {
    const { url } = await serve()
    const snapshot = await state(url)
    expect(snapshot.answers).toEqual({ items: [], unseen: 0 })
    expect(snapshot.fresh_results).toEqual({ items: [] })
    // 球那一格的两个布尔在没有东西时**缺席**(additive,老客户端读不到即当无)。
    expect(snapshot.orb?.answer).toBeUndefined()
    expect(snapshot.orb?.fresh_result).toBeUndefined()
  })

  it('一张卡办完了 → 它在「刚办完」里,球那一格跟着立起来', async () => {
    const { url } = await serve()
    await post(url, '/task/create', { title: '加个导出 PDF', status: 'todo' })
    await post(url, '/task/move', { id: 't-1', status: 'doing' })
    await post(url, '/task/move', { id: 't-1', status: 'done' })

    const snapshot = await state(url)
    expect(snapshot.fresh_results?.items.map(one => one.task_id)).toEqual(['t-1'])
    expect(snapshot.orb?.fresh_result).toBe(true)
  })
})

describe('POST /task/seen-result', () => {
  it('★ 她看过了 → 从「刚办完」里收掉,**状态还是 done**(不是改状态那条路)', async () => {
    const { url } = await serve()
    await post(url, '/task/create', { title: '加个导出 PDF', status: 'todo' })
    await post(url, '/task/move', { id: 't-1', status: 'doing' })
    await post(url, '/task/move', { id: 't-1', status: 'done' })
    expect((await state(url)).fresh_results?.items).toHaveLength(1)

    const seen = await post(url, '/task/seen-result', { id: 't-1' })
    expect(seen.status).toBe(200)
    expect(seen.body).toMatchObject({ ok: true })

    /**
     * ★ **两端同步就在这一行**:记的是服务端那一格,所以下一次 `GET /state`
     * 不论谁来问,拿到的都是同一个结论(手机看过,电脑那一处也收)。
     */
    const after = await state(url)
    expect(after.fresh_results?.items).toEqual([])
    expect(after.orb?.fresh_result).toBeUndefined()
    const task = after.tasks?.tasks.find(one => one.id === 't-1')
    // 状态一个字没动;多的只是「她看过了」那一格。
    expect(task?.status).toBe('done')
    expect(task?.seen_result_at).toBe('2026-10-04T18:00:00.000Z')
  })

  it('★ 她把卡拖回「进行中」→ 那一格跟着擦掉(这件事又活了,下次办完照旧摆一次)', async () => {
    const { url } = await serve()
    await post(url, '/task/create', { title: '加个导出 PDF', status: 'todo' })
    await post(url, '/task/move', { id: 't-1', status: 'doing' })
    await post(url, '/task/move', { id: 't-1', status: 'done' })
    await post(url, '/task/seen-result', { id: 't-1' })
    await post(url, '/task/move', { id: 't-1', status: 'doing' })

    const task = (await state(url)).tasks?.tasks.find(one => one.id === 't-1')
    expect(task?.seen_result_at).toBeUndefined()
  })

  it('没有这张卡 → 404,如实说一句(不假装成功)', async () => {
    const { url } = await serve()
    const res = await post(url, '/task/seen-result', { id: 't-404' })
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('没有这张卡')
  })

  it('`/task/update` 不接这一格(它是事实的转述,不是给人编辑的)', async () => {
    const { url } = await serve()
    await post(url, '/task/create', { title: '加个导出 PDF', status: 'todo' })
    await post(url, '/task/update', { id: 't-1', seen_result_at: '2026-10-04T18:00:00.000Z' })
    expect((await state(url)).tasks?.tasks.find(one => one.id === 't-1')?.seen_result_at).toBeUndefined()
  })
})

describe('POST /answers/seen', () => {
  it('认不出那条 id → 404 + **说清为什么**(过期掉了 / 账重建过),不假装成功', async () => {
    const { url } = await serve()
    const res = await post(url, '/answers/seen', { id: 'a-404' })
    expect(res.status).toBe(404)
    expect(String(res.body.error)).toContain('不在账上了')
  })

  it('没带 id → 400,说清要带什么', async () => {
    const { url } = await serve()
    const res = await post(url, '/answers/seen', {})
    expect(res.status).toBe(400)
    expect(String(res.body.error)).toContain('id')
  })
})
