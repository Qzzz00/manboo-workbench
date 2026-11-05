/**
 * 「就这一条资讯深聊」那一层(2026-10-13,卡「播客页重做」★3 / ★4)。
 *
 * 维护者原话:「我点击之后,可以打断正在播放的播客,我可以与事务官针对这条信息进行深入挖掘和
 * 交流,文字和语音两种选项,语音可以是按住说话的那种,也可以是通话,聊完之后的结论同步到电脑的
 * 随手记,如果需要形成待办的则做成事项卡出现在项目区的看板里,要带上来源于」。
 *
 * 盯住的几条:
 *   - **打字与按住说话走同一条路**(同一个 `/feed/dig`),按住说话那一句标一下「说的」;
 *   - 回合带得上去(多轮),事务官的回话原样摆在面板里;
 *   - 「存成随手记」「做成事项」各给回执,发的是**结论 + 这条资讯的 id** ——
 *     来源那一行由 8791 拼(写与读只认 protocol.ts 一处记号);
 *   - 「让它收一句」是**一颗键**,不自动跑:那是多一次模型调用,不替她决定花钱;
 *   - 「打电话聊」先打 `/feed/dig/call` 再开那一通;没接通话时那颗键**灰掉并写明原因**。
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NewsPage } from '../src/feed/NewsPage';
import { DIG_NOTE_DONE, DIG_TASK_DONE, DIG_CALL_OFF } from '../src/feed/DigSheet';
import { conclusionDraft, digMetaLine, turnsForServer, DIG_MAX_TURNS } from '../src/feed/digModel';
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

const VIEW: NewsView = {
  date: '2026-10-13',
  groups: [
    {
      project_id: 'p1',
      project_name: '桌面工作台',
      items: [
        { id: 'a', project_id: 'p1', project_name: '桌面工作台', title: '模型又降价了', url: 'https://a.example/1', source: '机器之心', why: '你们的中转就是转这家,成本要重算', score: 5, follow_up: true, date: '2026-10-13', at: 1 },
      ],
    },
  ],
  podcast: { date: '2026-10-13', script: '今天一件事。', file: 'feed-podcast-2026-10-13.mp3', at: 1 },
  config: { version: 1, enabled: true, per_project: 5, podcast: true, podcast_minutes: 4, interests: [] },
  last_run_at: 100,
};

interface MountOptions {
  /** 这几条路各回什么(缺省都成功)。 */
  digStatus?: number;
  digError?: string;
  noteStatus?: number;
  taskStatus?: number;
  onCall?: () => void;
}

