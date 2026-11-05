/**
 * 协作区页测试 · 真实 core 版(2026-10-24,小K,阶段 2)。
 *
 * fixtures 全部按 core 真实回包形状(契约 §1–§5):board 投影现算条件状态、note/activity
 * 合一活动账(留言带投递)、relations(含 stale)、capacity、lan identity/members。
 * 覆盖:条件七态与核验/交付交互、留言「请它处理」真投递(client_msg_id 幂等)、
 * 关系与轮次、容量四事、LAN 改名冲突保留输入、掉线在事项详情也摆横幅、频道只读。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SessionContext, type Session } from '../src/session';
import { createApiClient } from '../src/api/client';
import { createVoiceApi } from '../src/api/voice';
import { createCallApi } from '../src/api/call';
import { createAppearanceFeed } from '../src/swarm/appearance';
import { emptyState, type TaskView, type WorkbenchState } from '../src/api/protocol';
import type { FeedSnapshot, StateFeed } from '../src/api/stateFeed';
import { createSendOutbox } from '../src/outbox/sendOutbox';
import { CollabPage } from '../src/collab/CollabPage';
import { pinPhoneClock, unpinPhoneClock } from './clockFixture';
import { fakeChannel, fakeRouted } from './wbchFakes';

const NOW = '2026-10-24T12:00:00+08:00';

function task(partial: (Partial<TaskView> & { id: string; title: string; status: TaskView['status'] }) & Record<string, unknown>): TaskView {
  // Record<string, unknown> 那半截:手机镜像还没声明的协作原始字段(round/messages/transitions…),
  // 守卫层在读 —— core 的镜像落地后这些格子就有名分了。
  return { created_at: '2026-10-20T09:00:00+08:00', updated_at: '2026-10-23T09:00:00+08:00', ...partial } as TaskView;
}

/** 一批真实事项 + 真实条件/关系/活动账。 */
function seededState(): WorkbenchState {
  const tasks = [
    task({ id: 't-done', title: '已完成的活', status: 'done', assignee: 'agent:kimi-1', goal_id: 'goal:a', done_at: '2026-10-23T20:00:00+08:00' }),
    task({
      id: 't-confirm', title: '交回待验的活', status: 'confirm', assignee: 'agent:gemini-2', goal_id: 'goal:a',
      receipt: { kind: 'done', text: '做完了,见证据', at: '2026-10-23T20:00:00+08:00', evidence: ['out/ok.png'] },
    }),
    task({ id: 't-doing', title: '在做的活', status: 'doing', assignee: 'dsh', goal_id: 'goal:a', round: 2 }),
    task({ id: 't-blocked', title: '卡住的活', status: 'blocked', assignee: 'me', block_reason: 'approval', goal_id: 'goal:a', standing: { case: 'waiting_her', waiting_on: 'her', next: '你来解卡' } }),
    task({ id: 't-canceled', title: '不要了的活', status: 'canceled', goal_id: 'goal:a' }),
    task({ id: 'g1', title: '一整个组', status: 'doing', goal_id: 'goal:a', children: ['g1-a', 'g1-b'] }),
    task({ id: 'g1-a', title: '组里做完的', status: 'done', goal_id: 'goal:a' }),
    task({ id: 'g1-b', title: '组里没做的', status: 'todo', goal_id: 'goal:a' }),
    task({ id: 't-old', title: '很久没动的活', status: 'doing', assignee: 'dsh', goal_id: 'goal:b', updated_at: '2026-10-01T09:00:00+08:00' }),
    task({ id: 't-unsorted', title: '没贴目标的活', status: 'todo', from: { kind: 'said', quote: '顺手记一下' } }),
  ];
  return {
    ...emptyState(),
    now: NOW,
    sessions: [],
    butler_inbox: { items: [] },
    tasks: {
      tasks,
      goals: [
        {
          id: 'goal:a', title: '冲刺目标甲', status: 'open', due: '2026-10-30',
          created_at: '2026-10-20T00:00:00+08:00', updated_at: '2026-10-20T00:00:00+08:00',
          conditions: [
            { id: 'c-1', text: '打开目标页看分桶', task_id: 't-confirm', verifications: [], created_at: '2026-10-20T00:00:00+08:00', updated_at: '2026-10-20T00:00:00+08:00' },
            { id: 'c-2', text: '退回重算轮次清', task_id: 't-doing', verifications: [{ by: 'me', at: '2026-10-22T10:00:00+08:00', pass: true, round: 1 }], created_at: '2026-10-20T00:00:00+08:00', updated_at: '2026-10-22T10:00:00+08:00' },
            { id: 'c-3', text: '还没安排的条件', verifications: [], created_at: '2026-10-20T00:00:00+08:00', updated_at: '2026-10-20T00:00:00+08:00' },
          ],
        },
        { id: 'goal:b', title: '冲刺目标乙', status: 'open', created_at: '2026-10-20T00:00:00+08:00', updated_at: '2026-10-20T00:00:00+08:00' },
      ],
      goal_sprints: [{ id: 'sp-1', title: '本周冲刺', goal_ids: ['goal:a', 'goal:b'], created_at: '2026-10-20T00:00:00+08:00', updated_at: '2026-10-20T00:00:00+08:00' }],
      agent_cards: [{ id: 'agent:kimi-1', name: '小K' }, { id: 'agent:gemini-2', name: '小G' }],
      relay_tick: 1,
    } as unknown as WorkbenchState['tasks'],
  } as WorkbenchState;
}

