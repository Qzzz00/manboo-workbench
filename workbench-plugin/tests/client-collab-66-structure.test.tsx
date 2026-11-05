import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, within, waitFor, act } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import type { NodeProps } from '@xyflow/react'
import type { CollabGoal, TaskView, WorkbenchState } from '../src/protocol.ts'
import type { CollabApi } from '../src/client/collab/collabApi.ts'
import { ReadingBoard } from '../src/client/collab/ReadingBoard.tsx'
import { NoteDialog } from '../src/client/collab/NoteDialog.tsx'
import { NoteNode } from '../src/client/collab/nodes.tsx'
import { CollabZone } from '../src/client/collab/CollabZone.tsx'
import { LanIdentityPanel } from '../src/client/collab/LanIdentityPanel.tsx'
import { LanPeerConnect } from '../src/client/collab/LanPeerConnect.tsx'
import { collabApi } from '../src/client/collab/collabApi.ts'
import { DEFAULT_BASE_URL } from '../src/client/useWorkbenchState.ts'
import { SERVICE_CONFIG_GLOBAL } from '../src/serviceOrigin.ts'
import { ChannelView } from '../src/client/collab/ChannelView.tsx'
const at = '2026-10-24T04:00:00Z'
const note = (id: string, patch: Partial<TaskView> = {}): TaskView => ({ id, title: id, goal_id: 'g1', status: 'todo', source: { kind: 'manual' }, created_at: at, updated_at: at, ...patch })
const goals: CollabGoal[] = ['g1', 'g2'].map(id => ({ id, title: id, owner: 'me', status: 'open', created_at: at, updated_at: at }))
const reading = (tasks: TaskView[]) => <ReadingBoard goals={goals} tasks={tasks} shown={() => true} cards={[]} assigneeText={() => '我'} typeOf={() => undefined} goalOwner={() => '我'} onStamp={() => {}} onArrow={() => {}} onOpen={() => {}} />
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals() })

it('R4 跨目标子事保留在实际目标,三层递归且不重复计卡', () => {
  render(reading([note('P', { children: ['C', 'X'] }), note('C', { children: ['G'] }), note('G'), note('X', { goal_id: 'g2' })]))
  for (const id of ['P','C','G','X']) expect(screen.getAllByLabelText(`便签 ${id}`)).toHaveLength(1)
  expect(within(screen.getByLabelText('目标 g2')).getByLabelText('便签 X')).toBeInTheDocument()
})

it('R5 子组可收起展开,收起后仍有汇总,父组章始终只读', async () => {
  render(reading([note('P', { children: ['C'] }), note('C', { children: ['G'] }), note('G')]))
  const user = userEvent.setup()
  const group = document.querySelector('[data-group="P"]') as HTMLElement
  expect(within(screen.getByLabelText('便签 P')).getByRole('button', { name: /章:/ })).toBeDisabled()
  await user.click(within(group).getByRole('button', { name: '收起子事 · P' }))
  expect(screen.getByLabelText('便签 G')).not.toBeVisible()
  expect(group.querySelector(':scope > small')).toBeVisible()
  expect(group.querySelector(':scope > small')).toHaveTextContent('子事 1 件')
  await user.click(within(group).getByRole('button', { name: '展开子事 · P' }))
  expect(screen.getByLabelText('便签 G')).toBeVisible()
})

it('R5 画布节点不依赖阅读板传 grouped 才禁止父组盖章', () => {
  render(<NoteNode {...{ data: { task: note('P', { children: ['C'] }), type: undefined, dim: false, assigneeText: '我', gaps: [], working: false, onOpen: () => {}, onStamp: () => {}, onArrow: () => {} } } as unknown as NodeProps} />)
  expect(screen.getByRole('button', { name: /章:/ })).toBeDisabled()
  expect(screen.queryByRole('button', { name: /往右/ })).not.toBeInTheDocument()
})

it('R5 父组详情的状态/验收通过都不可独立完成,不发送副作用', async () => {
  const posts = vi.fn(async () => ({ ok: true, body: { ok: true } }))
  const tasks = [note('P', { children: ['C'], status: 'confirm' }), note('C')]
  const state = { tasks: { tasks, project_meta: [], session_usage: {}, modules: [], sprints: [], goals, agent_cards: [], goal_sprints: [] }, sessions: [] } as unknown as WorkbenchState
  const api: CollabApi = { get: async () => ({ items: [], runs: [], events: [] }) as never, post: posts }
  render(<NoteDialog task={tasks[0]!} state={state} goals={goals} cards={[]} entries={[]} api={api} baseUrl="http://test" fetchImpl={fetch} assigneeText={() => '我'} onClose={() => {}} onFlyGoal={() => {}} onReceipt={() => {}} />)
  const dialog = screen.getByRole('dialog')
  expect(within(dialog).getByRole('button', { name: /章:/ })).toBeDisabled()
  expect(within(dialog).getByRole('button', { name: '通过' })).toBeDisabled()
  await userEvent.setup().click(within(dialog).getByRole('button', { name: '通过' }))
  expect(posts).not.toHaveBeenCalled()
})

