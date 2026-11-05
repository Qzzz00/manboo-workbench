// @vitest-environment node
/**
 * 「今天的待办」两种显示来回切(2026-10-12,周三演示;交接 `docs/交接-1012-演示-切换待办版本.md`。
 * 2026-10-13 两版改成卡片 / 列表,见 `docs/交接-1013-待办列表卡片.md`)。
 *
 *   A `by_date`:卡片(每条一张小卡,今天 / 明天 / 更晚分三组,每组带件数);
 *   B `flat`   :列表(今天那一条平铺清单,原样)。
 *
 * 钉三件:① 切法(分组由服务端切好,两端只渲染);② `POST /today/view` 存进布局、广播、记日志与行为账;
 * ③ 别的写布局的路不把它冲掉(整份 `/layout`、`/layout/undo` 能切回上一版)。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TaskView, WorkbenchLayout, WorkbenchState } from '../src/protocol.ts'
import { TODAY_VIEW_TITLES } from '../src/protocol.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createTasksService } from '../src/server/tasks.ts'
import { createTemplateService } from '../src/server/templateStore.ts'
import { BEHAVIOR_EVENTS, createBehaviorLog } from '../src/server/behaviorLog.ts'
import { todayViewAsked } from '../src/server/demoPlaybook.ts'
import { localDayOf, nextDayOf, todayTodosOf } from '../src/todayTodos.ts'
import { resetStarterTemplateSource, startRealUserLayer } from './helpers/starterLayer.ts'

const AT = '2026-10-12T02:00:00.000Z'
function task(over: Partial<TaskView> & { id: string }): TaskView {
  return { title: over.id, status: 'todo', created_at: AT, updated_at: AT, ...over } as TaskView
}

describe('todayTodosOf 的分组(卡片版用)', () => {
  const tasks = [
    task({ id: 'today', due: '2026-10-12' }),
    task({ id: 'late', due: '2026-10-10' }),
    task({ id: 'tmr', due: '2026-10-13' }),
    task({ id: 'far2', due: '2026-10-20' }),
    task({ id: 'far1', due: '2026-10-15' }),
    task({ id: 'far-done', due: '2026-10-15', status: 'done', done_at: AT }),
    task({ id: 'topic', due: '2026-10-13', kind: 'topic' }),
    task({ id: 'nodue' }),
  ]

  it('今天(含逾期)/ 明天 / 更晚 三组都在,更晚的按日子先后;选题、没日子、将来却已办完的不进', () => {
    const view = todayTodosOf(tasks, '2026-10-12')
    expect(view.groups?.map(one => [one.key, one.label, one.items.map(item => item.id)])).toEqual([
      ['today', '今天', ['late', 'today']],
      ['tomorrow', '明天', ['tmr']],
      ['later', '更晚', ['far1', 'far2']],
    ])
  })

  it('列表版(items)一个字不变:仍只有今天那一刀;缺省是列表', () => {
    const view = todayTodosOf(tasks, '2026-10-12')
    expect(view.items.map(one => one.id)).toEqual(['late', 'today'])
    expect(view.style).toBe('flat')
    expect(todayTodosOf(tasks, '2026-10-12', 'by_date').style).toBe('by_date')
  })

  it('两版的名字只有一份', () => {
    expect(TODAY_VIEW_TITLES).toEqual({ by_date: '卡片', flat: '列表' })
  })
})

const NOW_SEC = Math.floor(Date.now() / 1000)
const started: WorkbenchServer[] = []
const dirs: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  // 全局模板来源是模块级状态:装过真实起步层也要复位,不然串到并行用例。
  resetStarterTemplateSource()
})

async function serve() {
  const dir = mkdtempSync(join(tmpdir(), 'wb-today-view-'))
  dirs.push(dir)
  // ops 模板从用户层来(2026-10-23,分层二刀二):真实 UserLayer 服务(起步层=仓库真文件)
  // ensure→scan,provider 与全局来源同一份快照;前置切模板才过得去。
  const userLayer = await startRealUserLayer(join(dir, '用户层'))
  let saved: WorkbenchLayout | undefined = { modules: [], butler: { corner: 'br', min: false } }
  const template = createTemplateService({
    file: join(dir, 'template.json'),
    backupsDir: join(dir, 'backups'),
    readLayout: () => Promise.resolve(saved),
    writeLayout: (next) => { saved = next; return Promise.resolve() },
    templates: () => userLayer.layoutTemplates(),
  })
  await template.load()
  let n = 0
  const tasks = createTasksService({ file: join(dir, 'tasks.json'), now: () => NOW_SEC, newId: () => `t-${++n}` })
  const behaviorLog = createBehaviorLog({ dir: join(dir, '行为账') })
  const lines: string[] = []
  vi.spyOn(console, 'log').mockImplementation((line: unknown) => { lines.push(String(line)) })
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService({ now: () => NOW_SEC }),
    tickIntervalMs: 0,
    template,
    tasks,
    behaviorLog,
    projects: {
      getProjectsState: () => Promise.resolve({ projects: [], pending: [], scan_errors: [], scanned_at: new Date(NOW_SEC * 1000).toISOString() }),
      confirmStatus: () => Promise.resolve(false),
      setDdl: () => Promise.resolve(false),
      addRule: () => Promise.resolve(),
      getLayout: () => Promise.resolve(saved),
      setLayout: (next: WorkbenchLayout) => { saved = next; return Promise.resolve() },
      invalidateScanCache: () => {},
    },
    actorTokens: { butler: 'butler-token', worker: 'worker-token' },
    paths: { home: dir },
  } as never)
  started.push(server)
  const applied = await fetch(`${server.url}/template/apply`, { method: 'POST', headers: { 'content-type': 'application/json', ...SHELL }, body: JSON.stringify({ id: 'ops' }) })
  expect(applied.status).toBe(200)
  return { url: server.url, tasks, behaviorLog, lines, layout: () => saved }
}

async function state(url: string): Promise<WorkbenchState> {
  return await (await fetch(`${url}/state`)).json() as WorkbenchState
}

/** 她在电脑上点的(壳里的页面)。 */
const SHELL = { 'user-agent': 'BenWorkbenchShell/1.0' }

