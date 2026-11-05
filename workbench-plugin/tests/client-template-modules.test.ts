// @vitest-environment node
/**
 * 三个新模块的纯函数那一层(2026-09-21 布局模板)。渲染那一层在 client-ops-landscape.test.tsx。
 *
 * 这一份守的都是"错一格就整月对不上"的东西:月历的周一开头与本地时区切天、
 * 事项按环节分组时**一张卡都不许丢**。
 */
import { describe, expect, it } from 'vitest'
import type { TaskView } from '../src/protocol.ts'
import { PUBLISH_VIEWS, isOverdue, monthCells, publishDayOf, shiftMonth, tasksByDue, tasksByPublishDay } from '../src/client/PublishModule.tsx'
import { TODO_UNASSIGNED_LANE, groupTasksByLane } from '../src/client/TodoModule.tsx'
import { laneModuleId, laneOfModuleId } from '../src/templates.ts'
import { loadStarterLayoutTemplate } from './helpers/starterLayer.ts'

const OPS_STAGES = (await loadStarterLayoutTemplate()).board_lanes

function task(over: Partial<TaskView> & { id: string }): TaskView {
  return {
    title: `卡 ${over.id}`,
    status: 'todo',
    source: { kind: 'manual' },
    created_at: '2026-09-21T02:00:00.000Z',
    updated_at: '2026-09-21T02:00:00.000Z',
    ...over,
  }
}

describe('月历的格子', () => {
  it('周一开头:2026-09-01 是周二,所以第一格是 8 月 31 日(周一)', () => {
    const cells = monthCells('2026-09')
    expect(cells[0]?.date).toBe('2026-08-31')
    expect(cells[0]?.inMonth).toBe(false)
    expect(cells[1]?.date).toBe('2026-09-01')
    expect(cells[1]?.inMonth).toBe(true)
  })

  it('整周:格子数一定是 7 的倍数', () => {
    for (const month of ['2026-01', '2026-02', '2026-09', '2027-02', '2028-02']) {
      expect(monthCells(month).length % 7).toBe(0)
    }
  })

  it('本月那几天一天不少、一天不多', () => {
    const inMonth = monthCells('2026-09').filter(cell => cell.inMonth)
    expect(inMonth.length).toBe(30)
    expect(inMonth[0]?.date).toBe('2026-09-01')
    expect(inMonth[29]?.date).toBe('2026-09-30')
  })

  it('闰年的二月:2028-02 有 29 天', () => {
    expect(monthCells('2028-02').filter(cell => cell.inMonth).length).toBe(29)
  })

  it('日期是**本地**日期,不是 UTC 切的那一天', () => {
    // 这一条钉的是 client/dates.ts 顶上那段:toISOString().slice(0,10) 在东八区
    // 每天 00:00–08:00 给的是昨天。格子的日期由本地 Date 拼,永远是那一天本身。
    const cells = monthCells('2026-09')
    const first = cells.find(cell => cell.inMonth)
    expect(first?.day).toBe(1)
    expect(first?.date.endsWith('-01')).toBe(true)
  })

  it('认不出的月份回空数组(不退回"这个月")', () => {
    expect(monthCells('')).toEqual([])
    expect(monthCells('2026-13')).toEqual([])
    expect(monthCells('2026/09')).toEqual([])
    expect(monthCells('九月')).toEqual([])
  })
})

describe('翻月', () => {
  it('前后各一个月,跨年也对', () => {
    expect(shiftMonth('2026-09', 1)).toBe('2026-10')
    expect(shiftMonth('2026-09', -1)).toBe('2026-08')
    expect(shiftMonth('2026-12', 1)).toBe('2027-01')
    expect(shiftMonth('2026-01', -1)).toBe('2025-12')
  })

  it('认不出的原样返回(不抛)', () => {
    expect(shiftMonth('', 1)).toBe('')
    expect(shiftMonth('九月', -1)).toBe('九月')
  })
})

