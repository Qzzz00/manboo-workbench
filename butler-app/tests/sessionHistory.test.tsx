/**
 * 手机「最近的对话」接 `GET /sessions/history`(2026-10-01;维护者:「每一个智能体只显示一个最近会话,
 * 像昨晚我主要是和你聊,起码三四个会话」)。
 *
 * ① 昨晚那几条 Claude 都列出来(关掉的也在),新的在前;② 在跑的留在「各家正在办」,这里不重复;事务官自己不列;
 * ③「再往前看」带游标翻下一页;④ 窗口型那几家如实写「只能看最新一句」;⑤ 电脑是旧版(没有这条路)时退回会话表那一份并说一句。
 *
 * 2026-10-03(卡「手机各家最近会话固定入口」;维护者:「给他一个固定的入口,固定显示每一家最近的十个会话,
 * 最好是按项目分好的」):这一页改成**按家、按项目分组**,每家 10 条、**在跑的也在**;
 * 电脑有这条路但不认 `per_family` 时退回那条平列表并说一句。
 */
import { describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { HistoryPage } from '../src/items/RecordPages';
import { HISTORY_ASKING_TEXT, HISTORY_FLAT_NOTE, HISTORY_NO_PROJECT, familyGroups, familyHistoryItems, historyCard, recentHistoryItems } from '../src/items/sessionHistory';
import { SessionContext, type Session } from '../src/session';
import { createApiClient } from '../src/api/client';
import { createVoiceApi } from '../src/api/voice';
import { createCallApi } from '../src/api/call';
import { createAppearanceFeed } from '../src/swarm/appearance';
import { SESSION_HISTORY_PER_FAMILY, emptyState, type SessionHistoryItem, type SessionHistoryView, type SessionView, type WorkbenchState } from '../src/api/protocol';
import type { FeedSnapshot, StateFeed } from '../src/api/stateFeed';
import { fakeChannel, fakeRouted } from './wbchFakes';
import { registryOf } from './registryFixture';

const NOW = '2026-10-01T09:00:00.000Z';
const ago = (hours: number) => new Date(Date.parse(NOW) - hours * 3_600_000).toISOString();

function item(id: string, hours: number, over: Partial<SessionHistoryItem> = {}): SessionHistoryItem {
  return { agent: 'claude', session_id: id, title: `对话 ${id}`, last_at: ago(hours), last_line: { who: 'ai', text: `${id} 说完了` }, ...over };
}

function running(id: string): SessionView {
  return { agent: 'claude', session_id: id, project: 'p', status: 'running', title: `对话 ${id}`, elapsed_sec: 60, unread: false, updated_at: NOW };
}

function state(sessions: SessionView[] = []): WorkbenchState {
  return { ...emptyState(), stale: false, now: NOW, sessions, agent_registry: registryOf(sessions, ['claude', 'codex']) } as WorkbenchState;
}

describe('列表里留哪些、卡面怎么写', () => {
  it('★在跑的不重复(在「各家正在办」里),事务官自己不列,同一条只留一次', () => {
    const s = state([running('live')]);
    const items = [item('live', 0), item('a', 1), item('a', 1), item('b', 2, { status: 'running' }), item('x', 3, { agent: 'dsh' }), item('c', 9)];
    expect(recentHistoryItems(items, s).map((one) => one.session_id)).toEqual(['a', 'c']);
  });

  it('卡面:标题、「Claude · 1 小时前」、最后一句;她说的那句带「你:」;在等她的标黄', () => {
    const s = state();
    expect(historyCard(item('a', 1), s)).toMatchObject({ title: '对话 a', label: 'Claude · 1 小时前', note: 'a 说完了', external: { agent: 'claude', sessionId: 'a' } });
    expect(historyCard(item('b', 2, { last_line: { who: 'you', text: '好的' }, status: 'waiting' }), s)).toMatchObject({ label: 'Claude · 在等你 · 2 小时前', note: '你:好的', dot: 'yellow' });
    expect(historyCard(item('c', 1, { title: undefined }), s).title).toBe('Claude 的一条会话');
  });

  it('窗口型那几家:如实写只能看最新一句', () => {
    const card = historyCard(item('window:doubao:1', 1, { agent: 'doubao', window_only: true, last_line: { who: 'ai', text: '写好了' } }), state());
    expect(card.note).toBe('写好了 · 只能看最新一句');
  });
});

function fakeFeed(value: WorkbenchState): StateFeed {
  const snapshot: FeedSnapshot = { state: value, connected: true, error: undefined };
  return { get: () => snapshot, subscribe: () => () => {}, async refresh() {}, stop() {} };
}

/** @param hold 给了就等它 resolve 之后才回(用来看「还没问到」那一瞬间说的是哪一句)。 */
function mount(value: WorkbenchState, answer: (path: string) => { status: number; body: unknown }, hold?: Promise<void>) {
  const gets: string[] = [];
  const pairing = { token: 't', host: 'h', port: 8791, deviceId: 'd' };
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const path = url.slice(url.indexOf('/', 'http://'.length));
    if ((init?.method ?? 'GET') === 'GET') gets.push(path);
    if (hold !== undefined) await hold;
    const got = answer(path);
    return new Response(JSON.stringify(got.body), { status: got.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const client = createApiClient({ pairing, fetchImpl, onUnauthorized: () => {} });
  const ctx: Session = {
    pairing,
    client: fakeRouted(client, 'direct'),
    direct: client,
    feed: fakeFeed(value),
    voice: createVoiceApi(client),
    call: createCallApi(client),
    channel: fakeChannel({}),
    appearance: createAppearanceFeed(client),
    settings: { async load() { throw new Error('用不到'); }, async update() { throw new Error('用不到'); } },
    async unpair() {},
  };
  render(<SessionContext.Provider value={ctx}><HistoryPage /></SessionContext.Provider>);
  return { gets };
}

const PAGE1: SessionHistoryView = { items: [item('s1', 1), item('s2', 8), item('s3', 9)], next: 'c1', days: 7, read_at: NOW };
const PAGE2: SessionHistoryView = { items: [item('s4', 10), item('s5', 30)], days: 7, read_at: NOW };

describe('「各家对话」页(10-01 从事项页搬出来)', () => {
  it('★昨晚那几条都在;「再往前看」带游标翻下一页,翻到底就不再摆那颗键', async () => {
    const { gets } = mount(state(), (path) => path === '/sessions/history?limit=10&before=c1' ? { status: 200, body: PAGE2 } : path.startsWith('/sessions/history') ? { status: 200, body: PAGE1 } : { status: 404, body: { error: '没这条路' } });
    const section = await screen.findByRole('region', { name: '各家最近的对话' });
    await waitFor(() => expect(within(section).getAllByRole('button').filter((b) => b.textContent?.includes('对话 s'))).toHaveLength(3));
    expect(within(section).getByText('最近的对话 3+')).toBeTruthy();
    await act(async () => { fireEvent.click(within(section).getByRole('button', { name: '再往前看' })); });
    await waitFor(() => expect(within(section).getByText('对话 s5')).toBeTruthy());
    expect(gets).toContain('/sessions/history?limit=10&before=c1');
    expect(within(section).queryByRole('button', { name: '再往前看' })).toBeNull();
  });

  it('电脑是旧版(没有这条路):退回会话表里停着的那几条,并说一句', async () => {
    const done = { ...running('old-1'), status: 'done' as const };
    mount(state([done]), () => ({ status: 404, body: { error: '没这条路' } }));
    const section = await screen.findByRole('region', { name: '各家最近的对话' });
    expect(within(section).getByText('对话 old-1')).toBeTruthy();
    expect(within(section).getByText(/旧版/)).toBeTruthy();
  });
});

/* ──────── 2026-10-03,卡「手机各家最近会话固定入口」 ──────── */

describe('固定入口那一份:留哪些、怎么分组', () => {
  it('★在跑的也留着(一条对话跑起来 / 停下来都不许从这里消失);事务官自己不列;同一条只留一次', () => {
    const s = state([running('live')]);
    const items = [item('live', 0, { status: 'running' }), item('a', 1), item('a', 1), item('x', 3, { agent: 'dsh' }), item('c', 9)];
    expect(familyHistoryItems(items, s).map((one) => one.session_id)).toEqual(['live', 'a', 'c']);
    // 原来那份(平列表那条退路)口径没动:在跑的让给「各家正在办」。
    expect(recentHistoryItems(items, s).map((one) => one.session_id)).toEqual(['a', 'c']);
  });

  it('★按家分组 → 组头是家名 + 条数;家底下按项目分;没有项目的归「未分项目」', () => {
    const s = state();
    const groups = familyGroups([
      item('c1', 1, { project: '工作台' }),
      item('k1', 2, { agent: 'codex', project: '参赛网页' }),
      item('c2', 3, { project: '工作台' }),
      item('c3', 4),
      item('k2', 5, { agent: 'codex', project: '参赛网页' }),
    ], s);
    expect(groups.map((one) => [one.agent, one.name, one.count])).toEqual([['claude', 'Claude', 3], ['codex', 'Codex', 2]]);
    expect(groups[0]!.projects.map((p) => [p.project, p.cards.length])).toEqual([['工作台', 2], [HISTORY_NO_PROJECT, 1]]);
    expect(groups[1]!.projects.map((p) => p.project)).toEqual(['参赛网页']);
    // 卡片还是原来那一张(点下去进原来那张会话页)。
    expect(groups[0]!.projects[0]!.cards[0]!.external).toEqual({ agent: 'claude', sessionId: 'c1' });
  });

  it('家名问主人要:登记表里没有那一家就原样用家名,不另写一张表', () => {
    const groups = familyGroups([item('g1', 1, { agent: 'grok-bot' })], state());
    expect(groups.map((one) => one.name)).toEqual(['grok-bot']);
  });

  it('顺序照电脑给的那一份(它已经按最后动静排好):哪一家最近动过排前面,窗口型没时间的排后面', () => {
    const groups = familyGroups([
      item('k1', 1, { agent: 'codex' }),
      item('c1', 2),
      item('w1', 0, { agent: 'manus', window_only: true, last_at: undefined }),
    ], state());
    expect(groups.map((one) => one.agent)).toEqual(['codex', 'claude', 'manus']);
  });
});

const GROUPED: SessionHistoryView = {
  items: [
    item('g1', 1, { project: '工作台', status: 'running' }),
    item('g2', 2, { project: '工作台' }),
    item('g3', 3),
    item('x1', 4, { agent: 'codex', project: '参赛网页' }),
  ],
  days: 7,
  read_at: NOW,
  per_family: SESSION_HISTORY_PER_FAMILY,
};

describe('「各家最近的对话」页:按家、按项目分好(10-03)', () => {
  it('★按 per_family 要;一家一折叠组(家名 + 条数),项目各一小节;在跑的那条也在', async () => {
    const { gets } = mount(state([running('g1')]), (path) => (path.startsWith('/sessions/history') ? { status: 200, body: GROUPED } : { status: 404, body: { error: '没这条路' } }));
    const section = await screen.findByRole('region', { name: '各家最近的对话' });
    await waitFor(() => expect(within(section).getByRole('region', { name: 'Claude' })).toBeTruthy());
    expect(gets.some((one) => one === `/sessions/history?per_family=${SESSION_HISTORY_PER_FAMILY}`)).toBe(true);
    const claude = within(section).getByRole('region', { name: 'Claude' });
    expect(within(claude).getByRole('button', { expanded: true }).textContent).toContain('Claude');
    expect(within(claude).getByRole('button', { expanded: true }).textContent).toContain('3');
    // 项目那两小节:每一组一份列表,读屏名「Claude · <项目>」。
    expect(within(claude).getByRole('list', { name: 'Claude · 工作台' })).toBeTruthy();
    expect(within(claude).getByRole('list', { name: `Claude · ${HISTORY_NO_PROJECT}` })).toBeTruthy();
    // 在跑的那条(g1)照样在 —— 这正是维护者 10-03 说「找不到」的那一条。
    expect(within(claude).getByText('对话 g1')).toBeTruthy();
    expect(within(section).getByRole('region', { name: 'Codex' })).toBeTruthy();
    // 这一档不分页:不摆「再往前看」。
    expect(within(section).queryByRole('button', { name: '再往前看' })).toBeNull();
  });

  it('组头点一下收起这一家,再点一下摊开(默认摊开)', async () => {
    mount(state(), (path) => (path.startsWith('/sessions/history') ? { status: 200, body: GROUPED } : { status: 404, body: { error: '没这条路' } }));
    const claude = await screen.findByRole('region', { name: 'Claude' });
    const toggle = within(claude).getByRole('button', { expanded: true });
    await act(async () => { fireEvent.click(toggle); });
    expect(within(claude).queryByText('对话 g1')).toBeNull();
    expect(within(claude).getByRole('button', { expanded: false })).toBeTruthy();
    await act(async () => { fireEvent.click(within(claude).getByRole('button', { expanded: false })); });
    expect(within(claude).getByText('对话 g1')).toBeTruthy();
  });

  it('★还没问到第一份之前只说「正在读…」:不许先说一句关于她那台电脑的断言', async () => {
    let answer: (() => void) | undefined;
    const held = new Promise<void>((done) => { answer = done; });
    mount(state(), () => ({ status: 200, body: GROUPED }), held);
    const section = await screen.findByRole('region', { name: '各家最近的对话' });
    expect(within(section).getByText(HISTORY_ASKING_TEXT)).toBeTruthy();
    expect(section.textContent ?? '').not.toContain(HISTORY_FLAT_NOTE);
    await act(async () => { answer?.(); await held; });
    await waitFor(() => expect(within(section).getByRole('region', { name: 'Claude' })).toBeTruthy());
  });

  it('★电脑有这条路、但不认 per_family(老版):退回那条平列表并说一句,不空白', async () => {
    // 老工作台把未知参数当没看见,照旧回一页、回包里没有 `per_family`。
    mount(state(), (path) => (path.startsWith('/sessions/history') ? { status: 200, body: PAGE1 } : { status: 404, body: { error: '没这条路' } }));
    const section = await screen.findByRole('region', { name: '各家最近的对话' });
    await waitFor(() => expect(within(section).getByText('对话 s1')).toBeTruthy());
    expect(within(section).getByText(HISTORY_FLAT_NOTE)).toBeTruthy();
    expect(within(section).queryByRole('region', { name: 'Claude' })).toBeNull();
    // 平列表那一档照旧能往前翻。
    expect(within(section).getByRole('button', { name: '再往前看' })).toBeTruthy();
  });
});
