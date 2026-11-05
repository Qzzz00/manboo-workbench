import { useEffect, useRef, useState } from 'react';
import type { CallSettings } from '../lib/callSettingsStore.ts';
import { createCallClient, type CallClient, type CallStatus } from '../lib/rtcCall.ts';
import { showToast } from '../lib/toastStore.ts';

type Props = {
  open: boolean;
  /** 通话模式：voice=纯语音；video=视频通话（接通即推视频、开视觉、先看后开口） */
  mode?: 'voice' | 'video';
  avatarName: string;
  avatarId: string;
  /** 该角色的通话音色（每角色配置） */
  voice?: string;
  /** 角色人设，作为智能体 LLM 的 SystemMessages */
  systemMessage?: string;
  callSettings: CallSettings;
  /** 演出挂钩：她说话的音量 0-1（逐帧）→ 驱动口型（App.setMouthOpen） */
  onBotAudioLevel?: (level: number) => void;
  /** 演出挂钩：她的定稿字幕（每句一次）→ 本地情绪判断驱动表情/动作 */
  onBotUtterance?: (text: string) => void;
  variant?: 'default' | 'handheld-home';
  onClose: () => void;
};

function formatDuration(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function CallOverlay({ open, mode = 'voice', avatarName, avatarId, voice, systemMessage, callSettings, onBotAudioLevel, onBotUtterance, variant = 'default', onClose }: Props) {
  const [status, setStatus] = useState<CallStatus | null>(null);
  const [errorMsg, setErrorMsg] = useState('');
  const [seconds, setSeconds] = useState(0);
  const [micMuted, setMicMuted] = useState(false);
  const [visionAvailable, setVisionAvailable] = useState(false);
  const [cameraOn, setCameraOn] = useState(false);
  const [swapped, setSwapped] = useState(false); // false: Live2D大窗/摄像头小窗；true: 交换
  const clientRef = useRef<CallClient | null>(null);
  const camRef = useRef<HTMLDivElement | null>(null);

  // 发起 / 清理一次通话
  useEffect(() => {
    if (!open) return;

    let cancelled = false;
    const client = createCallClient();
    clientRef.current = client;
    setStatus('connecting');
    setErrorMsg('');
    setSeconds(0);
    setMicMuted(false);

    void client.start(
      { avatarId, avatarName, voice, systemMessage, callSettings, mode, onBotAudioLevel, onBotUtterance },
      (next, detail) => {
        if (cancelled) return;
        setStatus(next);
        if (next === 'connected') {
          setVisionAvailable(!!detail?.visionAvailable);
          // "直接视频"：视频已在接通前推流，接通即点亮摄像头并挂上本地预览。
          if (detail?.cameraOn) {
            setCameraOn(true);
            clientRef.current?.attachLocalPreview(camRef.current ?? undefined);
          }
        }
        if (next === 'error') {
          setErrorMsg(detail?.error ?? '通话失败');
        }
      },
    );

    return () => {
      cancelled = true;
      void client.hangup();
      clientRef.current = null;
    };
    // 仅在打开/角色切换时重新建连
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, avatarId]);

  // 关闭时重置摄像头状态
  useEffect(() => {
    if (!open) {
      setCameraOn(false);
      setSwapped(false);
      setVisionAvailable(false);
    }
  }, [open]);

  // 接通后开始计时
  useEffect(() => {
    if (status !== 'connected') return;
    const timer = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, [status]);

  if (!open) return null;

  async function handleHangup() {
    await clientRef.current?.hangup();
    onClose();
  }

  async function toggleMute() {
    const next = !micMuted;
    setMicMuted(next);
    await clientRef.current?.setMuted(next);
  }

  async function toggleCamera() {
    const next = !cameraOn;
    try {
      await clientRef.current?.setCameraEnabled(next, camRef.current ?? undefined);
      setCameraOn(next);
      if (!next) setSwapped(false);
    } catch {
      // 权限被拒/采集失败 → 降级纯语音
      setCameraOn(false);
      showToast('摄像头打开失败，继续语音通话', 'warning');
    }
  }

  const statusLine =
    status === 'connecting'
      ? (mode === 'video' ? `正在和 ${avatarName} 视频连线…` : `正在给 ${avatarName} 打电话…`)
      : status === 'connected'
        ? formatDuration(seconds)
        : status === 'error'
          ? errorMsg
          : '';

  if (variant === 'handheld-home') {
    return (
      <div className="call-overlay call-overlay--handheld" role="dialog" aria-label={`与 ${avatarName} 通话`}>
        <div
          ref={camRef}
          className={`call-cam ${cameraOn ? (swapped ? 'call-cam--full' : 'call-cam--pip') : 'call-cam--hidden'}`}
          onClick={() => { if (cameraOn) setSwapped((s) => !s); }}
          role="button"
          aria-label="切换大小窗"
        />
        <div className="call-overlay__bottom call-overlay__bottom--handheld" onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            className="call-handheld-btn call-handheld-btn--hangup"
            onClick={handleHangup}
            aria-label="挂断"
          >
            <img src="./handheld/figma/call-hangup.svg" alt="" />
          </button>
          <button
            type="button"
            className={`call-handheld-btn call-handheld-btn--mute${micMuted ? ' is-muted' : ''}`}
            onClick={toggleMute}
            aria-label={micMuted ? '取消静音' : '静音'}
          >
            <span className="call-handheld-btn__frost">
              <img src="./handheld/figma/call-mute.svg" alt="" />
            </span>
          </button>
          <span className="call-handheld-status" aria-live="polite">
            {statusLine}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="call-overlay" role="dialog" aria-label={`与 ${avatarName} 通话`}>
      <div
        ref={camRef}
        className={`call-cam ${cameraOn ? (swapped ? 'call-cam--full' : 'call-cam--pip') : 'call-cam--hidden'}`}
        onClick={() => { if (cameraOn) setSwapped((s) => !s); }}
        role="button"
        aria-label="切换大小窗"
      />
      <div className="call-overlay__bottom" onClick={(e) => e.stopPropagation()}>
        <p className={`call-status-text${status === 'error' ? ' is-error' : ''}`}>{statusLine}</p>
        <div className="call-controls">
          <div className="call-control">
            <button
              type="button"
              className={`call-mic${micMuted ? ' is-muted' : ''}`}
              onClick={toggleMute}
              disabled={status !== 'connected'}
              aria-label={micMuted ? '取消静音' : '静音'}
            >
              {micMuted ? (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="2" y1="2" x2="22" y2="22" />
                  <path d="M9 9v1a3 3 0 0 0 5.12 2.12M15 9.34V5a3 3 0 0 0-5.94-.6" />
                  <path d="M17 10a5 5 0 0 1-.54 2.27M5 10a7 7 0 0 0 11 5.5" />
                  <line x1="12" y1="19" x2="12" y2="22" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="9" y="2" width="6" height="12" rx="3" />
                  <path d="M5 10a7 7 0 0 0 14 0" />
                  <line x1="12" y1="19" x2="12" y2="22" />
                </svg>
              )}
            </button>
            <span className="call-hangup-label">{micMuted ? '已静音' : '静音'}</span>
          </div>
          {/* 摄像头按钮仅视频模式显示：语音模式服务端未开视觉，开了 LLM 也看不到 */}
          {mode === 'video' && visionAvailable ? (
            <div className="call-control">
              <button
                type="button"
                className={`call-cam-btn${cameraOn ? ' is-on' : ''}`}
                onClick={toggleCamera}
                disabled={status !== 'connected'}
                aria-label={cameraOn ? '关闭摄像头' : '开启摄像头'}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M23 7 16 12l7 5V7z" />
                  <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
                </svg>
              </button>
              <span className="call-hangup-label">{cameraOn ? '关摄像头' : '开摄像头'}</span>
            </div>
          ) : null}
          <div className="call-control">
            <button
              type="button"
              className="call-hangup"
              onClick={handleHangup}
              aria-label="挂断"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.35 1.9.66 2.81a2 2 0 0 1-.45 2.11L8.05 9.91a16 16 0 0 0 6.04 6.04l1.27-1.27a2 2 0 0 1 2.11-.45c.91.31 1.85.53 2.81.66A2 2 0 0 1 22 16.92Z" />
              </svg>
            </button>
            <span className="call-hangup-label">挂断</span>
          </div>
        </div>
      </div>
    </div>
  );
}
