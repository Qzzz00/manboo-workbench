/**
 * 手机事项详情「继续这件事」(2026-10-23,卡 A「同事项接续与动作契约」;10-23 复审一轮补齐)。
 *
 * 守(复审 Important 1/2/3 全钉在这里):
 * ① 歧义不代选:能续的多条时初始**没有**选择,没选就按发送 → 零外发 + 屏上「先选一条再发」;选定哪条只发哪条;
 * ② 走既有待发箱(不另造第二表):先落盘带请求号再发;App 重开补发同一句同号(隔离重放:第二个
 *    outbox 实例 pump → 同一个 client_key 再发一次,服务端按号只办一次);**HTTP 200 但回包
 *    ok:false(pick/unsupported)是业务拒绝** —— 不自动补发、不算已投递。草稿按事项存 localStorage,
 *    关页再开不丢、换事项不串稿;
 * ③ 请求号绑整个动作包:同一句同目标重试同号;换目标/换 record 档换新号;「只留记录」连点只落一条;
 *    送成了打字框清空。
 * 回执三档(送到了/没送到/这条这会儿走不通)照服务端那句原样摆;旧工作台没有这条路 → 这一格不摆。
 */
import { describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ItemContinueBox, CONTINUE_LABEL, CONTINUE_RECORD, CONTINUE_NEED_PICK, CONTINUE_PATH } from '../src/items/ItemContinueBox';
import { SessionContext, type Session } from '../src/session';
import { createApiClient, type ApiResult } from '../src/api/client';
import { createVoiceApi } from '../src/api/voice';
import { createCallApi } from '../src/api/call';
import { createAppearanceFeed } from '../src/swarm/appearance';
import { createSendOutbox, type SendOutbox } from '../src/outbox/sendOutbox';
import { emptyState, ITEM_CONTINUE_BUTLER_KEY, type ItemContinueView, type WorkbenchState } from '../src/api/protocol';
import type { FeedSnapshot, StateFeed } from '../src/api/stateFeed';
import { fakeChannel, fakeRouted } from './wbchFakes';

const NOW = '2026-10-23T14:05:00.000Z';
const TASK_ID = 't-abc123';

const view = (over: Partial<ItemContinueView> = {}): ItemContinueView => ({
  id: TASK_ID,
  sources: [
    { key: ITEM_CONTINUE_BUTLER_KEY, agent: 'dsh', session_id: 's-1', title: '事务官', action: { kind: 'butler' } },
    { key: 'claude:c-1', agent: 'claude', session_id: 'c-1', title: '梳理那一条', action: { kind: 'relay' } },
    { key: 'codex:x-1', agent: 'codex', session_id: 'x-1', title: 'codex 的会话', action: { kind: 'none', why: '这家这会儿送不进' } },
  ],
  ...over,
});

function fakeFeed(): StateFeed {
  const snapshot: FeedSnapshot = { state: { ...emptyState(), stale: false, now: NOW } as WorkbenchState, connected: true, error: undefined };
  return { get: () => snapshot, subscribe: () => () => {}, async refresh() {}, stop() {} };
}

interface Rig {
  viewStatus: number;
  viewBody: unknown;
  postStatus: number;
  postBody: unknown;
  transcriptStatus?: number;
  transcriptBody?: unknown;
}

interface Mounted {
  gets: string[];
  posts: { path: string; body: Record<string, unknown> }[];
  store: Record<string, string>;
  outbox?: SendOutbox;
  remount: () => Promise<void>;
  unmount: () => void;
}

