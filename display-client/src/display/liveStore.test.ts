import { describe, expect, it } from 'vitest';
import { createLiveStore, resolveWorkbenchUrl, workbenchFallbackUrl, type LiveStoreOptions, type WebSocketLike } from './liveStore';
import type { WorkbenchState } from './workbenchProtocol';
import { emptyState } from './workbenchProtocol';

/** 可手动喂消息的假 WS。 */
class FakeSocket implements WebSocketLike {
  listeners: Record<string, ((event: unknown) => void)[]> = {};
  closed = false;

  addEventListener(type: string, listener: (event: unknown) => void) {
    (this.listeners[type] ??= []).push(listener);
  }

  close() {
    this.closed = true;
  }

  emit(type: string, event?: unknown) {
    for (const listener of this.listeners[type] ?? []) listener(event);
  }

  send(message: unknown) {
    this.emit('message', { data: JSON.stringify(message) });
  }
}

function store(socket: FakeSocket) {
  return createLiveStore({
    url: 'ws://test/live',
    socketFactory: () => socket,
    reconnectMs: 0,
  });
}

function snapshot(over: Partial<WorkbenchState> = {}): WorkbenchState {
  return { ...emptyState(), stale: false, ...over };
}

function oneSession(title: string) {
  return {
    agent: 'dsh' as const,
    session_id: 'a7c1',
    project: '扣扣直聘',
    status: 'waiting' as const,
    title,
    elapsed_sec: 252,
    unread: false,
    updated_at: '2026-08-18T10:03:00+08:00',
  };
}

