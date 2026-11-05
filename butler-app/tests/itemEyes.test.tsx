/**
 * 手机事项详情里「派活的眼睛」那几样(2026-09-25,卡 O):花了多少 / 上限多少、「停掉这一件」、
 * 派不出去时为什么 + 「要在电脑前点『帮我接上』」(手机上不画那颗键)+「先交给 Codex 做」;设置里各家能做什么(只读)。
 * 9/29 起他只带手机:这几颗键出了局域网也要按得动(房间白名单见 channel-worker/src/rpc.ts)。
 */
import { describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { InboxPage } from '../src/items/InboxPage';
import { AgentCapsSection } from '../src/settings/AgentCapsSection';
import { budgetLine, stoppable } from '../src/items/itemControls';
import { SessionContext, type Session } from '../src/session';
import { createApiClient } from '../src/api/client';
import { createVoiceApi } from '../src/api/voice';
import { createCallApi } from '../src/api/call';
import { createAppearanceFeed } from '../src/swarm/appearance';
import { emptyState, type AgentCapsView, type SessionView, type TaskView, type WorkbenchState } from '../src/api/protocol';
import type { FeedSnapshot, StateFeed } from '../src/api/stateFeed';
import { fakeChannel, fakeRouted } from './wbchFakes';

function fakeFeed(state: WorkbenchState): StateFeed {
  const snapshot: FeedSnapshot = { state, connected: true, error: undefined };
  return { get: () => snapshot, subscribe: () => () => {}, async refresh() {}, stop() {} };
}

const RUNNING = { agent: 'dsh', session_id: 's-1', project: '', status: 'running', elapsed_sec: 200, unread: false, updated_at: '2026-09-25T15:00:00Z' } as SessionView;

function mount(task: TaskView, sessions: readonly SessionView[] = []) {
  const posts: { path: string; body: Record<string, unknown> }[] = [];
  const pairing = { token: 't', host: 'h', port: 8791, deviceId: 'd' };
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const path = url.slice(url.indexOf('/', 'http://'.length));
    if (init?.method === 'POST') posts.push({ path, body: JSON.parse(String(init.body ?? '{}')) as Record<string, unknown> });
    return new Response(JSON.stringify({ ok: true, note: '停了:停了事务官那条会话' }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const client = createApiClient({ pairing, fetchImpl, onUnauthorized: () => {} });
  const state: WorkbenchState = { ...emptyState(), sessions, tasks: { tasks: [task] }, butler_inbox: { items: [] } } as WorkbenchState;
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

describe('事项详情:派活的眼睛', () => {
  it('★事务官自己在办的:花了多少 / 上限多少;「停掉这一件」= POST /butler/item/stop,回执原样说', async () => {
    const task = {
      id: 't-1', title: '修首页球', status: 'doing', direction: 'mine', origin: 'user',
      conversation: { agent: 'dsh', session_id: 's-1' },
      budget: { limit_cny: 0.5, limit_minutes: 10, spent_cny: 0.14, run_minutes: 3.2, state: 'running' },
      created_at: 'x', updated_at: '2026-09-25T15:00:00Z',
    } as TaskView;
    const { posts } = mount(task, [RUNNING]);
    const sheet = await screen.findByRole('dialog', { name: '事项详情' });
    expect(within(sheet).getByText('花了约 0.14 元 · 跑了 3 分钟(上限 0.5 元 / 10 分钟)')).toBeTruthy();
    await act(async () => { fireEvent.click(within(sheet).getByRole('button', { name: '停掉这一件' })); });
    await waitFor(() => expect(posts.find((one) => one.path === '/butler/item/stop')?.body).toEqual({ id: 't-1' }));
    expect((await within(sheet).findByRole('status', {}, { timeout: 3000 })).textContent).toContain('停了');
  });

  it('★派不出去(Claude 还差一步):说清为什么,「帮我接上」只能在电脑前 —— 手机上不画那颗键;「先交给 Codex 做」按得动', async () => {
    const task = {
      id: 't-2', title: '修首页球', status: 'blocked', direction: 'mine', origin: 'user',
      dispatch_block: {
        family: 'claude', kind: 'code', why: '要让 Claude 直接改你电脑上的文件,还差一步:登录一次', at: 'x',
        fix: { kind: 'login_cli', family: 'claude', label: '帮我接上', desk_only: true },
        alternatives: [{ family: 'codex', title: 'Codex', note: '5 小时窗口还剩约 80%' }],
      },
      created_at: 'x', updated_at: '2026-09-25T15:00:00Z',
    } as TaskView;
    const { posts } = mount(task);
    const sheet = await screen.findByRole('dialog', { name: '事项详情' });
    expect(within(sheet).getByText(/要在电脑前点「帮我接上」/)).toBeTruthy();
    expect(within(sheet).queryByRole('button', { name: '帮我接上' })).toBeNull();
    await act(async () => { fireEvent.click(within(sheet).getByRole('button', { name: /先交给 Codex 做/ })); });
    await waitFor(() => expect(posts.find((one) => one.path === '/dispatch/run')?.body).toEqual({ item_id: 't-2', app: 'codex', kind: 'code' }));
  });

  it('判据与电脑那份逐字同一套', () => {
    expect(budgetLine({ limit_cny: 0.5, limit_minutes: 10, spent_cny: 0.52, run_minutes: 11.2, state: 'paused' })).toBe('花了约 0.52 元 · 跑了 11 分钟(上限 0.5 元 / 10 分钟)');
    expect(stoppable({ id: 'x', title: 'x', status: 'doing', client_dispatch: { status: 'sent', at: 'x', reply_state: 'waiting' }, created_at: '', updated_at: '' } as TaskView, [])).toBe(true);
  });
});

describe('设置:各家能做什么(只读)', () => {
  it('没装的不列;不行的那格说原因,修法写「要在电脑前点」', () => {
    const caps: AgentCapsView = {
      line: '能直接改你电脑上的文件的:Codex;还差一步的:Claude(点那一格里的按钮)',
      agents: [
        { family: 'claude', title: 'Claude', installed: true, line: 'x', cells: {
          chat: { state: 'ok', note: '送得进' },
          edit: { state: 'no', note: '要让 Claude 直接改你电脑上的文件,还差一步:登录一次', fix: { kind: 'login_cli', family: 'claude', label: '帮我接上', desk_only: true } },
          collect: { state: 'ok', note: '读' },
        } },
        { family: 'doubao', title: '豆包', installed: false, line: 'x', cells: { chat: { state: 'na', note: '没装' }, edit: { state: 'na', note: '没装' }, collect: { state: 'na', note: '没装' } } },
      ],
    };
    render(<AgentCapsSection caps={caps} />);
    const section = screen.getByTestId('agent-caps');
    expect(section.textContent).toContain('Claude 能聊天 行 · 能改本机文件 不行 · 能收回结果 行');
    expect(section.textContent).toContain('(要在电脑前点「帮我接上」)');
    expect(section.textContent).not.toContain('豆包');
  });

  it('每家跟一句额度(三格之一:有数 / 不限 / 没接上:原因)', () => {
    const cells = { chat: { state: 'ok' as const, note: '送得进' }, edit: { state: 'na' as const, note: '只能聊天' }, collect: { state: 'ok' as const, note: '读' } };
    const caps: AgentCapsView = {
      line: 'x',
      agents: [
        { family: 'doubao', title: '豆包', installed: true, line: 'x', cells },
        { family: 'muse', title: 'Muse', installed: true, line: 'x', cells },
        { family: 'manus', title: 'Manus', installed: true, line: 'x', cells },
      ],
    };
    render(<AgentCapsSection caps={caps} quotas={[
      { id: 'doubao', title: '豆包', state: 'unlimited', line: '不限' },
      { id: 'muse', title: 'Muse', state: 'unconnected', line: '没接上:Muse 有用量上限,剩多少只在它自己的「使用情况」页上' },
      { id: 'manus', title: 'Manus', state: 'numbers', line: '剩 1,234 积分' },
    ]} />);
    const text = screen.getByTestId('agent-caps').textContent ?? '';
    expect(text).toContain('豆包 能聊天 行 · 能改本机文件 没有 · 能收回结果 行 · 额度不限');
    expect(text).toContain('Muse 能聊天 行 · 能改本机文件 没有 · 能收回结果 行 · 额度没接上:Muse 有用量上限');
    expect(text).toContain('Manus 能聊天 行 · 能改本机文件 没有 · 能收回结果 行 · 额度:剩 1,234 积分');
  });

  /**
   * 2026-09-26(卡 QS;维护者:「Claude 的额度怎么突然显示为未接入了」):读到过的数不因为一会儿
   * 没刷新就翻成「没接上」。手机上**照工作台那一句原样摆** —— 电脑、派活确认那一行、这里一个字不差。
   */
  it('★上次读到的那个数:照原话摆(带几点读到的与「数字可能旧」),不写「没接上」', () => {
    const cells = { chat: { state: 'ok' as const, note: '送得进' }, edit: { state: 'ok' as const, note: '能改' }, collect: { state: 'ok' as const, note: '读' } };
    const caps: AgentCapsView = {
      line: 'x',
      agents: [{ family: 'claude', title: 'Claude', installed: true, line: 'x', cells }],
    };
    render(<AgentCapsSection caps={caps} quotas={[{
      id: 'claude',
      title: 'Claude',
      state: 'numbers',
      line: '本周还剩约 69% · 昨晚 20:42 读到的 · Claude 桌面没在跑,数字可能旧',
      read_at: '2026-09-25T20:42:00+08:00',
      stale: true,
    }]} />);
    const text = screen.getByTestId('agent-caps').textContent ?? '';
    expect(text).toContain('额度:本周还剩约 69% · 昨晚 20:42 读到的 · Claude 桌面没在跑,数字可能旧');
    expect(text).not.toContain('没接上');
  });
});

describe('「等你确认」里要他定的那一件(卡 O)', () => {
  it('派不出去 / 到上限停下来了:一行、附注「要你定」,点下去是那件事的详情', async () => {
    const { waitingRows, DECIDE_NOTE } = await import('../src/stage/stageCardsModel');
    const rows = waitingRows({
      now: 'x', stale: false, sessions: [],
      waiting: { count: 1, items: [{ key: 'decide:t-b', kind: 'decide', verb: '答', text: '「修一下首页」派不出去:要让 Claude 直接改你电脑上的文件,还差一步', task_id: 't-b' }] },
    } as never);
    expect(rows).toEqual([{ id: 'decide:t-b', kind: 'decide', text: '「修一下首页」派不出去:要让 Claude 直接改你电脑上的文件,还差一步', note: DECIDE_NOTE, taskId: 't-b' }]);
    expect(DECIDE_NOTE).toBe('要你定');
  });
});
