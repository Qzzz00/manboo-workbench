// AU 表情 solver —— 1:1 移植自 LiveStudio services/expression/solver.py（ExpressionSolver）。
//
// 完整保留算法：
//  - 相关性打分：correlation*0.80 + novelty*0.20（novelty: 近期出现过 0.35，否则 1.0）。
//  - 排序抖动：randomness>0 时加 ±randomness*diversity*0.30 的均匀噪声；randomness<=0 完全确定。
//  - 概率选择：score>=coreScore || correlation>=0.80 || randomness<=0 必选；否则按概率 p。
//  - 互斥：显式 MutualExclusionRule + 隐式（两端都是 semantic 且 action 交集非空）；
//          一次收集全部冲突者统一裁决，candidate 需超过最强冲突者 0.03 才顶替。
//  - 强制绑定（penalty=Infinity）：组合命中部分绑定单元即非法；软绑定在 combo 分里扣分。
//  - noisy-OR 情绪饱和：unmet *= (1-correlation)，fulfillment=1-unmet ∈[0,1]，单个强 AU 即近满额。
//  - 饱和提前收手：randomness>0 且 fulfillment>=0.90 时按 (1-diversity) 概率停手（多样性来源）。
//  - combo 分：fulfillment + variety(区域覆盖,最高0.10) - size_penalty(每多1个-0.04)
//             + rule_score(bonus/软绑定penalty) - history_penalty。
//  - 历史回避 + 区域覆盖小奖。
//  - 注入 rng（默认 Math.random 独立实例，测试可固定种子复现）。solve 记历史，preview 不记。

import { ExpressionHistory } from './history';
import {
  DEFAULT_EXPRESSION_REQUEST,
  FACIAL_REGIONS,
  SEMANTIC_ACTION_RANGE,
  unitRegions,
  type Emotion,
  type ExpressionRequest,
  type ExpressionRule,
  type ExpressionUnit,
  type FacialRegion,
  type ResolvedSemanticTarget,
  type ScoredExpressionUnit,
  type SelectedExpression,
  type SemanticAction,
  type SemanticExpressionUnit,
} from './types';

/** 解算出的随机数源：返回 [0,1)。默认 Math.random，可注入固定种子。 */
export type Rng = () => number;

/** 平台标识：当前只有 Live2D。 */
const PLATFORM = 'live2d';

function isSemantic(unit: ExpressionUnit): unit is SemanticExpressionUnit {
  return unit.type === 'semantic';
}

/** 把 [min,max] 内随机采样的值按 action 的合法值域钳制（对齐 LiveStudio clamp_semantic_value）。 */
function clampSemanticValue(action: SemanticAction, value: number): number {
  const range = SEMANTIC_ACTION_RANGE[action];
  if (!range) return value;
  return Math.min(Math.max(value, range[0]), range[1]);
}

function resolveRequest(request: ExpressionRequest): Required<ExpressionRequest> {
  return {
    emotion: request.emotion,
    randomness: request.randomness ?? DEFAULT_EXPRESSION_REQUEST.randomness,
    diversity: request.diversity ?? DEFAULT_EXPRESSION_REQUEST.diversity,
    historyAvoidance: request.historyAvoidance ?? DEFAULT_EXPRESSION_REQUEST.historyAvoidance,
    maxUnits: request.maxUnits ?? DEFAULT_EXPRESSION_REQUEST.maxUnits,
    coreScore: request.coreScore ?? DEFAULT_EXPRESSION_REQUEST.coreScore,
  };
}

export interface ExpressionSolverOptions {
  units: ExpressionUnit[];
  rules: ExpressionRule[];
  history: ExpressionHistory;
  /** 候选裁剪上限（对齐 LiveStudio top_candidates，默认 14）。 */
  topCandidates?: number;
  /** 随机源，注入便于测试；默认独立 Math.random，不污染全局。 */
  rng?: Rng;
}

export class ExpressionSolver {
  private readonly units: ExpressionUnit[];
  private readonly rules: ExpressionRule[];
  private readonly _history: ExpressionHistory;
  private readonly topCandidates: number;
  private readonly rng: Rng;

  constructor(opts: ExpressionSolverOptions) {
    // 仅保留 enabled !== false 的 AU。
    this.units = opts.units.filter((u) => u.enabled !== false);
    this.rules = opts.rules;
    this._history = opts.history;
    this.topCandidates = opts.topCandidates ?? 14;
    this.rng = opts.rng ?? Math.random;
  }

  get history(): ExpressionHistory {
    return this._history;
  }

  // ── 公开接口 ────────────────────────────────────────────────────────────────

  /** 执行完整选择算法并更新历史。 */
  solve(request: ExpressionRequest): SelectedExpression {
    const req = resolveRequest(request);
    const result = this.run(req);
    this._history.record({
      unitIds: new Set(result.units.map((u) => u.id)),
      emotion: req.emotion,
    });
    return result;
  }

