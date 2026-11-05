import { useEffect, useRef, useState } from 'react';

import type { DjControls, DjItem, DjState } from '../lib/djClient';
import { fetchActiveDjAvatarId, portraitForAvatar } from '../lib/djAvatar';

function trackLabel(item: DjItem | null): { title: string; subtitle: string } {
  if (!item) return { title: '电台待机', subtitle: '等待节目…' };
  if (item.kind === 'tts') {
    return { title: item.text?.slice(0, 40) || 'DJ 口播中…', subtitle: '主播口播' };
  }
  return { title: item.title || '未知曲目', subtitle: item.artist || '未知歌手' };
}

function statusLabel(status: DjState['status']): string {
  switch (status) {
    case 'connected':
      return '● 直播中';
    case 'connecting':
      return '○ 连接中';
    case 'error':
      return '○ 未连接';
    default:
      return '○ 未配置';
  }
}

/** 网易云封面缩放（CDN 支持 ?param=WxH）。 */
function coverUrl(pic: string, size = 200): string {
  if (!pic) return '';
  return pic.includes('?') ? pic : `${pic}?param=${size}y${size}`;
}

/**
 * DJ 播放器卡片。
 * - 传入 controls（DJ 模式页）：渲染音乐播放器控制行（上一首/喜欢/播放暂停/不喜欢/下一首），
 *   封面用歌曲专辑图，进度跟随真实播放位置。
 * - 不传 controls（充电屏保）：保持原纯展示形态。
 */
