/**
 * 运行片段与容量(2026-10-24,小K collab-desktop-1024,消费 core 契约 §4 E)。
 *
 * 钉死:
 * - 详情「经手」里区分计划时间(既有 start/end)与实际运行片段(jobLog 现算):
 *   实际运行 / 暂停等待(带原因)/ 已收场 / 失败 / 状态未知(失联或记录过旧,不装作在跑);
 * - 没有运行记录 = 「还没有运行记录」,不编一段;
 * - 名片栏容量四件事分开:手上几件 / 在跑几件 / 在线 / 上限;上限取不到写「未知」,不从卡数推导;
 * - 容量接口不在(老服务)= 那一行不画,不编。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { AgentEntryView, CollabPresence, TaskView, WorkbenchState } from '../src/protocol.ts'
import { CollabZone } from '../src/client/collab/CollabZone.tsx'
import { RunsPanel } from '../src/client/collab/RunsPanel.tsx'
import type { CollabApi } from '../src/client/collab/collabApi.ts'

afterEach(cleanup)
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

describe('运行片段(详情经手)', () => {
  it('计划/实际/暂停/未知分开写;暂停带原因;空 = 没有运行记录', async () => {
    const { api } = apiWith({
      '/collab/runs': () => ({
        status: 200,
        json: {
          runs: [
            { task_id: 't-1', source: 'codex', status: 'done', started_at: '2026-10-24T08:00:00', finished_at: '2026-10-24T08:40:00', outcome: 'replied' },
            { task_id: 't-1', source: 'kimi', status: 'paused', started_at: '2026-10-24T09:00:00', pause_reason: '等 Ben 解锁电脑' },
            { task_id: 't-1', source: 'claude', status: 'unknown', started_at: '2026-10-23T09:00:00' },
          ],
        },
      }),
    })
    render(<RunsPanel taskId="t-1" api={api} />)
    expect(await screen.findByText(/实际运行 · codex · 本机核到开工：未知 · 收到结果：未知 · 派出记录：2026-10-24 08:00:00 · 管线收场：2026-10-24 08:40:00/)).toBeInTheDocument()
    expect(screen.getByText(/暂停等待 · kimi .*等 Ben 解锁电脑/)).toBeInTheDocument()
    expect(screen.getByText(/状态未知 · claude .*失联或记录过旧,不当作在跑/)).toBeInTheDocument()
  })

  it('没有运行记录:如实说没有,不编', async () => {
    const { api } = apiWith({ '/collab/runs': () => ({ status: 200, json: { runs: [] } }) })
    render(<RunsPanel taskId="t-1" api={api} />)
    expect(await screen.findByText('还没有运行记录。')).toBeInTheDocument()
  })

  it('接口不在(老服务):这一段明说没接上', async () => {
    const { api } = apiWith({})
    render(<RunsPanel taskId="t-1" api={api} />)
    expect(await screen.findByText('运行账还没接上(老服务)。')).toBeInTheDocument()
  })
})

describe('容量(名片栏)', () => {
  function stateWith(tasks: TaskView[], registry: AgentEntryView[]): WorkbenchState {
    return {
      now: AT,
      sessions: [],
      tasks: {
        tasks, sprints: [], modules: [], project_meta: [],
        goals: [{ id: 'g-1', title: '座机打通', owner: 'me', status: 'open', created_at: AT, updated_at: AT }],
        goal_sprints: [], agent_cards: [], session_proposals: [],
      },
      agent_registry: { entries: registry, asking: [], notices: [] },
    } as unknown as WorkbenchState
  }
  const registry = [
    { id: 'codex', name: 'Codex', status: 'running' },
  ] as unknown as AgentEntryView[]
  const note = (id: string, patch: Partial<TaskView> = {}): TaskView => ({ id, title: id, status: 'todo', source: { kind: 'manual' }, created_at: AT, updated_at: AT, ...patch })

  function fakeFetch(handlers: Record<string, unknown>) {
    const impl = (async (input: string, init?: RequestInit) => {
      const url = new URL(input)
      const method = init?.method ?? 'GET'
      const json = method === 'GET' && handlers[url.pathname] !== undefined
        ? handlers[url.pathname]
        : url.pathname === '/collab/canvas' && method === 'GET' ? { layout: { goals: {}, notes: {} } } : url.pathname.endsWith('/trace') ? { events: [] } : { ok: true }
      return new Response(JSON.stringify(json), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    return impl
  }

  it('手上/在跑/上限分开;上限取不到写「未知」', async () => {
    render((
      <div style={{ width: 1400, height: 900, position: 'relative' }}>
        <CollabZone
          state={stateWith([note('换铃声', { goal_id: 'g-1', status: 'doing', assignee: 'codex' })], registry)}
          baseUrl="http://127.0.0.1:8791"
          fetchImpl={fakeFetch({ '/collab/capacity': { items: [{ id: 'codex', online: true, active_jobs: 3, running_jobs: 1, limit: 'unknown' }] } })}
          presence={[] as CollabPresence[]}
          visible
          initialView="goals"
          width={1400}
        />
      </div>
    ))
    // 2026-10-27 起目标视图右边缺省是事项轨迹,名片栏点「N 张名片」才换过来。
    fireEvent.click(screen.getByRole('button', { name: /张名片$/ }))
    const rail = await screen.findByRole('complementary', { name: '名片' })
    await waitFor(() => expect(rail.textContent).toContain('手上 3 件'))
    expect(rail.textContent).toContain('在跑 1 件')
    expect(rail.textContent).toContain('上限未知')
  })

  it('容量接口不在:那一行不画,不编', async () => {
    render((
      <div style={{ width: 1400, height: 900, position: 'relative' }}>
        <CollabZone
          state={stateWith([note('换铃声', { goal_id: 'g-1' })], registry)}
          baseUrl="http://127.0.0.1:8791"
          fetchImpl={fakeFetch({})}
          presence={[] as CollabPresence[]}
          visible
          initialView="goals"
          width={1400}
        />
      </div>
    ))
    // 2026-10-27 起目标视图右边缺省是事项轨迹,名片栏点「N 张名片」才换过来。
    fireEvent.click(screen.getByRole('button', { name: /张名片$/ }))
    const rail = await screen.findByRole('complementary', { name: '名片' })
    await screen.findByText('换铃声')
    expect(rail.textContent).not.toContain('在跑')
    expect(rail.textContent).not.toContain('上限')
  })
})
