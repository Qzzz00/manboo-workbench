/**
 * 手机上每一处「家」的名字前都有它的 logo(2026-09-26,卡 LG3)。
 * 维护者原话:「每家的 logo-icon 要显示在手机客户端上,我发现你一边做一边漏」——
 * 所以这一份用例的活就是**一处一条,别漏**:
 *
 *   ① 首页「正在办」那几行 ② 首页「等你确认」里别家会话那一行 ③ 等你确认页的派活确认点
 *   ④ 等你确认页「X 在等你选」那张卡 ⑤ 事项页「各家正在办」的卡 ⑥ 事项详情「派给」那一格
 *   ⑦ 会话详情抬头 ⑧ 设置「各家能做什么」每一行
 *
 * 每一条都同时钉住那条退路:**登记表说这一家没有图(老工作台、没装、壳是旧版)时退回色点**,
 * 而且那时**一个请求都不发**。图里没有任何一家的 logo 文件 —— 字节是用例给的,产品代码里一张图都没有。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { StageCards } from '../src/stage/StageCards';
import { PhoneApprovalAsk, PhoneSessionAsk } from '../src/asks/AskCards';
import { AgentCapsSection } from '../src/settings/AgentCapsSection';
import { InboxPage } from '../src/items/InboxPage';
import { SessionContext, type Session } from '../src/session';
import { createApiClient } from '../src/api/client';
import { createVoiceApi } from '../src/api/voice';
import { createCallApi } from '../src/api/call';
import { createAppearanceFeed } from '../src/swarm/appearance';
import { bytesToBase64, createAgentIconStore, iconDataUrl, type AgentIconRow, type AgentIconStore } from '../src/agents/agentIcons';
import { emptyState, type AgentEntryView, type PendingApprovalView, type SessionView, type WorkbenchState } from '../src/api/protocol';
import type { FeedSnapshot, StateFeed } from '../src/api/stateFeed';
import { fakeChannel, fakeRouted } from './wbchFakes';

afterEach(cleanup);

/** 用例给的那几个字节(不是任何一家真的 logo)。 */
const BYTES = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]);
export const URL_OF = iconDataUrl(bytesToBase64(BYTES));

interface Fetched { manifest: number; png: string[] }

/** 一个真的 store(走真的清单 → 取图那条路),外加一本账看它发了几次请求。 */
function iconStore(rows: readonly AgentIconRow[]): { store: AgentIconStore; log: Fetched } {
  const log: Fetched = { manifest: 0, png: [] };
  const store = createAgentIconStore({
    async manifest() { log.manifest += 1; return { ok: true, rows }; },
    async png(id) { log.png.push(id); return { ok: true, bytes: BYTES }; },
  });
  return { store, log };
}

function entry(over: Partial<AgentEntryView> & { id: string; name: string }): AgentEntryView {
  return { status: 'idle', gaps: {}, sessions: [], counts: { running: 0, waiting: 0, unread: 0 }, ...over };
}

/** 登记表里两家:Claude 有图,Antigravity 没有(那一格 `icon` 是假的 —— 没装 / 渲不出 / 壳是旧版)。 */
const CLAUDE = entry({ id: 'claude', name: 'Claude', color: 'rgb(235, 113, 77)', icon: true });
const NOPIC = entry({ id: 'antigravity', name: 'Antigravity', color: 'rgb(90, 140, 220)', icon: false });

/** 用例里的一条会话。`agent` 是开集的(卡 P:按字符串处理),这里连 'antigravity' 这种也塞得进去。 */
function session(over: Omit<Partial<SessionView>, 'agent'> & { agent?: string } = {}): SessionView {
  return { agent: 'claude', session_id: 'cl-1', project: '工作台', status: 'running', title: '周报怎么写', elapsed_sec: 60, unread: false, updated_at: '2026-09-26T10:50:00Z', ...over } as SessionView;
}
/** 那一问(工作台写好的那一份;`since` / `by` 这一版必填)。 */
function ask(over: Partial<NonNullable<SessionView['ask']>> = {}): NonNullable<SessionView['ask']> {
  return { kind: 'choose', question: '要哪一种?', since: '2026-09-26T10:40:00Z', by: 'rules', reply: 'window', ...over } as NonNullable<SessionView['ask']>;
}

