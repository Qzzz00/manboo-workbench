/**
 * 事项页四个标签 + 搬出去的三页 + 删测试单子(2026-10-01,维护者拍板:标签「在办 · 等你 · 排着 · 办完」;
 * 汇报单独一页;测试单子删掉;各家对话、通话记录两页入口放记录面板)。梳理见 docs/梳理-1001-手机事项页.md。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { InboxPage } from '../src/items/InboxPage';
import { CallsPage, ReportsPage } from '../src/items/RecordPages';
import { TestTicketsSection } from '../src/settings/TestTicketsSection';
import { SessionContext, type Session } from '../src/session';
import { createApiClient } from '../src/api/client';
import { createVoiceApi } from '../src/api/voice';
import { createCallApi } from '../src/api/call';
import { createAppearanceFeed } from '../src/swarm/appearance';
import { emptyState, type TaskView, type WorkbenchState } from '../src/api/protocol';
import type { FeedSnapshot, StateFeed } from '../src/api/stateFeed';
import { fakeChannel, fakeRouted } from './wbchFakes';
import { dayHmOf, hmOf, pinPhoneClock, unpinPhoneClock } from './clockFixture';

const NOW = '2026-10-01T21:30:00+08:00';

function task(over: Partial<TaskView> & { id: string; title: string }): TaskView {
  return { status: 'todo', direction: 'mine', created_at: NOW, updated_at: NOW, ...over } as TaskView;
}

const STATE = {
  ...emptyState(),
  stale: false,
  now: NOW,
  sessions: [{ agent: 'claude', session_id: 's1', project: 'workbench', status: 'running', title: '手机横屏展示台', elapsed_sec: 300, unread: false, updated_at: NOW }],
  butler_inbox: {
    items: [
      { id: 'r1', kind: 'routine', title: '开工汇报', note: '上次 9月30日 记了 3 个项目的进展。今天先做哪件?', at: NOW },
      { id: 'c1', kind: 'confirm', title: '按清单真机走一遍', note: '要不要加' },
      { id: 'f1', kind: 'feed', title: '《FDE前沿部署工程师实战教程》', note: 'CSDN', url: 'https://x' },
    ],
  },
  tasks: {
    tasks: [
      task({ id: 'a', title: '打磨自媒体布局', status: 'doing', mover: { who: 'agent', line: 'Claude 在做' } }),
      task({ id: 'm', title: '参赛网页:下载地址', mover: { who: 'me', line: '你来' } }),
      task({ id: 'd', title: '定核心体验流程', status: 'done' }),
      task({ id: 'call1', title: '和事务官通了个电话(8 秒)', status: 'done', origin: 'call', updated_at: '2026-09-30T19:15:00+08:00' }),
      task({ id: 'call2', title: '和事务官通了个电话(2 分 6 秒)', status: 'done', origin: 'call', updated_at: '2026-09-28T19:25:00+08:00' }),
      task({ id: 't1', title: '[派活测试] 让 Kimi 用一句话回答:一周有几天?', status: 'canceled' }),
      task({ id: 't2', title: '【工作台自测】查一下国庆放几天', status: 'done' }),
    ],
  },
} as unknown as WorkbenchState;

function mount(node: ReactNode, opts: { deleteFails?: string } = {}) {
  const posts: { path: string; body: Record<string, unknown> }[] = [];
  const pairing = { token: 't', host: 'h', port: 8791, deviceId: 'd' };
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const path = url.slice(url.indexOf('/', 'http://'.length));
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
      posts.push({ path, body });
      if (path === '/task/delete' && body.id === opts.deleteFails) return new Response(JSON.stringify({ error: '没有这张卡' }), { status: 404 });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ error: '没这条路' }), { status: 404 });
  }) as typeof fetch;
  const client = createApiClient({ pairing, fetchImpl, onUnauthorized: () => {} });
  const snapshot: FeedSnapshot = { state: STATE, connected: true, error: undefined };
  const feed: StateFeed = { get: () => snapshot, subscribe: () => () => {}, async refresh() {}, stop() {} };
  const session: Session = {
    pairing, client: fakeRouted(client, 'direct'), direct: client, feed,
    voice: createVoiceApi(client), call: createCallApi(client), channel: fakeChannel({}),
    appearance: createAppearanceFeed(client),
    settings: { async load() { throw new Error('用不到'); }, async update() { throw new Error('用不到'); } },
    async unpair() {},
  };
  render(<SessionContext.Provider value={session}>{node}</SessionContext.Provider>);
  return { posts };
}

/** 手机自己的钟拨到哪一天都不该影响这一页(它该看电脑发来的 /state.now);每个用例收手时拨回来。 */
afterEach(unpinPhoneClock);

