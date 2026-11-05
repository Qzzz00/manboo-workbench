/**
 * 手机上的粒子黑洞与串联(2026-09-23,docs/交接-0923-黑洞主视觉与图标.md)。
 * 核心(blackhole.js)的状态机用例在电脑端 workbench-plugin/tests/client-brand-blackhole.test.ts —— 同一份文件;
 * 这里钉:与源逐字节相同、手机的终点(她的核心 + 手机参数)、走哪条路、兜底起点、样式、runHandoff 按时收场。
 */
/** @vitest-environment jsdom */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HANDOFF_MS, HANDOFF_REDUCED_MS, handoffFrame, orbTargets, runHandoff, type SwarmLike } from '../src/brand/blackhole.js';
import { PHONE_HANDOFF_COUNT, fallbackHeroRect, handoffMode, startBrandHandoff } from '../src/brand/brandHandoff';
import { heroLayout } from '../src/brand/BlackholeHero';
import { SwarmV4 } from '../src/swarm/core.js';
import { defaultPreset } from '../src/swarm/appearance';
import { phoneOrbSettings } from '../src/swarm/orbState';

const repo = resolve(__dirname, '../..');

describe('核心与源逐字节相同', () => {
  for (const name of ['blackhole.js', 'blackhole.d.ts']) {
    it(name, () => {
      expect(readFileSync(resolve(repo, `butler-app/src/brand/${name}`), 'utf8')).toBe(readFileSync(resolve(repo, `docs/brand/${name}`), 'utf8'));
    });
  }
});

describe('手机串联', () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
  it('走哪条路:没画布不做;减少动效只淡;否则飞', () => {
    expect(handoffMode({ canvas: false, reduced: false })).toBe('none');
    expect(handoffMode({ canvas: true, reduced: true })).toBe('fade');
    expect(handoffMode({ canvas: true, reduced: false })).toBe('fly');
  });
  it('jsdom 里没有画布:什么都不做,不留痕迹(登录照常)', () => {
    expect(startBrandHandoff(null)).toBeNull();
    expect(document.documentElement.dataset.brandHandoff).toBeUndefined();
  });
  it('时长 1.5–2.5 秒;减少动效 0.6 秒内', () => {
    expect(HANDOFF_MS).toBeGreaterThanOrEqual(1500);
    expect(HANDOFF_MS).toBeLessThanOrEqual(2500);
    expect(handoffFrame(HANDOFF_REDUCED_MS, true).done).toBe(true);
  });
  it('终点是她的核心、手机参数(光团关):投影在球里', () => {
    const settings = phoneOrbSettings(defaultPreset().settings, 'idle');
    expect(settings.cloudSize).toBe(0);
    const targets = orbTargets(SwarmV4 as unknown as new (n: number) => SwarmLike, settings, PHONE_HANDOFF_COUNT);
    const rect = { left: 0, top: 100, width: 300, height: 300 };
    const center = targets.center(rect);
    for (const p of targets.project(rect)) expect(Math.hypot(p.x - center.x, p.y - center.y)).toBeLessThan(300 * 0.32 * 1.25 * 1.32);
  });
  it('没黑洞在屏上时,起点在屏幕上部', () => {
    const rect = fallbackHeroRect(390, 844);
    expect(rect.top + rect.height).toBeLessThan(844 * 0.4);
    expect(rect.width).toBe(390);
  });
  it('欢迎屏黑洞的版式:环 10.5% 宽,不超过高的 26%', () => {
    expect(heroLayout(390, 280).radius).toBeCloseTo(390 * 0.105);
    expect(heroLayout(390, 100).radius).toBe(26);
  });
  it('runHandoff 不拦人,按时收场', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance'] });
    const ctx = new Proxy({}, { get: (_, key) => key === 'createImageData' ? (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }) : () => {}, set: () => true });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
    const handle = runHandoff({ targets: orbTargets(SwarmV4 as unknown as new (n: number) => SwarmLike, defaultPreset().settings, 40), count: 40, fallbackRect: fallbackHeroRect(390, 844) });
    expect(handle.canvas.style.pointerEvents).toBe('none');
    expect(document.documentElement.dataset.brandHandoff).toBe('fly');
    vi.advanceTimersByTime(HANDOFF_MS + 100);
    await handle.done;
    expect(document.documentElement.dataset.brandHandoff).toBeUndefined();
    expect(handle.canvas.isConnected).toBe(false);
  });
  it('样式:飞行期间只把球画布的透明度交给 --brand-handoff-orb', () => {
    const css = readFileSync(resolve(repo, 'butler-app/src/styles.css'), 'utf8');
    expect(css).toContain('html[data-brand-handoff] .ba-particles .ba-particles__canvas { opacity: var(--brand-handoff-orb, 1); }');
    expect(css).toMatch(/\.ba-login__hero \{[^}]*pointer-events: none/);
  });
});
