// AUProfile 运行时校验。用纯 TS 实现（不引 zod），便于脚本与前端复用。
// 校验范围（P2）：枚举合法性、值域、引用完整性、id 唯一。不做 solver 语义。

import { EMOTIONS, type Emotion } from '../../../lib/emotion';
import {
  SEMANTIC_ACTIONS,
  type AUProfile,
  type ExpressionRule,
  type ExpressionUnit,
  type EmotionWeights,
} from './types';

const EMOTION_SET = new Set<string>(EMOTIONS);
const ACTION_SET = new Set<string>(SEMANTIC_ACTIONS);
const RULE_KINDS = new Set(['mutual_exclusion', 'bonus', 'penalty', 'binding']);

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 校验情绪权重表：键须是合法 Emotion，值须在 (0,1]。 */
function validateEmotions(emotions: unknown, where: string, errors: string[]): void {
  if (emotions === undefined) return;
  if (!isObject(emotions)) {
    errors.push(`${where}: emotions 必须是对象`);
    return;
  }
  for (const [k, v] of Object.entries(emotions as EmotionWeights)) {
    if (!EMOTION_SET.has(k)) {
      errors.push(`${where}: 非法情绪 "${k}"（仅允许 ${EMOTIONS.join('/')}）`);
    }
    if (typeof v !== 'number' || Number.isNaN(v) || v <= 0 || v > 1) {
      errors.push(`${where}: 情绪 "${k}" 权重须在 (0,1]，得到 ${String(v)}`);
    }
  }
}

function validateUnit(unit: unknown, where: string, errors: string[]): string | null {
  if (!isObject(unit)) {
    errors.push(`${where}: AU 必须是对象`);
    return null;
  }
  const id = typeof unit.id === 'string' ? unit.id : null;
  if (!id) errors.push(`${where}: AU 缺少 id`);

  if (unit.type === 'semantic') {
    if (!Array.isArray(unit.targets) || unit.targets.length === 0) {
      errors.push(`${where}: semantic AU 须有非空 targets`);
    } else {
      for (const t of unit.targets as Array<Record<string, unknown>>) {
        if (!ACTION_SET.has(t.action as string)) {
          errors.push(`${where}: 非法 SemanticAction "${String(t.action)}"`);
        }
        if (
          typeof t.min !== 'number' ||
          typeof t.max !== 'number' ||
          (t.min as number) > (t.max as number)
        ) {
          errors.push(`${where}: target 值域非法 (min>max 或非数字)`);
        }
      }
    }
    validateEmotions(unit.emotions, where, errors);
  } else if (unit.type === 'native') {
    if (typeof unit.nativeRef !== 'string' || !unit.nativeRef) {
      errors.push(`${where}: native AU 缺少 nativeRef`);
    }
    if (!Array.isArray(unit.regions)) {
      errors.push(`${where}: native AU regions 必须是数组`);
    }
    if (
      unit.category !== undefined &&
      unit.category !== 'apparel' &&
      unit.category !== 'morph' &&
      unit.category !== 'gesture' &&
      unit.category !== 'prop'
    ) {
      errors.push(`${where}: 非法 category "${String(unit.category)}"`);
    }
    validateEmotions(unit.emotions, where, errors);
  } else {
    errors.push(`${where}: 未知 AU type "${String(unit.type)}"`);
  }
  return id;
}

function validateRule(
  rule: unknown,
  where: string,
  unitIds: Set<string>,
  errors: string[],
): void {
  if (!isObject(rule)) {
    errors.push(`${where}: 规则必须是对象`);
    return;
  }
  if (!RULE_KINDS.has(rule.kind as string)) {
    errors.push(`${where}: 未知规则 kind "${String(rule.kind)}"`);
  }
  if (!Array.isArray(rule.unitIds) || rule.unitIds.length === 0) {
    errors.push(`${where}: 规则须有非空 unitIds`);
    return;
  }
  for (const uid of rule.unitIds as string[]) {
    if (!unitIds.has(uid)) errors.push(`${where}: 规则引用了不存在的 unitId "${uid}"`);
  }
  if ((rule.kind === 'bonus' || rule.kind === 'penalty') && typeof rule.value !== 'number') {
    errors.push(`${where}: ${rule.kind} 规则须有数字 value`);
  }
  const emotions = (rule as { emotions?: unknown }).emotions;
  if (emotions !== undefined) {
    if (!Array.isArray(emotions)) {
      errors.push(`${where}: 规则 emotions 必须是数组`);
    } else {
      for (const e of emotions as Emotion[]) {
        if (!EMOTION_SET.has(e)) errors.push(`${where}: 规则含非法情绪 "${String(e)}"`);
      }
    }
  }
}

/** 校验 AUProfile，返回 {ok, errors}。绝不抛异常。 */
export function validateAUProfile(profile: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isObject(profile)) {
    return { ok: false, errors: ['profile 必须是对象'] };
  }
  if (typeof profile.characterId !== 'string' || !profile.characterId) {
    errors.push('缺少 characterId');
  }
  if (typeof profile.version !== 'number') {
    errors.push('缺少 version');
  }

  // semanticBindings
  if (profile.semanticBindings !== undefined) {
    if (!isObject(profile.semanticBindings)) {
      errors.push('semanticBindings 必须是对象');
    } else {
      for (const [action, binding] of Object.entries(profile.semanticBindings)) {
        if (!ACTION_SET.has(action)) {
          errors.push(`semanticBindings: 非法 SemanticAction "${action}"`);
        }
        if (!isObject(binding) || typeof binding.paramId !== 'string') {
          errors.push(`semanticBindings["${action}"]: 缺少 paramId`);
        }
      }
    }
  }

  // units
  const unitIds = new Set<string>();
  if (!Array.isArray(profile.units)) {
    errors.push('units 必须是数组');
  } else {
    profile.units.forEach((u: unknown, i: number) => {
      const id = validateUnit(u, `units[${i}]`, errors);
      if (id) {
        if (unitIds.has(id)) errors.push(`units[${i}]: 重复 id "${id}"`);
        unitIds.add(id);
      }
    });
  }

  // rules
  if (profile.rules !== undefined) {
    if (!Array.isArray(profile.rules)) {
      errors.push('rules 必须是数组');
    } else {
      profile.rules.forEach((r: unknown, i: number) => validateRule(r, `rules[${i}]`, unitIds, errors));
    }
  }

  return { ok: errors.length === 0, errors };
}

/** 类型守卫：profile 是否合法 AUProfile。 */
export function isAUProfile(profile: unknown): profile is AUProfile {
  return validateAUProfile(profile).ok;
}

// 重新导出便于消费方按需引用。
export type { AUProfile, ExpressionRule, ExpressionUnit };
