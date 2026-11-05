/**
 * 手机「继续这件事」· 四意图(2026-10-26,卡「事务官机制A」;与桌面同一个口同一契约)。
 *
 * 钉:补充是缺省档(不带 intent 字段,老服务端兼容);改方向 / 催一下带 intent 且是动作包的
 * 一部分(换意图 = 新请求号);撤回走单独的键、允许不带字;「只留记录」保持纯留言档;
 * 意图与草稿同存,关页重开不丢;手机协议副本与插件 protocol.ts 同名同值(源文对照)。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CONTINUE_INTENT_LABEL, CONTINUE_LABEL, CONTINUE_RECALL, CONTINUE_RECORD, CONTINUE_PATH,
  ItemContinueBox,
} from '../src/items/ItemContinueBox';
import { SessionContext, type Session } from '../src/session';
import { createApiClient } from '../src/api/client';
import { createVoiceApi } from '../src/api/voice';
import { createCallApi } from '../src/api/call';
import { createAppearanceFeed } from '../src/swarm/appearance';
import { emptyState, ITEM_CONTINUE_BUTLER_KEY, ITEM_SAY_INTENTS, type ItemContinueView, type WorkbenchState } from '../src/api/protocol';
import type { FeedSnapshot, StateFeed } from '../src/api/stateFeed';
import { fakeChannel, fakeRouted } from './wbchFakes';

const NOW = '2026-10-26T06:00:00.000Z';
const TASK_ID = 't-intent01';

const view = (taskId: string, over: Partial<ItemContinueView> = {}): ItemContinueView => ({
  id: taskId,
  sources: [
    { key: ITEM_CONTINUE_BUTLER_KEY, agent: 'dsh', session_id: 's-1', title: '事务官', action: { kind: 'butler' } },
  ],
  ...over,
});

function fakeFeed(): StateFeed {
  const snapshot: FeedSnapshot = { state: { ...emptyState(), stale: false, now: NOW } as WorkbenchState, connected: true, error: undefined };
  return { get: () => snapshot, subscribe: () => () => {}, async refresh() {}, stop() {} };
}

interface Rig { postBody?: unknown }

interface Mounted {
  posts: { path: string; body: Record<string, unknown> }[];
  store: Record<string, string>;
  remount: () => Promise<void>;
  unmount: () => void;
}

function mount(rig: Rig, taskId: string = TASK_ID): Mounted {
  const posts: Mounted['posts'] = [];
  const store: Record<string, string> = {};
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const path = url.slice(url.indexOf('/', 'http://'.length));
    if ((init?.method ?? 'GET') !== 'GET') {
      posts.push({ path, body: init?.body === undefined ? {} : JSON.parse(String(init.body)) as Record<string, unknown> });
    }
    if (path === CONTINUE_PATH) {
      return new Response(JSON.stringify(rig.postBody ?? { ok: true, fact: 'sent', note: '送到了。' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (path.endsWith('/continue')) {
      return new Response(JSON.stringify(view(taskId)), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ error: '没这条路' }), { status: 404 });
  }) as typeof fetch;
  const pairing = { token: 't', host: 'h', port: 8791, deviceId: 'd' };
  const client = createApiClient({ pairing, fetchImpl, onUnauthorized: () => {} });
  const ctx: Session = {
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
  const utils = render(
    <SessionContext.Provider value={ctx}>
      <ItemContinueBox taskId={taskId} />
    </SessionContext.Provider>,
  );
  return {
    posts, store,
    unmount: () => utils.unmount(),
    remount: async () => {
      utils.unmount();
      await act(async () => {
        render(
          <SessionContext.Provider value={ctx}>
            <ItemContinueBox taskId={taskId} />
          </SessionContext.Provider>,
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    },
  };
}

const section = (): HTMLElement => screen.getByRole('region', { name: '继续这件事' });

// 草稿按事项存 localStorage(jsdom 跨用例不清):格与格互串会假红,每条用例清零;组件逐条卸载。
beforeEach(() => {
  try { localStorage.clear(); } catch { /* jsdom 总有 */ }
});

afterEach(() => {
  cleanup();
});

