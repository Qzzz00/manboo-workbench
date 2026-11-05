/**
 * 手机事项详情上的「通过 / 取消这件」(2026-09-25,卡 fix/confirm-cancel)。
 *
 * 统筹 0.2.89 真机:一件带交付物、在「等你确认」里的测试题**取消不掉**(那一次走的是 `/task/update {status}`,
 * 那条路由不改状态却回了 ok);手机上本来也没有取消的口。现在详情里有一颗「取消这件」,
 * 走的是看板唯一改状态的那条 `POST /task/move`(房间白名单里有它),不删卡。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { InboxPage } from '../src/items/InboxPage';
import { SessionContext, type Session } from '../src/session';
import { createApiClient } from '../src/api/client';
import { createVoiceApi } from '../src/api/voice';
import { createCallApi } from '../src/api/call';
import { createAppearanceFeed } from '../src/swarm/appearance';
import { emptyState, type TaskView, type WorkbenchState } from '../src/api/protocol';
import type { FeedSnapshot, StateFeed } from '../src/api/stateFeed';
import { fakeChannel, fakeRouted } from './wbchFakes';
import { dayHmOf, hmOf, pinPhoneClock, unpinPhoneClock } from './clockFixture';

const CONFIRMED: TaskView = {
  id: 't-f27d6416',
  title: '[测试] 我的规矩有哪些?',
  status: 'confirm',
  direction: 'mine',
  origin: 'user',
  deliverables: [{ kind: 'reply', ref: '分四块:全局……' }],
  created_at: '2026-09-24T14:31:51Z',
  updated_at: '2026-09-24T14:59:00Z',
} as TaskView;

function fakeFeed(state: WorkbenchState): StateFeed {
  const snapshot: FeedSnapshot = { state, connected: true, error: undefined };
  return { get: () => snapshot, subscribe: () => () => {}, async refresh() {}, stop() {} };
}

function mount(task: TaskView, moveReply: Record<string, unknown> = { ok: true }, moveStatus = 200, extra: Partial<WorkbenchState> = {}) {
  const posts: { path: string; body: Record<string, unknown> }[] = [];
  const pairing = { token: 't', host: 'h', port: 8791, deviceId: 'd' };
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const path = url.slice(url.indexOf('/', 'http://'.length));
    if (init?.method === 'POST') posts.push({ path, body: JSON.parse(String(init.body ?? '{}')) as Record<string, unknown> });
    if (path === '/task/move') return new Response(JSON.stringify(moveReply), { status: moveStatus, headers: { 'content-type': 'application/json' } });
    if (path === '/questions/answer' || path === '/approvals/answer') return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ error: '没这条路' }), { status: 404 });
  }) as typeof fetch;
  const client = createApiClient({ pairing, fetchImpl, onUnauthorized: () => {} });
  const state: WorkbenchState = {
    ...emptyState(),
    tasks: { tasks: [task] },
    butler_inbox: { items: task.status === 'confirm' ? [{ id: `confirm:${task.id}`, kind: 'confirm', title: task.title, note: '1 件交付物', task_id: task.id }] : [] },
    ...extra,
  } as WorkbenchState;
  const session: Session = {
    pairing,
    client: fakeRouted(client, 'direct'),
    direct: client,
    feed: fakeFeed(state),
    voice: createVoiceApi(client),
    call: createCallApi(client),
    channel: fakeChannel({}),
    appearance: createAppearanceFeed(client),
    settings: { async load() { throw new Error('用不到'); }, async update() { throw new Error('用不到'); } },
    async unpair() {},
  };
  render(
    <SessionContext.Provider value={session}>
      <InboxPage target={{ taskId: task.id }} />
    </SessionContext.Provider>,
  );
  return { posts };
}

afterEach(unpinPhoneClock);

/**
 * 详情里「时间」那一格(2026-10-02,卡 claude/phone-clock):写不写日期照**电脑的钟**判
 * (`/state.now`),不看这台手机的墙钟。两条用例都把手机的钟钉在 12-25。
 */
describe('事项详情:「时间」那一格照 /state.now 判是不是今天', () => {
  const AT = CONFIRMED.updated_at;

  it('★/state.now 和它同一天 → 只写时刻', async () => {
    pinPhoneClock();
    mount(CONFIRMED, { ok: true }, 200, { now: '2026-09-24T15:30:00Z' } as Partial<WorkbenchState>);
    const sheet = await screen.findByRole('dialog', { name: '事项详情' });
    expect(within(sheet).getByText(hmOf(AT))).toBeTruthy();
  });

  it('★/state.now 已经是第二天 → 带「M-DD」(手机的钟还停在那一天也不算数)', async () => {
    // 手机的钟与这一件同一天:照手机的钟就会写成光秃秃的「22:59」,照 /state.now 才带日期。
    pinPhoneClock('2026-09-24T15:00:00Z');
    mount(CONFIRMED, { ok: true }, 200, { now: '2026-09-25T15:30:00Z' } as Partial<WorkbenchState>);
    const sheet = await screen.findByRole('dialog', { name: '事项详情' });
    expect(within(sheet).getByText(dayHmOf(AT))).toBeTruthy();
  });
});