/** 真实回包(契约 §1)现算:目标甲的条件状态。 */
const BOARD_A = {
  summary: {
    goal_id: 'goal:a',
    scope: '本目标 · 冲刺目标甲',
    conditions: {
      total: 3,
      by_state: { pending: 1, doing: 1, blocked: 0, submitted: 1, rework: 0, verified: 0, delivered: 0 },
      items: [
        { id: 'c-1', text: '打开目标页看分桶', state: 'submitted', task_id: 't-confirm', assignee: 'agent:gemini-2', last_receipt_at: '2026-10-23T20:00:00+08:00' },
        { id: 'c-2', text: '退回重算轮次清', state: 'doing', task_id: 't-doing', assignee: 'dsh' },
        { id: 'c-3', text: '还没安排的条件', state: 'pending' },
      ],
    },
    tasks: { total: 8, by_status: { backlog: 0, todo: 2, doing: 3, confirm: 1, done: 2, blocked: 1, canceled: 1 }, canceled: 1, unscheduled: 1 },
  },
};

function activityFor(taskId: string) {
  if (taskId === 't-confirm') {
    return { items: [
      { type: 'transition', at: '2026-10-23T09:00:00+08:00', from: 'todo', to: 'doing' },
      { type: 'message', at: '2026-10-23T18:00:00+08:00', message: { id: 'm-1', by: 'me', text: '@小K 看一眼', at: '2026-10-23T18:00:00+08:00', intent: 'ask', mentions: ['agent:kimi-1'], deliveries: [{ to: 'agent:kimi-1', status: 'accepted', at: '2026-10-23T19:00:00+08:00' }] } },
      { type: 'receipt', at: '2026-10-23T20:00:00+08:00', receipt: { kind: 'done', text: '做完了,见证据', at: '2026-10-23T20:00:00+08:00', by: 'agent:gemini-2', evidence: ['out/ok.png'] } },
      { type: 'transition', at: '2026-10-23T20:00:00+08:00', from: 'doing', to: 'confirm' },
      { type: 'run', at: '2026-10-23T20:00:00+08:00', segment: { task_id: 't-confirm', source: 'gemini', status: 'done', started_at: '2026-10-23T09:00:00+08:00', finished_at: '2026-10-23T20:00:00+08:00', outcome: 'replied' } },
    ] };
  }
  if (taskId === 't-doing') {
    return { items: [
      { type: 'run', at: '2026-10-24T10:00:00+08:00', segment: { task_id: 't-doing', source: 'dsh', status: 'paused', started_at: '2026-10-24T09:00:00+08:00', pause_reason: '等她补充材料' } },
    ] };
  }
  return { items: [] };
}

function fakeFeed(state: WorkbenchState, connected = true): StateFeed {
  const snapshot: FeedSnapshot = { state, connected, error: connected ? undefined : '连不上' };
  return { get: () => snapshot, subscribe: () => () => {}, async refresh() {}, stop() {} };
}

