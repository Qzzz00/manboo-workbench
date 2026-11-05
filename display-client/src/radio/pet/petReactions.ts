/**
 * 反应桌：(事件 × 角色 × 心情) → 反应计划。纯函数纯查表，人设差异全在这里——
 * 猫高冷（连戳嘟囔甩尾）、狗黏人（怎么弄都委屈但不走）、小幽灵害羞（零动作，全靠参数晃+叫声）。
 * actionId/expressionId 只允许各角色清单里真实存在的 id（测试硬校验 avatarData）。
 */
import type { PetCryMood } from '../radioVoicePack.ts';
import type { Hunger } from './petState.ts';

export type SnackId = 'fish' | 'bone' | 'candy';
export const SNACKS: { id: SnackId; emoji: string; label: string }[] = [
  { id: 'fish', emoji: '🐟', label: '小鱼干' },
  { id: 'bone', emoji: '🦴', label: '骨头' },
  { id: 'candy', emoji: '⭐', label: '星星糖' },
];
const FAVORITE: Record<string, SnackId> = { hijiki: 'fish', tororo: 'fish', ghostpuppy: 'bone', ghostie: 'candy' };
export function favoriteSnackFor(avatarId: string): SnackId | null {
  return FAVORITE[avatarId] ?? null;
}

export type IdleBehavior = 'attention' | 'nap' | 'dance' | 'hungryRemind';
export type PetNudge = 'sway-small' | 'sway-big' | 'dodge' | 'blush';
export type PetMood = { hunger: Hunger; sleepy: boolean; level: number };
export type PetEvent =
  | { kind: 'tap'; zone: 'head' | 'body'; streak: number; wake?: boolean }
  | { kind: 'feed'; favorite: boolean; sated: boolean }
  | { kind: 'greet' }
  | { kind: 'idle'; behavior: IdleBehavior };
export type PetReaction = {
  actionId?: string;      // 统一动作 id（motion key），playAction 消化
  expressionId?: string;  // 追加表情（motion 之后隔 150ms 再触发，两者可共存）
  cry?: PetCryMood;
  nudge?: PetNudge;       // 小幽灵的参数轻推（usePetPlay 播放）
  mouthPulse?: boolean;   // 喂食咀嚼
  hearts?: boolean;       // 爱心粒子
};

type CharKind = 'cat' | 'dog' | 'ghost';
function charKindOf(avatarId: string): CharKind | null {
  if (avatarId === 'hijiki' || avatarId === 'tororo') return 'cat';
  if (avatarId === 'ghostpuppy') return 'dog';
  if (avatarId === 'ghostie') return 'ghost';
  return null;
}

const DEFAULT_MOOD: PetMood = { hunger: 'ok', sleepy: false, level: 1 };

export function petReactionFor(avatarId: string, ev: PetEvent, mood: PetMood = DEFAULT_MOOD): PetReaction | null {
  const kind = charKindOf(avatarId);
  if (!kind) return null;
  switch (ev.kind) {
    case 'tap': return tapReaction(kind, ev, mood);
    case 'feed': return feedReaction(kind, ev);
    case 'greet': return greetReaction(kind, mood);
    case 'idle': return idleReaction(kind, ev.behavior);
  }
}