/** 造一个带记录器的 fetch;postBody 可以是数组(第几次发拿第几个,不够取最后一个)。 */
function recorder(rig: Rig, posts: Mounted['posts'], gets: string[]) {
  let postCount = 0;
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const path = url.slice(url.indexOf('/', 'http://'.length));
    const method = init?.method ?? 'GET';
    if (method === 'GET') gets.push(path);
    else {
      const body = init?.body === undefined ? {} : JSON.parse(String(init.body)) as Record<string, unknown>;
      posts.push({ path, body });
      postCount += 1;
    }
    if (path === CONTINUE_PATH) {
      const one = Array.isArray(rig.postBody) ? rig.postBody[Math.min(postCount - 1, rig.postBody.length - 1)] : rig.postBody;
      return new Response(JSON.stringify(one), { status: rig.postStatus, headers: { 'content-type': 'application/json' } });
    }
    if (path.startsWith('/sessions/transcript?')) {
      return new Response(JSON.stringify(rig.transcriptBody ?? { error: '这条 CLI 会话还没落盘' }), { status: rig.transcriptStatus ?? 404, headers: { 'content-type': 'application/json' } });
    }
    if (path.endsWith('/continue')) {
      return new Response(JSON.stringify(rig.viewBody), { status: rig.viewStatus, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ error: '没这条路' }), { status: 404 });
  }) as typeof fetch;
}

