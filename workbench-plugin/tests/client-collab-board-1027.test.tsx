// 协作区主体换成合并稿的层级(2026-10-27,《设计-协作区与事务官标签页合并》第二节;决策记录同日两条)。
// 目标条回答四问;事项卡按完成情况上色、带进度与下一步;右侧轨迹只由真实记录拼,没记录就说没有。
import '@testing-library/jest-dom/vitest'
import type { NodeProps } from '@xyflow/react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CollabGoal, GoalTraceView, TaskView } from '../src/protocol.ts'
import { goalBrief, progressOf, stageSteps, taskConditions, traceDirection } from '../src/client/collab/boardProgress.ts'
import { GoalBar } from '../src/client/collab/GoalBar.tsx'
import { TraceRail } from '../src/client/collab/TraceRail.tsx'
import { NoteNode, type NoteNodeData } from '../src/client/collab/nodes.tsx'
import { collabApi } from '../src/client/collab/collabApi.ts'

afterEach(cleanup)
const AT = '2026-10-27T10:00:00.000Z'
const task = (id: string, patch: Partial<TaskView> = {}): TaskView => ({ id, title: `事项-${id}`, status: 'todo', source: { kind: 'manual' }, created_at: AT, updated_at: AT, goal_id: 'g', ...patch })
const goal = (patch: Partial<CollabGoal> = {}): CollabGoal => ({ id: 'g', title: '让一次委托走到交付', owner: 'me', status: 'open', created_at: AT, updated_at: AT, ...patch })

describe('完成情况的判据(纯函数)', () => {
  it('卡片颜色只按卡上状态分五档', () => {
    expect(progressOf('backlog')).toBe('not-started')
    expect(progressOf('todo')).toBe('not-started')
    expect(progressOf('canceled')).toBe('not-started')
    expect(progressOf('doing')).toBe('doing')
    expect(progressOf('confirm')).toBe('review')
    expect(progressOf('done')).toBe('done')
    expect(progressOf('blocked')).toBe('blocked')
  })
  it('事项的完成条件取目标条件里挂在它身上的那几条,核验过才算', () => {
    const t = task('a', { status: 'confirm' })
    const g = goal({ conditions: [
      { id: 'c1', text: '一', task_id: 'a', verifications: [{ by: 'me', at: AT, pass: true, round: 1 }] },
      { id: 'c2', text: '二', task_id: 'a', verifications: [] },
      { id: 'c3', text: '别人的', task_id: 'b', verifications: [] },
    ] } as unknown as Partial<CollabGoal>)
    expect(taskConditions(t, [g])).toEqual({ verified: 1, total: 2 })
    expect(taskConditions(task('z'), [g])).toEqual({ verified: 0, total: 0 })
  })
  it('没有条件时用阶段刻度:派发、执行、交回、验收', () => {
    expect(stageSteps('todo')).toEqual({ passed: 0, total: 4 })
    expect(stageSteps('doing')).toEqual({ passed: 2, total: 4 })
    expect(stageSteps('confirm')).toEqual({ passed: 3, total: 4 })
    expect(stageSteps('done')).toEqual({ passed: 4, total: 4 })
  })
  it('目标四问:验收数照实数,未完原因取最该看的那一件,预计没有估计就说缺什么', () => {
    const tasks = [task('a', { status: 'done' }), task('b', { status: 'blocked', title: '恢复', block_reason: 'others' } as unknown as Partial<TaskView>), task('c', { status: 'doing' })]
    const brief = goalBrief(goal(), tasks)
    expect(brief.done).toBe(1)
    expect(brief.total).toBe(3)
    expect(brief.segments).toEqual(['done', 'blocked', 'doing'])
    expect(brief.reason).toMatch(/恢复/)
    expect(brief.eta).toBe('未估计 · 缺执行者估计')
    expect(goalBrief(goal(), [task('a', { status: 'done' })]).reason).toBeUndefined()
  })
  it('轨迹方向按容器:宽大于高横排,否则竖排', () => {
    expect(traceDirection(800, 180)).toBe('row')
    expect(traceDirection(320, 700)).toBe('column')
  })
})

const noteData = (t: TaskView, extra: Partial<NoteNodeData> = {}): NoteNodeData => ({
  task: t, type: 'dev', dim: false, assigneeText: 'Kimi', gaps: [], working: false,
  onStamp: () => {}, onArrow: () => {}, onOpen: () => {}, ...extra,
})

describe('事项卡', () => {
  it('底色按完成情况,类型留在图标上;有条件画条件刻度,写下一步', () => {
    const t = task('a', { status: 'doing', standing: { case: 'running', next: '修好定位后再交回' } as unknown as NonNullable<TaskView['standing']> })
    const { container } = render(<NoteNode {...({ data: noteData(t, { conditions: { verified: 2, total: 4 } }) } as unknown as NodeProps)} />)
    const note = container.querySelector('.ben-cl__note')!
    expect(note).toHaveAttribute('data-progress', 'doing')
    expect(note).toHaveAttribute('data-type', 'dev')
    expect(container.querySelectorAll('.ben-cl__note-rungs i')).toHaveLength(4)
    expect(container.querySelectorAll('.ben-cl__note-rungs i[data-on=true]')).toHaveLength(2)
    expect(screen.getByText('完成条件 2/4 已核验')).toBeInTheDocument()
    expect(screen.getByText(/下一步:修好定位后再交回/)).toBeInTheDocument()
  })
  it('没有条件时画阶段刻度,不造百分比', () => {
    const { container } = render(<NoteNode {...({ data: noteData(task('a', { status: 'confirm' })) } as unknown as NodeProps)} />)
    expect(container.querySelector('.ben-cl__note')).toHaveAttribute('data-progress', 'review')
    expect(container.querySelectorAll('.ben-cl__note-rungs i[data-on=true]')).toHaveLength(3)
    expect(screen.getByText('阶段 交回')).toBeInTheDocument()
    expect(container.textContent).not.toMatch(/%/)
  })
})

