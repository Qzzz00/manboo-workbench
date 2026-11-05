// 来源:Aiboo origin/main 7c55ce12 src/features/live2d/profile/types.ts
// v1 角色 Profile 类型定义。
// 与 Aiboo/model/profiles/<role>.v1.json 的 schema 一一对应。

export type TriggerKind = 'idle' | 'motion' | 'expr' | 'costume';

export type Intensity = 'light' | 'strong';

export const COSTUME_SLOTS = [
  'hair',
  'headwear',
  'earwear',
  'eyewear',
  'mouth_cover',
  'pupil',
  'ears',
  'tail',
  'chest_cover',
  'outerwear',
  'outfit',
  'legwear',
  'handheld',
  'hand_prop',
  'accessory',
  'headphone',
  'headphone_support',
] as const;

export type CostumeSlot = (typeof COSTUME_SLOTS)[number];

export type IdleStrategy = 'virtual_empty';

export type MotionEntry =
  | { file: string; kind: 'idle' }
  | { file: string; kind: 'motion'; intensity: Intensity };

export type ExpressionEntry =
  | { file: string; kind: 'expr'; intensity: Intensity }
  | { file: string; kind: 'costume'; slot: CostumeSlot };

export type ExcludedEntry = {
  file: string;
  reason: string;
};

export type RoleProfile = {
  role: string;
  schemaVersion: 'v1';
  driver?: 'v2';
  idleStrategy?: IdleStrategy;
  motions: MotionEntry[];
  expressions: ExpressionEntry[];
  excluded: ExcludedEntry[];
};
