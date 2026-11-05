// v2 profile 触发系统公开入口。
// App.tsx 只从此文件与 ../live2dEngine 引入 profile 相关能力。

export type { RoleProfile, CostumeSlot, TriggerKind, Intensity, IdleStrategy } from './types.ts';
export { COSTUME_SLOTS } from './types.ts';
export { loadProfileFromJson, parseProfile, loadProfileByRole } from './loader.ts';
export { TriggerScheduler, TriggerSchedulerConfig } from './triggerScheduler.ts';
export type { TriggerAction, ChannelState } from './triggerScheduler.ts';
export { initTtsEndTracker } from './ttsEndTracker.ts';
export type { TtsEndTracker } from './ttsEndTracker.ts';
export { attachProfileBinding } from './profileBinding.ts';
export type { ProfileBinding } from './profileBinding.ts';

// v2 split profile
export type { V2Profile, V2MotionProfile, V2ExpressionProfile, V2MotionItem, V2ExpressionItem } from './v2Types.ts';
export { loadV2Profile, loadV2MotionProfile, loadV2ExpressionProfile, validateV2Profile } from './v2Loader.ts';
export { V2TriggerScheduler } from './v2TriggerScheduler.ts';
export type { V2ChannelState } from './v2TriggerScheduler.ts';
export { attachV2ProfileBinding } from './v2ProfileBinding.ts';
export type { V2ProfileBinding } from './v2ProfileBinding.ts';
export { attachNativeV2ProfileBinding } from './nativeV2ProfileBinding.ts';
export { diffShuangshengPair } from './shuangshengPairDiff.ts';
export type { ProfilePairDiff } from './shuangshengPairDiff.ts';
export { classifyProfileTriggers } from './localTriggerClassifier.ts';
export type { LocalTriggerResult, LocalTriggerHit } from './localTriggerClassifier.ts';
