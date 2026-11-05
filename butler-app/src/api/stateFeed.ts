/**
 * 事项数据的来源:`GET /state`(带 Bearer 头轮询)+ `/live` WebSocket 推送(?token=,只认 snapshot)。
 *
 * 为什么两条都要:WS 是即时的,但手机锁屏/切网时 WS 经常半死不活;轮询是兜底,慢但一定到。
 * WS 连着时轮询放慢到 pollWhileLiveMs;断了就 pollMs 一拍。断线时保留上次快照(C1),只翻 connected。
 * 401 一出现整条停下——令牌没了,再打也是 401,界面回配对页(client.onUnauthorized 负责)。
 */
import type { ApiClient } from './client';
import type { LiveMessage, WorkbenchState } from './protocol';
import { emptyState } from './protocol';
import type { Pairing } from './tokenStore';

export interface WebSocketLike {
  addEventListener(type: string, listener: (event: unknown) => void): void;
  close(): void;
}

export interface FeedSnapshot {
  state: WorkbenchState;
  connected: boolean;
  error: string | undefined;
  /**
   * **还在连,没到说「不在线」的时候**(2026-09-30,维护者:「一上来先显示电脑不在线,每次都以为坏了」)。
   * 一打开还没问出结果、或者失败还没连续满 `offlineGraceMs`、或者刚从后台切回来 → true。
   * 界面据此写「正在连接电脑…」,只有 `!connected && !connecting` 才写「电脑不在线」。
   */
  connecting?: boolean;
}

export interface StateFeed {
  get(): FeedSnapshot;
  subscribe(listener: () => void): () => void;
  refresh(): Promise<void>;
  /** 从后台切回来:先回到「正在连接」,马上问一次(2026-09-30)。 */
  resume?(): Promise<void>;
  stop(): void;
}

export interface StateFeedOptions {
  client: ApiClient;
  pairing: Pairing;
  socketFactory?: (url: string) => WebSocketLike;
  pollMs?: number;
  pollWhileLiveMs?: number;
  reconnectMs?: number;
  /**
   * `/live` 连哪个地址(2026-10-21,局域网 M4):路线驱动在家时判到的那个 8791;回 null = 不在家,不连 `/live`
   * (只轮询,轮询经房间)。不给就是配对时那个地址。
   */
  liveBase?: () => string | null;
  /**
   * 连续失败多久才说「不在线」(2026-09-30)。缺省 0 = 一失败就不在线(老行为);手机那一份传 {@link FEED_OFFLINE_GRACE_MS}。
   */
  offlineGraceMs?: number;
  now?: () => number;
}

/** 手机上「正在连接」撑多久才改口说「电脑不在线」。 */
export const FEED_OFFLINE_GRACE_MS = 10_000;

export function liveUrlOf(pairing: Pairing): string {
  const url = new URL(`ws://${pairing.host}:${pairing.port}/live`);
  url.searchParams.set('token', pairing.token);
  return url.toString();
}

/** 同 {@link liveUrlOf},地址取自 `http://<host>:<port>` 那种写法。 */
export function liveUrlAt(base: string, token: string): string {
  const url = new URL('/live', base.replace(/^http/, 'ws'));
  url.searchParams.set('token', token);
  return url.toString();
}

