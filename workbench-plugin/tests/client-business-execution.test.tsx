import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { WorkbenchState } from '../src/protocol.ts'
import { BusinessExecution } from '../src/client/BusinessExecution.tsx'
afterEach(cleanup)
const at = '2026-10-26T06:00:00.000Z'
function state(): WorkbenchState {
  return { now: at, stale: false, agents: [], quota: {}, agent_registry: { entries: [{ id: 'codex', name: 'Codex', sessions: [] }, { id: 'kimi', name: 'Kimi', sessions: [] }] }, sessions: [
    { agent: 'codex', session_id: 'one', summary: '正在修复滚动', updated_at: at, status: 'running' },
    { agent: 'kimi', session_id: 'two', summary: '正在检查返回路径', updated_at: at, status: 'running' },
  ], tasks: { tasks: [{ id: 'a', title: '图谱返修', assignee: 'codex', status: 'confirm', links: [{ agent: 'codex', session_id: 'one' }, { agent: 'kimi', session_id: 'two' }] }, { id: 'b', title: '引导修复', assignee: 'kimi', status: 'doing' }] },
  running: { count: 5, items: [
    { key: 'task:a', task_id: 'a', agent: 'codex', session_id: 'one', text: '图谱返修' },
    { key: 'task:a:two', task_id: 'a', agent: 'kimi', session_id: 'two', text: '图谱返修' },
    { key: 'duplicate', task_id: 'a', agent: 'codex', session_id: 'one', text: '图谱返修' },
    { key: 'task:b', task_id: 'b', agent: 'kimi', text: '引导修复' },
    { key: 'session:codex:pm', agent: 'codex', session_id: 'pm', text: '统筹 Codex' },
  ] } } as unknown as WorkbenchState
}
it('业务数与可点清单同源；统筹散会话单列，同事项多提供方与来源重复均去重', () => {
  const open = vi.fn()
  render(<BusinessExecution state={state()} onOpenTask={open} />)
  fireEvent.click(screen.getByRole('button', { name: '业务任务正在执行 2 件' }))
  const list = screen.getByRole('region', { name: '正在执行的业务任务' })
  expect(within(list).getAllByRole('button', { name: /^打开业务任务:/ })).toHaveLength(2)
  expect(within(list).queryByText('统筹 Codex')).not.toBeInTheDocument()
  expect(within(list).getByText(/Codex.*Kimi/)).toBeInTheDocument()
  expect(within(list).getByText(/正在修复滚动/)).toBeInTheDocument()
  expect(within(list).getAllByText(/最后更新/).length).toBeGreaterThan(0)
  fireEvent.click(within(list).getByRole('button', { name: '打开业务任务:图谱返修' }))
  expect(open).toHaveBeenCalledWith('a')
  expect(screen.getByText(/未关联事项的会话 1/)).toBeInTheDocument()
})
it('未知与冻结不能冒充零或继续报正在执行', () => {
  const s = state(); delete s.running!.count
  const { rerender } = render(<BusinessExecution state={s} onOpenTask={() => {}} />)
  expect(screen.getByRole('button', { name: /业务任务执行状态未知/ })).toBeInTheDocument()
  s.stale = true; s.running!.count = 5
  rerender(<BusinessExecution state={s} onOpenTask={() => {}} />)
  expect(screen.getByText(/Agent 掉线/)).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '业务任务正在执行 2 件' })).not.toBeInTheDocument()
})
it('交回后移出公共运行清单即同步减少；新轮执行不被旧confirm章遮住', () => {
  const s = state()
  const { rerender } = render(<BusinessExecution state={s} onOpenTask={() => {}} />)
  expect(screen.getByRole('button', { name: '业务任务正在执行 2 件' })).toBeInTheDocument()
  s.running = { count: 1, items: s.running!.items.filter(i => i.task_id === 'b') }
  rerender(<BusinessExecution state={s} onOpenTask={() => {}} />)
  expect(screen.getByRole('button', { name: '业务任务正在执行 1 件' })).toBeInTheDocument()
})

it('生产舞台服从公共新轮执行事实；旧confirm不继续显示完成等确认', async () => {
  const { buildButlerScene } = await import('../src/client/butlerSceneModel.ts')
  const s = state()
  const item = buildButlerScene(s).items.find(one => one.id === 'a')!
  expect(item.executing).toBe(true)
  expect(item.group).toBe('working')
  expect(item.confirmTaskId).toBeUndefined()
  expect(item.label).toBe('正在执行')
})