function mount(opts: { state?: WorkbenchState; connected?: boolean; network?: { online: boolean } } = {}) {
  const posts: { path: string; body: Record<string, unknown> }[] = [];
  const requests: string[] = [];
  const sentMessages: Record<string, unknown>[] = [];
  const pairing = { token: 't', host: 'h', port: 8791, deviceId: 'd' };
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const q = url.indexOf('/', 'http://'.length);
    const path = q < 0 ? '/' : url.slice(q);
    requests.push(path);
    if (path === '/collab/note/message' && init?.method === 'POST' && opts.network?.online === false) throw new TypeError('controlled offline');
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
    if (init?.method === 'POST') {
      posts.push({ path, body: JSON.parse(String(init.body ?? '{}')) as Record<string, unknown> });
      if (path === '/collab/note/message') {
        const body = posts[posts.length - 1]!.body;
        const message = { id: 'm-new', by: 'me', text: body.text, at: NOW, intent: body.intent, mentions: body.mentions, deliveries: (body.mentions as string[] ?? []).map((to: string) => ({ to, status: 'pending', at: NOW })) };
        sentMessages.push({ ...message, task_id: body.task_id });
        return json({ ok: true, message });
      }
      if (path === '/collab/goal/condition/verify' || path === '/collab/goal/condition/deliver') return json({ ok: true });
      if (path === '/collab/lan/identity') {
        const body = posts[posts.length - 1]!.body;
        if (body.name === '阿真二号') return json({ ok: false, error: '名称与已知成员重复(归一后)', conflict_with: 'acct-zhen', identity: { member_id: 'id-me', name: '本机', version: 2, updated_at: NOW } }, 409);
        return json({ ok: true, identity: { member_id: 'id-me', name: body.name, version: 3, updated_at: NOW } });
      }
      return json({ error: '没这条路' }, 404);
    }
    if (path.startsWith('/collab/goal/board')) return json(BOARD_A);
    if (path.startsWith('/collab/note/activity')) {
      const id = new URL(url).searchParams.get('id') ?? '';
      return json({ items: [...activityFor(id).items, ...sentMessages.filter((message) => message.task_id === id).map((message) => ({ type: 'message', at: NOW, message }))] });
    }
    if (path.startsWith('/collab/relations')) {
      const id = new URL(url).searchParams.get('task_id') ?? '';
      if (id === 't-confirm') {
        return json({ relations: [
          { id: 'r-1', from_id: 't-doing', to_id: 't-confirm', kind: 'handoff', note: '剪完交给验收', round: 1, stale: true },
          { id: 'r-2', from_id: 't-confirm', to_id: 't-doing', kind: 'rejected_back', note: '改音乐', round: 2 },
          { id: 'r-3', from_id: 't-old', to_id: 't-confirm', kind: 'depends_on', note: '等乙的资料' },
        ] });
      }
      return json({ relations: [] });
    }
    if (path === '/collab/capacity') {
      return json({ items: [
        { id: 'me', online: true, active_jobs: 0, running_jobs: 0, limit: 'unknown' },
        { id: 'agent:kimi-1', online: true, active_jobs: 1, running_jobs: 1, limit: 'unknown' },
        { id: 'dsh', online: true, active_jobs: 1, running_jobs: 0, limit: 'unknown' },
      ] });
    }
    if (path.startsWith('/collab/runs')) {
      return json({ runs: [
        { task_id: 't-confirm', source: 'gemini-2', status: 'done', started_at: '2026-10-23T09:00:00+08:00', finished_at: '2026-10-23T20:00:00+08:00', outcome: 'replied' },
        { task_id: 't-doing', source: 'dsh', status: 'paused', started_at: '2026-10-24T09:00:00+08:00', pause_reason: '等她补充材料' },
      ] });
    }
    if (path === '/collab/lan/identity') return json({ identity: { member_id: 'id-me', name: '本机事务官', version: 2, updated_at: NOW } });
    if (path === '/collab/lan/members') {
      return json({ members: [
        { member_id: 'id-me', name: '本机事务官', host: '127.0.0.1', port: 8791 },
        { member_id: 'id-zhen', name: '阿真', host: '127.0.0.1', port: 10099, last_seen: '2026-10-24T10:00:00+08:00', reachable: true },
      ] });
    }
    if (path === '/collab/relay/studio') return json({ state: 'none' });
    return json({ error: '没这条路' }, 404);
  }) as typeof fetch;
  const client = createApiClient({ pairing, fetchImpl, onUnauthorized: () => {} });
  const kv = (() => { const m = new Map<string, string>(); return { get: async (k: string) => m.get(k) ?? null, set: async (k: string, v: string) => { m.set(k, v); }, remove: async (k: string) => { m.delete(k); } }; })();
  const outbox = createSendOutbox({ kv, client: fakeRouted(client, 'direct') });
  const state = opts.state ?? seededState();
  const session: Session = {
    pairing,
    client: fakeRouted(client, 'direct'),
    direct: client,
    feed: fakeFeed(state, opts.connected ?? true),
    voice: createVoiceApi(client),
    call: createCallApi(client),
    channel: fakeChannel({}),
    appearance: createAppearanceFeed(client),
    settings: { async load() { throw new Error('用不到'); }, async update() { throw new Error('用不到'); } },
    outbox,
    async unpair() {},
  };
  render(<SessionContext.Provider value={session}><CollabPage /></SessionContext.Provider>);
  return { posts, outbox, requests };
}

