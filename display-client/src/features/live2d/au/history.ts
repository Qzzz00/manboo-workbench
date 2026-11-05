// 历史签名队列 + 重复惩罚计算。
// 1:1 移植自 LiveStudio services/expression/history.py（ExpressionHistory）。
//  - 队列「最新在队头」，penalty 用 Jaccard(unit_ids)*0.65 + emotion_match*0.35，
//    乘以随队列位置线性衰减的 recency 权重，取历史中最大者再乘 historyAvoidance。

import type { ExpressionSignature } from './types';

export class ExpressionHistory {
  private readonly capacity: number;
  // 队头 = 最新（对齐 Python deque.appendleft）。
  private queue: ExpressionSignature[] = [];

  constructor(capacity = 20) {
    this.capacity = capacity;
  }

  /** 返回所有历史签名，最新的在前。 */
  recent(): ExpressionSignature[] {
    return [...this.queue];
  }

  /** 计算候选组合与历史记录的相似度惩罚分。 */
  penalty(candidate: ExpressionSignature, historyAvoidance: number): number {
    if (this.queue.length === 0 || historyAvoidance <= 0) return 0;

    let maxWeighted = 0;
    const capacity = this.capacity || this.queue.length;

    this.queue.forEach((hist, index) => {
      const interSize = countIntersection(candidate.unitIds, hist.unitIds);
      const unionSize = countUnion(candidate.unitIds, hist.unitIds);
      const unitJaccard = unionSize === 0 ? 1 : interSize / unionSize;

      const emotionMatch = candidate.emotion === hist.emotion ? 1 : 0;
      const similarity = unitJaccard * 0.65 + emotionMatch * 0.35;
      const recencyWeight = Math.max(0, 1 - index / capacity);
      const weighted = similarity * recencyWeight;
      if (weighted > maxWeighted) maxWeighted = weighted;
    });

    return maxWeighted * historyAvoidance;
  }

  /** 记录一次真实选择，最新的插入队头，超出容量时丢弃队尾。 */
  record(sig: ExpressionSignature): void {
    this.queue.unshift(sig);
    while (this.queue.length > this.capacity) this.queue.pop();
  }

  /** 当前状态快照（用于 preview 恢复），语义同 recent。 */
  snapshot(): ExpressionSignature[] {
    return this.recent();
  }

  restore(snapshot: ExpressionSignature[]): void {
    this.queue = [...snapshot];
  }

  /** 历史中出现过的全部 unit id（用于 novelty 判断）。 */
  get recentUnitIds(): ReadonlySet<string> {
    const ids = new Set<string>();
    for (const sig of this.queue) {
      for (const uid of sig.unitIds) ids.add(uid);
    }
    return ids;
  }

  get length(): number {
    return this.queue.length;
  }
}

function countIntersection(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let n = 0;
  for (const x of a) if (b.has(x)) n += 1;
  return n;
}

function countUnion(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  const u = new Set<string>(a);
  for (const x of b) u.add(x);
  return u.size;
}
