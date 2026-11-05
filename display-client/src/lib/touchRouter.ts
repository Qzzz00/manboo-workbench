export type TouchTier = 'daily' | 'heavy' | 'silent';
export type TouchEventKind = 'message' | 'call';

export interface TouchEvent {
  kind: TouchEventKind;
  tier: TouchTier;
  id: string;
  avatarId: string;
  content?: string;
  emotion?: string;
  intensity?: number;
  title?: string;
  createdAt?: number;
  portraitUrl?: string;
  ringtoneUrl?: string;
  notifySoundUrl?: string;
}

export interface TouchContext {
  flagEnabled: boolean; // client-flags 的 inAppTouch
  currentAvatarId: string;
  inCall: boolean;
  callEnabled: boolean;
}

export type TouchAction =
  | { type: 'perform' }
  | { type: 'banner' }
  | { type: 'call-inplace' }
  | { type: 'call-fullscreen' }
  | { type: 'report-missed' }
  | { type: 'silent' };

export function routeTouch(e: TouchEvent, ctx: TouchContext): TouchAction {
  const isCurrent = e.avatarId === ctx.currentAvatarId;

  // flag 关 = 完全等价现状：当前角色消息照常演出，其余静默
  if (!ctx.flagEnabled) {
    return e.kind === 'message' && isCurrent ? { type: 'perform' } : { type: 'silent' };
  }

  if (e.tier === 'silent') {
    return { type: 'silent' };
  }

  if (e.kind === 'call') {
    if (ctx.inCall || !ctx.callEnabled) {
      return { type: 'report-missed' };
    }
    return isCurrent ? { type: 'call-inplace' } : { type: 'call-fullscreen' };
  }

  // 消息（daily 与 heavy 同路由）
  if (ctx.inCall) {
    return { type: 'silent' };
  }
  return isCurrent ? { type: 'perform' } : { type: 'banner' };
}