describe('createLiveStore', () => {
  it('还没连上就先有 stale 空快照，界面不会白屏', () => {
    const live = store(new FakeSocket());

    expect(live.get().state.stale).toBe(true);
    expect(live.get().state.sessions).toEqual([]);
    expect(live.get().connected).toBe(false);
    live.stop();
  });

  it('收到 snapshot 后填充并标记已连上，同时通知订阅者', () => {
    const socket = new FakeSocket();
    const live = store(socket);
    let notified = 0;
    live.subscribe(() => { notified += 1; });

    socket.emit('open');
    socket.send({ kind: 'snapshot', state: snapshot({ sessions: [oneSession('要改 schema.ts')] }) });

    expect(live.get().connected).toBe(true);
    expect(live.get().state.stale).toBe(false);
    expect(live.get().state.sessions[0].title).toBe('要改 schema.ts');
    expect(notified).toBeGreaterThan(0);
    live.stop();
  });

  it('★C1：断线时保留最后快照，只标 stale，绝不清空', () => {
    const socket = new FakeSocket();
    const live = store(socket);

    socket.emit('open');
    socket.send({ kind: 'snapshot', state: snapshot({ sessions: [oneSession('最后已知的会话')] }) });
    expect(live.get().state.sessions).toHaveLength(1);

    socket.emit('close');

    expect(live.get().connected).toBe(false);
    expect(live.get().state.stale).toBe(true);
    expect(live.get().state.sessions).toHaveLength(1);
    expect(live.get().state.sessions[0].title).toBe('最后已知的会话');
    live.stop();
  });

  it('error 事件与 close 同等对待（也不清空）', () => {
    const socket = new FakeSocket();
    const live = store(socket);

    socket.emit('open');
    socket.send({ kind: 'snapshot', state: snapshot({ sessions: [oneSession('还在')] }) });
    socket.emit('error');

    expect(live.get().state.stale).toBe(true);
    expect(live.get().state.sessions).toHaveLength(1);
    live.stop();
  });

  it('收到 ring 就标记响铃中（判定在工作台做，展示台只消费 — C2）', () => {
    const socket = new FakeSocket();
    const live = store(socket);

    socket.emit('open');
    socket.send({ kind: 'ring', agent: 'dsh', session_id: 'a7c1' });

    expect([...live.get().ringing]).toEqual(['dsh:a7c1']);
    live.stop();
  });

  it('响铃过一阵自己退场，不会一直起身着', () => {
    const socket = new FakeSocket();
    const fired: (() => void)[] = [];
    const live = createLiveStore({
      url: 'ws://test/live',
      socketFactory: () => socket,
      reconnectMs: 0,
      ringVisibleMs: 1000,
      setTimeoutImpl: (fn) => { fired.push(fn); return fired.length; },
      clearTimeoutImpl: () => {},
    });

    socket.emit('open');
    socket.send({ kind: 'ring', agent: 'dsh', session_id: 'a7c1' });
    expect([...live.get().ringing]).toEqual(['dsh:a7c1']);

    fired.forEach((fn) => fn());

    expect([...live.get().ringing]).toEqual([]);
    live.stop();
  });

  it('★call/offhook 停铃：话机一接，响铃立刻退场（来电链 v0）', () => {
    const socket = new FakeSocket();
    const live = store(socket);

    socket.emit('open');
    socket.send({ kind: 'ring', agent: 'dsh', session_id: 'a7c1' });
    expect([...live.get().ringing]).toEqual(['dsh:a7c1']);

    socket.send({ kind: 'call', phase: 'offhook', agent: 'dsh', session_id: 'a7c1' });

    expect([...live.get().ringing]).toEqual([]);
    live.stop();
  });

  it('call/missed 同样停铃（响铃超时没人接）', () => {
    const socket = new FakeSocket();
    const live = store(socket);

    socket.emit('open');
    socket.send({ kind: 'ring', agent: 'claude', session_id: 'b1' });
    socket.send({ kind: 'call', phase: 'missed', agent: 'claude', session_id: 'b1' });

    expect([...live.get().ringing]).toEqual([]);
    live.stop();
  });

  it('call/onhook 不碰铃——挂断的时候铃早停了，别的会话还响着也不许误伤', () => {
    const socket = new FakeSocket();
    const live = store(socket);

    socket.emit('open');
    socket.send({ kind: 'ring', agent: 'dsh', session_id: 'a7c1' });
    socket.send({ kind: 'call', phase: 'onhook', agent: 'dsh', session_id: 'a7c1' });

    expect([...live.get().ringing]).toEqual(['dsh:a7c1']);
    live.stop();
  });

  it('停铃只停指定会话，别的会话继续响', () => {
    const socket = new FakeSocket();
    const live = store(socket);

    socket.emit('open');
    socket.send({ kind: 'ring', agent: 'dsh', session_id: 'a7c1' });
    socket.send({ kind: 'ring', agent: 'claude', session_id: 'b1' });
    socket.send({ kind: 'call', phase: 'offhook', agent: 'dsh', session_id: 'a7c1' });

    expect([...live.get().ringing]).toEqual(['claude:b1']);
    live.stop();
  });

  it('铃已被 call 停掉后，原定的退场定时器迟到触发不再惊动订阅者', () => {
    const socket = new FakeSocket();
    const fired: (() => void)[] = [];
    const live = createLiveStore({
      url: 'ws://test/live',
      socketFactory: () => socket,
      reconnectMs: 0,
      idleTimeoutMs: 0,
      ringVisibleMs: 1000,
      setTimeoutImpl: (fn) => { fired.push(fn); return fired.length; },
      clearTimeoutImpl: () => {},
    });

    socket.emit('open');
    socket.send({ kind: 'ring', agent: 'dsh', session_id: 'a7c1' });
    socket.send({ kind: 'call', phase: 'offhook', agent: 'dsh', session_id: 'a7c1' });

    let notified = 0;
    live.subscribe(() => { notified += 1; });
    fired.forEach((fn) => fn());

    expect(notified).toBe(0);
    expect([...live.get().ringing]).toEqual([]);
    live.stop();
  });

  it('没响过铃时收到 call 停铃信号（幽灵停铃）不惊动订阅者', () => {
    const socket = new FakeSocket();
    const live = store(socket);
    socket.emit('open');

    let notified = 0;
    live.subscribe(() => { notified += 1; });
    socket.send({ kind: 'call', phase: 'offhook', agent: 'dsh', session_id: 'a7c1' });

    expect(notified).toBe(0);
    live.stop();
  });

  it('脏数据丢掉，不让展示台崩在一条坏消息上', () => {
    const socket = new FakeSocket();
    const live = store(socket);

    socket.emit('open');
    socket.emit('message', { data: '{不是 json' });

    expect(live.get().connected).toBe(true);
    expect(live.get().state.sessions).toEqual([]);
    live.stop();
  });

  it('增量 event 直接并进快照，不用等下一份 snapshot', () => {
    const socket = new FakeSocket();
    const live = store(socket);

    socket.emit('open');
    socket.send({ kind: 'snapshot', state: snapshot() });
    socket.send({ kind: 'event', event: { agent: 'claude', session_id: 'b1', type: 'waiting', title: '新来的' } });

    expect(live.get().state.sessions).toHaveLength(1);
    expect(live.get().state.sessions[0].title).toBe('新来的');
    live.stop();
  });

  it('stop 之后关掉 socket 且不再理消息', () => {
    const socket = new FakeSocket();
    const live = store(socket);
    socket.emit('open');
    live.stop();

    socket.send({ kind: 'snapshot', state: snapshot({ sessions: [oneSession('迟到的')] }) });

    expect(socket.closed).toBe(true);
    expect(live.get().state.sessions).toEqual([]);
  });
});

