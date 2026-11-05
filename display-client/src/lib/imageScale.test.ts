import { describe, it, expect } from 'vitest';
import { fitDimensions } from './imageScale.ts';

describe('fitDimensions', () => {
  it('横图按宽缩放', () => {
    expect(fitDimensions(4000, 2000, 1024)).toEqual({ width: 1024, height: 512 });
  });
  it('竖图按高缩放', () => {
    expect(fitDimensions(2000, 4000, 1024)).toEqual({ width: 512, height: 1024 });
  });
  it('小图不放大', () => {
    expect(fitDimensions(800, 600, 1024)).toEqual({ width: 800, height: 600 });
  });
  it('正方形', () => {
    expect(fitDimensions(2048, 2048, 1024)).toEqual({ width: 1024, height: 1024 });
  });
});
