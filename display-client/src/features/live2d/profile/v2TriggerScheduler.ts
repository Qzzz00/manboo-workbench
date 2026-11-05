// v2 Profile 触发调度器。
// 与 v1 TriggerScheduler 行为一致，但基于新的 split profile 结构（motion / expression 两份 JSON）。

import { TriggerSchedulerConfig, type TriggerAction } from './triggerScheduler.ts';
import { COSTUME_SLOTS, type CostumeSlot } from './types.ts';
import type { V2ExpressionItem, V2MotionItem, V2Profile } from './v2Types.ts';

export type V2ChannelState = {
  motion: { file: string | null };
  expr: { file: string | null; expiresAt: number | null };
  costumes: Map<CostumeSlot, string>;
};

const VALID_COSTUME_SLOTS = new Set<CostumeSlot>(COSTUME_SLOTS);

function normalizeProfileFileKey(file: string): string {
  return file.trim().replace(/\.json$/i, '');
}

function findMotionItem(profile: V2Profile, file: string): V2MotionItem | undefined {
  const key = normalizeProfileFileKey(file);
  return profile.motion.items.find((item) => normalizeProfileFileKey(item.file) === key);
}

function findExpressionItem(profile: V2Profile, file: string): V2ExpressionItem | undefined {
  const key = normalizeProfileFileKey(file);
  return profile.expression.items.find((item) => normalizeProfileFileKey(item.file) === key);
}

function getDefaultIdleFile(profile: V2Profile): string | null {
  const canonical = profile.motion.items.find((item) => item.id === 'idle');
  if (canonical) return canonical.file;
  const anyIdle = profile.motion.items.find((item) => item.loop);
  return anyIdle?.file ?? null;
}

export class V2TriggerScheduler {
  private readonly profile: V2Profile;

  private readonly now: () => number;

  private readonly state: V2ChannelState;

  constructor(profile: V2Profile, now: () => number) {
    this.profile = profile;
    this.now = now;
    this.state = {
      motion: { file: null },
      expr: { file: null, expiresAt: null },
      costumes: new Map<CostumeSlot, string>(),
    };
  }

  getState(): Readonly<V2ChannelState> {
    return this.state;
  }

  /**
   * 触发一次 motion / expression。
   * @param file profile 中声明的文件名
   * @param opts.ttsEndsAtMs 本轮 TTS 结束时间戳（ms）；expr 用其 +500ms 作为自动清时间
   * @returns 本次要执行的 action 列表
   */
  trigger(file: string, opts: { ttsEndsAtMs?: number } = {}): TriggerAction[] {
    const motion = findMotionItem(this.profile, file);
    if (motion) {
      this.state.motion = { file: motion.file };
      return [{ type: 'play_motion', file: motion.file }];
    }

    const expression = findExpressionItem(this.profile, file);
    if (expression) {
      if (expression.category === 'costume' && expression.slot && VALID_COSTUME_SLOTS.has(expression.slot)) {
        if (expression.mode === 'remove') {
          const existing = this.state.costumes.get(expression.slot);
          if (existing) {
            this.state.costumes.delete(expression.slot);
            return [{ type: 'clear_costume', slot: expression.slot, file: existing }];
          }
          return [];
        }
        const replaced = this.state.costumes.get(expression.slot) ?? null;
        this.state.costumes.set(expression.slot, expression.file);
        return [{ type: 'set_costume', file: expression.file, slot: expression.slot, replaced }];
      }
      const now = this.now();
      const clearAtMs = typeof opts.ttsEndsAtMs === 'number'
        ? opts.ttsEndsAtMs + 500
        : now + TriggerSchedulerConfig.defaultExprHoldMs;
      this.state.expr = { file: expression.file, expiresAt: clearAtMs };
      return [{ type: 'set_expr', file: expression.file, clearAtMs }];
    }

    throw new Error(
      `未知文件: "${file}"（归一化后 "${normalizeProfileFileKey(file)}"）不在 v2 profile 中。` +
        `已注册 expression: [${this.profile.expression.items.slice(0, 5).map((i) => i.file).join(', ')}${this.profile.expression.items.length > 5 ? ', ...' : ''}]，` +
        `已注册 motion: [${this.profile.motion.items.slice(0, 5).map((i) => i.file).join(', ')}${this.profile.motion.items.length > 5 ? ', ...' : ''}]`
    );
  }

  /** motion 播放结束回调。
   * @param finishedMotionFile 刚结束的 motion 文件；若期间有新 motion 覆盖，
   *        当前 state.motion.file 会与之不同，此时不再返回 idle，避免打断新 motion。
   * @returns 回到 idle 的 action 列表（必要时为空）。
   */
  onMotionEnded(finishedMotionFile: string): TriggerAction[] {
    if (this.state.motion.file === null) return [];
    if (this.state.motion.file !== finishedMotionFile) return [];

    const idleFile = getDefaultIdleFile(this.profile);
    this.state.motion = { file: null };
    return [{ type: 'return_to_idle', file: idleFile }];
  }

  /**
   * 主动清除某个 costume slot。
   * @param slot 要清除的 slot
   * @returns 实际产生清除 action；若该 slot 无装饰则返回空数组
   */
  clearSlot(slot: CostumeSlot): TriggerAction[] {
    if (!VALID_COSTUME_SLOTS.has(slot)) return [];
    const existing = this.state.costumes.get(slot);
    if (!existing) return [];
    this.state.costumes.delete(slot);
    return [{ type: 'clear_costume', slot, file: existing }];
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
}
