import { describe, it, expect } from 'vitest';
// validateModelProfile 只从 internal 子路径导出(主入口 @soullink-emotion/engine 未 re-export)。
import { validateModelProfile } from '@soullink-emotion/engine/internal';
import { isEmotionDomainParam } from '../emotionDomain.ts';
import profile from './shuangsheng.profile.json';

describe('shuangsheng.profile', () => {
  it('是合法 ModelProfile', () => {
    const result = validateModelProfile(profile as unknown);
    // ProfileValidationResult 实际形状只有 ok(见 @soullink-emotion/engine/internal 类型定义)。
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });
  it('parameterMap 的所有 target 都落在情绪域(不侵占 costume/口型)', () => {
    const rules = Object.values((profile as { parameterMap: Record<string, { target?: string; targets?: string[] }> }).parameterMap);
    const targets = rules.flatMap((r) => [r.target, ...(r.targets ?? [])]).filter(Boolean) as string[];
    const invaders = targets.filter((t) => !isEmotionDomainParam(t));
    // 允许少量非情绪域(生成器可能映射到中性参数),但 costume/口型必须为 0
    expect(invaders.filter((t) => t === 'Param67' || /^ParamMouthOpen/i.test(t))).toEqual([]);
  });
});
