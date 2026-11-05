import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import type { CollabGoal, TaskView } from '../src/protocol.ts'
import type { CollabApi } from '../src/client/collab/collabApi.ts'
import { GoalPanel } from '../src/client/collab/GoalPanel.tsx'
import { RunsPanel } from '../src/client/collab/RunsPanel.tsx'
import { RelationsPanel } from '../src/client/collab/RelationsPanel.tsx'
import { mentionsOf, NoteTalk } from '../src/client/collab/NoteTalk.tsx'
import { TimelineView } from '../src/client/collab/TimelineView.tsx'
import { CollabZone } from '../src/client/collab/CollabZone.tsx'
import { GOAL_CONDITION_TITLES } from '../src/client/collab/collabContract.ts'
import { classifyExecutionTruth } from '../src/client/collab/progressModel.ts'

afterEach(() => { cleanup(); localStorage.clear() })
const at = '2026-10-24T09:00:00Z'
const task: TaskView = { id: 't1', title: '制作可验产物', status: 'confirm', source: { kind: 'manual' }, created_at: at, updated_at: at }
const goal: CollabGoal = { id: 'g1', title: '可交付目标', owner: 'me', status: 'open', created_at: at, updated_at: at }

it('同一句失败重试复用请求号,改为回复另一条记录时用新请求号', async () => {
  const user = userEvent.setup()
  const posts: Array<{ client_msg_id: string, reply_to: string }> = []
  const api: CollabApi = {
    get: async () => ({ items: ['第一条', '第二条'].map((text, index) => ({ type: 'message', at, message: { id: `m${index}`, by: 'me', text, intent: 'record', at } })) }) as never,
    post: async (_path, body) => { posts.push(body as typeof posts[number]); return { ok: false, body: {}, error: '暂时不可达' } },
  }
  render(<NoteTalk task={task} cards={[]} api={api} onReceipt={() => {}} />)
  const first = (await screen.findByText('第一条')).closest('li')!
  await user.click(within(first).getByRole('button', { name: '回复' }))
  await user.type(screen.getByLabelText('留一句'), '同一句答复')
  await user.click(screen.getByRole('button', { name: '留言' }))
  await user.click(screen.getByRole('button', { name: '留言' }))
  expect(posts[1]!.client_msg_id).toBe(posts[0]!.client_msg_id)
  await user.click(within(screen.getByText('第二条').closest('li')!).getByRole('button', { name: '回复' }))
  await user.click(screen.getByRole('button', { name: '留言' }))
  expect(posts[2]!.reply_to).toBe('m1')
  expect(posts[2]!.client_msg_id).not.toBe(posts[0]!.client_msg_id)
})

it('摘要不把启动了进程当开工,只有实际运行账或明确新鲜活动才可计入', () => {
  const dispatched = { ...task, status: 'doing', dispatch: { family: 'codex', status: 'running', started_at: at, pid: 12345 } } as TaskView
  expect(classifyExecutionTruth(dispatched)).toBe('waiting_receipt')
  expect(classifyExecutionTruth(dispatched, { runs: [{ task_id: task.id, status: 'dispatched', source: 'codex', started_at: at }] } as never)).toBe('waiting_receipt')
  expect(classifyExecutionTruth(dispatched, { runs: [{ task_id: task.id, status: 'running', source: 'codex', started_at: at }] } as never)).toBe('running')
})

it('已交付和仅已验收各自有准确状态文案', () => {
  expect(GOAL_CONDITION_TITLES.delivered).toBe('已交付')
  expect(GOAL_CONDITION_TITLES.verified).toBe('已验收')
})

