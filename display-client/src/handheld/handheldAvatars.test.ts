import { describe, it, expect } from 'vitest';
import {
  HANDHELD_AVATAR_OPTIONS,
  DEFAULT_HANDHELD_AVATAR_ID,
  isValidHandheldAvatarId,
  handheldAvatarFor,
} from './handheldAvatars.ts';

describe('掌机角色注册表', () => {
  it('三只都在，顺序=双生/幽灵狗/小白猫', () => {
    expect(HANDHELD_AVATAR_OPTIONS.map((o) => o.id)).toEqual([
      'shuangsheng-dj',
      'ghostpuppy',
      'tororo',
    ]);
  });

  it('默认是第一只', () => {
    expect(DEFAULT_HANDHELD_AVATAR_ID).toBe('shuangsheng-dj');
  });

  // 未知 id 绝不能返回 undefined 让构图崩掉（旧存档/降级安装都可能残留下架 id）
  it('未知 id 回落第一只而不是 undefined', () => {
    expect(handheldAvatarFor('nope').id).toBe('shuangsheng-dj');
    expect(handheldAvatarFor('').id).toBe('shuangsheng-dj');
    expect(isValidHandheldAvatarId('nope')).toBe(false);
    expect(isValidHandheldAvatarId('tororo')).toBe(true);
  });

  // 双生在 avatarData 里没填头部度量（走兜底 0.18/0.16），必须由掌机侧覆盖真值，
  // 否则取景滑块又变回「调模型比例」。另两只 avatarData 有真值，不该覆盖。
  it('只有双生带 stripFramingHead 覆盖', () => {
    expect(handheldAvatarFor('shuangsheng-dj').stripFramingHead).toEqual({
      headSizeNorm: 0.19,
      headAnchorY: 0.05,
    });
    expect(handheldAvatarFor('ghostpuppy').stripFramingHead).toBeUndefined();
    expect(handheldAvatarFor('tororo').stripFramingHead).toBeUndefined();
  });

  // 换装参数只应有一份真相源（djModels），这里必须是取来的、非空
  it('双生带换装参数，另两只为空', () => {
    expect(handheldAvatarFor('shuangsheng-dj').costume.length).toBeGreaterThan(0);
    expect(handheldAvatarFor('ghostpuppy').costume).toEqual([]);
  });

  it('三只共用同一组底条取景默认值（auto-fit 已按各自模型度量归一化）', () => {
    for (const o of HANDHELD_AVATAR_OPTIONS) {
      expect(o.stripFraming).toEqual({ headScreenY: 0.35, faceScreenFrac: 0.31 });
    }
  });

  it('每只都有剪影图路径', () => {
    for (const o of HANDHELD_AVATAR_OPTIONS) {
      expect(o.silhouette).toBe(`./live2D/${o.id}/strip-silhouette.png`);
    }
  });
});
