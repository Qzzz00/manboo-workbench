// v2 Profile 绑定的原生渲染镜像（低端机 GL 路径没有 Pixi runtime 时用）。
// 调度逻辑完全复用 V2TriggerScheduler，只把执行层映射到原生通道：
//   play_motion    → playNativeMotion(group)（动作结束回 idle 由原生看门狗负责，
//                    见 NativeLive2DModel.maybeStartIdleOrBeat，故不接 onMotionEnded）
//   set_expr/clear → applyNativeExpressionMix（overlay 通道，与舞台 presence 写入
//                    last-write-wins，对齐 Pixi 上两来源共用语义）
//   set/clear_costume → setNativeProfileCostumeParams（persistent 通道，profile 赢 legacy）
import { findAvatarExpressionByProfileFile } from '../live2dEngine.ts';
import type { AvatarManifest } from '../avatarManifest.ts';
import {
  applyNativeExpressionMix,
  getNativeStageState,
  playNativeMotion,
  setNativeProfileCostumeParams,
} from '../nativeStage.ts';
import { fetchExpressionFileParams } from '../paramFlatten.ts';
import { V2TriggerScheduler } from './v2TriggerScheduler.ts';
import type { V2Profile } from './v2Types.ts';
import type { TriggerAction } from './triggerScheduler.ts';
import type { TtsEndTracker } from './ttsEndTracker.ts';
import type { CostumeSlot } from './types.ts';
import type { V2ProfileBinding } from './v2ProfileBinding.ts';

interface NativeV2ProfileBindingOptions {
  avatar: AvatarManifest;
  profile: V2Profile;
  tracker: TtsEndTracker;
  /** 切角色重建时重放的穿着状态（slot→file）；缺省为空。 */
  initialCostumes?: ReadonlyMap<CostumeSlot, string>;
  now?: () => number;
  tickIntervalMs?: number;
}

function sameProfileFile(a: string, b: string): boolean {
  return a.trim().replace(/\.json$/i, '') === b.trim().replace(/\.json$/i, '');
}

export function attachNativeV2ProfileBinding(opts: NativeV2ProfileBindingOptions): V2ProfileBinding {
  const { avatar, profile, tracker, now = () => performance.now(), tickIntervalMs = 250 } = opts;

  const scheduler = new V2TriggerScheduler(profile, now);
  // 脱下 costume 的参数钉回默认值：引擎侧是一次性写回 Cubism 默认；原生 persistent 是
  // 持续通道只能钉值——视觉等价（默认=未穿戴）。同名参数被 legacy 换装占用是已知边界。
  const pinnedDefaults = new Map<string, number>();
  let publishedIds = new Set<string>();
  let costumeRecomputeToken = 0;
  let disposed = false;

  async function recomputeCostumes(): Promise<void> {
    const token = ++costumeRecomputeToken;
    const worn = new Map<string, number>();
    for (const [slot, file] of scheduler.getState().costumes) {
      const expression = findAvatarExpressionByProfileFile(avatar, file);
      if (!expression || expression.binding.mode !== 'file') {
        console.warn(`[profile:native] costume expression not found: slot=${slot} file=${file}`);
        continue;
      }
      try {
        const params = await fetchExpressionFileParams(expression.binding.file);
        for (const p of params) worn.set(p.id, p.value);
      } catch (err) {
        console.warn('[profile:native] costume exp3 resolve failed', { slot, file, error: String(err) });
      }
    }
    if (disposed || token !== costumeRecomputeToken) return;

    const paramInfo = getNativeStageState()?.paramInfo;
    for (const id of publishedIds) {
      if (!worn.has(id) && !pinnedDefaults.has(id)) {
        pinnedDefaults.set(id, paramInfo?.get(id)?.def ?? 0);
      }
    }
    for (const id of worn.keys()) pinnedDefaults.delete(id);

    const next: Record<string, number> = {};
    for (const [id, value] of pinnedDefaults) next[id] = value;
    for (const [id, value] of worn) next[id] = value;
    publishedIds = new Set(Object.keys(next));
    setNativeProfileCostumeParams(next);
  }

  function execute(actions: TriggerAction[]): void {
    if (disposed || actions.length === 0) return;
    console.info('[profile:native] execute actions', { actions });
    for (const action of actions) {
      try {
        switch (action.type) {
          case 'play_motion': {
            const item = profile.motion.items.find((m) => sameProfileFile(m.file, action.file));
            if (item) playNativeMotion(item.group);
            else console.warn(`[profile:native] motion not in profile: ${action.file}`);
            break;
          }
          case 'return_to_idle':
            // 原生 motionManager 排空后看门狗自动回 idle，无需显式播。
            break;
          case 'set_expr': {
            const expression = findAvatarExpressionByProfileFile(avatar, action.file);
            if (expression) void applyNativeExpressionMix(avatar, [{ key: expression.id, weight: 1 }]);
            else console.warn(`[profile:native] expression not found: ${action.file}`);
            break;
          }
          case 'clear_expr':
            void applyNativeExpressionMix(avatar, []);
            break;
          case 'set_costume':
          case 'clear_costume':
            void recomputeCostumes();
            break;
        }
      } catch (err) {
        console.error('[profile:native] individual action failed', { action, error: err });
      }
    }
  }

  const intervalId = setInterval(() => {
    execute(scheduler.tick());
  }, tickIntervalMs);

  // 重放记忆里的穿着（切角色回来恢复 costume）：trigger 产出的 action 与原始触发同构。
  if (opts.initialCostumes) {
    for (const [, file] of opts.initialCostumes) {
      execute(scheduler.trigger(file));
    }
  }

  return {
    trigger(file: string): TriggerAction[] {
      const ttsEndsAtMs = tracker.getExpectedTtsEndMs(now());
      const actions = scheduler.trigger(file, { ttsEndsAtMs: ttsEndsAtMs ?? undefined });
      execute(actions);
      return actions;
    },
    clearSlot(slot: CostumeSlot): TriggerAction[] {
      const actions = scheduler.clearSlot(slot);
      execute(actions);
      return actions;
    },
    getActiveCostumeSlots(): CostumeSlot[] {
      return [...scheduler.getState().costumes.keys()];
    },
    dispose() {
      disposed = true;
      clearInterval(intervalId);
      setNativeProfileCostumeParams({});
    },
  };
}
