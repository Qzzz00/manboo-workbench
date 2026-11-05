import { describe, it, expect } from 'vitest';
import { computeCoverScale } from './coverScale.ts';

describe('computeCoverScale', () => {
  it('宽度受限：按 sw/tw 放大', () => {
    // tex 100x100, screen 200x100 → 需 200/100=2（高度 100/100=1，取大者）
    expect(computeCoverScale(100, 100, 200, 100)).toBe(2);
  });

  it('高度受限：按 sh/th 放大', () => {
    expect(computeCoverScale(100, 100, 100, 300)).toBe(3);
  });

  it('overscan 叠乘', () => {
    expect(computeCoverScale(100, 100, 200, 100, 1.2)).toBeCloseTo(2.4, 5);
  });

  it('除零保护：texW 和 texH 为 0 时钳到 1', () => {
    const result = computeCoverScale(0, 0, 200, 100);
    expect(Number.isFinite(result)).toBe(true);
    expect(result).toBe(200);
  });
});
