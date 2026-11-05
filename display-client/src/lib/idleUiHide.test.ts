import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createIdleHideController, IDLE_HIDE_MS } from './idleUiHide';

describe('createIdleHideController（主页沉浸模式计时器）', () => {
  let hidden: boolean[];
  let onChange: (h: boolean) => void;

  beforeEach(() => {
    vi.useFakeTimers();
    hidden = [];
    onChange = (h) => hidden.push(h);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('激活后 30s 无触屏 → 隐藏', () => {
    const c = createIdleHideController(onChange);
    c.setActive(true);
    vi.advanceTimersByTime(IDLE_HIDE_MS - 1);
    expect(hidden).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(hidden).toEqual([true]);
    c.dispose();
  });

  it('触屏重置计时：29s 时摸一下，再等 29s 仍显示，满 30s 才隐藏', () => {
    const c = createIdleHideController(onChange);
    c.setActive(true);
    vi.advanceTimersByTime(29_000);
    c.touch();
    vi.advanceTimersByTime(29_000);
    expect(hidden).toEqual([]);
    vi.advanceTimersByTime(1_000);
    expect(hidden).toEqual([true]);
    c.dispose();
  });

  it('隐藏后触屏 → 立即唤回并重新计时', () => {
    const c = createIdleHideController(onChange);
    c.setActive(true);
    vi.advanceTimersByTime(IDLE_HIDE_MS);
    expect(hidden).toEqual([true]);
    c.touch();
    expect(hidden).toEqual([true, false]);
    vi.advanceTimersByTime(IDLE_HIDE_MS);
    expect(hidden).toEqual([true, false, true]);
    c.dispose();
  });

  it('setActive(false)（豁免态/离开主页）→ 立即唤回且不再计时', () => {
    const c = createIdleHideController(onChange);
    c.setActive(true);
    vi.advanceTimersByTime(IDLE_HIDE_MS);
    expect(hidden).toEqual([true]);
    c.setActive(false);
    expect(hidden).toEqual([true, false]);
    vi.advanceTimersByTime(IDLE_HIDE_MS * 2);
    expect(hidden).toEqual([true, false]);
    c.dispose();
  });

  it('非激活期间 touch/wake 不计时不报错', () => {
    const c = createIdleHideController(onChange);
    c.touch();
    c.wake();
    vi.advanceTimersByTime(IDLE_HIDE_MS * 2);
    expect(hidden).toEqual([]);
    c.dispose();
  });

  it('wake()（新消息到达）→ 唤回并重新计时', () => {
    const c = createIdleHideController(onChange);
    c.setActive(true);
    vi.advanceTimersByTime(IDLE_HIDE_MS);
    c.wake();
    expect(hidden).toEqual([true, false]);
    vi.advanceTimersByTime(IDLE_HIDE_MS);
    expect(hidden).toEqual([true, false, true]);
    c.dispose();
  });

  it('只在状态变化时回调（重复 setActive(true) 不抖动）', () => {
    const c = createIdleHideController(onChange);
    c.setActive(true);
    c.setActive(true);
    c.touch();
    expect(hidden).toEqual([]);
    c.dispose();
  });

  it('dispose 后计时器清理，不再触发', () => {
    const c = createIdleHideController(onChange);
    c.setActive(true);
    c.dispose();
    vi.advanceTimersByTime(IDLE_HIDE_MS * 2);
    expect(hidden).toEqual([]);
  });
});
