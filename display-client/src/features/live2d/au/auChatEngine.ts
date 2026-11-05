// 聊天链路的 AU 引擎封装：按角色持有 AUProfile + ExpressionSolver + history。
// useChat 用它把 {emotion,intensity} 解算成 ① 情绪层的 {expressionMix, parameterOverrides}。
//
// 设计：
//  - 切角色时整个引擎重建（history 重置，符合「不同角色不共享表情历史」）。
//  - profile 缺失（其他角色没 au-profile.json）时 ready() 为 false，useChat 走临时桥回退。
//  - intensity 调制 solver 旋钮：强度高 → 更确定（randomness 低）+ 允许更多 AU，
//    强度低 → 更随机收手；保持「同情绪多次出不同脸」的同时让强情绪更稳更满。

import { ExpressionHistory } from './history';
import { ExpressionSolver } from './solver';
import { loadAuProfile } from './loadAuProfile';
import { resolveExpression, type ResolvedEmotionLayer } from './resolveExpression';
import type { AUProfile, Emotion } from './types';

export interface AuChatEngine {
  /** 是否拿到了该角色的 AUProfile（false → useChat 走临时桥）。 */
  ready(): boolean;
  /** 解算一轮情绪 → ① 情绪层输入；未就绪返回 null。 */
  solveEmotion(emotion: Emotion, intensity: number): ResolvedEmotionLayer | null;
  /** 底层 profile（供调试/扩展）。 */
  readonly profile: AUProfile | null;
}

/**
 * 异步创建某角色的 AU 引擎。modelJsonUrl 来自 AvatarManifest.modelJson。
 * profile 缺失时仍返回一个 ready()===false 的引擎（useChat 据此回退临时桥）。
 */
export async function createAuChatEngine(
  modelJsonUrl: string,
  opts: { fetcher?: (url: string) => Promise<Response> } = {},
): Promise<AuChatEngine> {
  const profile = await loadAuProfile(modelJsonUrl, { fetcher: opts.fetcher });
  return makeEngine(profile);
}

/** 同步构造（已有 profile 时，或测试用）。 */
export function makeEngine(profile: AUProfile | null): AuChatEngine {
  const history = new ExpressionHistory(20);
  // ① 情绪 solver 只吃「情绪类」units：带 category 的 native（apparel/morph/gesture/prop）
  // 一律排除——它们不是表情，若混入会被当 neutral 情绪误挑而触发非面部参数（模型乱变/消失）。
  // 语义 units 与未标 category 的 native 情绪 unit 保留。
  const emotionUnits = profile
    ? profile.units.filter((u) => !(u.type === 'native' && u.category))
    : [];
  const solver = profile
    ? new ExpressionSolver({ units: emotionUnits, rules: profile.rules, history })
    : null;

  return {
    profile,
    ready() {
      return solver !== null;
    },
    solveEmotion(emotion: Emotion, intensity: number): ResolvedEmotionLayer | null {
      if (!solver || !profile) return null;
      const i = clamp01(intensity);
      const selected = solver.solve({
        emotion,
        // 强度越高越确定、越倾向多区域满额；越低越随机、越易单点收手。
        randomness: lerp(0.7, 0.25, i),
        diversity: lerp(0.7, 0.45, i),
        historyAvoidance: 0.7,
        maxUnits: i >= 0.66 ? 5 : i >= 0.33 ? 4 : 3,
        coreScore: 0.65,
      });
      return resolveExpression(selected, profile);
    },
  };
}

function clamp01(v: number): number {
  if (Number.isNaN(v)) return 0.5;
  return Math.min(1, Math.max(0, v));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
