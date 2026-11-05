import { describe, it, expect, vi } from 'vitest';

vi.mock('pixi-live2d-display/cubism4', () => ({ Live2DModel: class {} }));
vi.mock('pixi.js', () => ({ default: {}, Application: class {}, Sprite: class {} }));

import { smootherstep } from './live2dEngine.ts';

describe('smootherstep', () => {
  it('端点为 0 和 1', () => {
    expect(smootherstep(0)).toBeCloseTo(0, 9);
    expect(smootherstep(1)).toBeCloseTo(1, 9);
  });
  it('中点为 0.5', () => {
    expect(smootherstep(0.5)).toBeCloseTo(0.5, 9);
  });
  it('两端导数为 0（慢起慢停）：靠近 0/1 的增量远小于中段', () => {
    const dStart = smootherstep(0.05) - smootherstep(0);
    const dMid = smootherstep(0.55) - smootherstep(0.5);
    expect(dStart).toBeLessThan(dMid * 0.2);
  });
  it('越界输入被裁剪', () => {
    expect(smootherstep(-1)).toBeCloseTo(0, 9);
    expect(smootherstep(2)).toBeCloseTo(1, 9);
  });
});
