import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiClient } from '../src/api/client';
import { createStateFeed, liveUrlOf, type WebSocketLike } from '../src/api/stateFeed';
import type { WorkbenchState } from '../src/api/protocol';

const pairing = { token: 'tok', host: '10.0.0.2', port: 8791, deviceId: 'd' };
const stateA: WorkbenchState = { now: 'a', stale: false, sessions: [] };
const stateB: WorkbenchState = { now: 'b', stale: false, sessions: [] };

class FakeSocket implements WebSocketLike {
  listeners = new Map<string, Array<(e: unknown) => void>>();
  closed = false;
  constructor(public url: string) {}
  addEventListener(type: string, fn: (e: unknown) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() { this.closed = true; }
  fire(type: string, event: unknown = {}) { for (const fn of this.listeners.get(type) ?? []) fn(event); }
}

describe('liveUrlOf', () => {
  it('ws://host:port/live?token=(浏览器 WebSocket 设不了请求头,服务端只在 /live 升级时认查询串)', () => {
    expect(liveUrlOf(pairing)).toBe('ws://10.0.0.2:8791/live?token=tok');
  });
});

describe('stateFeed:轮询 /state + 订阅 /live', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  function setup(responses: Array<() => Response>) {
    let i = 0;
    const fetchImpl = vi.fn(async () => (responses[Math.min(i++, responses.length - 1)])());
    const client = createApiClient({ pairing, fetchImpl, onUnauthorized: () => {} });
    const sockets: FakeSocket[] = [];
    const feed = createStateFeed({
      client, pairing,
      socketFactory: (url) => { const s = new FakeSocket(url); sockets.push(s); return s; },
      pollMs: 3000, pollWhileLiveMs: 30000, reconnectMs: 5000,
    });
    return { feed, fetchImpl, sockets };
  }

  it('一起步就拉一次 /state,拿到快照并标 connected', async () => {
    const { feed, fetchImpl } = setup([() => new Response(JSON.stringify(stateA), { status: 200 })]);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(feed.get()).toEqual({ state: stateA, connected: true, error: undefined, connecting: false });
    feed.stop();
  });

  it('WS 没连上时每 pollMs 轮询一次;连上后改成慢轮询,靠 snapshot 推送', async () => {
    const { feed, fetchImpl, sockets } = setup([() => new Response(JSON.stringify(stateA), { status: 200 })]);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(3000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    sockets[0].fire('open');
    sockets[0].fire('message', { data: JSON.stringify({ kind: 'snapshot', state: stateB }) });
    expect(feed.get().state).toEqual(stateB);
    await vi.advanceTimersByTimeAsync(9000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(30000);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    feed.stop();
  });

  it('连不上 → 保留上次快照、connected=false、error 有话;之后连上再清掉', async () => {
    const listener = vi.fn();
    const { feed } = setup([
      () => new Response(JSON.stringify(stateA), { status: 200 }),
      () => { throw new TypeError('down'); },
      () => new Response(JSON.stringify(stateB), { status: 200 }),
    ]);
    feed.subscribe(listener);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(3000);
    expect(feed.get().connected).toBe(false);
    // C1:保留上次快照,只翻 stale
    expect(feed.get().state).toEqual({ ...stateA, stale: true });
    expect(feed.get().error).toContain('连不上工作台');
    await vi.advanceTimersByTimeAsync(3000);
    expect(feed.get()).toEqual({ state: stateB, connected: true, error: undefined, connecting: false });
    expect(listener).toHaveBeenCalled();
    feed.stop();
  });

  it('WS 掉了就按 reconnectMs 重开一条,老的先关(不让连接数翻倍)', async () => {
    const { feed, sockets } = setup([() => new Response(JSON.stringify(stateA), { status: 200 })]);
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets).toHaveLength(1);
    sockets[0].fire('error');
    sockets[0].fire('close');
    await vi.advanceTimersByTimeAsync(5000);
    expect(sockets).toHaveLength(2);
    expect(sockets[0].closed).toBe(true);
    feed.stop();
    expect(sockets[1].closed).toBe(true);
  });

  it('refresh() 立刻拉一次', async () => {
    const { feed, fetchImpl } = setup([() => new Response(JSON.stringify(stateA), { status: 200 })]);
    await vi.advanceTimersByTimeAsync(0);
    await feed.refresh();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    feed.stop();
  });

  it('401 → 停止一切(轮询与 WS),不再打扰', async () => {
    const { feed, fetchImpl, sockets } = setup([() => new Response(JSON.stringify({ error: '需要设备令牌' }), { status: 401 })]);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sockets.every((s) => s.closed)).toBe(true);
    feed.stop();
  });
});
