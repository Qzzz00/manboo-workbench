import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { ButlerScene } from '../src/client/ButlerScene.tsx'
import { ButlerInbox, type ButlerInboxProps } from '../src/client/ButlerInbox.tsx'
import type { TaskView, WorkbenchState } from '../src/protocol.ts'
afterEach(cleanup)
const state: WorkbenchState = { agents: [], sessions: [], quota: {}, stale: false, now: '', tasks: { tasks: [{ id: 'a', title: '验收报告', status: 'confirm', direction: 'mine', source: { kind: 'manual' }, created_at: '', updated_at: 'v1', conversation: { agent: 'dsh', session_id: 's' }, owner_ask: { kind: 'publish', proposal: '发布这一版', basis: '整包绿', by: 'butler', at: 'v1' } }], sprints: [], modules: [], project_meta: [] }, butler_inbox: { items: [] } }
it('初始左侧空，阅读展开一件但不确认；后台更新不抢焦点；返回待机收空', async () => {
  const user = userEvent.setup(), onConfirm = vi.fn(), onOpen = vi.fn()
  const { rerender } = render(<ButlerScene state={state} onConfirm={onConfirm} onOpen={onOpen}><span>粒子</span></ButlerScene>)
  expect(screen.getByLabelText('当前聚焦事项')).toBeEmptyDOMElement()
  await user.click(screen.getByRole('button', { name: '查看事项:验收报告' }))
  expect(within(screen.getByLabelText('当前聚焦事项')).getByText('验收报告')).toBeInTheDocument()
  expect(onConfirm).not.toHaveBeenCalled()
  rerender(<ButlerScene state={{ ...state, now: 'next' }} onConfirm={onConfirm} onOpen={onOpen}><span>粒子</span></ButlerScene>)
  await user.click(screen.getByRole('button', { name: '打开事项:验收报告' }))
  expect(onOpen).toHaveBeenCalledWith('s')
  await user.click(screen.getByRole('button', { name: '确认收下:验收报告' }))
  expect(onConfirm).toHaveBeenCalledWith('a')
  await user.click(screen.getByRole('button', { name: '返回待机' }))
  expect(screen.getByLabelText('当前聚焦事项')).toBeEmptyDOMElement()
})
it('正式入口阅读不POST，确认走原route并显示失败；切走保留实例与草稿', async () => {
  const user = userEvent.setup(), fetchImpl = vi.fn(async () => ({ ok: false, json: async () => ({ ok: false, error: '确认被拒绝' }) }))
  const props: ButlerInboxProps = { state, baseUrl: '/service', fetchImpl: fetchImpl as unknown as typeof fetch, onOpenConversation: vi.fn(), draft: '保留草稿', onDraftChange: vi.fn(), visible: true, controls: { paused: false, testRinging: false, onPause: vi.fn(), onTestRing: vi.fn(), onCancelWatch: vi.fn(), onDismissBrief: vi.fn(), proposals: [] } }
  const { rerender } = render(<ButlerInbox {...props} />)
  await user.click(screen.getByRole('button', { name: '查看事项:验收报告' }))
  // 阅读不写:点开一件事只读(外观同步 GET 一次 /butler/appearance;2026-09-25 卡 M 起事项里那一段对话 GET 一次 /turns),一个写都没有。
  expect((fetchImpl.mock.calls as unknown as [string, RequestInit | undefined][]).filter(([, init]) => init?.method !== undefined && init.method !== 'GET')).toHaveLength(0)
  await user.click(screen.getByRole('button', { name: '确认收下:验收报告' }))
  expect(fetchImpl).toHaveBeenCalledWith('/service/task/move', expect.objectContaining({ body: JSON.stringify({ id: 'a', status: 'done' }) }))
  expect(await screen.findByText('确认被拒绝')).toBeInTheDocument()
  const input = screen.getByLabelText('交给事务官一件事')
  rerender(<ButlerInbox {...props} visible={false} />)
  rerender(<ButlerInbox {...props} />)
  expect(screen.getByLabelText('交给事务官一件事')).toBe(input)
  expect(input).toHaveValue('保留草稿')
  expect(within(screen.getByLabelText('当前聚焦事项')).getByText('验收报告')).toBeInTheDocument()
})
it('后台执行时球就在办(2026-09-16 Ben:进行中该一直转)；聚焦/返回待机都不改这一点，计数不变', async () => {
  const active: WorkbenchState = { ...state, running: { count: 1, items: [{ key: 'task:a', task_id: 'a', agent: 'dsh', text: '验收报告' }] }, tasks: { ...state.tasks!, tasks: [{ ...state.tasks!.tasks[0]!, status: 'doing', links: [{ agent: 'dsh', session_id: 's' }] }] }, sessions: [{ agent: 'dsh', session_id: 's', status: 'running', project: '', elapsed_sec: 1, unread: false, updated_at: 'v1' }] }
  render(<ButlerInbox state={active} baseUrl="/service" fetchImpl={vi.fn()} onOpenConversation={vi.fn()} draft="" onDraftChange={vi.fn()} visible controls={{ paused: false, testRinging: false, onPause: vi.fn(), onTestRing: vi.fn(), onCancelWatch: vi.fn(), onDismissBrief: vi.fn(), proposals: [] }} />)
  expect(screen.getByRole('img', { name: /^事务官:/ })).toHaveAttribute('data-state', 'busy')
  await userEvent.click(screen.getByRole('button', { name: '查看事项:验收报告' }))
  expect(screen.getByRole('img', { name: /^事务官:/ })).toHaveAttribute('data-state', 'busy')
  expect(screen.getByText('正在执行当前事项')).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: '返回待机' }))
  expect(screen.getByRole('img', { name: /^事务官:/ })).toHaveAttribute('data-state', 'busy')
  expect(screen.getByText('执行 1 · 排队 0 · 等你 0')).toBeInTheDocument()
})
it('等我确认的卡:聚焦详情里能看到交付物里的回答与依据(2026-09-16)', async () => {
  const replied: WorkbenchState = { ...state, tasks: { ...state.tasks!, tasks: [{ ...state.tasks!.tasks[0]!, deliverables: [{ kind: 'reply', ref: '我是 DeepSeek-V3', session_id: 's' }] }] } }
  render(<ButlerScene state={replied} onConfirm={vi.fn()} onOpen={vi.fn()}>粒子</ButlerScene>)
  await userEvent.click(screen.getByRole('button', { name: '查看事项:验收报告' }))
  const focus = screen.getByLabelText('当前聚焦事项')
  expect(within(focus).getByText('我是 DeepSeek-V3')).toBeInTheDocument()
  expect(within(focus).getByText('回答')).toBeInTheDocument()
})
it('标了四类拍板请求:详情里摆「要拍板 / 方案 / 依据」;没标的:不给「确认」键、只摆「事务官核验中」(2026-10-26,卡「事务官页接管队列」)', async () => {
  render(<ButlerScene state={state} onConfirm={vi.fn()} onOpen={vi.fn()}>粒子</ButlerScene>)
  await userEvent.click(screen.getByRole('button', { name: '查看事项:验收报告' }))
  const focus = screen.getByLabelText('当前聚焦事项')
  expect(within(focus).getByText('要拍板:对外发布')).toBeInTheDocument()
  expect(within(focus).getByText('方案:发布这一版')).toBeInTheDocument()
  expect(within(focus).getByText('依据:整包绿')).toBeInTheDocument()
  cleanup()
  // 没标 owner_ask 的「等我确认」:没有「确认收下」键,状态字是「事务官核验中」。
  const bare: TaskView = { ...state.tasks!.tasks[0]! }
  delete bare.owner_ask
  const unmarked: WorkbenchState = { ...state, tasks: { ...state.tasks!, tasks: [bare] } }
  render(<ButlerScene state={unmarked} onConfirm={vi.fn()} onOpen={vi.fn()}>粒子</ButlerScene>)
  await userEvent.click(screen.getByRole('button', { name: '查看事项:验收报告' }))
  const pending = screen.getByLabelText('当前聚焦事项')
  expect(within(pending).queryByRole('button', { name: '确认收下:验收报告' })).toBeNull()
  expect(within(pending).getByText('事务官核验中')).toBeInTheDocument()
})