describe('★事项页:四个标签', () => {
  it('顶上一排四个标签带数,缺省停在「在办」;在办里是各家正在跑的 + AI 与事务官手上的', () => {
    mount(<InboxPage />);
    const tabs = within(screen.getByRole('tablist', { name: '事项分区' })).getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['在办 2', '等你 1', '排着 1', '办完 1']);
    expect(screen.getByRole('tab', { name: /在办/ }).getAttribute('aria-selected')).toBe('true');
    expect(within(screen.getByRole('region', { name: '各家正在办' })).getByText('手机横屏展示台')).toBeTruthy();
    expect(screen.getByText('打磨自媒体布局')).toBeTruthy();
    expect(screen.queryByText('参赛网页:下载地址')).toBeNull();
  });

  it('★资讯搜索结果、汇报、通话纪要、历史对话、测试单子:事项页哪个标签里都没有', async () => {
    mount(<InboxPage />);
    for (const label of ['在办', '等你', '排着', '办完']) {
      await act(async () => { fireEvent.click(screen.getByRole('tab', { name: new RegExp(label) })); });
      for (const gone of ['《FDE前沿部署工程师实战教程》', '开工汇报', '和事务官通了个电话(8 秒)', '[派活测试] 让 Kimi 用一句话回答:一周有几天?', '【工作台自测】查一下国庆放几天']) {
        expect(screen.queryByText(gone)).toBeNull();
      }
      expect(screen.queryByRole('region', { name: '各家最近的对话' })).toBeNull();
    }
  });

  /**
   * 「办完」那几行按天分组:用例给的是固定的 NOW,**手机的钟拨到哪一天都不许影响它** ——
   * 这一页该照电脑发来的 /state.now 分(2026-10-02 卡 fix/inbox-today:原来 doneByDay 拿的是
   * 手机的墙钟,于是 10-01 写的这个用例一过夜就红在「今天」上)。
   */
  it('点标签只换下面那一块:等你 = 要她拍板的;排着 = 你来的;办完按天分组', async () => {
    pinPhoneClock('2026-12-25T10:00:00+08:00');
    mount(<InboxPage />);
    await act(async () => { fireEvent.click(screen.getByRole('tab', { name: /等你/ })); });
    expect(screen.getByText('按清单真机走一遍')).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole('tab', { name: /排着/ })); });
    expect(screen.getByText('参赛网页:下载地址')).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole('tab', { name: /办完/ })); });
    expect(screen.getByText('定核心体验流程')).toBeTruthy();
    expect(screen.getByRole('heading', { name: '今天' })).toBeTruthy();
    /**
     * 抬头写「今天」,它底下那张卡上的时刻就**不许带日期**(2026-10-02,卡 claude/phone-clock):
     * 两处原来各看一个钟 —— 抬头看电脑的、时刻看手机的,手机钟歪了就一个说「今天」、
     * 一个写「10-01 21:30」。现在同一个钟,所以这里只会是「21:30」。
     */
    expect(document.querySelector('.ba-item__time')?.textContent).toBe(hmOf(NOW));
  });

  it('★「排着」那张的时刻同一个钟:/state.now 那一天只写时刻(手机的钟在 9-30 也不算数)', async () => {
    pinPhoneClock('2026-09-30T10:00:00+08:00');
    mount(<InboxPage />);
    await act(async () => { fireEvent.click(screen.getByRole('tab', { name: /排着/ })); });
    // 「排着」里那张的 updated_at 就是 NOW(= /state.now 那一天)→ 只写时刻。
    expect(document.querySelector('.ba-item__time')?.textContent).toBe(hmOf(NOW));
  });

  it('★首页哪张卡点进来就停在哪个标签', () => {
    mount(<InboxPage target={{ tab: 'queued' }} />);
    expect(screen.getByRole('tab', { name: /排着/ }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText('参赛网页:下载地址')).toBeTruthy();
  });
});