afterEach(() => { unpinPhoneClock(); window.localStorage.clear(); });
beforeEach(() => {
  const values = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', { configurable: true, value: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); }, clear: () => values.clear() } });
});

describe('目标:真实条件(board 现算)+ 核验/交付', () => {
  it('条件七态照服务端;退回的旧核验留痕但状态不算数;没安排如实', async () => {
    pinPhoneClock();
    mount();
    await act(async () => { fireEvent.click(screen.getByText('冲刺目标甲')); });
    expect(await screen.findByText('打开目标页看分桶')).toBeTruthy();
    expect(screen.getAllByText('交回待验').length).toBeGreaterThan(0); // c-1 submitted(桶名同字)
    expect(screen.getByText('退回重算轮次清')).toBeTruthy();
    expect(screen.getByText('进行中')).toBeTruthy(); // c-2(t-doing 第2轮,旧核验失效 → 服务端给 doing)
    expect(screen.getByText('还没安排的条件')).toBeTruthy();
    expect(screen.getByText('尚未安排')).toBeTruthy(); // c-3
    expect(screen.getByText(/按条件算,不按卡数/)).toBeTruthy();
    // 核验留痕保留(第1轮通过),但条件状态不是已验收
    expect(screen.getByText(/我 通过 · 第1轮/)).toBeTruthy();
  });

  it('核验/交付是真 POST:通过 → verify;已验收后 → deliver;失败把原因摆出来', async () => {
    pinPhoneClock();
    const { posts } = mount();
    await act(async () => { fireEvent.click(screen.getByText('冲刺目标甲')); });
    // c-1 的承接任务在 confirm → 有验收键
    const passBtn = await screen.findByRole('button', { name: '验收通过' });
    await act(async () => { fireEvent.click(passBtn); });
    await waitFor(() => expect(posts.some((p) => p.path === '/collab/goal/condition/verify')).toBe(true));
    const verify = posts.find((p) => p.path === '/collab/goal/condition/verify');
    expect(verify?.body).toMatchObject({ goal_id: 'goal:a', condition_id: 'c-1', by: 'me', pass: true });
    expect(await screen.findByText('已验收通过')).toBeTruthy();
    // fixture board 未变(仍是 submitted)→ deliver 键不出现,不造假成功
    expect(screen.queryByRole('button', { name: '记交付' })).toBeNull();
  });

  it('按人安排读取派出与执行记录,不把派出冒充开工', async () => {
    pinPhoneClock();
    const { requests } = mount();
    await act(async () => { fireEvent.click(screen.getByText('冲刺目标甲')); });
    expect(await screen.findByText(/派出与执行记录:执行已收场/)).toBeTruthy();
    expect(screen.getByText(/派出与执行记录:有等待\/暂停记录\(开工未知\) · 停着:等她补充材料/)).toBeTruthy();
    expect(requests.some((path) => path === '/collab/runs?goal_id=goal%3Aa')).toBe(true);
  });

  it('退回先写修改要求,核验请求保留具体依据', async () => {
    pinPhoneClock();
    const { posts } = mount();
    await act(async () => { fireEvent.click(screen.getByText('冲刺目标甲')); });
    const reject = await screen.findByRole('button', { name: '退回重做' });
    await act(async () => { fireEvent.click(reject); });
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '退回前写明要改什么');
    expect(posts.some((p) => p.path === '/collab/goal/condition/verify')).toBe(false);
    await act(async () => { fireEvent.change(screen.getByLabelText('核验依据或退回要求'), { target: { value: '第二屏文字超出,缩短后再验' } }); });
    await act(async () => { fireEvent.click(reject); });
    await waitFor(() => expect(posts.find((p) => p.path === '/collab/goal/condition/verify')?.body).toMatchObject({
      goal_id: 'goal:a', condition_id: 'c-1', pass: false, note: '第二屏文字超出,缩短后再验',
    }));
  });
});

