// AU (Action Unit) 数据模型 —— 移植自开源项目 LiveStudio
// (livestudio/services/expression/models.py + semantic_actions/models.py)，
// 改写为 TS。关键差异见 README 注释：
//  1. 情绪枚举换成 Aiboo 现有 8 个 (src/lib/emotion.ts EMOTIONS)，不用 Ekman 7。
//  2. 用 TS 类型 + 运行时校验函数（au/validate.ts），不引 pydantic/zod。
//  3. NativeExpressionUnit 增加 category('apparel'|'morph'|'gesture') 区分②③④层 exp3，
//     避免形态/服饰/一次性动作 exp3 污染①情绪层。
//
// 本任务 (P2) 只定义类型 + 校验，不实现 solver（solver 是 P3）。

import type { Emotion } from '../../../lib/emotion';

export type { Emotion };

// ── 语义动作 / 面部区域 ────────────────────────────────────────────────────

/** 与 LiveStudio FacialRegion 一致。 */
export const FACIAL_REGIONS = ['brow', 'eye', 'mouth', 'head'] as const;
export type FacialRegion = (typeof FACIAL_REGIONS)[number];

/**
 * 语义动作枚举。平台无关的「我要做什么」，由 AUProfile.semanticBindings
 * 映射到各角色具体 ParamId。取值域统一约定 [-1,1] 或 [0,1]（见 SEMANTIC_ACTION_RANGE）。
 */
export const SEMANTIC_ACTIONS = [
  'brow.height',
  'brow.height.left',
  'brow.height.right',
  'eye.open',
  'eye.open.left',
  'eye.open.right',
  'eye.gaze.x',
  'eye.gaze.y',
  'mouth.open',
  'mouth.smile',
  'mouth.x',
  'mouth.y',
  'head.yaw',
  'head.pitch',
  'head.roll',
] as const;
export type SemanticAction = (typeof SEMANTIC_ACTIONS)[number];

/** 各 SemanticAction 的合法值域（移植 DEFAULT_SEMANTIC_ACTION_SPECS）。 */
export const SEMANTIC_ACTION_RANGE: Record<SemanticAction, readonly [number, number]> = {
  'brow.height': [-1, 1],
  'brow.height.left': [-1, 1],
  'brow.height.right': [-1, 1],
  'eye.open': [0, 1],
  'eye.open.left': [0, 1],
  'eye.open.right': [0, 1],
  'eye.gaze.x': [-1, 1],
  'eye.gaze.y': [-1, 1],
  'mouth.open': [0, 1],
  'mouth.smile': [-1, 1],
  'mouth.x': [-1, 1],
  'mouth.y': [-1, 1],
  'head.yaw': [-1, 1],
  'head.pitch': [-1, 1],
  'head.roll': [-1, 1],
};

/** SemanticAction → 所属 FacialRegion。 */
export const SEMANTIC_ACTION_REGION: Record<SemanticAction, FacialRegion> = {
  'brow.height': 'brow',
  'brow.height.left': 'brow',
  'brow.height.right': 'brow',
  'eye.open': 'eye',
  'eye.open.left': 'eye',
  'eye.open.right': 'eye',
  'eye.gaze.x': 'eye',
  'eye.gaze.y': 'eye',
  'mouth.open': 'mouth',
  'mouth.smile': 'mouth',
  'mouth.x': 'mouth',
  'mouth.y': 'mouth',
  'head.yaw': 'head',
  'head.pitch': 'head',
  'head.roll': 'head',
};

// ── AU（表情单元）────────────────────────────────────────────────────────

/** 情绪相关性：正数 (0,1]；缺失或 <=0 视为无关。 */
export type EmotionWeights = Partial<Record<Emotion, number>>;

/** 单个语义动作目标，值域 [min,max]，solver 时随机采样（P3）。 */
export interface ExpressionTarget {
  action: SemanticAction;
  min: number;
  max: number;
}

/**
 * ② 服饰 / ③ 形态 / ④ 一次性动作(gesture) 类 exp3 的标记；①情绪类 exp3 不带此字段。
 * gesture：抬手/拿话筒/俯身/挥手等动作姿态，与服饰/形态一样不参与情绪标注（emotions:{}）。
 */
// 'prop' = 非表情的自定义参数开关 exp3（名字认不出、不碰任何面部参数）。
// 与 apparel/morph/gesture 一样不进 ① 情绪 solver，避免被当 neutral 情绪误挑而触发位置/身体参数。
export type NativeCategory = 'apparel' | 'morph' | 'gesture' | 'prop';

/** 通过 SemanticAction 驱动参数的 AU（param 驱动）。 */
export interface SemanticExpressionUnit {
  type: 'semantic';
  id: string;
  enabled?: boolean;
  targets: ExpressionTarget[];
  /** 情绪相关性，沿用 Aiboo 8 情绪。 */
  emotions: EmotionWeights;
  easing?: string;
}

/** 直接触发平台原生 exp3 表情的 AU（exp3 触发）。 */
export interface NativeExpressionUnit {
  type: 'native';
  id: string;
  enabled?: boolean;
  /** exp3 文件名（相对角色目录）。 */
  nativeRef: string;
  regions: FacialRegion[];
  emotions: EmotionWeights;
  /** 形态/服饰类标记；情绪类省略。 */
  category?: NativeCategory;
}

export type ExpressionUnit = SemanticExpressionUnit | NativeExpressionUnit;

// ── 规则（结构照搬 LiveStudio，本任务只定义 + 校验，不实现 solver）────────────

/** unit_ids 中的 AU 不能同时出现。 */
export interface MutualExclusionRule {
  kind: 'mutual_exclusion';
  id: string;
  unitIds: string[];
  emotions?: Emotion[];
}

