/**
 * 手机上的需求卡页(2026-09-23,中秋断点 A)。
 *
 * 盯住的几条:
 *   - **四态**:当前那一格看得出来;点别的一格只翻页签,不改进度(手机这一版压根推不动进度)。
 *   - **推进走同一个口**:`POST /feature/run`,**带的是这张卡的 id** —— 不带名字、不带仓库路径
 *     (那两样服务端自己查,少一条"往哪儿写"的输入就少一把钥匙)。
 *   - **把关三键各发各的路由**:pass / revise / self 同一条 `/feature/review`,action 不同;
 *     「打回」没写那一句时**一个字节都不发**(手机自己就知道的事,不白跑一趟房间代理)。
 *   - **只读**:产物是 <pre> 不是 textarea;唯一的输入框是「打回」那一句。
 *   - **两条路**:同一份接口,局域网直连不通时自动经房间;电脑那头答了 403 就用它的答复,
 *     不再换条路问一遍(那是 routedClient 的老规矩,这里钉住它在需求卡这条路上也成立)。
 *
 * **手机不在手上,这一版没有任何真机验证**:以下全是 jsdom 里的假接口。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FeatureDeckPage } from '../src/feature/FeatureDeckPage';
import { InboxPage } from '../src/items/InboxPage';
import { createFeatureApi } from '../src/feature/featureApi';
import {
  deckRunBadge, defaultFeatureTab, docNote, featureStageOf, featureStageView,
  isFeatureTask, lastDeckRun, lastFeatureReviewOf, lastRecord, orderedFeatureTabs, reviewBlocked,
} from '../src/feature/featureModel';
import { SessionContext, type Session } from '../src/session';
import { createApiClient, type ApiClient, type ApiResult } from '../src/api/client';
import { createVoiceApi } from '../src/api/voice';
import { createCallApi } from '../src/api/call';
import { createAppearanceFeed } from '../src/swarm/appearance';
import { createWbchRoutedClient } from '../src/channel/routedClient';
import { emptyState, type TaskView, type WorkbenchState } from '../src/api/protocol';
import type { FeedSnapshot, StateFeed } from '../src/api/stateFeed';
import { fakeChannel, fakeRouted } from './wbchFakes';
import { dayHmOf, hmOf, pinPhoneClock, unpinPhoneClock } from './clockFixture';

const TASK: TaskView = {
  id: 't-7',
  title: '把座机页的时钟字号调大一号',
  status: 'doing',
  direction: 'mine',
  kind: 'feature',
  feature_stage: '验收',
  project_id: 'p1',
  created_at: '2026-09-23T01:00:00Z',
  updated_at: '2026-09-23T02:00:00Z',
};

const DOCS = {
  ok: true,
  dir: '/Users/example/repo/docs/需求/把座机页的时钟字号调大一号',
  stage: '验收',
  project: 'desktop-workbench',
  project_path: '/Users/example/repo',
  docs: [
    { tab: '需求', file: '需求.md', exists: true, text: '目标:字号大一号', updated_at: '2026-09-23T01:10:00Z' },
    { tab: '子事项', file: '子事项.md', exists: true, text: '1. 改样式(Codex)' },
    { tab: '验收', file: '验收.md', exists: true, text: '三件都回来了', updated_at: '2026-09-23T02:00:00Z' },
    { tab: '记录', file: '记录.md', exists: false },
  ],
  reviews: [
    { at: '2026-09-23T01:30:00Z', tab: '需求', action: 'pass', stage: '梳理' },
  ],
};

function fakeFeed(state: WorkbenchState): StateFeed {
  const snapshot: FeedSnapshot = { state, connected: true, error: undefined };
  return { get: () => snapshot, subscribe: () => () => {}, async refresh() {}, stop() {} };
}

interface MountOptions {
  /** `/feature/docs` 回什么状态(缺省 200)。 */
  docsStatus?: number;
  docsError?: string;
  /** 卡上那一格(缺省 TASK 里那个)。 */
  task?: TaskView;
  state?: WorkbenchState;
  /** 页面:缺省是需求卡页本身;传 'inbox' 就整页挂事项收件箱。 */
  page?: 'deck' | 'inbox';
  /** `/feature/ship` 装成「停在某一步」(200 + ok:false)。 */
  shipStopped?: boolean;
}

