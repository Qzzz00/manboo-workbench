// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import type { LiveMessage, WorkbenchState } from '../src/protocol.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createProjectsService } from '../src/server/projectsService.ts'
import type { TasksFile } from '../src/server/tasks.ts'
import { createTasksService } from '../src/server/tasks.ts'
import { createWorkbenchService } from '../src/server/service.ts'

/** 本地 2026-09-09 12:00。风险按本地日切天。 */
const NOW_SEC = Math.floor(new Date(2026, 8, 9, 12, 0, 0).getTime() / 1000)
const DAY = 86400
const iso = (daysAgo: number) => new Date((NOW_SEC - daysAgo * DAY) * 1000).toISOString()

const started: WorkbenchServer[] = []
const dirs: string[] = []

afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-risk-http-'))
  dirs.push(dir)
  return dir
}

/** 一个仓库 Aiboo,项目 id 就是 'aiboo';DDL 由参数给。 */
function projectsWith(dir: string, ddl: string | undefined, commits = '9\n') {
  const file = join(dir, 'projects.json')
  if (ddl !== undefined) {
    writeFileSync(file, JSON.stringify({
      version: 1,
      projects: [{
        id: 'aiboo', name: 'Aiboo', stage: 'MVP 开发', repoPath: '/roots/gh/Aiboo',
        links: [], ddl: { date: ddl, title: '上线' },
      }],
      rules: [],
    }))
  }
  return createProjectsService({
    file,
    exec: async (args) => {
      if (args[0] === 'rev-parse') return { ok: true, stdout: 'main\n' }
      if (args[0] === 'log') return { ok: true, stdout: iso(1) }
      if (args[0] === 'rev-list') return { ok: true, stdout: commits }
      return { ok: true, stdout: '' }
    },
    listDir: async (d) => d === '/roots/gh' ? ['/roots/gh/Aiboo'] : [],
    isRepo: async (d) => d === '/roots/gh/Aiboo',
    codexHome: '/x',
    codexDeps: { listFiles: async () => [], readFirstLine: async () => '' },
    home: '/Users/example',
    now: () => NOW_SEC,
    scanRoots: [{ path: '/roots/gh', depth: 1 }],
    scanMinIntervalSec: 0,
  })
}

function tasksWith(dir: string, data: Partial<TasksFile>) {
  const file = join(dir, 'tasks.json')
  writeFileSync(file, JSON.stringify({
    version: 1, tasks: [], sprints: [], modules: [], project_meta: [], ...data,
  }))
  return createTasksService({ file, now: () => NOW_SEC, newId: () => 'x' })
}

let seq = 0
function card(over: Record<string, unknown> = {}) {
  seq += 1
  return {
    id: `t${seq}`, title: `卡 ${seq}`, status: 'todo', project_id: 'aiboo',
    source: { kind: 'manual' }, created_at: iso(30), updated_at: iso(30), ...over,
  }
}
const doneCards = (n: number) => Array.from({ length: n }, (_, i) =>
  card({ status: 'done', done_at: iso(1 + i % 10), updated_at: iso(1 + i % 10) }))
const openCards = (n: number, over: Record<string, unknown> = {}) => Array.from({ length: n }, () => card(over))

async function serve(ddl: string | undefined, data: Partial<TasksFile>, commits?: string) {
  const dir = tempDir()
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService({ now: () => NOW_SEC }),
    tickIntervalMs: 0,
    projects: projectsWith(dir, ddl, commits),
    tasks: tasksWith(dir, data),
  })
  started.push(server)
  return server
}

async function state(url: string): Promise<WorkbenchState> {
  return await (await fetch(`${url}/state`)).json() as WorkbenchState
}