it('R6 固定区消费真实 GoalBoardSummary 的条件与剩余,快照变化重读', async () => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never
  let delivered = 1
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(String(input)); const data = url.pathname === '/collab/goal/board' ? { summary: { goal_id: 'g1', scope: '真实目标', conditions: { total: 3, by_state: { delivered, rework: 3-delivered }, items: [{ id: 'c1', text: '能独立接续', state: 'delivered' }, { id: 'c2', text: '能检查依据', state: 'rework' }, { id: 'c3', text: '能交回复核', state: 'rework' }] }, tasks: { total: 1, canceled: 0 } } } : { layout: { goals: {}, notes: {} }, runs: [], items: [] }
    return new Response(JSON.stringify(data))
  }) as typeof fetch
  const state = (revision: string) => ({ now: at, sessions: [], tasks: { tasks: [note('T', { updated_at: revision })], goals: [goals[0]!], agent_cards: [] } }) as unknown as WorkbenchState
  const view = render(<CollabZone state={state(at)} baseUrl="http://test" fetchImpl={fetchImpl} visible initialView="goals" presence={[]} />)
  const summary = await screen.findByLabelText('当前目标能力摘要')
  await within(summary).findByText(/剩余条件 2/)
  expect(summary).toHaveTextContent('能检查依据')
  expect(summary.closest('.ben-cl__reading')).toBeNull()
  expect(summary.compareDocumentPosition(screen.getByLabelText('目标阅读区')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  delivered = 2
  view.rerender(<CollabZone state={state('2026-10-24T04:01:00Z')} baseUrl="http://test" fetchImpl={fetchImpl} visible initialView="goals" presence={[]} />)
  await within(summary).findByText(/剩余条件 1/)
})

it('R7 refresh 已知失联后立即替换旧在线徽标', async () => {
  const api: CollabApi = { get: async path => path === '/collab/lan/identity' ? { identity: { member_id: 'self', name: '我', version: 1 } } as never : { members: [{ member_id: 'peer', name: '对端', reachable: !path.includes('refresh=1'), last_seen: at }] } as never, post: vi.fn() }
  render(<LanIdentityPanel api={api} />)
  await screen.findByText(/在线/)
  await userEvent.setup().click(screen.getByRole('button', { name: '查重并保存' }))
  await screen.findByText(/名称可用性未知/)
  expect(screen.getByText('现在不在')).toBeInTheDocument()
  expect(screen.queryByText(/在线/)).not.toBeInTheDocument()
  expect(api.post).not.toHaveBeenCalled()
})

it('R8 LAN 长报告可展开收回,引用和投递状态不丢', async () => {
  const long = '做完: 真实长报告。' + '说明与检查依据。'.repeat(90) + '报告尾部标记'
  const api: CollabApi = { get: async path => path.includes('/lan/channel') ? { transport: 'lan', messages: [{ id: 'original', project_id: 'p', kind: 'message', author: { member_id: 'self', name: '我' }, at, text: '被引用的原消息' }, { id: 'long', project_id: 'p', kind: 'report', author: { member_id: 'peer', name: '对端' }, at, text: long, reply_to: 'original', deliveries: [{ to: 'self', status: 'delivered' }] }] } as never : path.includes('/identity') ? { identity: { member_id: 'self', name: '我', version: 1 } } as never : { members: [], state: 'unwired' } as never, post: vi.fn() }
  render(<ChannelView api={api} tick={1} nowMs={Date.parse(at)} projects={[{ id: 'p', title: '项目' }]} onOpenStudio={() => {}} onReceipt={() => {}} />)
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: '展开报告' }))
  expect(screen.getByText(long)).toBeVisible()
  expect(screen.getByRole('link', { name: '引用 · 被引用的原消息' })).toHaveAttribute('href', '#lan-message-original')
  expect(screen.getByText(/已送达/)).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '收回报告' }))
  expect(screen.queryByText(long)).not.toBeInTheDocument()
  expect(screen.getByRole('link', { name: '引用 · 被引用的原消息' })).toHaveAttribute('href', '#lan-message-original')
  expect(screen.getByText(/已送达/)).toBeInTheDocument()
})

