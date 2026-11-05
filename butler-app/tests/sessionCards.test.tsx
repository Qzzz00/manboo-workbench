/**
 * 手机上「各家在跑的会话」写清是什么(2026-09-25,卡 P;维护者:「事务官中并没有显示会话的标题和内容」)。
 *
 * 与电脑事务官页同一口径:
 * - 标题 = 那家自己的标题(服务端读出来放在 /state.sessions[].title);读不到才「Codex 的一条会话」;
 * - 附注 = 「在做什么 · 几分钟前」,读不到写「读不到它在做什么」(不写占位话);
 * - 点开 = 在手机里看这条会话(`GET /sessions/digest`):标题、现在怎样、项目、在做什么、最近几轮 —— 不露会话 id。
 * - 哪一家按字符串认:名字表里没有的(以后自动发现的一家)用它自己的 id,不收窄成固定几家。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { InboxPage } from '../src/items/InboxPage';
import { externalSessionCard, sessionStatusText } from '../src/items/itemsModel';
import { agentTitle, stageCards } from '../src/stage/stageCardsModel';
import { SessionContext, type Session } from '../src/session';
import { createApiClient } from '../src/api/client';
import { createVoiceApi } from '../src/api/voice';
import { createCallApi } from '../src/api/call';
import { createAppearanceFeed } from '../src/swarm/appearance';
import { emptyState, sessionActivityLine, sessionDisplayTitle, type SessionDigestView, type SessionView, type WorkbenchState } from '../src/api/protocol';
import type { FeedSnapshot, StateFeed } from '../src/api/stateFeed';
import { fakeChannel, fakeRouted } from './wbchFakes';
import { registryOf } from './registryFixture';
import { hmOf, pinPhoneClock, unpinPhoneClock } from './clockFixture';

const NOW = '2026-09-25T08:20:00.000Z';

function session(over: Partial<SessionView> = {}): SessionView {
  return {
    agent: 'codex', session_id: 'cx-9f3a1c2b7e', project: 'desktop-workbench', status: 'running',
    title: '把截图不切窗做成机制', elapsed_sec: 14 * 60, unread: false, updated_at: NOW,
    activity: { line: '在跑测试', at: '2026-09-25T08:17:00.000Z' },
    ...over,
  };
}

function state(sessions: SessionView[]): WorkbenchState {
  // 服务端每一拍都带登记表(卡 Q):各家叫什么只从这里来。
  return { ...emptyState(), stale: false, now: NOW, sessions, agent_registry: registryOf(sessions, ['codex', 'claude']) } as WorkbenchState;
}
/** 只要名字那一格时用的登记表。 */
const REG = { agent_registry: registryOf([], ['codex', 'claude']) };

describe('卡面:标题与「在做什么」', () => {
  it('★事项页那一行:标题是那家自己的标题,附注是「在做什么 · 几分钟前」,状态「Codex · 进行中 · 14 分钟」', () => {
    const card = externalSessionCard(session(), NOW, agentTitle('codex', REG));
    expect(card.title).toBe('把截图不切窗做成机制');
    expect(card.note).toBe('在跑测试 · 3 分钟前');
    expect(card.label).toBe('Codex · 进行中 · 14 分钟');
    expect(card.external).toEqual({ agent: 'codex', sessionId: 'cx-9f3a1c2b7e' });
  });

  it('读不到在做什么 → 「读不到它在做什么」;读不到标题 → 「Codex 的一条会话」(不写占位话)', () => {
    const card = externalSessionCard(session({ title: undefined, activity: undefined }), NOW, agentTitle('codex', REG));
    expect(card.title).toBe('Codex 的一条会话');
    expect(card.note).toBe('读不到它在做什么');
    expect(sessionActivityLine({ line: '  ', at: NOW }, NOW)).toBe('读不到它在做什么');
  });

  it('首页「正在办」里那一行用同一个标题;没标题时同样是「Codex 的一条会话」', () => {
    const doing = stageCards(state([session(), session({ session_id: 'cx-2', title: '   ' })])).find((card) => card.id === 'doing')!;
    expect(doing.lines.map((line) => [line.text, line.note])).toEqual([
      ['把截图不切窗做成机制', 'Codex'],
      ['Codex 的一条会话', 'Codex'],
    ]);
  });

  it('哪一家按字符串认:名字从登记表来;登记表里没有的一家用它自己的 id(不收窄成固定几家)', () => {
    expect(agentTitle('claude', REG)).toBe('Claude');
    expect(agentTitle('claude')).toBe('claude');
    expect(agentTitle('muse')).toBe('muse');
    expect(sessionDisplayTitle({}, agentTitle('muse'))).toBe('muse 的一条会话');
    expect(sessionStatusText({ status: 'done', elapsed_sec: 0 }, agentTitle('muse'))).toBe('muse · 这一轮说完了');
  });
});

// ───────────── 点开一条会话 ─────────────

function fakeFeed(value: WorkbenchState): StateFeed {
  const snapshot: FeedSnapshot = { state: value, connected: true, error: undefined };
  return { get: () => snapshot, subscribe: () => () => {}, async refresh() {}, stop() {} };
}