/**
 * 重连行为的观察台：记下每一次新建的 socket，并把定时器攥在手里手动跑，
 * 这样「一次掉线派了几个重连」是可数的，不用等真实时间。
 */
function reconnectRig(over: Partial<LiveStoreOptions> = {}) {
  const sockets: FakeSocket[] = [];
  const timers = new Map<number, { ms: number; fn: () => void }>();
  let seq = 0;
  const live = createLiveStore({
    url: 'ws://test/live',
    socketFactory: () => { const s = new FakeSocket(); sockets.push(s); return s; },
    reconnectMs: 3000,
    idleTimeoutMs: 45_000,
    ringVisibleMs: 1000,
    setTimeoutImpl: (fn, ms) => { seq += 1; timers.set(seq, { ms, fn }); return seq; },
    clearTimeoutImpl: (handle) => { timers.delete(handle as number); },
    ...over,
  });
  /** 跑完当前这批到期定时器（新排的留到下一轮，模拟真实时间推进）。 */
  const runTimers = () => {
    for (const [id, t] of [...timers.entries()]) { timers.delete(id); t.fn(); }
  };
  /** 只跑某个时长的定时器——用来把「重连」和「看门狗」分开触发。 */
  const runTimersOf = (ms: number) => {
    for (const [id, t] of [...timers.entries()]) {
      if (t.ms === ms) { timers.delete(id); t.fn(); }
    }
  };
  const delays = () => [...timers.values()].map((t) => t.ms).sort((a, b) => a - b);
  /** 还活着的连接：真机上 Wi-Fi 一断，这些会一起掉。 */
  const liveSockets = () => sockets.filter((s) => !s.closed);
  return { live, sockets, timers, runTimers, runTimersOf, delays, liveSockets };
}

describe('createLiveStore 的重连（渲染进程内存泄漏的根因所在）', () => {
  it('★一次掉线只能排一个重连：规范规定连接失败时先 error 再 close，那是同一次掉线', () => {
    const rig = reconnectRig();
    expect(rig.sockets).toHaveLength(1);

    rig.sockets[0].emit('error');
    rig.sockets[0].emit('close');
    expect(rig.timers.size).toBe(1);

    rig.runTimers();
    expect(rig.sockets).toHaveLength(2);
    rig.live.stop();
  });

  it('★重连前先关掉旧连接，否则旧 socket 永远挂着不回收', () => {
    const rig = reconnectRig();
    const first = rig.sockets[0];

    first.emit('close');
    rig.runTimers();

    expect(first.closed).toBe(true);
    rig.live.stop();
  });

  it('★反复掉线不能让连接数翻倍——这正是渲染进程被撑爆的机制', () => {
    const rig = reconnectRig();

    for (let cycle = 0; cycle < 8; cycle += 1) {
      for (const s of rig.liveSockets()) { s.emit('error'); s.emit('close'); }
      rig.runTimers();
    }

    // 每轮至多再开一条：8 轮下来总数应当是个位数，而不是 2^8。
    expect(rig.liveSockets().length).toBe(1);
    expect(rig.sockets.length).toBeLessThanOrEqual(9);
    rig.live.stop();
  });

  it('stop 之后不再重连，也不留下待跑的定时器', () => {
    const rig = reconnectRig();
    rig.sockets[0].emit('close');
    rig.live.stop();

    rig.runTimers();

    expect(rig.sockets).toHaveLength(1);
  });
});

