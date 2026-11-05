/**
 * 「讲到哪条亮哪条」与那块播放器(2026-10-13,卡「播客页重做」★1 / ★2)。
 *
 * 维护者原话:「语音播放到哪一条的时候,被讲到的资讯卡片能有一个放大的效果表示现在正在讲的是这一条」。
 *
 * 盯住的几条:
 *   - 「这会儿在讲哪条」**只在 `speakingItemId` 判一遍**(页面认的就是它);
 *   - **老播客(没有 segments)一张卡都不亮** —— 宁可不亮,也不按字数猜;
 *   - 播放器那块该有的四样:主题、日期、进度、「第几 / 共几条」;
 *   - 深聊那一层开着 = 播客**暂停**;收起来**接着播**(进度在 `<audio>` 自己身上)。
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NewsPage } from '../src/feed/NewsPage';
import { speakingItemId, speakingPosition, type NewsPodcastSegment, type NewsView } from '../src/feed/newsModel';
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

const SEGMENTS: NewsPodcastSegment[] = [
  { item_id: 'a', start_ms: 4_000, end_ms: 20_000 },
  { item_id: 'b', start_ms: 20_000, end_ms: 36_000, estimated: true },
];

function viewWith(segments?: readonly NewsPodcastSegment[]): NewsView {
  return {
    date: '2026-10-13',
    groups: [
      {
        project_id: 'p1',
        project_name: '桌面工作台',
        items: [
          { id: 'a', project_id: 'p1', project_name: '桌面工作台', title: '模型又降价了', url: 'https://a.example/1', source: '机器之心', why: '成本要重算', score: 5, follow_up: true, date: '2026-10-13', at: 1 },
          { id: 'b', project_id: 'p1', project_name: '桌面工作台', title: '别家也出了桌面端', url: 'https://a.example/2', why: '同类产品', score: 3, follow_up: false, date: '2026-10-13', at: 1 },
        ],
      },
    ],
    podcast: {
      date: '2026-10-13',
      script: '今天两件事。',
      file: 'feed-podcast-2026-10-13.mp3',
      bytes: 1234,
      ...(segments === undefined ? {} : { segments }),
      at: 1,
    },
    config: { version: 1, enabled: true, per_project: 5, podcast: true, podcast_minutes: 4, interests: [{ project_id: 'p1', project_name: '桌面工作台', keywords: ['事务官'] }] },
    last_run_at: 100,
  };
}

function mount(view: NewsView) {
  const pairing = { token: 't', host: 'h', port: 8791, deviceId: 'd' };
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    const path = url.slice(url.indexOf('/', 'http://'.length));
    if (path === '/feed') return new Response(JSON.stringify(view), { status: 200, headers: { 'content-type': 'application/json' } });
    if (path.startsWith('/feed/podcast')) return new Response(new Blob(['FAKE']), { status: 200 });
    return new Response(JSON.stringify({ error: '没这条路' }), { status: 404 });
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
  return render(<SessionContext.Provider value={session}><NewsPage /></SessionContext.Provider>);
}

/** 把音频那一下推到第 `seconds` 秒(jsdom 里 currentTime 不能直接写,按属性盖上去)。 */
function at(audio: HTMLAudioElement, seconds: number, duration = 40): void {
  Object.defineProperty(audio, 'currentTime', { value: seconds, writable: true, configurable: true });
  Object.defineProperty(audio, 'duration', { value: duration, writable: true, configurable: true });
  fireEvent.loadedMetadata(audio);
  fireEvent.timeUpdate(audio);
}

/** 点一下播放把音频挂上来,回那个 `<audio>`。 */
async function startAudio(container: HTMLElement): Promise<HTMLAudioElement> {
  const created = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fake');
  fireEvent.click(await screen.findByLabelText('播放'));
  await waitFor(() => { expect(container.querySelector('audio')).toBeTruthy(); });
  created.mockRestore();
  return container.querySelector('audio') as HTMLAudioElement;
}

