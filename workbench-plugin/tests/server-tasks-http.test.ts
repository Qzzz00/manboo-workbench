// @vitest-environment node
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkbenchLayout, WorkbenchState } from '../src/protocol.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createTasksService } from '../src/server/tasks.ts'

const NOW_SEC = Math.floor(Date.parse('2026-08-25T09:00:00Z') / 1000)

const started: WorkbenchServer[] = []
const dirs: string[] = []

afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

function tempFile(name = 'tasks.json'): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-tasks-http-'))
  dirs.push(dir)
  return join(dir, name)
}

async function post(url: string, path: string, body: unknown) {
  const res = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

async function serve(withTasks = true) {
  const file = tempFile()
  let n = 0
  const tasks = createTasksService({ file, now: () => NOW_SEC, newId: () => `t-${++n}` })
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService({ now: () => NOW_SEC }),
    tickIntervalMs: 0,
    ...(withTasks ? { tasks } : {}),
  })
  started.push(server)
  return { url: server.url, file, tasks }
}

async function state(url: string): Promise<WorkbenchState> {
  return await (await fetch(`${url}/state`)).json() as WorkbenchState
}

describe('/task/* 路由', () => {
  it('建卡 → /state.tasks 里看得到(这条路的缺省是「待排」,2026-10-23 卡「待排的卡不许被派出去」③)', async () => {
    const { url } = await serve()
    const created = await post(url, '/task/create', { title: '修好那个铃' })
    expect(created.status).toBe(200)
    expect(created.body).toEqual({ ok: true, id: 't-1' })

    expect((await state(url)).tasks?.tasks).toEqual([{
      id: 't-1',
      title: '修好那个铃',
      status: 'backlog',
      source: { kind: 'manual' },
      execution_role: { kind: 'business', origin: 'explicit_task' },
      execution_sources: [],
      created_at: '2026-08-25T09:00:00.000Z',
      updated_at: '2026-08-25T09:00:00.000Z',
    }])
  })

  it('建卡带项目/模块/优先级/执行人/预期结束/来源', async () => {
    const { url } = await serve()
    await post(url, '/task/create', {
      title: '看一眼 Codex 那个会话',
      project_id: 'p1',
      module_id: 'm1',
      status: 'confirm',
      priority: 'high',
      assignee: 'codex',
      due: '2026-09-01',
      desc: '把那条会话的结论抄进来',
      source: { kind: 'session', ref: 'sess-9' },
    })
    expect((await state(url)).tasks?.tasks[0]).toMatchObject({
      status: 'confirm',
      project_id: 'p1',
      module_id: 'm1',
      priority: 'high',
      assignee: 'codex',
      due: '2026-09-01',
      desc: '把那条会话的结论抄进来',
      source: { kind: 'session', ref: 'sess-9' },
    })
  })

  it('改状态', async () => {
    const { url } = await serve()
    await post(url, '/task/create', { title: 'a', status: 'todo' })
    expect((await post(url, '/task/move', { id: 't-1', status: 'doing' })).status).toBe(200)
    expect((await state(url)).tasks?.tasks[0]?.status).toBe('doing')
  })

  /**
   * 状态机(2026-09-09 七态)。改状态**还是 /task/move 这一条路**,没有第二条:
   * 两条都能改状态就有两份真相,下一个人改规则时一定漏掉一条。
   */
  it('非法转换 → 409 + 一句中文原因,卡上的状态没动', async () => {
    const { url } = await serve()
    await post(url, '/task/create', { title: 'a', status: 'todo' })
    const rejected = await post(url, '/task/move', { id: 't-1', status: 'done' })
    expect(rejected.status).toBe(409)
    expect(String(rejected.body.error)).toContain('「待办」不能直接改成「完成」')
    expect((await state(url)).tasks?.tasks[0]?.status).toBe('todo')
  })

  it('卡不存在还是 404(跟"这一步不许走"是两回事)', async () => {
    const { url } = await serve()
    expect((await post(url, '/task/move', { id: '没有', status: 'doing' })).status).toBe(404)
  })

  it('七个状态都是合法枚举值;阻塞与取消也走同一条路由', async () => {
    const { url } = await serve()
    await post(url, '/task/create', { title: 'a', status: 'todo' })
    expect((await post(url, '/task/move', { id: 't-1', status: 'blocked' })).status).toBe(200)
    expect((await post(url, '/task/move', { id: 't-1', status: 'canceled' })).status).toBe(200)
    expect((await state(url)).tasks?.tasks[0]?.status).toBe('canceled')
  })

  it('建卡时可以直接落在待排(记下来但这个冲刺不做)', async () => {
    const { url } = await serve()
    expect((await post(url, '/task/create', { title: '以后再说', status: 'backlog' })).status).toBe(200)
    expect((await state(url)).tasks?.tasks[0]?.status).toBe('backlog')
  })

  it('改标题与归属;project_id 传 null = 摘出项目', async () => {
    const { url } = await serve()
    await post(url, '/task/create', { title: 'a', project_id: 'p1' })
    await post(url, '/task/update', { id: 't-1', title: 'b' })
    expect((await state(url)).tasks?.tasks[0]?.title).toBe('b')

    await post(url, '/task/update', { id: 't-1', project_id: null })
    expect((await state(url)).tasks?.tasks[0]).not.toHaveProperty('project_id')
  })

  it('删卡', async () => {
    const { url } = await serve()
    await post(url, '/task/create', { title: 'a' })
    expect((await post(url, '/task/delete', { id: 't-1' })).status).toBe(200)
    expect((await state(url)).tasks?.tasks).toEqual([])
  })

  it('状态枚举写错 → 400,不静默丢掉', async () => {
    const { url } = await serve()
    await post(url, '/task/create', { title: 'a' })
    const bad = await post(url, '/task/move', { id: 't-1', status: '已归档' })
    expect(bad.status).toBe(400)
    expect(String(bad.body.error)).toContain('status 必须是')
  })

  it('标题空白 → 400;卡不存在 → 404', async () => {
    const { url } = await serve()
    expect((await post(url, '/task/create', { title: '  ' })).status).toBe(400)
    expect((await post(url, '/task/move', { id: '没有', status: 'doing' })).status).toBe(404)
    expect((await post(url, '/task/delete', { id: '没有' })).status).toBe(404)
  })

  it('不认识的看板操作 → 404,不当成别的动作执行', async () => {
    const { url } = await serve()
    await post(url, '/task/create', { title: 'a' })
    for (const path of ['/task/archive', '/task/cleanup', '/sprint/archive', '/module/prune']) {
      expect((await post(url, path, { id: 't-1' })).status).toBe(404)
    }
    expect((await state(url)).tasks?.tasks).toHaveLength(1)
  })

  it('优先级/执行人写错 → 400,不静默丢掉', async () => {
    const { url } = await serve()
    expect((await post(url, '/task/create', { title: 'a', priority: '特急' })).status).toBe(400)
    expect((await post(url, '/task/create', { title: 'a', assignee: '张三' })).status).toBe(400)
    expect((await state(url)).tasks?.tasks).toEqual([])
  })

  it('没接看板服务时 /task/* 一律 404,/state.tasks 缺省', async () => {
    const { url } = await serve(false)
    expect((await post(url, '/task/create', { title: 'a' })).status).toBe(404)
    expect((await state(url)).tasks).toBeUndefined()
  })

  it('tasks.json 写坏了只是看板空着,GET /state 照常 200(D13 降级纪律)', async () => {
    const { url, file } = await serve()
    writeFileSync(file, '{ 坏掉的 JSON')
    const res = await fetch(`${url}/state`)
    expect(res.status).toBe(200)
    expect(((await res.json()) as WorkbenchState).tasks?.tasks).toEqual([])
  })

  it('tasks.json 写坏了:/state 报一句人话,建卡 409 拒写,原文件一字不差(移交审查复现步骤)', async () => {
    const { url, file } = await serve()
    const truncated = '{"version":2,"tasks":[{"id":"t-old","title":"原来那张","status":"todo","sou'
    writeFileSync(file, truncated)

    const before = await state(url)
    expect(before.tasks?.tasks).toEqual([])
    expect(before.tasks?.problem).toContain('原文件没动')

    const created = await post(url, '/task/create', { title: '新的一张' })
    expect(created.status).toBe(409)
    // /state 与后台刷新可能同时读到坏文件:只另存一份,两处说的是同一句(tasks.ts keepCorruptCopy)。
    expect(created.body.error).toBe(before.tasks?.problem)
    expect(readdirSync(dirname(file)).filter(name => name.startsWith('tasks.json.corrupt-'))).toHaveLength(1)
    expect(readFileSync(file, 'utf8')).toBe(truncated)
  })
})

