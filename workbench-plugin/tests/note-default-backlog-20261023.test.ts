// @vitest-environment node
/**
 * ★ **待排的卡不许被派出去**(2026-10-23,卡「待排的卡不许被派出去」③④)。
 *
 * ③ **新建便签缺省「待排」**(统筹定):`POST /task/create` 与界面新建不传 `status` 时落 `backlog`;
 *    显式传 `todo` 照旧;`/butler/item`(交办)2026-10-29 起进理解中枢 —— 落「待办」由中枢 note 命令的
 *    status 决定(用例里假模型照原语义回 todo),不再服务端写死。
 * ④ **会话记录回流建卡**:同一条会话记录(`from.ref = <家>:<会话 id>`)对应的卡被删过,就不再登;
 *    「删过」记一张小表落盘,重启后仍有效。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkbenchState } from '../src/protocol.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createTasksService } from '../src/server/tasks.ts'
import { placeSession } from '../src/server/collabRoutes.ts'

const NOW_SEC = Math.floor(Date.parse('2026-10-23T09:00:00Z') / 1000)

const started: WorkbenchServer[] = []
const dirs: string[] = []

afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-note-backlog-'))
  dirs.push(dir)
  return join(dir, 'tasks.json')
}

async function post(url: string, path: string, body: unknown) {
  const res = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

async function serve() {
  const file = tempFile()
  let n = 0
  const tasks = createTasksService({ file, now: () => NOW_SEC, newId: () => `t-${++n}` })
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService({ now: () => NOW_SEC }),
    tickIntervalMs: 0,
    tasks,
    // 2026-10-29 入口归一:/butler/item 进理解中枢 —— 假模型按原语义回一条 note(todo)。
    model: { endpoint: async () => ({ baseUrl: 'http://x/v1', key: 'k', model: 'm', ready: true }) } as never,
    fetchImpl: (async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ commands: [{ name: 'note', title: '周四把稿子交给甲方', status: 'todo' }] }) } }] }))) as never,
  })
  started.push(server)
  return { url: server.url, file, tasks }
}

async function state(url: string): Promise<WorkbenchState> {
  return await (await fetch(`${url}/state`)).json() as WorkbenchState
}

describe('新建便签缺省「待排」(③)', () => {
  it('★POST /task/create 不传 status → 落「待排」,负责人驱动不会把它派出去', async () => {
    const { url } = await serve()
    const created = await post(url, '/task/create', { title: '排期上的那张卡' })
    expect(created.status).toBe(200)
    expect((await state(url)).tasks?.tasks[0]).toMatchObject({ id: 't-1', title: '排期上的那张卡', status: 'backlog' })
  })

  it('显式传 todo → 照旧进「待办」;拖进「待办」也照旧', async () => {
    const { url } = await serve()
    await post(url, '/task/create', { title: '明说待办的', status: 'todo' })
    await post(url, '/task/create', { title: '先待排后拖进去的' })
    expect((await state(url)).tasks?.tasks[0]?.status).toBe('todo')
    expect((await post(url, '/task/move', { id: 't-2', status: 'todo' })).status).toBe(200)
    expect((await state(url)).tasks?.tasks[1]?.status).toBe('todo')
  })

  it('★/butler/item(交办)进中枢:中枢 note(todo)建的卡还是「待办」', async () => {
    const { url } = await serve()
    const said = await post(url, '/butler/item', { text: '提醒我周四把稿子交给甲方' })
    expect(said.status).toBe(200)
    expect((await state(url)).tasks?.tasks[0]?.status).toBe('todo')
  })
})

describe('删过的会话卡不再登(④)', () => {
  it('同一条会话记录对应的卡被删过 → 不再登;「删过」落盘,重启后仍有效', async () => {
    const file = tempFile()
    let n = 0
    const tasks = createTasksService({ file, now: () => NOW_SEC, newId: () => `t-${++n}` })

    const first = await placeSession(tasks, { agent: 'claude', sessionId: 'sess-1', body: { title: '那条会话' } })
    expect(first.ok).toBe(true)
    if (first.ok) {
      expect((await tasks.list()).tasks[0]?.from).toMatchObject({ kind: 'session', ref: 'claude:sess-1' })
      // 她把这张回流建的卡删了。
      expect(await tasks.remove(first.id)).toBe(true)
    }

    // 同一条会话记录再来:不再登。
    const again = await placeSession(tasks, { agent: 'claude', sessionId: 'sess-1', body: { title: '那条会话' } })
    expect(again.ok).toBe(false)
    expect((await tasks.list()).tasks).toHaveLength(0)

    // 「重启」:换一个服务实例读同一份文件,删过的小表还在,照样不登。
    const reopened = createTasksService({ file, now: () => NOW_SEC, newId: () => `t-${++n}` })
    expect(await reopened.removedSessionCards()).toContain('claude:sess-1')
    const afterReboot = await placeSession(reopened, { agent: 'claude', sessionId: 'sess-1', body: { title: '那条会话' } })
    expect(afterReboot.ok).toBe(false)

    // 别条会话不受影响。
    const other = await placeSession(reopened, { agent: 'claude', sessionId: 'sess-2', body: { title: '另一条会话' } })
    expect(other.ok).toBe(true)
  })

  it('删的不是会话回流卡(比如她自己手建的便签)不记「删过」', async () => {
    const file = tempFile()
    let n = 0
    const tasks = createTasksService({ file, now: () => NOW_SEC, newId: () => `t-${++n}` })
    const manual = await tasks.create({ title: '她自己写的卡' })
    expect(await tasks.remove(manual.id as string)).toBe(true)
    expect(await tasks.removedSessionCards()).toEqual([])
  })
})