describe('纯函数:这会儿在讲哪条', () => {
  it('左闭右开 —— 相邻两段不会有一瞬间两张卡一起亮', () => {
    expect(speakingItemId(SEGMENTS, 3_999)).toBeUndefined();
    expect(speakingItemId(SEGMENTS, 4_000)).toBe('a');
    expect(speakingItemId(SEGMENTS, 19_999)).toBe('a');
    expect(speakingItemId(SEGMENTS, 20_000)).toBe('b');
    expect(speakingItemId(SEGMENTS, 36_000)).toBeUndefined();
  });

  it('没有 segments / 时间不是数:谁都不亮', () => {
    expect(speakingItemId(undefined, 10_000)).toBeUndefined();
    expect(speakingItemId(SEGMENTS, Number.NaN)).toBeUndefined();
    expect(speakingItemId(SEGMENTS, -1)).toBeUndefined();
  });

  it('第几 / 共几条;讲开头结尾时只有「共几条」', () => {
    expect(speakingPosition(SEGMENTS, 25_000)).toEqual({ at: 2, total: 2 });
    expect(speakingPosition(SEGMENTS, 0)).toEqual({ total: 2 });
    expect(speakingPosition(undefined, 0)).toEqual({ total: 0 });
  });
});

describe('资讯页:讲到哪条亮哪条', () => {
  it('播到第一条那一段,只有那张卡标成「正在讲」', async () => {
    const { container } = mount(viewWith(SEGMENTS));
    const audio = await startAudio(container);
    at(audio, 10);
    await waitFor(() => {
      const items = container.querySelectorAll('.ba-news__item');
      expect((items[0] as HTMLElement).dataset.speaking).toBe('true');
      expect((items[1] as HTMLElement).dataset.speaking).toBe('false');
    });
    // 往后播到第二条:亮的那张跟着换,**不会两张一起亮**。
    at(audio, 25);
    await waitFor(() => {
      const items = container.querySelectorAll('.ba-news__item');
      expect((items[0] as HTMLElement).dataset.speaking).toBe('false');
      expect((items[1] as HTMLElement).dataset.speaking).toBe('true');
    });
  });

  it('老播客(没有 segments):播到哪儿都不亮,也不画「第几条」', async () => {
    const { container } = mount(viewWith(undefined));
    const audio = await startAudio(container);
    at(audio, 25);
    await waitFor(() => {
      expect(container.querySelector('.ba-news__item[data-speaking="true"]')).toBeNull();
    });
    expect(screen.queryByText(/共 \d+ 条/)).toBeNull();
  });

  it('播放器那块:主题、日期、进度、第几 / 共几条', async () => {
    const { container } = mount(viewWith(SEGMENTS));
    expect(await screen.findByText('今天的资讯播客')).toBeTruthy();
    expect(screen.getByText('2026-10-13')).toBeTruthy();
    expect(screen.getByLabelText('进度')).toBeTruthy();
    const audio = await startAudio(container);
    at(audio, 25);
    expect(await screen.findByText('第 2 / 2 条')).toBeTruthy();
  });
});

describe('点卡打断播客', () => {
  it('开深聊 = 暂停;收起来接着播', async () => {
    const { container } = mount(viewWith(SEGMENTS));
    const audio = await startAudio(container);
    // jsdom 没实现 play/pause,按真实现在 PodcastBar 里判的是 `el.paused` —— 这里把它与两个方法都接上。
    let paused = false;
    Object.defineProperty(audio, 'paused', { get: () => paused, configurable: true });
    const pause = vi.fn(() => { paused = true; });
    const play = vi.fn(() => { paused = false; });
    Object.defineProperty(audio, 'pause', { value: pause, configurable: true });
    Object.defineProperty(audio, 'play', { value: play, configurable: true });

    fireEvent.click(screen.getAllByText('聊这条')[0] as HTMLElement);
    await waitFor(() => { expect(pause).toHaveBeenCalled(); });
    expect(await screen.findByLabelText('就这一条深聊')).toBeTruthy();

    fireEvent.click(screen.getByText('聊完了,回去听'));
    await waitFor(() => { expect(play).toHaveBeenCalled(); });
    expect(screen.queryByLabelText('就这一条深聊')).toBeNull();
  });

  it('暂停那一下本来没在播:聊完也不替她开播', async () => {
    const { container } = mount(viewWith(SEGMENTS));
    const audio = await startAudio(container);
    Object.defineProperty(audio, 'paused', { get: () => true, configurable: true });
    const play = vi.fn();
    Object.defineProperty(audio, 'play', { value: play, configurable: true });
    fireEvent.click(screen.getAllByText('聊这条')[0] as HTMLElement);
    await screen.findByLabelText('就这一条深聊');
    fireEvent.click(screen.getByText('聊完了,回去听'));
    await waitFor(() => { expect(screen.queryByLabelText('就这一条深聊')).toBeNull(); });
    expect(play).not.toHaveBeenCalled();
  });
});
