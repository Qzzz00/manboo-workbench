// 时间占用里同一子列的重叠排布(2026-10-28 统筹退修:真机小K「计划」一格叠了四五块,字糊成一团)。
// 机制:按子列(计划 / 实际)把相交的区间连成一簇,簇内贪心分小列(起止不交的复用);一簇超过上限只并列前几列,
// 其余收成一枚「+N 件」。两份布局(人和 Agent 占用 / 按日期日程)共用同一个排布纯函数 packLanes。
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RunSegment, TaskView } from '../src/protocol.ts'
import { packLanes } from '../src/client/collab/lanePack.ts'
import { OCC_MAX_LANES, occupancyRows } from '../src/client/collab/occupancyModel.ts'
import { OCC_COLUMN_LANE_PX, OCC_LINE_PX, OccupancyView } from '../src/client/collab/OccupancyView.tsx'
import type { CollabApi } from '../src/client/collab/collabApi.ts'

afterEach(cleanup)
const day = '2026-10-27'
const T = (hhmm: string, d = day) => new Date(`${d}T${hhmm}:00`).toISOString()
const ms = (hhmm: string, d = day) => Date.parse(T(hhmm, d))
const span = (id: string, a: string, b: string, d1 = day, d2 = d1) => ({ id, start: ms(a, d1), end: ms(b, d2) })
const placed = (items: ReturnType<typeof span>[]) => packLanes(items).flatMap(c => c.placed.map(p => [p.item.id, p.lane, c.lanes]))

describe('packLanes(共用的区间排布)', () => {
  it('两件相交:各占一列,列数 2', () => {
    expect(placed([span('a', '09:00', '10:00'), span('b', '09:30', '10:30')])).toEqual([['a', 0, 2], ['b', 1, 2]])
  })
  it('三件链式相交(a∩b、b∩c,a 与 c 不交):同一簇,c 复用 a 那一列,列数 2', () => {
    expect(placed([span('a', '09:00', '10:00'), span('b', '09:30', '10:30'), span('c', '10:15', '11:00')])).toEqual([['a', 0, 2], ['b', 1, 2], ['c', 0, 2]])
    expect(packLanes([span('a', '09:00', '10:00'), span('b', '09:30', '10:30'), span('c', '10:15', '11:00')])).toHaveLength(1)
  })
  it('互不相交(首尾相接也算不交):各自一簇、都在第 0 列,列数 1', () => {
    expect(placed([span('a', '09:00', '10:00'), span('b', '10:00', '11:00'), span('c', '13:00', '14:00')])).toEqual([['a', 0, 1], ['b', 0, 1], ['c', 0, 1]])
  })
  it('跨午夜:前一天 23:00–次日 01:00 与 00:30–02:00 相交', () => {
    const out = placed([span('b', '00:30', '02:00', '2026-10-28'), span('a', '23:00', '01:00', day, '2026-10-28')])
    expect(out).toEqual([['a', 0, 2], ['b', 1, 2]])
  })
})

const task = (id: string, patch: Partial<TaskView> = {}): TaskView => ({ id, title: `事项${id}`, status: 'todo', source: { kind: 'manual' }, created_at: T('08:00'), updated_at: T('08:00'), goal_id: 'g1', ...patch })
const five = ['1', '2', '3', '4', '5'].map(n => task(`t${n}`, { assignee: 'kimi', start: T('09:00'), end: T('13:00') }))

