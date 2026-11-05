/**
 * 来电类 UI（IncomingCallScreen / InlineCallPrompt / TouchBanner）共用的
 * "选头像源 + 名字兜底"逻辑：有 portraitUrl 用图，否则保留文字占位圆；
 * 名字优先取角色名，取不到落回事件标题，两者都没有再落回默认文案。
 */
export interface CallAvatarViewAvatar {
  name?: string;
  portraitUrl?: string;
}

export interface CallAvatarViewEvent {
  title?: string;
  portraitUrl?: string;
}

export interface CallAvatarView {
  /** 有值时渲染圆形头像图；null 时保留文字占位圆。 */
  portraitUrl: string | null;
  /** 用于占位圆首字母/alt/可见标题的统一名字。 */
  name: string;
}

export function resolveCallAvatarView(
  avatar: CallAvatarViewAvatar | undefined,
  event: CallAvatarViewEvent,
): CallAvatarView {
  return {
    // 事件优先：远端/非当前角色来电场景下 SSE 载荷带图但本地 avatar 缓存可能未同步或不存在。
    portraitUrl: event?.portraitUrl ?? avatar?.portraitUrl ?? null,
    name: avatar?.name || event.title || '来电',
  };
}