describe('汇报一页', () => {
  it('开工汇报整段原样,一条一张', () => {
    mount(<ReportsPage />);
    expect(screen.getByText('开工汇报')).toBeTruthy();
    expect(screen.getByText(/今天先做哪件/)).toBeTruthy();
    expect(screen.queryByText('按清单真机走一遍')).toBeNull();
  });

  /** 抬头那个时刻也照电脑的钟(2026-10-02,卡 claude/phone-clock):手机的钟在 12-25 也不算数。 */
  it('★抬头那个时刻照 /state.now 判是不是今天', () => {
    pinPhoneClock();
    mount(<ReportsPage />);
    expect(document.querySelector('.ba-report__at')?.textContent).toBe(` · ${hmOf(NOW)}`);
  });
});

/**
 * 通话记录那一页的每一行也走同一处 `formatClock`(2026-10-02,卡 claude/phone-clock):
 * 那两通是 9-30 / 9-28 打的,`/state.now` 在 10-01 → 两行都带日期,写的是**电脑那一天**算出来的。
 */
describe('通话记录一页:行上的时刻', () => {
  it('★不是今天的带日期,日子按 /state.now 算,不按手机的墙钟', async () => {
    // 手机的钟停在第一通那一天:照手机的钟第一行就会写成光秃秃的「19:15」。
    pinPhoneClock('2026-09-30T19:20:00+08:00');
    mount(<CallsPage />);
    const times = [...document.querySelectorAll('.ba-item__time')].map((el) => el.textContent);
    expect(times).toEqual([dayHmOf('2026-09-30T19:15:00+08:00'), dayHmOf('2026-09-28T19:25:00+08:00')]);
  });
});

describe('通话记录一页', () => {
  it('只有通话纪要,新的在前;首页「最近一次通话」带进来的那一通直接打开', async () => {
    mount(<CallsPage target={{ callId: 'call1' }} />);
    const list = screen.getByRole('list', { name: '通话记录' });
    expect(within(list).getAllByRole('button').map((b) => b.textContent?.includes('8 秒'))).toEqual([true, false]);
    expect(await screen.findByRole('dialog', { name: '事项详情' })).toBeTruthy();
  });
});

describe('设置 › 高级:删掉测试单子', () => {
  it('★说清有几条;按了先问一句,点「删掉」才一条条 POST /task/delete,删完回一句', async () => {
    const { posts } = mount(<TestTicketsSection />);
    expect(screen.getByText(/2 条/)).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '删掉测试单子' })); });
    expect(posts.filter((p) => p.path === '/task/delete')).toHaveLength(0);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '删掉' })); });
    await waitFor(() => expect(posts.filter((p) => p.path === '/task/delete').map((p) => p.body.id)).toEqual(['t1', 't2']));
    expect(await screen.findByRole('status')).toHaveProperty('textContent', '删掉了 2 条测试单子。');
  });

  it('有删不掉的照实说几条没删掉', async () => {
    mount(<TestTicketsSection />, { deleteFails: 't2' });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '删掉测试单子' })); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '删掉' })); });
    expect(await screen.findByText(/删掉了 1 条,1 条没删掉/)).toBeTruthy();
  });
});
