import { describe, expect, test } from 'vitest';
import { planAlignedWindow } from './bakeAlign.ts';

/* 采集窗对齐速度谷（2026-07-10 证书压线诊断的治法）：
 * 侦察窗（绝对帧 0..n-1，相位=帧号）测得环形 MAD 谷下标 valley 后，第二窗从
 * startAbs 起再采 n 帧，使证书判决的回卷对（末帧→首帧）恰好落在谷转移对
 * (valley-1 → valley)。这里的不变量全是差一错误的高发地，钉死。 */
describe('planAlignedWindow', () => {
  test('第二窗承接侦察窗末帧之后，首帧相位=谷下标', () => {
    const w = planAlignedWindow(80, 8);
    expect(w.startAbs).toBe(88);
    expect(w.startAbs % 80).toBe(8);
  });

  test('回卷对=侦察窗谷转移对：末帧相位 valley-1，首帧相位 valley', () => {
    const { startAbs } = planAlignedWindow(80, 8);
    expect((startAbs + 80 - 1) % 80).toBe(7);
    expect(startAbs % 80).toBe(8);
  });

  test('物理时间只前进不倒带：startAbs ≥ n 对任意谷成立', () => {
    for (const v of [0, 1, 40, 79]) {
      expect(planAlignedWindow(80, v).startAbs).toBeGreaterThanOrEqual(80);
    }
  });

  test('谷=0 时第二窗与侦察窗同相位（调用方以此跳过重采）', () => {
    expect(planAlignedWindow(80, 0).startAbs % 80).toBe(0);
  });

  test('谷下标越界自动取模（防御：findLoopValleyIndex 语义内不会发生）', () => {
    expect(planAlignedWindow(80, 88).startAbs % 80).toBe(8);
  });
});
