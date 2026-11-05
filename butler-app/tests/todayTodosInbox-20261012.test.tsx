/**
 * 「今天的待办」手机这一端(2026-10-12):事项页「排着」顶上那一块,读电脑切好的 `/state.today_todos`
 * (与自媒体模板里那一格同一份;切法在 workbench-plugin/src/todayTodos.ts)。手机上只看,点一件打开那件事项的详情。
 */
import { describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { InboxPage } from '../src/items/InboxPage';
import { SessionContext, type Session } from '../src/session';
import { createApiClient } from '../src/api/client';
import { createVoiceApi } from '../src/api/voice';
import { createCallApi } from '../src/api/call';
import { createAppearanceFeed } from '../src/swarm/appearance';
import { emptyState, type TaskView, type TodayTodosView, type WorkbenchState } from '../src/api/protocol';
import type { FeedSnapshot, StateFeed } from '../src/api/stateFeed';
import { fakeChannel, fakeRouted } from './wbchFakes';

const NOW = '2026-10-12T10:00:00+08:00';
const TODAY: TodayTodosView = {
  date: '2026-10-12',
  tomorrow: '2026-10-13',
  items: [
    { id: 'late', title: '补拍空镜', due: '2026-10-10', done: false, overdue: true },
    { id: 'a', title: '回三条评论', due: '2026-10-12', done: false, overdue: false },
    { id: 'd', title: '剪片头', due: '2026-10-12', done: true, overdue: false },
  ],
};

function task(id: string, title: string, status: TaskView['status']): TaskView {
  return { id, title, status, due: '2026-10-12', created_at: NOW, updated_at: NOW } as TaskView;
}

function mount(today?: TodayTodosView) {
  const state = {
    ...emptyState(), stale: false, now: NOW, sessions: [],
    tasks: { tasks: [task('late', '补拍空镜', 'todo'), task('a', '回三条评论', 'todo'), task('d', '剪片头', 'done')] },
    ...(today === undefined ? {} : { today_todos: today }),
  } as unknown as WorkbenchState;
  const pairing = { token: 't', host: 'h', port: 8791, deviceId: 'd' };
  const fetchImpl = (async () => new Response(JSON.stringify({ error: '没这条路' }), { status: 404 })) as typeof fetch;
  const client = createApiClient({ pairing, fetchImpl, onUnauthorized: () => {} });
  const snapshot: FeedSnapshot = { state, connected: true, error: undefined };
  const feed: StateFeed = { get: () => snapshot, subscribe: () => () => {}, async refresh() {}, stop() {} };
  const session: Session = {
    pairing, client: fakeRouted(client, 'direct'), direct: client, feed,
    voice: createVoiceApi(client), call: createCallApi(client), channel: fakeChannel({}),
    appearance: createAppearanceFeed(client),
    settings: { async load() { throw new Error('用不到'); }, async update() { throw new Error('用不到'); } },
    async unpair() {},
  };
  render(<SessionContext.Provider value={session}><InboxPage target={{ tab: 'queued' }} /></SessionContext.Provider>);
}

describe('手机事项页「排着」:今天的待办', () => {
  it('有这一份就在顶上摆一块:日期、还剩几件、逾期写明、办完的标出来', () => {
    mount(TODAY);
    const block = screen.getByRole('region', { name: '今天的待办' });
    expect(within(block).getByRole('heading').textContent).toBe('今天的待办 · 10月12日 · 还有 2 件');
    expect(within(block).getByText('补拍空镜')).toBeTruthy();
    expect(within(block).getByText('逾期 · 10/10')).toBeTruthy();
    expect(within(block).getByText('已办完')).toBeTruthy();
  });

  it('点一件打开那件事项的详情', async () => {
    mount(TODAY);
    const block = screen.getByRole('region', { name: '今天的待办' });
    await act(async () => { fireEvent.click(within(block).getByText('回三条评论')); });
    expect(screen.getByRole('dialog', { name: '事项详情' })).toBeTruthy();
  });

  it('没有这一份(不是自媒体模板 / 老工作台):不摆这一块', () => {
    mount();
    expect(screen.queryByRole('region', { name: '今天的待办' })).toBeNull();
  });
});
