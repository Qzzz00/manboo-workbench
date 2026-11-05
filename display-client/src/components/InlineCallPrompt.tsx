import { useRingingTimeout } from '../hooks/useRingingTimeout.ts';
import { getAvatarById } from '../features/live2d/avatarData.ts';
import { resolveCallAvatarView } from '../lib/callAvatarView.ts';

export interface InlineCallPromptEvent {
  id: string;
  avatarId: string;
  title?: string;
  portraitUrl?: string;
  ringtoneUrl?: string;
}

export interface InlineCallPromptProps {
  event: InlineCallPromptEvent | null; // null=隐藏
  /** App: postCallResult(accepted) + startCall() + callResolved()。Task 11 接线时用 useCallback 包裹，避免内联函数每次渲染重建导致下方 effect 反复重挂。 */
  onAccept(e: InlineCallPromptEvent): void;
  /** App: postCallResult(declined) + refreshMessages + callResolved()。同上建议 useCallback。 */
  onDecline(e: InlineCallPromptEvent): void;
  /** 组件内 25s 计时到点自动调用，App 侧处理同 onDecline 但 result=timeout。同上建议 useCallback，它进了下方 effect 的依赖数组。 */
  onTimeout(e: InlineCallPromptEvent): void;
}

/**
 * 原地来电浮层：底部固定，接(绿)/挂(红)两圆钮 + 铃声 + 25s 超时。
 * 按钮语言贴近 CallModePopover（48px 圆底 + 深色/彩色 glyph）。
 * 挂载时机/触发链路（SSE、协调器）留给 Task 11，本组件只负责可独立渲染。
 *
 * 铃声 + 25s 超时抽成共享 hook useRingingTimeout（Task 10）：event 变化（含从一通
 * 来电切到另一通、或置 null）时，hook 内部的 effect cleanup 先清掉旧的一套计时器
 * 与铃声再起新的一套，不会叠加响铃/提前触发上一通的 onTimeout（参考 TouchBanner.tsx
 * 的 event-keyed effect 清理模式）；onTimeout 存 ref 不进 deps，调用方内联回调重建
 * 也不会导致重新起铃。
 *
 * 铃声：有 getAvatarById(...)?.ringtoneUrl 时播放该角色上传的 mp3（循环），无则回落
 * useRingingTimeout 内 createRingtone 的合成叮咚兜底。
 */
export function InlineCallPrompt({ event, onAccept, onDecline, onTimeout }: InlineCallPromptProps) {
  const avatar = event ? getAvatarById(event.avatarId) : undefined;
  useRingingTimeout(event, onTimeout, undefined, event?.ringtoneUrl ?? avatar?.ringtoneUrl);

  if (!event) return null;

  const { portraitUrl: portrait, name } = resolveCallAvatarView(avatar, event);

  return (
    <div className="inline-call-prompt" role="alert" aria-label="来电邀请">
      <div className="inline-call-prompt-body">
        <span className="inline-call-prompt-avatar" aria-hidden="true">
          {portrait ? <img className="inline-call-prompt-portrait" src={portrait} alt={name} /> : name.slice(0, 1)}
        </span>
        <span className="inline-call-prompt-title">{name}</span>
      </div>
      <div className="inline-call-prompt-actions">
        <button
          type="button"
          className="inline-call-prompt-btn inline-call-prompt-decline"
          onClick={() => onDecline(event)}
          aria-label="挂断"
        >
          <svg viewBox="0 0 24 24" fill="currentColor">
            <path
              d="M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.35 1.9.66 2.81a2 2 0 0 1-.45 2.11L8.05 9.91a16 16 0 0 0 6.04 6.04l1.27-1.27a2 2 0 0 1 2.11-.45c.91.31 1.85.53 2.81.66A2 2 0 0 1 22 16.92Z"
              transform="rotate(135 12 12)"
            />
          </svg>
        </button>
        <button
          type="button"
          className="inline-call-prompt-btn inline-call-prompt-accept"
          onClick={() => onAccept(event)}
          aria-label="接听"
        >
          <svg viewBox="0 0 24 24" fill="currentColor">
            <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.35 1.9.66 2.81a2 2 0 0 1-.45 2.11L8.05 9.91a16 16 0 0 0 6.04 6.04l1.27-1.27a2 2 0 0 1 2.11-.45c.91.31 1.85.53 2.81.66A2 2 0 0 1 22 16.92Z" />
          </svg>
        </button>
      </div>
    </div>
  );
}
