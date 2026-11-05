/**
 * 前台活跃时长跟踪器（纯状态机，不依赖 DOM / Capacitor，便于单测）。
 *
 * 口径：只产出「角色 + 时长段（秒）」，不记录精确起止时间。
 * 每段上限 MAX_REPORT_SECONDS（与服务端 /api/usage/report 校验一致）；
 * 周期 flush 保证崩溃/杀进程最多丢失最后一个周期间隔的时长。
 */

export const MAX_REPORT_SECONDS = 3600;

export interface UsageSegment {
  avatarId: string;
  seconds: number;
}

export interface UsageTrackerOptions {
  /** 会话开始回调：inactive→active 真实切换时触发一次（应用「打开」语义），已在前台时重复调用不触发。 */
  onSessionStart?: () => void;
}

export interface UsageTracker {
  /** 进前台：开始计时。重复调用是 no-op。返回被异常打断时遗留的结算段（正常为 []）。 */
  enterForeground(nowMs: number, avatarId: string): UsageSegment[];
  /** 退后台/锁屏：结算当前段。未在前台时 no-op。 */
  enterBackground(nowMs: number): UsageSegment[];
  /** 前台期间周期结算：上报已过时长并继续计时。 */
  flush(nowMs: number): UsageSegment[];
  /** 前台期间切换角色：旧角色结算，新角色重新起计。 */
  switchAvatar(nowMs: number, avatarId: string): UsageSegment[];
}

function toSegments(avatarId: string, elapsedMs: number): UsageSegment[] {
  if (!avatarId) return [];
  let remaining = Math.round(elapsedMs / 1000);
  if (remaining <= 0) return [];
  const segments: UsageSegment[] = [];
  while (remaining > 0) {
    const seconds = Math.min(remaining, MAX_REPORT_SECONDS);
    segments.push({ avatarId, seconds });
    remaining -= seconds;
  }
  return segments;
}

export function createUsageTracker(opts: UsageTrackerOptions = {}): UsageTracker {
  let active = false;
  let avatarId = '';
  let lastMarkMs = 0;

  function settle(nowMs: number): UsageSegment[] {
    const segments = toSegments(avatarId, nowMs - lastMarkMs);
    lastMarkMs = nowMs;
    return segments;
  }

  return {
    enterForeground(nowMs, nextAvatarId) {
      if (active) return [];
      active = true;
      avatarId = nextAvatarId;
      lastMarkMs = nowMs;
      opts.onSessionStart?.();
      return [];
    },
    enterBackground(nowMs) {
      if (!active) return [];
      active = false;
      return settle(nowMs);
    },
    flush(nowMs) {
      if (!active) return [];
      return settle(nowMs);
    },
    switchAvatar(nowMs, nextAvatarId) {
      if (!active || nextAvatarId === avatarId) return [];
      const segments = settle(nowMs);
      avatarId = nextAvatarId;
      return segments;
    },
  };
}
