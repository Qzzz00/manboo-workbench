import { describe, expect, test } from 'vitest';
import { dizzyWobble, DIZZY_DURATION_MS, DIZZY_ATTACK_MS } from './dizzyWobble.ts';

describe('dizzyWobble', () => {
  const D = DIZZY_DURATION_MS;

  test('起点(t=0)从中位甩出：focus 与张嘴均≈0，但已激活', () => {
    const f = dizzyWobble(0);
    expect(f.active).toBe(true);
    expect(Math.abs(f.focusX)).toBeLessThan(1e-6);
    expect(Math.abs(f.focusY)).toBeLessThan(1e-6);
    expect(Math.abs(f.mouthOpen)).toBeLessThan(1e-6);
  });

  test('时长结束/越界 → 未激活且全部归零', () => {
    expect(dizzyWobble(D)).toEqual({ active: false, focusX: 0, focusY: 0, mouthOpen: 0 });
    expect(dizzyWobble(D + 500)).toEqual({ active: false, focusX: 0, focusY: 0, mouthOpen: 0 });
    expect(dizzyWobble(-10)).toEqual({ active: false, focusX: 0, focusY: 0, mouthOpen: 0 });
  });

  test('起手爬升：攀到峰值时摆动幅度接近满量程（动作大）', () => {
    // 起手 DIZZY_ATTACK_MS 后包络到 1，取此后一小段的峰值幅度应接近满量程。
    let peak = 0;
    for (let e = DIZZY_ATTACK_MS; e < DIZZY_ATTACK_MS + 500; e += 5) {
      peak = Math.max(peak, Math.hypot(dizzyWobble(e).focusX, dizzyWobble(e).focusY));
    }
    expect(peak).toBeGreaterThan(0.9);
  });

  test('长尾慢衰减：过半时仍有可观余波（动作大→余波久）', () => {
    // 用户摇完停手时（约演出中段）仍要有明显晃动可看。取 t≈0.5 处峰值应仍较大。
    let midPeak = 0;
    for (let e = 0.45 * D; e < 0.55 * D; e += 5) {
      midPeak = Math.max(midPeak, Math.abs(dizzyWobble(e).focusX));
    }
    expect(midPeak).toBeGreaterThan(0.35);
  });

  test('包络单调衰减：前段峰值 > 中段 > 尾段', () => {
    const maxAbsX = (from: number, to: number) => {
      let m = 0;
      for (let e = from; e < to; e += 5) m = Math.max(m, Math.abs(dizzyWobble(e).focusX));
      return m;
    };
    const early = maxAbsX(DIZZY_ATTACK_MS, 0.25 * D);
    const mid = maxAbsX(0.4 * D, 0.6 * D);
    const late = maxAbsX(0.75 * D, D);
    expect(early).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(late);
  });

  test('圆周打转：focusX 与 focusY 都多次变号（绕圈而非纯左右）', () => {
    const countCrossings = (pick: (e: number) => number) => {
      let sign = 0;
      let crossings = 0;
      for (let e = 0; e < D; e += 5) {
        const s = Math.sign(pick(e));
        if (s !== 0 && sign !== 0 && s !== sign) crossings++;
        if (s !== 0) sign = s;
      }
      return crossings;
    };
    expect(countCrossings((e) => dizzyWobble(e).focusX)).toBeGreaterThanOrEqual(6);
    expect(countCrossings((e) => dizzyWobble(e).focusY)).toBeGreaterThanOrEqual(6);
  });

  test('张嘴：随余波慢慢合上，末尾归零', () => {
    const start = dizzyWobble(DIZZY_ATTACK_MS + 100).mouthOpen;
    const late = dizzyWobble(0.85 * D).mouthOpen;
    expect(start).toBeGreaterThan(0.4);
    expect(start).toBeGreaterThan(late);
    expect(dizzyWobble(0.99 * D).mouthOpen).toBeLessThan(0.1);
  });

  test('focus 幅度始终在 [-1,1]（focusController 归一化空间）', () => {
    for (let e = 0; e < D; e += 7) {
      const f = dizzyWobble(e);
      expect(Math.abs(f.focusX)).toBeLessThanOrEqual(1);
      expect(Math.abs(f.focusY)).toBeLessThanOrEqual(1);
    }
  });
});
