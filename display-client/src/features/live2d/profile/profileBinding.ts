// Profile 调度器与 live2dEngine / TTS 的胶水层。
// 把 TriggerScheduler 输出的描述性 action 映射为引擎调用。

import type { RuntimeState } from '../live2dEngine.ts';
import {
  applyProfileCostume,
  applyProfileExpression,
  clearProfileExpression,
  startProfileMotion,
  subscribeMotionFinished,
} from '../live2dEngine.ts';
import type { AvatarManifest } from '../avatarManifest.ts';
import { TriggerScheduler, type TriggerAction } from './triggerScheduler.ts';
import type { RoleProfile } from './types.ts';
import type { TtsEndTracker } from './ttsEndTracker.ts';

export interface ProfileBinding {
  /** 触发一个 profile 文件。 */
  trigger(file: string): TriggerAction[];
  /** 释放定时器与订阅。 */
  dispose(): void;
}

interface ProfileBindingOptions {
  runtime: RuntimeState;
  avatar: AvatarManifest;
  profile: RoleProfile;
  tracker: TtsEndTracker;
  now?: () => number;
  tickIntervalMs?: number;
}

function execute(
  runtime: RuntimeState,
  avatar: AvatarManifest,
  actions: TriggerAction[],
): void {
  for (const action of actions) {
    switch (action.type) {
      case 'play_motion':
        void startProfileMotion(runtime, avatar, action.file);
        break;
      case 'return_to_idle': {
        const idleFile = action.file;
        if (idleFile !== null && idleFile !== '__virtual_empty__') {
          void startProfileMotion(runtime, avatar, idleFile);
        }
        break;
      }
      case 'set_expr':
        void applyProfileExpression(runtime, action.file);
        break;
      case 'clear_expr':
        void clearProfileExpression(runtime);
        break;
      case 'set_costume':
        void applyProfileCostume(runtime, avatar, action.file, action.slot);
        break;
      case 'clear_costume':
        // v1 scheduler 不会产生 clear_costume；为类型 exhaustiveness 提供空处理。
        break;
      default:
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        ((_exhaustive: never) => { /* ignore unknown action */ })(action);
    }
  }
}

export function attachProfileBinding(opts: ProfileBindingOptions): ProfileBinding {
  const { runtime, avatar, profile, tracker, now = () => performance.now(), tickIntervalMs = 250 } = opts;

  const scheduler = new TriggerScheduler(profile, now);

  const unsubscribeMotionFinished = subscribeMotionFinished(runtime, () => {
    const actions = scheduler.onMotionEnded();
    execute(runtime, avatar, actions);
  });

  const intervalId = setInterval(() => {
    const actions = scheduler.tick();
    if (actions.length > 0) {
      execute(runtime, avatar, actions);
    }
  }, tickIntervalMs);

  return {
    trigger(file: string): TriggerAction[] {
      const ttsEndsAtMs = tracker.getExpectedTtsEndMs(now());
      const actions = scheduler.trigger(file, { ttsEndsAtMs: ttsEndsAtMs ?? undefined });
      execute(runtime, avatar, actions);
      return actions;
    },
    dispose() {
      clearInterval(intervalId);
      unsubscribeMotionFinished();
    },
  };
}
