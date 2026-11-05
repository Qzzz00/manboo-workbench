/**
 * 点开一条对话看完整内容(2026-10-01,手机读对话卡 B;维护者:「往上就没了」)。
 *
 * ① 先给最新那几轮;「再往上看」(或滑到顶)带游标接着要更早的,一直到「这就是开头了」;
 * ② 文字不截断,AI 那句按 Markdown 显示(粗体、表格…);③ 工具那几步折成一行,点开看说明与文件名;
 * ④ 那条会话动了只刷新最新那一段(`from=` 最新一页的起点);⑤ 电脑是旧版(没有这条路)→ 退回原来那几轮摘要;
 * ⑥ 窗口型那一家不去要完整对话(没有记录文件),照旧说那一句。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { InboxPage } from '../src/items/InboxPage';
import { HistoryPage } from '../src/items/RecordPages';
import { SessionContext, type Session } from '../src/session';
import { createApiClient } from '../src/api/client';
import { createVoiceApi } from '../src/api/voice';
import { createCallApi } from '../src/api/call';
import { createAppearanceFeed } from '../src/swarm/appearance';
import { emptyState, type SessionDigestView, type SessionTranscriptView, type SessionView, type WorkbenchState } from '../src/api/protocol';
import type { FeedSnapshot, StateFeed } from '../src/api/stateFeed';
import { fakeChannel, fakeRouted } from './wbchFakes';
import { registryOf } from './registryFixture';
import { hmOf, pinPhoneClock, unpinPhoneClock } from './clockFixture';

const NOW = '2026-10-01T09:00:00.000Z';
const LONG = `开头。${'中间很长的一段话,'.repeat(30)}结尾。`;

function running(over: Partial<SessionView> = {}): SessionView {
  return { agent: 'claude', session_id: 'c1', project: 'p', status: 'running', title: '统筹交接', elapsed_sec: 60, unread: false, updated_at: NOW, ...over };
}

function state(sessions: SessionView[]): WorkbenchState {
  return { ...emptyState(), stale: false, now: NOW, sessions, agent_registry: registryOf(sessions, ['claude', 'codex']) } as WorkbenchState;
}

const DIGEST: SessionDigestView = { agent: 'claude', session_id: 'c1', title: '统筹交接', project: 'p', rounds: [{ ask: '摘要那一句', reply: '摘要回答' }], read_at: NOW };

const NEWEST: SessionTranscriptView = {
  agent: 'claude', session_id: 'c1', title: '统筹交接', before: '500', read_at: NOW,
  entries: [
    { k: 'ask', text: '第 3 句', at: '2026-10-01T08:00:00.000Z' },
    { k: 'steps', line: '做了 2 步:改了 1 个文件、跑了 1 次测试', steps: [{ line: '改文件', files: ['a.ts'] }, { line: '跑测试', detail: '跑一遍测试' }] },
    { k: 'reply', text: `**结论**:${LONG}\n\n| 项 | 状态 |\n|---|---|\n| A | 好 |`, final: true },
  ],
};
const OLDER: SessionTranscriptView = {
  agent: 'claude', session_id: 'c1', read_at: NOW,
  entries: [{ k: 'ask', text: '第 1 句' }, { k: 'reply', text: '回答 1' }],
};

function fakeFeed(value: WorkbenchState): StateFeed {
  let snapshot: FeedSnapshot = { state: value, connected: true, error: undefined };
  const listeners = new Set<() => void>();
  return {
    get: () => snapshot,
    subscribe: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn); },
    async refresh() {},
    stop() {},
    // 测试里换一份状态(那条会话动了)
    set(next: WorkbenchState) { snapshot = { ...snapshot, state: next }; listeners.forEach((fn) => fn()); },
  } as StateFeed & { set(next: WorkbenchState): void };
}

function mount(sessions: SessionView[], answer: (path: string) => { status: number; body: unknown }, page: 'inbox' | 'history' = 'inbox') {
  const gets: string[] = [];
  const pairing = { token: 't', host: 'h', port: 8791, deviceId: 'd' };
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const path = url.slice(url.indexOf('/', 'http://'.length));
    if ((init?.method ?? 'GET') === 'GET') gets.push(path);
    const got = answer(path);
    return new Response(JSON.stringify(got.body), { status: got.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const client = createApiClient({ pairing, fetchImpl, onUnauthorized: () => {} });
  const feed = fakeFeed(state(sessions)) as StateFeed & { set(next: WorkbenchState): void };
  const ctx: Session = {
    pairing,
    client: fakeRouted(client, 'direct'),
    direct: client,
    feed,
    voice: createVoiceApi(client),
    call: createCallApi(client),
    channel: fakeChannel({}),
    appearance: createAppearanceFeed(client),
    settings: { async load() { throw new Error('用不到'); }, async update() { throw new Error('用不到'); } },
    async unpair() {},
  };
  render(<SessionContext.Provider value={ctx}>{page === 'history' ? <HistoryPage /> : <InboxPage />}</SessionContext.Provider>);
  return { gets, feed };
}

const T = '/sessions/transcript?agent=claude&id=c1';

async function openRunning(): Promise<HTMLElement> {
  await act(async () => { fireEvent.click(within(screen.getByRole('region', { name: '各家正在办' })).getByRole('button')); });
  return await screen.findByRole('dialog', { name: '会话详情' });
}

afterEach(unpinPhoneClock);

/**
 * 每一句后面那个时刻(2026-10-02,卡 claude/phone-clock):这一份手上没有 `state`,
 * `now` 是会话详情传进来的 `/state.now` —— 写不写日期照电脑的钟判。
 * 这一条把**手机的钟钉在 12-25**:照手机的钟「你 · …」那一行就会带「10-01」。
 */
