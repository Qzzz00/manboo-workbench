import { describe, expect, it } from 'vitest';
import { validateAUProfile, isAUProfile } from './validate.ts';
import type { AUProfile } from './types.ts';

function baseProfile(): AUProfile {
  return {
    version: 1,
    characterId: 'demo',
    semanticBindings: {
      'eye.open.left': { paramId: 'ParamEyeLOpen', curve: 'linear' },
    },
    units: [
      {
        type: 'native',
        id: 'native:angry',
        nativeRef: 'angry.exp3.json',
        regions: ['brow', 'mouth'],
        emotions: { angry: 0.8 },
      },
      {
        type: 'semantic',
        id: 'sem:smile',
        targets: [{ action: 'mouth.smile', min: 0.3, max: 1 }],
        emotions: { happy: 0.7 },
      },
    ],
    rules: [
      { kind: 'mutual_exclusion', id: 'mx1', unitIds: ['native:angry', 'sem:smile'] },
    ],
  };
}

describe('validateAUProfile', () => {
  it('合法 profile 通过，errors 为空', () => {
    const { ok, errors } = validateAUProfile(baseProfile());
    expect(ok).toBe(true);
    expect(errors).toEqual([]);
    expect(isAUProfile(baseProfile())).toBe(true);
  });

  it('非法 SemanticAction 绑定被拒', () => {
    const p = baseProfile();
    // @ts-expect-error 故意塞非法 action
    p.semanticBindings['mouth.frown'] = { paramId: 'X', curve: 'linear' };
    const { ok, errors } = validateAUProfile(p);
    expect(ok).toBe(false);
    expect(errors.join(' ')).toMatch(/mouth\.frown/);
  });

  it('情绪权重含非法情绪(fear)被拒', () => {
    const p = baseProfile();
    // 故意塞 Ekman 专属情绪（不在 Aiboo 8 情绪内）
    (p.units[0] as { emotions: Record<string, number> }).emotions = { fear: 0.8 };
    const { ok, errors } = validateAUProfile(p);
    expect(ok).toBe(false);
    expect(errors.join(' ')).toMatch(/fear/);
  });

  it('情绪权重越界(>1 或 <=0)被拒', () => {
    const p = baseProfile();
    (p.units[0] as { emotions: Record<string, number> }).emotions = { angry: 1.5 };
    expect(validateAUProfile(p).ok).toBe(false);
    (p.units[0] as { emotions: Record<string, number> }).emotions = { angry: 0 };
    expect(validateAUProfile(p).ok).toBe(false);
  });

  it('semantic target 的 action 非法或 min>max 被拒', () => {
    const p = baseProfile();
    (p.units[1] as { targets: Array<{ action: string; min: number; max: number }> }).targets = [
      { action: 'mouth.smile', min: 0.9, max: 0.1 },
    ];
    expect(validateAUProfile(p).ok).toBe(false);
  });

  it('规则引用了不存在的 unitId 被拒', () => {
    const p = baseProfile();
    p.rules = [{ kind: 'bonus', id: 'b1', unitIds: ['native:angry', 'ghost'], value: 1 }];
    const { ok, errors } = validateAUProfile(p);
    expect(ok).toBe(false);
    expect(errors.join(' ')).toMatch(/ghost/);
  });

  it('unit id 重复被拒', () => {
    const p = baseProfile();
    p.units.push({ ...p.units[0] });
    expect(validateAUProfile(p).ok).toBe(false);
  });

  it('非对象/缺字段输入安全返回 ok=false', () => {
    expect(validateAUProfile(null).ok).toBe(false);
    expect(validateAUProfile({}).ok).toBe(false);
    expect(isAUProfile(42)).toBe(false);
  });
});