function mount(options: MountOptions = {}) {
  const posts: { path: string; body: string }[] = [];
  const pairing = { token: 't', host: 'h', port: 8791, deviceId: 'd' };
  const task = options.task ?? TASK;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const path = url.slice(url.indexOf('/', 'http://'.length));
    if (init?.method === 'POST') posts.push({ path, body: String(init.body ?? '') });
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (path === '/feature/docs') {
      const status = options.docsStatus ?? 200;
      return status === 200
        ? json({ ...DOCS, stage: task.feature_stage ?? '梳理' })
        : json({ error: options.docsError ?? '只能在本机操作需求目录' }, status);
    }
    if (path === '/feature/run') return json({ ok: true, sent: true, stage: task.feature_stage, standin: false, text: '(一整段话)' });
    if (path === '/feature/review') return json({ ok: true, sent: true });
    if (path === '/feature/record') return json({ ok: true, path: '/Users/example/repo/docs/决策记录.md', added: true });
    if (path === '/feature/ship') {
      // 那条闭环失败**照旧 200 + ok:false**(停在第几步是执行结果,不是接口出错)。
      return options.shipStopped === true
        ? json({ ok: false, stopped_at: '全量测试', note: '3 条红的' })
        : json({ ok: true, version: '0.2.67', steps: [] });
    }
    return json({ error: '没这条路' }, 404);
  }) as typeof fetch;
  const client = createApiClient({ pairing, fetchImpl, onUnauthorized: () => {} });
  const state = options.state ?? { ...emptyState(), tasks: { tasks: [task] } };
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
  const view = render(
    <SessionContext.Provider value={session}>
      {options.page === 'inbox' ? <InboxPage /> : <FeatureDeckPage task={task} onClose={() => {}} />}
    </SessionContext.Provider>,
  );
  return { posts, view };
}

/** 最后一条打到某条路上的请求体。 */
function lastPost(posts: { path: string; body: string }[], path: string): Record<string, unknown> {
  const hit = [...posts].reverse().find((one) => one.path === path);
  if (hit === undefined) throw new Error(`一条 ${path} 都没发出去`);
  return JSON.parse(hit.body) as Record<string, unknown>;
}

afterEach(unpinPhoneClock);

