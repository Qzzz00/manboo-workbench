/**
 * 手机上在某家那条会话的卡片里**直接回话**(2026-09-27,卡 PS)。
 *
 * 维护者 22:0x 原话:「手机上加一个很实用的功能,现在运行中的卡不是有能看到最近的几轮吗,要及时之外,
 * 还得能直接在下面输入信息,对标最外侧的输入框,能直接把信息发到这个会话窗口里。」
 *
 * 守:
 * ① 能送进去的会话(digest 里 `relay.can`)才摆输入框 —— 用的是**最外侧那个输入框同一个组件**(PhoneComposer);
 * ② 打一句发出去 = `POST /sessions/relay`,带的是**这一条**会话的两个字段(agent + session_id)与他的原话;
 * ③ 送进去了:回执照工作台那句话说,并**立刻再读一次**最近几轮(他自己那句、对方的回话都能看见);
 * ④ 送不进去:人话原因原样摆出来,**他打的字留在框里不丢**;
 * ⑤ 送不进去的会话 / 读不到记录的会话:**不摆输入框**,只有一行人话(不给摆设)。
 */
import { describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { InboxPage } from '../src/items/InboxPage';
import { SessionContext, type Session } from '../src/session';
import { createApiClient } from '../src/api/client';
import { createVoiceApi } from '../src/api/voice';
import { createCallApi } from '../src/api/call';
import { createAppearanceFeed } from '../src/swarm/appearance';
import { emptyState, type SessionDigestView, type SessionView, type WorkbenchState } from '../src/api/protocol';
import type { FeedSnapshot, StateFeed } from '../src/api/stateFeed';
import { fakeChannel, fakeRouted } from './wbchFakes';
import { registryOf } from './registryFixture';

const NOW = '2026-09-27T14:05:00.000Z';
const SESSION_ID = 'cx-9f3a1c2b7e';

function session(over: Partial<SessionView> = {}): SessionView {
  return {
    agent: 'codex', session_id: SESSION_ID, project: 'desktop-workbench', status: 'running',
    title: '把导出 PDF 做出来', elapsed_sec: 14 * 60, unread: false, updated_at: NOW,
    activity: { line: '在跑测试', at: '2026-09-27T14:02:00.000Z' },
    ...over,
  };
}

function state(sessions: SessionView[]): WorkbenchState {
  return { ...emptyState(), stale: false, now: NOW, sessions, agent_registry: registryOf(sessions, ['codex', 'claude']) } as WorkbenchState;
}

function fakeFeed(value: WorkbenchState): StateFeed {
  const snapshot: FeedSnapshot = { state: value, connected: true, error: undefined };
  return { get: () => snapshot, subscribe: () => () => {}, async refresh() {}, stop() {} };
}

const digest = (over: Partial<SessionDigestView> = {}): SessionDigestView => ({
  agent: 'codex',
  session_id: SESSION_ID,
  title: '把导出 PDF 做出来',
  project: 'desktop-workbench',
  status: 'running',
  elapsed_sec: 14 * 60,
  activity: { line: '在跑测试', at: '2026-09-27T14:02:00.000Z' },
  rounds: [{ ask: '加个导出 PDF', reply: '在做,先把按钮摆上。', at: '2026-09-27T14:00:00.000Z' }],
  read_at: NOW,
  relay: { can: true },
  ...over,
});

interface Rig {
  /** 每次读 digest 回什么(按第几次读:不够就用最后那一份)。 */
  digests: { status: number; body: unknown }[];
  /** 捎话那一条回什么。 */
  relay: { status: number; body: unknown };
}

function mount(rig: Rig, sessions: SessionView[] = [session()]) {
  const gets: string[] = [];
  const posts: { path: string; body: unknown }[] = [];
  let read = 0;
  const pairing = { token: 't', host: 'h', port: 8791, deviceId: 'd' };
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const path = url.slice(url.indexOf('/', 'http://'.length));
    const method = init?.method ?? 'GET';
    if (method === 'GET') gets.push(path);
    else posts.push({ path, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
    if (path.startsWith('/sessions/digest')) {
      const one = rig.digests[Math.min(read, rig.digests.length - 1)]!;
      read += 1;
      return new Response(JSON.stringify(one.body), { status: one.status, headers: { 'content-type': 'application/json' } });
    }
    if (path === '/sessions/relay') return new Response(JSON.stringify(rig.relay.body), { status: rig.relay.status, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ error: '没这条路' }), { status: 404 });
  }) as typeof fetch;
  const client = createApiClient({ pairing, fetchImpl, onUnauthorized: () => {} });
  const ctx: Session = {
    pairing,
    client: fakeRouted(client, 'direct'),
    direct: client,
    feed: fakeFeed(state(sessions)),
    voice: createVoiceApi(client),
    call: createCallApi(client),
    channel: fakeChannel({}),
    appearance: createAppearanceFeed(client),
    settings: { async load() { throw new Error('用不到'); }, async update() { throw new Error('用不到'); } },
    async unpair() {},
  };
  const view = render(
    <SessionContext.Provider value={ctx}>
      <InboxPage />
    </SessionContext.Provider>,
  );
  return { gets, posts, view };
}

