import { expect, it } from 'vitest'
import { emptyState, type WorkbenchState } from '../src/api/protocol'
import { stageCards } from '../src/stage/stageCardsModel'
it('手机正在办仅显示公共业务任务，同事项去重，统筹散会话不混入', () => {
  const state: WorkbenchState = { ...emptyState(), stale: false, running: { count: 3, items: [
    { key: 'a', task_id: 'task-a', text: '图谱返修', agent: 'codex' },
    { key: 'b', task_id: 'task-a', text: '图谱返修', agent: 'kimi' },
    { key: 'pm', text: '统筹', agent: 'codex', session_id: 'pm' },
  ] } }
  const card = stageCards(state).find(one => one.id === 'doing')!
  expect(card.count).toBe(1)
  expect(card.lines.map(one => one.id)).toEqual(['task-a'])
  state.stale = true
  expect(stageCards(state).find(one => one.id === 'doing')!.count).toBeUndefined()
})

it('手机只读公共已分类业务清单与总数缺席，显示真实提供方', () => {
  const state: WorkbenchState = { ...emptyState(), stale: false, running: { scope: 'classified_business_tasks', observed_count: 1, items: [
    { key: 'task-a', task_id: 'task-a', text: '图谱返修', agent: 'codex', role: 'business', sources: [{ agent: 'codex', session_id: 'one', provider: 'kimi', transport: 'codex-rollout', role: 'business', state: 'running' }] },
  ], excluded: [{ key: 'pm', task_id: 'pm', text: '统筹', agent: 'codex', role: 'coordination' }] } }
  const card = stageCards(state).find(one => one.id === 'doing')!
  expect(card.count).toBeUndefined()
  expect(card.lines.map(one => one.id)).toEqual(['task-a'])
  expect(card.lines[0]?.note).toContain('kimi')
  expect(card.lines[0]?.note).toContain('业务总数未知')
})

it('手机首页同一业务双来源只数一件，协调会话单列不加业务数', () => {
  const state: WorkbenchState = { ...emptyState(), stale: false, running: { scope: 'classified_business_tasks', count: 1, observed_count: 1, items: [
    { key: 'task-a', task_id: 'task-a', text: '图谱返修', agent: 'codex', role: 'business', sources: [
      { agent: 'codex', session_id: 'one', provider: 'codex', transport: 'codex-rollout', role: 'business', state: 'running' },
      { agent: 'kimi', session_id: 'two', provider: 'kimi', transport: 'kimi-wire', role: 'business', state: 'running' },
    ] },
  ], excluded: [{ key: 'task-pm', task_id: 'task-pm', text: '统筹', agent: 'codex', role: 'coordination' }] } }
  const card = stageCards(state).find(one => one.id === 'doing')!
  expect(card.count).toBe(1)
  expect(card.lines.map(one => one.id)).toEqual(['task-a'])
  expect(card.lines[0]?.note).toContain('codex')
  expect(card.lines[0]?.note).toContain('kimi')
  delete state.running!.count
  expect(stageCards(state).find(one => one.id === 'doing')!.count).toBeUndefined()
})

it('手机当前业务总数已知时，历史未分类来源不误报总数未知', () => {
  const state: WorkbenchState = { ...emptyState(), stale: false, running: { scope: 'classified_business_tasks', count: 0, observed_count: 0,
    items: [], excluded: [{ key: 'task-old', task_id: 'task-old', text: '历史导入', agent: 'codex', role: 'unclassified' }] } }
  const card = stageCards(state).find(one => one.id === 'doing')!
  expect(card.count).toBe(0)
  expect(card.empty).toContain('历史来源')
  expect(card.empty).not.toContain('业务总数未确认')
})
