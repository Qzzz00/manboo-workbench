/**
 * 手机「资讯」页(2026-09-21)。按项目分组、一句话为什么相关、跟进 / 不看了、播放条。
 *
 * 盯住的几条:
 *   - **三种"空"说三句不同的话**:还没问到 / 中转没配搜索 / 确实没搜到。
 *     一句「暂无资讯」把它们糊在一起等于什么都没说。
 *   - **「不看了」立刻从列表里消失并发请求**(乐观更新),请求失败要把真相拉回来。
 *   - **播客只有文字稿时不摆播放条** —— 摆一个点了没反应的播放键比没有更坏。
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NewsPage } from '../src/feed/NewsPage';
import { emptyNote, metaLine, withFeedback, type NewsView } from '../src/feed/newsModel';
import { parseKeywords } from '../src/feed/NewsSettings';
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

const VIEW: NewsView = {
  date: '2026-09-21',
  groups: [
    {
      project_id: 'p1',
      project_name: '桌面工作台',
      items: [
        { id: 'a', project_id: 'p1', project_name: '桌面工作台', title: '模型又降价了', url: 'https://a.example/1', source: '机器之心', why: '你们的中转就是转这家,成本要重算', score: 5, follow_up: true, date: '2026-09-21', at: 1 },
        { id: 'b', project_id: 'p1', project_name: '桌面工作台', title: '别家也出了桌面端', url: 'https://a.example/2', why: '同类产品,看看它怎么做引导', score: 3, follow_up: false, date: '2026-09-21', at: 1 },
      ],
    },
    {
      project_id: 'p2',
      project_name: '小红书号',
      items: [
        { id: 'c', project_id: 'p2', project_name: '小红书号', title: '平台改了流量规则', url: 'https://a.example/3', source: '新榜', why: '直接影响你这个号的发布节奏', score: 5, follow_up: true, date: '2026-09-21', at: 1 },
      ],
    },
  ],
  podcast: { date: '2026-09-21', script: '今天两件事。第一,模型降价了。', file: 'feed-podcast-2026-09-21.mp3', bytes: 1234, at: 1 },
  config: { version: 1, enabled: true, per_project: 5, podcast: true, podcast_minutes: 4, interests: [{ project_id: 'p1', project_name: '桌面工作台', keywords: ['事务官'] }] },
  last_run_at: 100,
};

interface MountOptions {
  view?: NewsView;
  /** /feed 回什么状态(缺省 200)。 */
  status?: number;
  error?: string;
  feedbackStatus?: number;
}

function mount(options: MountOptions = {}) {
  const posts: { path: string; body: string }[] = [];
  const pairing = { token: 't', host: 'h', port: 8791, deviceId: 'd' };
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const path = url.slice(url.indexOf('/', 'http://'.length));
    if (init?.method === 'POST') posts.push({ path, body: String(init.body ?? '') });
    if (path === '/feed') {
      const status = options.status ?? 200;
      return status === 200
        ? new Response(JSON.stringify(options.view ?? VIEW), { status, headers: { 'content-type': 'application/json' } })
        : new Response(JSON.stringify({ error: options.error ?? '资讯未启用' }), { status, headers: { 'content-type': 'application/json' } });
    }
    if (path === '/feed/feedback') {
      const status = options.feedbackStatus ?? 200;
      return new Response(JSON.stringify(status === 200 ? { ok: true } : { error: '没有这一条资讯' }), { status, headers: { 'content-type': 'application/json' } });
    }
    if (path.startsWith('/feed/podcast')) return new Response(new Blob(['FAKE']), { status: 200 });
    if (path === '/feed/run') return new Response(JSON.stringify({ note: '资讯:2 个项目搜到 4 条' }), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ error: '没这条路' }), { status: 404 });
  }) as typeof fetch;
  const client = createApiClient({ pairing, fetchImpl, onUnauthorized: () => {} });
  const session: Session = {
    pairing,
    client: fakeRouted(client, 'direct'),
    // 合并 merge/sprint-2:会议那张卡给 Session 加了必填的 direct(直连电脑的那条),
    // 这一页用不到它,给真的那个 client 就行。
    direct: client,
    feed: fakeFeed(),
    voice: createVoiceApi(client),
    call: createCallApi(client),
    channel: fakeChannel({}),
    appearance: createAppearanceFeed(client),
    settings: { async load() { throw new Error('用不到'); }, async update() { throw new Error('用不到'); } },
    async unpair() {},
  };
  render(<SessionContext.Provider value={session}><NewsPage /></SessionContext.Provider>);
  return { posts };
}

