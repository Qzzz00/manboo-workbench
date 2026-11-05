// 类型声明：bootstrapRules.mjs（纯 JS 共享模块）的 TS 类型。
import type {
  Emotion,
  FacialRegion,
  SemanticAction,
  SemanticBinding,
  NativeExpressionUnit,
  EmotionWeights,
} from './types';

export const EMOTIONS: readonly Emotion[];
export const SEMANTIC_ACTIONS: readonly SemanticAction[];
export const PARAM_ACTION_RULES: ReadonlyArray<{
  re: RegExp;
  action: SemanticAction;
  auxiliary?: boolean;
}>;

export function actionRegion(action: string): FacialRegion | undefined;
export function paramNameToSemanticAction(paramName: string): SemanticAction | null;
export function buildSemanticBindings(
  paramNames: readonly string[],
): Partial<Record<SemanticAction, SemanticBinding>>;

export function exp3BaseName(fileName: string): string;
export function classifyExp3(fileName: string): 'emotion' | 'apparel' | 'morph' | 'gesture';
export function seedEmotionsForExp3(fileName: string): EmotionWeights;
export function regionsFromParams(paramNames: readonly string[]): FacialRegion[];

export function exp3FileToNativeUnit(
  fileName: string,
  touchedParams?: readonly string[],
): Omit<NativeExpressionUnit, 'type'> & { type?: 'native' };

export function canonicalEmotionUnits(
  boundActions: ReadonlySet<string>,
): Array<{
  type: 'semantic';
  id: string;
  targets: Array<{ action: SemanticAction; min: number; max: number }>;
  emotions: EmotionWeights;
}>;