describe('/sprint/* 与 /module/* 路由', () => {
  it('建冲刺 → 建模块 → 建功能点,三层都在 /state 里', async () => {
    const { url } = await serve()
    const sprint = await post(url, '/sprint/create', {
      project_id: 'p1',
      name: '冲刺一',
      goal: '把看板跑通',
      versions: [{ label: '客户端', version: 'V0.1' }, { label: '后端', version: 'V0.1' }],
    })
    expect(sprint.status).toBe(200)

    const module = await post(url, '/module/create', {
      sprint_id: sprint.body.id, name: '播放模块', goal: '能连播',
    })
    expect(module.status).toBe(200)

    await post(url, '/task/create', { title: '连播', project_id: 'p1', module_id: module.body.id })

    const tasks = (await state(url)).tasks
    expect(tasks?.sprints[0]).toMatchObject({
      project_id: 'p1',
      name: '冲刺一',
      goal: '把看板跑通',
      versions: [{ label: '客户端', version: 'V0.1' }, { label: '后端', version: 'V0.1' }],
    })
    expect(tasks?.modules[0]).toMatchObject({ sprint_id: sprint.body.id, name: '播放模块', goal: '能连播' })
    expect(tasks?.tasks[0]).toMatchObject({ module_id: module.body.id })
  })

  it('半条版本号(只有名字没有号)整条丢掉,不留读不懂的东西', async () => {
    const { url } = await serve()
    await post(url, '/sprint/create', {
      project_id: 'p1',
      name: 'S1',
      versions: [{ label: '客户端' }, { label: '后端', version: 'V0.1' }, 'x'],
    })
    expect((await state(url)).tasks?.sprints[0]?.versions).toEqual([{ label: '后端', version: 'V0.1' }])
  })

  it('删冲刺:模块退休、卡一张不少(不级联删待办)', async () => {
    const { url } = await serve()
    const sprint = await post(url, '/sprint/create', { project_id: 'p1', name: 'S1' })
    const module = await post(url, '/module/create', { sprint_id: sprint.body.id, name: 'M1' })
    await post(url, '/task/create', { title: '连播', project_id: 'p1', module_id: module.body.id })

    expect((await post(url, '/sprint/delete', { id: sprint.body.id })).status).toBe(200)
    const tasks = (await state(url)).tasks
    expect(tasks?.sprints).toEqual([])
    expect(tasks?.modules).toEqual([])
    expect(tasks?.tasks).toHaveLength(1)
    expect(tasks?.tasks[0]).not.toHaveProperty('module_id')
  })

  it('缺 project_id / sprint_id → 400;改不存在的冲刺/模块 → 404', async () => {
    const { url } = await serve()
    expect((await post(url, '/sprint/create', { name: 'S1' })).status).toBe(400)
    expect((await post(url, '/module/create', { name: 'M1' })).status).toBe(400)
    expect((await post(url, '/sprint/update', { id: '没有', name: 'x' })).status).toBe(404)
    expect((await post(url, '/module/update', { id: '没有', name: 'x' })).status).toBe(404)
  })

  it('项目排期元数据:优先级与执行人', async () => {
    const { url } = await serve()
    expect((await post(url, '/board/project', { project_id: 'p1', priority: 'high', assignee: 'claude' })).status).toBe(200)
    expect((await state(url)).tasks?.project_meta).toEqual([
      { project_id: 'p1', priority: 'high', assignee: 'claude' },
    ])

    expect((await post(url, '/board/project', { project_id: 'p1', priority: '特急' })).status).toBe(400)
    expect((await post(url, '/board/project', { priority: 'high' })).status).toBe(400)
  })
})

