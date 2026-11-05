import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CollabGoal, CollabSprint, TaskView } from '../src/protocol.ts'
import { ProgressSummary } from '../src/client/collab/ProgressSummary.tsx'

afterEach(cleanup)

const AT = '2026-10-23T10:00:00.000Z'
const makeTask = (id: string, patch: Partial<TaskView> = {}): TaskView => ({
  id,
  title: `事项-${id}`,
  status: 'todo',
  source: { kind: 'manual' },
  created_at: AT,
  updated_at: AT,
  ...patch,
})

describe('ProgressSummary: 真实进展可读摘要组件', () => {
  const goals: CollabGoal[] = [{
    id: 'g-1',
    title: '座机打通',
    owner: 'me',
    status: 'open',
    created_at: AT,
    updated_at: AT,
  }]

  const sprints: CollabSprint[] = [{
    id: 's-1',
    title: '冲刺一',
    goal_ids: ['g-1'],
    created_at: AT,
    updated_at: AT,
  }]

  it('正确渲染摘要条：范围、数量分布、父子去重与隔离提示', () => {
    const tasks: TaskView[] = [
      makeTask('t-p', { children: ['t-c1', 't-c2'], title: '父任务组' }),
      makeTask('t-c1', { status: 'doing', dispatch: { family: 'codex', status: 'running', started_at: AT }, title: '子任务1' }),
      makeTask('t-c2', { status: 'confirm', receipt: { kind: 'done', text: '已交回', at: AT }, title: '子任务2' }),
      makeTask('t-blocked', { status: 'blocked', block_reason: 'approval', title: '受阻事项' }),
      makeTask('t-demo', { demo: true, status: 'doing', title: '演示事项' }),
    ]

    render(
      <ProgressSummary
        tasks={tasks}
        runs={[{ task_id: 't-c1', source: 'codex', started_at: AT, status: 'running' }]}
        goals={goals}
        sprints={sprints}
        filter={{ goal: ['g-1'] }}
        nowMs={Date.parse(AT)}
      />
    )

    // 范围显示
    expect(screen.getByText('目标: 座机打通')).toBeInTheDocument()
    // 父子去重说明
    expect(screen.getByText(/含 1 个任务组，已去重/)).toBeInTheDocument()
    // 演示数据隔离
    expect(screen.getByText(/已隔离 1 件演示数据/)).toBeInTheDocument()

    // 芯片数量
    expect(screen.getByRole('button', { name: /真实执行中 1/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /交回待验 1/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /受阻 1/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /本轮剩余 3/ })).toBeInTheDocument()
  })

  it('点击某状态芯片可展开清单，展示负责人、真实回执时间、阻塞原因，点击可定位事项', async () => {
    const user = userEvent.setup()
    const onFlyToNote = vi.fn()
    const onOpenTask = vi.fn()

    const tasks: TaskView[] = [
      makeTask('t-blocked', {
        status: 'blocked',
        block_reason: 'approval',
        assignee: 'agent:local:kimi',
        title: '需要等待审批的活',
      }),
    ]

    render(
      <ProgressSummary
        tasks={tasks}
        goals={goals}
        nowMs={Date.parse(AT)}
        onFlyToNote={onFlyToNote}
        onOpenTask={onOpenTask}
      />
    )

    // 点击受阻芯片
    await user.click(screen.getByRole('button', { name: /受阻 1/ }))

    // 抽屉展开
    expect(screen.getByRole('region', { name: '进展清单明细' })).toBeInTheDocument()
    expect(screen.getByText('需要等待审批的活')).toBeInTheDocument()
    expect(screen.getByText(/等审批/)).toBeInTheDocument()

    // 点击事项标题触发定位与打开
    await user.click(screen.getByRole('button', { name: '定位: 需要等待审批的活' }))
    expect(onFlyToNote).toHaveBeenCalledWith('t-blocked')
  })

  it('点击验收条件切换至能力条件清单，未写条件的标明尚未安排', async () => {
    const user = userEvent.setup()
    const tasks: TaskView[] = [
      makeTask('t1', { acceptance: ['真机通话接通', '延迟小于500ms'], title: '通话优化' }),
      makeTask('t2', { title: '暂未写条件的事项' }),
    ]

    render(
      <ProgressSummary
        tasks={tasks}
        goals={goals}
        nowMs={Date.parse(AT)}
      />
    )

    await user.click(screen.getByRole('button', { name: /事项验收要求 3/ }))

    expect(screen.getByText('真机通话接通')).toBeInTheDocument()
    expect(screen.getByText('延迟小于500ms')).toBeInTheDocument()
    expect(screen.getByText(/未声明验收条件：尚未安排/)).toBeInTheDocument()
  })

  it('非目标范围时条件抽屉标题不冒称「目标验收条件」', async () => {
    const user = userEvent.setup()
    const tasks: TaskView[] = [makeTask('t1', { acceptance: ['条件一'], title: '普通事项' })]

    render(
      <ProgressSummary
        tasks={tasks}
        goals={goals}
        nowMs={Date.parse(AT)}
      />
    )

    await user.click(screen.getByRole('button', { name: /事项验收要求 1/ }))
    expect(screen.getByRole('heading', { name: '事项验收要求清单 (1 条)' })).toBeInTheDocument()
  })

  it('目标范围也明确这些是事项要求,不冒充目标能力条件', async () => {
    const user = userEvent.setup()
    const tasks: TaskView[] = [makeTask('t1', { acceptance: ['条件一'], goal_id: 'g-1', title: '目标内事项' })]

    render(
      <ProgressSummary
        tasks={tasks}
        goals={goals}
        filter={{ goal: ['g-1'] }}
        nowMs={Date.parse(AT)}
      />
    )

    await user.click(screen.getByRole('button', { name: /事项验收要求 1/ }))
    expect(screen.getByRole('heading', { name: '事项验收要求清单 (1 条)' })).toBeInTheDocument()
  })

  it('点击关闭按钮可收起清单抽屉', async () => {
    const user = userEvent.setup()
    const tasks: TaskView[] = [makeTask('t1', { status: 'todo' })]

    render(
      <ProgressSummary
        tasks={tasks}
        goals={goals}
        nowMs={Date.parse(AT)}
      />
    )

    // 展开
    await user.click(screen.getByRole('button', { name: /未开始 1/ }))
    expect(screen.getByRole('region', { name: '进展清单明细' })).toBeInTheDocument()

    // 关闭
    await user.click(screen.getByRole('button', { name: '收起清单' }))
    expect(screen.queryByRole('region', { name: '进展清单明细' })).not.toBeInTheDocument()
  })
})
