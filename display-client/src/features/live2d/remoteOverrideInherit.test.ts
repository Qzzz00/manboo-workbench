// 覆盖包继承内置同名角色的 expressions/motions（v3 覆盖包事故修复回归测试）。
import { describe, expect, it, vi } from 'vitest';

// live2dEngine 顶层依赖 pixi（node 测试环境加载不了），本文件只用其纯函数，打桩掉。
vi.mock('pixi.js', () => ({}));
vi.mock('pixi-live2d-display/cubism4', () => ({ Live2DModel: class {} }));

import { applyRemoteOverrides, getAvatarById } from './avatarManifest.ts';
import { findAvatarExpressionByProfileFile } from './live2dEngine.ts';
import { installTestAvatars } from './testAvatars.ts';

// 仓库不带模型(10-21),内置表是空的:这份用例拿当年那份清单当输入。
installTestAvatars();

describe('远端覆盖包继承内置角色资产库', () => {
  it('内置同名角色的覆盖包：继承 expressions（v2 触发可查）', () => {
    applyRemoteOverrides([
      { id: 'shuangsheng', model_entry: 'shuangsheng03.model3.json', localDir: 'avatars/shuangsheng/v3' },
    ]);
    const avatar = getAvatarById('shuangsheng');
    expect(avatar).toBeDefined();
    expect(avatar!.expressions.length).toBeGreaterThan(0);
    expect(avatar!.expressions.some((e) => e.id === 'baowawa')).toBe(true);
  });

  it('覆盖包动作文件 URL 绝对化（不随覆盖包目录相对解析）', () => {
    const avatar = getAvatarById('shuangsheng');
    const file = avatar!.motions?.idle?.file;
    expect(file).toBeDefined();
    expect(file).not.toMatch(/^\.\//);
    expect(file).toContain('live2D/');
  });

  it('覆盖包自带同名动作文件时优先用包内版本（待机抽搐修复），包内缺失的回退内置', () => {
    applyRemoteOverrides([
      {
        id: 'shuangsheng',
        model_entry: 'shuangsheng03.model3.json',
        localDir: 'avatars/shuangsheng/v3',
        files: ['shuangsheng03.model3.json', 'motions/idle.motion3.json'],
      },
    ]);
    const avatar = getAvatarById('shuangsheng');
    expect(avatar!.motions?.idle?.file).toContain('avatars/shuangsheng/v3/motions/idle.motion3.json');
    // v3 包没有 erduo.motion3.json → 保持内置绝对 URL
    expect(avatar!.motions?.erduo?.file).toContain('live2D/');
  });

  it('覆盖角色 enrich 后仍保留继承的 expressions（目录发现只剩 neutral 不能清空清单）', async () => {
    const { resolveAvatarManifest, invalidateAvatarResolution } = await import('./avatarManifest.ts');
    invalidateAvatarResolution('shuangsheng');
    const resolved = await resolveAvatarManifest(getAvatarById('shuangsheng')!);
    expect(resolved.expressions.some((e) => e.id === 'baowawa')).toBe(true);
  });

  it('profile 文件名与目录发现的 expression id 归一化一致（Game console → game_console）', () => {
    const avatar = getAvatarById('shuangsheng')!;
    const withUnderscoredId = {
      ...avatar,
      expressions: [
        { id: 'game_console', label: 'Game console', kind: 'prop' as const, prompt: '', binding: { mode: 'file' as const, file: '/assets/Game console-HASH123.exp3.json' } },
      ],
    };
    expect(findAvatarExpressionByProfileFile(withUnderscoredId, 'Game console.exp3.json')?.id).toBe('game_console');
  });
});
