// 人和 Agent 的时间占用(2026-10-27,合并稿 ④,原型 repair-time-wide / repair-time-portrait):
// 每个参与者两条 —— 计划(task.start/end、会议)虚线,实际(运行片段里核到的开工到交回)实心。
// 没有开工证据的不画实心;在跑的只画到现在;不把任务持续时间当作一直在跑。方向按容器宽高:宽 → 时间横排,高 → 时间竖排。
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MeetingView, RunSegment, TaskView } from '../src/protocol.ts'
import { occupancyRows } from '../src/client/collab/occupancyModel.ts'
import { OccupancyView } from '../src/client/collab/OccupancyView.tsx'
import type { CollabApi } from '../src/client/collab/collabApi.ts'
import { CollabZone } from '../src/client/collab/CollabZone.tsx'
import type { WorkbenchState } from '../src/protocol.ts'

afterEach(cleanup)
const day = '2026-10-27'
const T = (hhmm: string) => new Date(`${day}T${hhmm}:00`).toISOString()
const ms = (hhmm: string) => Date.parse(T(hhmm))
const task = (id: string, patch: Partial<TaskView> = {}): TaskView => ({ id, title: `事项${id}`, status: 'doing', source: { kind: 'manual' }, created_at: T('08:00'), updated_at: T('08:00'), goal_id: 'g1', ...patch })
const run = (patch: Partial<RunSegment>): RunSegment => ({ task_id: 't1', source: 'kimi', agent: 'kimi', status: 'done', started_at: T('09:00'), ...patch })

describe('occupancyRows', () => {
  it('★计划按负责人进行;实际只认核到的开工到交回', () => {
    const tasks = [task('t1', { assignee: 'kimi', start: T('09:00'), end: T('11:00') })]
    const runs = [run({ execution_started_observed_at: T('09:20'), execution_finished_observed_at: T('10:40') })]
    const { rows } = occupancyRows({ tasks, meetings: [], runs, dayKey: day, nowMs: ms('12:00') })
    const kimi = rows.find(r => r.id === 'kimi')!
    expect(kimi.plan).toEqual([expect.objectContaining({ taskId: 't1', start: ms('09:00'), end: ms('11:00') })])
    expect(kimi.actual).toEqual([expect.objectContaining({ taskId: 't1', start: ms('09:20'), end: ms('10:40'), open: false })])
  })
  it('★没有开工证据(只派出)不画实际;在跑的只画到现在,标 open', () => {
    const runs = [
      run({ task_id: 't1', status: 'dispatched' }),
      run({ task_id: 't2', agent: 'codex', source: 'codex', status: 'running', execution_started_observed_at: T('10:00') }),
    ]
    const { rows } = occupancyRows({ tasks: [task('t1'), task('t2')], meetings: [], runs, dayKey: day, nowMs: ms('11:30') })
    expect(rows.find(r => r.id === 'kimi')?.actual ?? []).toEqual([])
    expect(rows.find(r => r.id === 'codex')!.actual).toEqual([expect.objectContaining({ start: ms('10:00'), end: ms('11:30'), open: true })])
  })
  it('收场了但没核到交回:实际只到收场那一刻,不补到计划结束', () => {
    const runs = [run({ status: 'failed', execution_started_observed_at: T('09:10'), finished_at: T('09:40') })]
    const { rows } = occupancyRows({ tasks: [task('t1', { assignee: 'kimi', start: T('09:00'), end: T('12:00') })], meetings: [], runs, dayKey: day, nowMs: ms('13:00') })
    expect(rows.find(r => r.id === 'kimi')!.actual[0]).toEqual(expect.objectContaining({ end: ms('09:40'), open: false }))
  })
  it('来源不明(agent 缺席且 source unknown)不编一行', () => {
    const { agent: _agent, ...anon } = run({ source: 'unknown', execution_started_observed_at: T('09:10') })
    const runs = [anon]
    const { rows } = occupancyRows({ tasks: [task('t1')], meetings: [], runs, dayKey: day, nowMs: ms('13:00') })
    expect(rows.some(r => r.id === 'unknown')).toBe(false)
  })
  it('会议算「你」的计划;别的日子的不算;「你」排第一', () => {
    const meeting = { id: 'm1', title: '周会', status: 'planned', prep: { scheduled_at: T('14:00') } } as unknown as MeetingView
    const tasks = [task('t1', { assignee: 'kimi', start: T('09:00'), end: T('10:00') }), task('t3', { assignee: 'kimi', start: '2026-10-28T09:00:00.000Z', end: '2026-10-28T10:00:00.000Z' })]
    const { rows } = occupancyRows({ tasks, meetings: [meeting], runs: [], dayKey: day, nowMs: ms('12:00') })
    expect(rows[0]!.id).toBe('me')
    expect(rows[0]!.plan).toEqual([expect.objectContaining({ meetingId: 'm1', start: ms('14:00') })])
    expect(rows.find(r => r.id === 'kimi')!.plan).toHaveLength(1)
  })
  it('时间窗按整点包住所有条与现在;什么都没有时 9:00–18:00', () => {
    const tasks = [task('t1', { assignee: 'kimi', start: T('09:30'), end: T('15:10') })]
    const got = occupancyRows({ tasks, meetings: [], runs: [], dayKey: day, nowMs: ms('16:20') })
    expect([got.from, got.to]).toEqual([ms('09:00'), ms('17:00')])
    const empty = occupancyRows({ tasks: [], meetings: [], runs: [], dayKey: day, nowMs: Date.parse('2026-10-26T12:00:00') })
    expect([empty.from, empty.to]).toEqual([ms('09:00'), ms('18:00')])
  })
})