describe('继续这件事 · 四意图(手机)', () => {
  it('缺省「补充一句」:发送不带 intent 字段(与卡 A 之前逐字一致)', async () => {
    const m = mount({});
    await screen.findByRole('region', { name: '继续这件事' });
    const box = within(section()).getByLabelText(CONTINUE_LABEL);
    await act(async () => { fireEvent.change(box, { target: { value: '顺便补一句' } }); });
    await act(async () => { fireEvent.click(within(section()).getByRole('button', { name: '发送' })); });
    await waitFor(() => expect(m.posts.filter(one => one.path === CONTINUE_PATH)).toHaveLength(1));
    expect(m.posts[0]?.body).toMatchObject({ id: TASK_ID, text: '顺便补一句', target: ITEM_CONTINUE_BUTLER_KEY });
    expect(m.posts[0]?.body).not.toHaveProperty('intent');
    expect(String(m.posts[0]?.body.client_key)).toMatch(/^ph-/);
  });

  it('选定「改方向」:body 带 intent:redirect;换意图 = 另一个动作,新请求号', async () => {
    const m = mount({ postBody: { ok: false, fact: 'failed', note: '没办成' } }, 't-intent02');
    await screen.findByRole('region', { name: '继续这件事' });
    const box = within(section()).getByLabelText(CONTINUE_LABEL);
    await act(async () => { fireEvent.change(box, { target: { value: '第一句' } }); });
    await act(async () => { fireEvent.click(within(section()).getByRole('button', { name: '发送' })); });
    await waitFor(() => expect(m.posts.filter(one => one.path === CONTINUE_PATH)).toHaveLength(1));
    const keyA = m.posts[0]?.body.client_key;
    // 换意图,同字再发。
    await act(async () => { fireEvent.change(within(section()).getByLabelText(CONTINUE_INTENT_LABEL), { target: { value: 'redirect' } }); });
    await act(async () => { fireEvent.click(within(section()).getByRole('button', { name: '发送' })); });
    await waitFor(() => expect(m.posts.filter(one => one.path === CONTINUE_PATH)).toHaveLength(2));
    expect(m.posts[1]?.body).toMatchObject({ id: 't-intent02', text: '第一句', intent: 'redirect' });
    expect(m.posts[1]?.body.client_key).not.toBe(keyA);
    // 回执照服务端原话摆。
    expect(await within(section()).findByText('没办成')).toBeTruthy();
  });

  it('「撤回」键:不带字也发得动(intent:recall),带字随键走', async () => {
    const m = mount({}, 't-intent03');
    await screen.findByRole('region', { name: '继续这件事' });
    // 空框撤回。
    await act(async () => { fireEvent.click(within(section()).getByRole('button', { name: CONTINUE_RECALL })); });
    await waitFor(() => expect(m.posts.filter(one => one.path === CONTINUE_PATH)).toHaveLength(1));
    expect(m.posts[0]?.body).toMatchObject({ id: 't-intent03', text: '', intent: 'recall' });
    // 带字撤回:字一并递进。
    const box = within(section()).getByLabelText(CONTINUE_LABEL);
    await act(async () => { fireEvent.change(box, { target: { value: '先不做了' } }); });
    await act(async () => { fireEvent.click(within(section()).getByRole('button', { name: CONTINUE_RECALL })); });
    await waitFor(() => expect(m.posts.filter(one => one.path === CONTINUE_PATH)).toHaveLength(2));
    expect(m.posts[1]?.body).toMatchObject({ text: '先不做了', intent: 'recall' });
  });

  it('「只留记录」保持纯留言档:不带意图、不受意图选择影响', async () => {
    const m = mount({ postBody: { ok: true, fact: 'saved', note: '记下了 —— 这句话留在卡上,没有发给任何人。' } }, 't-intent04');
    await screen.findByRole('region', { name: '继续这件事' });
    const box = within(section()).getByLabelText(CONTINUE_LABEL);
    await act(async () => { fireEvent.change(box, { target: { value: '先记一句' } }); });
    await act(async () => { fireEvent.change(within(section()).getByLabelText(CONTINUE_INTENT_LABEL), { target: { value: 'redirect' } }); });
    await act(async () => { fireEvent.click(within(section()).getByRole('button', { name: CONTINUE_RECORD })); });
    await waitFor(() => expect(m.posts.filter(one => one.path === CONTINUE_PATH)).toHaveLength(1));
    expect(m.posts[0]?.body).toMatchObject({ id: 't-intent04', text: '先记一句', record: true });
    expect(m.posts[0]?.body).not.toHaveProperty('intent');
  });

  it('意图与草稿同存:关页重开,选过的意图还在', async () => {
    const m = mount({}, 't-intent05');
    await screen.findByRole('region', { name: '继续这件事' });
    const box = within(section()).getByLabelText(CONTINUE_LABEL);
    await act(async () => { fireEvent.change(box, { target: { value: '改用手动验收' } }); });
    await act(async () => { fireEvent.change(within(section()).getByLabelText(CONTINUE_INTENT_LABEL), { target: { value: 'redirect' } }); });
    await m.remount();
    expect((await within(section()).findByLabelText(CONTINUE_LABEL) as HTMLTextAreaElement).value).toBe('改用手动验收');
    expect((within(section()).getByLabelText(CONTINUE_INTENT_LABEL) as HTMLSelectElement).value).toBe('redirect');
  });

  it('★协议镜像与插件同名同值(源文对照,不抄死值)', () => {
    const plugin = readFileSync(join(__dirname, '../../workbench-plugin/src/protocol.ts'), 'utf8');
    expect(plugin).toContain(`export type ItemSayIntent = 'supplement' | 'redirect' | 'hurry' | 'recall'`);
    expect(plugin).toContain(`'saved' | 'kept' | 'sent' | 'failed' | 'unsupported' | 'pick' | 'redirected' | 'recalled'`);
    expect(ITEM_SAY_INTENTS).toEqual(['supplement', 'redirect', 'hurry', 'recall']);
  });
});
