// 协作区「目标」视图的显示区域(2026-10-28 统筹退修,真机 1440×2560 竖屏、目标 11/32、板上 150 张卡、21 件进行中):
// ① 画布从区域顶部裁掉卡,只露一张卡的下半截;② 轨迹一直「在读执行记录……」—— 服务端 2.1 秒就回了,
//    客户端每秒一份新快照就丢掉在途的那次读,慢于 1 秒的口永远落不了地;③ 三截纵向空间都没把内容放出来。
import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GoalTraceView, MeetingView, RunSegment, TaskView } from '../src/protocol.ts'
import type { CollabApi } from '../src/client/collab/collabApi.ts'
import { TRACE_SLOW_MS, TraceRail } from '../src/client/collab/TraceRail.tsx'
import { readTraceView } from '../src/client/collab/traceRows.ts'
import { GOAL_VIEW_PAD, MIN_READABLE_ZOOM, goalViewport } from '../src/client/collab/boardViewport.ts'
import { OccupancyView } from '../src/client/collab/OccupancyView.tsx'
import { BIG_DAY, bigBoardRuns, bigBoardTasks, bigBoardTrace } from './fixtures/bigGoalBoard.ts'

afterEach(() => { cleanup(); vi.useRealTimers() })

/** 一个手动放行的口:每次 get 都挂起,`release(i, body)` 才回。 */
function slowApi() {
  const calls: { path: string, resolve: (body: unknown) => void }[] = []
  const api: CollabApi = {
    get: (path: string) => new Promise(resolve => { calls.push({ path, resolve: resolve as (body: unknown) => void }) }) as never,
    post: async () => ({ ok: true, body: {} }),
  }
  return { api, calls }
}

const tasks = bigBoardTasks()
const goalTasks = tasks.filter(one => one.goal_id === 'g1')
const trace = bigBoardTrace(tasks)
/** 第 n 份快照:事项内容随快照变(updated_at 往前走),像真机上 21 件在跑时那样。 */
const snap = (n: number): TaskView[] => goalTasks.map(one => (one.status === 'doing' ? { ...one, updated_at: new Date(Date.parse(one.updated_at) + n * 1000).toISOString() } : one))
const rail = (api: CollabApi, n: number, list: readonly TaskView[] = snap(n)) =>
  <TraceRail api={api} goalId="g1" tasks={list} nameOf={String} onOpen={() => {}} width={300} height={1800} />

describe('夹具照真机形状', () => {
  it('150 张卡、目标 32 件(21 进行中、11 已完成)、轨迹回包约 36 KB', () => {
    expect(tasks).toHaveLength(150)
    expect(goalTasks.filter(one => one.status === 'doing')).toHaveLength(21)
    expect(goalTasks.filter(one => one.status === 'done')).toHaveLength(11)
    const size = new TextEncoder().encode(JSON.stringify(trace)).length // 真机量的是字节
    expect(size).toBeGreaterThan(30_000)
    expect(size).toBeLessThan(45_000)
  })
})

