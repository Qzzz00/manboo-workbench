/**
 * 协作A「继续这件事」手机真浏览器验收页(2026-10-23 复审):真 ItemContinueBox,
 * 真隔离 8791(代理同源),真待发箱(内存 kv —— 重开页面那条「没送到」的还在账上)。
 * 不设配对、不进首页:只验这一格的下级行为(草稿 / 不代选 / 回执 / 断网重试)。
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ItemContinueBox } from '../../src/items/ItemContinueBox';
import { SessionContext, type Session } from '../../src/session';
import { createApiClient } from '../../src/api/client';
import { createVoiceApi } from '../../src/api/voice';
import { createCallApi } from '../../src/api/call';
import { createAppearanceFeed } from '../../src/swarm/appearance';
import { createSendOutbox } from '../../src/outbox/sendOutbox';
import { emptyState } from '../../src/api/protocol';

// 直连端口走 VITE_WB_PORT(真 DSH 验收例 = 8993;缺省同)。浏览器跨端 fetch 对回环来源插件按本机信任。
const WB_PORT = Number(import.meta.env.VITE_WB_PORT ?? 8993)
const pairing = { token: 'browser-acceptance', host: '127.0.0.1', port: WB_PORT, deviceId: 'browser-acceptance' };
const client = createApiClient({ pairing, fetchImpl: fetch as never, onUnauthorized: () => {} });
const memoryKv = (() => {
  const map = new Map<string, string>();
  return {
    async get(key: string) { return map.get(key) ?? null; },
    async set(key: string, value: string) { map.set(key, value); },
  };
})();
const recordingClient = {
  json: async (path: string, options?: unknown) => {
    const result = await client.json(path, options as never);
    // 验收脚本核「同一句重试同一个号」用:最后一次 POST 的原样。
    (globalThis as Record<string, unknown>).__lastPost = { path, body: (options as { body?: unknown } | undefined)?.body ?? null };
    return result as never;
  },
};
const outbox = createSendOutbox({ kv: memoryKv, client: recordingClient });
const feed = {
  get: () => ({ state: { ...emptyState(), stale: false, now: new Date().toISOString() }, connected: true, error: undefined }),
  subscribe: () => () => {},
  async refresh() {},
  stop() {},
};
const ctx: Session = {
  pairing,
  client: client as never,
  direct: client,
  feed: feed as never,
  voice: createVoiceApi(client),
  call: createCallApi(client),
  channel: {} as never,
  appearance: createAppearanceFeed(client),
  outbox: outbox as never,
  settings: { async load() { throw new Error('用不到'); }, async update() { throw new Error('用不到'); } },
  async unpair() {},
};

// 验收脚本读这里:待发箱的账(同一句断网重试 = 同一条账、同一个号)。
(globalThis as Record<string, unknown>).__outbox = () =>
  outbox.list().filter((e) => e.path === '/butler/item/continue').map((e) => ({ key: e.key, state: e.state, text: e.text }));

// 那张卡的 id:URL ?task= 优先(第二来源腿指 Kimi 那件),缺省首页第一张。
const override = new URLSearchParams(location.search).get('task')
const cardId = override ?? await fetch('/state').then(async (res) => {
  const s = await res.json() as { tasks?: { tasks?: { id: string }[] } };
  return s.tasks?.tasks?.[0]?.id ?? 't-1';
}).catch(() => 't-1');
(globalThis as Record<string, unknown>).__cardId = cardId;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SessionContext.Provider value={ctx}>
      <div style={{ padding: '12px 0' }}>
        <ItemContinueBox taskId={cardId} />
      </div>
    </SessionContext.Provider>
  </StrictMode>,
);
