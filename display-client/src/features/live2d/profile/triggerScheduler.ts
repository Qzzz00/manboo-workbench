// v1 Profile 触发调度器。
// 纯逻辑：维护 motion / expr / costume 三个通道的状态，输出描述性 action。
// 不直接调用 live2d 引擎，也不订阅 TTS 事件。

import type { CostumeSlot, ExpressionEntry, MotionEntry, RoleProfile } from './types';

export type ChannelState = {
  motion: { kind: 'idle' | 'motion'; file: string | null }; // file=null 表示 virtual_empty
  expr: { file: string | null; expiresAt: number | null };  // expiresAt=时间戳(ms)，null 表示无 expr
  costumes: Map<CostumeSlot, string>;                       // slot -> file
};

export type TriggerAction =
  | { type: 'play_motion'; file: string }
  | { type: 'return_to_idle'; file: string | null } // null = virtual_empty
  | { type: 'set_expr'; file: string; clearAtMs: number }
  | { type: 'clear_expr' }
  | { type: 'set_costume'; slot: CostumeSlot; file: string; replaced: string | null }
  | { type: 'clear_costume'; slot: CostumeSlot; file: string };

/**
 * 调度器运行时配置。
 * 调用方可在构造实例前覆盖 defaultExprHoldMs，用于未传 ttsEndsAtMs 时的兜底保持时长。
 */
export const TriggerSchedulerConfig = {
  defaultExprHoldMs: 3000,
};

function findMotionEntry(profile: RoleProfile, file: string): MotionEntry | undefined {
  return profile.motions.find((entry) => entry.file === file);
}

function findExpressionEntry(profile: RoleProfile, file: string): ExpressionEntry | undefined {
  return profile.expressions.find((entry) => entry.file === file);
}

function getDefaultIdleFile(profile: RoleProfile): string | null {
  if (profile.idleStrategy === 'virtual_empty') return null;
  const idleEntries = profile.motions.filter((entry): entry is MotionEntry & { kind: 'idle' } => entry.kind === 'idle');
  if (idleEntries.length === 0) return null;
  // 优先使用标准 idle.motion3；否则取第一条 idle。
  const canonical = idleEntries.find((entry) => entry.file === 'idle.motion3');
  return canonical?.file ?? idleEntries[0].file;
}

export class TriggerScheduler {
  private readonly profile: RoleProfile;

  private readonly now: () => number;

  private readonly state: ChannelState;

  constructor(profile: RoleProfile, now: () => number) {
    this.profile = profile;
    this.now = now;
    this.state = {
      motion: { kind: 'idle', file: getDefaultIdleFile(profile) },
      expr: { file: null, expiresAt: null },
      costumes: new Map<CostumeSlot, string>(),
    };
  }

  getState(): Readonly<ChannelState> {
    return this.state;
  }

  /**
   * 触发一次 motion / expr / costume。
   * @param file profile 中声明的文件名
   * @param opts.ttsEndsAtMs 本轮 TTS 结束时间戳（ms）；expr 用其 +500ms 作为自动清时间
   * @returns 本次要执行的 action 列表
   */
  trigger(file: string, opts: { ttsEndsAtMs?: number } = {}): TriggerAction[] {
    const motion = findMotionEntry(this.profile, file);
    if (motion) {
      return this.handleMotion(motion);
    }

    const expression = findExpressionEntry(this.profile, file);
    if (expression) {
      return this.handleExpression(expression, opts.ttsEndsAtMs);
    }

    throw new Error(`未知文件: "${file}" 不在 profile 中`);
  }

  /** motion 播放结束回调。返回回到 idle 的 action。 */
  onMotionEnded(): TriggerAction[] {
    if (this.state.motion.kind === 'idle') return [];

    const idleFile = getDefaultIdleFile(this.profile);
    this.state.motion = { kind: 'idle', file: idleFile };
    return [{ type: 'return_to_idle', file: idleFile }];
  }

  /** 每帧或定时调用；若 expr 已到期返回 clear_expr action。 */
  tick(): TriggerAction[] {
    if (this.state.expr.file === null || this.state.expr.expiresAt === null) return [];
    if (this.now() >= this.state.expr.expiresAt) {
      this.state.expr = { file: null, expiresAt: null };
      return [{ type: 'clear_expr' }];
    }
    return [];
  }

  private handleMotion(entry: MotionEntry): TriggerAction[] {
    if (entry.kind === 'idle') {
      if (this.state.motion.kind === 'idle' && this.state.motion.file === entry.file) {
        return [];
      }
      this.state.motion = { kind: 'idle', file: entry.file };
      return [{ type: 'return_to_idle', file: entry.file }];
    }

    // entry.kind === 'motion'
    this.state.motion = { kind: 'motion', file: entry.file };
    return [{ type: 'play_motion', file: entry.file }];
  }

  private handleExpression(entry: ExpressionEntry, ttsEndsAtMs?: number): TriggerAction[] {
    if (entry.kind === 'expr') {
      const now = this.now();
      const clearAtMs = typeof ttsEndsAtMs === 'number' ? ttsEndsAtMs + 500 : now + TriggerSchedulerConfig.defaultExprHoldMs;
      this.state.expr = { file: entry.file, expiresAt: clearAtMs };
      return [{ type: 'set_expr', file: entry.file, clearAtMs }];
    }

    // entry.kind === 'costume'
    const replaced = this.state.costumes.get(entry.slot) ?? null;
    this.state.costumes.set(entry.slot, entry.file);
    return [{ type: 'set_costume', slot: entry.slot, file: entry.file, replaced }];
  }
}
