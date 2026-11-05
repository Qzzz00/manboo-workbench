import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeAll, expect, it } from 'vitest'
import type { LanChannelMessage, LanChannelSourceScope } from '../src/protocol.ts'
import { CollabZone } from '../src/client/collab/CollabZone.tsx'
import { ChannelView } from '../src/client/collab/ChannelView.tsx'
import type { CollabApi } from '../src/client/collab/collabApi.ts'
afterEach(cleanup)
beforeAll(() => { globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never })
const at = '2026-10-24T06:00:00Z'
const news: LanChannelMessage = { id: 'news-1', project_id: 'p1', author: { member_id: 'peer-stable', name: '对端原名' }, kind: 'message', text: '正式资讯正文', at, category: 'news', topic: { id: 'feed:entry-1', title: '同一真实话题' }, source: { kind: 'feed', id: 'feed-source-1', scope: 'project-feed', url: 'https://example.test/original', publisher: '原公告发布者', published_at: '2026-10-23T02:00:00Z', recorded_at: at }, refs: [{ kind: 'url', id: 'original-1', title: '原公告链接', url: 'https://example.test/original' }] }
const daily: LanChannelMessage = { id: 'daily-1', project_id: 'p1', author: news.author, kind: 'message', text: '日报正文\n'.repeat(80) + '精确报告尾部', at, category: 'daily', topic: { id: 'project:p1', title: '项目真实进展' }, source: { kind: 'project-report', id: 'daily-source-1', scope: 'local-project-records', recorded_at: at, period: { from: '2026-10-23T00:00:00Z', to: '2026-10-24T00:00:00Z' } }, refs: [{ kind: 'task', id: 'same-local-id', title: '对端原件事项' }], reply_to: news.id, deliveries: [{ to: 'local', status: 'delivered', at }] }
const legacy: LanChannelMessage = { id: 'legacy-1', project_id: 'p1', author: news.author, kind: 'report', text: '日报 新闻 这些文字不能推断分类', at }
const scope: LanChannelSourceScope = { news: 'unwired', reports: 'unknown', peer_sources: 'paired-origin-claims', publication_enabled: false, notes: ['受控来源说明'] }
function setup(messages: readonly LanChannelMessage[] = [news, daily, legacy], sourceScope: LanChannelSourceScope | null = scope) {
  let online = true
  const calls: string[] = []
  const api: CollabApi = { get: async path => {
    calls.push(path)
    if (path.startsWith('/collab/lan/channel')) return online ? { transport: 'lan', messages: path.includes('p2') ? [] : messages, ...(sourceScope ? { source_scope: sourceScope } : {}) } as never : undefined
    if (path === '/collab/relay/studio') return { state: 'unwired' } as never
    if (path === '/collab/lan/identity') return { identity: { member_id: 'local', name: '本机', version: 1 } } as never
    return { members: [] } as never
  }, post: async path => { throw new Error(`只读频道不应调用 ${path}`) } }
  const props = { api, tick: 1, nowMs: Date.parse(at), projects: [{ id: 'p1', title: '当前项目' }, { id: 'p2', title: '另一个项目' }], onOpenStudio: () => {}, onReceipt: () => {} }
  const view = render(<ChannelView {...props} />)
  return { calls, view, props, offline: () => { online = false; view.rerender(<ChannelView {...props} tick={2} />) }, lan: screen.getByRole('region', { name: '局域网项目频道' }) }
}
it('正式资讯显示分类话题原发布者链接与三类时间，配对声明不冒本机全源核验', async () => {
  const { lan } = setup()
  await within(lan).findByText('正式资讯正文')
  expect(within(lan).getByText('话题：同一真实话题')).toHaveAttribute('title', 'feed:entry-1')
  expect(within(lan).getByText(/发布者：原公告发布者/)).toBeInTheDocument()
  expect(within(lan).getByRole('link', { name: '原公告链接' })).toHaveAttribute('href', 'https://example.test/original')
  for (const label of ['发表时间', '来源记录时间', '消息时间', '配对来源声明', '本机未独立核验对端源文件']) expect(lan).toHaveTextContent(label)
  expect(lan).toHaveTextContent('本机资讯来源未接入')
  expect(lan).toHaveTextContent('不代表整个局域网')
  expect(within(lan).queryByRole('textbox')).not.toBeInTheDocument()
})
it('正式 message 日报展开收回、完整时期和对端事项只读，不跳本机同 ID', async () => {
  const { lan } = setup([daily])
  const user = userEvent.setup()
  const expand = await within(lan).findByRole('button', { name: '展开报告' })
  expect(lan).toHaveTextContent('2026-10-23T00:00:00Z — 2026-10-24T00:00:00Z')
  expect(lan).toHaveTextContent('对端原件事项')
  expect(lan).toHaveTextContent('same-local-id')
  expect(lan).toHaveTextContent('发送成员原件，只读引用')
  expect(within(lan).queryByRole('link', { name: /对端原件事项/ })).not.toBeInTheDocument()
  expect(lan).not.toHaveTextContent('精确报告尾部')
  await user.click(expand)
  expect(lan).toHaveTextContent('精确报告尾部')
  await user.click(within(lan).getByRole('button', { name: '收回报告' }))
  expect(lan).not.toHaveTextContent('精确报告尾部')
})
it('分类只消费正式 category，筛选后引用能回到原消息，话题不改变项目频道', async () => {
  const { lan, calls } = setup()
  const user = userEvent.setup()
  await within(lan).findByText('正式资讯正文')
  await user.selectOptions(within(lan).getByLabelText('局域网消息分类'), 'daily')
  expect(within(lan).queryByText('正式资讯正文')).not.toBeInTheDocument()
  expect(within(lan).getByRole('link', { name: /引用.*正式资讯正文/ })).toBeInTheDocument()
  await user.click(within(lan).getByRole('link', { name: /引用.*正式资讯正文/ }))
  expect(await within(lan).findByText('正式资讯正文')).toBeInTheDocument()
  await user.selectOptions(within(lan).getByLabelText('局域网消息分类'), 'unknown')
  expect(lan).toHaveTextContent(legacy.text)
  expect(within(lan).queryByText('正式资讯正文')).not.toBeInTheDocument()
  await user.selectOptions(within(lan).getByLabelText('局域网消息分类'), 'all')
  await user.selectOptions(within(lan).getByLabelText('局域网消息话题'), 'feed:entry-1')
  expect(lan).toHaveTextContent('正式资讯正文')
  expect(lan).not.toHaveTextContent('精确报告尾部')
  expect(calls.filter(path => path.startsWith('/collab/lan/channel'))).toEqual(['/collab/lan/channel?project_id=p1'])
  await user.selectOptions(within(lan).getByLabelText('局域网频道项目'), 'p2')
  await within(lan).findByText('这个项目还没有局域网消息。')
  expect(lan).not.toHaveTextContent('正式资讯正文')
})
it('失联保留历史快照但来源就绪不冒当前，恢复刷新使用新状态', async () => {
  const { lan, offline, view, props } = setup([news], { ...scope, news: 'ready', reports: 'ready' })
  await within(lan).findByText('正式资讯正文')
  offline()
  await within(lan).findByText(/局域网频道此刻读不到/)
  expect(lan).toHaveTextContent('上次已知本机来源范围')
  expect(lan).toHaveTextContent('正式资讯正文')
  view.rerender(<ChannelView {...props} api={{ ...props.api, get: async path => path.startsWith('/collab/lan/channel') ? { transport: 'lan', messages: [news], source_scope: scope } as never : props.api.get(path) }} tick={3} />)
  expect(await within(lan).findByText(/本机资讯来源未接入/)).toBeInTheDocument()
  expect(lan).not.toHaveTextContent('上次已知本机来源范围')
})
it.each(['unwired', 'empty', 'ready', 'unknown'] as const)('本机来源范围 %s 不外推 LAN 全局', async newsState => {
  const { lan } = setup([], { ...scope, news: newsState })
  await within(lan).findByText('这个项目还没有局域网消息。')
  const labels = { unwired: '本机资讯来源未接入', empty: '本机资讯来源已知为空', ready: '本机资讯来源已接入', unknown: '本机资讯来源状态未知' }
  expect(lan).toHaveTextContent(labels[newsState])
  expect(lan).toHaveTextContent('受控来源说明')
})
it('旧源没有 scope 时明确未知，不补来源，不根据日报关键字生成选项', async () => {
  const { lan } = setup([legacy], null)
  await within(lan).findByText(legacy.text)
  expect(lan).toHaveTextContent('本机来源范围未知')
  expect(lan).toHaveTextContent('分类未知')
  expect(within(lan).queryByRole('option', { name: '日报' })).not.toBeInTheDocument()
})
it('首次不可读时本机来源状态也明确未知，不显示就绪', async () => {
  const api: CollabApi = { get: async () => undefined, post: async () => ({ ok: false, body: {} }) }
  render(<ChannelView api={api} tick={1} nowMs={Date.parse(at)} projects={[{ id: 'p1', title: '当前项目' }]} onOpenStudio={() => {}} onReceipt={() => {}} />)
  const lan = screen.getByRole('region', { name: '局域网项目频道' })
  await within(lan).findByText(/局域网频道此刻读不到/)
  expect(lan).toHaveTextContent('本机来源范围未知')
  expect(lan).not.toHaveTextContent('本机资讯来源已接入')
})
it('残缺来源快照按未知保留消息，不用残留 category 生成正式菜单', async () => {
  const { source: _source, ...partial } = news
  const { lan } = setup([partial])
  await within(lan).findByText(news.text)
  expect(lan).toHaveTextContent('未提供完整正式来源快照')
  expect(within(lan).queryByRole('option', { name: '资讯' })).not.toBeInTheDocument()
  expect(within(lan).queryByText('话题：同一真实话题')).not.toBeInTheDocument()
})
it('周报也消费正式 category，即便 kind 仍为 message；危险 URL 不变成可执行链接', async () => {
  const weekly: LanChannelMessage = { ...daily, id: 'weekly-1', category: 'weekly', source: { ...daily.source!, id: 'weekly-source', period: { from: '2026-10-12', to: '2026-10-18' } }, refs: [{ kind: 'url', id: 'bad-url', title: '无效原链接', url: 'javascript:alert(1)' }] }
  const { lan } = setup([weekly])
  await within(lan).findByRole('button', { name: '展开报告' })
  expect(lan).toHaveTextContent('周报')
  expect(lan).toHaveTextContent('2026-10-12 — 2026-10-18')
  expect(within(lan).queryByRole('link', { name: '无效原链接' })).not.toBeInTheDocument()
})