describe('纯函数', () => {
  it('metaLine:来源 · 发布日;两样都没有就空串', () => {
    expect(metaLine({ ...VIEW.groups[0]!.items[0]!, published_at: '2026-09-20T00:00:00Z' })).toBe('机器之心 · 9月20日');
    expect(metaLine(VIEW.groups[0]!.items[1]!)).toBe('');
  });

  it('emptyNote:三种"空"三句话', () => {
    const base: NewsView = { ...VIEW, groups: [], podcast: undefined };
    expect(emptyNote(base, false)).toContain('正在拿');
    expect(emptyNote({ ...base, last_error: '这台服务器还没配搜索服务' }, true)).toBe('这台服务器还没配搜索服务');
    expect(emptyNote({ ...base, config: { ...base.config, interests: [{ project_id: 'p1', project_name: 'x', keywords: [] }] } }, true)).toContain('关注什么');
    expect(emptyNote(base, true)).toContain('没搜到');
  });

  it('withFeedback:不看了从列表里拿掉,组空了连组一起拿掉', () => {
    const next = withFeedback(VIEW, 'c', 'mute');
    expect(next.groups.map(g => g.project_id)).toEqual(['p1']);
    expect(withFeedback(VIEW, 'a', 'follow').groups[0]!.items[0]!.feedback).toBe('follow');
  });

  it('parseKeywords:中英文逗号顿号空格都算分隔,去重去空', () => {
    expect(parseKeywords('事务官, 桌面、 桌面  Agent')).toEqual(['事务官', '桌面', 'Agent']);
    expect(parseKeywords('   ')).toEqual([]);
  });
});

describe('资讯页', () => {
  it('按项目分组,每条带标题、来源与一句话为什么相关', async () => {
    mount();
    expect(await screen.findByText('桌面工作台')).toBeTruthy();
    expect(screen.getByText('小红书号')).toBeTruthy();
    expect(screen.getByText('模型又降价了')).toBeTruthy();
    expect(screen.getByText('你们的中转就是转这家,成本要重算')).toBeTruthy();
    expect(screen.getByText('机器之心')).toBeTruthy();
  });

  /**
   * 2026-10-13(卡「播客页重做」):**点卡那一下改成深聊**(维护者原话:「我点击之后……
   * 可以与事务官针对这条信息进行深入挖掘和交流」),原文挪到卡上那颗「原文」键。
   * 这一条跟着改成点那颗键 —— 行为变了就改用例,不留一条测着旧行为的绿灯。
   */
  it('卡上那颗「原文」用系统浏览器开原文', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    mount();
    await screen.findByText('模型又降价了');
    fireEvent.click(screen.getAllByText('原文')[0] as HTMLElement);
    expect(open).toHaveBeenCalledWith('https://a.example/1', '_blank', 'noopener,noreferrer');
    open.mockRestore();
  });

  it('「不看了」立刻从列表消失,并把反馈发给工作台', async () => {
    const { posts } = mount();
    await screen.findByText('模型又降价了');
    fireEvent.click(screen.getAllByText('不看了')[0]!);
    await waitFor(() => expect(screen.queryByText('模型又降价了')).toBeNull());
    await waitFor(() => expect(posts.some(p => p.path === '/feed/feedback')).toBe(true));
    expect(JSON.parse(posts.find(p => p.path === '/feed/feedback')!.body)).toEqual({ id: 'a', action: 'mute' });
  });

  it('反馈失败:把真相拉回来,那一条不会因为一次失败的请求就永久消失', async () => {
    mount({ feedbackStatus: 404 });
    await screen.findByText('模型又降价了');
    fireEvent.click(screen.getAllByText('不看了')[0]!);
    await waitFor(() => expect(screen.getByText('模型又降价了')).toBeTruthy());
  });

  it('「跟进」标上之后按钮变「已跟进」', async () => {
    mount();
    await screen.findByText('模型又降价了');
    fireEvent.click(screen.getAllByText('跟进')[0]!);
    expect(await screen.findByText('已跟进')).toBeTruthy();
  });

  it('播客合成好了:有播放条;点播放会去拉音频', async () => {
    const created = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fake');
    mount();
    expect(await screen.findByText('今天的资讯播客')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('播放'));
    await waitFor(() => expect(created).toHaveBeenCalled());
    created.mockRestore();
  });

  it('只有文字稿时不摆播放条,只说一句话 + 文字稿按钮', async () => {
    mount({ view: { ...VIEW, podcast: { date: '2026-09-21', script: '稿子在这', error: '语音合成失败,今天只有文字稿', at: 1 } } });
    expect(await screen.findByText('语音合成失败,今天只有文字稿')).toBeTruthy();
    expect(screen.queryByLabelText('播放')).toBeNull();
    fireEvent.click(screen.getByText('文字稿'));
    expect(await screen.findByText('稿子在这')).toBeTruthy();
  });

  it('中转没配搜索:原样说那句话,不编条目', async () => {
    mount({ view: { ...VIEW, groups: [], podcast: undefined, last_error: '这台服务器还没配搜索服务,资讯这一块暂时用不了。' } });
    expect(await screen.findByText('这台服务器还没配搜索服务,资讯这一块暂时用不了。')).toBeTruthy();
    expect(screen.queryByText('模型又降价了')).toBeNull();
  });

  it('这台工作台压根没接资讯(404):说那一句,不摆「现在搜一轮」', async () => {
    mount({ status: 404, error: '资讯未启用' });
    expect(await screen.findByText('资讯未启用')).toBeTruthy();
    expect(screen.queryByText('现在搜一轮')).toBeNull();
  });

  it('「现在搜一轮」把服务端那句回执原样显示', async () => {
    mount();
    fireEvent.click(await screen.findByText('现在搜一轮'));
    expect(await screen.findByText('资讯:2 个项目搜到 4 条')).toBeTruthy();
  });
});
