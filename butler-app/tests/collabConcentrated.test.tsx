import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createApiClient } from '../src/api/client';
import { createSendOutbox, SEND_OUTBOX_AUTO_MS, SEND_OUTBOX_KEY } from '../src/outbox/sendOutbox';
import { TaskSheet } from '../src/collab/TaskSheet';
import { GoalPanel } from '../src/collab/GoalPanel';
import { collabFields } from '../src/collab/collabState';
import { readCollabDraft } from '../src/collab/collabDrafts';
import type { TaskView } from '../src/api/protocol';
const NOW = '2026-10-24T12:00:00Z';
const actors = { cards: { 'agent:a': '同名', 'agent:b': '同名' }, members: {} };
const task = (id: string, more: Partial<TaskView> = {}): TaskView => ({ id, title: `事项${id}`, status: 'doing', created_at: NOW, updated_at: NOW, ...more });
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const clientOf = (fetchImpl: typeof fetch) => createApiClient({ pairing: { host: '127.0.0.1', port: 10092, token: 'test-only', deviceId: 'test-only' }, fetchImpl, onUnauthorized() {} });
const emptyFetch = (async () => json({ items: [], relations: [], runs: [] })) as typeof fetch;
function sheet(client = clientOf(emptyFetch), item = task('A'), outbox?: ReturnType<typeof createSendOutbox>) {
  return <TaskSheet task={item} allTasks={[task('A'), task('B')]} goals={[]} fields={collabFields} actors={actors} now={NOW} sessions={[]} outbox={outbox} client={client} draftScope="concentrated" onOpenTask={() => {}} onOpenGoal={() => {}} />;
}
beforeEach(() => { const m = new Map<string, string>(); Object.defineProperty(window, 'localStorage', { configurable: true, value: { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); }, clear: () => m.clear() } }); });
afterEach(cleanup);

describe('R2 send snapshot protects later edits', () => {
  it.each(['direct', 'delivered', 'unsent'] as const)('%s late A cannot clear edited B, intent or recipient; persistence agrees', async (mode) => {
    const response = deferred<Response>(); const bodies: Record<string, unknown>[] = [];
    const client = clientOf((async (_url, init) => { if (init?.method === 'POST') { bodies.push(JSON.parse(String(init.body))); return response.promise; } return json({ items: [], relations: [] }); }) as typeof fetch);
    const kv = { get: async () => null, set: async () => {}, remove: async () => {} };
    const outbox = mode === 'direct' ? undefined : createSendOutbox({ client, kv });
    const ui = render(sheet(client, task('A'), outbox));
    fireEvent.change(screen.getByLabelText('留言草稿'), { target: { value: '发送A' } }); fireEvent.click(screen.getByRole('button', { name: '留这条' }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: '请它处理' })); fireEvent.click(screen.getByRole('button', { name: '@ 名片' })); fireEvent.click(screen.getByRole('button', { name: '@同名 · agent:b' }));
    fireEvent.change(screen.getByLabelText('留言草稿'), { target: { value: '@同名 新稿B' } });
    await act(async () => { response.resolve(mode === 'unsent' ? json({ error: 'offline' }, 503) : json({ ok: true })); });
    expect(bodies[0]).toMatchObject({ text: '发送A', intent: 'record', mentions: [] });
    expect((screen.getByLabelText('留言草稿') as HTMLTextAreaElement).value).toBe('@同名 新稿B');
    expect(readCollabDraft('concentrated', 'A')).toEqual({ text: '@同名 新稿B', intent: 'ask', pickedIds: ['agent:b'] });
    ui.unmount(); render(sheet(client, task('A'), outbox));
    expect((screen.getByLabelText('留言草稿') as HTMLTextAreaElement).value).toBe('@同名 新稿B');
    expect(screen.getByText(/已选收件名片:同名 \(agent:b\)/)).toBeTruthy(); outbox?.stop();
  });
});

