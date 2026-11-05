import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BoardModule, SprintView, TaskClientDispatch, TaskView, WorkbenchProject } from '../src/protocol.ts'
import { TaskBoard, type BoardActions } from '../src/client/TaskBoard.tsx'
import { dispatchBadgeText, dispatchTitle } from '../src/client/boardModel.ts'

/**
 * 事项卡上那一格:「派给 Claude(窗口)· 已送出」(2026-09-21)。
 *
 * 这一格只回答**"这段话送到哪儿去了"**。"在跑 / 等确认 / 完成"不归它管 ——
 * 那是关联窗口那几个状态点(现查会话,不落盘)。
 */
afterEach(cleanup)

const AT = '2026-09-21T10:00:00.000Z'

function dispatch(over: Partial<TaskClientDispatch> = {}): TaskClientDispatch {
  return { hand: 'window', family: 'claude', status: 'sent', at: AT, text: '把登录那段看一下', ...over }
}

function task(over: Partial<TaskView> = {}): TaskView {
  return {
    id: 'a', title: '把登录那段看一下', status: 'doing', project_id: 'p1',
    source: { kind: 'manual' }, created_at: AT, updated_at: AT, ...over,
  }
}

function board(tasks: readonly TaskView[]) {
  const actions = {
    createTask: vi.fn(), moveTask: vi.fn(), updateTask: vi.fn(), deleteTask: vi.fn(),
    createSprint: vi.fn(), updateSprint: vi.fn(), deleteSprint: vi.fn(),
    createModule: vi.fn(), updateModule: vi.fn(), deleteModule: vi.fn(),
    setProjectMeta: vi.fn(),
  } satisfies BoardActions
  const sprint: SprintView = { id: 's1', project_id: 'p1', name: '冲刺一', versions: [], created_at: AT, updated_at: AT }
  const boardModule: BoardModule = { id: 'm1', sprint_id: 's1', name: '登录', created_at: AT, updated_at: AT }
  const projects: WorkbenchProject[] = [{ id: 'p1', name: '工作台', stage: 'MVP 开发', links: [], session_count: 0, idle: false }]
  render(
    <TaskBoard
      tasks={tasks}
      sprints={[sprint]}
      modules={[boardModule]}
      projectMeta={[]}
      projects={projects}
      sessions={[]}
      now={AT}
      axis="module-rows"
      onAxisChange={vi.fn()}
      actions={actions}
    />,
  )
}

describe('卡面「已送出」那一格', () => {
  it('送成了就显示派给谁', () => {
    board([task({ client_dispatch: dispatch() })])
    expect(screen.getByText('派给 Claude(窗口)· 已送出')).toBeInTheDocument()
  })

  it('★没派过窗口的卡整格不出现(没有"未派活"这种话)', () => {
    board([task()])
    expect(screen.queryByText(/派给/)).not.toBeInTheDocument()
  })

  it('★鼠标停一下能看见送出去的原话 —— 我们以他的名义说了什么,他得看得见', () => {
    board([task({ client_dispatch: dispatch() })])
    expect(screen.getByText('派给 Claude(窗口)· 已送出'))
      .toHaveAttribute('title', expect.stringContaining('把登录那段看一下'))
  })

  it('★没送成的那张也显示,原因原样挂在上面(不藏起来)', () => {
    board([task({ client_dispatch: dispatch({ status: 'failed', reason: '输入框没找到:…… AX 树里没有任何文本输入元素' }) })])
    const badge = screen.getByText('派给 Claude(窗口)· 没送成')
    expect(badge).toHaveAttribute('data-status', 'failed')
    expect(badge).toHaveAttribute('title', expect.stringContaining('输入框没找到'))
  })

  it('替他按过发送的那次说清楚了', () => {
    board([task({ client_dispatch: dispatch({ submitted: true }) })])
    expect(screen.getByText('派给 Claude(窗口)· 已送出并发送')).toBeInTheDocument()
  })

  it('★卡上一眼看得出派出去了没有(2026-09-30 维护者拍板:成功不回电话,那就得看得见)', () => {
    board([task({ client_dispatch: dispatch({ submitted: true, seen_at: AT, reply_state: 'waiting' }) })])
    const line = screen.getByText('已派出 · Claude那边看到了')
    expect(line).toHaveAttribute('data-delivery', 'seen')
  })

  it('★按了发送、没在它那边核上:说「我在盯着」,不说已送达', () => {
    board([task({ client_dispatch: dispatch({ submitted: true, reply_state: 'waiting', confirm_note: '按了发送,可这会儿还没在它对话区里看见这句话' }) })])
    const line = screen.getByText('按了发送,还没在Claude那边看到 —— 我在盯着')
    expect(line).toHaveAttribute('data-delivery', 'unconfirmed')
    expect(line).toHaveAttribute('title', expect.stringContaining('还没在它对话区里看见'))
  })

  it('★没派出去的两档写清原因', () => {
    board([task({ client_dispatch: dispatch({ status: 'failed', reason: '找不到窗口:Claude 没在运行' }) })])
    expect(screen.getByText('没派出去:找不到窗口:Claude 没在运行')).toHaveAttribute('data-delivery', 'failed')
    cleanup()
    board([task({ client_dispatch: dispatch({ status: 'typed' }) })])
    expect(screen.getByText('没派出去:字写进Claude的输入框了,没发出去')).toHaveAttribute('data-delivery', 'typed')
  })

  it('认上会话就把会话 id 挂在 title 上;认不准时写那句话', () => {
    expect(dispatchTitle(dispatch({ session_id: 'sess-9' }))).toContain('sess-9')
    expect(dispatchTitle(dispatch({ match_note: '同时冒出 2 条新会话,认不准' }))).toContain('认不准')
  })

  it('★这一格与服务端那份是同一串字(两边各有一条用例钉着)', () => {
    // server/dispatchClient.ts 的 dispatchBadgeText 逐字相同 —— 那一份由
    // tests/server-dispatch-client.test.ts 钉住,这里钉客户端这一份。
    expect(dispatchBadgeText(dispatch())).toBe('派给 Claude(窗口)· 已送出')
    expect(dispatchBadgeText(dispatch({ family: 'kimi', status: 'failed' }))).toBe('派给 Kimi(窗口)· 没送成')
    expect(dispatchBadgeText(dispatch({ family: 'doubao' }))).toBe('派给 豆包办公(窗口)· 已送出')
    // 2026-09-24(卡 F):与服务端那一份同样多三档(逐字相同)。
    expect(dispatchBadgeText(dispatch({ family: 'muse', submitted: true, reply_state: 'waiting' }))).toBe('派给 Muse(窗口)· 已发出,等它回答')
    expect(dispatchBadgeText(dispatch({ family: 'manus', submitted: true, reply_state: 'done' }))).toBe('派给 Manus(窗口)· 回来了')
    expect(dispatchBadgeText(dispatch({ family: 'kimi', submitted: true, reply_state: 'unreadable' }))).toBe('派给 Kimi(窗口)· 已发出,结果在 Kimi 里')
  })
})