describe('OccupancyView', () => {
  const tasks = [task('t1', { assignee: 'kimi', start: T('09:00'), end: T('11:00') })]
  const apiWith = (runs: RunSegment[] | undefined): CollabApi => ({ get: async () => (runs === undefined ? undefined : { runs }) as never, post: async () => ({ ok: true, body: {} }) as never } as CollabApi)
  it('★宽容器:时间横排(data-dir=row);每人两条,计划虚线、实际实心;点条打开那件', async () => {
    const open = vi.fn()
    render(<OccupancyView api={apiWith([run({ execution_started_observed_at: T('09:20'), execution_finished_observed_at: T('10:40') })])} tasks={tasks} meetings={[]} dayKey={day} nowMs={ms('12:00')} width={1200} height={600} onOpenNote={open} onOpenMeeting={() => {}} />)
    const view = screen.getByRole('region', { name: '人和 Agent 的时间占用' })
    expect(view).toHaveAttribute('data-dir', 'row')
    const row = await within(view).findByRole('group', { name: /Kimi/ })
    expect(within(row).getByRole('button', { name: '计划 · 事项t1' })).toHaveAttribute('data-kind', 'plan')
    const actual = await within(row).findByRole('button', { name: '实际 · 事项t1' })
    expect(actual).toHaveAttribute('data-kind', 'actual')
    await userEvent.click(actual)
    expect(open).toHaveBeenCalledWith('t1')
    expect(view).toHaveTextContent('虚线为计划占位,实色为实际执行;空白表示没有记录')
    expect(within(view).getByLabelText('现在')).toBeInTheDocument()
  })
  it('★高容器:时间竖排(data-dir=column)', () => {
    render(<OccupancyView api={apiWith([])} tasks={tasks} meetings={[]} dayKey={day} nowMs={ms('12:00')} width={600} height={1000} onOpenNote={() => {}} onOpenMeeting={() => {}} />)
    expect(screen.getByRole('region', { name: '人和 Agent 的时间占用' })).toHaveAttribute('data-dir', 'column')
  })
  it('执行账读不到:说读不到,计划照画,不画实际', async () => {
    render(<OccupancyView api={apiWith(undefined)} tasks={tasks} meetings={[]} dayKey={day} nowMs={ms('12:00')} width={1200} height={600} onOpenNote={() => {}} onOpenMeeting={() => {}} />)
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('执行账暂时读不到'))
    expect(screen.getByRole('button', { name: '计划 · 事项t1' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^实际 · / })).toBeNull()
  })
})

describe('协作区时间线里的摆法切换', () => {
  afterEach(() => { try { localStorage.clear() } catch { /* 无 */ } })
  it('★缺省就是人和 Agent 占用(决策记录 10-27);点「按日期」换成原来的日程,偏好记住', async () => {
    const at = '2026-10-27T02:00:00.000Z'
    const state = { now: at, sessions: [], tasks: { tasks: [task('t1', { assignee: 'kimi', start: T('09:00'), end: T('11:00') })], goals: [{ id: 'g1', title: '演示', status: 'active', created_at: at, updated_at: at }], agent_cards: [] } } as unknown as WorkbenchState
    const fetchImpl = (async () => new Response(JSON.stringify({ layout: { goals: {}, notes: {} }, runs: [], items: [] }))) as typeof fetch
    const view = render(<CollabZone state={state} baseUrl="http://test" fetchImpl={fetchImpl} visible initialView="timeline" presence={[]} />)
    expect(screen.getByRole('region', { name: '人和 Agent 的时间占用' })).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: '时间线' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: '按日期' }))
    expect(screen.getByRole('region', { name: '时间线' })).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: '人和 Agent 的时间占用' })).toBeNull()
    view.unmount()
    render(<CollabZone state={state} baseUrl="http://test" fetchImpl={fetchImpl} visible initialView="timeline" presence={[]} />)
    expect(screen.getByRole('region', { name: '时间线' })).toBeInTheDocument()
  })

})