  /** 预览模式：不更新历史。 */
  preview(request: ExpressionRequest): SelectedExpression {
    return this.run(resolveRequest(request));
  }

  // ── 内部实现 ────────────────────────────────────────────────────────────────

  private run(request: Required<ExpressionRequest>): SelectedExpression {
    const recentIds = this._history.recentUnitIds;
    const candidates = this.scoreUnits(request, recentIds);
    if (candidates.length === 0) return emptyResult(request.emotion);

    // 对齐 Python「先算 key 再排序」：每个候选只抽样一次 rank，再按 rank 降序排序。
    // （若在比较器里调用 this.rank 会每次比较都重抽样，语义不对。）
    const ranked = candidates
      .map((s) => ({ s, r: this.rank(s, request) }))
      .sort((a, b) => b.r - a.r)
      .map((x) => x.s);

    const combo = this.buildCombo(ranked, request);
    return this.makeResult(combo, request);
  }

  private scoreUnits(
    request: Required<ExpressionRequest>,
    recentIds: ReadonlySet<string>,
  ): ScoredExpressionUnit[] {
    const result: ScoredExpressionUnit[] = [];
    for (const unit of this.units) {
      const correlation = unit.emotions[request.emotion] ?? 0;
      if (correlation <= 0) continue;
      const novelty = recentIds.has(unit.id) ? 0.35 : 1.0;
      const score = correlation * 0.8 + novelty * 0.2;
      result.push({ unit, score, correlation });
    }
    result.sort((a, b) => b.score - a.score);
    return result.slice(0, this.topCandidates);
  }

  private rank(scored: ScoredExpressionUnit, request: Required<ExpressionRequest>): number {
    if (request.randomness <= 0) return scored.score;
    return (
      scored.score +
      (this.rng() * 2 - 1) * request.randomness * request.diversity * 0.3
    );
  }

  private shouldSelect(
    scored: ScoredExpressionUnit,
    request: Required<ExpressionRequest>,
  ): boolean {
    if (
      scored.score >= request.coreScore ||
      scored.correlation >= 0.8 ||
      request.randomness <= 0
    ) {
      return true;
    }
    const p = Math.min(
      1,
      Math.max(0.05, scored.score) * (0.55 + request.diversity * 0.55) +
        scored.correlation * 0.2,
    );
    return this.rng() <= p;
  }

  private buildCombo(
    ranked: ScoredExpressionUnit[],
    request: Required<ExpressionRequest>,
  ): ScoredExpressionUnit[] {
    const combo: ScoredExpressionUnit[] = [];
    const occupiedActions = new Set<string>();
    let unmet = 1.0; // 情绪「未满足残量」，noisy-OR 累计

    for (const candidate of ranked) {
      if (combo.length >= request.maxUnits) break;
      if (!this.shouldSelect(candidate, request)) continue;

      // 互斥冲突（显式规则 + 隐式 action 冲突），一次性全收集后统一裁决。
      const conflicts = this.findConflicts(candidate, combo, request.emotion);
      if (conflicts.length > 0) {
        const strongest = Math.max(...conflicts.map((c) => c.score));
        if (candidate.score <= strongest + 0.03) continue; // 不足以顶替最强冲突者
        for (const victim of conflicts) {
          const idx = combo.indexOf(victim);
          if (idx >= 0) combo.splice(idx, 1);
          if (isSemantic(victim.unit)) {
            for (const t of victim.unit.targets) occupiedActions.delete(t.action);
          }
        }
      }

      // 强制绑定合法性。
      const newIds = new Set(combo.map((s) => s.unit.id));
      newIds.add(candidate.unit.id);
      if (!this.bindingLegal(newIds, request.emotion)) continue;

      combo.push(candidate);
      if (isSemantic(candidate.unit)) {
        for (const t of candidate.unit.targets) occupiedActions.add(t.action);
      }

      // 情绪饱和提前收手（多样性来源）。
      unmet *= 1 - Math.max(0, Math.min(1, candidate.correlation));
      if (request.randomness > 0 && 1 - unmet >= 0.9 && this.rng() > request.diversity) {
        break;
      }
    }

    return combo;
  }

  private findConflicts(
    candidate: ScoredExpressionUnit,
    combo: ScoredExpressionUnit[],
    emotion: Emotion,
  ): ScoredExpressionUnit[] {
    const conflicts: ScoredExpressionUnit[] = [];

    let candidateActions = new Set<SemanticAction>();
    if (isSemantic(candidate.unit)) {
      candidateActions = new Set(candidate.unit.targets.map((t) => t.action));
    }

    // 当前情绪下生效、且包含 candidate 的显式互斥规则的并集。
    const mutexIds = new Set<string>();
    for (const rule of this.rules) {
      if (rule.kind !== 'mutual_exclusion') continue;
      if (rule.emotions && rule.emotions.length > 0 && !rule.emotions.includes(emotion)) continue;
      if (rule.unitIds.includes(candidate.unit.id)) {
        for (const id of rule.unitIds) mutexIds.add(id);
      }
    }

    for (const existing of combo) {
      // 1. 显式互斥
      if (mutexIds.has(existing.unit.id)) {
        conflicts.push(existing);
        continue;
      }
      // 2. 隐式 action 冲突（仅两端都是 semantic 时）
      if (
        candidateActions.size > 0 &&
        isSemantic(existing.unit) &&
        existing.unit.targets.some((t) => candidateActions.has(t.action))
      ) {
        conflicts.push(existing);
      }
    }

    return conflicts;
  }