/** unit_ids 全部出现时，组合得分 +value。 */
export interface BonusRule {
  kind: 'bonus';
  id: string;
  unitIds: string[];
  value: number;
  emotions?: Emotion[];
}

/** unit_ids 全部出现时，组合得分 -value。 */
export interface PenaltyRule {
  kind: 'penalty';
  id: string;
  unitIds: string[];
  value: number;
  emotions?: Emotion[];
}

/** unit_ids 中任一 AU 出现时，其余 AU 也应出现；否则扣 penalty（inf=强制）。 */
export interface BindingRule {
  kind: 'binding';
  id: string;
  unitIds: string[];
  /** Infinity 表示强制（缺席则组合非法）。 */
  penalty?: number;
  emotions?: Emotion[];
}

export type ExpressionRule = MutualExclusionRule | BonusRule | PenaltyRule | BindingRule;

// ── 角色 AU Profile ───────────────────────────────────────────────────────

/** 单条语义绑定：SemanticAction → 该角色的具体 ParamId + 曲线。 */
export interface SemanticBinding {
  paramId: string;
  /** 取值映射曲线；当前 bootstrap 一律 'linear'，留待人工/admin 调。 */
  curve: string;
}

/** 每角色一份 AU Profile（bootstrap 生成、admin-ui 维护）。 */
export interface AUProfile {
  /** schema 版本，便于后续迁移。 */
  version: number;
  characterId: string;
  /** 语义动作 → ParamId 绑定表（仅含命中的 action）。 */
  semanticBindings: Partial<Record<SemanticAction, SemanticBinding>>;
  units: ExpressionUnit[];
  rules: ExpressionRule[];
  /** bootstrap 元信息（可选，便于人工审阅）。 */
  meta?: {
    generatedBy?: string;
    generatedAt?: string;
    modelFile?: string;
    /** 需人工补的项（未命中映射的参数 / neutral 占位的 exp3）。 */
    todo?: string[];
  };
}

export const AU_PROFILE_VERSION = 1;

// ── 运行时模型（P3：solver 的输入 / 中间体 / 输出）─────────────────────────────
// 移植自 LiveStudio services/expression/models.py 的纯运行时 dataclass
// (ExpressionRequest / ScoredExpressionUnit / ResolvedSemanticTarget /
//  NativeExpressionTrigger / SelectedExpression / ExpressionSignature)。
// 与静态 unit/rule/AUProfile（上方 P2 定义）共用，不重复定义。

/**
 * solver 的解算输入。情绪 + 强度 + 一组可控随机旋钮。
 * 时序参数（淡入/保持时长）属于消费侧（presence.applyEmotion 的 holdMs），不在此处。
 * 默认值对齐 LiveStudio ExpressionRequest。
 */
export interface ExpressionRequest {
  emotion: Emotion;
  /** [0,1]，越高越随机；<=0 时完全确定性（不抖动、不提前停、不概率选择）。 */
  randomness?: number;
  /** [0,1]，多样性：影响抖动幅度、概率选择阈值、情绪饱和提前收手概率。 */
  diversity?: number;
  /** [0,1]，历史回避强度：组合与近期历史越相似扣分越多。 */
  historyAvoidance?: number;
  /** 组合最多容纳的 AU 数。 */
  maxUnits?: number;
  /** 核心分阈值：>= 此分的候选必选。 */
  coreScore?: number;
}

/** ExpressionRequest 的默认旋钮值（对齐 LiveStudio）。 */
export const DEFAULT_EXPRESSION_REQUEST: Required<Omit<ExpressionRequest, 'emotion'>> = {
  randomness: 0.5,
  diversity: 0.6,
  historyAvoidance: 0.7,
  maxUnits: 5,
  coreScore: 0.65,
};

/** 打分后的候选 AU（中间体）。 */
export interface ScoredExpressionUnit {
  unit: ExpressionUnit;
  score: number;
  correlation: number;
}

/** 已采样的语义目标（直接用作 end value）。 */
export interface ResolvedSemanticTarget {
  action: SemanticAction;
  /** 已在 [min,max] 内随机采样并按 SEMANTIC_ACTION_RANGE 钳制。 */
  value: number;
  /** 来自所属 AU 的 easing。 */
  easing: string;
}

/** 触发平台原生 exp3 表情。 */
export interface NativeExpressionTrigger {
  platform: string;
  nativeRef: string;
}

/** solver 输出：一组选中的 AU + 解算后的语义目标 / 原生触发。 */
export interface SelectedExpression {
  units: ExpressionUnit[];
  emotion: Emotion;
  score: number;
  semanticTargets: ResolvedSemanticTarget[];
  nativeTriggers: NativeExpressionTrigger[];
  unitsByRegion: Partial<Record<FacialRegion, ExpressionUnit[]>>;
}

/** 历史签名：一次真实选择的 unit 集合 + 情绪。 */
export interface ExpressionSignature {
  unitIds: ReadonlySet<string>;
  emotion: Emotion;
}

/**
 * 取一个 AU 的面部区域集合：
 *  - native：直接读 regions 字段。
 *  - semantic：由 targets 的 action 经 SEMANTIC_ACTION_REGION 推导（对齐 LiveStudio 动态 property）。
 */
export function unitRegions(unit: ExpressionUnit): FacialRegion[] {
  if (unit.type === 'native') return unit.regions ?? [];
  const set = new Set<FacialRegion>();
  for (const t of unit.targets) {
    const region = SEMANTIC_ACTION_REGION[t.action];
    if (region) set.add(region);
  }
  return [...set];
}
