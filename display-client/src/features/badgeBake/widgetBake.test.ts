import { describe, it, expect } from 'vitest';
import { WIDGET_VIEW, widgetProfileFor, widgetFpsFor, capFrames, WIDGET_SWAY_PERIOD_S, WIDGET_SWAY_AMP } from './widgetProfile.ts';

describe('WIDGET_VIEW', () => {
  it('320×427 画幅，offsetX 水平居中式，offsetY 上移为负', () => {
    expect(WIDGET_VIEW.w).toBe(320);
    expect(WIDGET_VIEW.h).toBe(427);
    expect(WIDGET_VIEW.stageOffsetX).toBeCloseTo(-(466 * WIDGET_VIEW.stageScale - 320) / 2, 5);
    expect(WIDGET_VIEW.stageOffsetY ?? 0).toBeLessThan(0);
  });
});

describe('widgetFpsFor（时长自适应帧率，48 帧预算，MIUI 12fps 天花板）', () => {
  it('短环封顶 12fps（MIUI 地板实测）；长环降帧；下限 10', () => {
    expect(widgetFpsFor(2.4)).toBe(12);
    expect(widgetFpsFor(4)).toBe(12);
    expect(widgetFpsFor(8)).toBe(10);
  });
  it('非法时长回默认 12', () => {
    expect(widgetFpsFor(0)).toBe(12);
    expect(widgetFpsFor(NaN)).toBe(12);
  });
});

describe('widgetProfileFor', () => {
  it('motion 驱动，fps 随时长自适应（4s → 12fps）', () => {
    const p = widgetProfileFor('/live2D/x/motions/idle.motion3.json', 4);
    expect(p.fps).toBe(12);
    expect(p.driver).toEqual({
      kind: 'motion',
      url: '/live2D/x/motions/idle.motion3.json',
      wobble: true,
      loopMult: 1,
    });
    expect(p.mouth).toBeUndefined();
    expect(p.view).toBe(WIDGET_VIEW);
  });

  it('null → Tier B 自然摆动（默认 4s×12fps=48 帧顶格=墙内最优）', () => {
    const p = widgetProfileFor(null);
    expect(p.fps).toBe(12);
    expect(p.driver).toEqual({ kind: 'wobble', periodS: WIDGET_SWAY_PERIOD_S, ampScale: WIDGET_SWAY_AMP, blink: false });
    expect(p.view).toBe(WIDGET_VIEW);
  });
});

describe('capFrames', () => {
  const mk = (n: number) => Array.from({ length: n }, (_, i) => i);

  it('≤56 帧原样返回', () => {
    const r = capFrames(mk(48), 12);
    expect(r.frames.length).toBe(48);
    expect(r.fps).toBe(12);
  });

  it('96 帧隔帧取样 48 帧且 fps 减半', () => {
    const r = capFrames(mk(96), 12);
    expect(r.frames.length).toBe(48);
    expect(r.fps).toBe(6);
    expect(r.frames[1]).toBe(2);
  });

  it('200 帧循环降采到 ≤56', () => {
    const r = capFrames(mk(200), 12);
    expect(r.frames.length).toBeLessThanOrEqual(56);
    expect(r.frames.length).toBe(50);
    expect(r.fps).toBe(3);
  });
});