describe('createLiveStore 的看门狗（半开连接的唯一出路）', () => {
  it('★久没收到任何消息就当掉线并重连——半开的 TCP 不会派 close，只能靠这个发现', () => {
    const rig = reconnectRig();
    rig.sockets[0].emit('open');
    expect(rig.live.get().connected).toBe(true);

    rig.runTimersOf(45_000);

    expect(rig.live.get().connected).toBe(false);
    expect(rig.live.get().state.stale).toBe(true);
    expect(rig.sockets[0].closed).toBe(true);

    rig.runTimersOf(3000);
    expect(rig.sockets).toHaveLength(2);
    rig.live.stop();
  });

  it('每收到一条消息就把看门狗推后，正常连着不会被误判', () => {
    const rig = reconnectRig();
    rig.sockets[0].emit('open');

    for (let i = 0; i < 5; i += 1) {
      rig.sockets[0].send({ kind: 'ping', ts: i });
      // 推后 = 旧的那个被清掉、只剩新排的一个。
      expect(rig.delays().filter((ms) => ms === 45_000)).toHaveLength(1);
    }

    expect(rig.live.get().connected).toBe(true);
    expect(rig.sockets).toHaveLength(1);
    rig.live.stop();
  });

  it('★ping 只喂看门狗：不进快照、不响铃、也不惊动订阅者（否则每 20 秒白重渲染一次）', () => {
    const rig = reconnectRig();
    let notified = 0;
    rig.sockets[0].emit('open');
    rig.live.subscribe(() => { notified += 1; });

    rig.sockets[0].send({ kind: 'ping', ts: 1 });

    expect(notified).toBe(0);
    expect(rig.live.get().state.sessions).toEqual([]);
    expect([...rig.live.get().ringing]).toEqual([]);
    rig.live.stop();
  });

  it('stop 之后看门狗也不再咬人', () => {
    const rig = reconnectRig();
    rig.sockets[0].emit('open');
    rig.live.stop();

    rig.runTimers();

    expect(rig.sockets).toHaveLength(1);
  });
});

describe('resolveWorkbenchUrl', () => {
  it('默认连本机 8791', () => {
    expect(resolveWorkbenchUrl('')).toBe('ws://127.0.0.1:8791/live');
  });

  it('可用查询串覆盖', () => {
    expect(resolveWorkbenchUrl('?workbench=ws://192.168.1.9:9000/live'))
      .toBe('ws://192.168.1.9:9000/live');
  });

  it('空值不算覆盖', () => {
    expect(resolveWorkbenchUrl('?workbench=')).toBe('ws://127.0.0.1:8791/live');
  });
});

describe('workbenchFallbackUrl（构建期默认地址）', () => {
  it('没配就还是本机——开发机上照旧连自己，行为不变', () => {
    expect(workbenchFallbackUrl({})).toBe('ws://127.0.0.1:8791/live');
    expect(workbenchFallbackUrl({ VITE_WORKBENCH_URL: '' })).toBe('ws://127.0.0.1:8791/live');
  });

  it('配完整 ws 地址就原样用', () => {
    expect(workbenchFallbackUrl({ VITE_WORKBENCH_URL: 'ws://172.20.10.3:8791/live' }))
      .toBe('ws://172.20.10.3:8791/live');
  });

  it('只配 host:port 也认——实际要填的就是这个，别逼人背 ws 前缀和 /live 后缀', () => {
    expect(workbenchFallbackUrl({ VITE_WORKBENCH_URL: '172.20.10.3:8791' }))
      .toBe('ws://172.20.10.3:8791/live');
  });

  it('只配 host 就补默认端口', () => {
    expect(workbenchFallbackUrl({ VITE_WORKBENCH_URL: '172.20.10.3' }))
      .toBe('ws://172.20.10.3:8791/live');
  });

  it('http:// 写法也接住，换成 ws://——这是最容易手滑的一种', () => {
    expect(workbenchFallbackUrl({ VITE_WORKBENCH_URL: 'http://172.20.10.3:8791' }))
      .toBe('ws://172.20.10.3:8791/live');
  });
});
