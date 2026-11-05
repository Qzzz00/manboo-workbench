/**
 * 协作区手机验收 harness：生产 CollabPage / StateFeed / Outbox 对隔离工作台。
 *
 * 与 dev/continue-box 同一先例:真生产组件 + 真数据链(真轮询 /state、真 POST /task/comment、
 * 真待发箱)。真实 core 用 run-real-core.mjs 启动；fixture 后端仅用于边界测试。
 * 待发箱落 localStorage:重开页面「没送到」的还在账上,恢复后自动补发可见。
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { CollabPage } from '../../src/collab/CollabPage';
import { SessionContext, type Session } from '../../src/session';
import { createApiClient } from '../../src/api/client';
import { createStateFeed, FEED_OFFLINE_GRACE_MS } from '../../src/api/stateFeed';
import { createVoiceApi } from '../../src/api/voice';
import { createCallApi } from '../../src/api/call';
import { createAppearanceFeed } from '../../src/swarm/appearance';
import { createSendOutbox } from '../../src/outbox/sendOutbox';
import { BackProvider } from '../../src/nav/back';
import { createBackStack } from '../../src/nav/backStack';
import '../../src/styles.css';

// HTTP 与快照 WebSocket 都由同源代理转到本轮隔离 core。
const WB_PORT = Number(import.meta.env.VITE_WB_PORT ?? 10091);
const pairing = { token: 'browser-acceptance', host: '127.0.0.1', port: WB_PORT, deviceId: 'browser-acceptance' };
const client = createApiClient({ pairing, baseUrl: () => location.origin, onUnauthorized: () => {} });

const kv = (() => ({
  async get(key: string) { return localStorage.getItem(key); },
  async set(key: string, value: string) { localStorage.setItem(key, value); },
  async remove(key: string) { localStorage.removeItem(key); },
}))();

// 会话换掉不退订的那半截由页面重开自然处理;这里每 3 秒补发一拍,验收不必等 30 秒。
const outbox = createSendOutbox({
  kv,
  client,
  autoPump: {
    everyMs: 3000,
    networkChanges: (listener) => {
      window.addEventListener('online', listener);
      return () => window.removeEventListener('online', listener);
    },
  },
});

const feed = createStateFeed({ client, pairing, liveBase: () => location.origin, offlineGraceMs: FEED_OFFLINE_GRACE_MS });

// 验收驱动按「系统返回」的那一下(harness 没有原生返回键)。
const backStack = createBackStack();
(globalThis as Record<string, unknown>).__backStack = backStack;

const ctx: Session = {
  pairing,
  client: client as never,
  direct: client,
  feed: feed as never,
  voice: createVoiceApi(client),
  call: createCallApi(client),
  channel: {} as never,
  appearance: createAppearanceFeed(client),
  settings: { async load() { throw new Error('用不到'); }, async update() { throw new Error('用不到'); } },
  outbox,
  async unpair() {},
};

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SessionContext.Provider value={ctx}>
      <BackProvider stack={backStack}>
        <CollabPage />
      </BackProvider>
    </SessionContext.Provider>
  </StrictMode>,
);