describe('纯算那一半', () => {
  it('四态:认不出的归「梳理」,不抛', () => {
    expect(featureStageOf('验收')).toBe('验收');
    expect(featureStageOf(undefined)).toBe('梳理');
    expect(featureStageOf('灵感')).toBe('梳理');
    expect(featureStageView('拆解与派活')).toEqual({ stage: '拆解与派活', index: 2, total: 4 });
  });

  it('页签:这一态的排在最前面,**四个一个都不藏**', () => {
    expect(orderedFeatureTabs('验收')).toEqual(['验收', '需求', '子事项', '记录']);
    expect(orderedFeatureTabs('梳理')).toEqual(['需求', '子事项', '验收', '记录']);
    expect(defaultFeatureTab('记录')).toBe('记录');
  });

  it('只认 kind 判是不是需求卡,不看标题', () => {
    expect(isFeatureTask(TASK)).toBe(true);
    expect(isFeatureTask({ ...TASK, kind: 'topic' })).toBe(false);
    expect(isFeatureTask({ ...TASK, kind: undefined, title: '需求:随便什么' })).toBe(false);
    expect(isFeatureTask(undefined)).toBe(false);
  });

  it('「没有这份」与「这份是空的」说两句不同的话', () => {
    expect(docNote(undefined)).toBe('还没读到这一份');
    expect(docNote({ tab: '记录', file: '记录.md', exists: false })).toContain('还没有 记录.md');
    expect(docNote({ tab: '记录', file: '记录.md', exists: true, text: '' })).toBe('记录.md 是空的');
    expect(docNote({ tab: '记录', file: '记录.md', exists: true, text: 'x' })).toBeUndefined();
    expect(docNote({ tab: '记录', file: '记录.md', exists: true, error: '读不了' })).toBe('读不了');
  });

  it('派活四档:点完按钮那头还没动静 = 排队;一条记录都没有就整段不画', () => {
    expect(deckRunBadge({})).toBeUndefined();
    expect(deckRunBadge({ lastRunAt: '2026-09-23T03:00:00Z' })).toBe('排队');
    expect(deckRunBadge({
      lastRunAt: '2026-09-23T03:00:00Z',
      dispatch: { status: 'running', started_at: '2026-09-23T03:01:00Z' },
    })).toBe('在做');
    expect(deckRunBadge({
      lastRunAt: '2026-09-23T03:00:00Z',
      dispatch: { status: 'done', started_at: '2026-09-23T02:00:00Z' },
    })).toBe('排队');
    expect(deckRunBadge({ clientDispatch: { status: 'failed', at: '2026-09-23T03:02:00Z' } })).toBe('失败');
  });

  it('「打回」没写那一句时在手机这一侧就拦住(省一趟房间代理的往返)', () => {
    expect(reviewBlocked('revise', '  ')).toBe('打回要带一句话:哪儿不对');
    expect(reviewBlocked('revise', '第三件没验')).toBeUndefined();
    expect(reviewBlocked('pass', '')).toBeUndefined();
    expect(reviewBlocked('self', '')).toBeUndefined();
  });

  it('留痕上翻:run / record 不算「你上次说」', () => {
    const reviews = [
      { at: '1', tab: '验收', action: 'pass' as const },
      { at: '2', tab: '验收', action: 'run' as const },
      { at: '3', tab: '记录', action: 'record' as const, text: 'docs/决策记录.md' },
    ];
    expect(lastFeatureReviewOf(reviews, '验收')?.at).toBe('1');
    expect(lastDeckRun(reviews)?.at).toBe('2');
    expect(lastRecord(reviews)?.text).toBe('docs/决策记录.md');
  });
});

describe('四态与产物页签', () => {
  it('四格都在,当前那一格标出来,并写明第几态', async () => {
    mount();
    await screen.findByText('现在:第 3/4 态「验收」');
    for (const stage of ['梳理', '拆解与派活', '验收', '记录']) {
      expect(screen.getByRole('button', { name: stage })).toBeTruthy();
    }
    expect(screen.getByRole('button', { name: '验收' }).getAttribute('aria-current')).toBe('step');
    expect(screen.getByRole('button', { name: '梳理' }).getAttribute('aria-current')).toBeNull();
  });

  it('点别的一格只翻页签,**不改进度**、不发任何请求', async () => {
    const { posts } = mount();
    await screen.findByText('现在:第 3/4 态「验收」');
    const before = posts.length;
    fireEvent.click(screen.getByRole('button', { name: '梳理' }));
    await screen.findByText('点别的一格只是翻页签,不改进度。');
    // 那一行「现在」一个字没变,请求也一条没多。
    expect(screen.getByText('现在:第 3/4 态「验收」')).toBeTruthy();
    expect(posts.length).toBe(before);
    expect(screen.getAllByRole('tab')[0]?.textContent).toBe('需求');
  });

  it('产物只读:正文是 <pre>,页面上没有输入框(「打回」那一句除外)', async () => {
    const { view } = mount();
    await screen.findByText('三件都回来了');
    expect(view.container.querySelector('pre.ba-fd__text')?.textContent).toBe('三件都回来了');
    expect(view.container.querySelector('textarea')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '打回' }));
    expect(view.container.querySelector('textarea')).not.toBeNull();
  });

  it('文件还没有的那一份如实说,不画一份空的', async () => {
    mount();
    await screen.findByText('三件都回来了');
    fireEvent.click(screen.getByRole('tab', { name: '记录' }));
    expect(screen.getByText(/还没有 记录\.md/)).toBeTruthy();
  });

  /**
   * 产物那一行的时刻(2026-10-02,卡 claude/phone-clock):写不写日期照**电脑的钟**判
   * (`/state.now`)—— 这一页原来不订状态流,时刻是按手机的墙钟写的。两条都把手机的钟钉在 9-23
   * (与产物同一天):照手机的钟两条都只写时刻,照 `/state.now` 第二条才带日期。
   */
  const DOC_AT = '2026-09-23T02:00:00Z';
  function stateAt(now: string): WorkbenchState {
    return { ...emptyState(), now, tasks: { tasks: [TASK] } } as WorkbenchState;
  }

  it('★产物那个时刻:/state.now 和它同一天 → 只写时刻(手机的钟在 12-25 也不算数)', async () => {
    pinPhoneClock();
    const { view } = mount({ state: stateAt('2026-09-23T03:00:00Z') });
    await screen.findByText('三件都回来了');
    expect(view.container.querySelector('.ba-item__time')?.textContent).toBe(hmOf(DOC_AT));
  });

  it('★产物那个时刻:/state.now 已经过了两天 → 带「M-DD」(手机的钟还停在那天也不算数)', async () => {
    pinPhoneClock('2026-09-23T03:00:00Z');
    const { view } = mount({ state: stateAt('2026-09-25T03:00:00Z') });
    await screen.findByText('三件都回来了');
    expect(view.container.querySelector('.ba-item__time')?.textContent).toBe(dayHmOf(DOC_AT));
  });
});

