/**
 * 首页球下那一排里「资讯」那颗图标上的小点(2026-10-03 晚,卡 `claude/phone-news-podcast-dot`)。
 *
 * 维护者被问「资讯那颗图标要不要一个角标」时选的是:**要,只标播客有没有** ——
 * 今天那期播客能听时亮一个小点,不写数字。
 *
 * 这一份钉三件:
 *   ① 「今天那期播客能不能听」**只有一处判断**(`playablePodcast`):AIDJ 双主播能播 → 它;
 *      否则工作台自己合成的那段有音频 → 它;都没有 → 没有(只有文字稿不算能听);
 *   ② 资讯那一页摆哪条播放条**认的就是这一处** —— 同一份服务端答复,首页那颗亮不亮与那一页有没有播放条
 *      永远一致(两处各判一遍早晚出「首页亮着点、进去没得听」);
 *   ③ 首页那一问(`useNewsGlance`):两样都问、关着时一样都不问、隔一阵再问一次。
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import { NewsPage } from '../src/feed/NewsPage';
import type { AidjView } from '../src/feed/aidjModel';
import { playablePodcast, type NewsView } from '../src/feed/newsModel';
import { glancePodcast, type NewsGlance } from '../src/stage/stageCardsModel';
import { useNewsGlance } from '../src/stage/useNewsGlance';
import { SessionContext, type Session } from '../src/session';
import { createApiClient } from '../src/api/client';
import { createVoiceApi } from '../src/api/voice';
import { createCallApi } from '../src/api/call';
import { createAppearanceFeed } from '../src/swarm/appearance';
import { emptyState } from '../src/api/protocol';
import type { FeedSnapshot, StateFeed } from '../src/api/stateFeed';
import { fakeChannel, fakeRouted } from './wbchFakes';

beforeAll(() => {
  // jsdom 没实现媒体播放;这一份不按播放,只是别让它往 virtual console 打一整页 Not implemented。
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(async () => {});
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

const BASE = 'http://your-aiboo-host:3456';
const CONFIG = { version: 1 as const, enabled: true, per_project: 5, podcast: true, podcast_minutes: 4, interests: [] };
const view = (over: Partial<NewsView> = {}): NewsView => ({ date: '2026-10-03', groups: [], config: CONFIG, last_run_at: 1, ...over });
const LOCAL_AUDIO = { date: '2026-10-03', script: '今天两件事。', file: 'feed-podcast-2026-10-03.mp3', bytes: 12, at: 1 };
const SCRIPT_ONLY = { date: '2026-10-03', script: '今天两件事。', error: '语音没配', at: 1 };
const PROGRAM = {
  date: '2026-10-03', status: 'ready' as const,
  topics: [{ id: 't1', title: '一条头条', summary: '', url: '', source: '' }],
  segments: [{ id: 's1', speaker: '机车妹', text: '早啊各位!', audio_url: `${BASE}/a.mp3`, duration_ms: 5000 }],
  hosts: ['机车妹', '刘飞'],
  estimated_total_ms: 11 * 60_000,
};
const aidj = (over: Partial<AidjView> = {}): AidjView => ({
  status: 'ready', fetched_at: 1, config: { enabled: true, base_url: BASE, push_interests: true, token_set: false }, program: PROGRAM, ...over,
});

/** 四种都在用的情形:同一份答复喂给判断、资讯页、首页那一问。 */
const CASES: { name: string; feed: NewsView; aidj: AidjView | null; kind: 'aidj' | 'local' | null }[] = [
  { name: 'AIDJ 那期在(单人口播也在)', feed: view({ podcast: LOCAL_AUDIO }), aidj: aidj(), kind: 'aidj' },
  { name: 'AIDJ 不是今天的,工作台那段有音频', feed: view({ podcast: LOCAL_AUDIO }), aidj: aidj({ status: 'stale', error: '最新那期不是今天的' }), kind: 'local' },
  { name: '没接 AIDJ,工作台那段有音频', feed: view({ podcast: LOCAL_AUDIO }), aidj: null, kind: 'local' },
  { name: '只有文字稿', feed: view({ podcast: SCRIPT_ONLY }), aidj: aidj({ status: 'empty', program: undefined }), kind: null },
  { name: '今天什么都没有', feed: view(), aidj: null, kind: null },
];

