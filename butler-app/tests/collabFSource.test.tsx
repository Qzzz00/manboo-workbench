import { afterEach, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createApiClient } from '../src/api/client';
import { ChannelPanel } from '../src/collab/ChannelPanel';
import { LanChannelPanel } from '../src/collab/LanChannelPanel';
const NOW = '2026-10-24T12:00:00Z';
const base = { id: 'm-news', project_id: 'project:a', author: { member_id: 'peer:a', name: '甲事务官' }, text: '原始资讯说明', kind: 'message', at: NOW };
const news = { ...base, category: 'news', topic: { id: 'feed:item-a', title: '真实资料话题' }, source: { kind: 'feed', id: 'source:a', recorded_at: '2026-10-24T11:30:00Z', scope: 'project-feed', url: 'https://example.test/source-a', publisher: '原发布者', published_at: '2026-10-23T10:00:00Z' }, refs: [{ kind: 'url', id: 'original-a', title: '原材料', url: 'https://example.test/source-a' }] };
const daily = { ...base, id: 'm-daily', text: '# 原项目日报\n\n' + '长报告内容。'.repeat(800) + '\n\n日报末尾未截断', category: 'daily', topic: { id: 'project:a', title: '项目日报话题' }, source: { kind: 'project-report', id: 'daily:a', recorded_at: NOW, scope: 'local-project-records', period: { from: '2026-10-23', to: '2026-10-23' } }, refs: [{ kind: 'task', id: 't-local-collision', title: '对端事项原名' }] };
const weekly = { ...daily, id: 'm-weekly', text: '# 原项目周报\n\n周报完整正文', category: 'weekly', source: { ...daily.source, id: 'weekly:a', period: { from: '2026-10-12', to: '2026-10-18' } } };
const scope = { news: 'unwired', reports: 'ready', peer_sources: 'paired-origin-claims', publication_enabled: false, notes: ['本机没有接资讯来源，不代表对端没有资讯'] };
const response = (messages: readonly unknown[], sourceScope: unknown = scope) => ({ transport: 'lan', scope: 'known-paired-members', messages, ...(sourceScope === undefined ? {} : { source_scope: sourceScope }) });
function clientOf(data: unknown, calls: { method: string; path: string }[] = []) {
  return createApiClient({ pairing: { token: 'test-only', host: '127.0.0.1', port: 10092, deviceId: 'f-test' }, onUnauthorized() {}, fetchImpl: async (input, init) => { calls.push({ method: init?.method ?? 'GET', path: String(input) }); return new Response(JSON.stringify(data), { status: 200 }); } });
}
const projects = [{ id: 'project:a', name: '项目甲' }, { id: 'project:b', name: '项目乙' }];
const view = (client: ReturnType<typeof clientOf>, token = 1) => <LanChannelPanel client={client} projects={projects} refreshToken={token} now={NOW} />;
afterEach(cleanup);
it('news来源快照完整可读，本机unwired不遮配对资讯，人类没有写口', async () => {
  const calls: { method: string; path: string }[] = [];
  render(view(clientOf(response([news]), calls)));
  await screen.findByText('原始资讯说明');
  expect(screen.getByText(/本机资讯来源未接入/)).toBeTruthy();
  expect(screen.getByText(/不代表整个局域网/)).toBeTruthy();
  expect(screen.getByText(/来自已配对发送者的来源声明.*未独立核验/)).toBeTruthy();
  expect(screen.getByText(/话题:真实资料话题.*feed:item-a/)).toBeTruthy();
  expect(screen.getByText(/发布者:原发布者/)).toBeTruthy();
  expect(screen.getByText(/发表时间:2026-10-23T10:00:00Z/)).toBeTruthy();
  expect(screen.getByText(/来源记录时间:2026-10-24T11:30:00Z/)).toBeTruthy();
  expect(screen.getByRole('link', { name: /原链接/ }).getAttribute('href')).toBe('https://example.test/source-a');
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(screen.queryByRole('button', { name: /发送|发布|来源配置/ })).toBeNull();
  expect(calls.every(call => call.method === 'GET')).toBe(true);
});
it('daily/weekly正文可完整展开，准确时期与发送成员事项引用不假跳本地', async () => {
  render(view(clientOf(response([daily, weekly]))));
  const details = await screen.findAllByText(/展开(日报|周报)正文/);
  expect(details).toHaveLength(2);
  fireEvent.click(details[0]!);
  expect(screen.getByText('日报末尾未截断')).toBeTruthy();
  expect(screen.getByRole('heading', { name: '原项目日报' })).toBeTruthy();
  expect(screen.getByText(/时期:2026-10-23 → 2026-10-23/)).toBeTruthy();
  expect(screen.getByText(/时期:2026-10-12 → 2026-10-18/)).toBeTruthy();
  expect(screen.getAllByText(/发送成员 peer:a 的事项引用.*对端事项原名.*t-local-collision/)).toHaveLength(2);
  expect(screen.queryByRole('button', { name: /对端事项原名/ })).toBeNull();
  expect(screen.queryByRole('link', { name: /对端事项原名/ })).toBeNull();
});
it('category/topic/source按真实快照筛选，不从旧正文日报关键词猜分类，项目不等于话题', async () => {
  const otherSource = { ...news, id: 'm-news-other', text: '另一来源', source: { ...news.source, id: 'source:b' } };
  const old = { ...base, id: 'm-old', text: '日报周报资讯全是关键词，仍未分类' };
  render(view(clientOf(response([news, otherSource, daily, weekly, old]))));
  await screen.findByText(old.text);
  fireEvent.change(screen.getByRole('combobox', { name: '频道内容分类' }), { target: { value: 'daily' } });
  expect(screen.queryByText(old.text)).toBeNull(); expect(screen.getByText(/展开日报正文/)).toBeTruthy();
  fireEvent.change(screen.getByRole('combobox', { name: '频道内容分类' }), { target: { value: 'news' } });
  fireEvent.change(screen.getByRole('combobox', { name: '频道话题' }), { target: { value: 'feed:item-a' } });
  fireEvent.change(screen.getByRole('combobox', { name: '频道来源' }), { target: { value: 'source:b' } });
  expect(screen.getByText('另一来源')).toBeTruthy(); expect(screen.queryByText('原始资讯说明')).toBeNull();
  expect((screen.getByRole('combobox', { name: '局域网项目频道' }) as HTMLSelectElement).value).toBe('project:a');
  fireEvent.change(screen.getByRole('combobox', { name: '频道内容分类' }), { target: { value: 'unknown' } });
  expect(screen.getByText(old.text)).toBeTruthy(); expect(screen.queryByText('另一来源')).toBeNull();
  expect(screen.getByText(/未分类记录.*没有正式来源快照/)).toBeTruthy();
});
it.each([['unwired', '本机资讯来源未接入'], ['empty', '本机资讯来源已知为空或关闭'], ['unknown', '本机资讯来源未知或失联'], ['ready', '本机资讯来源可读']])('本机来源范围 %s 不冒LAN全范围', async (newsState, label) => {
  render(view(clientOf(response([], { ...scope, news: newsState }))));
  expect(await screen.findByText(new RegExp(label))).toBeTruthy();
  expect(screen.getByText(/不代表整个局域网/)).toBeTruthy();
});
it('旧源缺scope仍保历史未分类记录，空消息不等于未接入来源', async () => {
  render(view(clientOf({ transport: 'lan', scope: 'known-paired-members', messages: [base] })));
  await screen.findByText(base.text);
  expect(screen.getByText(/本机来源入口状态未知/)).toBeTruthy();
  expect(screen.getByText(/未分类记录.*没有正式来源快照/)).toBeTruthy();
});
it.each([
  { ...base, category: 'news' },
  { ...news, source: { ...news.source, kind: 'project-report' } },
  { ...daily, source: { ...daily.source, period: undefined } },
  { ...news, refs: [{ kind: 'url', id: 'a', title: '坏格', url: 42 }] },
])('不完整/矛盾四字段不降为假普通消息', async (bad) => {
  render(view(clientOf(response([bad]))));
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(screen.queryByText(bad.text)).toBeNull();
  expect(screen.queryByText(/还没有消息/)).toBeNull();
});
it('同项目刷新失败保留来源和历史但标旧；切项目与换client不能借旧来源/消息', async () => {
  let offline = false;
  const client = createApiClient({ pairing: { token: 'test-only', host: '127.0.0.1', port: 10092, deviceId: 'f-test' }, onUnauthorized() {}, fetchImpl: async input => offline || String(input).includes('project%3Ab') ? new Response(JSON.stringify({ error: 'controlled-offline' }), { status: 503 }) : new Response(JSON.stringify(response([news]))) });
  const ui = render(view(client)); await screen.findByText('原始资讯说明');
  offline = true; ui.rerender(view(client, 2)); await screen.findByText('controlled-offline');
  expect(screen.getByText('原始资讯说明')).toBeTruthy(); expect(screen.getByText(/上次读到的.*来源/)).toBeTruthy();
  await act(async () => { fireEvent.change(screen.getByRole('combobox', { name: '局域网项目频道' }), { target: { value: 'project:b' } }); });
  expect(screen.queryByText('原始资讯说明')).toBeNull(); expect(screen.queryByText(/本机资讯来源未接入/)).toBeNull();
  ui.rerender(view(clientOf(response([], { ...scope, news: 'unknown' })), 3));
  await screen.findByText(/本机资讯来源未知或失联/);
  expect(screen.queryByText('原始资讯说明')).toBeNull();
});
it('不安全原链接只读原文不执行脚本，引用回复与精确投递回执仍保留', async () => {
  const badLink = { ...news, source: { ...news.source, url: 'javascript:alert(1)', publisher: undefined, published_at: undefined }, refs: [{ kind: 'url', id: 'unsafe', title: '原链接不安全', url: 'javascript:alert(1)' }] };
  const reply = { ...base, id: 'm-reply', text: '执行回执原文', kind: 'report', reply_to: news.id, deliveries: [{ to: 'peer:a', status: 'accepted', at: NOW, receipt: { kind: 'done', text: '准确回执', at: NOW, message_id: 'm-reply', evidence: [] } }] };
  render(view(clientOf(response([badLink, reply]))));
  await screen.findByText('准确回执', { exact: false });
  expect(screen.getByText(/发表时间未知/)).toBeTruthy(); expect(screen.getByText(/发布者未知/)).toBeTruthy();
  expect(screen.queryByRole('link', { name: /原链接不安全/ })).toBeNull();
  expect(screen.getByText(/回应:原始资讯说明/)).toBeTruthy();
  const article = screen.getByText('执行回执原文').closest('article')!;
  expect(within(article).getByText(/准确回执/)).toBeTruthy();
});
it('刷新失败时旧空快照不能宣称当前没有消息，来源状态明确只是上次读到', async () => {
  let offline = false;
  const client = createApiClient({ pairing: { token: 'test-only', host: '127.0.0.1', port: 10092, deviceId: 'f-test' }, onUnauthorized() {}, fetchImpl: async () => offline ? new Response(JSON.stringify({ error: 'source-disconnected' }), { status: 503 }) : new Response(JSON.stringify(response([], { ...scope, news: 'ready' }))) });
  const ui = render(view(client)); await screen.findByText('这个项目的已知成员范围里还没有消息。');
  offline = true; ui.rerender(view(client, 2)); await screen.findByText('source-disconnected');
  expect(screen.queryByText('这个项目的已知成员范围里还没有消息。')).toBeNull();
  expect(screen.getByText(/上次读到的消息为空,当前情况未知/)).toBeTruthy();
  expect(screen.getByText(/上次来源入口快照.*当前状态未知/)).toBeTruthy();
});
it('成组来源里的可选period若坏也不能当可读来源', async () => {
  render(view(clientOf(response([{ ...news, source: { ...news.source, period: 42 } }]))));
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(screen.queryByText(news.text)).toBeNull();
});
it('较多事项引用可展开完整读取，默认不把长报告正文入口挤到引用清单后面', async () => {
  const refs = Array.from({ length: 4 }, (_, index) => ({ kind: 'task', id: `remote:${index}`, title: `远端事项${index}` }));
  render(view(clientOf(response([{ ...daily, refs }]))));
  const summary = await screen.findByText('查看 4 项来源引用');
  const details = summary.closest('details')!;
  expect(details.open).toBe(false);
  fireEvent.click(summary); expect(details.open).toBe(true);
  expect(within(details).getByText(/远端事项3.*remote:3/)).toBeTruthy();
  expect(screen.getByText(/事项引用属于发送成员 peer:a.*尚未接通跨机读取/)).toBeTruthy();
});

it('同显示名的配对成员不冒成本机，身份标签只认稳定member_id', async () => {
  const client = createApiClient({ pairing: { token: 'test-only', host: '127.0.0.1', port: 10092, deviceId: 'f-test' }, onUnauthorized() {}, fetchImpl: async input => new Response(JSON.stringify(String(input).includes('/identity') ? { identity: { member_id: 'self-id', name: '事务官', version: 1 } } : { members: [{ member_id: 'peer-id', name: '事务官', host: '127.0.0.1', port: 10095 }] })) });
  render(<ChannelPanel client={client} studio={{ studio: { state: 'none' }, loading: false, error: undefined, retry() {} }} tick={undefined} now={NOW} projects={[]} refreshToken={1} />);
  const region = screen.getByRole('region', { name: '局域网身份与成员' });
  await within(region).findByText(/peer-id/);
  expect(within(region).queryByText('本机', { selector: '.ba-collab__factk' })).toBeNull();
  expect(within(region).getByText('成员', { selector: '.ba-collab__factk' })).toBeTruthy();
});
