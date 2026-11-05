import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { isCancel, isNativeCamera, takePhoto } from '../lib/nativeCamera.ts';
import {
  checkAvatarLibraryUpdate,
  startAvatarLibraryDownload,
  pauseAvatarLibraryDownload,
} from '../hooks/useRemoteAvatars.ts';
import {
  useAvatarLibraryUpdate,
  type AvatarLibraryUpdateState,
} from '../features/live2d/remoteAvatarSyncStore.ts';

type ChatComposerPanelProps = {
  open: boolean;
  onClose: () => void;
  onPickImage: (file: File) => void;
  autoHideChat: boolean;
  onToggleAutoHide: () => void;
};

interface ComposerItem {
  key: string;
  label: string;
  onClick: () => void;
  onMouseDown?: (e: React.MouseEvent) => void;
  icon: React.ReactNode;
  showDot?: boolean;
  showRing?: boolean;
  ringPercent?: number;
}

const RING_RADIUS = 10;

function avatarUpdateLabel(state: AvatarLibraryUpdateState): string {
  switch (state.downloadState) {
    case 'checking':
      return '检查更新…';
    case 'downloading':
      return `更新中 ${state.progress.completed}/${state.progress.total}`;
    case 'paused':
      return '继续更新';
    case 'failed':
      return '更新失败可重试';
    case 'available':
      return state.pendingCount > 0 ? `发现 ${state.pendingCount} 个更新` : '角色库有更新';
    default:
      return '角色库';
  }
}

export function ChatComposerPanel({
  open,
  onClose,
  onPickImage,
  autoHideChat,
  onToggleAutoHide,
}: ChatComposerPanelProps) {
  const albumInputRef = useRef<HTMLInputElement>(null);
  const updateState = useAvatarLibraryUpdate();

  // 进入加号页面时做一次轻量检查（只拉 catalog 元数据，不下载）。
  useEffect(() => {
    if (open) void checkAvatarLibraryUpdate();
  }, [open]);

  const handleCamera = async () => {
    if (isNativeCamera()) {
      try {
        const file = await takePhoto();
        if (file) onPickImage(file);
        onClose();
        return;
      } catch (err) {
        if (isCancel(err)) {
          onClose();
          return;
        }
        // 权限被拒/不可用 → 降级到相册选择
      }
    }
    albumInputRef.current?.click();
  };

  // 隐藏的相册 input 始终挂载（即便面板收起，拍照降级仍可能触发它）
  const albumInput = (
    <input
      ref={albumInputRef}
      type="file"
      accept="image/*"
      className="composer-panel-hidden-input"
      onChange={(e) => {
        const f = e.target.files?.[0];
        if (f) onPickImage(f);
        e.target.value = '';
        onClose();
      }}
    />
  );

  if (!open) return albumInput;

  // 图标统一为「面状」填充风格（evenodd 挖空细节），与胶囊内的 + 号一致
  const items: ComposerItem[] = [
    {
      key: 'camera',
      label: '拍照',
      onClick: handleCamera,
      icon: (
        <path
          fillRule="evenodd"
          clipRule="evenodd"
          d="M9 3.5l-1.3 2H4a2 2 0 00-2 2V19a2 2 0 002 2h16a2 2 0 002-2V7.5a2 2 0 00-2-2h-3.7L15 3.5H9zm3 4.5a4.5 4.5 0 100 9 4.5 4.5 0 000-9zm0 2a2.5 2.5 0 110 5 2.5 2.5 0 010-5z"
        />
      ),
    },
    {
      key: 'album',
      label: '相册',
      onClick: () => albumInputRef.current?.click(),
      icon: (
        <path
          fillRule="evenodd"
          clipRule="evenodd"
          d="M4 3a2 2 0 00-2 2v14a2 2 0 002 2h16a2 2 0 002-2V5a2 2 0 00-2-2H4zm4.5 3.5a2 2 0 100 4 2 2 0 000-4zM4.5 18.5l4.2-5 2.8 3.3L14.5 13l5 5.5h-15z"
        />
      ),
    },
    {
      key: 'autoHide',
      label: autoHideChat ? '自动隐藏' : '常显对话',
      onClick: () => {
        onToggleAutoHide();
        onClose();
      },
      icon: (
        <path
          fillRule="evenodd"
          clipRule="evenodd"
          d="M12 3C7 3 3 7 1 12c2 5 6 9 11 9s9-4 11-9c-2-5-6-9-11-9zm0 14a5 5 0 110-10 5 5 0 010 10zm0-2a3 3 0 100-6 3 3 0 000 6z"
        />
      ),
    },
    {
      key: 'avatarUpdate',
      label: avatarUpdateLabel(updateState),
      onClick: () => {
        if (updateState.downloadState === 'downloading') {
          pauseAvatarLibraryDownload();
        } else if (updateState.downloadState === 'paused') {
          void startAvatarLibraryDownload();
        } else if (updateState.updateAvailable || updateState.failedItems.length > 0) {
          void startAvatarLibraryDownload();
        } else {
          void checkAvatarLibraryUpdate();
        }
      },
      icon: (
        <path
          fillRule="evenodd"
          clipRule="evenodd"
          d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm3.6 9.3-2.2 2.2V4.5h-2.8v9l-2.2-2.2-2 2L12 19l5.6-5.7-2-2z"
        />
      ),
      showDot:
        updateState.updateAvailable &&
        updateState.downloadState !== 'downloading' &&
        updateState.downloadState !== 'paused',
      showRing: updateState.downloadState === 'downloading' || updateState.downloadState === 'paused',
      ringPercent: updateState.progress.percent,
    },
  ];

  // 面板 portal 到 body：composer 根节点带 transform（键盘/面板位移），若面板作为其子节点，
  // position:fixed 会以被 transform 的 composer 为包含块 → 面板飘到屏幕中间。挂到 body 才是视口固定。
  const panel = createPortal(
    <div className="composer-attach-panel">
      {items.map((it) => {
        const ringDash = `${(Math.min(100, Math.max(0, it.ringPercent ?? 0)) / 100) * 2 * Math.PI * RING_RADIUS} ${2 * Math.PI * RING_RADIUS}`;
        return (
          <button
            key={it.key}
            type="button"
            className="composer-attach-panel-item"
            onMouseDown={it.onMouseDown}
            onClick={it.onClick}
            aria-label={it.label}
          >
            <span className="composer-attach-panel-icon">
              <svg viewBox="0 0 24 24" fill="currentColor">
                {it.icon}
              </svg>
              {it.showRing ? (
                <svg className="composer-attach-panel-ring" viewBox="0 0 24 24" aria-hidden="true">
                  <circle cx="12" cy="12" r="10" fill="none" stroke="rgba(255,255,255,0.3)" strokeWidth="2.5" />
                  <circle
                    cx="12"
                    cy="12"
                    r="10"
                    fill="none"
                    stroke="#fff"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeDasharray={ringDash}
                    transform="rotate(-90 12 12)"
                  />
                </svg>
              ) : null}
              {it.showDot ? <span className="composer-attach-panel-dot" /> : null}
            </span>
            <span className="composer-attach-panel-label">{it.label}</span>
          </button>
        );
      })}
    </div>,
    document.body,
  );

  return (
    <>
      {albumInput}
      {panel}
    </>
  );
}