it('活动暂时不可读时保留精确邀请回执,标明上次记录并保留草稿', async () => {
  const user = userEvent.setup()
  let online = true
  const api: CollabApi = { get: async () => online ? { items: [{ type: 'message', at, message: { id: 'm1', by: 'me', text: '真实已读活动', intent: 'record', at } }] } as never : undefined, post: async () => ({ ok: false, body: {} }) }
  const view = render(<NoteTalk task={task} cards={[]} api={api} onReceipt={() => {}} />)
  await screen.findByText('真实已读活动')
  await user.type(screen.getByLabelText('留一句'), '尚未发出的草稿')
  online = false
  view.rerender(<NoteTalk task={{ ...task, updated_at: '2026-10-24T09:01:00Z' }} cards={[]} api={api} onReceipt={() => {}} />)
  await screen.findByText(/活动暂时读不到/)
  expect(screen.getByText('真实已读活动')).toBeInTheDocument()
  expect(screen.getByLabelText('留一句')).toHaveValue('尚未发出的草稿')
})

it('条件可在界面关联事项并保存证据,核验操作不会误打开事项', async () => {
  const user = userEvent.setup()
  const onOpen = vi.fn()
  const posts: Array<{ path: string, body: unknown }> = []
  const api: CollabApi = {
    get: async () => ({ summary: { scope: '当前目标', conditions: { total: 1, by_state: {}, items: [{ id: 'c1', text: '产物能读取', task_id: 't1', state: 'submitted' }] }, tasks: { total: 1, canceled: 0 } } }) as never,
    post: async (path, body) => { posts.push({ path, body }); return { ok: true, body: { ok: true } } },
  }
  render(<GoalPanel goal={goal} api={api} snapshotKey={{ tasks: [task] } as never} onOpenTask={onOpen} onClose={() => {}} />)
  await user.selectOptions(await screen.findByLabelText('承接事项 · 产物能读取'), 't1')
  await user.type(screen.getByLabelText('验收证据 · 产物能读取'), '/tmp/result.txt\n验收编号 QA-1')
  await user.click(screen.getByRole('button', { name: '保存承接与证据' }))
  expect(posts).toContainEqual({ path: '/collab/goal/condition/save', body: { goal_id: 'g1', id: 'c1', text: '产物能读取', task_id: 't1', evidence: ['/tmp/result.txt', '验收编号 QA-1'] } })
  await user.type(screen.getByLabelText('核验依据'), '已对照实际产物')
  await user.click(screen.getByRole('button', { name: '核验通过' }))
  expect(onOpen).not.toHaveBeenCalled()
  await user.click(screen.getByRole('button', { name: '查看承接事项' }))
  expect(onOpen).toHaveBeenCalledWith('t1')
})

it('同一事项快照更新后运行片段会刷新,不保留旧开工状态', async () => {
  let status = 'running'
  const api: CollabApi = {
    get: async () => ({ runs: [{ task_id: 't1', source: 'codex', status, started_at: at, pause_reason: '等待人工检查' }] }) as never,
    post: async () => ({ ok: true, body: {} }),
  }
  const view = render(<RunsPanel taskId="t1" api={api} snapshotKey={1} />)
  await screen.findByText(/实际运行中/)
  status = 'paused'
  view.rerender(<RunsPanel taskId="t1" api={api} snapshotKey={2} />)
  await waitFor(() => expect(screen.getByText(/暂停等待.*等待人工检查/)).toBeInTheDocument())
  expect(screen.queryByText(/实际运行中/)).not.toBeInTheDocument()
})

it('关系删除成功后立即消失,同事项上游快照更新后呈现旧交接提醒', async () => {
  const user = userEvent.setup()
  let rows = [{ id: 'r1', from_id: 't1', to_id: 't2', kind: 'handoff', note: '交给乙验收', created_at: at, stale: false }]
  const api: CollabApi = {
    get: async () => ({ relations: rows }) as never,
    post: async () => { rows = []; return { ok: true, body: { ok: true } } },
  }
  const view = render(<RelationsPanel taskId="t1" tasks={[task]} api={api} onOpenTask={() => {}} />)
  await screen.findByText('交给乙验收')
  rows = [{ ...rows[0]!, stale: true }]
  view.rerender(<RelationsPanel taskId="t1" tasks={[{ ...task, round: 2 }]} api={api} onOpenTask={() => {}} />)
  await screen.findByText('上游重开,旧交接需复核')
  await user.click(screen.getByRole('button', { name: '删' }))
  await waitFor(() => expect(screen.queryByText('交给乙验收')).not.toBeInTheDocument())
})