describe('关联窗口与模块版本号的路由', () => {
  it('建卡带 links;update 整组替换;认不出的 agent 被挑掉', async () => {
    const { url } = await serve()
    await post(url, '/task/create', {
      title: '连播',
      links: [{ agent: 'codex', session_id: 'sess-1' }, { agent: '张三', session_id: 'x' }],
    })
    expect((await state(url)).tasks?.tasks[0]?.links).toEqual([{ agent: 'codex', session_id: 'sess-1' }])

    await post(url, '/task/update', {
      id: 't-1',
      links: [{ agent: 'codex', session_id: 'sess-1' }, { agent: 'claude', session_id: 'sess-2' }],
    })
    expect((await state(url)).tasks?.tasks[0]?.links).toHaveLength(2)
  })

  it('模块的 version_label 可设可清', async () => {
    const { url } = await serve()
    const sprint = await post(url, '/sprint/create', {
      project_id: 'p1', name: 'S1', versions: [{ label: '客户端', version: 'V0.1' }],
    })
    const module = await post(url, '/module/create', {
      sprint_id: sprint.body.id, name: 'M1', version_label: '客户端',
    })
    expect((await state(url)).tasks?.modules[0]?.version_label).toBe('客户端')

    await post(url, '/module/update', { id: module.body.id, version_label: null })
    expect((await state(url)).tasks?.modules[0]).not.toHaveProperty('version_label')
  })
})

