/**
 * WS 接线，与 React 无关。
 *
 * 抽成纯 store 的原因：本仓库的测试全是 node 环境纯逻辑（161 个文件都是），
 * 没有 jsdom / testing-library。把接线做成可测的 store，就能在既有约定下
 * 覆盖住最要紧的那条——**断线时保留最后快照**（架构约束 C1）——
 * 而不必为了渲染一个 hook 往仓库塞两个新依赖。
 */
import type { LiveMessage, WorkbenchState } from './workbenchProtocol';
import { emptyState } from './workbenchProtocol';
import { reduceLive } from './displayFeed';

/** 只用到这几个成员，方便测试替换。 */
export interface WebSocketLike {
  addEventListener: (type: string, listener: (event: unknown) => void) => void;
  close: () => void;
}

export interface LiveSnapshot {
  state: WorkbenchState;
  ringing: ReadonlySet<string>;
  /** WS 是否连着。断了要在界面标"Agent 掉线"。 */
  connected: boolean;
}

export interface LiveStoreOptions {
  url: string;
  socketFactory: (url: string) => WebSocketLike;
  /** 0 表示不自动重连（测试用）。 */
  reconnectMs?: number;
  /** 响铃视觉持续多久；工作台那边的 10 分钟冷却是另一回事。 */
  ringVisibleMs?: number;
  /**
   * 多久收不到任何消息就当这条连接已经死了（0 表示不看门）。
   * 默认 60 秒 = 工作台心跳周期(20s)的三倍，掉一两拍不误杀。
   */
  idleTimeoutMs?: number;
  setTimeoutImpl?: (fn: () => void, ms: number) => unknown;
  clearTimeoutImpl?: (handle: unknown) => void;
}

export interface LiveStore {
  get: () => LiveSnapshot;
  subscribe: (listener: () => void) => () => void;
  stop: () => void;
}