function mount(rig: Rig, opts: { withOutbox?: boolean } = {}): Mounted {
  const gets: string[] = [];
  const posts: Mounted['posts'] = [];
  const store: Record<string, string> = {};
  const fetchImpl = recorder(rig, posts, gets);
  const pairing = { token: 't', host: 'h', port: 8791, deviceId: 'd' };
  const client = createApiClient({ pairing, fetchImpl, onUnauthorized: () => {} });
  const outbox: SendOutbox | undefined = opts.withOutbox === true
    ? createSendOutbox({
        kv: {
          async get(key: string) { return store[key] ?? null; },
          async set(key: string, value: string) { store[key] = value; },
          async remove(key: string) { delete store[key]; },
        },
        client: { json: <T,>(path: string, options?: unknown) => client.json<T>(path, options as never) as Promise<ApiResult<T>> },
      })
    : undefined;
  const ctx: Session = {
    pairing,
    client: fakeRouted(client, 'direct'),
    direct: client,
    feed: fakeFeed(),
    voice: createVoiceApi(client),
    call: createCallApi(client),
    channel: fakeChannel({}),
    appearance: createAppearanceFeed(client),
    ...(outbox === undefined ? {} : { outbox }),
    settings: { async load() { throw new Error('用不到'); }, async update() { throw new Error('用不到'); } },
    async unpair() {},
  };
  const utils = render(
    <SessionContext.Provider value={ctx}>
      <ItemContinueBox taskId={TASK_ID} />
    </SessionContext.Provider>,
  );
  return {
    gets, posts, store, outbox,
    unmount: () => utils.unmount(),
    remount: async () => {
      utils.unmount();
      await act(async () => {
        render(
          <SessionContext.Provider value={ctx}>
            <ItemContinueBox taskId={TASK_ID} />
          </SessionContext.Provider>,
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    },
  };
}

const section = (): HTMLElement => screen.getByRole('region', { name: '继续这件事' });

async function type(text: string): Promise<void> {
  // composer 等草稿恢复才挂(它的初始文字只在挂载那一刻读)——等它出现再打字。
  const box = await within(section()).findByLabelText(CONTINUE_LABEL);
  await act(async () => { fireEvent.change(box, { target: { value: text } }); });
}

describe('事项详情「继续这件事」', () => {
  it('打开读来源清单:能续的列出来,不能续的带那句为什么', async () => {
    const m = mount({ viewStatus: 200, viewBody: view(), postStatus: 200, postBody: {} });
    expect(await screen.findByRole('region', { name: '继续这件事' })).toBeTruthy();
    expect(m.gets).toContain(`/butler/item/${TASK_ID}/continue`);
    expect(within(section()).getByLabelText('发给哪一条会话')).toBeTruthy();
    expect(within(section()).getByText(/这家这会儿送不进/)).toBeTruthy();
  });

  it('★歧义不代选:多条能续初始未选;没选就按发送 → 零外发 + 屏上「先选一条」;选定后只发那一条', async () => {
    const m = mount({
      viewStatus: 200,
      viewBody: view(),
      postStatus: 200,
      postBody: { ok: true, fact: 'sent', note: '送到了。' },
    });
    await screen.findByRole('region', { name: '继续这件事' });
    const select = within(section()).getByLabelText('发给哪一条会话') as HTMLSelectElement;
    expect(select.value).toBe('');
    await type('还没选就打字');
    await act(async () => { fireEvent.click(within(section()).getByRole('button', { name: '发送' })); });
    expect(await within(section()).findByText(CONTINUE_NEED_PICK)).toBeTruthy();
    expect(m.posts.filter(one => one.path === CONTINUE_PATH)).toHaveLength(0);
    // 选定 claude → 只发 claude。
    await act(async () => { fireEvent.change(select, { target: { value: 'claude:c-1' } }); });
    await act(async () => { fireEvent.click(within(section()).getByRole('button', { name: '发送' })); });
    await waitFor(() => expect(m.posts.filter(one => one.path === CONTINUE_PATH)).toHaveLength(1));
    expect(m.posts[0]?.body).toMatchObject({ id: TASK_ID, text: '还没选就打字', target: 'claude:c-1' });
    expect(await within(section()).findByText('送到了。')).toBeTruthy();
  });

  it('★送成了:打字框清空、草稿清掉(直接档同样生效)', async () => {
    const m = mount({
      viewStatus: 200,
      viewBody: view({ sources: [view().sources[0]!] }),
      postStatus: 200,
      postBody: { ok: true, fact: 'sent', note: '送到了。' },
    });
    await screen.findByRole('region', { name: '继续这件事' });
    await type('发完就清');
    await act(async () => { fireEvent.click(within(section()).getByRole('button', { name: '发送' })); });
    expect(await within(section()).findByText('送到了。')).toBeTruthy();
    expect((within(section()).getByLabelText(CONTINUE_LABEL) as HTMLTextAreaElement).value).toBe('');
    // 关页再开:草稿不再回来。
    await m.remount();
    expect((await within(section()).findByLabelText(CONTINUE_LABEL) as HTMLTextAreaElement).value).toBe('');
  });

  it('★没送到:原因摆出来、字留在框里;同一句再发同一个号(动作包没变)', async () => {
    const m = mount({ viewStatus: 200, viewBody: view(), postStatus: 500, postBody: { error: '内部错误' } });
    await screen.findByRole('region', { name: '继续这件事' });
    await act(async () => { fireEvent.change(within(section()).getByLabelText('发给哪一条会话'), { target: { value: 'claude:c-1' } }); });
    await type('别丢这句话');
    await act(async () => { fireEvent.click(within(section()).getByRole('button', { name: '发送' })); });
    expect(await within(section()).findByText(/没送到/)).toBeTruthy();
    expect((within(section()).getByLabelText(CONTINUE_LABEL) as HTMLTextAreaElement).value).toBe('别丢这句话');
    const firstKey = m.posts[0]?.body.client_key;
    expect(String(firstKey)).toMatch(/^ph-/);
    await act(async () => { fireEvent.click(within(section()).getByRole('button', { name: '发送' })); });
    await waitFor(() => expect(m.posts.filter(one => one.path === CONTINUE_PATH)).toHaveLength(2));
    expect(m.posts[1]?.body.client_key).toBe(firstKey);
  });

  it('★留着等它醒(kept):工作台那句原样摆,不说「已送到」', async () => {
    const m = mount({
      viewStatus: 200, viewBody: view(), postStatus: 200,
      postBody: { ok: true, fact: 'kept', delivered: 'kept', note: '那条会话没开着,这句我留着,它一开就送进去' },
    });
    await screen.findByRole('region', { name: '继续这件事' });
    await act(async () => { fireEvent.change(within(section()).getByLabelText('发给哪一条会话'), { target: { value: 'claude:c-1' } }); });
    await type('醒了再看');
    await act(async () => { fireEvent.click(within(section()).getByRole('button', { name: '发送' })); });
    expect(await within(section()).findByText('那条会话没开着,这句我留着,它一开就送进去')).toBeTruthy();
    expect(within(section()).queryByText(/已送到/)).toBeNull();
    expect(m.posts.length).toBeGreaterThan(0);
  });

  it('★只留记录:record 档、不带给谁;连点只落一条(在途锁);送成清框', async () => {
    const m = mount({
      viewStatus: 200, viewBody: view(), postStatus: 200,
      postBody: { ok: true, fact: 'saved', note: '记下了 —— 这句话留在卡上,没有发给任何人。' },
    });
    await screen.findByRole('region', { name: '继续这件事' });
    await type('先记一句');
    const recordBtn = within(section()).getByRole('button', { name: CONTINUE_RECORD });
    await act(async () => { fireEvent.click(recordBtn); });
    await act(async () => { fireEvent.click(recordBtn); });
    await waitFor(() => expect(m.posts.filter(one => one.path === CONTINUE_PATH)).toHaveLength(1));
    expect(m.posts[0]?.body).toMatchObject({ id: TASK_ID, text: '先记一句', record: true });
    expect(m.posts[0]?.body).not.toHaveProperty('target');
    expect(await within(section()).findByText('记下了 —— 这句话留在卡上,没有发给任何人。')).toBeTruthy();
    expect((within(section()).getByLabelText(CONTINUE_LABEL) as HTMLTextAreaElement).value).toBe('');
  });

  it('★草稿按事项留着:关页再开字与选择都在;换事项不串稿', async () => {
    const m = mount({ viewStatus: 200, viewBody: view(), postStatus: 200, postBody: {} });
    await screen.findByRole('region', { name: '继续这件事' });
    await act(async () => { fireEvent.change(within(section()).getByLabelText('发给哪一条会话'), { target: { value: 'claude:c-1' } }); });
    await type('给这件事打的草稿');
    await m.remount();
    expect((await within(section()).findByLabelText(CONTINUE_LABEL) as HTMLTextAreaElement).value).toBe('给这件事打的草稿');
    expect((within(section()).getByLabelText('发给哪一条会话') as HTMLSelectElement).value).toBe('claude:c-1');
  });

  it('只有一条能续:不摆选择,直接发', async () => {
    const m = mount({
      viewStatus: 200,
      viewBody: view({ sources: [view().sources[0]!] }),
      postStatus: 200,
      postBody: { ok: true, fact: 'sent', note: '送到了。' },
    });
    await screen.findByRole('region', { name: '继续这件事' });
    expect(within(section()).queryByLabelText('发给哪一条会话')).toBeNull();
    await type('接着做');
    await act(async () => { fireEvent.click(within(section()).getByRole('button', { name: '发送' })); });
    await waitFor(() => expect(m.posts.filter(one => one.path === CONTINUE_PATH)).toHaveLength(1));
    expect(m.posts[0]?.body).toMatchObject({ id: TASK_ID, text: '接着做', target: ITEM_CONTINUE_BUTLER_KEY });
  });

  it('已登记但不支持发送的 Codex 原件可独立查看，不先捎话或伪造派发', async () => {
    const source = { key: 'codex:registered', agent: 'codex', session_id: 'registered', title: '已登记 Codex 原件', action: { kind: 'none' as const, why: 'CLI 来源暂不支持捎话' } };
    const m = mount({ viewStatus: 200, viewBody: view({ sources: [source] }), postStatus: 200, postBody: {}, transcriptStatus: 200,
      transcriptBody: { agent: 'codex', session_id: source.session_id, read_at: NOW, entries: [{ k: 'reply', text: '受信原件已有真实回复' }] } });
    fireEvent.click(await screen.findByRole('button', { name: '查看原会话：已登记 Codex 原件' }));
    await screen.findByText('受信原件已有真实回复');
    expect(m.gets).toContain('/sessions/transcript?agent=codex&id=registered');
    expect(m.posts).toEqual([]);
    expect(screen.getByText(/CLI 来源暂不支持捎话/)).toBeTruthy();
    m.unmount();
  });

  it('★原件接续送达后按服务端 source 读 transcript turns,显示真实会话回话', async () => {
    const kimi = { key: 'kimi:session-1c-qa', agent: 'kimi', session_id: 'session-1c-qa', title: 'Kimi 原件', action: { kind: 'relay' as const } };
    const m = mount({
      viewStatus: 200, viewBody: view({ sources: [kimi] }), postStatus: 200,
      postBody: { ok: true, fact: 'sent', target: kimi.key, note: '送到了。' },
      transcriptStatus: 200,
      transcriptBody: { agent: 'kimi', session_id: kimi.session_id, read_at: NOW, turns: [{ k: 'ask', text: '补一句:只回复口令' }, { k: 'reply', text: 'QA_1C_CONTINUATION_RECEIPT' }] },
    });
    await screen.findByRole('region', { name: '继续这件事' });
    await type('补一句:只回复口令');
    await act(async () => { fireEvent.click(within(section()).getByRole('button', { name: '发送' })); });
    expect(await within(section()).findByText('QA_1C_CONTINUATION_RECEIPT')).toBeTruthy();
    expect(m.gets).toContain('/sessions/transcript?agent=kimi&id=session-1c-qa');
  });

  it('★回读目标以接续服务端回执 target 为准，不按提交选择猜来源', async () => {
    const kimi = { key: 'kimi:session-1c-qa', agent: 'kimi', session_id: 'session-1c-qa', title: 'Kimi 原件', action: { kind: 'relay' as const } };
    const claude = { key: 'claude:c-1', agent: 'claude', session_id: 'c-1', title: 'Claude 原件', action: { kind: 'relay' as const } };
    const m = mount({
      viewStatus: 200, viewBody: view({ sources: [claude, kimi] }), postStatus: 200,
      postBody: { ok: true, fact: 'sent', target: kimi.key, note: '送到了。' },
      transcriptStatus: 200,
      transcriptBody: { agent: 'kimi', session_id: kimi.session_id, turns: [{ k: 'reply', text: '来自服务端实际目标' }] },
    });
    await screen.findByRole('region', { name: '继续这件事' });
    await act(async () => { fireEvent.change(within(section()).getByLabelText('发给哪一条会话'), { target: { value: claude.key } }); });
    await type('接续原件');
    await act(async () => { fireEvent.click(within(section()).getByRole('button', { name: '发送' })); });
    expect(await within(section()).findByText('来自服务端实际目标')).toBeTruthy();
    expect(m.gets).toContain('/sessions/transcript?agent=kimi&id=session-1c-qa');
  });

  it('旧工作台没有这条路(404)→ 这一格不摆', async () => {
    mount({ viewStatus: 404, viewBody: { error: '没这条路' }, postStatus: 200, postBody: {} });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
    expect(screen.queryByRole('region', { name: '继续这件事' })).toBeNull();
  });
});

describe('待发箱那一档(复审 Important 2/3)', () => {
  it('★走既有待发箱:先落盘再发;App 重开补发**同一句同一个号**;送成了账上划掉', async () => {
    const m = mount({ viewStatus: 200, viewBody: view(), postStatus: 500, postBody: { error: '内部错误' } }, { withOutbox: true });
    await screen.findByRole('region', { name: '继续这件事' });
    await act(async () => { fireEvent.change(within(section()).getByLabelText('发给哪一条会话'), { target: { value: 'claude:c-1' } }); });
    await type('杀进程前这句');
    await act(async () => { fireEvent.click(within(section()).getByRole('button', { name: '发送' })); });
    expect(await within(section()).findByText(/没送到/)).toBeTruthy();
    // 落盘了:账上有一条 unsent,带着同一个号。
    const firstKey = m.posts[0]?.body.client_key;
    expect(String(firstKey)).toMatch(/^ph-/);
    expect(m.store['wb.send.outbox.v1']).toContain(String(firstKey));
    // ★模拟 App 被杀重开:同一个 kv 起第二个待发箱,pump → 同一句同一个号再发一次。
    const posts2: Mounted['posts'] = [];
    const gets2: string[] = [];
    const rig2: Rig = { viewStatus: 200, viewBody: view(), postStatus: 200, postBody: { ok: true, fact: 'sent', note: '送到了。' } };
    const fetch2 = recorder(rig2, posts2, gets2);
    const pairing = { token: 't', host: 'h', port: 8791, deviceId: 'd' };
    const client2 = createApiClient({ pairing, fetchImpl: fetch2, onUnauthorized: () => {} });
    const outbox2 = createSendOutbox({
      kv: {
        async get(key: string) { return m.store[key] ?? null; },
        async set(key: string, value: string) { m.store[key] = value; },
        async remove(key: string) { delete m.store[key]; },
      },
      client: { json: <T,>(path: string, options?: unknown) => client2.json<T>(path, options as never) as Promise<ApiResult<T>> },
    });
    await outbox2.pump();
    expect(posts2.filter(one => one.path === CONTINUE_PATH)).toHaveLength(1);
    expect(posts2[0]?.body.client_key).toBe(firstKey);
    expect(posts2[0]?.body.text).toBe('杀进程前这句');
  });

  it('★HTTP 200 但回包说没办成(pick/unsupported)= 业务拒绝:不自动补发、不当已投递,字留着', async () => {
    const m = mount({
      viewStatus: 200, viewBody: view(), postStatus: 200,
      postBody: { ok: false, fact: 'unsupported', note: '这家这会儿送不进' },
    }, { withOutbox: true });
    await screen.findByRole('region', { name: '继续这件事' });
    await act(async () => { fireEvent.change(within(section()).getByLabelText('发给哪一条会话'), { target: { value: 'claude:c-1' } }); });
    await type('送不进的这句');
    await act(async () => { fireEvent.click(within(section()).getByRole('button', { name: '发送' })); });
    expect(await within(section()).findByText('这家这会儿送不进')).toBeTruthy();
    // 账上标了 rejected:pump 不会把它再发出去。
    expect(m.store['wb.send.outbox.v1']).toContain('"rejected"');
    const before = m.posts.length;
    await m.outbox?.pump();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(m.posts.length).toBe(before);
    // 字留着 —— 那句话还没落地。
    expect((within(section()).getByLabelText(CONTINUE_LABEL) as HTMLTextAreaElement).value).toBe('送不进的这句');
  });

  it('换目标 / 换 record 档 = 另一个动作:新号,不复用上一条的号', async () => {
    const m = mount({
      viewStatus: 200, viewBody: view(), postStatus: 200,
      postBody: [
        { ok: true, fact: 'sent', note: '送到了。' },
        { ok: true, fact: 'saved', note: '记下了。' },
      ],
    }, { withOutbox: true });
    await screen.findByRole('region', { name: '继续这件事' });
    const select = within(section()).getByLabelText('发给哪一条会话') as HTMLSelectElement;
    await act(async () => { fireEvent.change(select, { target: { value: 'claude:c-1' } }); });
    await type('同一句字');
    await act(async () => { fireEvent.click(within(section()).getByRole('button', { name: '发送' })); });
    await waitFor(() => expect(m.posts.filter(one => one.path === CONTINUE_PATH)).toHaveLength(1));
    const keyA = m.posts[0]?.body.client_key;
    // 换 record 档,同一个字:另一个动作,新号。
    await type('同一句字');
    await act(async () => { fireEvent.click(within(section()).getByRole('button', { name: CONTINUE_RECORD })); });
    await waitFor(() => expect(m.posts.filter(one => one.path === CONTINUE_PATH)).toHaveLength(2));
    const keyB = m.posts[1]?.body.client_key;
    expect(keyB).not.toBe(keyA);
    expect(m.posts[1]?.body).toMatchObject({ record: true });
  });
});

describe('接续契约与插件那头一个字不差', () => {
  it('事务官来源键两边同名同值;请求号白名单两边同步加了 /butler/item/continue', () => {
    const plugin = readFileSync(join(import.meta.dirname, '..', '..', 'workbench-plugin', 'src', 'protocol.ts'), 'utf8');
    expect(plugin).toContain(`export const ITEM_CONTINUE_BUTLER_KEY = 'butler'`);
    expect(ITEM_CONTINUE_BUTLER_KEY).toBe('butler');
    const pluginKeys = readFileSync(join(import.meta.dirname, '..', '..', 'workbench-plugin', 'src', 'server', 'clientKeys.ts'), 'utf8');
    expect(pluginKeys).toContain(`'/butler/item/continue'`);
    const phoneKeys = readFileSync(join(import.meta.dirname, '..', 'src', 'channel', 'clientKey.ts'), 'utf8');
    expect(phoneKeys).toContain(`'/butler/item/continue'`);
  });
});