describe('事项详情:通过 / 取消这件', () => {
  it('★等我确认、带交付物的那一件:有「通过」也有「取消这件」;点取消 = POST /task/move {status:canceled},回执说清卡还在、不会被挪回来', async () => {
    const { posts } = mount(CONFIRMED);
    const sheet = await screen.findByRole('dialog', { name: '事项详情' });
    expect(within(sheet).getByRole('button', { name: '通过' })).toBeTruthy();
    await act(async () => { fireEvent.click(within(sheet).getByRole('button', { name: '取消这件' })); });
    await waitFor(() => expect(posts.some((one) => one.path === '/task/move')).toBe(true));
    expect(posts.find((one) => one.path === '/task/move')?.body).toEqual({ id: 't-f27d6416', status: 'canceled' });
    expect((await within(sheet).findByRole('status')).textContent).toContain('取消了');
  });

  it('工作台拒绝(七态转换表不许)→ 原话摆出来,不说「取消了」', async () => {
    mount(CONFIRMED, { error: '「完成」不能直接去「取消」' }, 409);
    const sheet = await screen.findByRole('dialog', { name: '事项详情' });
    await act(async () => { fireEvent.click(within(sheet).getByRole('button', { name: '取消这件' })); });
    const receipt = await within(sheet).findByRole('status');
    expect(receipt.textContent).toContain('不能直接去「取消」');
    expect(receipt.textContent).not.toContain('取消了。');
  });

  it('已经完成 / 取消了的:不画「取消这件」(也不画「通过」)', async () => {
    mount({ ...CONFIRMED, status: 'canceled' } as TaskView);
    const sheet = await screen.findByRole('dialog', { name: '事项详情' });
    expect(within(sheet).queryByRole('button', { name: '取消这件' })).toBeNull();
    expect(within(sheet).queryByRole('button', { name: '通过' })).toBeNull();
  });
});

describe('事项详情:她停着等他时,那一问就在这里答(卡 M 补:同电脑「在工作台里看」那一张)', () => {
  const DOING: TaskView = { ...CONFIRMED, id: 't-ask', title: '修小头像', status: 'doing', deliverables: [] } as TaskView;
  const QUESTION = {
    id: 'q-1', session_id: 's', task_id: 't-ask', task_title: '修小头像', at: 'x',
    questions: [{ id: 'pick', header: '派活前对一遍', question: '都对就开工。', multi: false, options: [{ label: 'A', text: 'A' }, { label: 'B', text: 'B' }] }],
  };

  it('★选项、「我自己说」(与电脑同一句提示)、「回复」(没写字时是灰的)都在;点 B 就交', async () => {
    const { posts } = mount(DOING, { ok: true }, 200, { questions: [QUESTION] } as Partial<WorkbenchState>);
    const sheet = await screen.findByRole('dialog', { name: '事项详情' });
    const own = within(sheet).getByLabelText('我自己说') as HTMLInputElement;
    expect(own.placeholder).toBe('我自己说:不照上面几个,直接写一句');
    expect((within(sheet).getByRole('button', { name: '回复' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { fireEvent.click(within(sheet).getByRole('button', { name: 'B' })); });
    await waitFor(() => expect(posts.find((one) => one.path === '/questions/answer')?.body).toEqual({ id: 'q-1', answers: [{ id: 'pick', selected: ['B'] }] }));
  });

  it('「我自己说」写一句按「回复」:只交他那句', async () => {
    const { posts } = mount(DOING, { ok: true }, 200, { questions: [QUESTION] } as Partial<WorkbenchState>);
    const sheet = await screen.findByRole('dialog', { name: '事项详情' });
    await act(async () => { fireEvent.change(within(sheet).getByLabelText('我自己说'), { target: { value: '你自己修吧' } }); });
    await act(async () => { fireEvent.click(within(sheet).getByRole('button', { name: '回复' })); });
    await waitFor(() => expect(posts.find((one) => one.path === '/questions/answer')?.body).toEqual({ id: 'q-1', answers: [{ id: 'pick', selected: [], custom: '你自己修吧' }] }));
  });
});