function mount(options: MountOptions = {}) {
  const posts: { path: string; body: Record<string, unknown> }[] = [];
  const pairing = { token: 't', host: 'h', port: 8791, deviceId: 'd' };
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const path = url.slice(url.indexOf('/', 'http://'.length));
    if (init?.method === 'POST') posts.push({ path, body: JSON.parse(String(init.body ?? '{}')) as Record<string, unknown> });
    if (path === '/feed') return new Response(JSON.stringify(VIEW), { status: 200, headers: { 'content-type': 'application/json' } });
    if (path.startsWith('/feed/podcast')) return new Response(new Blob(['FAKE']), { status: 200 });
    if (path === '/feed/dig') {
      const status = options.digStatus ?? 200;
      const body = JSON.parse(String(init?.body ?? '{}')) as { want?: string };
      if (status !== 200) return new Response(JSON.stringify({ error: options.digError ?? '聊不了' }), { status, headers: { 'content-type': 'application/json' } });
      return new Response(
        JSON.stringify({ ok: true, said: body.want === 'conclusion' ? '结论:下周重算中转成本。' : '这家降价对你的中转成本是实打实的一刀。' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (path === '/feed/dig/note') {
      const status = options.noteStatus ?? 200;
      return new Response(JSON.stringify(status === 200 ? { ok: true } : { error: '随手记未启用' }), { status, headers: { 'content-type': 'application/json' } });
    }
    if (path === '/feed/dig/task') {
      const status = options.taskStatus ?? 200;
      return new Response(JSON.stringify(status === 200 ? { ok: true, id: 't-1' } : { error: '任务看板未启用' }), { status, headers: { 'content-type': 'application/json' } });
    }
    if (path === '/feed/dig/call') return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
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
  render(
    <SessionContext.Provider value={session}>
      <NewsPage {...(options.onCall === undefined ? {} : { onCall: options.onCall })} />
    </SessionContext.Provider>,
  );
  return { posts };
}

/** 点开那张卡的深聊面板。 */
async function openDig(): Promise<void> {
  await screen.findByText('模型又降价了');
  fireEvent.click(screen.getAllByText('聊这条')[0] as HTMLElement);
  await screen.findByLabelText('就这一条深聊');
}

async function say(text: string): Promise<void> {
  fireEvent.change(screen.getByLabelText('就这一条问一句'), { target: { value: text } });
  fireEvent.click(screen.getByText('发'));
}

describe('纯函数', () => {
  it('turnsForServer:只留 who / text,最多带 DIG_MAX_TURNS 轮', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ who: 'her' as const, text: `第 ${i} 句`, spoken: true as const }));
    const sent = turnsForServer(many);
    expect(sent).toHaveLength(DIG_MAX_TURNS);
    expect(sent[0]).toEqual({ who: 'her', text: `第 ${20 - DIG_MAX_TURNS} 句` });
  });

  it('conclusionDraft:模型那句优先,否则事务官最后一句,再否则她最后一句,都没有就空', () => {
    const turns = [{ who: 'her' as const, text: '这条讲什么' }, { who: 'butler' as const, text: '降价一半' }];
    expect(conclusionDraft(turns, '收一句')).toBe('收一句');
    expect(conclusionDraft(turns)).toBe('降价一半');
    expect(conclusionDraft([{ who: 'her', text: '只说了一句' }])).toBe('只说了一句');
    expect(conclusionDraft([])).toBe('');
  });

  it('digMetaLine:来源 · 项目;两样都没有就空串', () => {
    expect(digMetaLine({ source: '机器之心', project_name: '桌面工作台' })).toBe('机器之心 · 桌面工作台');
    expect(digMetaLine({ project_name: '桌面工作台' })).toBe('桌面工作台');
    expect(digMetaLine({})).toBe('');
  });
});

describe('深聊面板', () => {
  it('顶上摆这条资讯本身:标题、来源 · 项目、一句话为什么相关、看原文', async () => {
    mount();
    await openDig();
    const sheet = screen.getByLabelText('就这一条深聊');
    expect(sheet.textContent).toContain('模型又降价了');
    expect(sheet.textContent).toContain('机器之心 · 桌面工作台');
    expect(sheet.textContent).toContain('你们的中转就是转这家,成本要重算');
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    fireEvent.click(screen.getByText('看原文'));
    expect(open).toHaveBeenCalledWith('https://a.example/1', '_blank', 'noopener,noreferrer');
    open.mockRestore();
  });

  it('打字发一句:带着这条资讯的 id 去 /feed/dig,回话摆在面板里', async () => {
    const { posts } = mount();
    await openDig();
    await say('这对我的成本有多大影响?');
    expect(await screen.findByText('这家降价对你的中转成本是实打实的一刀。')).toBeTruthy();
    const sent = posts.find(one => one.path === '/feed/dig');
    expect(sent?.body.id).toBe('a');
    expect(sent?.body.text).toBe('这对我的成本有多大影响?');
    expect(sent?.body.turns).toEqual([]);
  });

  it('第二句把刚才那两轮带上去(多轮)', async () => {
    const { posts } = mount();
    await openDig();
    await say('第一问');
    await screen.findByText('这家降价对你的中转成本是实打实的一刀。');
    await say('第二问');
    await waitFor(() => { expect(posts.filter(one => one.path === '/feed/dig')).toHaveLength(2); });
    const second = posts.filter(one => one.path === '/feed/dig')[1];
    expect(second?.body.turns).toEqual([
      { who: 'her', text: '第一问' },
      { who: 'butler', text: '这家降价对你的中转成本是实打实的一刀。' },
    ]);
  });

  it('聊不动时把服务端那句原话摆出来(不改写)', async () => {
    mount({ digStatus: 409, digError: '这台机器上的模型服务还没接上,这一条暂时聊不了' });
    await openDig();
    await say('问一句');
    expect(await screen.findByText('这台机器上的模型服务还没接上,这一条暂时聊不了')).toBeTruthy();
  });

  it('「让它收一句」是一颗键:没点就一次都不问模型要结论', async () => {
    const { posts } = mount();
    await openDig();
    await say('问一句');
    await screen.findByText('这家降价对你的中转成本是实打实的一刀。');
    // 结论那一栏先摆事务官最后那一句 —— **没有**一条 want:'conclusion' 的请求。
    await waitFor(() => {
      expect((screen.getByLabelText('聊完的结论') as HTMLTextAreaElement).value).toBe('这家降价对你的中转成本是实打实的一刀。');
    });
    expect(posts.some(one => one.path === '/feed/dig' && one.body.want === 'conclusion')).toBe(false);
    // 点了才问。
    fireEvent.click(screen.getByText('让它收一句'));
    await waitFor(() => {
      expect((screen.getByLabelText('聊完的结论') as HTMLTextAreaElement).value).toBe('结论:下周重算中转成本。');
    });
    expect(posts.some(one => one.path === '/feed/dig' && one.body.want === 'conclusion')).toBe(true);
  });

  it('她改过结论之后,新回合不再覆盖她写的那一句', async () => {
    mount();
    await openDig();
    fireEvent.change(screen.getByLabelText('聊完的结论'), { target: { value: '我自己写的结论' } });
    await say('再问一句');
    await screen.findByText('这家降价对你的中转成本是实打实的一刀。');
    expect((screen.getByLabelText('聊完的结论') as HTMLTextAreaElement).value).toBe('我自己写的结论');
  });
});