function state(over: Partial<WorkbenchState> = {}, entries: readonly AgentEntryView[] = [CLAUDE, NOPIC]): WorkbenchState {
  const sessions = over.sessions ?? [];
  return {
    ...emptyState(),
    stale: false,
    now: '2026-09-26T18:25:00+08:00',
    agent_registry: {
      entries: entries.map((one) => ({ ...one, sessions: sessions.filter((s) => s.agent === one.id).map((s) => ({ ...s, via: 'sessions' as const })) })),
      asking: [],
      notices: [],
    },
    ...over,
  } as WorkbenchState;
}

/** 那一处上画出来的是**图**(src 对、读屏不念它),还是退回的那颗色点。 */
function picsIn(root: HTMLElement): HTMLImageElement[] {
  return [...root.querySelectorAll<HTMLImageElement>('img.ba-agenticon__img')];
}
function dotsIn(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('.ba-agenticon__fallback')];
}

/** 一个只带 agentIcons 的假 Session(那几个只看图标的组件用不到别的)。 */
function iconOnlySession(store: AgentIconStore): Session {
  return { agentIcons: store } as unknown as Session;
}

async function mountWith(store: AgentIconStore, ui: React.ReactNode): Promise<HTMLElement> {
  const view = render(<SessionContext.Provider value={iconOnlySession(store)}>{ui}</SessionContext.Provider>);
  // 图是背后取回来的:等那一拍走完,界面重画一次(这就是「图标晚到就晚到」)。
  await act(async () => { await store.idle(); });
  return view.container;
}

describe('① 首页「正在办」那几行', () => {
  it('★某一家在跑的一条会话:那一行前面是它的 logo', async () => {
    const { store, log } = iconStore([{ id: 'claude', etag: '"a1"' }]);
    const s = state({ sessions: [session()] });
    const root = await mountWith(store, <StageCards state={s} />);
    const doing = root.querySelector<HTMLElement>('[data-card="doing"]');
    expect(doing).not.toBeNull();
    expect(picsIn(doing!).map((img) => img.getAttribute('src'))).toEqual([URL_OF]);
    // 图不参与读屏:名字就在旁边,念两遍是噪音
    expect(picsIn(doing!)[0]?.getAttribute('aria-hidden')).toBe('true');
    expect(picsIn(doing!)[0]?.getAttribute('alt')).toBe('');
    // 那一家的名字照旧在那一行里(图是加上去的,不是换掉字)
    expect(doing!.textContent).toContain('Claude');
    expect(log.png).toEqual(['claude']);
  });

  it('★登记表说这一家没有图:退回色点(它自己的颜色),而且一个请求都不发', async () => {
    const { store, log } = iconStore([{ id: 'claude', etag: '"a1"' }]);
    const s = state({ sessions: [session({ agent: 'antigravity', session_id: 'ag-1' })] });
    const root = await mountWith(store, <StageCards state={s} />);
    const doing = root.querySelector<HTMLElement>('[data-card="doing"]')!;
    expect(picsIn(doing)).toHaveLength(0);
    expect(dotsIn(doing)).toHaveLength(1);
    expect(dotsIn(doing)[0]?.getAttribute('style')).toContain('rgb(90, 140, 220)');
    expect(doing.textContent).toContain('Antigravity');
    expect(log.manifest).toBe(0);
    expect(log.png).toEqual([]);
  });

  it('一件事里两家一起在跑:那一行不画谁的图(画谁都是错的)', async () => {
    const { store } = iconStore([{ id: 'claude', etag: '"a1"' }]);
    const s = state({
      sessions: [session(), session({ agent: 'antigravity', session_id: 'ag-1' })],
      tasks: { tasks: [{
        id: 't-1', title: '两家一起办', status: 'doing', direction: 'mine', origin: 'user',
        created_at: '2026-09-26T09:00:00Z', updated_at: '2026-09-26T10:00:00Z',
        links: [{ agent: 'claude', session_id: 'cl-1' }, { agent: 'antigravity', session_id: 'ag-1' }],
      }] },
    } as unknown as Partial<WorkbenchState>);
    const root = await mountWith(store, <StageCards state={s} />);
    const line = root.querySelector<HTMLElement>('[data-card="doing"] .ba-cards__line')!;
    expect(line.textContent).toContain('两家一起办');
    expect(picsIn(line)).toHaveLength(0);
    expect(dotsIn(line)).toHaveLength(0);
  });
});