describe('目标条', () => {
  it('一行回答四问,并说明卡片颜色', () => {
    render(<GoalBar goal={goal({ due: '2026-10-30' })} tasks={[task('a', { status: 'done' }), task('b', { status: 'doing' })]} />)
    const bar = screen.getByRole('region', { name: '目标进展' })
    expect(bar).toHaveTextContent('让一次委托走到交付')
    expect(bar).toHaveTextContent('1/2 已验收')
    expect(bar).toHaveTextContent('预计完成:未估计 · 缺执行者估计')
    expect(bar).toHaveTextContent('截止 10-30')
    expect(bar.querySelectorAll('.ben-cl__goalbar-rungs i')).toHaveLength(2)
    expect(screen.getByRole('note', { name: '卡片颜色表示完成情况' })).toHaveTextContent('未开始进行中待验收已完成受阻')
  })
})

const fetchOf = (body: unknown, status = 200) => vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch

describe('右侧执行轨迹', () => {
  const tasks = [task('a', { title: '接续原会话', status: 'doing' }), task('b', { title: '已做完', status: 'done' })]
  const view: GoalTraceView = { goal_id: 'g', traces: [
    { task_id: 'a', nodes: [
      { at: '2026-10-27T09:00:00.000Z', kind: 'dispatch', to: 'kimi' },
      { at: '2026-10-27T09:12:00.000Z', kind: 'start', actor: 'kimi' },
      { at: '2026-10-27T10:20:00.000Z', kind: 'return', actor: 'kimi', text: '交回本轮' },
      { at: '2026-10-27T10:20:00.000Z', kind: 'artifact', actor: 'kimi', evidence: ['docs/接续.md'] },
      { at: '2026-10-27T10:35:00.000Z', kind: 'rework', actor: 'me', text: '切手机后丢定位' },
    ], current: { state: 'running', actor: 'kimi', since: '2026-10-27T10:50:00.000Z' } },
    { task_id: 'b', nodes: [], current: { state: 'done' } },
  ] }
  it('只摆没做完的事项,一件一条;节点写谁、做了什么、产物', async () => {
    const api = collabApi('http://x', fetchOf(view))
    render(<TraceRail api={api} goalId="g" tasks={tasks} nameOf={id => (id === 'kimi' ? 'Kimi' : id === 'me' ? 'Ben' : String(id))} onOpen={() => {}} width={320} height={700} />)
    const lane = await screen.findByRole('group', { name: '接续原会话 的轨迹' })
    expect(lane).toHaveTextContent('派发')
    expect(lane).toHaveTextContent('→ Kimi')
    expect(lane).toHaveTextContent('开工')
    expect(lane).toHaveTextContent('交回')
    expect(lane).toHaveTextContent('docs/接续.md')
    expect(lane).toHaveTextContent('验收退回')
    expect(lane).toHaveTextContent('执行中')
    expect(screen.queryByRole('group', { name: '已做完 的轨迹' })).toBeNull()
    expect(screen.getByRole('region', { name: '事项轨迹' })).toHaveAttribute('data-dir', 'column')
  })
  it('宽的容器横排', async () => {
    render(<TraceRail api={collabApi('http://x', fetchOf(view))} goalId="g" tasks={tasks} nameOf={String} onOpen={() => {}} width={900} height={180} />)
    await screen.findByRole('group', { name: '接续原会话 的轨迹' })
    expect(screen.getByRole('region', { name: '事项轨迹' })).toHaveAttribute('data-dir', 'row')
  })
  it('没记录就说没有,不编节点', async () => {
    render(<TraceRail api={collabApi('http://x', fetchOf({ goal_id: 'g', traces: [{ task_id: 'a', nodes: [], current: { state: 'unknown' } }] }))} goalId="g" tasks={tasks} nameOf={String} onOpen={() => {}} width={320} height={700} />)
    const lane = await screen.findByRole('group', { name: '接续原会话 的轨迹' })
    expect(lane).toHaveTextContent('还没有执行记录')
    expect(lane).toHaveTextContent('状态未知')
  })
  it('轨迹接口取不到时如实说,不当成没事', async () => {
    render(<TraceRail api={collabApi('http://x', fetchOf({ error: 'nope' }, 404))} goalId="g" tasks={tasks} nameOf={String} onOpen={() => {}} width={320} height={700} />)
    await waitFor(() => expect(screen.getByRole('region', { name: '事项轨迹' })).toHaveTextContent('轨迹记录取不到'))
  })
  it('点事项名打开它', async () => {
    const onOpen = vi.fn()
    render(<TraceRail api={collabApi('http://x', fetchOf(view))} goalId="g" tasks={tasks} nameOf={String} onOpen={onOpen} width={320} height={700} />)
    await userEvent.click(await screen.findByRole('button', { name: '打开 接续原会话' }))
    expect(onOpen).toHaveBeenCalledWith('a')
  })
})