  private bindingViolated(ruleUnitIds: string[], comboIds: Set<string>): boolean {
    let presentCount = 0;
    for (const id of ruleUnitIds) if (comboIds.has(id)) presentCount += 1;
    // 命中了部分但未覆盖全部（部分绑定即违反）。
    return presentCount > 0 && presentCount !== ruleUnitIds.length;
  }

  private bindingLegal(comboIds: Set<string>, emotion: Emotion): boolean {
    for (const rule of this.rules) {
      if (rule.kind !== 'binding') continue;
      if (rule.emotions && rule.emotions.length > 0 && !rule.emotions.includes(emotion)) continue;
      if (rule.penalty !== Infinity) continue; // 软惩罚在 combo_score 里处理
      if (this.bindingViolated(rule.unitIds, comboIds)) return false;
    }
    return true;
  }

  private comboScore(
    combo: ScoredExpressionUnit[],
    request: Required<ExpressionRequest>,
  ): number {
    const comboIds = new Set(combo.map((s) => s.unit.id));
    const covered = new Set<FacialRegion>();
    for (const s of combo) {
      for (const region of unitRegions(s.unit)) covered.add(region);
    }

    // 情绪饱和度（noisy-OR），值域恒为 [0,1]。
    let unmet = 1.0;
    for (const s of combo) unmet *= 1 - Math.max(0, Math.min(1, s.correlation));
    const fulfillment = 1 - unmet;

    // 多区域覆盖小额「锦上添花」。
    const variety = Math.min(1, covered.size / FACIAL_REGIONS.length) * 0.1;
    const sizePenalty = Math.max(0, combo.length - 1) * 0.04;
    const ruleScore = this.ruleScore(comboIds, request.emotion);
    const histPenalty = this._history.penalty(
      { unitIds: comboIds, emotion: request.emotion },
      request.historyAvoidance,
    );
    return fulfillment + variety - sizePenalty + ruleScore - histPenalty;
  }

  private ruleScore(comboIds: Set<string>, emotion: Emotion): number {
    let score = 0;
    for (const rule of this.rules) {
      if (rule.emotions && rule.emotions.length > 0 && !rule.emotions.includes(emotion)) continue;
      if (rule.kind === 'bonus' && subsetOf(rule.unitIds, comboIds)) {
        score += rule.value;
      } else if (rule.kind === 'penalty' && subsetOf(rule.unitIds, comboIds)) {
        score -= rule.value;
      } else if (
        rule.kind === 'binding' &&
        rule.penalty !== undefined &&
        rule.penalty !== Infinity &&
        this.bindingViolated(rule.unitIds, comboIds)
      ) {
        score -= rule.penalty;
      }
    }
    return score;
  }

  private makeResult(
    combo: ScoredExpressionUnit[],
    request: Required<ExpressionRequest>,
  ): SelectedExpression {
    const semanticTargets: ResolvedSemanticTarget[] = [];
    const nativeTriggers: SelectedExpression['nativeTriggers'] = [];
    const unitsByRegion: Partial<Record<FacialRegion, ExpressionUnit[]>> = {};
    const units: ExpressionUnit[] = [];

    for (const scored of combo) {
      const unit = scored.unit;
      units.push(unit);
      for (const region of unitRegions(unit)) {
        (unitsByRegion[region] ??= []).push(unit);
      }

      if (isSemantic(unit)) {
        for (const target of unit.targets) {
          const sampled = target.min + this.rng() * (target.max - target.min);
          const value = clampSemanticValue(target.action, sampled);
          semanticTargets.push({ action: target.action, value, easing: unit.easing ?? 'linear' });
        }
      } else {
        nativeTriggers.push({ platform: PLATFORM, nativeRef: unit.nativeRef });
      }
    }

    const totalScore = this.comboScore(combo, request);
    return {
      units,
      emotion: request.emotion,
      score: totalScore,
      semanticTargets,
      nativeTriggers,
      unitsByRegion,
    };
  }
}

function subsetOf(ids: string[], superset: Set<string>): boolean {
  return ids.every((id) => superset.has(id));
}

function emptyResult(emotion: Emotion): SelectedExpression {
  return {
    units: [],
    emotion,
    score: 0,
    semanticTargets: [],
    nativeTriggers: [],
    unitsByRegion: {},
  };
}
