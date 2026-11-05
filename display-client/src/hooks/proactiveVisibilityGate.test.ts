import { describe, expect, it } from 'vitest';
import {
  shouldPerformProactive,
  shouldTriggerCatchUpOnReady,
  claimPerformIfAllowed,
} from './proactiveVisibilityGate.ts';

/**
 * shouldPerformProactive 是「后台标签不替用户出声」的纯判定核心：
 * 仅当页面可见（document.visibilityState === 'visible'）时才允许 performProactive 出声；
 * 后台（hidden）/预渲染（prerender）/其它未知状态一律返回 false（静默）。
 * 记录类副作用（未读/消息）不走此门，此处只测「出声」判定。
 */
describe('shouldPerformProactive（后台标签出声门控判定）', () => {
  it('visible 时返回 true（前台可见，正常出声）', () => {
    expect(shouldPerformProactive('visible')).toBe(true);
  });

  it('hidden 时返回 false（后台标签，静默不出声——与 visible 取反）', () => {
    expect(shouldPerformProactive('hidden')).toBe(false);
    expect(shouldPerformProactive('hidden')).toBe(!shouldPerformProactive('visible'));
  });

  it('prerender 时返回 false（预渲染未真正可见，不出声）', () => {
    expect(shouldPerformProactive('prerender')).toBe(false);
  });

  it('其它/未知状态一律返回 false（保守静默）', () => {
    expect(shouldPerformProactive('unloaded')).toBe(false);
    expect(shouldPerformProactive('')).toBe(false);
  });
});

/**
 * ALL-434：App 冷启动/启动页/鉴权加载/切角色过渡期间，WebView 已可见但角色聊天/演出
 * 路径未就绪，此时不能提前开口。appReady 作为第二个门并入 shouldPerformProactive：
 * 页面可见 + App 未就绪 → false；可见 + 就绪 → true；hidden + 就绪 → 仍 false。
 */
describe('shouldPerformProactive — App 演出就绪门（ALL-434）', () => {
  it('visible 但 App/聊天未就绪（appReady=false）：返回 false，冷启动/加载中不出声', () => {
    expect(shouldPerformProactive('visible', false)).toBe(false);
  });

  it('visible + appReady=true：返回 true（聊天可见且演出路径就绪）', () => {
    expect(shouldPerformProactive('visible', true)).toBe(true);
  });

  it('hidden + appReady=true：返回 false（页面不可见仍静默）', () => {
    expect(shouldPerformProactive('hidden', true)).toBe(false);
  });

  it('缺省 appReady=true：仅可见性门控，保持旧行为', () => {
    expect(shouldPerformProactive('visible')).toBe(true);
    expect(shouldPerformProactive('hidden')).toBe(false);
  });
});

/**
 * shouldTriggerCatchUpOnReady：useProactivePerformance 监听 performanceReady 边沿的纯判定，
 * 保证「就绪条件延后满足时自动补拉一次」，且就绪态未变化不重复触发。
 */
describe('shouldTriggerCatchUpOnReady（就绪门 false→true 边沿，触发一次 catchUp）', () => {
  it('首次渲染即就绪（previousReady=null, current=true）：触发一次（覆盖挂载即就绪）', () => {
    expect(shouldTriggerCatchUpOnReady(null, true)).toBe(true);
  });

  it('false → true：触发一次（冷启动/切角色后舞台就绪）', () => {
    expect(shouldTriggerCatchUpOnReady(false, true)).toBe(true);
  });

  it('false → false：不触发（仍在加载中）', () => {
    expect(shouldTriggerCatchUpOnReady(false, false)).toBe(false);
  });

  it('true → true：不触发（就绪态未变化，不重复补拉）', () => {
    expect(shouldTriggerCatchUpOnReady(true, true)).toBe(false);
  });

  it('true → false：不触发（就绪被打断）', () => {
    expect(shouldTriggerCatchUpOnReady(true, false)).toBe(false);
  });
});

/**
 * claimPerformIfAllowed：实时 SSE 与上线补拉共用的 perform 出口判定。
 * gate 关闭（后台/App 未就绪）时不演出、不把 messageId 计入 performed——服务端保持
 * 未 seen，等 gate 打开后 catchUp 仍可补演，不会因「提前开口被拦」而永久丢失。
 */
describe('claimPerformIfAllowed（出声门控 + 会话内去重）', () => {
  it('gate 关闭（allowed=false）：拒绝且不把 id 计入 performed（保留补演机会）', () => {
    const performed = new Set<string>();
    expect(claimPerformIfAllowed(false, 'm1', performed)).toBe(false);
    expect(performed.has('m1')).toBe(false);
  });

  it('gate 打开 + 新 id：放行并计入 performed（防后续重复演出）', () => {
    const performed = new Set<string>();
    expect(claimPerformIfAllowed(true, 'm1', performed)).toBe(true);
    expect(performed.has('m1')).toBe(true);
  });

  it('gate 打开 + 已演出过的 id：拒绝（防重复）', () => {
    const performed = new Set(['m1']);
    expect(claimPerformIfAllowed(true, 'm1', performed)).toBe(false);
  });

  it('gate 关闭后再次打开：同一 id 仍可补演（不丢失）', () => {
    const performed = new Set<string>();
    expect(claimPerformIfAllowed(false, 'm1', performed)).toBe(false);
    expect(performed.has('m1')).toBe(false);
    expect(claimPerformIfAllowed(true, 'm1', performed)).toBe(true);
  });

  it('无 messageId：gate 打开直接放行', () => {
    expect(claimPerformIfAllowed(true, undefined, new Set())).toBe(true);
  });
});
