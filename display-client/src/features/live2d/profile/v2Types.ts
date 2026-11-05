// v2/v3 Profile 类型定义。
// 对应 model/profiles/<role>.motion.json 与 <role>.expression.json。
// v3 在 v2 基础上扩展 kind / emotion / intensity / disabled / triggerEnabled 等字段，保持向下兼容。

import type { CostumeSlot } from './types.ts';

/** v3 11 类 kind：motion 侧、expression 侧与两侧共用。 */
export type V3Kind =
  | 'emotion_motion' | 'greeting' | 'dance' | 'head' | 'pose' | 'idle'   // motion 侧
  | 'emotion_expr'  | 'prop'     | 'costume'                              // expression 侧
  | 'disabled' | 'pending';                                               // 两侧共用

/** v3 情绪标签。 */
export type V3Emotion = 'happy' | 'angry' | 'sad' | 'shy' | 'surprised' | 'excited' | 'neutral';

/** v3 强度标签。 */
export type V3Intensity = 'light' | 'medium' | 'strong';

/** costume 模式：add 为穿戴，remove 为移除。 */
export type V3CostumeMode = 'add' | 'remove';

/** motion 侧允许的白名单 kind。 */
export const V3_KIND_MOTION: V3Kind[] = [
  'emotion_motion',
  'greeting',
  'dance',
  'head',
  'pose',
  'idle',
  'disabled',
  'pending',
];

/** expression 侧允许的白名单 kind。 */
export const V3_KIND_EXPRESSION: V3Kind[] = [
  'emotion_expr',
  'prop',
  'pose',
  'costume',
  'disabled',
  'pending',
];

export type V2MotionItem = {
  id: string;
  file: string;
  group: string;
  loop: boolean;
  hint: string;
  keywords?: string[];
  /** v3 语义分类，缺省时由 loader 按 category 推断。 */
  kind?: V3Kind;
  /** v3 情绪标签。 */
  emotion?: V3Emotion;
  /** v3 强度标签。 */
  intensity?: V3Intensity;
};

export type V2MotionProfile = {
  role: string;
  kind: 'motion';
  version: 'v2' | 'v3';
  items: V2MotionItem[];
};

export type V2ExpressionCategory = 'emotion' | 'prop' | 'costume';

export type V2ExpressionItem = {
  id: string;
  file: string;
  category: V2ExpressionCategory;
  hint: string;
  slot?: CostumeSlot;    // 仅 category === 'costume' 时使用，缺省时视为配置错误
  keywords?: string[];
  /** v3 语义分类，缺省时由 loader 按 category 推断。 */
  kind?: V3Kind;
  /** v3 情绪标签。 */
  emotion?: V3Emotion;
  /** v3 强度标签。 */
  intensity?: V3Intensity;
  /** costume 模式，默认 add。 */
  mode?: V3CostumeMode;
  /** 是否默认穿戴该 costume；true 表示角色常态已穿，expression 文件表达的是脱掉/取消该装扮。
   *  例如默认穿着丝袜，baisi.exp3 是去掉丝袜。 */
  defaultWorn?: boolean;
  /** 是否允许触发，默认 true；pending 场景可关闭。 */
  triggerEnabled?: boolean;
};

export type V2ExpressionProfile = {
  role: string;
  kind: 'expression';
  version: 'v2' | 'v3';
  items: V2ExpressionItem[];
};

export type V2Profile = {
  role: string;
  motion: V2MotionProfile;
  expression: V2ExpressionProfile;
};