it('@较长名字不会同时邀请前缀名字或相似名字', () => {
  expect(mentionsOf('@Codex 名片 请处理', [
    { id: 'short', name: 'Codex', kind: 'card', online: true },
    { id: 'long', name: 'Codex 名片', kind: 'card', online: true },
  ])).toEqual(['long'])
  expect(mentionsOf('@Anna 请处理', [{ id: 'ann', name: 'Ann', kind: 'card', online: true }])).toEqual([])
})

it('切换事项不会把上一件的草稿写入下一件,发送后立即读取真实活动', async () => {
  const user = userEvent.setup()
  localStorage.clear()
  let items: unknown[] = []
  const api: CollabApi = {
    get: async () => ({ items }) as never,
    post: async (_path, body) => {
      const message = { id: 'm1', by: 'me', text: (body as { text: string }).text, at, intent: 'record' }
      items = [{ type: 'message', at, message }]
      return { ok: true, body: { ok: true, message } }
    },
  }
  const props = { cards: [], api, onReceipt: () => {} }
  const view = render(<NoteTalk task={task} {...props} />)
  await user.type(screen.getByRole('textbox', { name: '留一句' }), '甲的半句草稿')
  view.rerender(<NoteTalk task={{ ...task, id: 't2', title: '乙事项' }} {...props} />)
  await waitFor(() => expect(screen.getByRole('textbox', { name: '留一句' })).toHaveValue(''))
  expect(localStorage.getItem('ben-wb.note-draft.t1')).toContain('甲的半句草稿')
  expect(localStorage.getItem('ben-wb.note-draft.t2')).toBeNull()
  await user.type(screen.getByRole('textbox', { name: '留一句' }), '乙事项的留言')
  await user.click(screen.getByRole('button', { name: '留言' }))
  await screen.findByText('乙事项的留言')
})

it('已派出但没有开工证据不显示实际运行,未知的新状态也不冒运行', async () => {
  let status = 'dispatched'
  const api: CollabApi = { get: async () => ({ runs: [{ task_id: 't1', source: 'codex', status, started_at: at }] }) as never, post: async () => ({ ok: true, body: {} }) }
  const view = render(<RunsPanel taskId="t1" api={api} snapshotKey={1} />)
  await screen.findByText(/已派出.*待开工证据/)
  expect(screen.queryByText(/实际运行/)).not.toBeInTheDocument()
  status = 'future-state'
  view.rerender(<RunsPanel taskId="t1" api={api} snapshotKey={2} />)
  await screen.findByText(/状态未知/)
})

it('邀请展示精确执行事项与真实回执,不会把已投递说成已完成', async () => {
  const open = vi.fn()
  const api: CollabApi = { get: async () => ({ items: [{ type: 'message', at, message: { id: 'm1', by: 'me', text: '核对产物', at, intent: 'ask', deliveries: [{ to: 'codex', task_id: 'execution-1', status: 'accepted', at, receipt: { kind: 'objection', by: 'codex', at, text: '有异议:验收编号缺失' } }] } }] }) as never, post: async () => ({ ok: true, body: {} }) }
  render(<NoteTalk task={task} cards={[]} api={api} onReceipt={() => {}} onOpenTask={open} />)
  await screen.findByText(/验收编号缺失/)
  await userEvent.setup().click(screen.getByRole('button', { name: '查看协作执行事项' }))
  expect(open).toHaveBeenCalledWith('execution-1')
  expect(screen.queryByText(/已完成/)).not.toBeInTheDocument()
})