it('R3 A activity/relation never appears under B pending/error; same-item stale snapshot survives', async () => {
  const b = deferred<Response>(); let failA = false;
  const client = clientOf((async (input) => {
    const u = new URL(String(input)), id = u.searchParams.get('id') ?? u.searchParams.get('task_id');
    if (id === 'B') return b.promise;
    if (failA) return json({ error: 'A-refresh-offline' }, 503);
    return u.pathname.includes('activity') ? json({ items: [{ type: 'comment', at: NOW, comment: { id: 'c-a', by: 'me', at: NOW, text: '只属于A的证据' } }] }) : json({ relations: [{ id: 'r-a', from_id: 'A', to_id: 'B', kind: 'handoff', note: '只属于A的关系' }] });
  }) as typeof fetch);
  const ui = render(sheet(client)); await screen.findByText('只属于A的证据'); await screen.findByText(/只属于A的关系/);
  failA = true; ui.rerender(sheet(client, { ...task('A'), updated_at: '2026-10-24T12:00:01Z' }));
  await screen.findAllByText(/A-refresh-offline/); expect(screen.getByText('只属于A的证据')).toBeTruthy();
  ui.rerender(sheet(client, task('B')));
  expect(screen.queryByText('只属于A的证据')).toBeNull(); expect(screen.queryByText(/只属于A的关系/)).toBeNull();
  await act(async () => { b.resolve(json({ error: 'B-offline' }, 503)); });
  expect(screen.queryByText('只属于A的证据')).toBeNull(); expect(screen.queryByText(/只属于A的关系/)).toBeNull(); expect(screen.queryByText(/下面是上次读到的/)).toBeNull();
});

it('R7 expired unsent has manual resend using original outbox/message IDs', async () => {
  const bodies: Record<string, unknown>[] = [];
  const entry = { key: 'original-key', path: '/collab/note/message', body: { task_id: 'A', client_msg_id: 'original-message', text: '过期待发', intent: 'record', mentions: [] }, text: '过期待发', at: NOW, queuedAt: Date.now() - SEND_OUTBOX_AUTO_MS - 1, state: 'unsent' };
  const kv = { get: async (key: string) => key === SEND_OUTBOX_KEY ? JSON.stringify([entry]) : null, set: async () => {}, remove: async () => {} };
  const client = clientOf((async (_input, init) => { if (init?.method === 'POST') bodies.push(JSON.parse(String(init.body))); return json({ ok: true, items: [], relations: [] }); }) as typeof fetch);
  const outbox = createSendOutbox({ kv, client, now: () => Date.now() }); await outbox.ready(); await outbox.pump(); expect(bodies).toHaveLength(0);
  render(sheet(client, task('A'), outbox)); const pending = await screen.findByText(/没送到:过期待发/);
  expect(pending.textContent).not.toContain('恢复后自动补发');
  await act(async () => { fireEvent.click(within(pending).getByRole('button', { name: '重发' })); });
  await waitFor(() => expect(outbox.list()).toHaveLength(0)); expect(bodies).toEqual([{ ...entry.body, client_key: 'original-key' }]); outbox.stop();
});
const goal = { id: 'goal:a', title: '验收目标', conditions: [{ id: 'cond', text: '能力', taskId: 'A', verifications: [], createdAt: NOW, updatedAt: NOW }] };
const board = (state: string) => ({ summary: { goal_id: 'goal:a', scope: '目标', conditions: { items: [{ id: 'cond', text: '能力', task_id: 'A', state }] }, tasks: {} } });
const goalView = (client: ReturnType<typeof clientOf>, tasks = [task('A')], token = NOW) => <GoalPanel goal={{ ...goal }} tasks={tasks} fields={collabFields} actors={actors} now={token} client={client} onRefresh={async () => {}} onOpenTask={() => {}} />;
it('bounded board probe: old GET cannot overwrite newer rework response', async () => {
  const first = deferred<Response>(), second = deferred<Response>(); let count = 0;
  const client = clientOf((async (input) => String(input).includes('/goal/board') ? (++count === 1 ? first.promise : second.promise) : json({ items: [], runs: [] })) as typeof fetch);
  const ui = render(goalView(client)); await waitFor(() => expect(count).toBe(1));
  ui.rerender(goalView(client, [task('A', { status: 'doing' })], '2026-10-24T12:00:01Z')); await waitFor(() => expect(count).toBe(2));
  await act(async () => { second.resolve(json(board('rework'))); }); await screen.findByText('退回重做', { selector: '.ba-collab__condstate' });
  await act(async () => { first.resolve(json(board('delivered'))); });
  expect(screen.getByText('退回重做', { selector: '.ba-collab__condstate' })).toBeTruthy(); expect(screen.queryByText('当前可用(已交付)')).toBeNull();
});
it('R9 same-name people remain separate by stable ID in schedule/capacity', async () => {
  const client = clientOf((async (input) => String(input).includes('board') ? json(board('pending')) : String(input).endsWith('/capacity') ? json({ items: [{ id: 'agent:a', online: true, active_jobs: 1, running_jobs: 0, limit: 'unknown' }, { id: 'agent:b', online: true, active_jobs: 1, running_jobs: 0, limit: 'unknown' }] }) : json({ runs: [] })) as typeof fetch);
  render(goalView(client, [task('A', { assignee: 'agent:a' }), task('B', { assignee: 'agent:b' })]));
  const region = screen.getByRole('region', { name: '按人的安排' });
  expect(within(region).getByRole('heading', { name: /同名.*agent:a.*1 件/ })).toBeTruthy(); expect(within(region).getByRole('heading', { name: /同名.*agent:b.*1 件/ })).toBeTruthy();
  await waitFor(() => expect(within(region).getByText(/同名.*agent:a.*在线/)).toBeTruthy()); expect(within(region).getByText(/同名.*agent:b.*在线/)).toBeTruthy();
});