export function createStateFeed(options: StateFeedOptions): StateFeed {
  const pollMs = options.pollMs ?? 3000;
  const pollWhileLiveMs = options.pollWhileLiveMs ?? 30000;
  const reconnectMs = options.reconnectMs ?? 5000;
  const socketFactory = options.socketFactory ?? ((url: string) => new WebSocket(url) as unknown as WebSocketLike);

  const graceMs = options.offlineGraceMs ?? 0;
  const now = options.now ?? (() => Date.now());
  let snapshot: FeedSnapshot = { state: emptyState(), connected: false, error: undefined, connecting: true };
  /** 连续失败从几点开始的(成功一次就清掉)。 */
  let failingSince: number | undefined;

  const listeners = new Set<() => void>();
  let alive = true;
  let liveOpen = false;
  let socket: WebSocketLike | undefined;
  let generation = 0;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  function emit(next: FeedSnapshot) {
    snapshot = next;
    for (const l of listeners) l();
  }

  function schedulePoll() {
    if (!alive) return;
    if (pollTimer !== undefined) clearTimeout(pollTimer);
    pollTimer = setTimeout(() => { pollTimer = undefined; void poll(); }, liveOpen ? pollWhileLiveMs : pollMs);
  }

  async function poll(): Promise<void> {
    if (!alive) return;
    const result = await options.client.json<WorkbenchState>('/state');
    if (!alive) return;
    if (result.ok) {
      failingSince = undefined;
      emit({ state: result.data, connected: true, error: undefined, connecting: false });
    } else if (result.kind === 'unauthorized') {
      stop();
      return;
    } else {
      const t = now();
      failingSince ??= t;
      if (t - failingSince < graceMs) {
        // 还在缓冲里:连上过的照旧当连着(显示上次的),没连上过的照旧「正在连接」。
        emit({ ...snapshot, connecting: !snapshot.connected });
      } else {
        emit({ state: { ...snapshot.state, stale: true }, connected: false, error: result.error, connecting: false });
      }
    }
    schedulePoll();
  }

  function connectLive() {
    if (!alive) return;
    const previous = socket;
    socket = undefined;
    previous?.close();
    const gen = (generation += 1);
    let current: WebSocketLike;
    try {
      const base = options.liveBase === undefined ? undefined : options.liveBase();
      if (base === null) { scheduleReconnect(); return; }
      current = socketFactory(base === undefined ? liveUrlOf(options.pairing) : liveUrlAt(base, options.pairing.token));
    } catch {
      scheduleReconnect();
      return;
    }
    socket = current;
    const fresh = () => alive && gen === generation;
    let down = false;
    const onDown = () => {
      if (down || !fresh()) return;
      down = true;
      liveOpen = false;
      current.close();
      schedulePoll();
      scheduleReconnect();
    };
    current.addEventListener('open', () => {
      if (!fresh()) return;
      liveOpen = true;
      schedulePoll();
    });
    current.addEventListener('message', (event) => {
      if (!fresh()) return;
      let message: LiveMessage;
      try { message = JSON.parse(String((event as { data?: unknown }).data)) as LiveMessage; } catch { return; }
      if (message.kind === 'snapshot' && 'state' in message) {
        failingSince = undefined;
        emit({ state: message.state, connected: true, error: undefined, connecting: false });
      }
    });
    current.addEventListener('close', onDown);
    current.addEventListener('error', onDown);
  }

  function scheduleReconnect() {
    if (!alive || reconnectMs <= 0) return;
    if (retryTimer !== undefined) clearTimeout(retryTimer);
    retryTimer = setTimeout(() => { retryTimer = undefined; connectLive(); }, reconnectMs);
  }

  function stop() {
    alive = false;
    generation += 1;
    if (pollTimer !== undefined) { clearTimeout(pollTimer); pollTimer = undefined; }
    if (retryTimer !== undefined) { clearTimeout(retryTimer); retryTimer = undefined; }
    socket?.close();
    socket = undefined;
  }

  void poll();
  connectLive();

  return {
    get: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    async refresh() {
      if (pollTimer !== undefined) { clearTimeout(pollTimer); pollTimer = undefined; }
      await poll();
    },
    async resume() {
      // 切回前台:失败从头算,没连着的先说「正在连接」,马上问一次;WS 断了的顺手重连。
      failingSince = undefined;
      if (!snapshot.connected) emit({ ...snapshot, connecting: true });
      if (!liveOpen) connectLive();
      if (pollTimer !== undefined) { clearTimeout(pollTimer); pollTimer = undefined; }
      await poll();
    },
    stop,
  };
}
