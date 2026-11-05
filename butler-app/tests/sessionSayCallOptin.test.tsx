/**
 * **「回了打电话给我」那个勾选**(2026-10-04,卡 `claude/relay-call-optin`)。
 *
 * 维护者当天经工作台捎来的原话:
 *
 * > 「现在每次我在手机里给你发信息,你回信息他就给我打电话……不是每次都要的,
 * > 能不能给个勾选,勾了才需要盯和打电话」
 *
 * 守四件:
 * ① 框旁边就有这一个勾选,文案是大白话({@link SAY_CALL_BACK});
 * ② **缺省不勾** —— 发出去那一下请求里**没有** `call_on_reply` 这一格(工作台那头按不盯);
 * ③ 勾了再发 → 带 `call_on_reply: true`(照旧:盯着,它回了就打电话);
 * ④ 勾过又取消 → 又回到不带这一格(不是只能勾不能撤)。
 */
import { describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { InboxPage } from '../src/items/InboxPage';
import { SAY_CALL_BACK, SAY_LABEL } from '../src/items/SessionSayBox';
import { SessionContext, type Session } from '../src/session';
import { createApiClient } from '../src/api/client';
import { createVoiceApi } from '../src/api/voice';
import { createCallApi } from '../src/api/call';
import { createAppearanceFeed } from '../src/swarm/appearance';
import { emptyState, type SessionDigestView, type SessionView, type WorkbenchState } from '../src/api/protocol';
import type { FeedSnapshot, StateFeed } from '../src/api/stateFeed';
import { fakeChannel, fakeRouted } from './wbchFakes';
import { registryOf } from './registryFixture';

const NOW = '2026-10-04T14:05:00.000Z';
const SESSION_ID = 'cx-9f3a1c2b7e';

function session(): SessionView {
  return {
    agent: 'codex', session_id: SESSION_ID, project: 'desktop-workbench', status: 'running',
    title: '把导出 PDF 做出来', elapsed_sec: 14 * 60, unread: false, updated_at: NOW,
    activity: { line: '在跑测试', at: '2026-10-04T14:02:00.000Z' },
  };
}

function state(sessions: SessionView[]): WorkbenchState {
  return { ...emptyState(), stale: false, now: NOW, sessions, agent_registry: registryOf(sessions, ['codex', 'claude']) } as WorkbenchState;
}

function fakeFeed(value: WorkbenchState): StateFeed {
  const snapshot: FeedSnapshot = { state: value, connected: true, error: undefined };
  return { get: () => snapshot, subscribe: () => () => {}, async refresh() {}, stop() {} };
}

const digest = (): SessionDigestView => ({
  agent: 'codex',
  session_id: SESSION_ID,
  title: '把导出 PDF 做出来',
  project: 'desktop-workbench',
  status: 'running',
  elapsed_sec: 14 * 60,
  activity: { line: '在跑测试', at: '2026-10-04T14:02:00.000Z' },
  rounds: [{ ask: '加个导出 PDF', reply: '在做,先把按钮摆上。', at: '2026-10-04T14:00:00.000Z' }],
  read_at: NOW,
  relay: { can: true },
});

function mount(relayAnswers: ('offline' | 'ok')[] = []) {
  const posts: { path: string; body: Record<string, unknown> | undefined }[] = [];
  const pairing = { token: 't', host: 'h', port: 8791, deviceId: 'd' };
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const path = url.slice(url.indexOf('/', 'http://'.length));
    if ((init?.method ?? 'GET') !== 'GET') {
      posts.push({ path, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) as Record<string, unknown> });
    }
    if (path.startsWith('/sessions/digest')) {
      return new Response(JSON.stringify(digest()), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (path === '/sessions/relay') {
      if (relayAnswers.shift() === 'offline') throw new TypeError('Failed to fetch');
      return new Response(JSON.stringify({ ok: true, route: 'window', note: '捎到了。' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ error: '没这条路' }), { status: 404 });
  }) as typeof fetch;
  const client = createApiClient({ pairing, fetchImpl, onUnauthorized: () => {} });
  const ctx: Session = {
    pairing,
    client: fakeRouted(client, 'direct'),
    direct: client,
    feed: fakeFeed(state([session()])),
    voice: createVoiceApi(client),
    call: createCallApi(client),
    channel: fakeChannel({}),
    appearance: createAppearanceFeed(client),
    settings: { async load() { throw new Error('用不到'); }, async update() { throw new Error('用不到'); } },
    async unpair() {},
  };
  render(
    <SessionContext.Provider value={ctx}>
      <InboxPage />
    </SessionContext.Provider>,
  );
  return { posts };
}

async function openSheet(): Promise<HTMLElement> {
  await act(async () => { fireEvent.click(within(screen.getByRole('region', { name: '各家正在办' })).getByRole('button')); });
  return await screen.findByRole('dialog', { name: '会话详情' });
}

async function send(sheet: HTMLElement, text: string): Promise<void> {
  const box = within(sheet).getByLabelText(SAY_LABEL);
  await act(async () => { fireEvent.change(box, { target: { value: text } }); });
  await act(async () => { fireEvent.click(within(sheet).getByRole('button', { name: '发送' })); });
}

describe('「回了打电话给我」那个勾选', () => {
  it('★缺省不勾:框旁边摆着这一格、没打上钩;发出去那一下请求里没有 call_on_reply', async () => {
    const { posts } = mount();
    const sheet = await openSheet();
    const box = within(sheet).getByRole('checkbox', { name: SAY_CALL_BACK }) as HTMLInputElement;
    expect(box.checked).toBe(false);
    await send(sheet, '现在到哪了');
    expect(posts.map(one => one.path)).toEqual(['/sessions/relay']);
    expect(posts[0]?.body).toEqual({ agent: 'codex', session_id: SESSION_ID, text: '现在到哪了', client_key: expect.any(String) });
  });

  it('★勾了再发:带 call_on_reply:true', async () => {
    const { posts } = mount();
    const sheet = await openSheet();
    await act(async () => { fireEvent.click(within(sheet).getByRole('checkbox', { name: SAY_CALL_BACK })); });
    await send(sheet, '现在到哪了');
    expect(posts[0]?.body).toMatchObject({ call_on_reply: true });
  });

  it('★勾过又取消:又回到不带这一格', async () => {
    const { posts } = mount();
    const sheet = await openSheet();
    const box = within(sheet).getByRole('checkbox', { name: SAY_CALL_BACK });
    await act(async () => { fireEvent.click(box); });
    await act(async () => { fireEvent.click(box); });
    await send(sheet, '现在到哪了');
    expect(posts[0]?.body).not.toHaveProperty('call_on_reply');
  });
});

/**
 * 捎话没送到(2026-10-12,卡「手机交代只执行一次」):再按发送带**同一个请求号**(电脑办过的不办第二次);
 * 送到了之后再说一句是新的一句,换号。
 */
describe('捎话没送到再发', () => {
  it('★连不上 → 说「没送到」;同一句再按发送,带同一个号;送到之后下一句换号', async () => {
    const { posts } = mount(['offline', 'ok', 'ok']);
    const sheet = await openSheet();
    await send(sheet, '现在到哪了');
    expect(await within(sheet).findByText(/没送到/)).toBeTruthy();
    await send(sheet, '现在到哪了');
    await send(sheet, '再跑一遍测试');
    const keys = posts.filter(one => one.path === '/sessions/relay').map(one => one.body?.client_key);
    expect(keys).toHaveLength(3);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
  });
});