it('生产 CollabZone 只有 stale 改变也刷新 LAN 来源，不把上次 ready 冒当前', async () => {
  let online = true
  const fetchImpl = (async (input: string | URL | Request) => {
    const path = String(input)
    if (path.includes('/collab/lan/channel')) {
      if (!online) throw new TypeError('本机受控 API 已关闭')
      return new Response(JSON.stringify({ transport: 'lan', messages: [news], source_scope: scope }))
    }
    if (path.includes('/collab/relay/studio')) return new Response(JSON.stringify({ state: 'unwired' }))
    if (path.includes('/collab/lan/identity')) return new Response(JSON.stringify({ identity: { member_id: 'local', name: '本机', version: 1 } }))
    return new Response(JSON.stringify({ members: [] }))
  }) as typeof fetch
  const state = { now: at, stale: false, sessions: [], tasks: { tasks: [{ id: 't1', title: '已有事项', project_id: 'p1', status: 'todo', created_at: at, updated_at: at, source: { kind: 'manual' } }], sprints: [], modules: [], project_meta: [], goals: [], agent_cards: [] } }
  const props = { baseUrl: 'http://local', fetchImpl, presence: [], visible: true, initialView: 'channel' as const }
  const view = render(<CollabZone {...props} state={state as never} />)
  const lan = screen.getByRole('region', { name: '局域网项目频道' })
  await within(lan).findByText(news.text)
  online = false
  view.rerender(<CollabZone {...props} state={{ ...state, stale: true } as never} />)
  await within(lan).findByText(/局域网频道此刻读不到/)
  expect(lan).toHaveTextContent('上次已知本机来源范围')
  expect(lan).toHaveTextContent(news.text)
})