/**
 * layout.board_axis 的**透传**(2026-08-25 横排/竖排开关)。
 *
 * 这条必须测服务端而不是只测客户端:parseLayout 会按字段重建 layout 对象,漏掉一个键
 * 的后果不是报错而是"切了方向、刷新一下弹回去"——同款坑 projects_view 那次踩过,
 * 见 http.ts parseLayout 里那条注释。
 *
 * /layout 需要一个 projects 服务,这里给一个只记在内存里的最小替身:本用例关心的
 * 只有"写进去的 layout 原样读得回来",不需要真的扫仓库。
 */
describe('layout.board_axis 透传', () => {
  function fakeProjects() {
    let stored: WorkbenchLayout | undefined
    return {
      getProjectsState: async () => ({ projects: [], pending: [], scan_errors: [], scanned_at: '' }),
      confirmStatus: async () => false,
      setDdl: async () => false,
      addRule: async () => {},
      getLayout: async () => stored,
      setLayout: async (layout: WorkbenchLayout) => { stored = layout },
      invalidateScanCache: () => {},
    }
  }

  async function serveWithLayout() {
    const projects = fakeProjects()
    const server = await startWorkbenchServer({
      port: 0,
      service: createWorkbenchService({ now: () => NOW_SEC }),
      tickIntervalMs: 0,
      projects,
    })
    started.push(server)
    return server.url
  }

  const LAYOUT = { modules: [{ id: 'projects', order: 0 }], butler: { corner: 'br', min: false } }

  it('合法值写进去、原样读得回来(不透传的话切了方向刷新就弹回去)', async () => {
    const url = await serveWithLayout()
    expect((await post(url, '/layout', { layout: { ...LAYOUT, board_axis: 'module-columns' } })).status).toBe(200)
    expect((await state(url)).layout?.board_axis).toBe('module-columns')
  })

  it('不带这个键的旧客户端不该被拒(additive 字段)', async () => {
    const url = await serveWithLayout()
    expect((await post(url, '/layout', { layout: LAYOUT })).status).toBe(200)
    expect((await state(url)).layout?.board_axis).toBeUndefined()
  })

  it('写坏了 400,不静默丢掉一个写错的值', async () => {
    const url = await serveWithLayout()
    const bad = await post(url, '/layout', { layout: { ...LAYOUT, board_axis: '斜排' } })
    expect(bad.status).toBe(400)
    expect(String(bad.body.error)).toContain('board_axis 必须是')
  })
})

describe('/task/update · block_reason(阻塞原因,与会话等待原因同一套 id)', () => {
  it('挂上、清掉;认不出的 id 回 400', async () => {
    const { url } = await serve()
    await post(url, '/task/create', { title: 'a', status: 'blocked' })
    expect((await post(url, '/task/update', { id: 't-1', block_reason: 'approval' })).status).toBe(200)
    expect((await state(url)).tasks?.tasks[0]?.block_reason).toBe('approval')

    expect((await post(url, '/task/update', { id: 't-1', block_reason: null })).status).toBe(200)
    expect((await state(url)).tasks?.tasks[0]).not.toHaveProperty('block_reason')

    expect((await post(url, '/task/update', { id: 't-1', block_reason: '随便' })).status).toBe(400)
  })
})

