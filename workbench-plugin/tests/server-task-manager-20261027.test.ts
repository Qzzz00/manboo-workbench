// @vitest-environment node
/**
 * 事项上的「管理」一格(2026-10-27,协作区与事务官标签页合并 §3.1):谁派活、谁验收。
 * 只记建卡 / 派活那一刻的事实:事务官建的写 `dsh`(事务官的负责人 id),他自己建的不写;认不出的值读时挑掉。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createTasksService } from '../src/server/tasks.ts'

const started: WorkbenchServer[] = []
const dirs: string[] = []
afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-task-manager-'))
  dirs.push(dir)
  return dir
}

async function serve() {
  const dir = tmp()
  let n = 0
  const tasks = createTasksService({ file: join(dir, 'tasks.json'), newId: () => `t-${++n}` })
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService(),
    tickIntervalMs: 0,
    tasks,
    butlerSession: { open: async () => 'sess-1' },
    // 2026-10-29 入口归一:两个口都进理解中枢,假模型回一条 note(落「待办」、manager:dsh 由中枢的手写)。
    model: { endpoint: async () => ({ baseUrl: 'http://x/v1', key: 'k', model: 'm', ready: true }) } as never,
    fetchImpl: (async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ commands: [{ name: 'note', title: '周四发样片', status: 'todo' }] }) } }] }))) as never,
  })
  started.push(server)
  return { url: server.url, tasks }
}

async function post(url: string, path: string, body: unknown) {
  const res = await fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

describe('事项的「管理」', () => {
  it('事务官建的事项落盘带 manager:dsh,list 里看得见', async () => {
    const { url, tasks } = await serve()
    const made = await post(url, '/butler/item', { text: '把周报整理一下' })
    expect(made.status).toBe(200)
    const [one] = (await tasks.list()).tasks
    expect(one?.manager).toBe('dsh')
  })

  it('/butler/say 落地她那一句建的卡也带 manager:dsh(中枢 note 命令)', async () => {
    const dir = tmp()
    let n = 0
    const tasks = createTasksService({ file: join(dir, 'tasks.json'), newId: () => `t-${++n}` })
    const server = await startWorkbenchServer({
      port: 0, service: createWorkbenchService(), tickIntervalMs: 0, tasks,
      // 2026-10-29 入口归一:快路径删除,假模型按原语义回 note(建的卡照样 manager:dsh)。
      model: { endpoint: async () => ({ baseUrl: 'http://x/v1', key: 'k', model: 'm', ready: true }) } as never,
      fetchImpl: (async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ commands: [{ name: 'note', title: '周四下午把样片发给客户', status: 'todo' }] }) } }] }))) as never,
    })
    started.push(server)
    const res = await post(server.url, '/butler/say', { text: '记一下周四下午把样片发给客户' })
    expect(res.status).toBe(200)
    const cardId = (res.body.items as { card_id?: string }[])[0]?.card_id
    expect((await tasks.list()).tasks.find(one => one.id === cardId)?.manager).toBe('dsh')
  })

  it('他自己用 /task/create 建的不写 manager', async () => {
    const { url, tasks } = await serve()
    const made = await post(url, '/task/create', { title: '自己记一件' })
    expect(made.status).toBe(200)
    const [one] = (await tasks.list()).tasks
    expect(one).toBeDefined()
    expect(one?.manager).toBeUndefined()
  })

  it('/task/update 可以按负责人同一套判据改 manager;认不出的值 400', async () => {
    const { url, tasks } = await serve()
    await post(url, '/task/create', { title: '统筹手派的' })
    const id = (await tasks.list()).tasks[0]!.id
    expect((await post(url, '/task/update', { id, manager: 'me' })).status).toBe(200)
    expect((await tasks.list()).tasks[0]?.manager).toBe('me')
    expect((await post(url, '/task/update', { id, manager: 'root-统筹' })).status).toBe(400)
    expect((await tasks.list()).tasks[0]?.manager).toBe('me')
    expect((await post(url, '/task/update', { id, manager: null })).status).toBe(200)
    expect((await tasks.list()).tasks[0]?.manager).toBeUndefined()
  })

  it('tasks.json 里写坏的 manager 读时挑掉,卡留着、不抛', async () => {
    const dir = tmp()
    const file = join(dir, 'tasks.json')
    const at = '2026-10-27T10:00:00.000Z'
    writeFileSync(file, JSON.stringify({ tasks: [
      { id: 'a', title: '坏值', status: 'todo', manager: { who: 'x' }, source: { kind: 'manual' }, created_at: at, updated_at: at },
      { id: 'b', title: '乱写', status: 'todo', manager: 'root', source: { kind: 'manual' }, created_at: at, updated_at: at },
      { id: 'c', title: '好值', status: 'todo', manager: 'dsh', source: { kind: 'manual' }, created_at: at, updated_at: at },
    ] }))
    const tasks = createTasksService({ file })
    const list = (await tasks.list()).tasks
    expect(list.map(one => one.id)).toEqual(['a', 'b', 'c'])
    expect(list[0]?.manager).toBeUndefined()
    expect(list[1]?.manager).toBeUndefined()
    expect(list[2]?.manager).toBe('dsh')
  })
})
