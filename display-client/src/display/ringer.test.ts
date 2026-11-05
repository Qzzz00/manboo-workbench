import { describe, expect, it } from 'vitest';
import { createLiveStore, type WebSocketLike } from './liveStore';
import { attachRinger } from './ringer';
import { emptyState } from './workbenchProtocol';

/** 可手动喂消息的假 WS（与 liveStore.test.ts 同款）。 */
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

/** 真 store + 假铃：验证的是「WS 消息 → 铃响/铃停」这整条判定链。 */
function rig() {
  const socket = new FakeSocket();
  const live = createLiveStore({
    url: 'ws://test/live',
    socketFactory: () => socket,
    reconnectMs: 0,
  });
  const calls: string[] = [];
  const detach = attachRinger(live, {
    start: () => calls.push('start'),
    stop: () => calls.push('stop'),
  });
  socket.emit('open');
  return { socket, live, calls, detach };
}

describe('attachRinger：响铃集合 ↔ 铃声开关', () => {
  it('收到 ring 就起铃，恰好一次', () => {
    const { socket, live, calls } = rig();

    socket.send({ kind: 'ring', agent: 'dsh', session_id: 'a7c1' });

    expect(calls).toEqual(['start']);
    live.stop();
  });

  it('第二个会话也响铃时不重复起铃——铃只有一口，响着就是响着', () => {
    const { socket, live, calls } = rig();

    socket.send({ kind: 'ring', agent: 'dsh', session_id: 'a7c1' });
    socket.send({ kind: 'ring', agent: 'claude', session_id: 'b1' });

    expect(calls).toEqual(['start']);
    live.stop();
  });

  it('★call/offhook 停光所有响铃后停铃（来电链 v0 的停铃信号）', () => {
    const { socket, live, calls } = rig();

    socket.send({ kind: 'ring', agent: 'dsh', session_id: 'a7c1' });
    socket.send({ kind: 'call', phase: 'offhook', agent: 'dsh', session_id: 'a7c1' });

    expect(calls).toEqual(['start', 'stop']);
    live.stop();
  });

  it('还有别的会话响着就不停铃', () => {
    const { socket, live, calls } = rig();

    socket.send({ kind: 'ring', agent: 'dsh', session_id: 'a7c1' });
    socket.send({ kind: 'ring', agent: 'claude', session_id: 'b1' });
    socket.send({ kind: 'call', phase: 'offhook', agent: 'dsh', session_id: 'a7c1' });

    expect(calls).toEqual(['start']);
    live.stop();
  });

  it('detach 时还在响就先停铃——不许留一口停不下来的钟', () => {
    const { socket, live, calls, detach } = rig();

    socket.send({ kind: 'ring', agent: 'dsh', session_id: 'a7c1' });
    detach();

    expect(calls).toEqual(['start', 'stop']);
    live.stop();
  });

  it('从没响过就 detach，不乱补一次 stop', () => {
    const { live, calls, detach } = rig();

    detach();

    expect(calls).toEqual([]);
    live.stop();
  });
});

/**
 * 免打扰时段不出声(2026-09-26,卡 QH)。
 *
 * 维护者设的是 21:00–08:30,规矩只有一句:晚上 9 点以后不想被打扰。判断在工作台服务端
 * (`workbench-plugin/src/server/quietHours.ts` → `/state.quiet`),展示台照 C2 只读结论。
 * **响铃那一格照旧亮着** —— 屏上看得见谁在等他,只是屋里没声。
 */
describe('attachRinger：免打扰时段', () => {
  /** 一份带 quiet 那一格的快照。 */
  function snapshot(active: boolean) {
    return {
      kind: 'snapshot',
      state: { ...emptyState(), quiet: { active, from: '21:00', to: '08:30', ...(active ? { until: '08:30', reason: '免打扰时段' } : {}) } },
    };
  }

  it('★时段内来了 ring:不起铃 —— 但响铃那一格照旧亮着(屏上看得见,屋里没声)', () => {
    const { socket, live, calls } = rig();

    socket.send(snapshot(true));
    socket.send({ kind: 'ring', agent: 'dsh', session_id: 'a7c1' });

    expect(calls).toEqual([]);
    expect(live.get().ringing.has('dsh:a7c1')).toBe(true);
    live.stop();
  });

  it('时段外照旧起铃', () => {
    const { socket, live, calls } = rig();

    socket.send(snapshot(false));
    socket.send({ kind: 'ring', agent: 'dsh', session_id: 'a7c1' });

    expect(calls).toEqual(['start']);
    live.stop();
  });

  it('★响着的时候到点了(21:00):铃停 —— 到点了不该继续吵', () => {
    const { socket, live, calls } = rig();
    socket.send({ kind: 'ring', agent: 'dsh', session_id: 'a7c1' });
    expect(calls).toEqual(['start']);

    socket.send(snapshot(true));

    expect(calls).toEqual(['start', 'stop']);
    live.stop();
  });

  it('★天亮了(08:30)而那一通还在响:铃自己接上 —— 他这会儿愿意被叫了', () => {
    const { socket, live, calls } = rig();
    socket.send(snapshot(true));
    socket.send({ kind: 'ring', agent: 'dsh', session_id: 'a7c1' });

    socket.send(snapshot(false));

    expect(calls).toEqual(['start']);
    live.stop();
  });

  it('老工作台没有 quiet 那一格:缺席按能出声算,一切照旧', () => {
    const { socket, live, calls } = rig();

    socket.send({ kind: 'snapshot', state: emptyState() });
    socket.send({ kind: 'ring', agent: 'dsh', session_id: 'a7c1' });

    expect(calls).toEqual(['start']);
    live.stop();
  });

  it('时段内被拆线:没在出声,不乱补一次 stop', () => {
    const { socket, live, calls, detach } = rig();
    socket.send(snapshot(true));
    socket.send({ kind: 'ring', agent: 'dsh', session_id: 'a7c1' });

    detach();

    expect(calls).toEqual([]);
    live.stop();
  });
});
