import { useEffect } from 'react';

export interface TouchBannerEvent {
  avatarId: string;
  title?: string;
  content?: string;
  portraitUrl?: string;
  notifySoundUrl?: string;
}

export interface TouchBannerProps {
  event: TouchBannerEvent | null; // null=隐藏
  avatarName: string;
  avatarThumb: string | null;
  onTap(avatarId: string): void; // App 里接 handleAvatarChange
  onDismiss(): void; // 6s 自动或手动收起时调用
}

/**
 * 画外角色消息横幅：顶部固定定位滑入，6s 后自动收起（onDismiss）。
 * 点击横幅触发 onTap(avatarId) 并调用 onDismiss。
 * 挂载点/接线（SSE、协调器）留给 Task 11，本组件只负责可独立渲染。
 */
export function TouchBanner({ event, avatarName, avatarThumb, onTap, onDismiss }: TouchBannerProps) {
  useEffect(() => {
    if (!event) return;
    const timer = window.setTimeout(() => {
      onDismiss();
    }, 6000);
    return () => window.clearTimeout(timer);
  }, [event, onDismiss]);

  if (!event) return null;

  return (
    <div
      className="touch-banner"
      role="button"
      tabIndex={0}
      onClick={() => {
        onTap(event.avatarId);
        onDismiss();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault(); // Space 默认滚动页面，div[role=button] 需自行拦截
          onTap(event.avatarId);
          onDismiss();
        }
      }}
    >
      <span className="touch-banner-avatar">
        {avatarThumb ? <img src={avatarThumb} alt={avatarName} /> : avatarName.slice(0, 1)}
      </span>
      <span className="touch-banner-body">
        <span className="touch-banner-name">{event.title || avatarName}</span>
        {event.content ? <span className="touch-banner-content">{event.content}</span> : null}
      </span>
    </div>
  );
}
