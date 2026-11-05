import { useRingingTimeout } from '../hooks/useRingingTimeout.ts';
import { getAvatarById } from '../features/live2d/avatarData.ts';
import { resolveCallAvatarView } from '../lib/callAvatarView.ts';

export interface IncomingCallScreenEvent {
  id: string;
  avatarId: string;
  title?: string;
  portraitUrl?: string;
  ringtoneUrl?: string;
}

export interface IncomingCallScreenProps {
  event: IncomingCallScreenEvent | null; // null=隐藏
  /** App: postCallResult(accepted) + startCall() + callResolved()。Task 11 接线时用 useCallback 包裹。 */
  onAccept(e: IncomingCallScreenEvent): void;
  /** App: postCallResult(declined) + refreshMessages + callResolved()。同上建议 useCallback。 */
  onDecline(e: IncomingCallScreenEvent): void;
  /** 25s 到点自动调用，App 侧处理同 onDecline 但 result=timeout。 */
  onTimeout(e: IncomingCallScreenEvent): void;
}

/**
 * 全屏来电页：模糊底 + 大头像 + 名字 +「Aiboo 来电」+ 接(绿)/挂(红)两圆钮。
 * props 与 InlineCallPrompt 同构（event/onAccept/onDecline/onTimeout），铃声 + 25s 超时
 * 复用共享 hook useRingingTimeout（与 InlineCallPrompt 同源逻辑，行为一致）。
 *
 * 名字：getAvatarById(event.avatarId)?.name，取不到（远端角色未在本地清单/已下线等）
 * 兜底 event.title，两者都没有再兜底「来电」。
 * 头像：有 getAvatarById(...)?.portraitUrl（后台可上传，见 avatarData.ts）时渲染圆形头像图，
 * 无则保留占位圆（背景色 + 名字首字）。
 *
 * 组件不接线：挂载时机/触发链路（SSE、协调器）留给 Task 11，本组件只负责可独立渲染。
 *
 * 铃声：有 getAvatarById(...)?.ringtoneUrl 时播放该角色上传的 mp3（循环），无则回落
 * useRingingTimeout 内 createRingtone 的合成叮咚兜底。
 */
export function IncomingCallScreen({ event, onAccept, onDecline, onTimeout }: IncomingCallScreenProps) {
  const avatar = event ? getAvatarById(event.avatarId) : undefined;
  useRingingTimeout(event, onTimeout, undefined, event?.ringtoneUrl ?? avatar?.ringtoneUrl);

  if (!event) return null;

  const { portraitUrl: portrait, name } = resolveCallAvatarView(avatar, event);

  return (
    <div className="incoming-call-screen" role="alert" aria-label="来电邀请">
      <div className="incoming-call-screen-backdrop" />
      <div className="incoming-call-screen-content">
        <span className="incoming-call-screen-avatar" aria-hidden="true">
          {portrait ? <img className="incoming-portrait" src={portrait} alt={name} /> : name.slice(0, 1)}
        </span>
        <span className="incoming-call-screen-name">{name}</span>
        <span className="incoming-call-screen-subtitle">Aiboo 来电</span>
        <div className="incoming-call-screen-actions">
          <button
            type="button"
            className="incoming-call-screen-btn incoming-call-screen-decline"
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
            className="incoming-call-screen-btn incoming-call-screen-accept"
            onClick={() => onAccept(event)}
            aria-label="接听"
          >
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.35 1.9.66 2.81a2 2 0 0 1-.45 2.11L8.05 9.91a16 16 0 0 0 6.04 6.04l1.27-1.27a2 2 0 0 1 2.11-.45c.91.31 1.85.53 2.81.66A2 2 0 0 1 22 16.92Z" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
