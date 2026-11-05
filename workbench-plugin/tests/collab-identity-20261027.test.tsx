// 协作区每张事项卡与详情写清两个身份(2026-10-27,《设计-协作区与事务官标签页合并》§3.1):
// 执行 = 真实在干活的那一家(最后一段运行片段 → 派活那一家 → 负责人);管理 = 卡上记下的 manager,缺席就不写、不猜。
import '@testing-library/jest-dom/vitest'
import type { NodeProps } from '@xyflow/react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { TaskView, WorkbenchState } from '../src/protocol.ts'
import { assigneeName } from '../src/protocol.ts'
import { executorOf, managerOf } from '../src/client/collab/identity.ts'
import { NoteNode, type NoteNodeData } from '../src/client/collab/nodes.tsx'
import { NoteDialog } from '../src/client/collab/NoteDialog.tsx'
import { PeopleProvider, type PeopleCtx } from '../src/client/collab/people.tsx'
import type { CollabApi } from '../src/client/collab/collabApi.ts'

afterEach(cleanup)
const AT = '2026-10-27T10:00:00.000Z'
const task = (id: string, patch: Partial<TaskView> = {}): TaskView => ({ id, title: `事项-${id}`, status: 'todo', source: { kind: 'manual' }, created_at: AT, updated_at: AT, ...patch })
const noteData = (t: TaskView): NoteNodeData => ({
  task: t, type: 'dev', dim: false, assigneeText: 'Kimi', gaps: [], working: false,
  onStamp: () => {}, onArrow: () => {}, onOpen: () => {},
})
const renderNote = (t: TaskView) => render(<NoteNode {...({ data: noteData(t) } as unknown as NodeProps)} />)

describe('executorOf / managerOf(纯函数)', () => {
  it('执行:最后一段关联窗口的那一家优先于负责人', () => {
    const t = task('a', { assignee: 'kimi', links: [{ agent: 'codex', session_id: 's1' }, { agent: 'claude', session_id: 's2' }] })
    expect(executorOf(t)).toBe('claude')
  })
  it('执行:没有窗口时取派活那一家,再没有取负责人,都没有就缺席', () => {
    expect(executorOf(task('a', { assignee: 'kimi', dispatch: { family: 'codex', status: 'running' } as unknown as NonNullable<TaskView['dispatch']> }))).toBe('codex')
    expect(executorOf(task('a', { assignee: 'kimi' }))).toBe('kimi')
    expect(executorOf(task('a'))).toBeUndefined()
  })
  it('管理:只读卡上记的 manager,缺席不猜', () => {
    expect(managerOf(task('a', { manager: 'dsh' }))).toBe('dsh')
    expect(managerOf(task('a', { assignee: 'dsh' }))).toBeUndefined()
  })
})

describe('事项卡上的「管理」', () => {
  it('事务官管的:写「管理 + 事务官的显示名」', () => {
    const { container } = renderNote(task('a', { manager: 'dsh' }))
    const tag = container.querySelector('.ben-cl__manager')
    expect(tag).not.toBeNull()
    expect(tag).toHaveTextContent(`管理 ${assigneeName('dsh')}`)
  })
  it('名片表里给事务官起了名就用那个名', () => {
    const people = { cards: [{ id: 'dsh', name: '她起的名', kind: 'agent' }], avatars: {}, baseUrl: '', selected: undefined, onSelect: () => {} } as unknown as PeopleCtx
    const { container } = render(<PeopleProvider value={people}><NoteNode {...({ data: noteData(task('a', { manager: 'dsh' })) } as unknown as NodeProps)} /></PeopleProvider>)
    expect(container.querySelector('.ben-cl__manager')).toHaveTextContent('管理 她起的名')
  })
  it('没记 manager:什么都不画', () => {
    const { container } = renderNote(task('a', { assignee: 'dsh' }))
    expect(container.querySelector('.ben-cl__manager')).toBeNull()
    expect(container.textContent).not.toMatch(/管理/)
  })
})

describe('详情「头」里的「管理」', () => {
  const api: CollabApi = { get: async () => ({ items: [], runs: [], events: [] }) as never, post: async () => ({ ok: true, body: { ok: true } }) as never }
  const open = (t: TaskView) => {
    const state = { tasks: { tasks: [t], project_meta: [], session_usage: {}, modules: [], sprints: [], goals: [], agent_cards: [], goal_sprints: [] }, sessions: [] } as unknown as WorkbenchState
    return render(<NoteDialog task={t} state={state} goals={[]} cards={[]} entries={[]} api={api} baseUrl="http://test" fetchImpl={fetch} assigneeText={() => '我'} onClose={() => {}} onFlyGoal={() => {}} onReceipt={() => {}} />)
  }
  it('有 manager 就多一行只读的「管理」', () => {
    open(task('a', { manager: 'dsh' }))
    const head = screen.getByRole('region', { name: '头' })
    const dt = [...head.querySelectorAll('dt')].find(one => one.textContent === '管理')
    expect(dt).toBeDefined()
    expect(dt?.nextElementSibling).toHaveTextContent(assigneeName('dsh'))
  })
  it('没有就不画这一行', () => {
    open(task('a'))
    const head = screen.getByRole('region', { name: '头' })
    expect([...head.querySelectorAll('dt')].some(one => one.textContent === '管理')).toBe(false)
  })
})