describe('① 今天那期播客能不能听:一处判断', () => {
  for (const one of CASES) {
    it(`${one.name} → ${one.kind ?? '没有'}`, () => {
      expect(playablePodcast(one.feed, one.aidj)?.kind ?? null).toBe(one.kind);
    });
  }

  it('AIDJ 说 ready 但一段口播都没有:不算能听,退回工作台那段', () => {
    expect(playablePodcast(view({ podcast: LOCAL_AUDIO }), aidj({ program: { ...PROGRAM, segments: [] } }))?.kind).toBe('local');
    expect(playablePodcast(view(), aidj({ program: { ...PROGRAM, segments: [] } }))).toBeNull();
  });

  it('还没问到(没有那一份)就是没有 —— 不猜', () => {
    expect(playablePodcast(undefined, undefined)).toBeNull();
    expect(playablePodcast(undefined, null)).toBeNull();
  });

  it('首页那一份(`NewsGlance`):还没问到、这台工作台没接资讯(404)都是没有;其余照那一处判', () => {
    expect(glancePodcast(undefined)).toBeNull();
    expect(glancePodcast({ asked: false, unavailable: false })).toBeNull();
    // 404 那一种与资讯页一样整块当不存在(那一页这时只说「这台工作台还没接资讯」,不摆播放条)。
    expect(glancePodcast({ asked: true, unavailable: true, aidj: aidj() })).toBeNull();
    for (const one of CASES) {
      const glance: NewsGlance = { asked: true, unavailable: false, view: one.feed, aidj: one.aidj };
      expect(glancePodcast(glance)?.kind ?? null).toBe(one.kind);
    }
  });
});

function sessionFor(feed: NewsView | 404, aidjAnswer: AidjView | 404, asked: string[] = []): Session {
  const pairing = { token: 't', host: 'h', port: 8791, deviceId: 'd' };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    const path = url.slice(url.indexOf('/', 'http://'.length));
    asked.push(path);
    if (path === '/feed') return feed === 404 ? json({ error: '这台工作台没接资讯' }, 404) : json(feed);
    if (path === '/feed/aidj') return aidjAnswer === 404 ? json({ error: '还没接 Aiboo 的 AIDJ' }, 404) : json(aidjAnswer);
    if (path.startsWith('/feed/podcast')) return new Response(new Blob(['FAKE']), { status: 200 });
    return json({ error: '没这条路' }, 404);
  }) as typeof fetch;
  const client = createApiClient({ pairing, fetchImpl, onUnauthorized: () => {} });
  const snapshot: FeedSnapshot = { state: emptyState(), connected: true, error: undefined };
  const stateFeed: StateFeed = { get: () => snapshot, subscribe: () => () => {}, async refresh() {}, stop() {} };
  return {
    pairing,
    client: fakeRouted(client, 'direct'),
    direct: client,
    feed: stateFeed,
    voice: createVoiceApi(client),
    call: createCallApi(client),
    channel: fakeChannel({}),
    appearance: createAppearanceFeed(client),
    settings: { async load() { throw new Error('用不到'); }, async update() { throw new Error('用不到'); } },
    async unpair() {},
  };
}

