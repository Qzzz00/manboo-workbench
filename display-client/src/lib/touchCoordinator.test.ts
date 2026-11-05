/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from 'vitest';
import { createTouchCoordinator, type CoordinatorSinks } from './touchCoordinator.ts';
import type { TouchEvent, TouchContext } from './touchRouter.ts';

const msg = (id: string, avatarId = 'a1', overrides: Partial<TouchEvent> = {}): TouchEvent => ({
  kind: 'message',
  tier: 'daily',
  id,
  avatarId,
  content: 'hi',
  ...overrides,
});

const call = (id: string, avatarId = 'a1', overrides: Partial<TouchEvent> = {}): TouchEvent => ({
  kind: 'call',
  tier: 'heavy',
  id,
  avatarId,
  ...overrides,
});

function makeSinks(): CoordinatorSinks {
  return {
    perform: vi.fn(),
    showBanner: vi.fn(),
    startInplaceCall: vi.fn(),
    startFullscreenCall: vi.fn(),
    reportMissed: vi.fn(),
    markUnread: vi.fn(),
  };
}

function makeCtx(overrides: Partial<TouchContext> = {}): () => TouchContext {
  const ctx: TouchContext = {
    flagEnabled: true,
    currentAvatarId: 'a1',
    inCall: false,
    callEnabled: true,
    ...overrides,
  };
  return () => ctx;
}

describe('createTouchCoordinator', () => {
  it('规则①：事件按到达顺序处理', () => {
    const sinks = makeSinks();
    const { push } = createTouchCoordinator(sinks, makeCtx());
    push(msg('m1'));
    push(msg('m2', 'a2'));
    push(msg('m3'));

    const callOrder = [
      ...(sinks.perform as any).mock.invocationCallOrder.map((o: number) => ['perform', o]),
      ...(sinks.showBanner as any).mock.invocationCallOrder.map((o: number) => ['banner', o]),
    ].sort((a, b) => a[1] - b[1]);

    expect(callOrder.map((c) => c[0])).toEqual(['perform', 'banner', 'perform']);
    expect((sinks.perform as any).mock.calls[0][0].id).toBe('m1');
    expect((sinks.showBanner as any).mock.calls[0][0].id).toBe('m2');
    expect((sinks.perform as any).mock.calls[1][0].id).toBe('m3');
  });

  it('规则②：来电提示期间到达的消息全部 silent + markUnread', () => {
    const sinks = makeSinks();
    const { push } = createTouchCoordinator(sinks, makeCtx());

    push(call('c1', 'a2')); // 画外来电 -> call-fullscreen，进入 ringing
    expect(sinks.startFullscreenCall).toHaveBeenCalledTimes(1);

    const m1 = msg('m1'); // 当前角色消息，正常应 perform，但铃响期间应全部静默
    push(m1);
    expect(sinks.perform).not.toHaveBeenCalled();
    expect(sinks.markUnread).toHaveBeenCalledWith(m1);
  });

  it('规则③：来电提示期间再来一个来电 -> 第二个 reportMissed（不叠铃）', () => {
    const sinks = makeSinks();
    const { push } = createTouchCoordinator(sinks, makeCtx());

    push(call('c1')); // 当前角色来电 -> call-inplace，进入 ringing
    expect(sinks.startInplaceCall).toHaveBeenCalledTimes(1);

    const c2 = call('c2', 'a2');
    push(c2); // 铃响期间的第二个来电
    expect(sinks.reportMissed).toHaveBeenCalledWith(c2);
    expect(sinks.startFullscreenCall).not.toHaveBeenCalled();
    expect(sinks.startInplaceCall).toHaveBeenCalledTimes(1);
  });

  it('规则④：横幅正在显示时来电到达 -> 立即出来电（coordinator 不管横幅生命周期）', () => {
    const sinks = makeSinks();
    const { push } = createTouchCoordinator(sinks, makeCtx());

    push(msg('m1', 'a2')); // 画外消息 -> banner，coordinator 不因此进入 ringing
    expect(sinks.showBanner).toHaveBeenCalledTimes(1);

    const c1 = call('c1');
    push(c1); // 来电应立即触发，不受 banner 影响
    expect(sinks.startInplaceCall).toHaveBeenCalledWith(c1);
  });

  it('规则⑤：banner 与 silent 均 markUnread', () => {
    const sinks = makeSinks();
    const { push } = createTouchCoordinator(sinks, makeCtx());

    const bannerMsg = msg('m1', 'a2');
    push(bannerMsg);
    expect(sinks.showBanner).toHaveBeenCalledWith(bannerMsg);
    expect(sinks.markUnread).toHaveBeenCalledWith(bannerMsg);

    const silentMsg = msg('m2', 'a1', { tier: 'silent' });
    push(silentMsg);
    expect(sinks.markUnread).toHaveBeenCalledWith(silentMsg);
  });

  it('callResolved() 后放行队列：铃响结束后新消息恢复正常路由', () => {
    const sinks = makeSinks();
    const { push, callResolved } = createTouchCoordinator(sinks, makeCtx());

    push(call('c1', 'a2')); // 进入 ringing
    callResolved(); // 挂断/接听/超时后放行

    const m1 = msg('m1');
    push(m1);
    expect(sinks.perform).toHaveBeenCalledWith(m1);
    expect(sinks.markUnread).not.toHaveBeenCalledWith(m1);
  });

  it('dispose() 可调用且不抛异常', () => {
    const sinks = makeSinks();
    const { dispose } = createTouchCoordinator(sinks, makeCtx());
    expect(() => dispose()).not.toThrow();
  });

  // ALL-439：push 返回路由动作，补拉链路据此判断「用户是否可感知」以决定能否 markSeen。
  it('push 返回路由动作（perform/banner/silent）', () => {
    const sinks = makeSinks();
    const { push } = createTouchCoordinator(sinks, makeCtx());
    expect(push(msg('m1')).type).toBe('perform'); // 当前角色消息
    expect(push(msg('m2', 'a2')).type).toBe('banner'); // 画外消息
    expect(push(msg('m3', 'a1', { tier: 'silent' })).type).toBe('silent'); // 静默 tier
  });

  it('push 返回路由动作：通话中消息判 silent', () => {
    const sinks = makeSinks();
    const { push } = createTouchCoordinator(sinks, makeCtx({ inCall: true }));
    expect(push(msg('m1')).type).toBe('silent');
  });
});
