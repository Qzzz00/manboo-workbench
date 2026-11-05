/**
 * 一件事一份、进度靠证据(2026-09-25,卡 N)在手机上的那几块:
 *
 * - 事项 = 他交给事务官的 + 看板上写了负责人的(与工作台 `isTrackedItem` 同一条);按「现在该谁动」排;
 * - 首页「今天要做」加上现在该他动的(负责人是他),挂着「派给 X 开工?」那一问的不重复列;
 * - 详情里「现在到哪 · 依据 · 几点看的」,没看到进展时说一句(`POST /progress/said`);出处是人话、时刻是「昨天 20:17」;
 * - 证据里冒出来的下一步:「加上 / 不要」;
 * - 「XX 到哪了」当场答的那一句挂在交付物里,对话记录里当回复显示(不说「会话未开」)。
 */
import { describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { InboxPage } from '../src/items/InboxPage';
import { SessionContext, type Session } from '../src/session';
import { createApiClient } from '../src/api/client';
import { createVoiceApi } from '../src/api/voice';
import { createCallApi } from '../src/api/call';
import { createAppearanceFeed } from '../src/swarm/appearance';
import { PROGRESS_NONE_LINE, emptyState, isTrackedItem, type TaskView, type WorkbenchState } from '../src/api/protocol';
import type { FeedSnapshot, StateFeed } from '../src/api/stateFeed';
import { itemCard, moverGroups, trackedTasks } from '../src/items/itemsModel';
import { executingTasks, stageCards, todayTasks } from '../src/stage/stageCardsModel';
import { replyOf } from '../src/chat/chatModel';
import { fakeChannel, fakeRouted } from './wbchFakes';

const AT = '2026-09-25T02:00:00Z';

function task(over: Partial<TaskView>): TaskView {
  return { id: 't', title: '一件事', status: 'todo', created_at: AT, updated_at: AT, ...over } as TaskView;
}

const SITE = task({
  id: 'site', title: '参赛网页架构收尾', assignee: 'codex',
  progress: {
    line: '11 屏已做完,逐屏文案稿在等你审', state: 'found', checked_at: '2026-09-25T07:10:00Z', by: 'model', waiting_on: 'me',
    basis: [{ kind: 'session', source: 'Codex 里「制作参赛网页」那段对话', ref: '/Users/example/.codex/sessions/x/rollout-01a0ccd1.jsonl', at: '2026-09-24T12:17:00Z', quote: '11 屏按网页顺序排列' }],
  },
  mover: { who: 'butler', line: '排着,等派给 Codex', assignee: 'codex' },
});
const DOMAIN = task({
  id: 'domain', title: '注册域名', assignee: 'me', direction: 'mine', origin: 'user', due: '2026-09-28',
  progress: { line: PROGRESS_NONE_LINE, state: 'none', basis: [], checked_at: '2026-09-25T07:10:00Z', by: 'rules', read_sessions: true },
  mover: { who: 'me', line: '你来 · 截止 9/28', assignee: 'me' },
});
const COPY = task({ id: 'copy', title: '参赛文案', assignee: 'colleague', assignee_note: '9/29 回来写', mover: { who: 'others', line: '等同事 · 9/29 回来写', assignee: 'colleague' } });
const PLAIN = task({ id: 'plain', title: '随手记的一张' });
const SHOT = task({ id: 'shot', title: '换真截图', status: 'backlog', origin: 'evidence', assignee: 'codex' });

function stateOf(tasks: TaskView[], extra: Partial<WorkbenchState> = {}): WorkbenchState {
  return { ...emptyState(), stale: false, now: '2026-09-25T15:00:00+08:00', tasks: { tasks }, ...extra } as WorkbenchState;
}

describe('事项:一件事一份', () => {
  it('看板上写了负责人的卡也是事项;没写负责人的看板卡不是;选题卡只按 mine 算', () => {
    expect(trackedTasks(stateOf([SITE, DOMAIN, COPY, PLAIN])).map((one) => one.id)).toEqual(['site', 'domain', 'copy']);
    expect(isTrackedItem({ kind: 'topic', assignee: 'codex' })).toBe(false);
  });

  it('按「现在该谁动」排:你来 / AI 与事务官 / 等别人;证据里冒出来的待排卡不在这里(在「等你确认」)', () => {
    const groups = moverGroups(stateOf([SITE, DOMAIN, COPY, SHOT]));
    expect(groups.me.map((one) => one.id)).toEqual(['domain']);
    expect(groups.agents.map((one) => one.id)).toEqual(['site']);
    expect(groups.others.map((one) => one.id)).toEqual(['copy']);
  });

  it('看板上那种事项卡上写「现在该谁动」,不写「会话未开」', () => {
    expect(itemCard(COPY).note).toBe('等同事 · 9/29 回来写');
    expect(itemCard(SITE).note).toBe('排着,等派给 Codex');
  });
});

describe('首页', () => {
  it('「今天要做」:负责人是他的排前面;排着等派的 AI 卡、挂着「派给 X 开工?」那一问的不列', () => {
    const asking = task({ id: 'ask', title: '打磨自媒体布局', assignee: 'claude', mover: { who: 'me', line: '等你点头派给 Claude', assignee: 'claude' } });
    const oldMine = task({ id: 'old', title: '订机票', direction: 'mine', origin: 'user' });
    const s = stateOf([SITE, DOMAIN, COPY, asking, oldMine], {
      approvals: [{ id: 'a1', session_id: 'dispatch:ask', tool: '派给 Claude', at: AT }],
    });
    expect(todayTasks(s).map((one) => one.id)).toEqual(['domain', 'old']);
    const today = stageCards(s).find((card) => card.id === 'today');
    expect(today?.lines[0]).toEqual({ id: 'domain', text: '注册域名', note: '9/28' });
  });

  it('看板上派出去、正在那家跑着的卡算「正在办」', () => {
    const running = task({ id: 'site', title: '参赛网页架构收尾', status: 'doing', assignee: 'codex', links: [{ agent: 'codex', session_id: 'c-1' }] });
    const s = stateOf([running], { sessions: [{ agent: 'codex', session_id: 'c-1', project: '', status: 'running', elapsed_sec: 60, unread: false, updated_at: AT }] });
    expect(executingTasks(s).map((one) => one.id)).toEqual(['site']);
    expect(stageCards(s).find((card) => card.id === 'doing')?.lines.map((line) => line.id)).toEqual(['site']);
  });

  it('「XX 到哪了」当场答的那一句(挂在交付物里)在对话记录里是回复,不是「会话未开」', () => {
    const asked = task({ id: 'q', title: '参赛网页到哪了?', status: 'done', direction: 'mine', origin: 'user', deliverables: [{ kind: 'reply', ref: '「参赛网页架构收尾」:11 屏已做完,逐屏文案稿在等你审(依据:Codex 里「制作参赛网页」那段对话 · 9月24日 20:17)' }] });
    expect(replyOf(stateOf([asked]), asked)).toEqual({ kind: 'reply', text: '「参赛网页架构收尾」:11 屏已做完,逐屏文案稿在等你审(依据:Codex 里「制作参赛网页」那段对话 · 9月24日 20:17)', speak: true });
  });
});

function fakeFeed(state: WorkbenchState): StateFeed {
  const snapshot: FeedSnapshot = { state, connected: true, error: undefined };
  return { get: () => snapshot, subscribe: () => () => {}, async refresh() {}, stop() {} };
}

function mount(tasks: TaskView[], openId: string, extra: Partial<WorkbenchState> = {}) {
  const posts: { path: string; body: Record<string, unknown> }[] = [];
  const pairing = { token: 't', host: 'h', port: 8791, deviceId: 'd' };
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const path = url.slice(url.indexOf('/', 'http://'.length));
    if (init?.method === 'POST') posts.push({ path, body: JSON.parse(String(init.body ?? '{}')) as Record<string, unknown> });
    if (path === '/task/move') return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (path === '/progress/said') return new Response(JSON.stringify({ ok: true, note: '记下了。这张再核了一次。' }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (path === '/progress/check') return new Response(JSON.stringify({ ok: true, by: 'model', cards: 1, spend_cny: 0.004, results: [], proposed: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (path === '/item/drive') return new Response(JSON.stringify({ ok: false, note: 'Claude 窗口上挂着对话框', error: 'Claude 窗口上挂着对话框' }), { status: 409, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ error: '没这条路' }), { status: 404 });
  }) as typeof fetch;
  const client = createApiClient({ pairing, fetchImpl, onUnauthorized: () => {} });
  const session: Session = {
    pairing,
    client: fakeRouted(client, 'direct'),
    direct: client,
    feed: fakeFeed(stateOf(tasks, extra)),
    voice: createVoiceApi(client),
    call: createCallApi(client),
    channel: fakeChannel({}),
    appearance: createAppearanceFeed(client),
    settings: { async load() { throw new Error('用不到'); }, async update() { throw new Error('用不到'); } },
    async unpair() {},
  };
  render(
    <SessionContext.Provider value={session}>
      <InboxPage target={{ taskId: openId }} />
    </SessionContext.Provider>,
  );
  return { posts };
}

describe('事项详情:现在到哪', () => {
  it('按证据说的进度、依据(出处 + 时刻 + 逐字那一句)、几点看的:出处是人话、时刻是「昨天 / 今天」;不露文件名、路径', async () => {
    mount([SITE], 'site');
    const sheet = await screen.findByRole('dialog', { name: '事项详情' });
    const block = within(sheet).getByLabelText('现在到哪');
    expect(block.textContent).toContain('现在该谁动:排着,等派给 Codex');
    expect(block.textContent).toContain('11 屏已做完,逐屏文案稿在等你审');
    expect(block.textContent).toMatch(/依据:Codex 里「制作参赛网页」那段对话 · 昨天 \d{2}:17 ·「11 屏按网页顺序排列」/);
    expect(block.textContent).toMatch(/今天 \d{2}:10 看的/);
    expect(block.textContent).not.toMatch(/rollout|jsonl|\/Users|按规则|证据/);
    expect(within(block).queryByRole('textbox')).toBeNull();
  });

  it('没看到进展:补一句我在哪儿找过;说一句 → POST /progress/said,回执原样摆出来', async () => {
    const { posts } = mount([DOMAIN], 'domain');
    const sheet = await screen.findByRole('dialog', { name: '事项详情' });
    expect(within(sheet).getByText('还没看到进展,要你说一句')).toBeTruthy();
    expect(within(sheet).getByText('项目文件夹、交出去的活、你跟各家 AI 的对话里,都没说到这件事做到哪了。')).toBeTruthy();
    fireEvent.change(within(sheet).getByRole('textbox', { name: '说一句到哪了' }), { target: { value: '域名昨天注册好了' } });
    await act(async () => { fireEvent.click(within(sheet).getByRole('button', { name: '记下' })); });
    await waitFor(() => expect(posts.some((one) => one.path === '/progress/said')).toBe(true));
    expect(posts.find((one) => one.path === '/progress/said')?.body).toEqual({ task_id: 'domain', text: '域名昨天注册好了' });
    expect(await within(sheet).findByText('记下了。这张再核了一次。')).toBeTruthy();
  });

  it('现在核一次 → POST /progress/check;派给 X 先摆出那一问(与电脑同一句),点「派」才发 /item/drive,没派成的原因原样摆出来', async () => {
    const { posts } = mount([SITE], 'site');
    const sheet = await screen.findByRole('dialog', { name: '事项详情' });
    const block = within(sheet).getByLabelText('现在到哪');
    await act(async () => { fireEvent.click(within(block).getByRole('button', { name: '现在核一次' })); });
    await waitFor(() => expect(posts.some((one) => one.path === '/progress/check')).toBe(true));
    expect(posts.find((one) => one.path === '/progress/check')?.body).toEqual({ task_id: 'site' });
    // 回执说人话(不说「按证据」「按规则」)。
    expect(await within(block).findByText('看过了。')).toBeTruthy();

    fireEvent.click(within(block).getByRole('button', { name: '派给 Codex' }));
    const confirm = within(block).getByRole('group', { name: '派活确认' });
    expect(confirm.textContent).toMatch(/^这张派给 Codex 开工\?现在:11 屏已做完,逐屏文案稿在等你审\(Codex 里「制作参赛网页」那段对话 · 昨天 \d{2}:17\)/);
    fireEvent.click(within(confirm).getByRole('button', { name: '先不派' }));
    expect(posts.some((one) => one.path === '/item/drive')).toBe(false);
    fireEvent.click(within(block).getByRole('button', { name: '派给 Codex' }));
    await act(async () => { fireEvent.click(within(within(block).getByRole('group', { name: '派活确认' })).getByRole('button', { name: '派' })); });
    await waitFor(() => expect(posts.some((one) => one.path === '/item/drive')).toBe(true));
    expect(posts.find((one) => one.path === '/item/drive')?.body).toEqual({ task_id: 'site' });
    expect(await within(block).findByText('Claude 窗口上挂着对话框')).toBeTruthy();
  });

  it('负责人是他 / 同事的卡没有「派给」', async () => {
    mount([DOMAIN], 'domain');
    const sheet = await screen.findByRole('dialog', { name: '事项详情' });
    expect(within(sheet).queryByRole('button', { name: /派给|交给事务官/ })).toBeNull();
    expect(within(sheet).getByRole('button', { name: '现在核一次' })).toBeTruthy();
  });

  it('证据里冒出来的下一步:「加上」挪进待办、「不要」改取消', async () => {
    const { posts } = mount([SHOT], 'shot', { butler_inbox: { items: [{ id: 'confirm:shot', kind: 'confirm', title: '要加上吗:换真截图', status: 'backlog', task_id: 'shot' }] } });
    const sheet = await screen.findByRole('dialog', { name: '事项详情' });
    expect(within(sheet).queryByRole('button', { name: '取消这件' })).toBeNull();
    await act(async () => { fireEvent.click(within(sheet).getByRole('button', { name: '加上' })); });
    await act(async () => { fireEvent.click(within(sheet).getByRole('button', { name: '不要' })); });
    await waitFor(() => expect(posts.filter((one) => one.path === '/task/move')).toHaveLength(2));
    expect(posts.filter((one) => one.path === '/task/move').map((one) => one.body)).toEqual([{ id: 'shot', status: 'todo' }, { id: 'shot', status: 'canceled' }]);
  });
});
