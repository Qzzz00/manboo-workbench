// 角色轻量配置拉取的并发闸门（ALL-440）。
//
// 原实现用一个全局 inFlight 直接 return，导致「silent 同步在跑时，用户双击的 force 请求被吞掉」。
// 本闸门把并发状态拆到「每个角色各自在途」+「每角色最多一次待补跑的 force」，语义：
// - 同一角色在途时再来 force（双击）→ 合并成「当前请求结束后补跑一次」，不并发打多次接口；
// - 同一角色在途时再来 silent → 直接跳过（被手动 force 覆盖，无需排队）；
// - 不同角色互不阻塞（各自独立在途）；
// - 冷却只对非 force 生效；手动 force 永远不因冷却被吞。
// 纯逻辑、无副作用，便于单测；组件侧用 ref 持有一份实例并驱动 run/settled/markFetched。

export type ConfigFetchGateRequest = {
  targetId: string;
  force: boolean;
  silent: boolean;
};

export type ConfigFetchGateDecision =
  | { kind: 'run' }
  | { kind: 'skip'; reason: 'cooldown' | 'silent-inflight' }
  | { kind: 'queue' };

export type ConfigFetchGateSettle = { rerun: boolean; silent: boolean };

export type ConfigFetchGateOptions = {
  /** 非 force 请求的最小间隔；force 不受此限制。 */
  cooldownMs: number;
  now?: () => number;
};

export interface ConfigFetchGate {
  /** 提交一次请求意图，返回调用方该如何执行。 */
  submit(req: ConfigFetchGateRequest): ConfigFetchGateDecision;
  /** 一次 run 结束（成功/失败都调）；返回是否需要以相同意图补跑一次（force 被排队的情况）。 */
  settled(targetId: string): ConfigFetchGateSettle;
  /** 标记某角色 fetch 成功的时间戳（进入冷却起点）。 */
  markFetched(targetId: string): void;
}

export function createConfigFetchGate(options: ConfigFetchGateOptions): ConfigFetchGate {
  const cooldownMs = options.cooldownMs;
  const now = options.now ?? Date.now;
  const inFlight = new Set<string>();
  // targetId -> 补跑时是否 silent（双击是 silent=false，保留原意图的反馈语义）。
  const pendingForce = new Map<string, boolean>();
  const lastFetchedAt = new Map<string, number>();

  return {
    submit(req) {
      if (inFlight.has(req.targetId)) {
        if (req.force) {
          // 覆盖式登记：同一目标在途期间的多次 force 只保留一次，避免并发风暴。
          pendingForce.set(req.targetId, req.silent);
          return { kind: 'queue' };
        }
        return { kind: 'skip', reason: 'silent-inflight' };
      }
      if (!req.force) {
        // -Infinity：从未拉取过时冷却必然不命中（now() 接近 0 的单调钟也不能误判冷却）。
        const last = lastFetchedAt.get(req.targetId) ?? Number.NEGATIVE_INFINITY;
        if (now() - last < cooldownMs) return { kind: 'skip', reason: 'cooldown' };
      }
      inFlight.add(req.targetId);
      return { kind: 'run' };
    },

    settled(targetId) {
      inFlight.delete(targetId);
      const silent = pendingForce.get(targetId);
      if (silent !== undefined) {
        pendingForce.delete(targetId);
        return { rerun: true, silent };
      }
      return { rerun: false, silent: false };
    },

    markFetched(targetId) {
      lastFetchedAt.set(targetId, now());
    },
  };
}
