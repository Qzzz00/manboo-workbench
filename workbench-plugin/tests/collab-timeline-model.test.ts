// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { MeetingView, TaskView } from '../src/protocol.ts'
import {
  HALF_HOUR_PX, POINT_MINUTES, daysFor, dayKeyOf, layoutDay, maxLanesFor, meetingItem, timeRange, timelineItems, unscheduled, yOf,
  pastItems, railShownFor, RAIL_WIDTH, MAX_DAYS, DAY_MIN_WIDTH,
} from '../src/client/collab/timelineModel.ts'

const AT = '2026-10-21T01:00:00.000Z'
const local = (day: string, hm: string): string => new Date(`${day}T${hm}:00`).toISOString()
const note = (id: string, patch: Partial<TaskView> = {}): TaskView => ({ id, title: id, status: 'todo', source: { kind: 'manual' }, created_at: AT, updated_at: AT, ...patch })

describe('按容器宽度定显示天数', () => {
  it('400 → 1 天;714 / 840 → 2 天;窗口槽扣名片栏(1480−252)→ 3 天;再宽也最多 3 天', () => {
    expect(daysFor(400)).toBe(1)
    expect(daysFor(714)).toBe(2)
    expect(daysFor(840)).toBe(2)
    expect(daysFor(1480 - 252)).toBe(3)
    expect(daysFor(2400)).toBe(3)
    expect(daysFor(120)).toBe(1)
  })
})

describe('哪些便签上时间线', () => {
  it('有开始时刻才上;只有开始 = 时间点;都没有 = 未排时间', () => {
    const tasks = [
      note('a', { start: local('2026-10-21', '11:00'), end: local('2026-10-21', '12:00') }),
      note('b', { start: local('2026-10-21', '14:00') }),
      note('c'),
      note('d', { start: local('2026-10-21', '09:00'), casual: true }),
    ]
    const items = timelineItems(tasks, [])
    expect(items.map(one => [one.id, one.point])).toEqual([['a', false], ['b', true]])
    expect(unscheduled(tasks).map(one => one.id)).toEqual(['c'])
  })
  it('会议:会前按排期时刻,会后按开始 / 结束;是一张卡', () => {
    const planned = { id: 'm1', title: '取舍会', date: '2026-10-21', started_at: local('2026-10-21', '10:00'), status: 'planned', segments: 0, todos: [], unsure: [], prep: { said: 'x', scheduled_at: local('2026-10-21', '15:00'), card_status: 'answers' } } as unknown as MeetingView
    expect(meetingItem(planned)).toMatchObject({ kind: 'meeting', id: 'm1', point: true })
    expect(meetingItem(planned)?.start).toBe(Date.parse(local('2026-10-21', '15:00')))
    const done = { id: 'm2', title: '周复盘', date: '2026-10-21', started_at: local('2026-10-21', '16:00'), ended_at: local('2026-10-21', '16:40'), status: 'done', segments: 3, todos: [], unsure: [] } as unknown as MeetingView
    expect(meetingItem(done)).toMatchObject({ point: false, end: Date.parse(local('2026-10-21', '16:40')) })
  })
})

describe('同一天的排布:同刻并排、装不下收成「同刻 N 件」', () => {
  const at = (hm: string): number => Date.parse(local('2026-10-21', hm))
  const item = (id: string, from: string, to?: string) => ({ key: `note:${id}`, kind: 'note' as const, id, title: id, start: at(from), ...(to === undefined ? {} : { end: at(to) }), point: to === undefined })
  it('不重叠的各占整列;重叠的分到相邻两条道', () => {
    const out = layoutDay([item('a', '11:00', '12:00'), item('b', '11:30', '12:30'), item('c', '13:00', '14:00')], 2)
    expect(out.map(one => one.kind === 'item' ? [one.item.id, one.lane, one.lanes] : ['more'])).toEqual([['a', 0, 2], ['b', 1, 2], ['c', 0, 1]])
  })
  it('时间点按 30 分钟占位算重叠(不暗示工期)', () => {
    expect(POINT_MINUTES).toBe(30)
    const out = layoutDay([item('a', '11:00'), item('b', '11:15')], 2)
    expect(out.map(one => one.kind === 'item' ? one.lanes : 0)).toEqual([2, 2])
  })
  it('三件同刻、只装得下两条道 → 一块「同刻 3 件」,里面三件都在', () => {
    const out = layoutDay([item('a', '11:00', '12:00'), item('b', '11:00', '12:00'), item('c', '11:00', '12:00')], 2)
    expect(out).toHaveLength(1)
    const more = out[0]
    expect(more?.kind).toBe('more')
    if (more?.kind !== 'more') return
    expect(more.count).toBe(3)
    expect(more.items.map(one => one.id)).toEqual(['a', 'b', 'c'])
  })
  it('一列能放几条道:150 一条', () => {
    expect(maxLanesFor(312)).toBe(2)
    expect(maxLanesFor(140)).toBe(1)
    expect(maxLanesFor(500)).toBe(3)
  })
})

