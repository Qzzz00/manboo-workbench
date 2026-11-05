/**
 * 「资讯」页接上 AIDJ 之后的播放条(2026-09-22)。
 *
 * 盯住三件:
 *   ① Aiboo 那期在 → 摆**双主播**播放条(显示谁在说、第几段、话题卡片);
 *   ② 取不到 → **退回上一版那条单人口播**,并在上面用一行小字说清楚为什么(原话);
 *   ③ 这台工作台没接 AIDJ(404)→ 整块当不存在,界面与接它之前**逐字相同**。
 *
 * 另外验一条状态机在真 DOM 上的表现:一段 `ended` → 自动播下一段。
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NewsPage } from '../src/feed/NewsPage';
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

/**
 * jsdom 没实现 `HTMLMediaElement.play`(调一下就往 virtual console 打一整页 Not implemented)。
 * 打个桩当成"放出去了" —— 这一页要验的是**按序播的状态机**,不是 jsdom 能不能解码 mp3。
 */
beforeAll(() => {
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(async () => {});
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
});

function fakeFeed(): StateFeed {
  const snapshot: FeedSnapshot = { state: emptyState(), connected: true, error: undefined };
  return { get: () => snapshot, subscribe: () => () => {}, async refresh() {}, stop() {} };
}

const NEWS: NewsView = {
  date: '2026-09-21',
  groups: [{
    project_id: 'p1',
    project_name: '桌面工作台',
    items: [{
      id: 'a', project_id: 'p1', project_name: '桌面工作台', title: '模型又降价了',
      url: 'https://a.example/1', why: '成本要重算', score: 5, follow_up: true, date: '2026-09-21', at: 1,
    }],
  }],
  // 单人口播那一段**仍然在**(退路),AIDJ 能播时不该摆它。
  podcast: { date: '2026-09-21', script: '今天两件事。', file: 'feed-podcast-2026-09-21.mp3', bytes: 12, at: 1 },
  config: { version: 1, enabled: true, per_project: 5, podcast: true, podcast_minutes: 4, interests: [] },
  last_run_at: 100,
};

const BASE = 'http://your-aiboo-host:3456';

const AIDJ_READY: AidjView = {
  status: 'ready',
  fetched_at: 1,
  config: { enabled: true, base_url: BASE, push_interests: true, token_set: false },
  program: {
    date: '2026-09-21',
    status: 'ready',
    topics: [{ id: 't1', title: 'Gemini 安全测试事故', summary: '…', url: 'https://x.example/1', source: 'MarkTechPost' }],
    segments: [
      { id: 's1', speaker: '机车妹', text: '早啊各位!', audio_url: `${BASE}/uploads/tts/a.mp3`, duration_ms: 5500, tier: 'opening', topic_id: 't1' },
      { id: 's2', speaker: '刘飞', text: '先说第一条。', audio_url: `${BASE}/uploads/tts/b.mp3`, duration_ms: 4500, tier: 'flash', topic_id: 't1' },
    ],
    hosts: ['机车妹', '刘飞'],
    estimated_total_ms: 11 * 60_000,
  },
};

/** `aidj: 'off'` = 这台工作台没接 AIDJ(404)。 */
function mount(aidj: AidjView | 'off') {
  const pairing = { token: 't', host: 'h', port: 8791, deviceId: 'd' };
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const path = url.slice(url.indexOf('/', 'http://'.length));
    if (path === '/feed') return new Response(JSON.stringify(NEWS), { status: 200, headers: { 'content-type': 'application/json' } });
    if (path === '/feed/aidj') {
      return aidj === 'off'
        ? new Response(JSON.stringify({ error: '还没接 Aiboo 的 AIDJ' }), { status: 404, headers: { 'content-type': 'application/json' } })
        : new Response(JSON.stringify(aidj), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (path.startsWith('/feed/podcast')) return new Response(new Blob(['FAKE']), { status: 200 });
    void init;
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

describe('AIDJ 那期在', () => {
  it('摆双主播播放条:谁在说、说什么、第几段、约几分钟', async () => {
    mount(AIDJ_READY);
    expect(await screen.findByText('机车妹')).toBeTruthy();
    expect(screen.getByText('早啊各位!')).toBeTruthy();
    expect(screen.getByText('第 1/2 段 · 约 11 分钟')).toBeTruthy();
    expect(screen.getByText('今天的资讯播客·机车妹 / 刘飞')).toBeTruthy();
  });

  it('带出当前这一段在讲的那张话题卡片(点了用系统浏览器开)', async () => {
    mount(AIDJ_READY);
    expect(await screen.findByText('Gemini 安全测试事故')).toBeTruthy();
  });

  it('**不摆单人口播那条** —— 两条一起摆用户不知道该点哪个', async () => {
    mount(AIDJ_READY);
    await screen.findByText('机车妹');
    expect(screen.queryByText('今天的资讯播客')).toBeNull();
    expect(screen.queryByRole('button', { name: '文字稿' })).toBeNull();
  });

  it('一段播完自动接下一段', async () => {
    const { container } = mount(AIDJ_READY);
    await screen.findByText('机车妹');
    fireEvent.click(screen.getByRole('button', { name: '播放' }));
    const audio = container.querySelector('audio');
    expect(audio?.getAttribute('src')).toBe(`${BASE}/uploads/tts/a.mp3`);
    fireEvent.ended(audio!);
    await waitFor(() => { expect(screen.getByText('刘飞')).toBeTruthy(); });
    expect(container.querySelector('audio')?.getAttribute('src')).toBe(`${BASE}/uploads/tts/b.mp3`);
  });

  it('最后一段播完说「本期播完了」,**不从头循环**', async () => {
    const { container } = mount(AIDJ_READY);
    await screen.findByText('机车妹');
    fireEvent.click(screen.getByRole('button', { name: '播放' }));
    fireEvent.ended(container.querySelector('audio')!);
    await waitFor(() => { expect(screen.getByText('刘飞')).toBeTruthy(); });
    fireEvent.ended(container.querySelector('audio')!);
    await waitFor(() => { expect(screen.getByText('本期播完了。')).toBeTruthy(); });
  });
});

describe('AIDJ 取不到', () => {
  it('Aiboo 今天还没生成 → 退回单人口播 + 说清为什么', async () => {
    mount({ ...AIDJ_READY, status: 'empty', program: undefined });
    expect(await screen.findByText(/还没生成/)).toBeTruthy();
    expect(screen.getByText('今天的资讯播客')).toBeTruthy();
    expect(screen.getByRole('button', { name: '文字稿' })).toBeTruthy();
  });

  it('连不上 Aiboo → **原样显示那句错**,不粉饰', async () => {
    mount({ ...AIDJ_READY, status: 'error', program: undefined, error: '连不上 Aiboo(http://your-aiboo-host:3456):socket hang up' });
    expect(await screen.findByText(/socket hang up/)).toBeTruthy();
    expect(screen.getByText('今天的资讯播客')).toBeTruthy();
  });

  it('开关关着 → 说是关着(不是"取不到")', async () => {
    mount({ ...AIDJ_READY, status: 'off', program: undefined, config: { ...AIDJ_READY.config, enabled: false } });
    expect(await screen.findByText(/关着/)).toBeTruthy();
  });
});

describe('这台工作台没接 AIDJ', () => {
  it('404 → 整块当不存在,与接它之前逐字相同(不多说一句话)', async () => {
    mount('off');
    expect(await screen.findByText('今天的资讯播客')).toBeTruthy();
    expect(screen.queryByText(/Aiboo/)).toBeNull();
    expect(screen.queryByText(/关着/)).toBeNull();
  });
});
