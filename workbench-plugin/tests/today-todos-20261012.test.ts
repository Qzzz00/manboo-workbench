/**
 * 「今天的待办」= 看板事项的今天视图(2026-10-12,卡 `claude/zealous-benz-287eff`)。
 *
 * 维护者拍板:运营同学那个待办小组件进自媒体模板本体;统筹定它**不另存一份**,
 * 是看板事项按 `due` 切出来的「今天」那一刀。这一份钉的是切法本身(电脑那一格与手机读的是同一份)。
 */
import { describe, expect, it } from 'vitest'
import type { TaskView } from '../src/protocol.ts'
import { statusPathTo } from '../src/protocol.ts'
import { localDayOf, nextDayOf, todayTodosOf } from '../src/todayTodos.ts'

const AT = '2026-10-12T02:00:00.000Z'
function task(over: Partial<TaskView> & { id: string }): TaskView {
  return { title: over.id, status: 'todo', created_at: AT, updated_at: AT, ...over } as TaskView
}

describe('日子怎么算', () => {
  it('本机时区的那一天;明天跨月跨年都对', () => {
    expect(localDayOf(new Date(2026, 9, 12, 23, 59))).toBe('2026-10-12')
    expect(nextDayOf('2026-10-31')).toBe('2026-11-01')
    expect(nextDayOf('2026-12-31')).toBe('2027-01-01')
  })
})

describe('todayTodosOf', () => {
  it('今天到期的、还没办完的进来;明天的、没写日期的不进', () => {
    const view = todayTodosOf([
      task({ id: 'a', due: '2026-10-12' }),
      task({ id: 'b', due: '2026-10-13' }),
      task({ id: 'c' }),
    ], '2026-10-12')
    expect(view.date).toBe('2026-10-12')
    expect(view.tomorrow).toBe('2026-10-13')
    expect(view.items.map(one => one.id)).toEqual(['a'])
  })

  it('过了日子还没办的照样在今天(写明逾期),不悄悄消失', () => {
    const view = todayTodosOf([task({ id: 'old', due: '2026-10-10', status: 'doing' })], '2026-10-12')
    expect(view.items).toEqual([{ id: 'old', title: 'old', due: '2026-10-10', done: false, overdue: true }])
  })

  it('今天办完的留在今天(打勾的样子),昨天办完的不进;取消的不进', () => {
    const view = todayTodosOf([
      task({ id: 'done-today', due: '2026-10-12', status: 'done', done_at: new Date(2026, 9, 12, 9).toISOString() }),
      task({ id: 'done-before', due: '2026-10-11', status: 'done', done_at: new Date(2026, 9, 11, 9).toISOString() }),
      task({ id: 'gone', due: '2026-10-12', status: 'canceled' }),
    ], '2026-10-12')
    expect(view.items.map(one => [one.id, one.done])).toEqual([['done-today', true]])
  })

  it('选题不进(选题池与发布计划那两格管它们)', () => {
    const view = todayTodosOf([task({ id: 't', kind: 'topic', due: '2026-10-12' })], '2026-10-12')
    expect(view.items).toEqual([])
  })

  it('排序:没办完的在前(逾期的先、再按建的先后),办完的沉底', () => {
    const view = todayTodosOf([
      task({ id: 'done', due: '2026-10-12', status: 'done', done_at: new Date(2026, 9, 12, 8).toISOString() }),
      task({ id: 'late', due: '2026-10-12', created_at: '2026-10-12T03:00:00.000Z' }),
      task({ id: 'early', due: '2026-10-12', created_at: '2026-10-12T01:00:00.000Z' }),
      task({ id: 'overdue', due: '2026-10-09' }),
    ], '2026-10-12')
    expect(view.items.map(one => one.id)).toEqual(['overdue', 'early', 'late', 'done'])
  })
})

describe('statusPathTo(七态表上走到「完成」的最短一条)', () => {
  it('待办 → 进行中 → 完成;等我确认一步到;办完的原地不动;取消的回不到完成以外的路照表走', () => {
    expect(statusPathTo('todo', 'done')).toEqual(['doing', 'done'])
    expect(statusPathTo('backlog', 'done')).toEqual(['todo', 'doing', 'done'])
    expect(statusPathTo('confirm', 'done')).toEqual(['done'])
    expect(statusPathTo('done', 'done')).toEqual([])
    expect(statusPathTo('done', 'doing')).toEqual(['doing'])
  })
})