describe('② 首页「等你确认」里别家会话那一行', () => {
  it('★「Claude 在等你选…」那一行前面是它的 logo', async () => {
    const { store } = iconStore([{ id: 'claude', etag: '"a1"' }]);
    const s = state({
      sessions: [session({ status: 'waiting', ask: ask() })],
      waiting: { count: 1, items: [{ key: 'session:claude/cl-1', kind: 'session', verb: '答', text: 'Claude 在等你选:要哪一种?' }] },
    } as unknown as Partial<WorkbenchState>);
    const root = await mountWith(store, <StageCards state={s} />);
    const confirm = root.querySelector<HTMLElement>('[data-card="confirm"]')!;
    expect(confirm.textContent).toContain('Claude 在等你选');
    expect(picsIn(confirm).map((img) => img.getAttribute('src'))).toEqual([URL_OF]);
  });

  it('事务官问你的那一行没有图(那是她自己的事,不是某一家)', async () => {
    const { store, log } = iconStore([{ id: 'claude', etag: '"a1"' }]);
    const s = state({
      questions: [{ id: 'q1', questions: [{ id: 'i1', question: '先做哪一件?', options: [], multi: false }] }],
      waiting: { count: 1, items: [{ key: 'question:q1', kind: 'question', verb: '答', text: '先做哪一件?' }] },
    } as unknown as Partial<WorkbenchState>);
    const root = await mountWith(store, <StageCards state={s} />);
    const confirm = root.querySelector<HTMLElement>('[data-card="confirm"]')!;
    expect(picsIn(confirm)).toHaveLength(0);
    expect(dotsIn(confirm)).toHaveLength(0);
    expect(log.manifest).toBe(0);
  });
});

describe('③ 派活确认点上能派给的几家', () => {
  const approval: PendingApprovalView = {
    id: 'ap-1',
    tool: 'dispatch',
    say: '这件事派出去做',
    options: [
      { family: 'claude', title: 'Claude', quota: '本周还剩约 62%', state: 'numbers', chosen: true },
      { family: 'antigravity', title: 'Antigravity', quota: '没接上:Antigravity 没开', state: 'unconnected' },
    ],
  } as unknown as PendingApprovalView;

  /**
   * 2026-09-28(卡 UX):这一问默认**只摆这次问的那一家**(别家收起成一行,点「展开看额度」才一家一行)——
   * 所以「一家一行、各带 logo」现在分两次看:眼前那一家,与展开之后的别家。
   */
  it('★这次问的那一家带着自己的 logo;展开别家之后,没有图的那一家退回色点', async () => {
    const { store } = iconStore([{ id: 'claude', etag: '"a1"' }]);
    const root = await mountWith(store, (
      <PhoneApprovalAsk approval={approval} agents={state()} answer={async () => ({ ok: true })} />
    ));
    const chosen = [...root.querySelectorAll<HTMLElement>('[aria-label="这次问的那一家"] li')];
    expect(chosen).toHaveLength(1);
    expect(picsIn(chosen[0]!).map((img) => img.getAttribute('src'))).toEqual([URL_OF]);
    expect(chosen[0]!.textContent).toContain('本周还剩约 62%');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '展开看额度' })); });
    const others = [...root.querySelectorAll<HTMLElement>('[aria-label="能派给的几家"] li')];
    expect(others).toHaveLength(1);
    expect(picsIn(others[0]!)).toHaveLength(0);
    expect(dotsIn(others[0]!)).toHaveLength(1);
  });

  it('不给 agents(老调用方 / 老用例):一张图都没有,这张卡其余一个字不变', async () => {
    const { store, log } = iconStore([{ id: 'claude', etag: '"a1"' }]);
    const root = await mountWith(store, <PhoneApprovalAsk approval={approval} answer={async () => ({ ok: true })} />);
    expect(picsIn(root)).toHaveLength(0);
    expect(log.manifest).toBe(0);
    expect(root.textContent).toContain('本周还剩约 62%');
    // 「允许」那颗键上带着对象(卡 UX):批的是派给谁,一眼看得见。
    expect(screen.getByText('允许派给 Claude')).toBeTruthy();
  });
});