describe('/state 的项目行带排期风险', () => {
  it('宽裕:带等级、预计完成日与依据', async () => {
    const { url } = await serve('2026-10-09', { tasks: [...doneCards(7), ...openCards(5)] as TasksFile['tasks'] })
    const risk = (await state(url)).projects?.projects[0]?.risk
    expect(risk).toMatchObject({ level: 'ample', eta: '2026-09-19', window_days: 14, done_recent: 7, remaining: 5 })
  })

  it('赶不上:截止只剩 5 天而按速度要 10 天', async () => {
    const { url } = await serve('2026-09-14', { tasks: [...doneCards(7), ...openCards(5)] as TasksFile['tasks'] })
    expect((await state(url)).projects?.projects[0]?.risk?.level).toBe('late')
  })

  it('无法判断:没有 DDL', async () => {
    const { url } = await serve(undefined, { tasks: [...doneCards(7), ...openCards(5)] as TasksFile['tasks'] })
    expect((await state(url)).projects?.projects[0]?.risk).toMatchObject({ level: 'unknown', reason: '没有截止日' })
  })

  it('无法判断:有 DDL 但一张任务卡都没有——把仓库提交活跃度说出来,不编预计日', async () => {
    const { url } = await serve('2026-10-09', {}, '9\n')
    const risk = (await state(url)).projects?.projects[0]?.risk
    expect(risk?.level).toBe('unknown')
    expect(risk?.eta).toBeUndefined()
    expect(risk?.reason).toContain('9 次提交')
  })

  it('冲刺也带同一口径的风险,截止日取 ends_at', async () => {
    const { url } = await serve('2026-10-09', {
      tasks: [...doneCards(7).map(c => ({ ...c, module_id: 'm1' })),
        ...openCards(5, { module_id: 'm1' })] as TasksFile['tasks'],
      sprints: [{
        id: 's1', project_id: 'aiboo', name: '冲刺一', versions: [], ends_at: '2026-09-14',
        created_at: iso(20), updated_at: iso(20),
      }],
      modules: [{ id: 'm1', sprint_id: 's1', name: '播放', created_at: iso(20), updated_at: iso(20) }],
    } as Partial<TasksFile>)
    expect((await state(url)).tasks?.sprints[0]?.risk).toMatchObject({ level: 'late', eta: '2026-09-19' })
  })

  it('没接任务板时项目行照旧不带 risk,/state 不挂', async () => {
    const dir = tempDir()
    const server = await startWorkbenchServer({
      port: 0,
      service: createWorkbenchService({ now: () => NOW_SEC }),
      tickIntervalMs: 0,
      projects: projectsWith(dir, '2026-10-09'),
    })
    started.push(server)
    expect((await state(server.url)).projects?.projects[0]?.risk).toBeUndefined()
  })
})

describe('变成「赶不上」时事务官说一句', () => {
  it('第一次看到就是赶不上:只建基线,不报', async () => {
    const { url } = await serve('2026-09-14', { tasks: [...doneCards(7), ...openCards(5)] as TasksFile['tasks'] })
    await state(url)
    await state(url)
    expect((await state(url)).sessions.filter(s => s.session_id.startsWith('schedule:'))).toEqual([])
  })

  it('由宽裕转成赶不上:一条 waiting 会话进会话表,并从 /live 增量推出去', async () => {
    const dir = tempDir()
    const tasksFile = join(dir, 'tasks.json')
    const write = (tasks: unknown[]) => writeFileSync(tasksFile, JSON.stringify({
      version: 1, tasks, sprints: [], modules: [], project_meta: [],
    }))
    write([...doneCards(7), ...openCards(1)])
    const server = await startWorkbenchServer({
      port: 0,
      service: createWorkbenchService({ now: () => NOW_SEC }),
      tickIntervalMs: 0,
      projects: projectsWith(dir, '2026-09-14'),
      tasks: createTasksService({ file: tasksFile, now: () => NOW_SEC }),
    })
    started.push(server)

    expect((await state(server.url)).projects?.projects[0]?.risk?.level).toBe('ample')

    const ws = new WebSocket(`${server.url.replace('http://', 'ws://')}/live`)
    const messages: LiveMessage[] = []
    ws.on('message', raw => messages.push(JSON.parse(String(raw)) as LiveMessage))
    await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject) })

    // 活突然多出来一堆:同样的速度赶不上了。
    write([...doneCards(7), ...openCards(20)])
    await state(server.url)

    const snapshot = await state(server.url)
    const session = snapshot.sessions.find(s => s.session_id === 'schedule:aiboo')
    expect(session).toMatchObject({ agent: 'dsh', status: 'waiting', project: 'Aiboo' })
    expect(session?.title).toContain('赶不上')

    const deadline = Date.now() + 2000
    while (!messages.some(m => m.kind === 'event' && m.event.session_id === 'schedule:aiboo')) {
      if (Date.now() > deadline) throw new Error('没等到排期风险的增量事件')
      await new Promise(r => setTimeout(r, 10))
    }
    const pushed = messages.find(m => m.kind === 'event' && m.event.session_id === 'schedule:aiboo')
    expect(pushed).toMatchObject({ kind: 'event', event: { reason: 'idle_prompt', type: 'waiting' } })
    ws.close()
  })

  it('不响铃:reason 是 idle_prompt,不是 permission_prompt', async () => {
    const dir = tempDir()
    const tasksFile = join(dir, 'tasks.json')
    const write = (tasks: unknown[]) => writeFileSync(tasksFile, JSON.stringify({
      version: 1, tasks, sprints: [], modules: [], project_meta: [],
    }))
    write([...doneCards(7), ...openCards(1)])
    const server = await startWorkbenchServer({
      port: 0,
      service: createWorkbenchService({ now: () => NOW_SEC }),
      tickIntervalMs: 0,
      projects: projectsWith(dir, '2026-09-14'),
      tasks: createTasksService({ file: tasksFile, now: () => NOW_SEC }),
    })
    started.push(server)
    await state(server.url)
    write([...doneCards(7), ...openCards(20)])
    await state(server.url)
    const snapshot = await state(server.url)
    expect(snapshot.sessions.find(s => s.session_id === 'schedule:aiboo')?.reason).toBe('idle_prompt')
    expect(snapshot.ringing ?? []).toEqual([])
  })
})