describe('每一句后面那个时刻:照 /state.now 判', () => {
  it('★手机的钟在 12-25 也不算数:与 /state.now 同一天的那一句只写时刻', async () => {
    pinPhoneClock();
    mount([running()], (path) => path.startsWith(T)
      ? { status: 200, body: NEWEST }
      : path.startsWith('/sessions/digest') ? { status: 200, body: DIGEST } : { status: 404, body: { error: '没这条路' } });
    const sheet = await openRunning();
    const list = await within(sheet).findByRole('list', { name: '完整对话' });
    await within(list).findByText('第 3 句');
    expect(list.querySelector('.ba-tx__who')?.textContent).toBe(`你 · ${hmOf('2026-10-01T08:00:00.000Z')}`);
  });
});

describe('完整对话', () => {
  it('★读取 1a 登记的 CLI transcript turns 并原样显示 ask/reply', async () => {
    const cli = running({ agent: 'kimi', session_id: 'session-1c-qa', title: 'CLI 派活会话' });
    const { gets } = mount([cli], (path) => path.startsWith('/sessions/transcript?agent=kimi&id=session-1c-qa')
      ? { status: 200, body: { agent: 'kimi', session_id: 'session-1c-qa', title: 'CLI 派活会话', read_at: NOW, turns: [{ k: 'ask', text: '续说原话' }, { k: 'reply', text: 'QA_1C_CONTINUATION_RECEIPT' }] } }
      : path.startsWith('/sessions/digest?agent=kimi&id=session-1c-qa')
        ? { status: 200, body: { agent: 'kimi', session_id: 'session-1c-qa', title: 'CLI 派活会话', rounds: [{ k: 'ask', text: '续说原话' }, { k: 'reply', text: 'QA_1C_CONTINUATION_RECEIPT' }], read_at: NOW } }
        : { status: 404, body: { error: '没这条路' } });
    await act(async () => { fireEvent.click(within(screen.getByRole('region', { name: '各家正在办' })).getByRole('button')); });
    const dialog = await screen.findByRole('dialog', { name: '会话详情' });
    const list = await within(dialog).findByRole('list', { name: '完整对话' });
    expect(await within(list).findByText('QA_1C_CONTINUATION_RECEIPT')).toBeTruthy();
    expect(gets).toContain('/sessions/transcript?agent=kimi&id=session-1c-qa&before=&from=');
  });

  it('digest rounds 的 CLI k/text 形状也显示原文', async () => {
    const cli = running({ agent: 'kimi', session_id: 'session-1c-digest', title: 'CLI 派活会话' });
    mount([cli], (path) => path.startsWith('/sessions/transcript?agent=kimi&id=session-1c-digest')
      ? { status: 404, body: { error: '没这条路' } }
      : path.startsWith('/sessions/digest?agent=kimi&id=session-1c-digest')
        ? { status: 200, body: { agent: 'kimi', session_id: 'session-1c-digest', title: 'CLI 派活会话', rounds: [{ k: 'reply', text: 'QA_1C_DIGEST_RECEIPT' }], read_at: NOW } }
        : { status: 404, body: { error: '没这条路' } });
    await act(async () => { fireEvent.click(within(screen.getByRole('region', { name: '各家正在办' })).getByRole('button')); });
    const dialog = await screen.findByRole('dialog', { name: '会话详情' });
    expect(await within(dialog).findByText('QA_1C_DIGEST_RECEIPT')).toBeTruthy();
  });

  it('★最新几轮先到;文字不截断、Markdown 按格式;「再往上看」接着要更早的,到开头就说「这就是开头了」', async () => {
    const { gets } = mount([running()], (path) => {
      if (path === `${T}&before=500&from=`) return { status: 200, body: OLDER };
      if (path.startsWith(T)) return { status: 200, body: NEWEST };
      if (path.startsWith('/sessions/digest')) return { status: 200, body: DIGEST };
      return { status: 404, body: { error: '没这条路' } };
    });
    const sheet = await openRunning();
    const list = await within(sheet).findByRole('list', { name: '完整对话' });
    await within(list).findByText('第 3 句');
    expect(list.textContent).toContain('结尾。');
    expect(list.querySelector('strong')?.textContent).toBe('结论');
    expect(list.querySelector('table')).not.toBeNull();
    expect(within(sheet).queryByText('摘要那一句')).toBeNull();
    await act(async () => { fireEvent.click(within(sheet).getByRole('button', { name: '再往上看' })); });
    await within(list).findByText('第 1 句');
    expect(gets).toContain(`${T}&before=500&from=`);
    expect([...list.querySelectorAll('li.ba-tx__item')].map((li) => li.className.replace('ba-tx__item ba-tx__item--', ''))).toEqual(['ask', 'reply', 'ask', 'steps', 'reply']);
    expect(within(sheet).getByText('这就是开头了')).toBeTruthy();
  });

  it('工具那几步折成一行,点开看每步的说明与文件名', async () => {
    mount([running()], (path) => path.startsWith(T) ? { status: 200, body: NEWEST } : path.startsWith('/sessions/digest') ? { status: 200, body: DIGEST } : { status: 404, body: { error: '没这条路' } });
    const sheet = await openRunning();
    const line = await within(sheet).findByRole('button', { name: /做了 2 步/ });
    expect(within(sheet).queryByText('跑一遍测试')).toBeNull();
    await act(async () => { fireEvent.click(line); });
    expect(within(sheet).getByText('跑一遍测试')).toBeTruthy();
    expect(within(sheet).getByText('a.ts')).toBeTruthy();
  });

  it('★那条会话动了:只刷新最新那一段(from=最新一页的起点)', async () => {
    const { gets, feed } = mount([running()], (path) => {
      if (path === `${T}&before=&from=500`) return { status: 200, body: { ...NEWEST, entries: [...NEWEST.entries, { k: 'ask', text: '刚说的一句' }] } };
      if (path.startsWith(T)) return { status: 200, body: NEWEST };
      if (path.startsWith('/sessions/digest')) return { status: 200, body: DIGEST };
      return { status: 404, body: { error: '没这条路' } };
    });
    const sheet = await openRunning();
    await within(sheet).findByText('第 3 句');
    await act(async () => { feed.set(state([running({ updated_at: '2026-10-01T09:00:05.000Z' })])); });
    await waitFor(() => expect(gets).toContain(`${T}&before=&from=500`));
    expect(await within(sheet).findByText('刚说的一句')).toBeTruthy();
    expect(within(sheet).getAllByText('第 3 句')).toHaveLength(1);
  });

  it('电脑是旧版(没有这条路):退回原来那几轮摘要', async () => {
    mount([running()], (path) => path.startsWith('/sessions/digest') ? { status: 200, body: DIGEST } : { status: 404, body: { error: '没这条路' } });
    const sheet = await openRunning();
    expect(await within(sheet).findByText('摘要那一句')).toBeTruthy();
  });

  it('窗口型那一家:不去要完整对话,照旧说那一句', async () => {
    const win = running({ agent: 'claude', session_id: 'window:claude:1' });
    const { gets } = mount([win], (path) => path.startsWith('/sessions/digest') ? { status: 200, body: { ...DIGEST, session_id: 'window:claude:1', rounds: [], rounds_note: '只存了标题与最新一句' } } : { status: 404, body: { error: '没这条路' } });
    const sheet = await openRunning();
    expect(await within(sheet).findByText('只存了标题与最新一句')).toBeTruthy();
    expect(gets.some((path) => path.startsWith('/sessions/transcript'))).toBe(false);
  });
});

describe('关掉了的那条(只在记录文件里)', () => {
  it('完整对话照看;不写「在做:读不到」;输入框那一句说清是没开着,不说「记录读不到」', async () => {
    // 会话表里没有这条(关掉了),从「最近的对话」点进来
    mount([], (path) => {
      if (path.startsWith('/sessions/history')) return { status: 200, body: { items: [{ agent: 'claude', session_id: 'gone', title: '关掉的那条', last_at: NOW }], days: 7, read_at: NOW } };
      if (path.startsWith('/sessions/transcript?agent=claude&id=gone')) return { status: 200, body: { ...NEWEST, session_id: 'gone' } };
      return { status: 404, body: { error: '读不到这条会话的记录' } };
    }, 'history');
    const section = await screen.findByRole('region', { name: '各家最近的对话' });
    await act(async () => { fireEvent.click(await within(section).findByRole('button', { name: /关掉的那条/ })); });
    const sheet = await screen.findByRole('dialog', { name: '会话详情' });
    await within(sheet).findByText('第 3 句');
    expect(within(sheet).queryByText('在做')).toBeNull();
    expect(await within(sheet).findByText(/没在电脑上开着/)).toBeTruthy();
  });
});
