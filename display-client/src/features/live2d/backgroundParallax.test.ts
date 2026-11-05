import { describe, it, expect } from 'vitest';
import { parallaxOffset } from './backgroundParallax.ts';

describe('parallaxOffset', () => {
  it('零倾斜 → 零位移', () => {
    expect(parallaxOffset(0, 0, 14)).toEqual({ x: 0, y: 0 });
  });

  it('按 maxPx 线性缩放', () => {
    expect(parallaxOffset(1, -1, 14)).toEqual({ x: 14, y: -14 });
    expect(parallaxOffset(0.5, 0.5, 14)).toEqual({ x: 7, y: 7 });
  });

  it('把越界输入钳制到 [-1,1]，防止层露边', () => {
    expect(parallaxOffset(2, -3, 14)).toEqual({ x: 14, y: -14 });
  });

  it('不同 maxPx 独立缩放（近层大、远层小）', () => {
    expect(parallaxOffset(1, 1, 6)).toEqual({ x: 6, y: 6 });
  });
});
