// v2 Profile 调度器与 live2dEngine / TTS 的胶水层。
// 行为与 profileBinding.ts 一致，但基于 split v2 profile，不处理 costume slot。

import type { RuntimeState } from '../live2dEngine.ts';
import type { CostumeSlot } from './types.ts';
import {
  applyProfileCostume,
  applyProfileExpression,
  clearProfileExpression,
  removeProfileCostume,
  startProfileMotion,
  subscribeMotionFinished,
} from '../live2dEngine.ts';
import type { AvatarManifest } from '../avatarManifest.ts';
import { V2TriggerScheduler } from './v2TriggerScheduler.ts';
import type { V2Profile } from './v2Types.ts';
import type { TriggerAction } from './triggerScheduler.ts';
import type { TtsEndTracker } from './ttsEndTracker.ts';

export interface V2ProfileBinding {
  /** 触发一个 v2 profile 文件。 */
  trigger(file: string): TriggerAction[];
  /** 主动清除某个 costume slot。 */
  clearSlot(slot: CostumeSlot): TriggerAction[];
  /** 当前穿着的 costume slot（供 llm 上下文 ongoing state）。 */
  getActiveCostumeSlots(): CostumeSlot[];
  /** 释放定时器与订阅。 */
  dispose(): void;
}

interface V2ProfileBindingOptions {
  runtime: RuntimeState;
  avatar: AvatarManifest;
  profile: V2Profile;
  tracker: TtsEndTracker;
  /** 切角色重建时重放的穿着状态（slot→file）；缺省为空。 */
  initialCostumes?: ReadonlyMap<CostumeSlot, string>;
  now?: () => number;
  tickIntervalMs?: number;
}

/** 把异步 action 串行化：快速连续触发（如穿外套→脱外套→穿外套）时，
 * 保证引擎侧的读写按触发顺序完成，避免后启动的异步 recompute 覆盖先完成的，
 * 导致最终状态与调度器不一致。 */
function createActionQueue() {
  let running = false;
  let disposed = false;
  const pending: (() => Promise<void>)[] = [];

  async function drain() {
    if (running || disposed) return;
    running = true;
    try {
      while (pending.length > 0 && !disposed) {
        const task = pending.shift()!;
        try {
          await task();
        } catch (err) {
          console.error('[profile] action task failed', err);
        }
      }
    } finally {
      running = false;
    }
  }

  return {
    enqueue(task: () => Promise<void>) {
      if (disposed) return;
      pending.push(task);
      void drain();
    },
    dispose() {
      disposed = true;
      pending.length = 0;
    },
  };
}

function execute(
  queue: ReturnType<typeof createActionQueue>,
  runtime: RuntimeState,
  avatar: AvatarManifest,
  actions: TriggerAction[],
): void {
  if (actions.length === 0) return;
  queue.enqueue(async () => {
    console.info('[profile] execute actions', { actions });
    for (const action of actions) {
      try {
        switch (action.type) {
          case 'play_motion':
            await startProfileMotion(runtime, avatar, action.file);
            break;
          case 'return_to_idle': {
            const idleFile = action.file;
            if (idleFile !== null && idleFile !== '__virtual_empty__') {
              await startProfileMotion(runtime, avatar, idleFile);
            }
            break;
          }
          case 'set_expr':
            await applyProfileExpression(runtime, action.file);
            break;
          case 'clear_expr':
            await clearProfileExpression(runtime);
            break;
          case 'set_costume':
            await applyProfileCostume(runtime, avatar, action.file, action.slot);
            break;
          case 'clear_costume':
            await removeProfileCostume(runtime, avatar, action.slot);
            break;
          default:
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            ((_exhaustive: never) => { /* ignore unknown action */ })(action);
        }
      } catch (err) {
        console.error('[profile] individual action failed', { action, error: err });
      }
    }
  });
}

export function attachV2ProfileBinding(opts: V2ProfileBindingOptions): V2ProfileBinding {
  const { runtime, avatar, profile, tracker, now = () => performance.now(), tickIntervalMs = 250 } = opts;

  const scheduler = new V2TriggerScheduler(profile, now);
  const actionQueue = createActionQueue();

  const unsubscribeMotionFinished = subscribeMotionFinished(runtime, (finishedMotionFile) => {
    const actions = scheduler.onMotionEnded(finishedMotionFile);
    execute(actionQueue, runtime, avatar, actions);
  });

  const intervalId = setInterval(() => {
    const actions = scheduler.tick();
    if (actions.length > 0) {
      execute(actionQueue, runtime, avatar, actions);
    }
  }, tickIntervalMs);

  // 重放记忆里的穿着（切角色回来恢复 costume）：trigger 产出的 action 与原始触发同构。
  if (opts.initialCostumes) {
    for (const [, file] of opts.initialCostumes) {
      execute(actionQueue, runtime, avatar, scheduler.trigger(file));
    }
  }

  return {
    trigger(file: string): TriggerAction[] {
      const ttsEndsAtMs = tracker.getExpectedTtsEndMs(now());
      const actions = scheduler.trigger(file, { ttsEndsAtMs: ttsEndsAtMs ?? undefined });
      execute(actionQueue, runtime, avatar, actions);
      return actions;
    },
    clearSlot(slot: CostumeSlot): TriggerAction[] {
      const actions = scheduler.clearSlot(slot);
      execute(actionQueue, runtime, avatar, actions);
      return actions;
    },
    getActiveCostumeSlots(): CostumeSlot[] {
      return [...scheduler.getState().costumes.keys()];
    },
    dispose() {
      actionQueue.dispose();
      clearInterval(intervalId);
      unsubscribeMotionFinished();
    },
  };
}