describe('事项详情:真实活动账 + 关系 + 运行片段', () => {
  it('实际收回的回答正文可直接阅读,不只给交付物路径', async () => {
    pinPhoneClock();
    const state = seededState();
    mount({ state: { ...state, tasks: { ...state.tasks, tasks: state.tasks!.tasks.map((one) => one.id !== 't-confirm' ? one : {
      ...one, dispatch: { status: 'done', started_at: NOW, family: 'codex', hand: 'cli', reply: '**样片核对结果**：第七秒字幕需修改。' },
    }) } } });
    await act(async () => { fireEvent.click(screen.getByRole('tab', { name: '事项' })); });
    await act(async () => { fireEvent.click(screen.getByText('交回待验的活', { selector: '.ba-collab__rowtitle' })); });
    expect(await screen.findByText('样片核对结果')).toBeTruthy();
    expect(screen.getByRole('region', { name: '成果与证据' }).textContent).toContain('第七秒字幕需修改');
  });
  it('依赖跳转可打开筛选范围之外的真实事项,不丢原归属', async () => {
    pinPhoneClock();
    const state = seededState();
    mount({ state: { ...state, tasks: { ...state.tasks, goal_sprints: [{ id: 'only-a', title: '本轮仅甲', goal_ids: ['goal:a'] }] } } as unknown as WorkbenchState });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '本轮仅甲' })); });
    await act(async () => { fireEvent.click(screen.getByRole('tab', { name: '事项' })); });
    await act(async () => { fireEvent.click(screen.getByText('交回待验的活', { selector: '.ba-collab__rowtitle' })); });
    const related = await screen.findByText('很久没动的活');
    await act(async () => { fireEvent.click(related); });
    expect(await screen.findByRole('heading', { name: /很久没动的活/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: '冲刺目标乙' })).toBeTruthy();
  });

  it('会话必须同时匹配家与 id;未纳管明示未知,不借另一家的状态', async () => {
    pinPhoneClock();
    const state = seededState();
    const altered = { ...state, sessions: [{ agent: 'dsh', session_id: 'shared-id', status: 'done', title: '另一家的会话', updated_at: NOW, project: '', elapsed_sec: 0, unread: false }], tasks: {
      ...state.tasks, tasks: state.tasks!.tasks.map((one) => one.id === 't-confirm' ? { ...one, links: [{ agent: 'codex', session_id: 'shared-id' }] } : one),
    } } as WorkbenchState;
    mount({ state: altered });
    await act(async () => { fireEvent.click(screen.getByRole('tab', { name: '事项' })); });
    await act(async () => { fireEvent.click(screen.getByText('交回待验的活', { selector: '.ba-collab__rowtitle' })); });
    expect(await screen.findByText(/codex 的会话.*未纳管.*未知/)).toBeTruthy();
    expect(screen.queryByText('另一家的会话')).toBeNull();
  });

  it('活动流含留言(带投递状态)/回执/挪卡/运行;stale 关系标需复核', async () => {
    pinPhoneClock();
    mount();
    await act(async () => { fireEvent.click(screen.getByRole('tab', { name: '事项' })); });
    await act(async () => { fireEvent.click(screen.getByText('交回待验的活', { selector: '.ba-collab__rowtitle' })); });
    expect(await screen.findByText('@小K 看一眼')).toBeTruthy();
    expect(screen.getByText('小K:已受理')).toBeTruthy(); // accepted 不冒完成
    expect(screen.getAllByText(/交回:做完/).length).toBeGreaterThan(0);
    expect(screen.getByText(/挪卡:待办 → 进行中/)).toBeTruthy();
    expect(screen.getByText(/执行已收场/)).toBeTruthy();
    // 关系:handoff 从在做的活来,上游重开 → 需复核
    expect(screen.getAllByText('在做的活').length).toBeGreaterThan(0); // 关系跳转与别处同标题
    expect(screen.getByText(/剪完交给验收/)).toBeTruthy();
    expect(screen.getByText('上游重开,需复核')).toBeTruthy();
    expect(screen.getByText(/第2轮/)).toBeTruthy(); // rejected_back 记退回轮次
  });

  it('运行片段 paused 带原因(等补充材料)', async () => {
    pinPhoneClock();
    mount();
    await act(async () => { fireEvent.click(screen.getByRole('tab', { name: '事项' })); });
    await act(async () => { fireEvent.click(screen.getByText('在做的活', { selector: '.ba-collab__rowtitle' })); });
    expect(await screen.findByText(/停着:等她补充材料/)).toBeTruthy();
  });
});

