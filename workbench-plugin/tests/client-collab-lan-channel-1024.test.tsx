import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, expect, it } from 'vitest'
import { ChannelView } from '../src/client/collab/ChannelView.tsx'
import { LanIdentityPanel } from '../src/client/collab/LanIdentityPanel.tsx'
import type { CollabApi } from '../src/client/collab/collabApi.ts'
afterEach(cleanup)

it('无中转也能读真实 LAN 项目频道,报告引用与投递回执有明确来源,切项目不串消息', async () => {
  const calls: string[] = []
  const api: CollabApi = {
    get: async path => {
      calls.push(path)
      if (path.startsWith('/collab/lan/channel')) return { transport: 'lan', scope: 'known-paired-members', messages: path.includes('p1') ? [
        { id: 'm1', project_id: 'p1', author: { member_id: 'a', name: '甲事务官' }, text: '请核对交付文件', kind: 'message', at: '2026-10-24T09:00:00Z', deliveries: [{ to: 'b', status: 'delivered', at: '2026-10-24T09:00:01Z' }] },
        { id: 'm2', project_id: 'p1', author: { member_id: 'b', name: '乙事务官' }, text: '已读取交付文件', kind: 'report', reply_to: 'm1', at: '2026-10-24T09:01:00Z' },
      ] : [] } as never
      if (path === '/collab/relay/studio') return { state: 'unwired' } as never
      if (path === '/collab/lan/identity') return { identity: { member_id: 'a', name: '甲事务官', version: 1 } } as never
      return { members: [] } as never
    },
    post: async () => ({ ok: true, body: {} }),
  }
  render(<ChannelView api={api} tick={1} nowMs={Date.parse('2026-10-24T09:02:00Z')} projects={[{ id: 'p1', title: '交付项目' }, { id: 'p2', title: '另一个项目' }]} onOpenStudio={() => {}} onReceipt={() => {}} />)
  const lan = screen.getByRole('region', { name: '局域网项目频道' })
  expect(await within(lan).findByText('请核对交付文件')).toBeInTheDocument()
  expect(within(lan).getByText('乙事务官')).toBeInTheDocument()
  expect(within(lan).getByRole('link', { name: /引用.*请核对交付文件/ })).toHaveAttribute('href', '#lan-message-m1')
  expect(within(lan).getByText(/已送达/)).toBeInTheDocument()
  expect(within(lan).queryByRole('textbox')).not.toBeInTheDocument()
  expect(screen.getByText('没接中转')).toBeInTheDocument()
  await userEvent.setup().selectOptions(screen.getByLabelText('局域网频道项目'), 'p2')
  expect(await within(lan).findByText('这个项目还没有局域网消息。')).toBeInTheDocument()
  expect(within(lan).queryByText('请核对交付文件')).not.toBeInTheDocument()
  expect(calls).toContain('/collab/lan/channel?project_id=p2')
})

it('成员连接走既有配对接口,一次性配对码不存浏览器草稿', async () => {
  const sent: Array<{ path: string, body: unknown }> = []
  const api: CollabApi = {
    get: async path => (path === '/collab/lan/identity' ? { identity: { member_id: 'self-a', name: '甲', version: 1 } } : { members: [] }) as never,
    post: async (path, body) => { sent.push({ path, body }); return { ok: true, body: { ok: true } } },
  }
  render(<LanIdentityPanel api={api} />)
  const user = userEvent.setup()
  await user.click(await screen.findByText('连接局域网协作成员'))
  await user.type(screen.getByLabelText('对端局域网地址'), '127.0.0.1')
  await user.clear(screen.getByLabelText('对端端口'))
  await user.type(screen.getByLabelText('对端端口'), '9994')
  await user.type(screen.getByLabelText('对端稳定身份'), 'peer-b')
  await user.type(screen.getByLabelText('对端一次性配对码'), '123456')
  await user.click(screen.getByRole('button', { name: '配对协作成员' }))
  await screen.findByText('协作成员已配对，可在共同项目中收发记录。')
  expect(sent).toContainEqual({ path: '/collab/lan/connect', body: { host: '127.0.0.1', port: 9994, member_id: 'peer-b', code: '123456' } })
  expect(screen.getByLabelText('对端一次性配对码')).toHaveValue('')
})

it('已知成员探测失败时名称可用性未知,不带客户端自证绕过保存', async () => {
  const posts: string[] = []
  const api: CollabApi = {
    get: async path => (path === '/collab/lan/identity' ? { identity: { member_id: 'self', name: '甲', version: 1 } } : { members: [{ member_id: 'peer', name: '乙', reachable: false }] }) as never,
    post: async path => { posts.push(path); return { ok: true, body: { ok: true } } },
  }
  render(<LanIdentityPanel api={api} />)
  const user = userEvent.setup()
  const name = await screen.findByLabelText('本机事务官名称')
  await user.clear(name)
  await user.type(name, '新名字')
  await user.click(screen.getByRole('button', { name: '查重并保存' }))
  await screen.findByText(/名称可用性未知/)
  expect(posts).toEqual([])
})