function mount(sessions: SessionView[], digest: { status: number; body: unknown }) {
  const gets: string[] = [];
  const pairing = { token: 't', host: 'h', port: 8791, deviceId: 'd' };
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const path = url.slice(url.indexOf('/', 'http://'.length));
    if ((init?.method ?? 'GET') === 'GET') gets.push(path);
    if (path.startsWith('/sessions/digest')) return new Response(JSON.stringify(digest.body), { status: digest.status, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ error: '没这条路' }), { status: 404 });
  }) as typeof fetch;
  const client = createApiClient({ pairing, fetchImpl, onUnauthorized: () => {} });
  const value = state(sessions);
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
  const view = render(
    <SessionContext.Provider value={ctx}>
      <InboxPage />
    </SessionContext.Provider>,
  );
  return { gets, view };
}

const DIGEST: SessionDigestView = {
  agent: 'codex',
  session_id: 'cx-9f3a1c2b7e',
  title: '把截图不切窗做成机制',
  project: 'desktop-workbench',
  status: 'running',
  elapsed_sec: 14 * 60,
  activity: { line: '在跑测试', at: '2026-09-25T08:17:00.000Z' },
  rounds: [
    { ask: '企业微信截图不要把它叫出来', reply: '改好了,截图后页面保持不变。', did: '改了 3 个文件 · 跑了 2 次测试', at: '2026-09-25T08:10:00.000Z' },
  ],
  read_at: NOW,
};

afterEach(unpinPhoneClock);

/**
 * 「最近几轮」每一行末尾那个时刻(2026-10-02,卡 claude/phone-clock):同一处 `formatClock`,
 * 写不写日期照 `/state.now` 判。这一条把**手机的钟钉在 12-25** —— 照手机的钟这一行就会
 * 写成「9-25 16:10」,照电脑的钟才是光秃秃的时刻。
 */
describe('最近几轮:行末那个时刻照 /state.now 判', () => {
  it('★手机的钟在 12-25 也不算数:与 /state.now 同一天的那一轮只写时刻', async () => {
    pinPhoneClock();
    mount([session()], { status: 200, body: DIGEST });
    await act(async () => { fireEvent.click(within(screen.getByRole('region', { name: '各家正在办' })).getByRole('button')); });
    const sheet = await screen.findByRole('dialog', { name: '会话详情' });
    await within(sheet).findByText('企业微信截图不要把它叫出来');
    expect(sheet.querySelector('.ba-rounds__did')?.textContent)
      .toBe(`改了 3 个文件 · 跑了 2 次测试 · ${hmOf('2026-09-25T08:10:00.000Z')}`);
  });
});

describe('点开一条会话:在手机里看这条会话', () => {
  it('★事项页有「各家正在办」;点开读 /sessions/digest,摆出标题、现在怎样、项目、在做什么、最近几轮,不露会话 id', async () => {
    const { gets, view } = mount([session()], { status: 200, body: DIGEST });
    const section = screen.getByRole('region', { name: '各家正在办' });
    expect(within(section).getByText('把截图不切窗做成机制')).toBeTruthy();
    expect(within(section).getByText('在跑测试 · 3 分钟前')).toBeTruthy();

    await act(async () => { fireEvent.click(within(section).getByRole('button')); });
    const sheet = await screen.findByRole('dialog', { name: '会话详情' });
    await waitFor(() => expect(gets.some((path) => path === '/sessions/digest?agent=codex&id=cx-9f3a1c2b7e')).toBe(true));
    expect(await within(sheet).findByText('企业微信截图不要把它叫出来')).toBeTruthy();
    expect(within(sheet).getByText('改好了,截图后页面保持不变。')).toBeTruthy();
    expect(within(sheet).getByText(/改了 3 个文件 · 跑了 2 次测试/)).toBeTruthy();
    expect(within(sheet).getByText('Codex · 进行中 · 14 分钟')).toBeTruthy();
    expect(within(sheet).getByText('desktop-workbench')).toBeTruthy();
    expect(within(sheet).getByText('在跑测试 · 3 分钟前')).toBeTruthy();
    // 不露内部的东西
    expect(view.container.textContent).not.toContain('cx-9f3a1c2b7e');
  });

  it('读不到这条会话的记录(工作台回 404 + 一句人话)→ 原话摆出来,不拿占位话凑', async () => {
    mount([session()], { status: 404, body: { error: '读不到这条会话的记录(可能刚关掉)' } });
    await act(async () => { fireEvent.click(within(screen.getByRole('region', { name: '各家正在办' })).getByRole('button')); });
    const sheet = await screen.findByRole('dialog', { name: '会话详情' });
    expect((await within(sheet).findByText(/读不到这条会话的记录/)).textContent).toContain('可能刚关掉');
  });

  it('没有在跑的会话时不画「各家正在办」这一段', () => {
    mount([session({ status: 'done' })], { status: 200, body: DIGEST });
    expect(screen.queryByRole('region', { name: '各家正在办' })).toBeNull();
  });
});
