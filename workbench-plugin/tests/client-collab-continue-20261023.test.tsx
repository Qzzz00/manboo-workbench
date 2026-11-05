import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { ItemContinueSource, ItemContinueView, TaskView, WorkbenchState } from '../src/protocol.ts'
import { ITEM_CONTINUE_BUTLER_KEY } from '../src/protocol.ts'
import { NoteDialog } from '../src/client/collab/NoteDialog.tsx'
import { collabApi } from '../src/client/collab/collabApi.ts'

afterEach(cleanup)
beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never
})

const AT = '2026-10-23T09:00:00.000Z'
const taskOf = (patch: Partial<TaskView> = {}): TaskView => ({
  id: 't-1', title: '梳理报告', status: 'doing', source: { kind: 'manual' }, created_at: AT, updated_at: AT, ...patch,
})

function stateWith(task: TaskView): WorkbenchState {
  return {
    now: AT,
    sessions: [],
    tasks: { tasks: [task], sprints: [], modules: [], project_meta: [], goals: [], goal_sprints: [], agent_cards: [], session_proposals: [] },
    agent_registry: { entries: [], asking: [], notices: [] },
  } as unknown as WorkbenchState
}

interface Call { path: string, method: string, body: Record<string, unknown> | undefined }

function fakeFetch(handlers: { view?: ItemContinueView, result?: Record<string, unknown> } = {}) {
  const calls: Call[] = []
  const impl = (async (input: string, init?: RequestInit) => {
    const url = new URL(input)
    const method = init?.method ?? 'GET'
    const body = init?.body === undefined || typeof init?.body !== 'string' ? undefined : JSON.parse(init.body) as Record<string, unknown>
    calls.push({ path: url.pathname, method, body })
    if (url.pathname.endsWith('/continue') && method === 'GET') {
      return new Response(JSON.stringify(handlers.view ?? { id: 't-1', sources: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.pathname === '/butler/item/continue') {
      return new Response(JSON.stringify(handlers.result ?? { ok: true, fact: 'sent', note: '送到了。' }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return { calls, impl }
}

const viewTwo = (over: Partial<ItemContinueView> = {}): ItemContinueView => ({
  id: 't-1',
  sources: [
    { key: ITEM_CONTINUE_BUTLER_KEY, agent: 'dsh', session_id: 's-1', title: '事务官', action: { kind: 'butler' } },
    { key: 'claude:c-1', agent: 'claude', session_id: 'c-1', title: '梳理那一条', action: { kind: 'relay' } },
    { key: 'codex:x-1', agent: 'codex', session_id: 'x-1', title: 'codex 的会话', action: { kind: 'none', why: '这家这会儿送不进' } },
  ],
  ...over,
})

function renderDialog(task: TaskView, fetchImpl: typeof fetch) {
  const api = collabApi('http://127.0.0.1:8791', fetchImpl)
  const utils = render(
    <NoteDialog
      task={task}
      state={stateWith(task)}
      goals={[]}
      cards={[]}
      entries={[]}
      api={api}
      baseUrl="http://127.0.0.1:8791"
      fetchImpl={fetchImpl}
      assigneeText={() => ''}
      onClose={() => {}}
      onFlyGoal={() => {}}
      onReceipt={() => {}}
    />,
  )
  return utils
}

describe('事项详情「继续这件事」(2026-10-23,卡 A)', () => {
  it('打开时读来源清单:能续的列出来,不能续的带那句为什么', async () => {
    const { calls, impl } = fakeFetch({ view: viewTwo() })
    renderDialog(taskOf(), impl)
    await waitFor(() => expect(calls.some(one => one.path === '/butler/item/t-1/continue' && one.method === 'GET')).toBe(true))
    const section = screen.getByLabelText('继续这件事')
    expect(within(section).getByText('事务官')).toBeInTheDocument()
    expect(within(section).getByText('梳理那一条')).toBeInTheDocument()
    expect(within(section).getByText(/这家这会儿送不进/)).toBeInTheDocument()
  })

  it('★能续的多条 → 不替你猜:未选时「发出去」按不动、零外发;选定哪条就只发哪条', async () => {
    const { calls, impl } = fakeFetch({ view: viewTwo() })
    renderDialog(taskOf(), impl)
    const select = await screen.findByLabelText('发给哪一条会话')
    const sendButton = screen.getByRole('button', { name: '发出去' })
    // 没选:键是死的,打多少字也不外发(2026-10-23 复审 Important 1)。
    expect((select as HTMLSelectElement).value).toBe('')
    expect(sendButton).toBeDisabled()
    fireEvent.change(screen.getByLabelText('接着说'), { target: { value: '还没选就打字' } })
    fireEvent.click(sendButton)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(calls.filter(one => one.path === '/butler/item/continue')).toHaveLength(0)
    // 选定 claude 那一条 → 只发那一条。
    fireEvent.change(select, { target: { value: 'claude:c-1' } })
    expect(sendButton).toBeEnabled()
    fireEvent.click(sendButton)
    await waitFor(() => expect(calls.some(one => one.path === '/butler/item/continue')).toBe(true))
    const sent = calls.find(one => one.path === '/butler/item/continue')
    expect(sent?.body).toMatchObject({ id: 't-1', text: '还没选就打字', target: 'claude:c-1' })
    expect(sent?.body).not.toHaveProperty('record')
  })

  it('★每次发送带请求号;同一句同目标重试(丢回执)复用同号,换目标换新号(2026-10-23 复审 Important 3)', async () => {
    let fails = 1
    const { calls, impl } = fakeFetch({
      view: viewTwo(),
      result: { ok: false, fact: 'unsupported', note: '这家这会儿送不进' },
    })
    // 第一次回 unsupported(字留着),第二次起成功。
    const impl2 = (async (input: string, init?: RequestInit) => {
      const isFirstPost = fails > 0 && String(input).includes('/butler/item/continue') && (init?.method ?? 'GET') === 'POST'
      if (isFirstPost) fails -= 1
      // 第一次走内层记录器会拿到 happy 回包,这里拦下换成 unsupported(同样记录进 calls)。
      const res = await impl(input, init)
      if (!isFirstPost) return res
      return new Response(JSON.stringify({ ok: false, fact: 'unsupported', note: '这家这会儿送不进' }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    renderDialog(taskOf(), impl2)
    const select = await screen.findByLabelText('发给哪一条会话')
    fireEvent.change(select, { target: { value: 'claude:c-1' } })
    fireEvent.change(screen.getByLabelText('接着说'), { target: { value: '同一句' } })
    fireEvent.click(screen.getByRole('button', { name: '发出去' }))
    await waitFor(() => expect(calls.filter(one => one.path === '/butler/item/continue')).toHaveLength(1))
    const first = calls.find(one => one.path === '/butler/item/continue')
    expect(String(first?.body?.client_key)).toMatch(/^nc-/)
    // 同一句同目标再发(上一次没成,字还在):同一个号。
    fireEvent.click(screen.getByRole('button', { name: '发出去' }))
    await waitFor(() => expect(calls.filter(one => one.path === '/butler/item/continue')).toHaveLength(2))
    const second = calls.filter(one => one.path === '/butler/item/continue')[1]
    expect(second?.body?.client_key).toBe(first?.body?.client_key)
    // 换目标再发:动作包变了,新号。
    fireEvent.change(select, { target: { value: 'butler' } })
    fireEvent.click(screen.getByRole('button', { name: '发出去' }))
    await waitFor(() => expect(calls.filter(one => one.path === '/butler/item/continue')).toHaveLength(3))
    const third = calls.filter(one => one.path === '/butler/item/continue')[2]
    expect(String(third?.body?.client_key)).toMatch(/^nc-/)
    expect(third?.body?.client_key).not.toBe(first?.body?.client_key)
  })

  it('★能续的只有一条 → 不摆选择,直接发;服务端那句原样摆出来', async () => {
    const { calls, impl } = fakeFetch({
      view: { id: 't-1', sources: [viewTwo().sources[0] as ItemContinueSource] },
      result: { ok: true, fact: 'sent', note: '捎到了 —— 你那句话已经送进事务官那条会话里了。' },
    })
    renderDialog(taskOf(), impl)
    fireEvent.change(await screen.findByLabelText('接着说'), { target: { value: '接着做' } })
    expect(screen.queryByLabelText('发给哪一条会话')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '发出去' }))
    await waitFor(() => expect(screen.getByText('捎到了 —— 你那句话已经送进事务官那条会话里了。')).toBeInTheDocument())
    const sent = calls.find(one => one.path === '/butler/item/continue')
    expect(sent?.body).toMatchObject({ id: 't-1', text: '接着做', target: ITEM_CONTINUE_BUTLER_KEY })
  })

  it('★没送成 → 那句原因摆出来,打的字留着(不替他丢话)', async () => {
    const { impl } = fakeFetch({ view: viewTwo(), result: { ok: false, fact: 'unsupported', note: '这家这会儿送不进' } })
    renderDialog(taskOf(), impl)
    fireEvent.change(await screen.findByLabelText('接着说'), { target: { value: '别丢这句话' } })
    fireEvent.change(screen.getByLabelText('发给哪一条会话'), { target: { value: 'claude:c-1' } })
    fireEvent.click(screen.getByRole('button', { name: '发出去' }))
    expect(await screen.findByText('这家这会儿送不进')).toBeInTheDocument()
    expect(screen.getByLabelText('接着说')).toHaveValue('别丢这句话')
  })

  it('★草稿按事项留着:关详情再开字还在;换一张卡不串稿(2026-10-23 复审 Important 2)', async () => {
    localStorage.clear()
    const first = fakeFetch({ view: viewTwo() })
    const one = renderDialog(taskOf(), first.impl)
    fireEvent.change(await screen.findByLabelText('接着说'), { target: { value: '给 t-1 打的草稿' } })
    fireEvent.change(screen.getByLabelText('发给哪一条会话'), { target: { value: 'claude:c-1' } })
    one.unmount()
    // 关详情再开(同一事项):字与选择都在。
    const two = renderDialog(taskOf(), first.impl)
    expect(await two.findByLabelText('接着说')).toHaveValue('给 t-1 打的草稿')
    expect((two.getByLabelText('发给哪一条会话') as HTMLSelectElement).value).toBe('claude:c-1')
    two.unmount()
    // 换一张卡:不串稿。
    const other = fakeFetch({ view: { id: 't-2', sources: [viewTwo().sources[0] as ItemContinueSource] } })
    const three = renderDialog(taskOf({ id: 't-2', title: '另一件' }), other.impl)
    expect(await three.findByLabelText('接着说')).toHaveValue('')
  })

  it('★「只留记录」→ record 档,一个字都不往外发', async () => {
    const { calls, impl } = fakeFetch({ view: viewTwo() })
    renderDialog(taskOf(), impl)
    fireEvent.change(await screen.findByLabelText('接着说'), { target: { value: '先记一句' } })
    fireEvent.click(screen.getByRole('button', { name: '只留记录' }))
    await waitFor(() => expect(calls.some(one => one.path === '/butler/item/continue')).toBe(true))
    expect(calls.find(one => one.path === '/butler/item/continue')?.body).toMatchObject({ id: 't-1', text: '先记一句', record: true })
  })

  it('没有连着任何会话 → 一行说清,普通记录仍可以', async () => {
    const { impl } = fakeFetch({ view: { id: 't-1', sources: [], note: '这件事没有连着能接续的会话 —— 可以只留一句记在卡上,会话从「各家对话」里开。' } })
    renderDialog(taskOf(), impl)
    expect(await screen.findByText(/没有连着能接续的会话/)).toBeInTheDocument()
  })
})

describe('事项详情改卡名(2026-10-23,卡 A:用户的手盖过来源)', () => {
  it('★改名走 /task/update;改完服务端从此不再拿来源名覆盖这张', async () => {
    const { calls, impl } = fakeFetch()
    renderDialog(taskOf(), impl)
    fireEvent.click(await screen.findByRole('button', { name: '改卡名' }))
    const input = screen.getByLabelText('卡名')
    fireEvent.change(input, { target: { value: '我自己的名字' } })
    fireEvent.blur(input)
    await waitFor(() => expect(calls.some(one => one.path === '/task/update')).toBe(true))
    expect(calls.find(one => one.path === '/task/update')?.body).toMatchObject({ id: 't-1', title: '我自己的名字' })
  })

  it('空名不提交', async () => {
    const { calls, impl } = fakeFetch()
    renderDialog(taskOf(), impl)
    fireEvent.click(await screen.findByRole('button', { name: '改卡名' }))
    const input = screen.getByLabelText('卡名')
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.blur(input)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(calls.filter(one => one.path === '/task/update')).toHaveLength(0)
  })
})
