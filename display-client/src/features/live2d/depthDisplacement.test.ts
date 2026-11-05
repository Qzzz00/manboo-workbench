import { describe, it, expect } from 'vitest';
import { depthDisplacement } from './depthDisplacement.ts';

describe('depthDisplacement', () => {
  it('零倾斜输出零位移', () => {
    expect(depthDisplacement(0, 0, 20)).toEqual({ sx: 0, sy: 0 });
  });

  it('同向：正倾斜输出正位移强度', () => {
    expect(depthDisplacement(1, 1, 20)).toEqual({ sx: 20, sy: 20 });
  });

  it('线性缩放到 maxScale', () => {
    expect(depthDisplacement(0.5, -0.25, 20)).toEqual({ sx: 10, sy: -5 });
  });

  it('越界钳制到 [-1,1]', () => {
    expect(depthDisplacement(3, -2, 20)).toEqual({ sx: 20, sy: -20 });
  });
});
