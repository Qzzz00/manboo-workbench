import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { ItemContinueView, TaskView, WorkbenchState } from '../src/protocol.ts'
import { ITEM_CONTINUE_BUTLER_KEY } from '../src/protocol.ts'
import { NoteDialog } from '../src/client/collab/NoteDialog.tsx'
import { collabApi } from '../src/client/collab/collabApi.ts'

afterEach(() => {
  cleanup()
  // 草稿按事项存 localStorage:格与格之间互串会假红,每条用例清干净。
  try { localStorage.clear() } catch { /* jsdom 总有 */ }
})
beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never
})

const AT = '2026-10-26T06:00:00.000Z'
const taskOf = (patch: Partial<TaskView> = {}): TaskView => ({
  id: 't-1', title: '图谱显示修复', status: 'doing', source: { kind: 'manual' }, created_at: AT, updated_at: AT, ...patch,
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

const viewOne = (over: Partial<ItemContinueView> = {}): ItemContinueView => ({
  id: 't-1',
  sources: [
    { key: ITEM_CONTINUE_BUTLER_KEY, agent: 'dsh', session_id: 's-1', title: '事务官', action: { kind: 'butler' } },
  ],
  ...over,
})

function renderDialog(task: TaskView, fetchImpl: typeof fetch) {
  const api = collabApi('http://127.0.0.1:8791', fetchImpl)
  return render(
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
}

describe('继续这件事 · 四意图(2026-10-26,卡「事务官机制A」)', () => {
  it('缺省「补充一句」:发送不带 intent 字段(与卡 A 之前逐字一致)', async () => {
    const { calls, impl } = fakeFetch({ view: viewOne() })
    renderDialog(taskOf(), impl)
    fireEvent.change(await screen.findByLabelText('接着说'), { target: { value: '顺便补一句' } })
    fireEvent.click(screen.getByRole('button', { name: '发出去' }))
    await waitFor(() => expect(calls.some(one => one.path === '/butler/item/continue')).toBe(true))
    const sent = calls.find(one => one.path === '/butler/item/continue')
    expect(sent?.body).toMatchObject({ id: 't-1', text: '顺便补一句', target: ITEM_CONTINUE_BUTLER_KEY })
    expect(sent?.body).not.toHaveProperty('intent')
    expect(typeof sent?.body?.client_key).toBe('string')
  })

  it('选定「改方向」:body 带 intent:redirect;意图是动作包的一部分 —— 换意图换新请求号', async () => {
    const { calls, impl } = fakeFetch({ view: viewOne(), result: { ok: false, fact: 'failed', note: '没办成,稍后再试' } })
    renderDialog(taskOf(), impl)
    const box = await screen.findByLabelText('接着说')
    // 第一次:补充,失败留字(号 a)。
    fireEvent.change(box, { target: { value: '第一句' } })
    fireEvent.click(screen.getByRole('button', { name: '发出去' }))
    await waitFor(() => expect(calls.filter(one => one.path === '/butler/item/continue')).toHaveLength(1))
    const keyA = calls.find(one => one.path === '/butler/item/continue')?.body?.client_key
    // 换意图再发:同一个字也 = 另一个动作,新号。
    fireEvent.change(screen.getByLabelText('这句怎么递'), { target: { value: 'redirect' } })
    fireEvent.click(screen.getByRole('button', { name: '发出去' }))
    await waitFor(() => expect(calls.filter(one => one.path === '/butler/item/continue')).toHaveLength(2))
    const posts = calls.filter(one => one.path === '/butler/item/continue')
    expect(posts[1]?.body).toMatchObject({ id: 't-1', text: '第一句', intent: 'redirect' })
    expect(posts[1]?.body?.client_key).not.toBe(keyA)
    // 回执照服务端原话摆。
    const section = screen.getByLabelText('继续这件事')
    await waitFor(() => expect(within(section).getByRole('status')).toHaveTextContent('没办成,稍后再试'))
  })

  it('「撤回」键:不带文字也发得动(intent:recall),文字随键走', async () => {
    const { calls, impl } = fakeFetch({ view: viewOne() })
    renderDialog(taskOf(), impl)
    await screen.findByLabelText('接着说')
    const recallButton = screen.getByRole('button', { name: '撤回' })
    // 空框也能撤回。
    fireEvent.click(recallButton)
    await waitFor(() => expect(calls.some(one => one.path === '/butler/item/continue')).toBe(true))
    const first = calls.find(one => one.path === '/butler/item/continue')
    expect(first?.body).toMatchObject({ id: 't-1', text: '', intent: 'recall' })
    // 带文字的撤回:文字一并递进。
    fireEvent.change(screen.getByLabelText('接着说'), { target: { value: '先不做了' } })
    fireEvent.click(recallButton)
    await waitFor(() => expect(calls.filter(one => one.path === '/butler/item/continue')).toHaveLength(2))
    const posts = calls.filter(one => one.path === '/butler/item/continue')
    expect(posts[1]?.body).toMatchObject({ text: '先不做了', intent: 'recall' })
  })

  it('「只留记录」保持纯留言档:不带意图、不受意图选择影响', async () => {
    const { calls, impl } = fakeFetch({ view: viewOne() })
    renderDialog(taskOf(), impl)
    fireEvent.change(await screen.findByLabelText('接着说'), { target: { value: '先记一句' } })
    fireEvent.change(screen.getByLabelText('这句怎么递'), { target: { value: 'redirect' } })
    fireEvent.click(screen.getByRole('button', { name: '只留记录' }))
    await waitFor(() => expect(calls.some(one => one.path === '/butler/item/continue')).toBe(true))
    const sent = calls.find(one => one.path === '/butler/item/continue')
    expect(sent?.body).toMatchObject({ id: 't-1', text: '先记一句', record: true })
    expect(sent?.body).not.toHaveProperty('intent')
  })

  it('意图选择与草稿同存:关掉重开,选过的意图还在(换意图不悄悄变回补充)', async () => {
    const { calls, impl } = fakeFetch({ view: viewOne() })
    const first = renderDialog(taskOf(), impl)
    fireEvent.change(await screen.findByLabelText('接着说'), { target: { value: '改用手动验收' } })
    fireEvent.change(screen.getByLabelText('这句怎么递'), { target: { value: 'redirect' } })
    first.unmount()
    renderDialog(taskOf(), impl)
    const box = await screen.findByLabelText('接着说')
    expect((box as HTMLTextAreaElement).value).toBe('改用手动验收')
    expect((screen.getByLabelText('这句怎么递') as HTMLSelectElement).value).toBe('redirect')
    void calls
  })

  it('回执原样摆:redirected / recalled 都照服务端 note 说,不自己编', async () => {
    const { impl } = fakeFetch({ view: viewOne(), result: { ok: true, fact: 'redirected', intent: 'redirect', note: '改方向送进去了 —— 正在跑的那一轮已被打断。' } })
    renderDialog(taskOf(), impl)
    fireEvent.change(await screen.findByLabelText('接着说'), { target: { value: '换条路' } })
    fireEvent.change(screen.getByLabelText('这句怎么递'), { target: { value: 'redirect' } })
    fireEvent.click(screen.getByRole('button', { name: '发出去' }))
    const section = screen.getByLabelText('继续这件事')
    await waitFor(() => expect(within(section).getByRole('status')).toHaveTextContent('改方向送进去了 —— 正在跑的那一轮已被打断。'))
    // 送成了清框。
    expect((screen.getByLabelText('接着说') as HTMLTextAreaElement).value).toBe('')
  })

  it('锚点:这一格仍在「继续这件事」里,不另起区块', async () => {
    const { impl } = fakeFetch({ view: viewOne() })
    renderDialog(taskOf(), impl)
    const section = await screen.findByLabelText('继续这件事')
    expect(within(section).getByLabelText('这句怎么递')).toBeInTheDocument()
    expect(within(section).getByRole('button', { name: '撤回' })).toBeInTheDocument()
  })
})
