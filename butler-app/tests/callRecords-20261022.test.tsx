/**
 * 通话落成记录(2026-10-22,决策记录同日「通电话是记录不是事项」)手机这一侧:
 *
 *   ① 报记录那几格与工作台 `CALL_RECORD_BODY_FIELDS` 同名(读源文件比对);报的时候带上这一通的 call_id;
 *   ② 「最近一次通话」读 `/state.calls`,老工作台退回老纪要卡;引导那一通的记录也算;
 *   ③ 「通话记录」一页:记录在前、老纪要卡在后;点开一通看摘要、时长、通话里建过 / 挪过的事项、可能要办、原话;
 *      首页带进来的那一通直接打开。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { CallsPage } from '../src/items/RecordPages';
import { SessionContext, type Session } from '../src/session';
import { createApiClient } from '../src/api/client';
import { createVoiceApi } from '../src/api/voice';
import { createCallApi } from '../src/api/call';
import { createAppearanceFeed } from '../src/swarm/appearance';
import { CALL_RECORD_BODY_FIELDS, emptyState, type CallRecordView, type TaskView, type WorkbenchState } from '../src/api/protocol';
import type { FeedSnapshot, StateFeed } from '../src/api/stateFeed';
import { latestCall, stageCards } from '../src/stage/stageCardsModel';
import { newCallId } from '../src/call/callModel';
import { fakeChannel, fakeRouted } from './wbchFakes';

afterEach(cleanup);

const PLUGIN = readFileSync(resolve(process.cwd(), '../workbench-plugin/src/protocol.ts'), 'utf8');
const NOW = '2026-10-22T14:40:00+08:00';

function record(over: Partial<CallRecordView> & { id: string }): CallRecordView {
  return { kind: 'call', at: '2026-10-22T06:35:00.000Z', summary: '电话里:今天天气不错', lines: 2, transcript: [], items: [], ...over };
}
function oldCard(over: Partial<TaskView> & { id: string; title: string }): TaskView {
  return { status: 'done', direction: 'mine', origin: 'call', created_at: '2026-10-01T10:00:00Z', updated_at: '2026-10-01T10:00:00Z', ...over } as TaskView;
}
function state(over: Partial<WorkbenchState> = {}): WorkbenchState {
  return { ...emptyState(), stale: false, now: NOW, ...over } as WorkbenchState;
}

describe('① 报记录那几格', () => {
  it('与工作台 CALL_RECORD_BODY_FIELDS 同名', () => {
    const raw = /export const CALL_RECORD_BODY_FIELDS = \[([^\]]+)\] as const/.exec(PLUGIN)?.[1];
    expect(raw).toBeDefined();
    expect([...CALL_RECORD_BODY_FIELDS]).toEqual([...raw!.matchAll(/'([^']+)'/g)].map((m) => m[1]));
  });

  it('record() 带上 call_id;发出去的只用表里那几格', async () => {
    const seen: Record<string, unknown>[] = [];
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      return new Response(JSON.stringify({ ok: true, id: 'ph-1' }), { status: 200 });
    }) as typeof fetch;
    const client = createApiClient({ pairing: { token: 't', host: 'h', port: 8791, deviceId: 'd' }, fetchImpl, onUnauthorized: () => {} });
    await createCallApi(client).record({ callId: 'ph-1', durationSeconds: 12, transcript: [{ who: 'me', text: '喂' }] });
    expect(seen[0]).toMatchObject({ call_id: 'ph-1', durationSeconds: 12 });
    for (const key of Object.keys(seen[0]!)) expect(CALL_RECORD_BODY_FIELDS as readonly string[]).toContain(key);
  });

  it('拨号时编的号:ph- 开头、每次不一样', () => {
    const a = newCallId();
    expect(a).toMatch(/^ph-[0-9a-z]+$/);
    expect(newCallId()).not.toBe(a);
  });
});

describe('② 最近一次通话', () => {
  it('有通话记录 → 最新那一份:摘要、几点 · 多长;点下去带着那一通的编号', () => {
    const s = state({
      calls: { recent: [record({ id: 'c-old', at: '2026-10-22T05:00:00.000Z', summary: '电话里:早一点那一通' }), record({ id: 'c-new', duration_seconds: 185 })] },
      tasks: { tasks: [oldCard({ id: 't-old', title: '和事务官通了个电话(5 秒)' })] },
    } as Partial<WorkbenchState>);
    expect(latestCall(s)?.id).toBe('c-new');
    const card = stageCards(s).find((one) => one.id === 'call')!;
    expect(card.lines[0]!.text).toBe('电话里:今天天气不错');
    expect(card.lines[0]!.note).toMatch(/3 分 5 秒$/);
    expect(card.to).toEqual({ page: 'calls', callId: 'c-new' });
  });

  it('老工作台(没有 calls 那一格)→ 照旧读最新那张老纪要卡', () => {
    const s = state({ tasks: { tasks: [oldCard({ id: 't-old', title: '和事务官通了个电话(5 秒)', call: { kind: 'call', summary: '说了版本号', duration_seconds: 5 } })] } });
    expect(latestCall(s)?.id).toBe('t-old');
    expect(stageCards(s).find((one) => one.id === 'call')!.to).toEqual({ page: 'calls', callId: 't-old' });
  });

  it('引导那一通有记录 → 不再补「引导走完了」那一句', () => {
    const s = state({
      calls: { recent: [record({ id: 'c-onb', kind: 'onboarding', at: '2026-10-22T05:00:00.000Z', summary: '引导走完了:都记下了' })] },
      onboarding: { stage: 'done', done: true, done_at: '2026-10-22T06:00:00.000Z' },
    } as Partial<WorkbenchState>);
    expect(stageCards(s).find((one) => one.id === 'call')!.lines[0]!.text).toBe('引导走完了:都记下了');
  });
});

describe('③ 通话记录一页', () => {
  const TASKS = [
    { id: 't-1', title: '下周约牙医', status: 'todo', direction: 'mine', created_at: NOW, updated_at: NOW },
    oldCard({ id: 't-old', title: '和事务官通了个电话(5 秒)' }),
  ] as unknown as TaskView[];
  const CALLS = {
    recent: [
      record({
        id: 'c-1',
        duration_seconds: 40,
        summary: '电话里:帮我记一下下周约牙医',
        transcript: [{ who: 'me', text: '帮我记一下下周约牙医' }, { who: 'butler', text: '记下了。' }],
        items: [{ task_id: 't-1', did: 'created', title: '下周约牙医' }],
        maybe_todo: ['帮我记一下周五交报销'],
      }),
    ],
  };

  function mount(node: ReactNode) {
    const pairing = { token: 't', host: 'h', port: 8791, deviceId: 'd' };
    const fetchImpl = (async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as unknown as typeof fetch;
    const client = createApiClient({ pairing, fetchImpl, onUnauthorized: () => {} });
    const snapshot: FeedSnapshot = { state: state({ calls: CALLS, tasks: { tasks: TASKS } } as Partial<WorkbenchState>), connected: true, error: undefined };
    const feed: StateFeed = { get: () => snapshot, subscribe: () => () => {}, async refresh() {}, stop() {} };
    const session: Session = {
      pairing, client: fakeRouted(client, 'direct'), direct: client, feed,
      voice: createVoiceApi(client), call: createCallApi(client), channel: fakeChannel({}),
      appearance: createAppearanceFeed(client),
      settings: { async load() { throw new Error('用不到'); }, async update() { throw new Error('用不到'); } },
      async unpair() {},
    };
    render(<SessionContext.Provider value={session}>{node}</SessionContext.Provider>);
  }

  it('记录在前、老纪要卡在后;事项那张不在这一页', () => {
    mount(<CallsPage />);
    const titles = within(screen.getByRole('list', { name: '通话记录' })).getAllByRole('button').map((b) => b.querySelector('.ba-item__title')?.textContent);
    expect(titles).toEqual(['电话里:帮我记一下下周约牙医', '和事务官通了个电话(5 秒)']);
  });

  it('点开一通:摘要、时长、通话里建的那张卡(点得开)、可能要办、双方原话', async () => {
    mount(<CallsPage />);
    await act(async () => { fireEvent.click(screen.getByText('电话里:帮我记一下下周约牙医')); });
    const sheet = screen.getByRole('dialog', { name: '通话详情' });
    expect(within(sheet).getByText('40 秒')).toBeTruthy();
    const items = within(sheet).getByRole('region', { name: '通话里建过、挪过的事项' });
    expect(within(items).getByText('下周约牙医')).toBeTruthy();
    expect(within(items).getByText('建了')).toBeTruthy();
    expect(within(sheet).getByRole('region', { name: '可能要办' }).textContent).toContain('帮我记一下周五交报销');
    expect(sheet.textContent).toContain('我:帮我记一下下周约牙医');
    expect(sheet.textContent).toContain('事务官:记下了。');
    // 点那张卡 → 去那件事的详情。
    await act(async () => { fireEvent.click(within(items).getByText('下周约牙医')); });
    expect(screen.getByRole('dialog', { name: '事项详情' })).toBeTruthy();
  });

  it('首页带进来的那一通直接打开;老纪要卡照旧打开那张卡', async () => {
    mount(<CallsPage target={{ callId: 'c-1' }} />);
    expect(await screen.findByRole('dialog', { name: '通话详情' })).toBeTruthy();
    cleanup();
    mount(<CallsPage target={{ callId: 't-old' }} />);
    expect(await screen.findByRole('dialog', { name: '事项详情' })).toBeTruthy();
  });
});
