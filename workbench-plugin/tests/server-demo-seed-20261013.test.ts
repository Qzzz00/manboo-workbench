// @vitest-environment node
/**
 * `POST /demo/seed` / `POST /demo/clear`(2026-10-13,卡「演示数据一键放进去」)。
 *
 * 门与 `/meeting/seed-demo` 同一道:**只给本机**。这份用例守三样 ——
 * 走真路(卡真落在 `/state.tasks`、那一场会真进 `/state.meetings.upcoming`)、
 * 清掉只动带记号的卡、以及「放完顺手跑一遍早报」那一下**分得清「接下了」与「拒了」**。
 */
import { readFileSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkbenchState } from '../src/protocol.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { runMorningForDemo, startWorkbenchServer } from '../src/server/http.ts'
import { createJobLog } from '../src/server/jobLog.ts'
import { createMeetingService } from '../src/server/meeting.ts'
import { DEMO_AGENT_RECORDS, DEMO_BOARD_ITEMS, DEMO_PUBLISH_PLANS, DEMO_TAG } from '../src/server/demoSeed.ts'
import { createTasksService } from '../src/server/tasks.ts'
import { createWorkbenchService } from '../src/server/service.ts'

const started: WorkbenchServer[] = []
const dirs: string[] = []

afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

async function serve(options: { withTasks?: boolean } = {}) {
  const store = tempDir('wb-demo-http-store-')
  const workdir = tempDir('wb-demo-http-repo-')
  const tasks = createTasksService({ file: join(store, 'tasks.json') })
  const meeting = createMeetingService({
    file: join(store, 'meetings.json'),
    workdir: () => workdir,
    transcribe: async () => '没用到',
    chat: async () => '没用到',
    tasks,
  })
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService(),
    tickIntervalMs: 0,
    heartbeatMs: 0,
    jobLog: createJobLog(),
    meeting,
    ...(options.withTasks === false ? {} : { tasks }),
  })
  started.push(server)
  return { url: server.url, tasks }
}

async function post(url: string, path: string) {
  const res = await fetch(`${url}${path}`, { method: 'POST' })
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

describe('放 / 清演示数据(2026-10-13)', () => {
  it('★ 一条 POST:卡落在 /state.tasks、那一场会进「待开的会」、任务账上有记录', async () => {
    const { url } = await serve()
    const res = await post(url, '/demo/seed')
    expect(res.status).toBe(200)
    expect(res.body.jobs).toBe(DEMO_AGENT_RECORDS.reduce((sum, one) => sum + one.marks.length, 0))

    const snapshot = await (await fetch(`${url}/state`)).json() as WorkbenchState
    const tasks = snapshot.tasks?.tasks ?? []
    expect(tasks).toHaveLength(DEMO_BOARD_ITEMS.length + DEMO_AGENT_RECORDS.length + DEMO_PUBLISH_PLANS.length)
    expect(tasks.every(one => one.demo === true && (one.desc ?? '').includes(DEMO_TAG))).toBe(true)
    expect(snapshot.meetings?.upcoming ?? []).toHaveLength(1)
    // 这台没接例程 → 如实说让她自己点一下,不装作跑了
    expect(String(res.body.morning)).toContain('没替你跑')
  })

  it('清掉:带记号的卡全挪进「取消」;她自己的卡一张不碰', async () => {
    const { url, tasks } = await serve()
    await post(url, '/demo/seed')
    const hers = await tasks.create({ title: '她自己的一条', status: 'todo' })
    const cleared = await post(url, '/demo/clear')
    expect(cleared.status).toBe(200)
    const list = (await tasks.list()).tasks
    expect(list.filter(one => one.demo === true).every(one => one.status === 'canceled')).toBe(true)
    expect(list.find(one => one.id === hers.id)?.status).toBe('todo')
  })

  it('没接看板 404;两条都只给本机(路由里第一道闸就是 loopback)', async () => {
    const noTasks = await serve({ withTasks: false })
    expect((await post(noTasks.url, '/demo/seed')).status).toBe(404)
    const source = readFileSync(new URL('../src/server/http.ts', import.meta.url), 'utf8')
    const at = source.indexOf("path === '/demo/seed'")
    expect(at).toBeGreaterThan(0)
    expect(source.slice(at, at + 300)).toContain('if (!loopback)')
  })

  it('放完跑早报那一下:在跑中被拒就照它说,接下了就说「在跑」(不等它跑完)', async () => {
    const refused = await runMorningForDemo({ run: async () => ({ ok: false, reason: '这条例程正在跑' }) }, 50)
    expect(refused).toEqual({ ok: false, reason: '这条例程正在跑' })
    const accepted = await runMorningForDemo({ run: () => new Promise(() => {}) }, 20)
    expect(accepted.ok).toBe(true)
    const threw = await runMorningForDemo({ run: async () => { throw new Error('例程炸了') } }, 50)
    expect(threw).toEqual({ ok: false, reason: '例程炸了' })
  })
})
