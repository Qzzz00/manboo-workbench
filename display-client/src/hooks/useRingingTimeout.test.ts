import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startRingingTimeout } from './useRingingTimeout.ts';

/**
 * startRingingTimeout 是 useRingingTimeout 内部真正调用的计时核心（无 React 依赖的纯函数），
 * hook 只是把它包进 useEffect + ref（存最新 onTimeout，deps 只留 [event, timeoutMs]）。
 * 这里直接测这个核心的计时语义；node 环境无 AudioContext，createRingtone 自然走 no-op，
 * 不影响计时器行为。event 变化 / 置 null 时的“先清后起”由调用方（React effect cleanup）
 * 负责，这里通过手动调用返回的停止函数模拟。
 */
describe('startRingingTimeout（响铃+超时计时核心）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('25s 到点触发一次 onTimeout(event)，之前不触发', () => {
    const onTimeout = vi.fn();
    const event = { id: 'call-1', avatarId: 'yumi' };

    startRingingTimeout(event, onTimeout);

    vi.advanceTimersByTime(24999);
    expect(onTimeout).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(onTimeout).toHaveBeenCalledWith(event);
  });

  it('调用停止函数后不再触发 onTimeout（模拟 event 置 null 停铃）', () => {
    const onTimeout = vi.fn();
    const stop = startRingingTimeout({ id: 'call-1', avatarId: 'yumi' }, onTimeout);

    stop();
    vi.advanceTimersByTime(25000);

    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('event 变化：先停旧的再起新的，旧 event 不再触发，新 event 独立计满 25s', () => {
    const onTimeout = vi.fn();
    const eventA = { id: 'call-A', avatarId: 'yumi' };
    const eventB = { id: 'call-B', avatarId: 'ellen' };

    const stopA = startRingingTimeout(eventA, onTimeout);
    vi.advanceTimersByTime(10000); // A 计时 10s 时切换到 B（effect cleanup 先跑）
    stopA();
    const stopB = startRingingTimeout(eventB, onTimeout);

    vi.advanceTimersByTime(24999); // 距 A 的 25s 早已过去，但 A 已被清掉；B 还差 1ms
    expect(onTimeout).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1); // B 满 25s
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(onTimeout).toHaveBeenCalledWith(eventB);

    void stopB;
  });

  it('自定义 timeoutMs：按传入时长触发，而非固定 25s', () => {
    const onTimeout = vi.fn();
    const event = { id: 'call-1', avatarId: 'yumi' };

    startRingingTimeout(event, onTimeout, 5000);

    vi.advanceTimersByTime(4999);
    expect(onTimeout).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });
});
