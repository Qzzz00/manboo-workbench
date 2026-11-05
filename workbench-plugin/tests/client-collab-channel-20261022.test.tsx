/**
 * 协作区「频道」那一屏(2026-10-22,统筹转维护者:「频道是最早定下的功能」;照评审页协作区原型 `channelView`)。
 * 接已有的跨机底座:`GET /collab/relay/studio` 认工作室与频道、`GET /collab/relay/channel?id=` 读、`POST /collab/relay/channel/say` 发。
 * 中转没接上 / 连不上 / 还没加入工作室:整屏一块说清楚,不画空壳。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { CollabChannelSnapshot, WorkbenchState } from '../src/protocol.ts'
import { CollabZone } from '../src/client/collab/CollabZone.tsx'

afterEach(cleanup)
beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never
})

const NOW = Date.parse('2026-10-21T12:24:00+08:00')
const STATE = {
  now: new Date(NOW).toISOString(),
  sessions: [],
  tasks: { tasks: [], sprints: [], modules: [], project_meta: [], goals: [], goal_sprints: [], agent_cards: [], session_proposals: [], squads: [], timers: [], mcp: [] },
  agent_registry: { entries: [], asking: [], notices: [] },
} as unknown as WorkbenchState

const CHANNEL = { id: 'ws:a/ch:1', kind: 'workspace', workspace_id: 'a', name: '工作室', created_by: 'p1', created_at: '2026-10-20T00:00:00Z', version: 2 } as const
const SNAP: CollabChannelSnapshot = {
  channel: CHANNEL,
  cursor: 2,
  messages: [
    { id: 'm1', channel: CHANNEL.id, seq: 1, kind: 'say', author: { person: 'p1', nick: '阿本', device: 'd1' }, text: '本周先把任务接续跑稳。', refs: [], attachments: [], request_id: 'r1', at: '2026-10-21T01:58:00Z', origin: { device: 'd1' } },
    { id: 'm2', channel: CHANNEL.id, seq: 2, kind: 'say', author: { person: 'p2', nick: '小乔', device: 'd2', butler: true }, text: '脚本已交回。', refs: [{ object_id: 'o1', kind: 'note', title: '写第一版脚本' }], attachments: [], request_id: 'r2', at: '2026-10-21T04:08:00Z', origin: { device: 'd2' } },
  ],
}

function mount(studio: Record<string, unknown>) {
  const posts: { path: string, body: unknown }[] = []
  const impl = (async (input: string, init?: RequestInit) => {
    const url = new URL(input)
    if (init?.method === 'POST') posts.push({ path: url.pathname, body: JSON.parse(String(init.body)) })
    const json = url.pathname === '/collab/relay/studio' ? studio
      : url.pathname === '/collab/relay/channel' ? SNAP
        : url.pathname === '/collab/canvas' ? { layout: { goals: {}, notes: {} } } : { ok: true }
    return new Response(JSON.stringify(json), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  render(<div style={{ position: 'relative' }}><CollabZone state={STATE} baseUrl="http://127.0.0.1:8791" fetchImpl={impl} presence={[]} visible nowMs={NOW} timelineWidth={1228} /></div>)
  return posts
}

describe('频道视图', () => {
  it('视图那一段多一颗「频道」;中转没接上就整屏说「没接中转」', async () => {
    const user = userEvent.setup()
    mount({ state: 'unwired' })
    await user.click(within(screen.getByRole('group', { name: '视图' })).getByRole('button', { name: '频道' }))
    expect(await screen.findByText('没接中转')).toBeInTheDocument()
  })

  it('连不上中转:说为什么,给一颗「再试一次」', async () => {
    const user = userEvent.setup()
    mount({ state: 'offline', why: '网络断了' })
    await user.click(screen.getByRole('button', { name: '频道' }))
    expect(await screen.findByText('连不上中转')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /再试一次/ })).toBeInTheDocument()
  })

  it('还没加入工作室:「去设置」打开协作区设置的工作室那一组', async () => {
    const user = userEvent.setup()
    mount({ state: 'none' })
    await user.click(screen.getByRole('button', { name: '频道' }))
    await user.click(await screen.findByRole('button', { name: /去设置/ }))
    expect(within(screen.getByRole('dialog', { name: '设置' })).getByRole('button', { name: '工作室' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('加入了:一条一条「头像 名字 · 时刻 / 话 / 引用的事项」;人类只读,没有发送框(2026-10-24)', async () => {
    const user = userEvent.setup()
    const posts = mount({ state: 'joined', me: { account_id: 'p1', nick: '阿本', role: 'owner' }, channels: [CHANNEL] })
    await user.click(screen.getByRole('button', { name: '频道' }))
    const list = await screen.findByRole('list', { name: '频道消息' })
    const items = within(list).getAllByRole('listitem')
    expect(items).toHaveLength(2)
    expect(items[0]).toHaveTextContent('阿本')
    expect(items[0]).toHaveTextContent('本周先把任务接续跑稳。')
    expect(items[1]).toHaveTextContent('小乔 的事务官')
    expect(items[1]).toHaveTextContent('写第一版脚本')
    // 2026-10-24(collab-desktop-1024,设计 3.7 拍板):频道是事务官聊天室,人类只读 —— 发送框退休。
    expect(screen.queryByRole('textbox', { name: '给协作区留一句话' })).toBeNull()
    expect(screen.queryByRole('button', { name: '发送' })).toBeNull()
    expect(screen.getByText('频道由事务官们交流,人在这里只读旁观。')).toBeInTheDocument()
    expect(posts.filter(one => one.path === '/collab/relay/channel/say')).toHaveLength(0)
  })
})