it('退回后仍在制作的事项不能在条件面板提前核验', async () => {
  const api: CollabApi = { get: async () => ({ summary: { scope: '当前目标', conditions: { total: 1, by_state: {}, items: [{ id: 'c1', text: '已退回的条件', task_id: 't1', state: 'rework' }] }, tasks: { total: 1, canceled: 0 } } }) as never, post: async () => ({ ok: true, body: {} }) }
  render(<GoalPanel goal={goal} api={api} snapshotKey={{ tasks: [{ ...task, status: 'doing', round: 2 }] } as never} onOpenTask={() => {}} onClose={() => {}} />)
  await screen.findByText('已退回的条件')
  expect(screen.queryByRole('button', { name: '核验通过' })).not.toBeInTheDocument()
  expect(screen.getByText('成果还没交回,没得验')).toBeInTheDocument()
})

it('时间线把计划与实际分开,实际账无开工证据时显示待证据并能回到同事项', async () => {
  const open = vi.fn()
  const api: CollabApi = { get: async () => ({ runs: [{ task_id: 't1', source: 'codex', status: 'dispatched', started_at: at }] }) as never, post: async () => ({ ok: true, body: {} }) }
  render(<TimelineView tasks={[{ ...task, start: at, status: 'doing' }]} meetings={[]} anchorKey="2026-10-24" nowMs={Date.parse(at)} api={api} shown={() => true} typeOf={() => undefined} ownerText={() => 'Codex'} onOpenNote={open} onOpenMeeting={() => {}} onStamp={() => {}} />)
  await screen.findByRole('region', { name: '实际执行记录' })
  await screen.findByText(/待开工证据/)
  expect(screen.getByText('计划与会话记录')).toBeInTheDocument()
  await userEvent.setup().click(screen.getByRole('button', { name: '查看实际记录 · 制作可验产物' }))
  expect(open).toHaveBeenCalledWith('t1')
})

it('条件接口断开保留上次已知条件,恢复快照后重新可操作', async () => {
  let online = true
  const api: CollabApi = { get: async () => online ? { summary: { scope: '当前目标', conditions: { total: 1, by_state: {}, items: [{ id: 'c1', text: '保留的条件', state: 'submitted' }] }, tasks: { total: 1, canceled: 0 } } } as never : undefined, post: async () => ({ ok: true, body: {} }) }
  const view = render(<GoalPanel goal={goal} api={api} snapshotKey={{ tasks: [task] } as never} onOpenTask={() => {}} onClose={() => {}} />)
  await screen.findByText('保留的条件')
  online = false
  view.rerender(<GoalPanel goal={goal} api={api} snapshotKey={{ tasks: [task] } as never} onOpenTask={() => {}} onClose={() => {}} />)
  await screen.findByText(/保留上次已知条件/)
  expect(screen.getByText('保留的条件')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '核验通过' })).toBeDisabled()
  online = true
  view.rerender(<GoalPanel goal={goal} api={api} snapshotKey={{ tasks: [task] } as never} onOpenTask={() => {}} onClose={() => {}} />)
  await waitFor(() => expect(screen.getByRole('button', { name: '核验通过' })).toBeEnabled())
})

it('Agent 掉线时保留已有事项并明确标记上次已知状态', async () => {
  const fetchImpl = (async () => new Response(JSON.stringify({ layout: { goals: {}, notes: {} }, items: [] }), { headers: { 'content-type': 'application/json' } })) as typeof fetch
  render(<CollabZone state={{ now: at, stale: true, sessions: [], tasks: { tasks: [task], sprints: [], modules: [], project_meta: [], goals: [], agent_cards: [] } } as never} baseUrl="http://local" fetchImpl={fetchImpl} presence={[]} visible initialView="goals" />)
  expect((await screen.findAllByText('制作可验产物')).length).toBeGreaterThan(0)
  expect(screen.getByText(/Agent 掉线.*上次已知状态/)).toBeInTheDocument()
})