/** 点开「各家正在办」里那一条,拿到那张详情。 */
async function openSheet(): Promise<HTMLElement> {
  await act(async () => { fireEvent.click(within(screen.getByRole('region', { name: '各家正在办' })).getByRole('button')); });
  return await screen.findByRole('dialog', { name: '会话详情' });
}

async function type(sheet: HTMLElement, text: string): Promise<void> {
  const box = within(sheet).getByLabelText('在这条会话里说一句');
  await act(async () => { fireEvent.change(box, { target: { value: text } }); });
}

describe('会话卡里直接回话', () => {
  // 2026-10-12(卡「手机交代只执行一次」):捎话也带请求号 `client_key`(值随机,只认它在、是手机编的那种)。
  it('★能送进去:打一句点发送 → /sessions/relay 带这一条会话的两个字段与他的原话;回执照工作台那句说;发完立刻再读一次最近几轮', async () => {
    const after = digest({ rounds: [
      { ask: '加个导出 PDF', reply: '在做,先把按钮摆上。', at: '2026-09-27T14:00:00.000Z' },
      { ask: '现在到哪了', reply: '按钮好了,正在接后端。', at: '2026-09-27T14:06:00.000Z' },
    ] });
    const { gets, posts } = mount({
      digests: [{ status: 200, body: digest() }, { status: 200, body: after }],
      relay: { status: 200, body: { ok: true, route: 'window', note: '捎到了 —— 你那句话已经送进 Codex 那条会话里了。' } },
    });
    const sheet = await openSheet();
    await type(sheet, '现在到哪了');
    await act(async () => { fireEvent.click(within(sheet).getByRole('button', { name: '发送' })); });

    expect(posts).toEqual([{ path: '/sessions/relay', body: { agent: 'codex', session_id: SESSION_ID, text: '现在到哪了', client_key: expect.stringMatching(/^ph-/) } }]);
    expect(await within(sheet).findByText(/捎到了/)).toBeTruthy();
    // 发完立刻再读一次(不等下一拍):他自己那句与对方的回话都能看见
    await waitFor(() => expect(gets.filter((path) => path.startsWith('/sessions/digest')).length).toBeGreaterThanOrEqual(2));
    expect(await within(sheet).findByText('按钮好了,正在接后端。')).toBeTruthy();
  });

  /** ───────── 卡 WR(2026-09-28):正在跑的那条 —— 补一句 / 打断并发送 ───────── */
  it('★它在跑:发送键永远是「补一句」(不带 interrupt);打断要另点那颗次级键,而且先问一句', async () => {
    const { posts } = mount({
      digests: [{ status: 200, body: digest({ relay: { can: true, running: true, interrupt: { can: true } } }) }],
      relay: { status: 200, body: { ok: true, route: 'window', note: '捎到了。' } },
    });
    const sheet = await openSheet();
    await type(sheet, '顺手把标题也改一下');
    await act(async () => { fireEvent.click(within(sheet).getByRole('button', { name: '发送' })); });
    // 回车 / 发送键**绝不带 interrupt**:打断一条正在干活的会话不该由按一下发送发生
    expect(posts).toEqual([{ path: '/sessions/relay', body: { agent: 'codex', session_id: SESSION_ID, text: '顺手把标题也改一下', client_key: expect.stringMatching(/^ph-/) } }]);

    // 点那颗次级键:**先问一句**,一个字都还没送出去
    await act(async () => { fireEvent.click(within(sheet).getByRole('button', { name: '打断并发送' })); });
    expect(posts).toHaveLength(1);
    expect(await within(sheet).findByText(/要先停下它/)).toBeTruthy();
    // 写好那句话再按发送 —— 这一次才带 interrupt
    await type(sheet, '别做了,改成先出提纲');
    await act(async () => { fireEvent.click(within(sheet).getByRole('button', { name: '发送' })); });
    expect(posts[1]).toEqual({
      path: '/sessions/relay',
      body: { agent: 'codex', session_id: SESSION_ID, text: '别做了,改成先出提纲', interrupt: true, client_key: expect.stringMatching(/^ph-/) },
    });
  });

  it('★它在跑、可这一路打断不了:不摆那颗键,如实说一句为什么', async () => {
    mount({
      digests: [{ status: 200, body: digest({ relay: { can: true, running: true, interrupt: { can: false, why: '认不出它的停止键,没敢替你按 —— 打断这一下得你自己来' } } }) }],
      relay: { status: 200, body: { ok: true } },
    });
    const sheet = await openSheet();
    expect(await within(sheet).findByText(/认不出它的停止键/)).toBeTruthy();
    expect(within(sheet).queryByRole('button', { name: '打断并发送' })).toBeNull();
    // 「补一句」那个框照旧摆着
    expect(within(sheet).getByLabelText('在这条会话里说一句')).toBeTruthy();
  });

  it('★它停着:没有什么要打断的 —— 那颗次级键不摆', async () => {
    mount({
      digests: [{ status: 200, body: digest({ status: 'done', relay: { can: true, running: false, interrupt: { can: true } } }) }],
      relay: { status: 200, body: { ok: true } },
    });
    const sheet = await openSheet();
    expect(await within(sheet).findByLabelText('在这条会话里说一句')).toBeTruthy();
    expect(within(sheet).queryByRole('button', { name: '打断并发送' })).toBeNull();
  });

  it('★读它的窗口读出来的那一条:最近几轮照工作台那句话说,框照旧摆着', async () => {
    mount({
      digests: [{ status: 200, body: digest({
        rounds: [],
        rounds_note: 'Manus 是读它的窗口读出来的:这里只有标题和最新一句,完整的对话在 Manus 里',
        relay: { can: true, running: false },
      }) }],
      relay: { status: 200, body: { ok: true } },
    });
    const sheet = await openSheet();
    expect(await within(sheet).findByText(/完整的对话在 Manus 里/)).toBeTruthy();
    expect(within(sheet).getByLabelText('在这条会话里说一句')).toBeTruthy();
  });

  it('★送不进去:人话原因原样摆出来,他打的字留在框里不丢', async () => {
    const { posts } = mount({
      digests: [{ status: 200, body: digest() }],
      relay: { status: 200, body: { ok: false, where: 'desk', why: '这句话得你到电脑上的 Codex 里自己说(窗口里没找到那段对话)', note: '捎不进去:这句话得你到电脑上的 Codex 里自己说(窗口里没找到那段对话)' } },
    });
    const sheet = await openSheet();
    await type(sheet, '先停一下');
    await act(async () => { fireEvent.click(within(sheet).getByRole('button', { name: '发送' })); });
    expect(posts).toHaveLength(1);
    expect((await within(sheet).findByText(/捎不进去/)).textContent).toContain('窗口里没找到那段对话');
    expect((within(sheet).getByLabelText('在这条会话里说一句') as HTMLTextAreaElement).value).toBe('先停一下');
  });

  it('★不能送进去的会话:不摆输入框,只有一行人话说清为什么', async () => {
    mount({
      digests: [{ status: 200, body: digest({ relay: { can: false, why: '这句话得你到电脑上的 Kimi 里自己说(认得出是这一家,认不出是它哪一段对话,没敢替你打字)' } }) }],
      relay: { status: 200, body: { ok: true } },
    });
    const sheet = await openSheet();
    expect(await within(sheet).findByText(/认不出是它哪一段对话/)).toBeTruthy();
    expect(within(sheet).queryByLabelText('在这条会话里说一句')).toBeNull();
    expect(within(sheet).queryByRole('button', { name: '发送' })).toBeNull();
  });

  it('读不到这条会话的记录:同样不摆输入框,说一句为什么', async () => {
    mount({
      digests: [{ status: 404, body: { error: '读不到这条会话的记录(可能刚关掉)' } }],
      relay: { status: 200, body: { ok: true } },
    });
    const sheet = await openSheet();
    expect(await within(sheet).findByText(/读不到这条会话的记录/)).toBeTruthy();
    expect(within(sheet).queryByLabelText('在这条会话里说一句')).toBeNull();
  });

  it('旧版工作台(digest 里没有这一格):不摆输入框,说清是这台电脑上的工作台还不会', async () => {
    const { relay: _r, ...old } = digest();
    mount({ digests: [{ status: 200, body: old }], relay: { status: 200, body: { ok: true } } });
    const sheet = await openSheet();
    expect(await within(sheet).findByText(/旧版/)).toBeTruthy();
    expect(within(sheet).queryByLabelText('在这条会话里说一句')).toBeNull();
  });

  it('连不上工作台:回执说连不上,字还在框里', async () => {
    const { posts } = mount({
      digests: [{ status: 200, body: digest() }],
      relay: { status: 500, body: { error: '工作台出错了' } },
    });
    const sheet = await openSheet();
    await type(sheet, '喂');
    await act(async () => { fireEvent.click(within(sheet).getByRole('button', { name: '发送' })); });
    expect(posts).toHaveLength(1);
    await waitFor(() => expect(sheet.querySelector('[data-say="receipt"]')?.textContent ?? '').not.toBe(''));
    expect((within(sheet).getByLabelText('在这条会话里说一句') as HTMLTextAreaElement).value).toBe('喂');
  });
});