function tapReaction(kind: CharKind, ev: { zone: 'head' | 'body'; streak: number; wake?: boolean }, mood: PetMood): PetReaction {
  // 半睡被碰：先惊醒（也顺手把 sleepy 的「不回位姿态」用动作复位掉）
  if (ev.wake) {
    if (kind === 'ghost') return { nudge: 'sway-big', cry: 'curious' };
    return { actionId: 'surprised', cry: 'curious' };
  }
  if (ev.zone === 'head') {
    if (kind === 'cat') {
      if (mood.hunger === 'hungry' && ev.streak === 1) return { actionId: 'nod', cry: 'plead' }; // 蔫蔫的
      if (ev.streak >= 3) return { actionId: 'cheer', cry: 'delight', hearts: true };
      if (ev.streak === 2) return { actionId: 'happy', cry: 'happy' }; // 踩奶
      return { actionId: 'shy', cry: 'happy' }; // 舔爪
    }
    if (kind === 'dog') {
      if (mood.hunger === 'hungry' && ev.streak === 1) return { actionId: 'shy', cry: 'plead' };
      if (ev.streak >= 3) return { actionId: 'cheer', expressionId: 'excited_full', cry: 'delight', hearts: true };
      if (ev.streak === 2) return { actionId: 'happy', cry: 'happy' };
      return { actionId: 'nod', cry: 'happy' };
    }
    if (ev.streak >= 3) return { nudge: 'sway-small', cry: 'delight', hearts: true };
    return { nudge: 'blush', cry: 'happy' }; // 害羞仰头小晃
  }
  // 戳身体
  if (kind === 'cat') {
    return ev.streak >= 3
      ? { actionId: 'surprised', cry: 'grumble' } // 高冷：甩尾+嘟囔
      : { actionId: 'surprised', cry: 'curious' };
  }
  if (kind === 'dog') {
    return ev.streak >= 3
      ? { actionId: 'pout', expressionId: 'puppy_eyes', cry: 'grumble' } // 委屈但还黏你
      : { actionId: 'ear_perk', cry: 'curious' };
  }
  return ev.streak >= 3 ? { nudge: 'dodge', cry: 'grumble' } : { nudge: 'sway-big', cry: 'curious' };
}

function feedReaction(kind: CharKind, ev: { favorite: boolean; sated: boolean }): PetReaction {
  const base = { mouthPulse: true, hearts: true } as const;
  if (kind === 'cat') {
    if (ev.sated) return { ...base, actionId: 'nod', cry: 'happy' };       // 吃不下啦（慵懒）
    if (ev.favorite) return { ...base, actionId: 'cheer', cry: 'delight' };
    return { ...base, actionId: 'happy', cry: 'delight' };
  }
  if (kind === 'dog') {
    if (ev.sated) return { ...base, actionId: 'shy', cry: 'happy' };
    if (ev.favorite) return { ...base, actionId: 'cheer', expressionId: 'excited_full', cry: 'delight' };
    return { ...base, actionId: 'happy', cry: 'delight' };
  }
  if (ev.sated) return { ...base, nudge: 'sway-small', cry: 'happy' };
  return { ...base, nudge: 'sway-big', cry: ev.favorite ? 'delight' : 'happy' };
}

function greetReaction(kind: CharKind, mood: PetMood): PetReaction {
  if (kind === 'cat') return { actionId: mood.level >= 4 ? 'cheer' : 'happy', cry: 'greet' };
  if (kind === 'dog') return { actionId: mood.level >= 4 ? 'cheer' : 'greeting', cry: 'greet' };
  return { nudge: 'sway-big', cry: 'greet' };
}

function idleReaction(kind: CharKind, behavior: IdleBehavior): PetReaction | null {
  switch (behavior) {
    case 'attention':
      if (kind === 'cat') return { actionId: 'look_around', cry: 'curious' };
      if (kind === 'dog') return { actionId: 'greeting', cry: 'curious' };
      return { nudge: 'sway-small', cry: 'curious' };
    case 'nap':
      if (kind === 'cat') return { actionId: 'nod' };       // 眯眼打盹
      if (kind === 'dog') return { actionId: 'sleepy' };    // 故意不回位=真睡着（被摸会 wake）
      return null;                                          // 小幽灵物理飘着就够了
    case 'dance':
      // ★不带 cry：别对着正在播的音乐叫
      if (kind === 'cat') return { actionId: 'dance' };
      if (kind === 'dog') return { actionId: 'shake' };     // 摇摆身体跟节奏
      return { nudge: 'sway-big' };                         // 小幽灵飘动
    case 'hungryRemind':
      if (kind === 'ghost') return { nudge: 'sway-small', cry: 'plead' };
      return { cry: 'plead' };
  }
}