it('R5 goal watch list consumes latest core running/dispatched/unknown including conditionless tasks', async () => {
  const tasks = [task('A'), task('B'), task('C'), task('D')];
  const runs = [{ task_id: 'A', status: 'done', source: 'codex', started_at: '2026-10-23T10:00:00Z', outcome: 'replied' }, ...['running', 'dispatched', 'unknown'].map((status, i) => ({ task_id: ['A', 'B', 'C'][i], status, source: 'codex', started_at: NOW }))];
  const client = clientOf((async (input) => String(input).includes('/runs') ? json({ runs }) : String(input).includes('board') ? json(board('pending')) : json({ items: [] })) as typeof fetch);
  render(goalView(client, tasks));
  const region = await screen.findByRole('region', { name: '执行状态' });
  await waitFor(() => expect(within(region).getByRole('heading', { name: /实际执行中.*1 件/ })).toBeTruthy());
  for (const [name, title] of [['实际执行中', '事项A'], ['开工未确认', '事项B'], ['失联或记录过旧', '事项C'], ['执行状态未知', '事项D']]) {
    const heading = within(region).getByRole('heading', { name: new RegExp(name + '.*1 件') });
    expect(within(heading.parentElement!).getByRole('button', { name: title })).toBeTruthy();
  }
});
it.each(['blocked', 'objection'])('bounded done probe: replied is not a completion receipt for %s', async (kind) => {
  const client = clientOf((async () => json({ relations: [], items: [
    { type: 'run', at: NOW, segment: { task_id: 'A', source: 'codex', status: 'done', started_at: NOW, finished_at: NOW, outcome: 'replied' } },
    { type: 'receipt', at: NOW, receipt: { kind, at: NOW, text: kind === 'blocked' ? '缺素材' : '方案有异议', evidence: [] } },
  ] })) as typeof fetch);
  render(sheet(client, task('A', { status: kind === 'blocked' ? 'blocked' : 'confirm' })));
  await screen.findByText(kind === 'blocked' ? '缺素材' : '方案有异议');
  expect(screen.queryByText(/收到完成回执/)).toBeNull();
  expect(screen.getByText(/执行已收场.*成果另看回执/)).toBeTruthy();
});
it('R5 feed clock refresh reads producer status even when task objects are unchanged', async () => {
  const tasks = [task('A')]; let calls = 0;
  const client = clientOf((async (input) => String(input).includes('/runs') ? json({ runs: [{ task_id: 'A', source: 'codex', started_at: NOW, status: ++calls === 1 ? 'running' : 'unknown' }] }) : String(input).includes('board') ? json(board('pending')) : json({ items: [] })) as typeof fetch);
  const ui = render(goalView(client, tasks));
  await screen.findByRole('heading', { name: /实际执行中.*1 件/ });
  ui.rerender(goalView(client, tasks, '2026-10-24T12:03:00Z'));
  await screen.findByRole('heading', { name: /失联或记录过旧.*1 件/ });
  expect(screen.queryByRole('heading', { name: /实际执行中.*1 件/ })).toBeNull();
});

it('本轮选人理由和运行档位以宿主核验值显示', async () => {
  const item = task('A', { dispatch: { family: 'codex', status: 'done', started_at: NOW, selection: { evaluated_at: NOW, family: 'codex', reason: 'Claude 只剩9%，这次用 Codex', candidates: [] }, runtime: { attempt_id: 'attempt', mode: 'resume', started_at: NOW, requested: { model: 'requested', effort: 'high' }, observed: { model: 'actual', effort: 'low' }, status: 'mismatch', source: 'native_context' } } });
  item.client_dispatch = { status: 'sent', at: '2020-01-01T00:00:00Z', runtime: { attempt_id: 'old', mode: 'new', started_at: '2020-01-01T00:00:00Z', requested: {}, observed: { model: 'old-model', effort: 'high' }, status: 'verified', source: 'native_context' } };
  render(sheet(undefined, item));
  expect(screen.queryByText(/old-model/)).toBeNull();
  expect(screen.getByText(/运行档位与请求不符/).textContent).toContain('actual');
  expect(screen.getByText(/Claude 只剩9%/)).toBeTruthy();
});
