import { describe, it, expect } from 'vitest';
import { mouthOverridesForLevel } from './radioMouth.ts';

describe('mouthOverridesForLevel', () => {
  it('0 或低于阈值 → 空（嘴闭）', () => {
    expect(mouthOverridesForLevel(0)).toEqual([]);
    expect(mouthOverridesForLevel(0.01)).toEqual([]);
  });
  it('中等音量 → 新旧两种命名都写 = level', () => {
    expect(mouthOverridesForLevel(0.5)).toEqual([
      { id: 'ParamMouthOpenY', value: 0.5 },
      { id: 'PARAM_MOUTH_OPEN_Y', value: 0.5 },
    ]);
  });
  it('越界钳制到 [0,1]', () => {
    expect(mouthOverridesForLevel(1.4)).toEqual([
      { id: 'ParamMouthOpenY', value: 1 },
      { id: 'PARAM_MOUTH_OPEN_Y', value: 1 },
    ]);
  });
  it('负数/NaN → 空', () => {
    expect(mouthOverridesForLevel(-0.3)).toEqual([]);
    expect(mouthOverridesForLevel(NaN)).toEqual([]);
  });
});
