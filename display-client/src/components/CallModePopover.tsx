import { useEffect } from 'react';

type Props = {
  open: boolean;
  onVoice: () => void;
  onVideo: () => void;
  onClose: () => void;
};

/**
 * 通话方式选择弹出面板（语音 / 视频）。
 * 从 composer 电话键正上方竖排弹出，与 + 号的 composer-plus-popover 同款交互/视觉
 * （48px 浅圆底 + 深色填充 glyph），取代旧的全屏底部弹层：轻、快、不打断当前画面。
 * 语音/视频必须在接通前选定（视频需"视频先进房→开视觉→先看后开口"，无法中途切换）。
 *
 * 点击外部关闭用 document 级 pointerdown 监听实现，不用 DOM 遮罩：
 * .app-shell 是 position:fixed 的层叠上下文(z-index:auto)，任何 portal 到 body 的
 * 遮罩(正 z-index)都会盖在整个 app 之上、吃掉面板按钮的点击（曾导致点按钮无反应）。
 */
export function CallModePopover({ open, onVoice, onVideo, onClose }: Props) {
  useEffect(() => {
    if (!open) return;
    function onDocPointerDown(e: PointerEvent) {
      const t = e.target as HTMLElement | null;
      // 点面板内 → 由按钮自身处理；点电话键 → 由其 onClick 切换（避免与本监听打架重开）
      if (t?.closest('.composer-call-popover') || t?.closest('.composer-call-btn')) return;
      onClose();
    }
    document.addEventListener('pointerdown', onDocPointerDown);
    return () => document.removeEventListener('pointerdown', onDocPointerDown);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="composer-call-popover" role="menu" aria-label="选择通话方式">
      <button
        type="button"
        className="composer-call-popover-item"
        onClick={() => {
          onClose();
          onVideo();
        }}
        aria-label="视频通话"
      >
        <svg viewBox="0 0 24 24" fill="currentColor">
          <path d="M2 7.5A2.5 2.5 0 014.5 5h10A2.5 2.5 0 0117 7.5v9a2.5 2.5 0 01-2.5 2.5h-10A2.5 2.5 0 012 16.5v-9zM18.5 10.1l3.2-2.2a.8.8 0 011.3.66v6.88a.8.8 0 01-1.3.66l-3.2-2.2v-3.8z" />
        </svg>
        <span className="composer-call-popover-label">视频</span>
      </button>
      <button
        type="button"
        className="composer-call-popover-item"
        onClick={() => {
          onClose();
          onVoice();
        }}
        aria-label="语音通话"
      >
        <svg viewBox="0 0 24 24" fill="currentColor">
          <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.35 1.9.66 2.81a2 2 0 0 1-.45 2.11L8.05 9.91a16 16 0 0 0 6.04 6.04l1.27-1.27a2 2 0 0 1 2.11-.45c.91.31 1.85.53 2.81.66A2 2 0 0 1 22 16.92Z" />
        </svg>
        <span className="composer-call-popover-label">语音</span>
      </button>
    </div>
  );
}