export function createLiveStore(options: LiveStoreOptions): LiveStore {
  const reconnectMs = options.reconnectMs ?? 3000;
  const ringVisibleMs = options.ringVisibleMs ?? 60_000;
  const idleTimeoutMs = options.idleTimeoutMs ?? 60_000;
  const setTimer = options.setTimeoutImpl ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimeoutImpl
    ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  let snapshot: LiveSnapshot = { state: emptyState(), ringing: new Set(), connected: false };
  const listeners = new Set<() => void>();
  const pending = new Set<unknown>();
  let socket: WebSocketLike | undefined;
  let retry: unknown;
  /** 看门狗：半开连接不会派 close，只有「久没收到东西」能把它认出来。 */
  let idle: unknown;
  let alive = true;
  /** 连接代数：只有最新一代的事件算数，迟到的旧 socket 一律忽略。 */
  let generation = 0;

  function emit(next: LiveSnapshot) {
    snapshot = next;
    for (const listener of listeners) listener();
  }

  function handleMessage(raw: unknown) {
    let message: LiveMessage;
    try {
      message = JSON.parse(String(raw)) as LiveMessage;
    } catch {
      // 一条脏数据不该让整块展示台崩掉。
      return;
    }

    // 心跳只用来喂看门狗（喂食在 message 监听里已经做过了）。
    // 这里必须提前返回：否则每 20 秒就 emit 一次新快照对象，
    // 展示台整棵树跟着白重渲染一遍——那正是我们要治的病。
    if (message.kind === 'ping') return;

    const result = reduceLive(snapshot.state, message);

    // 停铃（话机摘机/响铃超时——来电链 v0）：只摘掉指定会话；
    // 没在响的（幽灵停铃）不 emit，不惊动整棵树白渲染一遍。
    if (result.ringStop !== undefined) {
      if (!snapshot.ringing.has(result.ringStop)) return;
      const ringing = new Set(snapshot.ringing);
      ringing.delete(result.ringStop);
      emit({ ...snapshot, state: result.state, ringing });
      return;
    }

    if (result.ring === undefined) {
      emit({ ...snapshot, state: result.state });
      return;
    }

    const key = result.ring;
    const ringing = new Set(snapshot.ringing);
    ringing.add(key);
    emit({ ...snapshot, state: result.state, ringing });

    // 响铃是一次性表现，过一阵自己退场，否则角色会一直"起身"着。
    const handle = setTimer(() => {
      pending.delete(handle);
      // 铃可能已被话机 call 消息提前停掉，迟到的退场定时器别再空 emit 一轮。
      if (!snapshot.ringing.has(key)) return;
      const next = new Set(snapshot.ringing);
      next.delete(key);
      emit({ ...snapshot, ringing: next });
    }, ringVisibleMs);
    pending.add(handle);
  }

  /**
   * 建立连接。这个函数有两条必须守住的规矩，破了任何一条，连接数都会随掉线次数翻倍：
   *
   * 1. **开新的之前先关旧的。** 旧 socket 不关就一直挂着占内存，而且下次掉线时
   *    它还会再派一份 close/error 出来，等于又排一个重连。
   * 2. **一次连接只算一次掉线。** WHATWG 规定连接失败时先派 `error` 再派 `close`
   *    ——那是同一次掉线的两个事件。两个都排重连，每掉一次线就多一条连接。
   *
   * 两条一起破的后果是实测出来的：单元测试里 8 个掉线周期长出 6561 条连接。
   * 真机在 iPhone 热点上跑（172.20.10.x），Wi-Fi 抖一下就走一个周期，几十秒就能到几千条：
   * 每条推送都要乘以连接数做一次整树渲染 → 主线程饱和 → 触摸排不进去、WS 推了也画不出来；
   * 内存与线程同时见底 → `pthread_create: Try again` → aw_browser_terminator 把整页打死。
   * 「数字卡住」和「点不动」这两个现象，根子都在这里。
   */
  function connect() {
    if (!alive) return;

    // 规矩 1：旧连接先关。
    const previous = socket;
    socket = undefined;
    previous?.close();

    const gen = (generation += 1);
    const current = options.socketFactory(options.url);
    socket = current;

    /** 喂狗：收到任何东西都把判死时间往后推。 */
    const feed = () => {
      if (idleTimeoutMs <= 0 || !fresh()) return;
      if (idle !== undefined) clearTimer(idle);
      idle = setTimer(() => { idle = undefined; onDown(); }, idleTimeoutMs);
    };
    // 规矩 2：本次连接是否已经算过掉线。
    let down = false;
    /** 事件是否来自当前这一代连接（旧 socket 的迟到事件一律不作数）。 */
    const fresh = () => alive && gen === generation;

    current.addEventListener('open', () => {
      if (!fresh()) return;
      feed();
      emit({ ...snapshot, connected: true });
    });

    current.addEventListener('message', (event) => {
      if (!fresh()) return;
      feed();
      handleMessage((event as { data?: unknown }).data);
    });

    function onDown() {
      if (down || !fresh()) return;
      down = true;
      if (idle !== undefined) { clearTimer(idle); idle = undefined; }
      // 看门狗判死时对端不会自己走，必须主动关掉这条 socket 把它释放掉。
      current.close();
      // C1：只翻 stale，sessions 一个字节都不动。
      emit({ ...snapshot, connected: false, state: { ...snapshot.state, stale: true } });
      if (reconnectMs > 0) {
        if (retry !== undefined) clearTimer(retry);
        retry = setTimer(() => { retry = undefined; connect(); }, reconnectMs);
      }
    }
    current.addEventListener('close', onDown);
    current.addEventListener('error', onDown);

    // 连上之前也要看着：连接一直吊着不 open 的情况同样得走重连。
    feed();
  }

  connect();

  return {
    get: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    stop() {
      alive = false;
      generation += 1;
      if (retry !== undefined) { clearTimer(retry); retry = undefined; }
      if (idle !== undefined) { clearTimer(idle); idle = undefined; }
      for (const handle of pending) clearTimer(handle);
      pending.clear();
      listeners.clear();
      socket?.close();
    },
  };
}

/** 没配任何东西时的兜底：本机 8791（开发机上照旧连自己）。 */
const LOCAL_WORKBENCH_URL = 'ws://127.0.0.1:8791/live';

/**
 * 构建期默认的工作台地址（VITE_WORKBENCH_URL）。
 *
 * 展示台是 kiosk 启动，地址栏没有查询串，`?workbench=` 那条路用不上；
 * 而它跑在另一台设备上，默认的 127.0.0.1 指向的是它自己，永远连不上工作台
 * （现象：会话区常年「Agent 掉线」、余额「未接入」）。所以要能在打包时钉一个地址进去。
 *
 * 容错按「人实际会怎么填」来：多数时候只想写个 IP，不该逼人背 `ws://` 前缀和 `/live` 后缀，
 * 更不该因为手滑写成 `http://` 就整条静默失效。
 */
export function workbenchFallbackUrl(env: { VITE_WORKBENCH_URL?: string }): string {
  const raw = env.VITE_WORKBENCH_URL;
  if (raw === undefined || raw === '') return LOCAL_WORKBENCH_URL;

  // http(s):// → ws(s)://；其余原样。
  let value = raw.replace(/^http(s?):\/\//i, 'ws$1://');
  if (!/^wss?:\/\//i.test(value)) value = `ws://${value}`;

  const url = new URL(value);
  if (url.port === '') url.port = '8791';
  if (url.pathname === '' || url.pathname === '/') url.pathname = '/live';
  return url.toString();
}

/** 从 URL 查询串或默认值解析工作台地址。 */
export function resolveWorkbenchUrl(search = '', fallback = LOCAL_WORKBENCH_URL): string {
  const found = new URLSearchParams(search).get('workbench');
  return found === null || found === '' ? fallback : found;
}
