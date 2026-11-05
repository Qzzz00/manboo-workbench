/**
 * 手机事项页「等你」里的「新学到一条:…,正在试用」(2026-10-10,维护者 10-09 拍板)。
 * 点开有「撤掉」(`POST /habits/revoke`)与「知道了」(`POST /habits/seen`),回执原样摆;
 * 两条都在房间白名单里(出门的手机经工人代理),8791 那边只认她本人(配对手机算)。
 */
import { describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { InboxPage } from '../src/items/InboxPage';
import { inboxItemCard } from '../src/items/itemsModel';
import { SessionContext, type Session } from '../src/session';
import { createApiClient } from '../src/api/client';
import { createVoiceApi } from '../src/api/voice';
import { createCallApi } from '../src/api/call';
import { createAppearanceFeed } from '../src/swarm/appearance';
import { emptyState, type ButlerInboxItem, type WorkbenchState } from '../src/api/protocol';
import type { FeedSnapshot, StateFeed } from '../src/api/stateFeed';
import { fakeChannel, fakeRouted } from './wbchFakes';

const ITEM: ButlerInboxItem = {
  id: 'habit:时段:13',
  kind: 'habit',
  title: '新学到一条:13:00–14:00 不打电话,改发消息,正在试用',
  note: '依据:10-05 13:10 那一通没接;10-06 13:40 那一通没接。下一次同类的事你没纠正就留下;不对就点「撤掉」。',
  at: '2026-10-06T12:00:00.000Z',
  habit: { id: '时段:13' },
};

function fakeFeed(state: WorkbenchState): StateFeed {
  const snapshot: FeedSnapshot = { state, connected: true, error: undefined };
  return { get: () => snapshot, subscribe: () => () => {}, async refresh() {}, stop() {} };
}

function mount() {
  const posts: { path: string; body: Record<string, unknown> }[] = [];
  const pairing = { token: 't', host: 'h', port: 8791, deviceId: 'd' };
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const path = url.slice(url.indexOf('/', 'http://'.length));
    if (init?.method === 'POST') posts.push({ path, body: JSON.parse(String(init.body ?? '{}')) as Record<string, unknown> });
    const note = path === '/habits/revoke' ? '撤掉了。撤错了在「它学到了什么」里点「恢复」。' : '好,在「它学到了什么」里随时能看、能撤。';
    return new Response(JSON.stringify({ ok: true, note }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const client = createApiClient({ pairing, fetchImpl, onUnauthorized: () => {} });
  const state = { ...emptyState(), butler_inbox: { items: [ITEM] } } as WorkbenchState;
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
  render(<SessionContext.Provider value={session}><InboxPage target={{ tab: 'waiting' }} /></SessionContext.Provider>);
  return { posts };
}

describe('「新学到一条」那一张', () => {
  it('收件箱条目带着习惯 id 上卡', () => {
    expect(inboxItemCard(ITEM).habit).toEqual({ id: '时段:13' });
  });

  it('★在「等你」里,点开能「撤掉」/「知道了」,回执原样摆', async () => {
    const { posts } = mount();
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: new RegExp(ITEM.title) })); });
    expect(within(screen.getByRole('dialog', { name: '事项详情' })).getByText(/不对就点「撤掉」/u)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '撤掉' }));
    expect(await screen.findByText(/撤错了在「它学到了什么」里点「恢复」/u)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '知道了' }));
    await waitFor(() => expect(posts).toEqual([
      { path: '/habits/revoke', body: { id: '时段:13' } },
      { path: '/habits/seen', body: { id: '时段:13' } },
    ]));
  });
});
