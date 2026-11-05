/**
 * 手机串联去卡顿(2026-09-24,维护者真机:「无论是电脑端还是手机端,粒子从黑洞变成球的过程都是先卡住的」)。
 * 过程与修前 / 修后数据:docs/交接-0924-串联动画去卡顿.md。核心的调度用例在电脑端
 * workbench-plugin/tests/client-brand-handoff-jank.test.tsx(同一份 blackhole.js);这里钉手机自己的两件:
 *   ① 手机真走的几乎都是「屏上没有黑洞」那条(扫码页 / 账号页):起点整份在空闲时预先画好,配对成功直接用;
 *   ② 舞台上的球(ParticleStage)在串联起步期间不初始化渲染器,放行之后才初始化。
 */
/** @vitest-environment jsdom */
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HANDOFF_DEFER_UNTIL, HANDOFF_MS, orbTargets, prepareHandoff, runHandoff, type SwarmLike } from '../src/brand/blackhole.js';
import { fallbackHeroRect } from '../src/brand/brandHandoff';
import { ParticleStage } from '../src/swarm/ParticleStage';
import { SwarmV4 } from '../src/swarm/core.js';
import { defaultPreset } from '../src/swarm/appearance';
import { phoneOrbSettings } from '../src/swarm/orbState';

const Swarm = SwarmV4 as unknown as new (n: number) => SwarmLike;

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

function stubCanvas() {
  const ctx = new Proxy({}, {
    get: (_, key) => key === 'createImageData' ? (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }) : () => {},
    set: () => true,
  });
  return vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
}

describe('① 屏上没有黑洞时的起点:空闲时整份画好', () => {
  it('按兜底位置(屏幕上部)、每 5 颗画 1 颗预先造好;配对成功那一刻直接拿来飞', async () => {
    stubCanvas();
    const idleWindow = Object.assign(Object.create(window), {
      requestIdleCallback: (cb: (d: { timeRemaining(): number }) => void) => { cb({ timeRemaining: () => 50 }); return 1; },
      cancelIdleCallback: () => {},
      document, innerWidth: 390, innerHeight: 844, devicePixelRatio: 1,
    }) as Window;
    const rect = fallbackHeroRect(390, 844);
    const prepared = prepareHandoff({
      SwarmClass: Swarm, settings: phoneOrbSettings(defaultPreset().settings, 'idle'), count: 120,
      painter: () => null, window: idleWindow, refreshMs: 60_000,
      fallbackRect: () => rect, fallbackStride: 5,
    });
    for (let k = 0; k < 50 && prepared.source() === null; k++) await new Promise(resolve => setTimeout(resolve, 5));
    const source = prepared.source();
    expect(source).not.toBeNull();
    expect(source!.rect).toEqual(rect);
    expect(source!.painter.stride).toBe(5);
    expect(source!.sources.length).toBe(120);
    expect(source!.sources.every(p => p.i % 5 === 0)).toBe(true);
    expect(prepared.targets()?.warmed).toBe(true);

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance'] });
    const handle = runHandoff({
      fallbackRect: rect, source, targets: prepared.targets()!, count: 80, findOrb: () => null,
    });
    expect(document.documentElement.dataset.brandHandoff).toBe('fly');
    handle.cancel();
    prepared.cancel();
    await handle.done;
  });
});

describe('② 舞台上的球让路', () => {
  it('串联起步期间只挂画布、不初始化;放行之后才初始化', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance'] });
    stubCanvas();
    const handle = runHandoff({ targets: orbTargets(Swarm, phoneOrbSettings(defaultPreset().settings, 'idle'), 20), count: 20, findOrb: () => null });
    const onDegraded = vi.fn();
    render(<ParticleStage mode="idle" settings={defaultPreset().settings} onDegraded={onDegraded} />);
    // jsdom 里一初始化就会「退回声纹球」并报原因 —— 没报 = 还没初始化。
    expect(onDegraded).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(HANDOFF_MS * HANDOFF_DEFER_UNTIL + 40); });
    expect(onDegraded).toHaveBeenCalled();
    handle.cancel();
  });
});
