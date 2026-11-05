// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { TaskView } from '../src/protocol.ts'
import {
  ASSIGNEE_PICKER_TAIL, NOTE_GAP_TITLES, STAMP_TITLES, TASK_STATUSES, UNSORTED_GOAL_ID, OWNER_ASK_KINDS,
  assigneeName, boardAssignee, goalIdOf, isOwnerAskKind, isTaskAssigneeValue, noteFromOf, noteGaps, ownerAskOf, receiptStatus,
} from '../src/protocol.ts'

const AT = '2026-10-21T09:00:00.000Z'
function task(patch: Partial<TaskView> = {}): TaskView {
  return { id: 't-1', title: '修好铃', status: 'todo', source: { kind: 'manual' }, created_at: AT, updated_at: AT, ...patch }
}

describe('章:七态一对一', () => {
  it('七个状态各有一个章,不多不少', () => {
    expect(Object.keys(STAMP_TITLES).sort()).toEqual([...TASK_STATUSES].sort())
    expect(TASK_STATUSES.map(status => STAMP_TITLES[status])).toEqual(['待领', '领了', '在做', '等你', '做完', '卡住', '不做'])
  })
})

describe('目标', () => {
  it('老卡没有 goal_id = 未归目标', () => {
    expect(goalIdOf(task())).toBe(UNSORTED_GOAL_ID)
    expect(goalIdOf(task({ goal_id: 'g-1' }))).toBe('g-1')
  })
})

describe('来源:老 origin 并进 from.kind', () => {
  it('有 from 用 from', () => {
    expect(noteFromOf(task({ from: { kind: 'meeting', ref: 'm-1' } }))).toEqual({ kind: 'meeting', ref: 'm-1' })
  })
  it('call → said,onboarding → user,其余原样', () => {
    expect(noteFromOf(task({ origin: 'call' })).kind).toBe('said')
    expect(noteFromOf(task({ origin: 'onboarding' })).kind).toBe('user')
    expect(noteFromOf(task({ origin: 'meeting' })).kind).toBe('meeting')
    expect(noteFromOf(task({ origin: 'evidence' })).kind).toBe('evidence')
  })
  it('从会话转的卡 → session,ref 是会话', () => {
    expect(noteFromOf(task({ source: { kind: 'session', ref: 'codex:abc' } }))).toEqual({ kind: 'session', ref: 'codex:abc' })
  })
  it('老卡什么都没有 → user(他写下的),不编 ref', () => {
    expect(noteFromOf(task())).toEqual({ kind: 'user' })
  })
})

describe('回执三态怎么落章', () => {
  it('done / objection → 等你,blocked → 卡住;只有他点才进做完', () => {
    expect(receiptStatus('done')).toBe('confirm')
    expect(receiptStatus('objection')).toBe('confirm')
    expect(receiptStatus('blocked')).toBe('blocked')
  })
})

describe('四样缺什么', () => {
  it('老卡:目标待定 + 没写验收 + 没写谁来做;来源按老 origin 认得出', () => {
    expect(noteGaps(task())).toEqual(['goal', 'acceptance', 'assignee'])
  })
  it('四样齐了就没有缺', () => {
    expect(noteGaps(task({ goal_id: 'g-1', from: { kind: 'said', quote: '修一下' }, acceptance: ['铃能响'], assignee: 'codex' }))).toEqual([])
  })
  it('每一样都有一句给人看的话', () => {
    expect(NOTE_GAP_TITLES.goal).toBe('目标待定')
  })
})

describe('负责人', () => {
  it('成员与 Agent 名片认得', () => {
    expect(isTaskAssigneeValue('member:li')).toBe(true)
    expect(isTaskAssigneeValue('agent:ben:01HX')).toBe(true)
    expect(isTaskAssigneeValue('member:')).toBe(false)
    expect(isTaskAssigneeValue('agent:有 空格')).toBe(false)
  })
  it('同事 / 别人读到按「你」处理,界面不再给选', () => {
    expect(boardAssignee('colleague')).toBe('me')
    expect(boardAssignee('other')).toBe('me')
    expect(boardAssignee('codex')).toBe('codex')
    expect(ASSIGNEE_PICKER_TAIL).toEqual([])
  })
  it('成员 / 名片的称呼:去掉前缀原样显示;带了名片表就换名片的名字(2026-10-22 卡 B)', () => {
    expect(assigneeName('member:小李')).toBe('小李')
    expect(assigneeName('agent:ben:01HX')).toBe('ben:01HX')
    const cards = [{ id: 'agent:ben:01HX', name: 'Kimi 编程' }]
    expect(assigneeName('agent:ben:01HX', cards)).toBe('Kimi 编程')
    // 表里没有这张名片:照旧去前缀原样显示,不编一个名字。
    expect(assigneeName('agent:ben:zzzz', cards)).toBe('ben:zzzz')
  })
})

describe('要本人拍板的四类请求(2026-10-26,卡「事务官页接管队列」)', () => {
  const ask = { kind: 'spend' as const, proposal: '买这个', basis: '核过的事实', by: 'butler', at: AT }
  it('类别只认四类:花钱 / 新对外发布 / 本人账号与设备配对 / 习惯与范围取舍', () => {
    for (const kind of ['spend', 'publish', 'pairing', 'scope']) {
      expect(isOwnerAskKind(kind)).toBe(true)
    }
    expect(isOwnerAskKind('unknown')).toBe(false)
    expect(isOwnerAskKind(undefined)).toBe(false)
    expect(OWNER_ASK_KINDS).toEqual(['spend', 'publish', 'pairing', 'scope'])
  })
  it('ownerAskOf:章在「等我确认」、且带四类之一才算;类别认不出(未知)不自动放行', () => {
    expect(ownerAskOf(task({ status: 'confirm', owner_ask: ask }))).toEqual(ask)
    // 不在「等我确认」:即使标了也不算。
    expect(ownerAskOf(task({ status: 'doing', owner_ask: ask }))).toBeUndefined()
    // 没标 / 类别认不出 / 坏形状:都不算。
    expect(ownerAskOf(task({ status: 'confirm' }))).toBeUndefined()
    expect(ownerAskOf(task({ status: 'confirm', owner_ask: { ...ask, kind: 'unknown' as never } }))).toBeUndefined()
  })
})
