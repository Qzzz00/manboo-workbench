import { describe, expect, it } from 'vitest';

import * as petVisualMode from './petVisualMode.ts';

const { shouldFadePetBottom } = petVisualMode;
const { nativePetBottomMask } = petVisualMode as typeof petVisualMode & {
  nativePetBottomMask?: (mode: petVisualMode.PetVisualMode) => { start: number; end: number } | null;
};

describe('shouldFadePetBottom', () => {
  it('普通透明桌宠保留底部渐隐，避免悬浮截肢', () => {
    expect(shouldFadePetBottom({ stripOn: false, bgOn: false, chibi: false })).toBe(true);
  });

  it('游戏底条禁用渐隐，角色应从屏幕底部探出', () => {
    expect(shouldFadePetBottom({ stripOn: true, bgOn: false, chibi: false })).toBe(false);
  });

  it('游戏底条不裁原生模型，让角色完整压在底栏上方', () => {
    expect(nativePetBottomMask?.({ stripOn: true, bgOn: false, chibi: false })).toBeNull();
  });

  it('普通透明桌宠仍保留原来的底部柔和渐隐', () => {
    expect(nativePetBottomMask?.({ stripOn: false, bgOn: false, chibi: false })).toEqual({
      start: 0.76,
      end: 0.98,
    });
  });
});
