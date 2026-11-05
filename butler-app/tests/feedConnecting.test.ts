// 「正在连接」与「电脑不在线」分开说(2026-09-30,维护者:「每次手机客户端一上来会先显示电脑不在线,每次都以为坏了」)。
//
// 以前状态源一开始就是 connected:false,顶上那一行立刻写「电脑不在线」—— 「还没问完」和「问过了、真不在」长得一样;
// 在房里的时候一次轮询失败也立刻翻成不在线。现在:
//   - 第一次问出结果之前是「正在连接」(connecting:true);
//   - 失败要连续满 offlineGraceMs 才说不在线;这段时间里连上过的照旧当连着(显示上次的),没连上过的照旧「正在连接」;
//   - 从后台切回来(resume)也先回到「正在连接」,马上问一次。
import { describe, expect, it, vi } from 'vitest';
import type { ApiClient, ApiResult } from '../src/api/client';
import { createStateFeed, type WebSocketLike } from '../src/api/stateFeed';
import type { WorkbenchState } from '../src/api/protocol';

const pairing = { token: 'tok', host: '10.0.0.2', port: 8791, deviceId: 'd' };
const OK: ApiResult<WorkbenchState> = { ok: true, status: 200, data: { now: 'a', stale: false, sessions: [] } as unknown as WorkbenchState };
const DOWN: ApiResult<WorkbenchState> = { ok: false, status: 0, kind: 'network', error: '连不上工作台' };

function client(answers: ApiResult<WorkbenchState>[]): ApiClient {
  let i = 0;
  return { baseUrl: 'x', json: async () => answers[Math.min(i++, answers.length - 1)] as never, blob: async () => DOWN as never };
}
const noSocket = (): WebSocketLike => ({ addEventListener() {}, close() {} } as unknown as WebSocketLike);

describe('正在连接 / 在线 / 不在线', () => {
  it('★一打开还没问出结果:是「正在连接」,不是「不在线」', () => {
    const feed = createStateFeed({ client: { baseUrl: 'x', json: () => new Promise(() => {}), blob: () => new Promise(() => {}) } as ApiClient, pairing, socketFactory: noSocket, reconnectMs: 0, offlineGraceMs: 10_000 });
    expect(feed.get()).toMatchObject({ connected: false, connecting: true });
    feed.stop();
  });

  it('★第一次失败还在缓冲里:照旧「正在连接」;连续失败满缓冲才说不在线', async () => {
    let t = 0;
    const feed = createStateFeed({ client: client([DOWN]), pairing, socketFactory: noSocket, reconnectMs: 0, pollMs: 60_000, offlineGraceMs: 10_000, now: () => t });
    await vi.waitFor(() => expect(feed.get().error === undefined || feed.get().connecting).toBe(true));
    expect(feed.get()).toMatchObject({ connected: false, connecting: true });
    t = 10_000;
    await feed.refresh();
    expect(feed.get()).toMatchObject({ connected: false, connecting: false });
    feed.stop();
  });

  it('连上过之后掉一两次:照旧当连着(显示上次的),满缓冲才翻成不在线', async () => {
    let t = 0;
    const feed = createStateFeed({ client: client([OK, DOWN]), pairing, socketFactory: noSocket, reconnectMs: 0, pollMs: 60_000, offlineGraceMs: 10_000, now: () => t });
    await vi.waitFor(() => expect(feed.get().connected).toBe(true));
    t = 1_000;
    await feed.refresh();
    expect(feed.get().connected).toBe(true);
    t = 11_001;
    await feed.refresh();
    expect(feed.get()).toMatchObject({ connected: false, connecting: false });
    feed.stop();
  });

  it('从后台切回来:先回到「正在连接」再问', async () => {
    let t = 0;
    const feed = createStateFeed({ client: client([DOWN]), pairing, socketFactory: noSocket, reconnectMs: 0, pollMs: 60_000, offlineGraceMs: 10_000, now: () => t });
    await feed.refresh();
    t = 20_000;
    await feed.refresh();
    expect(feed.get().connecting).toBe(false);
    const again = feed.resume!();
    expect(feed.get().connecting).toBe(true);
    await again;
    feed.stop();
  });

  it('不给缓冲(老调用方):一失败就不在线,和以前一样', async () => {
    const feed = createStateFeed({ client: client([DOWN]), pairing, socketFactory: noSocket, reconnectMs: 0, pollMs: 60_000 });
    await vi.waitFor(() => expect(feed.get().error).toBe('连不上工作台'));
    expect(feed.get()).toMatchObject({ connected: false, connecting: false });
    feed.stop();
  });
});