it('R8 中转日报/周报也按正式 kind 展开,不虚构 LAN 话题', async () => {
  const long = '正式日报内容。'.repeat(80)
  const channel = { id: 'ch', kind: 'workspace', name: '已有频道' }
  const api: CollabApi = { get: async path => {
    if (path === '/collab/relay/studio') return { state: 'joined', channels: [channel], members: [], workspace: { id: 'w', name: '工作室' }, me: { account_id: 'me', nick: '我', role: 'admin' } } as never
    if (path.startsWith('/collab/relay/channel')) return { messages: [{ id: 'daily', kind: 'daily', channel: 'ch', author: { person: 'a', nick: '对端', device: 'd' }, at, text: long, refs: [], attachments: [] }] } as never
    if (path.includes('/identity')) return { identity: { member_id: 'self', name: '我', version: 1 } } as never
    return { members: [] } as never
  }, post: vi.fn() }
  render(<ChannelView api={api} tick={1} nowMs={Date.parse(at)} onOpenStudio={() => {}} onReceipt={() => {}} />)
  const region = await screen.findByRole('region', { name: '频道' })
  await userEvent.setup().click(await within(region).findByRole('button', { name: '展开报告' }))
  expect(within(region).getByText(long)).toBeVisible()
})


it('R6 宽度观察延后到下一帧更新布局,不在 ResizeObserver 内同步改变所观察布局', async () => {
  const original = globalThis.ResizeObserver
  const observers: Array<{ callback: ResizeObserverCallback, target?: Element }> = []
  globalThis.ResizeObserver = class {
    constructor(callback: ResizeObserverCallback) { observers.push({ callback }) }
    observe(target: Element) { observers.at(-1)!.target = target }
    unobserve() {} disconnect() {}
  } as never
  const frame = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(() => 1)
  try {
    const state = { now: at, sessions: [], tasks: { tasks: [note('T')], goals: [goals[0]!], agent_cards: [] } } as unknown as WorkbenchState
    const fetchImpl = (async () => new Response(JSON.stringify({ layout: { goals: {}, notes: {} }, runs: [], items: [] }))) as typeof fetch
    render(<CollabZone state={state} baseUrl="http://test" fetchImpl={fetchImpl} visible initialView="goals" presence={[]} />)
    const observer = observers.find(one => one.target?.getAttribute('aria-label') === '协作区')!
    frame.mockClear()
    await act(async () => observer.callback([{ contentRect: { width: 800 } }] as ResizeObserverEntry[], {} as ResizeObserver))
    expect(frame).toHaveBeenCalledTimes(1)
  } finally { cleanup(); globalThis.ResizeObserver = original; frame.mockRestore() }
})

it.each([
  { origin: 'http://127.0.0.1:9993', injected: 'http://127.0.0.1:8890', expected: 9993 },
  { origin: undefined, injected: 'http://127.0.0.1:8890', expected: 8890 },
  { origin: undefined, injected: undefined, expected: Number(new URL(DEFAULT_BASE_URL).port) },
  { origin: 'http://workbench.test', injected: undefined, expected: 80 },
  { origin: 'https://workbench.test', injected: undefined, expected: 443 },
])('LAN 配对默认端口消费现有实际来源 $origin / 注入 $injected', ({ origin, injected, expected }) => {
  vi.stubGlobal(SERVICE_CONFIG_GLOBAL, injected === undefined ? undefined : { baseUrl: injected })
  const api = origin === undefined ? { get: async () => undefined, post: vi.fn() } : collabApi(origin, vi.fn())
  render(<LanPeerConnect api={api} memberId="self" onConnected={() => {}} />)
  expect(screen.getByLabelText('对端端口')).toHaveValue(expected)
})

it('LAN 配对默认来源不覆盖手动端口，正常提交仍使用用户填写参数', async () => {
  vi.stubGlobal(SERVICE_CONFIG_GLOBAL, { baseUrl: 'http://127.0.0.1:8890' })
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true })))
  const connected = vi.fn()
  render(<LanPeerConnect api={collabApi('http://127.0.0.1:9993', fetchImpl)} memberId="self" onConnected={connected} />)
  const user = userEvent.setup()
  await user.click(screen.getByText('连接局域网协作成员'))
  expect(screen.getByLabelText('对端端口')).toHaveValue(9993)
  await user.type(screen.getByLabelText('对端局域网地址'), '127.0.0.1')
  await user.clear(screen.getByLabelText('对端端口'))
  await user.type(screen.getByLabelText('对端端口'), '9994')
  await user.type(screen.getByLabelText('对端稳定身份'), 'peer-stable')
  await user.type(screen.getByLabelText('对端一次性配对码'), '123456')
  await user.click(screen.getByRole('button', { name: '配对协作成员' }))
  await screen.findByText('协作成员已配对，可在共同项目中收发记录。')
  expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:9993/collab/lan/connect', expect.objectContaining({ method: 'POST', body: JSON.stringify({ host: '127.0.0.1', port: 9994, member_id: 'peer-stable', code: '123456' }) }))
  expect(screen.getByLabelText('对端一次性配对码')).toHaveValue('')
  expect(connected).toHaveBeenCalledTimes(1)
})