/**
 * 交付物与费用归因(2026-09-09,待办第 5 条)。协议只加可选字段:老客户端不带这些键照常。
 */
describe('/task/* 交付物', () => {
  it('建卡带交付物;update 整组替换;坏条(认不出的 kind / 空 ref)丢掉不拒绝整张卡', async () => {
    const { url } = await serve()
    const created = await post(url, '/task/create', {
      title: '挂分支',
      deliverables: [
        { kind: 'branch', ref: 'claude/x', repo: '/r' },
        { kind: '压缩包', ref: '/x.zip' },
        { kind: 'url', ref: '   ' },
      ],
    })
    expect(created.status).toBe(200)
    expect((await state(url)).tasks?.tasks[0]?.deliverables).toEqual([{ kind: 'branch', ref: 'claude/x', repo: '/r' }])

    expect((await post(url, '/task/update', { id: 't-1', deliverables: [{ kind: 'file', ref: '/收件/a.pdf' }] })).status).toBe(200)
    expect((await state(url)).tasks?.tasks[0]?.deliverables).toEqual([{ kind: 'file', ref: '/收件/a.pdf' }])

    expect((await post(url, '/task/update', { id: 't-1', deliverables: [] })).status).toBe(200)
    expect((await state(url)).tasks?.tasks[0]).not.toHaveProperty('deliverables')
  })

  it('deliverables 不是数组时当没传(不动),不 400——它是可选留痕字段', async () => {
    const { url } = await serve()
    await post(url, '/task/create', { title: 'x', deliverables: [{ kind: 'url', ref: 'https://a' }] })
    expect((await post(url, '/task/update', { id: 't-1', deliverables: '不是数组' })).status).toBe(200)
    expect((await state(url)).tasks?.tasks[0]?.deliverables).toEqual([{ kind: 'url', ref: 'https://a' }])
  })
})

describe('/state.tasks.session_usage 费用归因', () => {
  const TOTALS = { input: 10, output: 5, cache_read: 100, cache_write: 20 }

  async function serveWithUsage(sessionTotals?: (keys: readonly string[]) => Record<string, typeof TOTALS>) {
    const file = tempFile()
    let n = 0
    const tasks = createTasksService({ file, now: () => NOW_SEC, newId: () => `t-${++n}` })
    const asked: string[][] = []
    const server = await startWorkbenchServer({
      port: 0,
      service: createWorkbenchService({ now: () => NOW_SEC }),
      tickIntervalMs: 0,
      tasks,
      usage: {
        refresh: async () => {},
        view: () => ({ error: '测试桩' }),
        ...(sessionTotals === undefined
          ? {}
          : { sessionTotals: (keys: readonly string[]) => { asked.push([...keys]); return sessionTotals(keys) } }),
      },
    })
    started.push(server)
    return { url: server.url, asked }
  }

  it('只问已关联到卡上的会话,查得到的按 agent:session_id 给回来;查不到的缺席不填 0', async () => {
    const { url, asked } = await serveWithUsage(keys => Object.fromEntries(
      keys.filter(key => key === 'claude:s-1').map(key => [key, TOTALS]),
    ))
    await post(url, '/task/create', {
      title: '有账的',
      links: [{ agent: 'claude', session_id: 's-1' }, { agent: 'kimi', session_id: 'k-1' }],
    })
    await post(url, '/task/create', { title: '没关联的' })
    const snapshot = await state(url)
    expect(snapshot.tasks?.session_usage).toEqual({ 'claude:s-1': TOTALS })
    expect(asked.at(-1)).toEqual(['claude:s-1', 'kimi:k-1'])
  })

  it('用量采集器不会按会话给数(旧接口)时字段整个缺席', async () => {
    const { url } = await serveWithUsage()
    await post(url, '/task/create', { title: 'x', links: [{ agent: 'claude', session_id: 's-1' }] })
    expect((await state(url)).tasks).not.toHaveProperty('session_usage')
  })

  it('一张卡都没关联会话时不问采集器,字段缺席', async () => {
    const { url, asked } = await serveWithUsage(() => ({ 'claude:s-1': TOTALS }))
    await post(url, '/task/create', { title: 'x' })
    expect((await state(url)).tasks).not.toHaveProperty('session_usage')
    expect(asked).toEqual([])
  })
})