describe('推进走同一个口', () => {
  it('「让事务官推进这一步」打 /feature/run,**只带这张卡的 id**', async () => {
    const { posts } = mount();
    await screen.findByText('现在:第 3/4 态「验收」');
    fireEvent.click(screen.getByRole('button', { name: '让事务官推进这一步' }));
    await waitFor(() => expect(lastPost(posts, '/feature/run')).toEqual({ id: 't-7' }));
    await screen.findByText('交给事务官了');
  });

  it('按钮底下那行小字随态换(他按下去之前该知道会发生什么)', async () => {
    mount({ task: { ...TASK, feature_stage: '梳理' } });
    await screen.findByText('把你那一句话问清楚(最多两问),写成需求:目标 / 边界 / 验收标准');
  });
});

describe('把关三键', () => {
  it('通过 / 我自己改:同一条 /feature/review,action 不同,带的是当前页签', async () => {
    const { posts } = mount();
    await screen.findByText('三件都回来了');
    fireEvent.click(screen.getByRole('button', { name: '通过' }));
    await waitFor(() => expect(lastPost(posts, '/feature/review')).toEqual({ id: 't-7', tab: '验收', action: 'pass' }));
    fireEvent.click(screen.getByRole('button', { name: '我自己改' }));
    await waitFor(() => expect(lastPost(posts, '/feature/review')).toEqual({ id: 't-7', tab: '验收', action: 'self' }));
  });

  it('打回:带上那一句;没写那一句时**一条请求都不发**', async () => {
    const { posts } = mount();
    await screen.findByText('三件都回来了');
    fireEvent.click(screen.getByRole('button', { name: '打回' }));
    fireEvent.click(screen.getByRole('button', { name: '打回去' }));
    await screen.findByText('打回要带一句话:哪儿不对');
    expect(posts.some((one) => one.path === '/feature/review')).toBe(false);

    fireEvent.change(screen.getByLabelText('哪儿不对(一句话)'), { target: { value: ' 第三件没验 ' } });
    fireEvent.click(screen.getByRole('button', { name: '打回去' }));
    await waitFor(() => expect(lastPost(posts, '/feature/review'))
      .toEqual({ id: 't-7', tab: '验收', action: 'revise', text: '第三件没验' }));
  });

  it('把关打在**他正看着的那一份**上,不是当前那一态', async () => {
    const { posts } = mount();
    await screen.findByText('三件都回来了');
    fireEvent.click(screen.getByRole('tab', { name: '需求' }));
    fireEvent.click(screen.getByRole('button', { name: '通过' }));
    await waitFor(() => expect(lastPost(posts, '/feature/review').tab).toBe('需求'));
  });
});