describe('④ 等你确认页「X 在等你选」那张卡', () => {
  it('★抬头那一句前面是那一家的 logo,那句话一个字不变', async () => {
    const { store } = iconStore([{ id: 'claude', etag: '"a1"' }]);
    const one = session({ status: 'waiting', ask: ask({ options: [{ label: '第一种' }] }) });
    const root = await mountWith(store, (
      <PhoneSessionAsk session={one} agents={state()} answer={async () => ({ ok: true })} />
    ));
    const head = root.querySelector<HTMLElement>('.ba-ask__head')!;
    expect(head.textContent).toContain('Claude 在等你选');
    expect(picsIn(head).map((img) => img.getAttribute('src'))).toEqual([URL_OF]);
  });
});

describe('⑧ 设置「各家能做什么」', () => {
  const caps = {
    line: '这台电脑上两家',
    agents: [
      { family: 'claude', title: 'Claude', cells: { chat: { state: 'ok' }, edit: { state: 'ok' }, collect: { state: 'ok' } }, line: '' },
      { family: 'antigravity', title: 'Antigravity', cells: { chat: { state: 'ok' }, edit: { state: 'na' }, collect: { state: 'ok' } }, line: '' },
    ],
  } as unknown as Parameters<typeof AgentCapsSection>[0]['caps'];

  it('★一家一行,名字前是它的 logo;额度那一句照旧', async () => {
    const { store } = iconStore([{ id: 'claude', etag: '"a1"' }]);
    const quotas = [{ id: 'claude', title: 'Claude', state: 'unlimited', line: '不限' }] as never;
    const root = await mountWith(store, <AgentCapsSection caps={caps} quotas={quotas} agents={state()} />);
    const rows = [...root.querySelectorAll<HTMLElement>('.ba-settings__line')].filter((row) => row.textContent?.includes('能聊天'));
    expect(rows).toHaveLength(2);
    expect(picsIn(rows[0]!).map((img) => img.getAttribute('src'))).toEqual([URL_OF]);
    expect(rows[0]!.textContent).toContain('额度不限');
    expect(picsIn(rows[1]!)).toHaveLength(0);
    expect(dotsIn(rows[1]!)).toHaveLength(1);
  });
});

/** 事项页那三处要一个能发请求的 Session(那一页自己会去读 /sessions/digest)。 */
function inboxSession(store: AgentIconStore, s: WorkbenchState): Session {
  const pairing = { token: 't', host: 'h', port: 8791, deviceId: 'd' };
  const fetchImpl = (async () => new Response(JSON.stringify({ error: '用例不接这条' }), { status: 404 })) as typeof fetch;
  const client = createApiClient({ pairing, fetchImpl, onUnauthorized: () => {} });
  const snapshot: FeedSnapshot = { state: s, connected: true, error: undefined };
  const feed: StateFeed = { get: () => snapshot, subscribe: () => () => {}, async refresh() {}, stop() {} };
  return {
    pairing,
    client: fakeRouted(client, 'direct'),
    direct: client,
    feed,
    voice: createVoiceApi(client),
    call: createCallApi(client),
    channel: fakeChannel({}),
    appearance: createAppearanceFeed(client),
    agentIcons: store,
    settings: { async load() { throw new Error('用不到'); }, async update() { throw new Error('用不到'); } },
    async unpair() {},
  } as unknown as Session;
}

