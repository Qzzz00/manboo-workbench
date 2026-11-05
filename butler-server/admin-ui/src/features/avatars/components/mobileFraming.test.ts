// 来源:Aiboo origin/main 1f430c3f admin-ui/src/features/avatars/components/mobileFraming.test.ts
/**
 * 回归：老角色（DB transform 无 modelTransform，如种子角色 yumi/rattan）打开
 * 角色编辑页时预览构图不能崩——缺省时按客户端同款中性值 {scale:1,offsetX:0,offsetY:0} 兜底。
 */
import { describe, it, expect } from 'vitest';
import { computeMobileHomeLayout, type MobileFramingInput } from './mobileFraming';

const base = {
  width: 360,
  rawHeight: 640,
  modelBaseWidth: 1000,
  modelBaseHeight: 2000,
  scaleMultiplier: 1.2,
  verticalOffset: 0.1,
} satisfies Omit<MobileFramingInput, 'modelTransform'>;

const NEUTRAL = { scale: 1, offsetX: 0, offsetY: 0 };

describe('computeMobileHomeLayout：modelTransform 缺省兜底', () => {
  it('不传 modelTransform 时不抛错', () => {
    expect(() => computeMobileHomeLayout(base)).not.toThrow();
  });

  it('缺省结果与显式中性 modelTransform 一致', () => {
    const withoutIt = computeMobileHomeLayout(base);
    const withNeutral = computeMobileHomeLayout({ ...base, modelTransform: NEUTRAL });
    expect(withoutIt).toEqual(withNeutral);
  });

  it('显式 modelTransform 仍然生效（offsetX 参与水平定位；auto-fit 下 scale 被头部归一化抵消是预期）', () => {
    const neutral = computeMobileHomeLayout({ ...base, modelTransform: NEUTRAL });
    const shifted = computeMobileHomeLayout({ ...base, modelTransform: { ...NEUTRAL, offsetX: 0.2 } });
    expect(shifted.modelX).not.toBeCloseTo(neutral.modelX);
  });
});
