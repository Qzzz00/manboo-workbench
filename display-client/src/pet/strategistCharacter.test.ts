import { describe, expect, it } from 'vitest';

import { characterPrompt } from './strategistCharacter.ts';
import { installTestAvatars } from '../features/live2d/testAvatars.ts';

// 仓库不带模型(10-21),内置表是空的:这份用例拿当年那份清单当输入。
installTestAvatars();

describe('characterPrompt', () => {
  it('把角色现成的人设拼成一句话（双生=白夜凛，外冷内软猫系）', () => {
    const s = characterPrompt('shuangsheng');
    expect(s).toContain('白猫妖与精灵混血');
    expect(s.length).toBeGreaterThan(10);
  });

  it('换角色就换语气——人设是每只各自的', () => {
    expect(characterPrompt('yumi')).not.toEqual(characterPrompt('shuangsheng'));
    expect(characterPrompt('yumi')).toContain('开朗');
  });

  it('拿不到角色就给空串，服务端退回没有人格的老样子', () => {
    expect(characterPrompt(undefined)).toBe('');
    expect(characterPrompt('根本不存在的角色')).toBe('');
  });

  it('★有长度上限——人格太长会把防幻觉规则挤到后面去', () => {
    for (const id of ['yumi', 'shuangsheng']) {
      expect(characterPrompt(id).length).toBeLessThanOrEqual(120);
    }
  });
});
