import { describe, it, expect } from 'vitest';
import { shouldCancelBySlide, isTooShort, CANCEL_SLIDE_PX, MIN_RECORD_MS } from './voiceGesture';

describe('shouldCancelBySlide', () => {
  it('上滑超过阈值 → true', () => {
    expect(shouldCancelBySlide(500, 500 - CANCEL_SLIDE_PX - 1)).toBe(true);
  });
  it('上滑恰好等于阈值 → true', () => {
    expect(shouldCancelBySlide(500, 500 - CANCEL_SLIDE_PX)).toBe(true);
  });
  it('上滑不足阈值 → false', () => {
    expect(shouldCancelBySlide(500, 500 - 10)).toBe(false);
  });
  it('下滑 → false', () => {
    expect(shouldCancelBySlide(500, 600)).toBe(false);
  });
});

describe('isTooShort', () => {
  it('短于下限 → true', () => { expect(isTooShort(MIN_RECORD_MS - 1)).toBe(true); });
  it('达到下限 → false', () => { expect(isTooShort(MIN_RECORD_MS)).toBe(false); });
});