export function DjPlayerWidget({
  state,
  controls,
}: {
  state: DjState;
  controls?: DjControls;
}) {
  const playing = state.playing;
  const isTts = playing?.kind === 'tts';
  const [progress, setProgress] = useState(0);
  const [portrait, setPortrait] = useState(() => portraitForAvatar(null));
  const [coverFailed, setCoverFailed] = useState(false);

  // 角色立绘（口播态/无专辑封面时的兜底）
  useEffect(() => {
    let alive = true;
    fetchActiveDjAvatarId().then((id) => {
      if (alive) setPortrait(portraitForAvatar(id));
    });
    return () => {
      alive = false;
    };
  }, []);

  // 换曲时重置封面失败标记
  useEffect(() => {
    setCoverFailed(false);
  }, [playing?.queue_item_id, playing?.pic_url]);

  // 进度：有 controls 用真实播放位置（含暂停/seek）；否则回落 started_at 估算。
  const controlsRef = useRef(controls);
  controlsRef.current = controls;
  useEffect(() => {
    if (controlsRef.current) {
      const tick = () => {
        const c = controlsRef.current;
        if (!c) return;
        const dur = c.getDurationMs();
        setProgress(dur > 0 ? Math.max(0, Math.min(1, c.getPositionMs() / dur)) : 0);
      };
      tick();
      const t = setInterval(tick, 500);
      return () => clearInterval(t);
    }
    if (!playing?.started_at || !playing.duration_ms) {
      setProgress(0);
      return;
    }
    const startMs = Date.parse(playing.started_at);
    if (Number.isNaN(startMs)) {
      setProgress(0);
      return;
    }
    const tick = () => {
      const elapsed = Date.now() - startMs;
      setProgress(Math.max(0, Math.min(1, elapsed / playing.duration_ms)));
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [controls, playing?.queue_item_id, playing?.started_at, playing?.duration_ms]);

  const { title, subtitle } = trackLabel(playing);
  const hasContent = !!playing;
  const paused = state.paused;

  // 封面：曲目封面优先 → 失败/无封面/口播态 → 角色立绘
  const songCover = !isTts && playing?.pic_url && !coverFailed ? coverUrl(playing.pic_url) : '';
  const artStyle = songCover
    ? { backgroundImage: `url(${songCover})` }
    : { backgroundImage: `url(${portrait})` };

  const coverProbe = songCover ? (
    // 触发 onError 兜底：隐藏的 img 仅用于探测封面是否可加载
    <img src={songCover} alt="" hidden onError={() => setCoverFailed(true)} />
  ) : null;

  // 屏保（无 controls）：保持原纯展示横排 + 波形。
  if (!controls) {
    return (
      <div className="ss-player">
        <div className="ss-player-art" style={artStyle}>
          {coverProbe}
          {hasContent && (
            <div className="ss-player-eq">
              <span />
              <span />
              <span />
            </div>
          )}
        </div>
        <div className="ss-player-body">
          <div className="ss-player-row">
            <span className="ss-player-tag">AI DJ · 音乐电台</span>
            <span className={`ss-dj-status ss-dj-status-${state.status}`}>{statusLabel(state.status)}</span>
          </div>
          <div className="ss-player-title">{title}</div>
          <div className="ss-player-artist">{subtitle}</div>
          <div className="ss-player-bar">
            <div className="ss-player-bar-fill" style={{ width: `${progress * 100}%` }} />
          </div>
        </div>
      </div>
    );
  }

  // DJ 模式：紧凑播放器——封面在左、信息在右；底部全宽控制行（左喜欢/讨厌，右切歌/播放暂停）。
  return (
    <div className="ss-player ss-player--controls">
      <div className="ss-player-head">
        <div className="ss-player-art" style={artStyle}>
          {coverProbe}
        </div>
        <div className="ss-player-meta">
          <div className="ss-player-row">
            <span className="ss-player-tag">AI DJ · 音乐电台</span>
            <span className={`ss-dj-status ss-dj-status-${state.status}`}>{statusLabel(state.status)}</span>
          </div>
          <div className="ss-player-title">{title}</div>
          <div className="ss-player-artist">{subtitle}</div>
        </div>
      </div>
      <div className="ss-player-bar">
        <div className="ss-player-bar-fill" style={{ width: `${progress * 100}%` }} />
      </div>
      <div className="ss-player-controls">
        <div className="ss-pc-group">
          <button
            type="button"
            className={`ss-pc-btn ss-pc-like${state.feedback === 'like' ? ' is-active' : ''}`}
            aria-label="喜欢"
            onClick={controls.like}
          >
            <HeartIcon filled={state.feedback === 'like'} />
          </button>
          <button
            type="button"
            className={`ss-pc-btn ss-pc-dislike${state.feedback === 'dislike' ? ' is-active' : ''}`}
            aria-label="不喜欢"
            onClick={controls.dislike}
          >
            <BanIcon />
          </button>
        </div>
        <div className="ss-pc-group">
          <button type="button" className="ss-pc-btn" aria-label="上一首" onClick={controls.prev}>
            <PrevIcon />
          </button>
          <button
            type="button"
            className="ss-pc-btn ss-pc-play"
            aria-label={paused ? '播放' : '暂停'}
            onClick={controls.playPause}
          >
            {paused ? <PlayIcon /> : <PauseIcon />}
          </button>
          <button type="button" className="ss-pc-btn" aria-label="下一首" onClick={controls.next}>
            <NextIcon />
          </button>
        </div>
      </div>
    </div>
  );
}

// ---- 内联 SVG 图标（描边/填充随 currentColor） ----

function PrevIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden>
      <path d="M7 6v12H5V6h2zm12 0v12l-9-6 9-6z" />
    </svg>
  );
}
function NextIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden>
      <path d="M17 6v12h2V6h-2zM5 6v12l9-6L5 6z" />
    </svg>
  );
}
function PlayIcon() {
  return (
    <svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor" aria-hidden>
      <path d="M8 5v14l11-7L8 5z" />
    </svg>
  );
}
function PauseIcon() {
  return (
    <svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor" aria-hidden>
      <path d="M6 5h4v14H6V5zm8 0h4v14h-4V5z" />
    </svg>
  );
}
function HeartIcon({ filled }: { filled: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="22"
      height="22"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
    </svg>
  );
}
function BanIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="22"
      height="22"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M5.6 5.6l12.8 12.8" />
    </svg>
  );
}
