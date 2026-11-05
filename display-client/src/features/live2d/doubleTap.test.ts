import { describe, expect, it } from 'vitest';
import { createDoubleTapDetector } from './doubleTap.ts';

function makeDetector(overrides = {}) {
  let t = 0;
  const detector = createDoubleTapDetector({ now: () => t, ...overrides });
  const advance = (ms: number) => { t += ms; };
  return { detector, advance };
}

describe('doubleTap 判定', () => {
  it('touch 小幅抖动双击成功（20px 内 / 420ms 内）', () => {
    const { detector, advance } = makeDetector();
    // 第一次点按：小幅移动（<20px）不算拖动
    detector.reset();
    detector.trackMove('touch', 12, 8);
    expect(detector.registerUp('touch')).toBe(false);
    advance(300); // 300ms 后第二击，落在 420ms 窗内
    detector.reset();
    detector.trackMove('touch', -10, 15);
    expect(detector.registerUp('touch')).toBe(true);
  });

  it('touch 位移超过 20px 不算 tap', () => {
    const { detector, advance } = makeDetector();
    detector.reset();
    detector.trackMove('touch', 0, 25);
    expect(detector.registerUp('touch')).toBe(false);
    advance(200);
    detector.reset();
    expect(detector.registerUp('touch')).toBe(false); // 上一击没登记 lastUpAt，无从双击
  });

  it('touch 超过 420ms 窗口不判双击', () => {
    const { detector, advance } = makeDetector();
    detector.reset();
    expect(detector.registerUp('touch')).toBe(false);
    advance(500);
    detector.reset();
    expect(detector.registerUp('touch')).toBe(false);
  });

  it('mouse 保持更严阈值：8px 位移即算拖动、320ms 窗', () => {
    const { detector, advance } = makeDetector();
    // 8px 内 mouse 双击成功
    detector.reset();
    detector.trackMove('mouse', 4, 4);
    expect(detector.registerUp('mouse')).toBe(false);
    advance(250);
    detector.reset();
    detector.trackMove('mouse', -4, -4);
    expect(detector.registerUp('mouse')).toBe(true);

    // 超过 8px（mouse 阈值）算拖动
    advance(500);
    detector.reset();
    detector.trackMove('mouse', 0, 10);
    expect(detector.registerUp('mouse')).toBe(false);
  });

  it('pointercancel 不计 tap、不更新 lastUpAt、不影响后续正常双击', () => {
    const { detector, advance } = makeDetector();
    // 第一击被 cancel 打断
    detector.reset();
    detector.trackMove('touch', 5, 5);
    detector.cancel(); // cancel：只清 moved，不登记 lastUpAt
    advance(100);
    // 紧接着一次正常单点 + 双击：cancel 没污染 lastUpAt，仍能正常识别
    detector.reset();
    expect(detector.registerUp('touch')).toBe(false); // 首次正常抬手登记 lastUpAt
    advance(300);
    detector.reset();
    expect(detector.registerUp('touch')).toBe(true); // 仍能双击成功
  });

  it('cancel 后 moved 被清理，下一段不受上一次拖动污染', () => {
    const { detector, advance } = makeDetector();
    detector.reset();
    detector.trackMove('touch', 50, 0); // 大幅移动 → moved
    detector.cancel(); // cancel 清 moved
    advance(100);
    detector.reset(); // 新一段
    expect(detector.registerUp('touch')).toBe(false); // moved 已清，登记 lastUpAt
    advance(200);
    detector.reset();
    expect(detector.registerUp('touch')).toBe(true);
  });
});