describe('写进决策记录', () => {
  it('只在「记录」那一态出现,点一下打 /feature/record', async () => {
    const { posts } = mount({ task: { ...TASK, feature_stage: '记录' } });
    await screen.findByText('现在:第 4/4 态「记录」');
    fireEvent.click(screen.getByRole('button', { name: '写进决策记录' }));
    await waitFor(() => expect(lastPost(posts, '/feature/record')).toEqual({ id: 't-7' }));
    await screen.findByText('写进了 /Users/example/repo/docs/决策记录.md');
  });

  it('别的态里没有这颗按钮', async () => {
    mount();
    await screen.findByText('现在:第 3/4 态「验收」');
    expect(screen.queryByRole('button', { name: '写进决策记录' })).toBeNull();
  });
});

describe('电脑那头说不行的时候', () => {
  /**
   * ★ 2026-09-23「同一个事务官」之后,配对过的手机与本机同权,这几条**本不该再 403**。
   * 所以这一句改了:原样转达电脑那句话,再补一句"多半是配对掉了或电脑上还是旧版本" ——
   * 旧的那句「这几条只认本机」已经不成立了,留着会把人往错的方向带。
   */
  it('403 原样转达,并补一句现在该往哪儿查', async () => {
    mount({ docsStatus: 403, docsError: '只有这台电脑或配对过的设备能操作需求目录' });
    const line = await screen.findByRole('alert');
    expect(line.textContent).toContain('只有这台电脑或配对过的设备能操作需求目录');
    expect(line.textContent).toContain('配对被解除');
    // 旧口径那句话不许再出现。
    expect(line.textContent).not.toContain('只认本机');
  });
});

/**
 * ★ 发版那一颗(2026-09-23,「同一个事务官」)。这一页唯一要按两次的键。
 * Ben 明知:「手机在外面按一下会合并 main 并发一版」—— 所以界面上那一下必须问清楚。
 */
describe('发版(手机上最重的那一下)', () => {
  it('只在「验收」那一态出现', async () => {
    mount({ task: { ...TASK, feature_stage: '记录' } });
    await screen.findByText('现在:第 4/4 态「记录」');
    expect(screen.queryByRole('button', { name: '发版' })).toBeNull();
  });

  it('★ 第一次点**一个字节都不发**,只把「会合并并发一版,确定?」摆出来', async () => {
    const { posts } = mount();
    await screen.findByText('现在:第 3/4 态「验收」');
    fireEvent.click(screen.getByRole('button', { name: '发版' }));
    // 键面换成「确定,发版」,那句话也摆出来了 —— 但一条请求都没发。
    await screen.findByRole('button', { name: '确定,发版' });
    expect(screen.getAllByText('会合并并发一版,确定?').length).toBeGreaterThan(0);
    expect(posts.some((one) => one.path === '/feature/ship')).toBe(false);
  });

  it('★ 第二次才真发,而且**只带这张卡的 id**(那句人话服务端从需求.md 里取)', async () => {
    const { posts } = mount();
    await screen.findByText('现在:第 3/4 态「验收」');
    fireEvent.click(screen.getByRole('button', { name: '发版' }));
    fireEvent.click(await screen.findByRole('button', { name: '确定,发版' }));
    await waitFor(() => expect(lastPost(posts, '/feature/ship')).toEqual({ id: 't-7' }));
    await screen.findByText('发出去了:0.2.67');
  });

  it('「先不发」把话收回去,什么都没发生', async () => {
    const { posts } = mount();
    await screen.findByText('现在:第 3/4 态「验收」');
    fireEvent.click(screen.getByRole('button', { name: '发版' }));
    fireEvent.click(await screen.findByRole('button', { name: '先不发' }));
    await screen.findByRole('button', { name: '发版' });
    expect(posts.some((one) => one.path === '/feature/ship')).toBe(false);
  });

  it('★ 停在某一步:200 + ok:false,如实说停在哪、为什么(不报成"发成了")', async () => {
    mount({ shipStopped: true });
    await screen.findByText('现在:第 3/4 态「验收」');
    fireEvent.click(screen.getByRole('button', { name: '发版' }));
    fireEvent.click(await screen.findByRole('button', { name: '确定,发版' }));
    await screen.findByText('停在「全量测试」:3 条红的');
  });
});