describe('结论回电脑', () => {
  it('存成随手记:发结论 + 这条的 id,给回执', async () => {
    const { posts } = mount();
    await openDig();
    fireEvent.change(screen.getByLabelText('聊完的结论'), { target: { value: '下周重算中转成本' } });
    fireEvent.click(screen.getByText('存成随手记'));
    expect(await screen.findByText(DIG_NOTE_DONE)).toBeTruthy();
    const sent = posts.find(one => one.path === '/feed/dig/note');
    expect(sent?.body).toEqual({ id: 'a', text: '下周重算中转成本' });
  });

  it('做成事项:标题就是结论,给回执', async () => {
    const { posts } = mount();
    await openDig();
    fireEvent.change(screen.getByLabelText('聊完的结论'), { target: { value: '重算中转成本' } });
    fireEvent.click(screen.getByText('做成事项'));
    expect(await screen.findByText(DIG_TASK_DONE)).toBeTruthy();
    expect(posts.find(one => one.path === '/feed/dig/task')?.body).toEqual({ id: 'a', title: '重算中转成本' });
  });

  it('结论是空的:不发请求,说一句让她先写', async () => {
    const { posts } = mount();
    await openDig();
    fireEvent.click(screen.getByText('存成随手记'));
    expect(await screen.findByText(/先写一句结论/)).toBeTruthy();
    expect(posts.some(one => one.path === '/feed/dig/note')).toBe(false);
  });

  it('电脑那边没接随手记 / 看板:原话摆出来,不假装记上了', async () => {
    mount({ noteStatus: 404 });
    await openDig();
    fireEvent.change(screen.getByLabelText('聊完的结论'), { target: { value: '要盯' } });
    fireEvent.click(screen.getByText('存成随手记'));
    expect(await screen.findByText('随手记未启用')).toBeTruthy();
    expect(screen.queryByText(DIG_NOTE_DONE)).toBeNull();
  });
});

describe('打电话聊', () => {
  it('先告诉电脑这一通为哪条打,再开那一通', async () => {
    const onCall = vi.fn();
    const { posts } = mount({ onCall });
    await openDig();
    await say('先打字问一句');
    await screen.findByText('这家降价对你的中转成本是实打实的一刀。');
    fireEvent.click(screen.getByText('打电话聊'));
    await waitFor(() => { expect(onCall).toHaveBeenCalled(); });
    const marked = posts.find(one => one.path === '/feed/dig/call');
    expect(marked?.body.id).toBe('a');
    // 她在手机上已经说过的那几句带上去,电话里不从头问一遍。
    expect(marked?.body.turns).toEqual([
      { who: 'her', text: '先打字问一句' },
      { who: 'butler', text: '这家降价对你的中转成本是实打实的一刀。' },
    ]);
    // 开电话就把这一层收了(她要去听电话,不是对着面板)。
    await waitFor(() => { expect(screen.queryByLabelText('就这一条深聊')).toBeNull(); });
  });

  it('这台机器上通话没接上:那颗键灰掉并写明原因', async () => {
    mount();
    await openDig();
    expect((screen.getByText('打电话聊') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(DIG_CALL_OFF)).toBeTruthy();
  });
});
