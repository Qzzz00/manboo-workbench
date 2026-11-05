/**
 * 频道:人类只读 + 局域网身份(2026-10-24,小K collab-desktop-1024,消费 core 契约 §5 F)。
 *
 * 钉死:
 * - 频道没有人类发送框(事务官聊天室,人旁观);
 * - 消息流=发送者/时间/引用,撤回的不混进来;
 * - 改名:先显式 refresh 成员(按需 ping,不是后台扫描)再保存,带 expected_version;
 *   归一重名 409 → 说清和谁冲突;成员不完整 availability:'unknown' → 不显示「可用」;
 *   版本冲突 → 保留输入、显示服务端当前副本、可重试;改名不换稳定 member_id。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { ChannelView } from '../src/client/collab/ChannelView.tsx'
import type { CollabApi } from '../src/client/collab/collabApi.ts'

afterEach(cleanup)

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

const studioOk = () => ({ status: 200, json: { state: 'joined', workspace: { id: 'w-1', name: 'Ben 的工作室' }, channels: [{ id: 'ch-1', name: '协作', kind: 'workspace', archived_at: undefined, created_at: AT, updated_at: AT }] } })

function view(api: CollabApi) {
  render(<ChannelView api={api} tick={0} nowMs={Date.parse(AT)} onOpenStudio={() => {}} onReceipt={() => {}} />)
}

describe('频道:人类只读', () => {
  it('没有发送框;消息流只有发送者/时间/引用', async () => {
    const { api } = apiWith({
      '/collab/relay/studio': studioOk,
      '/collab/relay/channel': () => ({
        status: 200,
        json: {
          id: 'ch-1', at: AT,
          messages: [
            { id: 'm1', at: AT, text: '早报已贴', via: undefined, retracted: undefined, refs: [], author: { person: 'a', nick: '小柯', butler: true } },
            { id: 'm2', at: AT, text: '撤了', retracted: AT, refs: [], author: { person: 'b', nick: '阿雅', butler: true } },
          ],
        },
      }),
      '/collab/lan/identity': () => ({ status: 200, json: { member_id: 'm-fixed-1', name: '事务官', version: 3, updated_at: AT } }),
      '/collab/lan/members': () => ({ status: 200, json: { members: [] } }),
    })
    view(api)
    expect(await screen.findByText('早报已贴')).toBeInTheDocument()
    expect(screen.getByText('小柯 的事务官')).toBeInTheDocument()
    expect(screen.queryByText('撤了')).toBeNull()
    // 人类没有发送框
    expect(screen.queryByLabelText('给协作区留一句话')).toBeNull()
    expect(screen.queryByRole('button', { name: '发送' })).toBeNull()
    expect(screen.getByText('频道由事务官们交流,人在这里只读旁观。')).toBeInTheDocument()
  })
})

describe('频道:局域网身份改名', () => {
  const identity = () => ({ status: 200, json: { identity: { member_id: 'm-fixed-1', name: '事务官', version: 3, updated_at: AT } } })

  it('保存前显式 refresh 成员(按需 ping),带 expected_version;改名不换 member_id', async () => {
    const user = userEvent.setup()
    const { calls, api } = apiWith({
      '/collab/relay/studio': studioOk,
      '/collab/relay/channel': () => ({ status: 200, json: { id: 'ch-1', at: AT, messages: [] } }),
      '/collab/lan/identity': ((body?: Record<string, unknown>) => body === undefined
        ? identity()
        : { status: 200, json: { ok: true, identity: { member_id: 'm-fixed-1', name: String(body.name), version: 4, updated_at: AT } } }) as (body?: Record<string, unknown>) => { status: number, json: unknown },
      '/collab/lan/members': () => ({ status: 200, json: { members: [{ member_id: 'm-2', name: '阿雅的事务官', host: '10.0.0.2', port: 8791, reachable: true, last_seen: AT }] } }),
    })
    view(api)
    const input = await screen.findByLabelText('本机事务官名称')
    expect(input).toHaveValue('事务官')
    await user.clear(input)
    await user.type(input, '小柯的事务官')
    await user.click(screen.getByRole('button', { name: '查重并保存' }))
    await waitFor(() => {
      const save = calls.find(one => one.path === '/collab/lan/identity' && one.method === 'POST')
      expect(save).toBeDefined()
      expect(save!.body).toMatchObject({ name: '小柯的事务官', expected_version: 3 })
    })
    // 保存成功回执;member_id 不动
    expect(await screen.findByText('名称存好了(身份不变,还是原来那个)')).toBeInTheDocument()
    expect(calls.some(one => one.path.startsWith('/collab/lan/members?refresh=1'))).toBe(true)
  })

  it('扫描失败/成员不完整:不显示「可用」,说清可用性未知', async () => {
    const user = userEvent.setup()
    const { api } = apiWith({
      '/collab/relay/studio': studioOk,
      '/collab/relay/channel': () => ({ status: 200, json: { id: 'ch-1', at: AT, messages: [] } }),
      '/collab/lan/identity': identity,
      '/collab/lan/members': () => ({ status: 200, json: { members: [], incomplete: true } }),
      // 即便 UI 误发保存,服务端也拒
    })
    view(api)
    await screen.findByLabelText('本机事务官名称')
    await user.click(screen.getByRole('button', { name: '查重并保存' }))
    expect(await screen.findByText('成员列表不完整,名称可用性未知 —— 没有确认「可用」,名字没改。')).toBeInTheDocument()
    expect(screen.queryByText('名称可用', { exact: true })).toBeNull()
  })

  it('归一重名 409:说清和谁冲突', async () => {
    const user = userEvent.setup()
    const { api } = apiWith({
      '/collab/relay/studio': studioOk,
      '/collab/relay/channel': () => ({ status: 200, json: { id: 'ch-1', at: AT, messages: [] } }),
      '/collab/lan/identity': ((body?: Record<string, unknown>) => body === undefined
        ? identity()
        : { status: 409, json: { ok: false, error: '名称与已知成员重复(归一后)', conflict_with: '阿雅的事务官' } }) as (body?: Record<string, unknown>) => { status: number, json: unknown },
      '/collab/lan/members': () => ({ status: 200, json: { members: [] } }),
    })
    view(api)
    const input = await screen.findByLabelText('本机事务官名称')
    await user.clear(input)
    await user.type(input, '阿雅的事务官')
    await user.click(screen.getByRole('button', { name: '查重并保存' }))
    expect(await screen.findByText(/名称与已知成员重复/)).toBeInTheDocument()
  })

  it('版本冲突:保留输入、显示服务端当前副本、可重试', async () => {
    const user = userEvent.setup()
    let version = 3
    let firstTry = true
    const { api } = apiWith({
      '/collab/relay/studio': studioOk,
      '/collab/relay/channel': () => ({ status: 200, json: { id: 'ch-1', at: AT, messages: [] } }),
      '/collab/lan/identity': ((body?: Record<string, unknown>) => {
        if (body === undefined) return { status: 200, json: { identity: { member_id: 'm-fixed-1', name: '事务官', version, updated_at: AT } } }
        // 第一次保存撞上并发(别的窗口刚改成「事务官·新」);按服务端副本重试则成功。
        if (firstTry) {
          firstTry = false
          return { status: 409, json: { ok: false, error: '保存冲突:别的窗口刚改过', identity: { member_id: 'm-fixed-1', name: '事务官·新', version: version + 1, updated_at: AT } } }
        }
        return { status: 200, json: { ok: true, identity: { member_id: 'm-fixed-1', name: String(body.name), version: version + 2, updated_at: AT } } }
      }) as (body?: Record<string, unknown>) => { status: number, json: unknown },
      '/collab/lan/members': () => ({ status: 200, json: { members: [] } }),
    })
    view(api)
    const input = await screen.findByLabelText('本机事务官名称')
    await user.clear(input)
    await user.type(input, '小柯')
    await user.click(screen.getByRole('button', { name: '查重并保存' }))
    expect(await screen.findByText(/保存冲突/)).toBeInTheDocument()
    // 输入保留 + 服务端副本显示
    expect(screen.getByLabelText('本机事务官名称')).toHaveValue('小柯')
    expect(screen.getByText(/事务官·新/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '按服务端这版重试' })).toBeInTheDocument()
  })

  it('成员可达性如实:没 refresh 过 = 未知,不说在线', async () => {
    const { api } = apiWith({
      '/collab/relay/studio': studioOk,
      '/collab/relay/channel': () => ({ status: 200, json: { id: 'ch-1', at: AT, messages: [] } }),
      '/collab/lan/identity': identity,
      '/collab/lan/members': () => ({ status: 200, json: { members: [{ member_id: 'm-2', name: '阿雅的事务官', host: '10.0.0.2', port: 8791 }] } }),
    })
    view(api)
    expect(await screen.findByText('阿雅的事务官')).toBeInTheDocument()
    expect(screen.getAllByText('可达性未知').length).toBeGreaterThan(0)
    expect(screen.queryByText('在线')).toBeNull()
  })
})
