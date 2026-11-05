/**
 * 任务关系与轮次(2026-10-24,小K collab-desktop-1024,消费 core 契约 §3 D2)。
 *
 * 钉死:
 * - 五种关系分别标字:衍生/前置依赖/流程交接/验收退回/参考;父子不在此列(走 children);
 * - handoff 必须写一句「交回什么、谁接收」;rejected_back 必须写修改要求;前端先挡,服务端 409 原话照显;
 * - depends_on 依赖环服务端拒(409),错误原话给人看;rejected_back 允许回路,不当环拦;
 * - 上游重开(目标卡 round 涨)后,handoff/derived 标 stale:「上游重开,旧交接需复核」;
 * - 轮次 round>1 的卡在详情头写明「第 N 轮」;
 * - 阅读模式父子分组:子卡包在父卡那一格里,不在顶层重复出现;父组不能单独标完成(服务端口径,UI 不画父组的完成键)。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { CollabPresence, TaskView, WorkbenchState } from '../src/protocol.ts'
import { CollabZone } from '../src/client/collab/CollabZone.tsx'
import { RelationsPanel } from '../src/client/collab/RelationsPanel.tsx'
import type { CollabApi } from '../src/client/collab/collabApi.ts'

afterEach(() => {
  cleanup()
  localStorage.clear()
})
beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never
})

const AT = '2026-10-24T09:00:00.000Z'

function apiWith(handlers: Record<string, (body?: Record<string, unknown>) => { status: number, json: unknown }>) {
  const calls: { path: string, method: string, body?: Record<string, unknown> }[] = []
  const impl = (async (input: string, init?: RequestInit) => {
    const url = new URL(input, 'http://x')
    const method = init?.method ?? 'GET'
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body)) as Record<string, unknown>
    calls.push({ path: url.pathname + url.search, method, ...(body === undefined ? {} : { body }) })
    const handler = handlers[url.pathname]
    if (handler === undefined) return new Response(JSON.stringify({ ok: false, error: '没有这个口' }), { status: 404 })
    const got = handler(body)
    return new Response(JSON.stringify(got.json), { status: got.status, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  const api: CollabApi = {
    async post(path, body) {
      const res = await impl(`http://x${path}`, { method: 'POST', body: JSON.stringify(body) })
      const got = await res.json() as Record<string, unknown>
      return res.ok ? { ok: true, body: got } : { ok: false, body: got, error: typeof got.error === 'string' ? got.error : '没办成' }
    },
    async get(path) {
      const res = await impl(`http://x${path}`)
      return res.ok ? await res.json() as never : undefined
    },
  }
  return { calls, api }
}

const tasks: TaskView[] = [
  { id: 't-parent', title: '做一版样片', status: 'doing', source: { kind: 'manual' }, created_at: AT, updated_at: AT, children: ['t-child1', 't-child2'] },
  { id: 't-child1', title: '样片 · 剪辑', status: 'todo', source: { kind: 'manual' }, created_at: AT, updated_at: AT },
  { id: 't-child2', title: '样片 · 配乐', status: 'done', source: { kind: 'manual' }, created_at: AT, updated_at: AT },
  { id: 't-other', title: '别的事', status: 'todo', source: { kind: 'manual' }, created_at: AT, updated_at: AT },
] as TaskView[]

describe('关系面板', () => {
  it('五种关系分别标字;stale 标「需复核」;删除走 remove', async () => {
    const user = userEvent.setup()
    const { calls, api } = apiWith({
      '/collab/relations': () => ({
        status: 200,
        json: {
          relations: [
            { id: 'r1', from_id: 't-parent', to_id: 't-other', kind: 'depends_on', note: '等别的事先完', created_at: AT },
            { id: 'r2', from_id: 't-other', to_id: 't-parent', kind: 'handoff', note: '把素材交回给小K', created_at: AT, stale: true },
            { id: 'r3', from_id: 't-parent', to_id: 't-child1', kind: 'rejected_back', note: '剪辑要重剪前 3 秒', round: 2, created_at: AT },
          ],
        },
      }),
      '/collab/relation/remove': () => ({ status: 200, json: { ok: true } }),
    })
    render(<RelationsPanel taskId="t-parent" tasks={tasks} api={api} onOpenTask={() => {}} />)
    await waitFor(() => expect(document.querySelector('.ben-cl__rels-list')).not.toBeNull())
    const list = document.querySelector('.ben-cl__rels-list') as HTMLElement
    expect(within(list).getByText('前置依赖')).toBeInTheDocument()
    expect(within(list).getByText(/等别的事先完/)).toBeInTheDocument()
    expect(within(list).getByText('流程交接')).toBeInTheDocument()
    expect(within(list).getByText('上游重开,旧交接需复核')).toBeInTheDocument()
    expect(within(list).getByText('验收退回')).toBeInTheDocument()
    expect(within(list).getByText(/第 2 轮退回/)).toBeInTheDocument()
    // 删除
    const row = within(list).getByText('前置依赖').closest('li') as HTMLElement
    await user.click(within(row).getByRole('button', { name: '删' }))
    await waitFor(() => {
      const sent = calls.find(one => one.path === '/collab/relation/remove' && one.method === 'POST')
      expect(sent!.body).toMatchObject({ id: 'r1' })
    })
  })

  it('加 depends_on:走 save;依赖环 409 原话照显,不假装加上了', async () => {
    const user = userEvent.setup()
    const { api } = apiWith({
      '/collab/relations': () => ({ status: 200, json: { relations: [] } }),
      '/collab/relation/save': () => ({ status: 409, json: { ok: false, error: '前置依赖成环了:别的事 → 做一版样片 → 别的事' } }),
    })
    render(<RelationsPanel taskId="t-parent" tasks={tasks} api={api} onOpenTask={() => {}} />)
    await user.selectOptions(await screen.findByLabelText('关系到哪张'), 't-other')
    await user.selectOptions(screen.getByLabelText('哪种关系'), 'depends_on')
    await user.type(screen.getByLabelText('说明一句'), '得等它先完')
    await user.click(screen.getByRole('button', { name: '加上关系' }))
    expect(await screen.findByText('前置依赖成环了:别的事 → 做一版样片 → 别的事')).toBeInTheDocument()
  })

  it('流程交接/验收退回必须写一句;空着加不上(前端先挡)', async () => {
    const user = userEvent.setup()
    const { calls, api } = apiWith({
      '/collab/relations': () => ({ status: 200, json: { relations: [] } }),
      '/collab/relation/save': () => ({ status: 200, json: { ok: true, id: 'r9' } }),
    })
    render(<RelationsPanel taskId="t-parent" tasks={tasks} api={api} onOpenTask={() => {}} />)
    await user.selectOptions(await screen.findByLabelText('关系到哪张'), 't-other')
    await user.selectOptions(screen.getByLabelText('哪种关系'), 'handoff')
    const addBtn = screen.getByRole('button', { name: '加上关系' })
    expect(addBtn).toBeDisabled()
    expect(screen.getByText(/交接要写一句:交回什么、谁接收/)).toBeInTheDocument()
    await user.type(screen.getByLabelText('说明一句'), '把渲染好的样片交回给 Ben 验收')
    await user.click(addBtn)
    await waitFor(() => {
      const sent = calls.find(one => one.path === '/collab/relation/save' && one.method === 'POST')
      expect(sent!.body).toMatchObject({ from_id: 't-parent', to_id: 't-other', kind: 'handoff', note: '把渲染好的样片交回给 Ben 验收' })
    })
  })
})

describe('父子分组与轮次(阅读模式 + 详情头)', () => {
  function zoneState(): WorkbenchState {
    return {
      now: AT,
      sessions: [],
      tasks: {
        tasks, sprints: [], modules: [], project_meta: [],
        goals: [{ id: 'g-1', title: '座机打通', why: '出门也能接', owner: 'me', status: 'open', created_at: AT, updated_at: AT }],
        goal_sprints: [], agent_cards: [], session_proposals: [],
      },
      agent_registry: { entries: [], asking: [], notices: [] },
    } as unknown as WorkbenchState
  }
  function fakeFetch() {
    const impl = (async (input: string, init?: RequestInit) => {
      const url = new URL(input)
      const method = init?.method ?? 'GET'
      const json = url.pathname === '/collab/canvas' && method === 'GET'
        ? { layout: { goals: {}, notes: {} } }
        : url.pathname.endsWith('/trace') ? { events: [] } : { ok: true }
      return new Response(JSON.stringify(json), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    return impl
  }

  it('子卡包在父卡那一格;顶层不再重复出现;组里写完成度', async () => {
    render((
      <div style={{ width: 1400, height: 900, position: 'relative' }}>
        <CollabZone state={zoneState()} baseUrl="http://127.0.0.1:8791" fetchImpl={fakeFetch()} presence={[] as CollabPresence[]} visible initialView="goals" width={1400} />
      </div>
    ))
    const reading = await screen.findByLabelText('目标阅读区')
    // 子卡在父组里
    const group = reading.querySelector('[data-group="t-parent"]')
    expect(group).not.toBeNull()
    expect(within(group as HTMLElement).getByLabelText('便签 样片 · 剪辑')).toBeInTheDocument()
    expect(within(group as HTMLElement).getByLabelText('便签 样片 · 配乐')).toBeInTheDocument()
    // 子卡落在组内的小网格,不在顶层大网格直接子级里(不重复出现)
    const childCard = within(group as HTMLElement).getByLabelText('便签 样片 · 剪辑')
    expect(childCard.closest('.ben-cl__rgroup-grid')).not.toBeNull()
    const topGrid = reading.querySelector('.ben-cl__rgrid') as HTMLElement
    expect(topGrid.querySelector(':scope > [data-note-id="t-child1"]')).toBeNull()
    // 父卡自己没有「做完」章可点(父组不能单独标完成 —— 组完成从子卡汇总)
    const parentCard = within(group as HTMLElement).getByLabelText('便签 做一版样片')
    expect(within(parentCard as HTMLElement).queryByText('做完', { selector: 'button' })).toBeNull()
    expect(within(group as HTMLElement).getByText(/完成度 1\/2/)).toBeInTheDocument()
  })

  it('第 N 轮(N>1)写在详情头', async () => {
    const roundTasks = [{ ...tasks[3], round: 3, goal_id: 'g-1' } as TaskView]
    const state = {
      now: AT, sessions: [],
      tasks: {
        tasks: roundTasks, sprints: [], modules: [], project_meta: [],
        goals: [{ id: 'g-1', title: '座机打通', owner: 'me', status: 'open', created_at: AT, updated_at: AT }],
        goal_sprints: [], agent_cards: [], session_proposals: [],
      },
      agent_registry: { entries: [], asking: [], notices: [] },
    } as unknown as WorkbenchState
    const user = userEvent.setup()
    render((
      <div style={{ width: 1400, height: 900, position: 'relative' }}>
        <CollabZone state={state} baseUrl="http://127.0.0.1:8791" fetchImpl={fakeFetch()} presence={[]} visible initialView="goals" width={1400} />
      </div>
    ))
    await user.click(within(await screen.findByLabelText('便签 别的事')).getByRole('button', { name: '别的事' }))
    expect(await screen.findByText('第 3 轮')).toBeInTheDocument()
  })
})