describe('⑤⑥⑦ 事项页:各家正在办的卡、「派给」那一格、会话详情抬头', () => {
  it('★「各家正在办」那张卡上那一格就是它的 logo(状态点挪到图的右下角,语义没丢)', async () => {
    const { store } = iconStore([{ id: 'claude', etag: '"a1"' }]);
    const s = state({ sessions: [session()] });
    const view = render(
      <SessionContext.Provider value={inboxSession(store, s)}><InboxPage /></SessionContext.Provider>,
    );
    await act(async () => { await store.idle(); });
    const running = view.container.querySelector<HTMLElement>('[aria-label="各家正在办"]')!;
    expect(running.textContent).toContain('周报怎么写');
    expect(picsIn(running).map((img) => img.getAttribute('src'))).toEqual([URL_OF]);
    // 状态点还在 —— 只是挪到了图的右下角
    expect(running.querySelectorAll('.ba-agenticon__dot')).toHaveLength(1);
  });

  it('★「派给 X」那一格与会话详情抬头都有图;没有图的那一家退回色点', async () => {
    const { store } = iconStore([{ id: 'claude', etag: '"a1"' }]);
    const task = {
      id: 't-2', title: '写一版周报', status: 'doing', direction: 'mine', origin: 'user',
      created_at: '2026-09-26T09:00:00Z', updated_at: '2026-09-26T10:00:00Z',
      dispatch: { family: 'claude' },
    };
    const s = state({ tasks: { tasks: [task] } } as unknown as Partial<WorkbenchState>);
    const view = render(
      <SessionContext.Provider value={inboxSession(store, s)}><InboxPage target={{ taskId: 't-2' }} /></SessionContext.Provider>,
    );
    await act(async () => { await store.idle(); });
    const sheet = await screen.findByRole('dialog', { name: '事项详情' });
    const facts = sheet.querySelector<HTMLElement>('.ba-sheet__facts')!;
    expect(within(facts).getByText('派给')).toBeTruthy();
    expect(picsIn(facts).map((img) => img.getAttribute('src'))).toEqual([URL_OF]);
    view.unmount();
  });
});

describe('退回色点时,别把状态色吃掉(卡 Q 那两处例外)', () => {
  it('★登记表那一档的卡(黄点)没有图时还是黄点,不是这一家的颜色', async () => {
    const { store } = iconStore([]);
    const s = state({
      butler_inbox: { items: [{ id: 'agent:antigravity', kind: 'agent', title: '新接上一家:Antigravity', agent: { id: 'antigravity' } }] },
    } as unknown as Partial<WorkbenchState>);
    const view = render(
      <SessionContext.Provider value={inboxSession(store, s)}><InboxPage target={{ tab: 'waiting' }} /></SessionContext.Provider>,
    );
    await act(async () => { await store.idle(); });
    const dot = view.container.querySelector<HTMLElement>('.ba-agenticon__fallback');
    expect(dot).not.toBeNull();
    // 状态点照旧报状态(黄 = 要你看);没有被 Antigravity 那个蓝色盖掉
    expect(dot!.getAttribute('data-dot')).toBe('yellow');
    expect(dot!.getAttribute('style') ?? '').not.toContain('rgb(90, 140, 220)');
    view.unmount();
  });

  it('★「各家正在办」那张卡原来就涂这一家的颜色:照旧涂', async () => {
    const { store } = iconStore([]);
    const s = state({ sessions: [session({ agent: 'antigravity', session_id: 'ag-1' })] });
    const view = render(
      <SessionContext.Provider value={inboxSession(store, s)}><InboxPage /></SessionContext.Provider>,
    );
    await act(async () => { await store.idle(); });
    const running = view.container.querySelector<HTMLElement>('[aria-label="各家正在办"]')!;
    const dot = running.querySelector<HTMLElement>('.ba-agenticon__fallback')!;
    expect(dot.getAttribute('style')).toContain('rgb(90, 140, 220)');
    view.unmount();
  });
});
