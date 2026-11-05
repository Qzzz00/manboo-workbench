// @vitest-environment node
/**
 * 同事项四意图的服务端生命周期(2026-10-26,机制卡A;与同树另一会话冲突上报 reconcile
 * 后的场景钉,语义以 reconcile 定案为准,命名 supplement/redirect/hurry/recall):
 *
 * 走一整条隔离的 8791(真 HTTP、内存假会话通道):
 *   - 四序连用:补充→加速→改向→撤回,卡上四条痕 intent 各不相同、状态与之一致;
 *   - 改向零新会话零新卡(无二派);撤回停轮+清队列+回 backlog,一句不进会话;
 *   - 异常(stale-queue / model / 老宿主停不了)零发送零副作用;done 卡 409;
 *   - 服务重启(同一本 tasks.json)痕仍在、撤回照常。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createTasksService } from '../src/server/tasks.ts'

const NOW_SEC = Math.floor(Date.parse('2026-10-26T07:30:00.000Z') / 1000)

const started: WorkbenchServer[] = []
const dirs: string[] = []
afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

interface Harness {
  url: string
  file: string
  tasks: ReturnType<typeof createTasksService>
  says: { session: string, mode: string, text: string }[]
  cancels: string[]
  clears: string[]
  nextClearResult: string[] | undefined
  running: boolean
  id: string
}

async function serve(dir?: string): Promise<Harness> {
  const root = dir ?? mkdtempSync(join(tmpdir(), 'wb-say-intent-'))
  if (dir === undefined) dirs.push(root)
  const file = join(root, 'tasks.json')
  let n = 0
  const tasks = createTasksService({ file, now: () => NOW_SEC, newId: () => `t-${++n}` })
  const says: Harness['says'] = []
  const cancels: string[] = []
  const clears: string[] = []
  const state = { nextClearResult: [] as string[] | undefined, running: true }
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService({ now: () => NOW_SEC }),
    tickIntervalMs: 0,
    tasks,
    butlerSession: {
      open: async () => 'sess-new',
      say: async (session: string, text: string, _onRejected?: unknown, opts?: { mode?: 'queue' | 'steer' }) => {
        says.push({ session, mode: opts?.mode ?? 'queue', text })
        return true
      },
      cancel: async (session: string) => {
        cancels.push(session)
        return state.running ? { ok: true, running: true } : { ok: true, running: false }
      },
      clearQueued: async (session: string, taskId: string) => {
        clears.push(`${session}:${taskId}`)
        // nextClearResult=undefined 模拟整条能力缺席(返回 undefined);否则视为干净清完。
        if (state.nextClearResult === undefined) return undefined
        return { removed: state.nextClearResult, remaining: [], incomplete: false }
      },
      running: (session: string) => { void session; return state.running },
    } as never,
  })
  started.push(server)
  const created = await tasks.create({ title: '梳理报告', status: 'doing' })
  const id = created.id as string
  await tasks.update(id, { conversation: { agent: 'dsh', session_id: 'sess-1' } })
  return {
    url: server.url, file, tasks, says, cancels, clears, id,
    get nextClearResult() { return state.nextClearResult },
    set nextClearResult(v: string[] | undefined) { state.nextClearResult = v },
    get running() { return state.running },
    set running(v: boolean) { state.running = v },
  } as unknown as Harness
}

async function post(url: string, path: string, body: unknown) {
  const res = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

async function cardOf(h: Harness) {
  return (await h.tasks.list()).tasks[0]!
}

describe('POST /butler/item/say:四序连用,生命周期可区分', () => {
  it('★补充→加速→改向→撤回:卡上四条痕 intent 各不相同、状态与之一致、零新会话零新卡', async () => {
    const h = await serve()
    h.nextClearResult = ['三句之前排着的旧话']
    await post(h.url, '/butler/item/say', { id: h.id, text: '一句', intent: 'supplement' })
    await post(h.url, '/butler/item/say', { id: h.id, text: '二句', intent: 'hurry' })
    await post(h.url, '/butler/item/say', { id: h.id, text: '三句', intent: 'redirect' })
    const last = await post(h.url, '/butler/item/say', { id: h.id, text: '四句', intent: 'recall' })
    expect(last.body).toMatchObject({ ok: true, intent: 'recall', stopped: true, cleared: 1 })
    const card = await cardOf(h)
    expect((card.comments ?? []).map(one => one.intent)).toEqual(['supplement', 'hurry', 'redirect', 'recall'])
    expect(card.status).toBe('backlog')
    // 进会话的只三句(撤回不进);改向那句带框;没有任何新会话 / 新卡。
    expect(h.says).toHaveLength(3)
    expect(h.says[2]?.text).toContain('【改方向')
    expect((await h.tasks.list()).tasks).toHaveLength(1)
    expect(h.says.every(one => one.session === 'sess-1')).toBe(true)
  })

  it('★撤回到 blocked 的卡 → 回待办(表里 blocked 到不了 backlog,退一格)', async () => {
    const h = await serve()
    await h.tasks.move(h.id, 'blocked')
    const res = await post(h.url, '/butler/item/say', { id: h.id, text: '这件先停', intent: 'recall' })
    expect(res.body).toMatchObject({ ok: true, intent: 'recall' })
    expect((await cardOf(h)).status).toBe('todo')
  })

  it('★撤回收场的卡(done)→ 409 说清原因,什么都没发生', async () => {
    const h = await serve()
    await h.tasks.move(h.id, 'confirm')
    await h.tasks.move(h.id, 'done')
    const res = await post(h.url, '/butler/item/say', { id: h.id, text: '这件先停', intent: 'recall' })
    expect(res.status).toBe(409)
    expect(h.cancels).toEqual([])
    expect(h.clears).toEqual([])
    expect((await cardOf(h)).status).toBe('done')
  })

  it('★改向清不动旧队列(stale-queue 拒发)→ 409 + code,零发送、零留言、原样没动', async () => {
    const h = await serve()
    h.nextClearResult = undefined
    const res = await post(h.url, '/butler/item/say', { id: h.id, text: '别按原方案了', intent: 'redirect' })
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ code: 'session_stale_queue' })
    expect(String(res.body.error)).toContain('没有发送')
    const card = await cardOf(h)
    expect(card.comments ?? []).toHaveLength(0)
    expect(card.status).toBe('doing')
  })

  it('★撤回:老宿主停不了会话 → 409,卡原样没动', async () => {
    const h = await serve()
    h.running = true
    const noCancel = await serve()
    void noCancel
    // 用 cancel 抛错模拟老宿主停不了。
    const dir = mkdtempSync(join(tmpdir(), 'wb-say-intent-nocancel-'))
    dirs.push(dir)
    const tasks = createTasksService({ file: join(dir, 'tasks.json'), now: () => NOW_SEC, newId: () => 't-nc' })
    const server = await startWorkbenchServer({
      port: 0,
      service: createWorkbenchService({ now: () => NOW_SEC }),
      tickIntervalMs: 0,
      tasks,
      butlerSession: {
        open: async () => 'sess-new',
        say: async () => true,
        running: () => true,
        // 没有 cancel(老宿主)。
      } as never,
    })
    started.push(server)
    const created = await tasks.create({ title: '停不了的那件', status: 'doing' })
    const id = created.id as string
    await tasks.update(id, { conversation: { agent: 'dsh', session_id: 'sess-1' } })
    const res = await post(server.url, '/butler/item/say', { id, text: '这件先停', intent: 'recall' })
    expect(res.status).toBe(409)
    expect(String(res.body.error)).toContain('停不住')
    expect((await tasks.list()).tasks[0]!.status).toBe('doing')
    expect((await tasks.list()).tasks[0]!.comments ?? []).toHaveLength(0)
  })
})

describe('重启与痕迹:服务重启后意图与卡痕照常', () => {
  it('★关服重启(同一本 tasks.json):四条痕还在,撤回照常执行', async () => {
    const h = await serve()
    await post(h.url, '/butler/item/say', { id: h.id, text: '一句', intent: 'supplement' })
    await post(h.url, '/butler/item/say', { id: h.id, text: '三句', intent: 'redirect' })
    const file = h.file
    const says = h.says
    const cancels = h.cancels
    const clears = h.clears
    await started.pop()?.close()
    const tasks = createTasksService({ file, now: () => NOW_SEC, newId: () => 't-x' })
    const server = await startWorkbenchServer({
      port: 0,
      service: createWorkbenchService({ now: () => NOW_SEC }),
      tickIntervalMs: 0,
      tasks,
      butlerSession: {
        open: async () => 'sess-new',
        say: async (session: string, text: string, _r?: unknown, opts?: { mode?: 'queue' | 'steer' }) => {
          says.push({ session, mode: opts?.mode ?? 'queue', text })
          return true
        },
        cancel: async (session: string) => { cancels.push(session); return { ok: true, running: true } },
        clearQueued: async (session: string, taskId: string) => { clears.push(`${session}:${taskId}`); return { removed: [], remaining: [], incomplete: false } },
        running: () => true,
      } as never,
    })
    started.push(server)
    const before = (await tasks.list()).tasks[0]!
    expect((before.comments ?? []).map(one => one.intent)).toEqual(['supplement', 'redirect'])
    const res = await post(server.url, '/butler/item/say', { id: h.id, text: '重启后撤回', intent: 'recall' })
    expect(res.body).toMatchObject({ ok: true, intent: 'recall', stopped: true })
    expect((await tasks.list()).tasks[0]!.status).toBe('backlog')
  })
})