function post(url: string, path: string, body: unknown, headers: Record<string, string> = SHELL) {
  return fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
}

describe('POST /today/view', () => {
  it('切到卡片:存进布局、/state 跟着换、分组带着明天的那件;再切回列表', async () => {
    const { url, tasks, layout } = await serve()
    const today = localDayOf(new Date(NOW_SEC * 1000))
    await tasks.create({ title: '回三条评论', due: today })
    await tasks.create({ title: '剪片头', due: nextDayOf(today) })
    expect((await state(url)).today_todos?.style).toBe('flat')

    const res = await post(url, '/today/view', { view: 'by_date' })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, view: 'by_date', changed: true })
    expect(layout()?.today_view).toBe('by_date')
    const view = (await state(url)).today_todos
    expect(view?.style).toBe('by_date')
    expect(view?.groups?.find(one => one.key === 'tomorrow')?.items.map(one => one.title)).toEqual(['剪片头'])

    const back = await post(url, '/today/view', { view: 'flat' })
    expect(await back.json()).toMatchObject({ ok: true, view: 'flat', changed: true })
    expect((await state(url)).today_todos?.style).toBe('flat')
  })

  it('已经是那一版:照回 ok、changed:false,不再存一份', async () => {
    const { url } = await serve()
    const res = await post(url, '/today/view', { view: 'flat' })
    expect(await res.json()).toMatchObject({ ok: true, view: 'flat', changed: false })
  })

  it('认不出的版本 → 400,布局不动', async () => {
    const { url, layout } = await serve()
    const res = await post(url, '/today/view', { view: 'grid' })
    expect(res.status).toBe(400)
    expect(layout()?.today_view).toBeUndefined()
  })

  it('电话里切(工人回环):记一行日志 + 行为账一条「改版面」,端是电话', async () => {
    const { url, behaviorLog, lines } = await serve()
    await post(url, '/today/view', { view: 'by_date' }, { 'x-workbench-actor': 'worker-token' })
    expect(lines.some(line => line.includes('今天的待办') && line.includes('卡片'))).toBe(true)
    await behaviorLog.flush()
    const entries = await behaviorLog.read({ 事: BEHAVIOR_EVENTS.layout })
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ 事: '改版面', 对象: '今天的待办', 结果: '卡片' })
  })

  it('整份 POST /layout(拖格子)不把它冲掉;/layout/undo 切回上一版', async () => {
    const { url, layout } = await serve()
    await post(url, '/today/view', { view: 'by_date' })
    const whole = (await state(url)).layout as WorkbenchLayout
    expect(whole.today_view).toBe('by_date')
    const saved = await post(url, '/layout', { layout: whole })
    expect(await saved.text()).toContain('"ok":true')
    expect(layout()?.today_view).toBe('by_date')

    expect((await post(url, '/layout/undo', {})).status).toBe(200)
    expect((await state(url)).today_todos?.style).toBe('flat')
  })
})