describe('② 资讯那一页摆哪条播放条,认的就是这一处', () => {
  for (const one of CASES) {
    it(`${one.name}:那一页${one.kind === 'aidj' ? '摆双主播那条' : one.kind === 'local' ? '摆单人口播那条' : '没有能按的播放条'}`, async () => {
      render(<SessionContext.Provider value={sessionFor(one.feed, one.aidj ?? 404)}><NewsPage /></SessionContext.Provider>);
      // 等那一页把两样都问回来(资讯在 → 「现在搜一轮」那颗一直在;等 AIDJ 那一问落地再看)。
      await screen.findByRole('button', { name: '现在搜一轮' });
      await act(async () => {});
      const twoHosts = screen.queryByText('今天的资讯播客·机车妹 / 刘飞');
      const play = screen.queryByRole('button', { name: '播放' });
      if (one.kind === 'aidj') {
        expect(twoHosts).toBeTruthy();
      } else if (one.kind === 'local') {
        expect(twoHosts).toBeNull();
        expect(play).toBeTruthy();
      } else {
        expect(twoHosts).toBeNull();
        expect(play).toBeNull();
      }
    });
  }
});

describe('③ 首页那一问(`useNewsGlance`)', () => {
  it('★两样都问:`/feed` 与 `/feed/aidj`;问回来照那一处判得出今天的播客', async () => {
    const asked: string[] = [];
    const session = sessionFor(view({ podcast: LOCAL_AUDIO }), aidj(), asked);
    const hook = renderHook(() => useNewsGlance(session, { refreshMs: 0 }));
    await waitFor(() => { expect(hook.result.current.asked).toBe(true); });
    expect(asked.sort()).toEqual(['/feed', '/feed/aidj']);
    expect(glancePodcast(hook.result.current)?.kind).toBe('aidj');
  });

  it('★关着(通话里 / 引导里 / 资讯那颗没去处)一样都不问 —— AIDJ 那一问要打 Aiboo 云端', async () => {
    const asked: string[] = [];
    const session = sessionFor(view({ podcast: LOCAL_AUDIO }), aidj(), asked);
    const hook = renderHook(() => useNewsGlance(session, { enabled: false, refreshMs: 0 }));
    await act(async () => {});
    expect(asked).toEqual([]);
    expect(glancePodcast(hook.result.current)).toBeNull();
  });

  it('隔一阵再问一次(真机上是 15 分钟):播客早上才合成好,首页那颗跟着亮', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const asked: string[] = [];
    const session = sessionFor(view(), 404, asked);
    renderHook(() => useNewsGlance(session, { refreshMs: 1000 }));
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    const first = asked.filter((path) => path === '/feed').length;
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(asked.filter((path) => path === '/feed').length).toBe(first + 1);
  });

  /*
   * 手机后台来电那张卡(2026-10-03)默认开了常驻前台服务 + 唤醒锁:App 退到后台、锁屏时 WebView 照样跑,
   * 定时器照样走。那时那颗点没人看,别每 15 分钟让电脑去打一次 Aiboo —— 藏着时到点不问,切回来问一次。
   */
  it('★藏在后台(锁屏 / 切到别的 App)时到点不问;切回前台立刻问一次', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const asked: string[] = [];
    const session = sessionFor(view(), 404, asked);
    let visibility: DocumentVisibilityState = 'visible';
    const spy = vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
    try {
      renderHook(() => useNewsGlance(session, { refreshMs: 1000 }));
      await act(async () => { await vi.advanceTimersByTimeAsync(10); });
      const feeds = () => asked.filter((path) => path === '/feed').length;
      expect(feeds()).toBe(1);
      visibility = 'hidden';
      document.dispatchEvent(new Event('visibilitychange'));
      await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
      expect(feeds()).toBe(1);
      visibility = 'visible';
      document.dispatchEvent(new Event('visibilitychange'));
      await act(async () => { await vi.advanceTimersByTimeAsync(10); });
      expect(feeds()).toBe(2);
    } finally {
      spy.mockRestore();
    }
  });

  it('这台工作台没接资讯(404):问过了,但不亮', async () => {
    const session = sessionFor(404, 404);
    const hook = renderHook(() => useNewsGlance(session, { refreshMs: 0 }));
    await waitFor(() => { expect(hook.result.current.asked).toBe(true); });
    expect(hook.result.current.unavailable).toBe(true);
    expect(glancePodcast(hook.result.current)).toBeNull();
  });
});