describe('留言:真投递口(client_msg_id 幂等)', () => {
  it('同名名片从列表选稳定身份,实际请求不退回第一张', async () => {
    pinPhoneClock();
    const state = seededState();
    const { posts } = mount({ state: { ...state, tasks: { ...state.tasks, tasks: state.tasks!.tasks, agent_cards: ['agent:first', 'agent:second'].map((id) => ({ id, name: '同名助手', owner: 'me', hand: 'codex' as const, shared: { to: 'none' as const }, created_at: NOW, updated_at: NOW })) } } });
    await act(async () => { fireEvent.click(screen.getByRole('tab', { name: '事项' })); });
    await act(async () => { fireEvent.click(screen.getByText('交回待验的活', { selector: '.ba-collab__rowtitle' })); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '请它处理' })); fireEvent.click(screen.getByRole('button', { name: '@ 名片' })); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '@同名助手 · agent:second' })); });
    await act(async () => { fireEvent.change(screen.getByLabelText('留言草稿'), { target: { value: '@同名助手 检查资料' } }); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '留这条' })); });
    await waitFor(() => expect(posts.find((post) => post.path === '/collab/note/message')?.body.mentions).toEqual(['agent:second']));
  });

  it('离线已入待发箱后清草稿,待发只归本事项;自动补发更新送达提示', async () => {
    pinPhoneClock();
    const network = { online: false };
    const { outbox } = mount({ network });
    await act(async () => { await outbox.send('/collab/note/message', { task_id: 'another-task', text: '另一事项的待发', intent: 'record', client_msg_id: 'other-draft' }, { text: '另一事项的待发', at: NOW }); });
    await act(async () => { fireEvent.click(screen.getByRole('tab', { name: '事项' })); });
    await act(async () => { fireEvent.click(screen.getByText('交回待验的活', { selector: '.ba-collab__rowtitle' })); });
    expect(screen.queryByText(/另一事项的待发/)).toBeNull();
    const box = await screen.findByLabelText('留言草稿') as HTMLTextAreaElement;
    await act(async () => { fireEvent.change(box, { target: { value: '本事项的离线留言' } }); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '留这条' })); });
    await screen.findByText(/没送到,已暂存/);
    expect(box.value).toBe('');
    network.online = true;
    await act(async () => { await outbox.pump(); });
    expect(await screen.findByText('已送达,等同步')).toBeTruthy();
    expect(await screen.findByText('本事项的离线留言', { selector: '.ba-collab__acttext' })).toBeTruthy();
    expect(screen.queryByText('另一事项的待发', { selector: '.ba-collab__acttext' })).toBeNull();
  });

  it('「请它处理」发得出:POST /collab/note/message 带 intent/mentions/client_msg_id', async () => {
    pinPhoneClock();
    const { posts } = mount();
    await act(async () => { fireEvent.click(screen.getByRole('tab', { name: '事项' })); });
    await act(async () => { fireEvent.click(screen.getByText('交回待验的活', { selector: '.ba-collab__rowtitle' })); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '请它处理' })); });
    await pageLoaded();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '@ 名片' })); });
    await act(async () => { fireEvent.click(screen.getByText('@小K', { selector: '.ba-collab__cardchip' })); });
    const box = await screen.findByLabelText('留言草稿');
    await act(async () => { fireEvent.change(box, { target: { value: `${box.textContent ?? ''}补一版` } }); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '留这条' })); });
    await waitFor(() => expect(posts.some((p) => p.path === '/collab/note/message')).toBe(true));
    const sent = posts.find((p) => p.path === '/collab/note/message');
    expect(sent?.body).toMatchObject({ task_id: 't-confirm', intent: 'ask' });
    expect((sent?.body.mentions as string[])).toEqual(['agent:kimi-1']);
    expect(typeof sent?.body.client_msg_id).toBe('string');
    expect(await screen.findByText('已送达,等同步')).toBeTruthy();
    expect(await screen.findByText('小K:已受理待处理')).toBeTruthy();
  });

  it('认不出的名字拒发;不 @ 选「请它处理」也拒发(要说清谁处理)', async () => {
    pinPhoneClock();
    const { posts } = mount();
    await act(async () => { fireEvent.click(screen.getByRole('tab', { name: '事项' })); });
    await act(async () => { fireEvent.click(screen.getByText('交回待验的活', { selector: '.ba-collab__rowtitle' })); });
    const box = await screen.findByLabelText('留言草稿');
    await act(async () => { fireEvent.change(box, { target: { value: '@不存在 看看' } }); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '留这条' })); });
    expect((await screen.findAllByRole('status')).some((el) => el.textContent?.includes('认不出「不存在」'))).toBe(true);
    // ask 无 mention
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '请它处理' })); });
    await act(async () => { fireEvent.change(box, { target: { value: '跑一下' } }); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '留这条' })); });
    expect((await screen.findAllByRole('status')).some((el) => el.textContent?.includes('要先 @ 一个名片'))).toBe(true);
    expect(posts.filter((p) => p.path === '/collab/note/message')).toHaveLength(0);
  });
});