/* ──────── 新说法:卡片 / 列表(2026-10-13,卡 I)──────── */

describe('「卡片 / 列表」认得出,老说法也还认', () => {
  it('卡片那几句 → by_date', () => {
    expect(todayViewAsked('把待办改成卡片')).toBe('by_date')
    expect(todayViewAsked('把今天的待办改成卡片式')).toBe('by_date')
    expect(todayViewAsked('待办切成卡片')).toBe('by_date')
  })

  it('列表那几句 → flat', () => {
    expect(todayViewAsked('待办改回列表')).toBe('flat')
    expect(todayViewAsked('改成列表')).toBe('flat')
    expect(todayViewAsked('把今天的待办换成列表')).toBe('flat')
  })

  it('老说法照旧:「按日期汇总」= 卡片,「不汇总 / 平铺」= 列表', () => {
    expect(todayViewAsked('把待办改成按日期汇总')).toBe('by_date')
    expect(todayViewAsked('改回不汇总')).toBe('flat')
  })

  it('一句里两个词都说了:后说的那个算(「从卡片改成列表」)', () => {
    expect(todayViewAsked('待办从卡片改成列表')).toBe('flat')
    expect(todayViewAsked('待办从列表改成卡片')).toBe('by_date')
  })

  it('光说那一格的名字不算要换:「待办列表给我念一遍」不切', () => {
    expect(todayViewAsked('待办列表给我念一遍')).toBeUndefined()
    expect(todayViewAsked('今天的待办列表')).toBeUndefined()
    expect(todayViewAsked('待办改成卡片吗?')).toBeUndefined()
  })

  it('说的是别的那一格不切:「把看板改成卡片」', () => {
    expect(todayViewAsked('把看板改成卡片')).toBeUndefined()
    expect(todayViewAsked('发布计划改成列表')).toBeUndefined()
  })
})

/* ──────── 词表放宽(2026-10-13 真机那几句,卡 B)──────── */

describe('「按日期 / 平铺」配上「改 / 切 / 换」就认', () => {
  it('★「改回那个按日期吧」认得出(10-13 下午这一句没认,落到模型路多等 6 秒)', () => {
    expect(todayViewAsked('改回那个按日期吧')).toBe('by_date')
    expect(todayViewAsked('切成按日期')).toBe('by_date')
    expect(todayViewAsked('换成按日期的')).toBe('by_date')
  })

  it('★「改成平铺的」「改回平铺」照旧认(10-13 下午这两句认了)', () => {
    expect(todayViewAsked('改成平铺的')).toBe('flat')
    expect(todayViewAsked('改回平铺')).toBe('flat')
  })

  it('★光一句「改回去」仍不认 —— 什么都能指,交给模型(老规矩没松)', () => {
    expect(todayViewAsked('改回去')).toBeUndefined()
    expect(todayViewAsked('改回那个')).toBeUndefined()
  })

  it('提到的是别的那一格就不认:「把发布计划改成按日期排」不切待办', () => {
    expect(todayViewAsked('把发布计划改成按日期排')).toBeUndefined()
    expect(todayViewAsked('月历改成按日期')).toBeUndefined()
  })

  it('问话不切;提到待办那一格的照旧认', () => {
    expect(todayViewAsked('待办是按日期汇总的吗?')).toBeUndefined()
    expect(todayViewAsked('把今天的待办改成按日期汇总')).toBe('by_date')
    expect(todayViewAsked('把今天的待办改回去')).toBe('flat')
  })
})
