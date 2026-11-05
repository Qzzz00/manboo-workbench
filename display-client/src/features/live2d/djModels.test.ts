import { describe, expect, it } from 'vitest';
import { DJ_MODEL_MAP, djConfigForModelAvatar, djModelFor } from './djModels';
import { avatarList, getAvatarById } from './avatarData';
import { installTestAvatars } from './testAvatars.ts';

// 仓库不带模型(10-21),内置表是空的:这份用例拿当年那份清单当输入。
installTestAvatars();

describe('djModels', () => {
  it('每个条目的 modelAvatarId 都能在 avatarData 里解析出来', () => {
    for (const [key, cfg] of Object.entries(DJ_MODEL_MAP)) {
      expect(getAvatarById(key), `选中角色 ${key} 不存在`).toBeTruthy();
      expect(getAvatarById(cfg.modelAvatarId), `渲染模型 ${cfg.modelAvatarId} 不存在`).toBeTruthy();
    }
  });

  // 回归：弱机面把选中角色换成物理降频变体后，本表漏登记 → djModelFor 返回 null →
  // costumeOverrides 成空数组 → 双击切主题不换装，且全程无报错（真机才发现）。
  it('普通双生与 p30 保留 Param67=1 的 DJ 换装', () => {
    for (const id of ['shuangsheng', 'shuangsheng-p30']) {
      const cfg = djModelFor(id);
      expect(cfg, `${id} 没登记进 DJ_MODEL_MAP`).not.toBeNull();
      expect(cfg!.costume).toContainEqual({ id: 'Param67', value: 1 });
    }
  });

  it('X08A p20 固定 Param67=0，不显示黑色 DJ 换装', () => {
    expect(djModelFor('shuangsheng-p20')?.costume).toEqual([
      { id: 'Param67', value: 0 },
    ]);
  });

  it('反查按渲染模型 id 也能拿到换装配置', () => {
    expect(djConfigForModelAvatar('shuangsheng-dj')?.costume).toContainEqual({ id: 'Param67', value: 1 });
    expect(djConfigForModelAvatar('shuangsheng-p30')?.costume).toContainEqual({ id: 'Param67', value: 1 });
    expect(djConfigForModelAvatar('shuangsheng-p20')?.costume).toEqual([{ id: 'Param67', value: 0 }]);
  });

  it('p20 是可解析但不进入角色抽屉的内部完整模型', () => {
    expect(getAvatarById('shuangsheng-p20')?.modelJson).toContain('shuangsheng.p20.model3.json');
    expect(avatarList.some((avatar) => avatar.id === 'shuangsheng-p20')).toBe(false);
  });

  it('未登记的角色返回 null（调用方需自行降级）', () => {
    expect(djModelFor('yumi')).toBeNull();
  });
});