it('自动挂到目标的会话事项仍需确认业务角色，不能仅凭task_id把统筹算业务', () => {
  const s = state()
  s.tasks!.tasks = [...s.tasks!.tasks, { id: 'auto', title: '任意会话名', source: { kind: 'session' } } as never]
  s.running!.items = [...s.running!.items, { key: 'task:auto', task_id: 'auto', agent: 'codex', text: '任意会话名' }]
  render(<BusinessExecution state={s} onOpenTask={() => {}} />)
  expect(screen.getByRole('button', { name: '业务任务执行状态未知' })).toBeInTheDocument()
  expect(screen.getByText(/来源角色未知 1/)).toBeInTheDocument()
})

it('按公共角色排除协调与未分类，覆盖不全时只报局部观测且列出真实来源', () => {
  const s = state()
  s.running = { scope: 'classified_business_tasks', observed_count: 1, items: [{ key: 'task:a', task_id: 'a', agent: 'codex', text: '图谱返修', role: 'business', sources: [
    { task_id: 'a', agent: 'codex', session_id: 'one', role: 'business', state: 'running', provider: 'kimi', transport: 'codex-rollout', rounds: [{ round: '1', event_id: 'start', kind: 'started', at }] },
    { task_id: 'a', agent: 'codex', session_id: 'pm', role: 'coordination', state: 'running', provider: 'codex', transport: 'codex-rollout', rounds: [] },
  ] }], excluded: [{ key: 'task:auto', task_id: 'auto', agent: 'codex', text: '统筹', role: 'coordination' }] }
  render(<BusinessExecution state={s} onOpenTask={() => {}} />)
  expect(screen.getByRole('button', { name: /业务任务执行状态未知/ })).toBeInTheDocument()
  expect(screen.getByText(/已观测业务任务 1 件/)).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: /业务任务执行状态未知/ }))
  const list = screen.getByRole('region', { name: '正在执行的业务任务' })
  expect(within(list).getAllByRole('button', { name: /^打开业务任务:/ })).toHaveLength(1)
  expect(within(list).getByText(/Kimi.*Codex CLI/)).toBeInTheDocument()
  expect(screen.getByText(/协调会话 1/)).toBeInTheDocument()
})

it('历史未分类来源另列，但当前业务数已知时不再写总数未确认', () => {
  const s = state()
  s.running = { scope: 'classified_business_tasks', count: 1, observed_count: 1,
    items: [{ key: 'task:a', task_id: 'a', agent: 'codex', text: '图谱返修', role: 'business' }],
    excluded: [{ key: 'task:old', task_id: 'old', agent: 'codex', text: '历史导入', role: 'unclassified', execution_state: 'unknown' }] }
  render(<BusinessExecution state={s} onOpenTask={() => {}} />)
  expect(screen.getByRole('button', { name: '业务任务正在执行 1 件' })).toBeInTheDocument()
  expect(screen.getByText(/来源角色未知 1 · 未计入当前业务任务/)).toBeInTheDocument()
  expect(screen.queryByText(/业务总数未确认/)).toBeNull()
})

it('生产场景将清单挂在球下独立区域，收起和打开原任务都恢复该区', async () => {
  const { ButlerScene } = await import('../src/client/ButlerScene.tsx')
  const { container } = render(<ButlerScene state={state()} onOpen={() => {}} onConfirm={() => {}}>舞台中心状态</ButlerScene>)
  const trigger = screen.getByRole('button', { name: '业务任务正在执行 2 件' })
  fireEvent.click(trigger)
  const list = screen.getByRole('region', { name: '正在执行的业务任务' })
  const below = container.querySelector('.ben-wb__scene-below')!
  expect(below).toHaveAttribute('data-execution-open', 'true')
  expect(below.contains(list)).toBe(true)
  expect(container.querySelector('.ben-wb__scene-top')!.contains(list)).toBe(false)
  fireEvent.click(within(list).getByRole('button', { name: '收起执行清单' }))
  expect(below).toHaveAttribute('data-execution-open', 'false')
  expect(screen.queryByRole('region', { name: '正在执行的业务任务' })).toBeNull()
  fireEvent.click(trigger)
  fireEvent.click(screen.getByRole('button', { name: '打开业务任务:图谱返修' }))
  expect(below).toHaveAttribute('data-execution-open', 'false')
  expect(screen.getByLabelText('当前聚焦事项')).toHaveTextContent('图谱返修')
})
