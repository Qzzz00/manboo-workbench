import { SoullinkRuntime } from '@soullink-emotion/engine';
import type { ModelProfile } from '@soullink-emotion/engine';
import { filterEmotionParams } from './emotionDomain.ts';

export type EmotionBridge = {
  feedText(text: string, tSec: number): void;
  tick(tSec: number, dtSec: number): Map<string, number>;
};

export function createSoullinkBridge(args: {
  profile: ModelProfile;
  reserved: { costumeIds: Iterable<string>; mouthIds: Iterable<string> };
}): EmotionBridge {
  const runtime = new SoullinkRuntime({ profile: args.profile });
  // SoulLink 不驱动口型(TTS 负责)，也不跑它自己的 idle(交给我们既有物理摆动)。
  runtime.setLipSyncEnabled(false);
  runtime.setIdleEnabled(false);

  // reserved 定格一份(costume/口型参数集在一次 DJ 会话内稳定)。
  const costumeIds = [...args.reserved.costumeIds];
  const mouthIds = [...args.reserved.mouthIds];

  return {
    feedText(text: string, tSec: number) {
      if (!text?.trim()) return;
      runtime.sendMessage(text, tSec);
    },
    tick(tSec: number, dtSec: number): Map<string, number> {
      const snapshot = runtime.update(tSec, dtSec);
      const { kept, conflicts } = filterEmotionParams(snapshot.live2dParams, { costumeIds, mouthIds });
      if (conflicts.length > 0) {
        throw new Error(`soullink emotion param invades reserved domain: ${conflicts.join(', ')}`);
      }
      return kept;
    },
  };
}
