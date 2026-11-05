// @vitest-environment node
/**
 * 取消了就是取消了(2026-09-25,卡 fix/confirm-cancel)。
 *
 * 统筹 0.2.89 真机:事项 t-f27d6416(一件带交付物、在「等我确认」里的测试题)
 * `POST /task/update {status: canceled}` 回了 `{ok:true}`,/state 里却马上又是 confirm;
 * 更早一次也是这样「取消」的,之后事务官那一轮收尾把它挪进了「等我确认」。
 * 病根:`/task/update` 不改状态(改状态只有 `/task/move` 一条),却对 `status` 一声不吭、回 ok。
 *
 * 钉住三条:
 *   1. `/task/update` 带 `status` → 整件退回(400),一个字都不改,并说清走哪条;
 *   2. `/task/move` 取消一件带交付物、在「等我确认」里的事 → 成;交付物还在;「等我确认」里没它了;
 *   3. 取消了的卡,**后台回写一格都挪不动**:会话收尾(事务官那一轮结束)不把它挪回「等我确认」。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkbenchState } from '../src/protocol.ts'
import { createButlerLifecycle } from '../src/server/butlerLifecycle.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createTasksService } from '../src/server/tasks.ts'

const NOW_SEC = Math.floor(Date.parse('2026-09-24T14:31:51Z') / 1000)
const started: WorkbenchServer[] = []
const dirs: string[] = []

afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

async function post(url: string, path: string, body: unknown) {
  const res = await fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: res.status, body: await res.json() as Record<string, any> }
}

async function serve() {
  const dir = mkdtempSync(join(tmpdir(), 'wb-task-cancel-'))
  dirs.push(dir)
  let clock = NOW_SEC
  const tasks = createTasksService({ file: join(dir, 'tasks.json'), now: () => clock, newId: () => 't-f27d6416' })
  const server = await startWorkbenchServer({ port: 0, service: createWorkbenchService({ now: () => clock }), tickIntervalMs: 0, heartbeatMs: 0, tasks })
  started.push(server)
  // 一件他交代的事:事务官答完了,挂着一条回答,等他确认。
  await tasks.create({ title: '[测试·统筹验证,可忽略] 我的规矩有哪些?', direction: 'mine', status: 'todo' })
  await tasks.update('t-f27d6416', { conversation: { agent: 'dsh', session_id: 'session-da27' } })
  await tasks.move('t-f27d6416', 'doing')
  clock += 60
  await tasks.update('t-f27d6416', { deliverables: [{ kind: 'reply', ref: '分四块:全局……', session_id: 'session-da27' }] })
  await tasks.move('t-f27d6416', 'confirm')
  return { url: server.url, tasks, tick: (sec: number) => { clock += sec } }
}

async function card(tasks: ReturnType<typeof createTasksService>) {
  return (await tasks.list()).tasks.find(one => one.id === 't-f27d6416')
}

describe('取消了就是取消了', () => {
  it('★/task/update 带 status → 400,一个字都不改,说清改状态走 /task/move', async () => {
    const { url, tasks } = await serve()
    const before = await card(tasks)
    const res = await post(url, '/task/update', { id: 't-f27d6416', status: 'canceled', title: '顺手改个标题' })
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('/task/move')
    const after = await card(tasks)
    expect(after?.status).toBe('confirm')
    expect(after?.title).toBe(before?.title)
    expect(after?.updated_at).toBe(before?.updated_at)
  })

  it('★/task/move 取消一件带交付物、在「等我确认」里的事:成;交付物还在;「等我确认」里没它了', async () => {
    const { url, tasks } = await serve()
    const res = await post(url, '/task/move', { id: 't-f27d6416', status: 'canceled' })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    const after = await card(tasks)
    expect(after?.status).toBe('canceled')
    expect(after?.deliverables).toHaveLength(1)
    const state = await (await fetch(`${url}/state`)).json() as WorkbenchState
    expect((state.butler_inbox?.items ?? []).filter(one => one.kind === 'confirm')).toEqual([])
  })

  it('★取消之后事务官那一轮才收尾:不把它挪回「等我确认」,也不再往卡上挂回答', async () => {
    const { tasks, tick } = await serve()
    // 还在办的时候他就取消了(真机那一次的样子:会话还没答完)。
    await tasks.move('t-f27d6416', 'doing')
    await tasks.move('t-f27d6416', 'canceled')
    tick(120)
    const lifecycle = createButlerLifecycle({ tasks, summaryOf: () => '答完了' })
    await lifecycle.handleSessionEnd('session-da27', { kind: 'done', ts: NOW_SEC + 180 })
    const after = await card(tasks)
    expect(after?.status).toBe('canceled')
    expect(after?.deliverables).toHaveLength(1)
  })

  it('取消了的卡能被**他**挪回待办(转换表留给人的那一步),后台没有这条路', async () => {
    const { url, tasks } = await serve()
    await post(url, '/task/move', { id: 't-f27d6416', status: 'canceled' })
    expect((await post(url, '/task/move', { id: 't-f27d6416', status: 'confirm' })).status).toBe(409)
    expect((await post(url, '/task/move', { id: 't-f27d6416', status: 'todo' })).status).toBe(200)
    expect((await card(tasks))?.status).toBe('todo')
  })
})
