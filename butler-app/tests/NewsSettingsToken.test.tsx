/**
 * 设置 · 资讯偏好里那一格「Aiboo 令牌」(2026-09-22)。
 *
 * Aiboo 把 `/api/dj/*` 的写路由关上了(它那边 `fix/dj-api-auth`),工作台要推信源
 * 就得带一把 `X-Aidj-Token`。这一格就是让 Ben 把那把令牌填进去的地方。
 *
 * 盯住四件:
 *   ① **密码型输入**,而且**回显不出来** —— 服务端只回 `token_set`,这一页拿不到真值;
 *   ② 存了就说「已设置」,没存就说没填;
 *   ③ 点保存发的是 `POST /feed/aidj/config { token }`,**只有这一个键**
 *      (别把别的开关顺手一起冲了);
 *   ④ 这台工作台没接 AIDJ(404)→ 整格不摆(摆一个点了没用的输入框更让人糊涂)。
 */
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NewsSettings } from '../src/feed/NewsSettings';
import type { AidjView } from '../src/feed/aidjModel';
import type { NewsView } from '../src/feed/newsModel';
import { SessionContext, type Session } from '../src/session';
import { createApiClient } from '../src/api/client';
import { createVoiceApi } from '../src/api/voice';
import { createCallApi } from '../src/api/call';
import { createAppearanceFeed } from '../src/swarm/appearance';
import { emptyState } from '../src/api/protocol';
import type { FeedSnapshot, StateFeed } from '../src/api/stateFeed';
import { fakeChannel, fakeRouted } from './wbchFakes';

function fakeFeed(): StateFeed {
  const snapshot: FeedSnapshot = { state: emptyState(), connected: true, error: undefined };
  return { get: () => snapshot, subscribe: () => () => {}, async refresh() {}, stop() {} };
}

const NEWS: NewsView = {
  date: '2026-09-21',
  groups: [],
  config: { version: 1, enabled: true, per_project: 5, podcast: true, podcast_minutes: 4, interests: [] },
  last_run_at: 100,
};

const AIDJ: AidjView = {
  status: 'ready',
  fetched_at: 1,
  config: { enabled: true, base_url: 'http://your-aiboo-host:3456', push_interests: true, token_set: false },
};

/** 记下发给 `/feed/aidj/config` 的每一次 body。`aidj: 'off'` = 这台工作台没接 AIDJ。 */
function mount(aidj: AidjView | 'off') {
  const posts: Record<string, unknown>[] = [];
  let config = aidj === 'off' ? AIDJ.config : aidj.config;
  const pairing = { token: 't', host: 'h', port: 8791, deviceId: 'd' };
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const path = url.slice(url.indexOf('/', 'http://'.length));
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (path === '/feed') return json(NEWS);
    if (path === '/feed/aidj') {
      return aidj === 'off' ? json({ error: '还没接 Aiboo 的 AIDJ' }, 404) : json({ ...aidj, config });
    }
    if (path === '/feed/aidj/config') {
      const patch = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      posts.push(patch);
      // 服务端的口径:令牌**存得下但不回显**,只回 token_set。
      const { token, ...rest } = patch;
      config = {
        ...config,
        ...(rest as Partial<typeof config>),
        ...(typeof token === 'string' ? { token_set: token.trim() !== '' } : {}),
      };
      return json({ ok: true, config });
    }
    return json({ error: '没这条路' }, 404);
  }) as typeof fetch;
  const client = createApiClient({ pairing, fetchImpl, onUnauthorized: () => {} });
  const session: Session = {
    pairing,
    client: fakeRouted(client, 'direct'),
    direct: client,
    feed: fakeFeed(),
    voice: createVoiceApi(client),
    call: createCallApi(client),
    channel: fakeChannel({}),
    appearance: createAppearanceFeed(client),
    settings: { async load() { throw new Error('用不到'); }, async update() { throw new Error('用不到'); } },
    async unpair() {},
  };
  const view = render(<SessionContext.Provider value={session}><NewsSettings /></SessionContext.Provider>);
  return { ...view, posts };
}

describe('资讯偏好 · Aiboo 令牌', () => {
  it('摆一格**密码型**输入,没填时说还没填', async () => {
    mount(AIDJ);
    const input = await screen.findByLabelText('Aiboo 令牌') as HTMLInputElement;
    expect(input.type).toBe('password');
    expect(input.value).toBe('');
    expect(screen.queryByText('已设置')).toBeNull();
  });

  it('存了就说「已设置」,而且**输入框里仍然是空的**(真值不下发)', async () => {
    mount({ ...AIDJ, config: { ...AIDJ.config, token_set: true } });
    expect(await screen.findByText('已设置')).toBeTruthy();
    expect((screen.getByLabelText('Aiboo 令牌') as HTMLInputElement).value).toBe('');
  });

  it('填了点保存 → `POST /feed/aidj/config` **只带 token 一个键**,存完说「已设置」、框子清空', async () => {
    const { posts } = mount(AIDJ);
    const input = await screen.findByLabelText('Aiboo 令牌');
    fireEvent.change(input, { target: { value: '  s3cr3t-abc  ' } });
    fireEvent.click(screen.getByRole('button', { name: '保存令牌' }));
    await waitFor(() => { expect(posts).toHaveLength(1); });
    expect(posts[0]).toEqual({ token: 's3cr3t-abc' });
    expect(await screen.findByText('已设置')).toBeTruthy();
    expect((screen.getByLabelText('Aiboo 令牌') as HTMLInputElement).value).toBe('');
  });

  it('清得掉(发一个空串过去)', async () => {
    const { posts } = mount({ ...AIDJ, config: { ...AIDJ.config, token_set: true } });
    fireEvent.click(await screen.findByRole('button', { name: '清掉令牌' }));
    await waitFor(() => { expect(posts).toHaveLength(1); });
    expect(posts[0]).toEqual({ token: '' });
    await waitFor(() => { expect(screen.queryByText('已设置')).toBeNull(); });
  });

  it('框子空着的时候保存按钮点不动(免得一不留神把存着的那把清了)', async () => {
    mount({ ...AIDJ, config: { ...AIDJ.config, token_set: true } });
    expect((await screen.findByRole('button', { name: '保存令牌' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('这台工作台没接 AIDJ → 整格不摆', async () => {
    mount('off');
    // 「资讯偏好」那一节照常在(这一节不是 AIDJ 的),只是没有令牌那一格。
    expect(await screen.findByText('资讯偏好')).toBeTruthy();
    expect(screen.queryByLabelText('Aiboo 令牌')).toBeNull();
  });
});