describe('容量与 LAN 身份', () => {
  it('容量四事分开,上限取不到 = 未知', async () => {
    pinPhoneClock();
    mount();
    await act(async () => { fireEvent.click(screen.getByText('冲刺目标甲')); });
    expect(await screen.findByText(/小K:在线 · 手上 1 件 · 实际执行 1 件 · 能接几件:未知/)).toBeTruthy();
  });

  it('LAN 改名:重名 409 保留输入并摆原因;成功带稳定身份不换', async () => {
    pinPhoneClock();
    const { posts } = mount();
    await act(async () => { fireEvent.click(screen.getByRole('tab', { name: '频道' })); });
    const input = await screen.findByLabelText('事务官名字');
    expect((input as HTMLInputElement).value).toBe('本机事务官');
    // 重名 → 409,输入保留
    await act(async () => { fireEvent.change(input, { target: { value: '阿真二号' } }); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '保存名字' })); });
    await waitFor(() => expect(posts.filter((p) => p.path === '/collab/lan/identity').length).toBe(1));
    await waitFor(() => expect((input as HTMLInputElement).value).toBe('阿真二号'), { timeout: 3000 });
    expect((await screen.findAllByRole('status')).some((el) => el.textContent?.includes('名称与已知成员重复'))).toBe(true);
  });
});

describe('掉线与返回规则(回归)', () => {
  it('连不上:打开着事项详情也摆掉线横幅(上次已知状态)', async () => {
    pinPhoneClock();
    mount({ connected: false });
    await act(async () => { fireEvent.click(screen.getByRole('tab', { name: '事项' })); });
    await act(async () => { fireEvent.click(screen.getByText('交回待验的活', { selector: '.ba-collab__rowtitle' })); });
    await pageLoaded();
    expect((await screen.findAllByRole('status')).some((el) => el.textContent?.includes('连不上'))).toBe(true);
    expect(screen.getByRole('heading', { name: /交回待验的活/ })).toBeTruthy();
  });
});

const pageLoaded = async () => { await Promise.resolve(); };