function runningState(count: number): WorkbenchState {
  return { ...state, tasks: { ...state.tasks!, tasks: Array.from({ length: count }, (_, i) => ({ ...state.tasks!.tasks[0]!, id: `job-${i}`, title: `执行事项 ${i}`, status: 'doing', links: [{ agent: 'dsh', session_id: `s-${i}` }] })) }, sessions: Array.from({ length: count }, (_, i) => ({ agent: 'dsh', session_id: `s-${i}`, status: 'running', project: '', elapsed_sec: 1, unread: false, updated_at: 'v1' })) }
}
it('执行卡不随选择搬走；仅真实执行项连球，结果三个夹不连线', async () => {
  const active = runningState(3)
  active.tasks = { ...active.tasks!, tasks: [...active.tasks!.tasks, ...state.tasks!.tasks] }
  const { container } = render(<ButlerScene state={active} onConfirm={vi.fn()} onOpen={vi.fn()}>粒子</ButlerScene>)
  const card = screen.getByRole('button', { name: '查看事项:执行事项 0' })
  expect(container.querySelectorAll('[data-task-link]')).toHaveLength(3)
  await userEvent.click(card)
  expect(screen.getByRole('button', { name: '查看事项:执行事项 0' })).toBe(card)
  const results = screen.getByLabelText('结果事项夹')
  expect(within(results).getAllByRole('region')).toHaveLength(3)
  expect(results.querySelector('svg')).toBeNull()
  await userEvent.click(screen.getByRole('button', { name: '查看事项:验收报告' }))
  expect(container.querySelectorAll('[data-task-link]')).toHaveLength(3)
})
it('七件执行事项可翻页；后台结束后页码有效且等待/未知记录不伪造连线', async () => {
  const active = runningState(7)
  const { container, rerender } = render(<ButlerScene state={active} onConfirm={vi.fn()} onOpen={vi.fn()}>粒子</ButlerScene>)
  expect(container.querySelectorAll('[data-task-link]')).toHaveLength(6)
  await userEvent.click(screen.getByRole('button', { name: '下一组执行事项' }))
  await userEvent.click(screen.getByRole('button', { name: '查看事项:执行事项 6' }))
  expect(container.querySelectorAll('[data-task-link]')).toHaveLength(1)
  const next = runningState(2)
  next.sessions[1]!.status = 'waiting'
  rerender(<ButlerScene state={next} onConfirm={vi.fn()} onOpen={vi.fn()}>粒子</ButlerScene>)
  expect(container.querySelectorAll('[data-task-link]')).toHaveLength(1)
  expect(screen.getByRole('button', { name: '查看事项:执行事项 1' })).toBeInTheDocument()
})
it('初载、阅读和时钟刷新无假流光，输出版本变化才沿该事项回传', async () => {
  const active = runningState(1)
  const { container, rerender } = render(<ButlerScene state={active} onConfirm={vi.fn()} onOpen={vi.fn()}>粒子</ButlerScene>)
  expect(container.querySelector('[data-progress-pulse]')).toBeNull()
  await userEvent.click(screen.getByRole('button', { name: '查看事项:执行事项 0' }))
  rerender(<ButlerScene state={{ ...active, now: 'next' }} onConfirm={vi.fn()} onOpen={vi.fn()}>粒子</ButlerScene>)
  expect(container.querySelector('[data-progress-pulse]')).toBeNull()
  const renamed = { ...active, tasks: { ...active.tasks!, tasks: [{ ...active.tasks!.tasks[0]!, title: '改个标题', updated_at: 'v2' }] } }
  rerender(<ButlerScene state={renamed} onConfirm={vi.fn()} onOpen={vi.fn()}>粒子</ButlerScene>)
  expect(container.querySelector('[data-progress-pulse]')).toBeNull()
  // 「在做什么」换一句(轮询读出来的状态,几秒一换)不走光(2026-09-25,卡 P)。
  rerender(<ButlerScene state={{ ...active, sessions: [{ ...active.sessions[0]!, activity: { line: '在跑测试', at: '2026-09-25T08:00:00.000Z' } }] }} onConfirm={vi.fn()} onOpen={vi.fn()}>粒子</ButlerScene>)
  expect(container.querySelector('[data-progress-pulse]')).toBeNull()
  rerender(<ButlerScene state={{ ...active, sessions: [{ ...active.sessions[0]!, summary: '结果已回传', updated_at: 'v2' }] }} onConfirm={vi.fn()} onOpen={vi.fn()}>粒子</ButlerScene>)
  expect(container.querySelector('[data-progress-pulse="job-0"]')).not.toBeNull()
})
