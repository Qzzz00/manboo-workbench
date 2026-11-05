import { describe, it, expect } from 'vitest';
import { decidePlayerSwipe } from './playerSwipe.ts';

describe('decidePlayerSwipe', () => {
  it('左滑=下一首，右滑=上一首', () => {
    expect(decidePlayerSwipe(-60, 0, 200)).toBe('next');
    expect(decidePlayerSwipe(60, 0, 200)).toBe('prev');
  });
  it('位移不足 45 不触发（纯点击）', () => {
    expect(decidePlayerSwipe(-44, 0, 100)).toBeNull();
    expect(decidePlayerSwipe(30, 5, 100)).toBeNull();
    expect(decidePlayerSwipe(0, 0, 50)).toBeNull();
  });
  it('垂直为主的滑动不触发：|dx| 未达 |dy| 的 1.2 倍', () => {
    expect(decidePlayerSwipe(50, 50, 200)).toBeNull();
    expect(decidePlayerSwipe(-50, -45, 200)).toBeNull(); // 45*1.2=54 > 50
    expect(decidePlayerSwipe(-60, -45, 200)).toBe('next'); // 60 ≥ 54，横向足够优势
  });
  it('超时（>700ms）不触发', () => {
    expect(decidePlayerSwipe(-120, 0, 701)).toBeNull();
  });
  it('边界值：恰好 45px / 恰好 700ms 触发（与切页手势判据一致）', () => {
    expect(decidePlayerSwipe(45, 0, 700)).toBe('prev');
    expect(decidePlayerSwipe(-45, 0, 700)).toBe('next');
  });
});