describe('事项按 due 落进哪一天', () => {
  it('同一天的堆在一起,顺序即原顺序', () => {
    const map = tasksByDue([
      task({ id: 'a', due: '2026-09-25' }),
      task({ id: 'b', due: '2026-09-25' }),
      task({ id: 'c', due: '2026-09-26' }),
    ])
    expect(map.get('2026-09-25')?.map(t => t.id)).toEqual(['a', 'b'])
    expect(map.get('2026-09-26')?.map(t => t.id)).toEqual(['c'])
  })

  it('没有 due 的一条都不算(不摆到"今天"去)', () => {
    expect(tasksByDue([task({ id: 'a' }), task({ id: 'b', due: '' })]).size).toBe(0)
  })

  it('取消掉的不占日历格 —— 它已经不是一条计划了', () => {
    const map = tasksByDue([task({ id: 'a', due: '2026-09-25', status: 'canceled' })])
    expect(map.size).toBe(0)
  })

  it('due 带时间也只按日期那一段切', () => {
    const map = tasksByDue([task({ id: 'a', due: '2026-09-25T18:00:00+08:00' })])
    expect(map.get('2026-09-25')?.length).toBe(1)
  })
})

describe('月历两个状态(2026-09-22;Ben:「其实是未发布和已发布的部分,我认为这是两个状态」)', () => {
  it('就两个视图,**未发布在前**(UI 优先表现未发布)', () => {
    expect([...PUBLISH_VIEWS]).toEqual(['未发布', '已发布'])
  })

  it('未发布视图:选题按**计划发布日**摆', () => {
    const map = tasksByPublishDay([task({ id: 'a', kind: 'topic', planned_at: '2026-09-25' })], '未发布')
    expect(map.get('2026-09-25')?.map(t => t.id)).toEqual(['a'])
  })

  it('已经有实际发布日的**不在未发布视图里**(它已经发了)', () => {
    const one = task({ id: 'a', kind: 'topic', planned_at: '2026-09-25', published_at: '2026-09-26' })
    expect(tasksByPublishDay([one], '未发布').size).toBe(0)
    expect(tasksByPublishDay([one], '已发布').get('2026-09-26')?.map(t => t.id)).toEqual(['a'])
  })

  it('已发布视图按**实际发布日**摆,与计划那天无关', () => {
    const map = tasksByPublishDay([task({ id: 'a', kind: 'topic', planned_at: '2026-09-25', published_at: '2026-09-28' })], '已发布')
    expect(map.get('2026-09-25')).toBeUndefined()
    expect(map.get('2026-09-28')?.map(t => t.id)).toEqual(['a'])
  })

  it('没有实际发布日的一条都不进已发布视图(不拿计划日冒充发出去了)', () => {
    expect(tasksByPublishDay([task({ id: 'a', kind: 'topic', planned_at: '2026-09-25' })], '已发布').size).toBe(0)
  })

  it('**普通事项的 due 照旧**:没有计划日就按 due 摆在未发布那一视图里', () => {
    const map = tasksByPublishDay([task({ id: 'a', due: '2026-09-25' })], '未发布')
    expect(map.get('2026-09-25')?.map(t => t.id)).toEqual(['a'])
  })

  it('两个都有时**计划日说了算**:due 是普通事项的预期结束时间,不是发布计划', () => {
    expect(publishDayOf(task({ id: 'a', kind: 'topic', planned_at: '2026-09-25', due: '2026-09-30' }), '未发布'))
      .toBe('2026-09-25')
  })

  it('两个日期都没有的:哪一天都不摆(不塞到"今天"去)', () => {
    expect(publishDayOf(task({ id: 'a' }), '未发布')).toBeUndefined()
    expect(publishDayOf(task({ id: 'a', planned_at: '' }), '未发布')).toBeUndefined()
  })

  it('取消掉的两个视图里都不占格 —— 它已经不是一条计划了', () => {
    const one = task({ id: 'a', status: 'canceled', planned_at: '2026-09-25', published_at: '2026-09-26' })
    expect(tasksByPublishDay([one], '未发布').size).toBe(0)
    expect(tasksByPublishDay([one], '已发布').size).toBe(0)
  })

  it('日期带时间也只按日期那一段切', () => {
    expect(publishDayOf(task({ id: 'a', due: '2026-09-25T18:00:00+08:00' }), '未发布')).toBe('2026-09-25')
  })

  it('同一天的堆在一起,顺序即原顺序', () => {
    const map = tasksByPublishDay([
      task({ id: 'a', kind: 'topic', planned_at: '2026-09-25' }),
      task({ id: 'b', due: '2026-09-25' }),
    ], '未发布')
    expect(map.get('2026-09-25')?.map(t => t.id)).toEqual(['a', 'b'])
  })
})