describe('occupancyRows 的列序与「+N 件」', () => {
  it('★每块带列序与列数;超过 OCC_MAX_LANES 的收进一枚「+N」,落在簇的时段上', () => {
    const { rows } = occupancyRows({ tasks: five, meetings: [], runs: [], dayKey: day, nowMs: ms('14:00') })
    const kimi = rows.find(r => r.id === 'kimi')!
    expect(kimi.plan).toHaveLength(OCC_MAX_LANES)
    expect(kimi.plan.map(b => [b.lane, b.lanes])).toEqual(Array.from({ length: OCC_MAX_LANES }, (_, i) => [i, OCC_MAX_LANES + 1]))
    expect(kimi.planMore).toEqual([expect.objectContaining({ count: 5 - OCC_MAX_LANES, lane: OCC_MAX_LANES, lanes: OCC_MAX_LANES + 1, start: ms('09:00'), end: ms('13:00') })])
    expect(kimi.planMore[0]!.items.map(b => b.title)).toEqual(['事项t4', '事项t5'])
    expect(kimi.actualMore).toEqual([])
  })
  it('不超上限就不收:三件并列各 1/3', () => {
    const { rows } = occupancyRows({ tasks: five.slice(0, OCC_MAX_LANES), meetings: [], runs: [], dayKey: day, nowMs: ms('14:00') })
    const kimi = rows.find(r => r.id === 'kimi')!
    expect(kimi.plan.map(b => b.lanes)).toEqual(Array(OCC_MAX_LANES).fill(OCC_MAX_LANES))
    expect(kimi.planMore).toEqual([])
  })
  it('计划与实际分开排:实际一件不受计划的重叠影响', () => {
    const runs: RunSegment[] = [{ task_id: 't1', source: 'kimi', agent: 'kimi', status: 'done', started_at: T('09:00'), execution_started_observed_at: T('09:10'), execution_finished_observed_at: T('09:50') }]
    const { rows } = occupancyRows({ tasks: five.slice(0, 2), meetings: [], runs, dayKey: day, nowMs: ms('14:00') })
    expect(rows.find(r => r.id === 'kimi')!.actual.map(b => [b.lane, b.lanes])).toEqual([[0, 1]])
  })
})

describe('OccupancyView 的排布', () => {
  const api: CollabApi = { get: async () => ({ runs: [] }) as never, post: async () => ({ ok: true, body: {} }) as never } as CollabApi
  it('★横排:同时段的块按列分开,不再叠在同一位置;「+N 件」点开列出标题,点标题打开那件', async () => {
    const open = vi.fn()
    render(<OccupancyView api={api} tasks={five} meetings={[]} dayKey={day} nowMs={ms('14:00')} width={1200} height={600} onOpenNote={open} onOpenMeeting={() => {}} />)
    const row = await screen.findByRole('group', { name: /Kimi/ })
    const bars = within(row).getAllByRole('button', { name: /^计划 · 事项/ })
    expect(bars).toHaveLength(OCC_MAX_LANES)
    expect(new Set(bars.map(b => b.style.top)).size).toBe(OCC_MAX_LANES)
    const more = within(row).getByRole('button', { name: `计划 · 同时段另有 ${5 - OCC_MAX_LANES} 件` })
    expect(more).toHaveTextContent(`+${5 - OCC_MAX_LANES} 件`)
    expect(more).toHaveAttribute('title', expect.stringContaining('事项t4'))
    await userEvent.click(more)
    const list = within(row).getByRole('list', { name: '同时段另有的事项' })
    await userEvent.click(within(list).getByRole('button', { name: '事项t5' }))
    expect(open).toHaveBeenCalledWith('t5')
  })
  it('竖排:并列的块按 left / width 分开;矮于一行字高的块只画色块不写字', () => {
    const shortMin = Math.floor((OCC_LINE_PX - 1) / OCC_COLUMN_LANE_PX * 9 * 60) // 9:00–18:00 九小时窗里矮于一行字高的分钟数
    const tasks = [
      ...five.slice(0, 2),
      task('tiny', { assignee: 'kimi', start: T('15:00'), end: new Date(ms('15:00') + shortMin * 60_000).toISOString() }),
    ]
    render(<OccupancyView api={api} tasks={tasks} meetings={[]} dayKey={day} nowMs={ms('18:00')} width={600} height={1000} onOpenNote={() => {}} onOpenMeeting={() => {}} />)
    const [a, b] = screen.getAllByRole('button', { name: /^计划 · 事项t[12]$/ })
    expect(a!.style.left).not.toBe(b!.style.left)
    expect(a).toHaveTextContent('事项t1')
    const tiny = screen.getByRole('button', { name: '计划 · 事项tiny' })
    expect(tiny).toHaveAttribute('data-short', 'true')
    expect(tiny).toHaveTextContent('')
  })
})
