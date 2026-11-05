import { describe, expect, it, vi } from 'vitest';
import { shouldPlayNotifySound } from './useProactivePerformance.ts';
import {
  shouldPerformProactive,
  shouldTriggerCatchUpOnReady,
  claimPerformIfAllowed,
} from './proactiveVisibilityGate.ts';
import { runProactiveCatchUp } from '../lib/proactiveActions.ts';

/**
 * shouldPlayNotifySound 是「前台 banner 是否该响一次提示音」的纯判定核心：
 * 有 notifySoundUrl（非空字符串）才播，无/空/undefined 一律静音（等价现状）。
 * 真正的播放副作用（new Audio(url).play()）由 showBanner sink 内联触发，
 * 这里只测判定，不测 Audio（node 环境无该全局）。
 */
describe('shouldPlayNotifySound（前台提示音播放判定）', () => {
  it('有 notifySoundUrl 时返回 true', () => {
    expect(shouldPlayNotifySound('https://cdn.example.com/notify.mp3')).toBe(true);
  });

  it('undefined 时返回 false（角色未配置提示音，静默，等价现状）', () => {
    expect(shouldPlayNotifySound(undefined)).toBe(false);
  });

  it('空字符串时返回 false', () => {
    expect(shouldPlayNotifySound('')).toBe(false);
  });
});

/**
 * ALL-434 的 hook 级接线（mount 不提前补演 / performanceReady false→true 补一次 / 未就绪
 * 收到 live 事件不演出）依赖 React effect 生命周期，node 测试环境无 jsdom/渲染器跑不动。
 * 按仓库既有约定（useRingingTimeout / useRemoteAvatars 均抽取纯核心测试），这里把
 * useProactivePerformance 的门控接线还原为纯核心组合验证：就绪门边沿判定 +
 * runProactiveCatchUp 的 gate 拦截 + claimPerformIfAllowed 的「gate 关闭不占 performed」。
 */
describe('useProactivePerformance — ALL-434 演出就绪门接线', () => {
  const msg = (id: string, createdAt: number) => ({ id, content: `c${id}`, createdAt });

  function makeCatchUpDeps(visibilityAllowed: () => boolean) {
    const performed = new Set<string>();
    let lastSeen = 0;
    const applyMessage = vi.fn();
    const markSeen = vi.fn(async () => {});
    const deps = {
      fetchSince: vi.fn(async () => [msg('p1', 1000)]),
      markSeen,
      applyMessage: (m: { id: string; content: string; createdAt: number }) => applyMessage(m),
      visibilityAllowed,
      getLastSeen: () => lastSeen,
      setLastSeen: (v: number) => { lastSeen = v; },
      performed,
    };
    return { deps, applyMessage, markSeen, getLastSeen: () => lastSeen };
  }

  it('mount 时 performanceReady=false：就绪门不触发 catchUp（启动/加载期间不补拉演出）', () => {
    // 冷启动首帧：就绪门边沿判定（首次渲染 prev=null, ready=false）返回 false → 不调用 catchUp。
    expect(shouldTriggerCatchUpOnReady(null, false)).toBe(false);
  });

  it('mount 时 performanceReady=false：即使 catchUp 被调用，gate 也拦下演出/seen（不丢消息）', async () => {
    const { deps, applyMessage, markSeen, getLastSeen } = makeCatchUpDeps(() =>
      shouldPerformProactive('visible', false),
    );
    await runProactiveCatchUp('a1', deps);
    expect(applyMessage).not.toHaveBeenCalled();
    expect(markSeen).not.toHaveBeenCalled();
    expect(getLastSeen()).toBe(0);
  });

  it('performanceReady false→true：就绪门触发一次 catchUp，补演未 seen beat 并 seen', async () => {
    expect(shouldTriggerCatchUpOnReady(false, true)).toBe(true);
    const { deps, applyMessage, markSeen, getLastSeen } = makeCatchUpDeps(() =>
      shouldPerformProactive('visible', true),
    );
    await runProactiveCatchUp('a1', deps);
    expect(applyMessage).toHaveBeenCalledTimes(1);
    expect(markSeen).toHaveBeenCalledTimes(1);
    expect(getLastSeen()).toBe(1000);
  });

  it('ready=false 时收到 proactive/live 事件：不 performProactive、不占 performed，ready=true 后可补演', () => {
    // 实时 SSE 的 perform 出口 = claimPerformIfAllowed：gate 关闭时拒绝且不把 messageId
    // 计入 performed，同一 id 在 gate 打开后仍可演出（由 catchUp 补），不会永久丢失。
    const performed = new Set<string>();
    expect(claimPerformIfAllowed(shouldPerformProactive('visible', false), 'm1', performed)).toBe(false);
    expect(performed.has('m1')).toBe(false);
    expect(claimPerformIfAllowed(shouldPerformProactive('visible', true), 'm1', performed)).toBe(true);
    expect(performed.has('m1')).toBe(true);
  });
});