describe('事项标签里点开哪一页', () => {
  it('kind:feature 的卡点开的是需求卡页', async () => {
    mount({ page: 'inbox' });
    fireEvent.click(screen.getByRole('button', { name: /把座机页的时钟字号调大一号/ }));
    await waitFor(() => expect(screen.getByRole('dialog', { name: '需求卡' })).toBeTruthy());
  });

  it('普通事项一字不变:还是那张只读详情卡', async () => {
    const plain: TaskView = { ...TASK, id: 't-8', kind: undefined, feature_stage: undefined, title: '买月饼' };
    mount({ page: 'inbox', task: plain, state: { ...emptyState(), tasks: { tasks: [plain] } } });
    fireEvent.click(screen.getByRole('button', { name: /买月饼/ }));
    await waitFor(() => expect(screen.getByRole('dialog', { name: '事项详情' })).toBeTruthy());
    expect(screen.queryByRole('dialog', { name: '需求卡' })).toBeNull();
  });
});

/**
 * 两条路(2026-09-17 的 routedClient,这里只钉住它在需求卡这条路上也照样成立)。
 * **同一份接口**:`createFeatureApi` 拿到的就是 routedClient,自己不知道走的是哪条。
 */
describe('局域网直连 / 房间代理', () => {
  function stub(result: () => ApiResult<unknown>, log?: string[]): ApiClient {
    return {
      baseUrl: 'http://x',
      async json<T>(path: string) { log?.push(path); return result() as ApiResult<T>; },
      async blob() { return result() as ApiResult<Blob>; },
    };
  }

  it('局域网里直连就够了,不进房间', async () => {
    const directLog: string[] = [];
    const remoteLog: string[] = [];
    const routed = createWbchRoutedClient({
      direct: stub(() => ({ ok: true, status: 200, data: DOCS }), directLog),
      remote: async () => ({ ok: true, client: stub(() => ({ ok: true, status: 200, data: DOCS }), remoteLog) }),
    });
    const result = await createFeatureApi(routed).docs('t-7');
    expect(result.ok).toBe(true);
    expect(directLog).toEqual(['/feature/docs']);
    expect(remoteLog).toEqual([]);
    expect(routed.mode()).toBe('direct');
  });

  it('出了局域网(直连连不上)自动换成房间代理,同一条路径', async () => {
    const remoteLog: string[] = [];
    const routed = createWbchRoutedClient({
      direct: stub(() => ({ ok: false, status: 0, kind: 'network', error: '连不上工作台' })),
      remote: async () => ({ ok: true, client: stub(() => ({ ok: true, status: 200, data: DOCS }), remoteLog) }),
    });
    const result = await createFeatureApi(routed).run('t-7', '第三件没验');
    expect(result.ok).toBe(true);
    expect(remoteLog).toEqual(['/feature/run']);
    expect(routed.mode()).toBe('remote');
  });

  it('**工作台答了 403 就用它的答复**,不再绕房间问第二遍', async () => {
    const remoteLog: string[] = [];
    const routed = createWbchRoutedClient({
      direct: stub(() => ({ ok: false, status: 403, kind: 'http', error: '只能在本机操作需求目录' })),
      remote: async () => ({ ok: true, client: stub(() => ({ ok: true, status: 200, data: DOCS }), remoteLog) }),
    });
    const result = await createFeatureApi(routed).docs('t-7');
    expect(result).toEqual({ ok: false, status: 403, kind: 'http', error: '只能在本机操作需求目录' });
    expect(remoteLog).toEqual([]);
    expect(routed.mode()).toBe('direct');
  });

  it('两条都不通:原样转达直连那句话(它说得最具体)', async () => {
    const routed = createWbchRoutedClient({
      direct: stub(() => ({ ok: false, status: 0, kind: 'network', error: '连不上工作台:确认手机和 Mac 在同一局域网' })),
      remote: async () => ({ ok: false, error: '房间也进不去' }),
    });
    const result = await createFeatureApi(routed).docs('t-7');
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain('同一局域网');
    expect(routed.mode()).toBe('offline');
  });
});