describe('共用时间刻度', () => {
  it('默认 9:00–18:00,有更早 / 更晚的就撑开,按半点取整', () => {
    const at = (hm: string): number => Date.parse(local('2026-10-21', hm))
    const range = timeRange([{ start: at('08:10'), end: at('19:20') }])
    expect(range.fromMinutes).toBe(8 * 60)
    expect(range.toMinutes).toBe(19 * 60 + 30)
    expect(timeRange([]).fromMinutes).toBe(9 * 60)
  })
  it('30 分钟 58 像素', () => {
    expect(HALF_HOUR_PX).toBe(58)
    expect(yOf(10 * 60, { fromMinutes: 9 * 60, toMinutes: 18 * 60 })).toBe(116)
  })
  it('本地日期键', () => {
    expect(dayKeyOf(Date.parse(local('2026-10-21', '23:59')))).toBe('2026-10-21')
  })
})

describe('已发生的经过与未来安排同屏', () => {
  const NOW = Date.parse('2026-10-21T12:00:00.000Z')
  const session = (patch: Record<string, unknown>) => ({ agent: 'codex', session_id: 's1', project: 'p', status: 'running', elapsed_sec: 1800, unread: false, updated_at: '2026-10-21T11:58:00.000Z', title: '修歌词错位', ...patch }) as never
  it('在跑的会话:从进入在跑那一刻到现在;别的状态只在最后动静那一刻落一点;工作台自检的不上', () => {
    const items = pastItems([], [session({}), session({ session_id: 's2', status: 'done', title: undefined }), session({ session_id: 's3', selfcheck: { kind: 'caps' } })], NOW)
    const running = items.find(one => one.id === 'codex:s1')
    expect(running).toMatchObject({ kind: 'session', start: NOW - 1800_000, end: NOW, point: false, title: '修歌词错位' })
    expect(items.find(one => one.id === 'codex:s2')).toMatchObject({ kind: 'session', start: Date.parse('2026-10-21T11:58:00.000Z'), point: true })
    expect(items.some(one => one.id === 'codex:s3')).toBe(false)
  })
  it('任务账:交回那一刻落一点(做完 / 卡住 / 有异议);没交回的不编时间', () => {
    const tasks = [
      { id: 't1', title: '提机接通', status: 'confirm', source: { kind: 'manual' }, created_at: '', updated_at: '', receipt: { kind: 'done', text: '做完:1', at: '2026-10-21T08:30:00.000Z', by: 'claude' } },
      { id: 't2', title: '没交回', status: 'doing', source: { kind: 'manual' }, created_at: '', updated_at: '' },
    ] as never
    const items = pastItems(tasks, [], NOW)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'event', id: 't1', start: Date.parse('2026-10-21T08:30:00.000Z'), point: true, title: '交回 · 提机接通' })
  })
  it('将来的时刻不算「经过」(钟不准时不把未来画成已发生)', () => {
    expect(pastItems([], [session({ status: 'done', updated_at: '2026-10-21T13:00:00.000Z' })], NOW)).toEqual([])
  })
})

describe('一套组件、三种摆法:按容器宽度定密度', () => {
  it('名片栏只在扣掉它还放得下三天时露出;窄了收成入口', () => {
    expect(railShownFor(400)).toBe(false)
    expect(railShownFor(714)).toBe(false)
    expect(railShownFor(840)).toBe(false)
    expect(railShownFor(RAIL_WIDTH + MAX_DAYS * DAY_MIN_WIDTH)).toBe(true)
  })
  it('天数:400 → 1、714 / 840 → 2、窗口槽扣名片栏 → 3', () => {
    expect(daysFor(400)).toBe(1)
    expect(daysFor(714)).toBe(2)
    expect(daysFor(840)).toBe(2)
    expect(daysFor(1480 - RAIL_WIDTH)).toBe(3)
  })
})