describe('事项轨迹:慢口也能落地', () => {
  it('★事项每秒都在变、轨迹 2 秒多才回:回包照样画出来,不被下一份快照丢掉;在途时变了只在回来后再读一次', async () => {
    const { api, calls } = slowApi()
    const view = render(rail(api, 1))
    view.rerender(rail(api, 2))
    view.rerender(rail(api, 3))
    expect(calls).toHaveLength(1) // 在途时不另起;变了的记一笔,回来再读一次
    await act(async () => { calls[0]!.resolve(trace) })
    expect(await screen.findAllByRole('group', { name: / 的轨迹$/ })).toHaveLength(21)
    expect(screen.getByRole('group', { name: '第 1 件 · 内部同学试用里冒出来的事 的轨迹' })).toHaveTextContent('开工')
    expect(calls).toHaveLength(2)
  })
  it('★36 KB 回包里一行坏数据:只那一行标「读不出」,其余照画', async () => {
    const broken: unknown = { ...trace, traces: trace.traces.map((one, i) => (i === 3 ? { task_id: one.task_id, nodes: 'oops', current: null } : i === 5 ? { ...one, nodes: [{ at: 1, kind: 'start', evidence: 'x' }] } : one)) }
    const { api, calls } = slowApi()
    render(rail(api, 1))
    await act(async () => { calls[0]!.resolve(broken) })
    const bad = await screen.findByRole('group', { name: '第 4 件 · 内部同学试用里冒出来的事 的轨迹' })
    expect(bad).toHaveTextContent('这件的执行记录读不出')
    expect(screen.getByRole('group', { name: '第 6 件 · 内部同学试用里冒出来的事 的轨迹' })).toHaveTextContent('这件的执行记录读不出')
    expect(screen.getByRole('group', { name: '第 1 件 · 内部同学试用里冒出来的事 的轨迹' })).toHaveTextContent('开工')
    expect(screen.getAllByRole('group', { name: / 的轨迹$/ })).toHaveLength(21)
  })
  it('readTraceView:整包不是轨迹就是取不到;单行坏的记成 bad,不连坐', () => {
    expect(readTraceView({ error: 'x' })).toBeUndefined()
    const got = readTraceView({ goal_id: 'g1', traces: [trace.traces[0], { task_id: 'zz', nodes: [{ at: 'x', kind: 'nope' }], current: { state: 'running' } }] })
    expect(got?.get('b0')).toEqual(trace.traces[0])
    expect(got?.get('zz')).toBe('bad')
  })
  it('★读中:先把进行中的事项一件一条摆出来(不留大片空白),说已读了几秒;超过 5 秒如实说慢在哪', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false })
    const { api } = slowApi()
    render(rail(api, 1))
    const region = screen.getByRole('region', { name: '事项轨迹' })
    expect(within(region).getAllByRole('group', { name: / 的轨迹$/ })).toHaveLength(21)
    expect(within(region).getByRole('status')).toHaveTextContent('在读执行记录')
    act(() => { vi.advanceTimersByTime(3000) })
    expect(within(region).getByRole('status')).toHaveTextContent('已读 3 秒')
    act(() => { vi.advanceTimersByTime(TRACE_SLOW_MS) })
    expect(within(region).getByRole('status')).toHaveTextContent('/collab/trace')
    expect(within(region).getByRole('status')).toHaveTextContent('还没回')
  })
  it('★重读时留着上次快照:节点照显示,只多一句「更新中」', async () => {
    const { api, calls } = slowApi()
    const view = render(rail(api, 1))
    await act(async () => { calls[0]!.resolve(trace) })
    await screen.findAllByRole('group', { name: / 的轨迹$/ })
    view.rerender(rail(api, 2))
    expect(calls).toHaveLength(2)
    expect(screen.getByRole('group', { name: '第 1 件 · 内部同学试用里冒出来的事 的轨迹' })).toHaveTextContent('开工')
    expect(screen.getByRole('region', { name: '事项轨迹' })).toHaveTextContent('更新中')
  })
  it('★快照对象换了、事项内容没变:不重读(否则慢口一读完立刻再读,一直在读)', async () => {
    const { api, calls } = slowApi()
    const same = snap(0)
    const view = render(rail(api, 0, same))
    await act(async () => { calls[0]!.resolve(trace) })
    await screen.findAllByRole('group', { name: / 的轨迹$/ })
    view.rerender(rail(api, 0, [...same]))
    view.rerender(rail(api, 0, same.map(one => ({ ...one }))))
    expect(calls).toHaveLength(1)
    expect(screen.queryByText(/更新中/)).toBeNull()
  })
  it('换了目标:上一个目标的回包不落到这个目标上', async () => {
    const { api, calls } = slowApi()
    const view = render(rail(api, 1))
    view.rerender(<TraceRail api={api} goalId="g2" tasks={tasks.filter(one => one.goal_id === 'g2').slice(0, 2)} nameOf={String} onOpen={() => {}} width={300} height={1800} />)
    await act(async () => { calls[0]!.resolve(trace) })
    await waitFor(() => expect(calls).toHaveLength(2))
    expect(calls[1]!.path).toContain('goal_id=g2')
    expect(screen.queryByText('开工')).toBeNull()
  })
})

describe('兄弟路:时间线「人和 Agent 占用」读执行片段(1.6 秒)也不被快照丢掉', () => {
  it('★tasks 每秒换一份新数组,片段照样落地', async () => {
    const { api, calls } = slowApi()
    const runs: RunSegment[] = bigBoardRuns(tasks)
    const view = (list: TaskView[]) => <OccupancyView api={api} tasks={list} meetings={[] as MeetingView[]} dayKey={BIG_DAY} nowMs={Date.parse(`${BIG_DAY}T06:00:00.000Z`)} width={1200} height={600} onOpenNote={() => {}} onOpenMeeting={() => {}} />
    const first = render(view([...goalTasks]))
    first.rerender(view([...goalTasks]))
    first.rerender(view([...goalTasks]))
    await act(async () => { for (const call of calls) call.resolve({ runs }) })
    expect((await screen.findAllByRole('button', { name: /^实际 · / })).length).toBeGreaterThan(0)
  })
})

describe('画布的初始视野:对准当前目标、从它顶上开始、字读得清', () => {
  it('★高的目标区:顶对齐在区域上沿,不从中间裁', () => {
    const vp = goalViewport({ x: 400, y: 1200, width: 900, height: 6000 }, { width: 1140, height: 1500 })
    expect(vp.y + 1200 * vp.zoom).toBeCloseTo(GOAL_VIEW_PAD)
    expect(vp.zoom).toBeGreaterThanOrEqual(MIN_READABLE_ZOOM)
    expect(vp.zoom).toBeLessThanOrEqual(1)
    expect(vp.x + 400 * vp.zoom).toBeGreaterThanOrEqual(0)
  })
  it('宽于区域的目标:按宽度缩到放得下,但不小于读得清的下限', () => {
    const vp = goalViewport({ x: 0, y: 0, width: 3000, height: 400 }, { width: 700, height: 500 })
    expect(vp.zoom).toBe(MIN_READABLE_ZOOM)
    const fits = goalViewport({ x: 0, y: 0, width: 1200, height: 400 }, { width: 1000, height: 500 })
    expect(1200 * fits.zoom).toBeLessThanOrEqual(1000 - 2 * GOAL_VIEW_PAD + 0.001)
  })
  it('矮小的目标:不放大超过 1,水平居中', () => {
    const vp = goalViewport({ x: 0, y: 0, width: 400, height: 300 }, { width: 1000, height: 800 })
    expect(vp.zoom).toBe(1)
    expect(vp.x).toBeCloseTo(300)
  })
})