describe('逾期 = 今天之前还没发的那几天', () => {
  it('今天之前算逾期,今天与以后都不算', () => {
    expect(isOverdue('2026-09-20', '2026-09-21')).toBe(true)
    expect(isOverdue('2026-09-21', '2026-09-21')).toBe(false)
    expect(isOverdue('2026-09-22', '2026-09-21')).toBe(false)
  })

  it('跨年也对(按 YYYY-MM-DD 逐位比,不解析成 Date)', () => {
    expect(isOverdue('2025-12-31', '2026-01-01')).toBe(true)
    expect(isOverdue('2026-01-02', '2025-12-31')).toBe(false)
  })

  it('不知道今天是哪天(快照里的 now 读不出来)就**一律不标逾期** —— 宁可不说,不猜', () => {
    expect(isOverdue('2026-09-20', undefined)).toBe(false)
  })
})

describe('事项按环节分组', () => {
  it('列就是模板给的八个环节,顺序一致,末尾跟一条「未分环节」', () => {
    const groups = groupTasksByLane([], OPS_STAGES)
    expect(groups.map(g => g.lane)).toEqual([...OPS_STAGES, TODO_UNASSIGNED_LANE])
  })

  it('module_id 是 `lane:<环节>` 的落进那一列', () => {
    const groups = groupTasksByLane([
      task({ id: 'a', module_id: laneModuleId('选题策划') }),
      task({ id: 'b', module_id: laneModuleId('后期制作') }),
    ], OPS_STAGES)
    expect(groups.find(g => g.lane === '选题策划')?.tasks.map(t => t.id)).toEqual(['a'])
    expect(groups.find(g => g.lane === '后期制作')?.tasks.map(t => t.id)).toEqual(['b'])
  })

  it('**认不出归属的一张都不丢** —— 全落进「未分环节」', () => {
    const groups = groupTasksByLane([
      task({ id: 'a' }),
      task({ id: 'b', module_id: 'mod-123' }),
      task({ id: 'c', module_id: laneModuleId('这个环节模板里没有') }),
    ], OPS_STAGES)
    expect(groups.find(g => g.lane === TODO_UNASSIGNED_LANE)?.tasks.map(t => t.id)).toEqual(['a', 'b', 'c'])
    // 一张都没少。
    expect(groups.reduce((sum, g) => sum + g.tasks.length, 0)).toBe(3)
  })

  it('做完与取消的不占这一格(它们留在看板上)', () => {
    const groups = groupTasksByLane([
      task({ id: 'a', status: 'done', module_id: laneModuleId('选题策划') }),
      task({ id: 'b', status: 'canceled', module_id: laneModuleId('选题策划') }),
      task({ id: 'c', status: 'doing', module_id: laneModuleId('选题策划') }),
    ], OPS_STAGES)
    expect(groups.find(g => g.lane === '选题策划')?.tasks.map(t => t.id)).toEqual(['c'])
  })

  it('模板没定环节(做产品):只有「未分环节」一列', () => {
    expect(groupTasksByLane([task({ id: 'a' })], []).map(g => g.lane)).toEqual([TODO_UNASSIGNED_LANE])
  })
})

describe('环节 ↔ module_id 的约定', () => {
  it('来回一次还是原来那个环节', () => {
    for (const stage of OPS_STAGES) expect(laneOfModuleId(laneModuleId(stage))).toBe(stage)
  })

  it('不是这种约定的回 undefined(**不猜**)', () => {
    expect(laneOfModuleId(undefined)).toBeUndefined()
    expect(laneOfModuleId('mod-123')).toBeUndefined()
    expect(laneOfModuleId('lane:')).toBeUndefined()
    expect(laneOfModuleId('')).toBeUndefined()
  })
})
