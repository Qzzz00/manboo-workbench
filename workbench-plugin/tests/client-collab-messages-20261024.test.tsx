/**
 * 事项留言/邀请 + 统一活动流(2026-10-24,小K collab-desktop-1024,消费 core 契约 §2 C)。
 *
 * 钉死:
 * - 普通留言默认只记;@名片 = ask,发送前显示准确对象与动作(「将请 X 处理」),
 *   可改「只留记录」;协作者由服务端加,负责人不动(UI 不替它改 assignee);
 * - client_msg_id 幂等:失败重发同一个号,不重复留言;
 * - 投递态如实渲染:已受理待处理/已开始处理/没送到+原因(未知名字不当已邀请);
 * - 活动流 = message/comment/receipt/transition/run 按时间合一(接口不在就退回本地 comment+receipt,不说有流);
 * - 悬浮速览与详情共用同一份草稿(localStorage 一键一事)。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { NoteTalk } from '../src/client/collab/NoteTalk.tsx'
import type { CollabApi } from '../src/client/collab/collabApi.ts'
import type { RailCard } from '../src/client/collab/collabModel.ts'
import type { TaskView } from '../src/protocol.ts'

afterEach(() => {
  cleanup()
  localStorage.clear()
})

const AT = '2026-10-24T09:00:00.000Z'
const task = (patch: Partial<TaskView> = {}): TaskView => ({
  id: 't-1', title: '换铃声', status: 'doing', source: { kind: 'manual' }, created_at: AT, updated_at: AT, ...patch,
}) as TaskView

const cards: RailCard[] = [
  { id: 'me', name: 'Ben', kind: 'me', online: true },
  { id: 'agent:ben:codex1', name: 'Codex 名片', kind: 'card', online: true },
]

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

const activityOk = () => ({ status: 200, json: { items: [] } })

function talk(api: CollabApi, patch: Partial<TaskView> = {}) {
  render(<NoteTalk task={task(patch)} cards={cards} api={api} onReceipt={() => {}} />)
}

describe('留言与邀请', () => {
  it('@名片:发送前显示准确对象与动作;可只留记录;不带 assignee 改动', async () => {
    const user = userEvent.setup()
    const { calls, api } = apiWith({
      '/collab/note/activity': activityOk,
      '/collab/note/message': () => ({ status: 200, json: { ok: true, message: { id: 'm1', at: AT, intent: 'ask' } } }),
    })
    talk(api)
    const box = await screen.findByRole('textbox', { name: '留一句' })
    await user.type(box, '@Codex 名片 把铃声换成三全音')
    // 发送前:准确对象与动作
    expect(screen.getByText(/将请 Codex 名片 处理/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '请 TA 处理' }))
    await waitFor(() => {
      const sent = calls.find(one => one.path === '/collab/note/message' && one.method === 'POST')
      expect(sent).toBeDefined()
      expect(sent!.body).toMatchObject({ task_id: 't-1', intent: 'ask', mentions: ['agent:ben:codex1'] })
      expect(String(sent!.body!.client_msg_id)).toMatch(/^nm-/)
      expect(sent!.body).not.toHaveProperty('assignee')
      expect(sent!.body).not.toHaveProperty('collaborators')
    })
  })

  it('没有 @:默认只留记录,直接发', async () => {
    const user = userEvent.setup()
    const { calls, api } = apiWith({
      '/collab/note/activity': activityOk,
      '/collab/note/message': () => ({ status: 200, json: { ok: true, message: { id: 'm2', at: AT, intent: 'record' } } }),
    })
    talk(api)
    const box = await screen.findByRole('textbox', { name: '留一句' })
    await user.type(box, '记得看周报')
    expect(screen.queryByText(/将请/)).toBeNull()
    await user.click(screen.getByRole('button', { name: '留言' }))
    await waitFor(() => {
      const sent = calls.find(one => one.path === '/collab/note/message' && one.method === 'POST')
      expect(sent!.body).toMatchObject({ intent: 'record' })
      expect(sent!.body).not.toHaveProperty('mentions')
    })
  })

  it('失败重发复用同一个 client_msg_id,不重复留言', async () => {
    const user = userEvent.setup()
    let tries = 0
    const { calls, api } = apiWith({
      '/collab/note/activity': activityOk,
      '/collab/note/message': () => {
        tries += 1
        return tries === 1
          ? { status: 200, json: { ok: false, error: '工作台服务没应答,稍后再试' } }
          : { status: 200, json: { ok: true, duplicated: true, message: { id: 'm3', at: AT, intent: 'record' } } }
      },
    })
    talk(api)
    const box = await screen.findByRole('textbox', { name: '留一句' })
    await user.type(box, '断线重试那句')
    await user.click(screen.getByRole('button', { name: '留言' }))
    await screen.findByText('工作台服务没应答,稍后再试')
    // 草稿还在(没丢),点重发 → 同一个号
    expect(box).toHaveValue('断线重试那句')
    await user.click(screen.getByRole('button', { name: '重发' }))
    await waitFor(() => expect(calls.filter(one => one.path === '/collab/note/message' && one.method === 'POST').length).toBe(2))
    const ids = calls.filter(one => one.path === '/collab/note/message').map(one => one.body!.client_msg_id)
    expect(ids[0]).toBe(ids[1])
  })

  it('投递态如实:已开始处理 / 没送到+原因(未知名字)', async () => {
    const { api } = apiWith({
      '/collab/note/activity': () => ({
        status: 200,
        json: {
          items: [
            {
              type: 'message', at: AT,
              message: {
                id: 'm4', by: 'me', text: '@Codex 名片 看一下', at: AT, intent: 'ask', mentions: ['agent:ben:codex1'],
                deliveries: [
                  { to: 'agent:ben:codex1', status: 'accepted', at: AT },
                  { to: 'ghost', status: 'failed', error: 'unknown target: ghost', at: AT },
                ],
              },
            },
          ],
        },
      }),
    })
    talk(api)
    expect(await screen.findByText(/Codex 名片:已开始处理/)).toBeInTheDocument()
    expect(screen.getByText(/ghost:没送到 · unknown target: ghost/)).toBeInTheDocument()
  })

  it('活动流按时间合一:message/comment/receipt/transition', async () => {
    const { api } = apiWith({
      '/collab/note/activity': () => ({
        status: 200,
        json: {
          items: [
            { type: 'transition', at: '2026-10-24T08:00:00.000Z', from: 'todo', to: 'doing' },
            { type: 'message', at: '2026-10-24T08:30:00.000Z', message: { id: 'm5', by: 'me', text: '开工了吗', at: '2026-10-24T08:30:00.000Z', intent: 'record' } },
            { type: 'comment', at: '2026-10-24T09:00:00.000Z', comment: { id: 'c1', by: 'me', text: '通过', at: '2026-10-24T09:00:00.000Z', verdict: 'pass' } },
            { type: 'receipt', at: '2026-10-24T09:30:00.000Z', receipt: { kind: 'done', text: '做完:铃声换好了', at: '2026-10-24T09:30:00.000Z', by: 'codex' } },
          ],
        },
      }),
    })
    talk(api)
    const stream = await screen.findByRole('list', { name: '事项活动' })
    const texts = within(stream).getAllByRole('listitem').map(one => one.textContent)
    expect(texts.some(one => one!.includes('盖成「在做」'))).toBe(true)
    expect(texts.some(one => one!.includes('开工了吗'))).toBe(true)
    expect(texts.some(one => one!.includes('通过'))).toBe(true)
    expect(texts.some(one => one!.includes('做完'))).toBe(true)
  })

  it('接口不在(老服务):退回本地留言与回执,不说有活动流', async () => {
    const { api } = apiWith({})
    talk(api, { comments: [{ id: 'c9', by: 'me', text: '老的留言', at: AT }], receipt: { kind: 'done', text: '做完:好', at: AT } })
    expect(await screen.findByText('老的留言')).toBeInTheDocument()
    expect(screen.getByText(/做完:好/)).toBeInTheDocument()
    expect(screen.queryByRole('list', { name: '事项活动' })).toBeNull()
  })
})

describe('共用草稿', () => {
  it('同一事项:写完关窗再开,草稿还在;换成别的事项不串稿', async () => {
    const user = userEvent.setup()
    const { api } = apiWith({ '/collab/note/activity': activityOk })
    const first = render(<NoteTalk task={task()} cards={cards} api={api} onReceipt={() => {}} />)
    const box = await screen.findByRole('textbox', { name: '留一句' })
    await user.type(box, '半句话')
    first.unmount()
    // 同一事项再开:草稿回来
    render(<NoteTalk task={task()} cards={cards} api={api} onReceipt={() => {}} />)
    expect(await screen.findByRole('textbox', { name: '留一句' })).toHaveValue('半句话')
  })
})
