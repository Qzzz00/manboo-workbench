// Live2D音乐 底部播放器：单行紧凑条（照 Ben 给的参考图重排）。
//   圆形封面 56 + 单行「歌名 - 歌手」+ 播停（48 圆圈线框）+ 歌单（44），顶部整条进度保留。
//   上一首/下一首不再放按钮——在整条播放条上左右滑切歌（左滑=下一首），判定见 playerSwipe.ts；
//   条上的 pointer 事件不冒泡，这样 RadioApp 的切页手势只在角色区生效，两种滑动不打架。
import { useRef, useState } from 'react';
import { type PlaybackView } from './radioState.ts';
import { decidePlayerSwipe, type PlayerSwipeAction } from './playerSwipe.ts';

export function RadioPlayerCard({ view, coverUrl, onToggle, onNext, onPrev, onOpenList }: {
  view: PlaybackView;
  coverUrl: string;
  onToggle: () => void;
  onNext: () => void;
  onPrev: () => void;
  onOpenList: () => void;
}) {
  const t = view.track;
  // 切歌反馈动画：内容行按滑动方向滑出→滑入（240ms CSS keyframes，中段透明窗口等原生歌名回传）。
  // key 用递增序号强制重挂内容行，连续快滑时动画才会从头重播（同类名重复 set 不会重启 animation）。
  const swipe = useRef<{ x: number; y: number; t: number } | null>(null);
  const animSeq = useRef(0);
  const [anim, setAnim] = useState<PlayerSwipeAction | null>(null);

  const onPointerDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    swipe.current = { x: e.clientX, y: e.clientY, t: Date.now() };
  };
  const onPointerUp = (e: React.PointerEvent) => {
    e.stopPropagation();
    const s = swipe.current;
    swipe.current = null;
    if (!s) return;
    const act = decidePlayerSwipe(e.clientX - s.x, e.clientY - s.y, Date.now() - s.t);
    if (!act) return;
    animSeq.current += 1;
    setAnim(act);
    if (act === 'next') onNext(); else onPrev();
  };

  return (
    <div className="radio-player" onPointerDown={onPointerDown} onPointerUp={onPointerUp} onPointerCancel={() => { swipe.current = null; }}>
      <div className="radio-player-track"><i style={{ width: `${view.progress * 100}%` }} /></div>
      <div
        key={animSeq.current}
        className={`radio-player-row${anim ? ` radio-player-row--${anim}` : ''}`}
        onAnimationEnd={() => setAnim(null)}
      >
        <div className="radio-player-art">
          {coverUrl ? <img src={coverUrl} alt="" /> : <div className="radio-player-art-fallback">♪</div>}
        </div>
        <div className="radio-player-line">
          {t ? (
            <>
              <span className="radio-player-line-title">{t.title}</span>
              <span className="radio-player-line-artist"> - {t.artist || '未知艺人'}</span>
            </>
          ) : (
            <span className="radio-player-line-title">未在播放</span>
          )}
        </div>
        <button className="radio-player-ctrl radio-player-ctrl--toggle" onClick={onToggle} aria-label="播放/暂停">
          {view.playing ? (
            <svg viewBox="0 0 48 48" width="48" height="48">
              <circle cx="24" cy="24" r="21.5" fill="none" stroke="currentColor" strokeWidth="2.6" />
              <path fill="currentColor" d="M18.4 16h4v16h-4zm7.2 0h4v16h-4z" />
            </svg>
          ) : (
            <svg viewBox="0 0 48 48" width="48" height="48">
              <circle cx="24" cy="24" r="21.5" fill="none" stroke="currentColor" strokeWidth="2.6" />
              <path fill="currentColor" d="M19.5 15.5v17L33 24z" />
            </svg>
          )}
        </button>
        <button className="radio-player-ctrl radio-player-ctrl--list" onClick={onOpenList} aria-label="歌单">
          <svg viewBox="0 0 44 44" width="44" height="44">
            <path fill="currentColor" d="M6 10h24v3.6H6zm0 9h24v3.6H6zm0 9h13v3.6H6z" />
            <path fill="currentColor" d="M33.5 19v10.9a5 5 0 1 0 2.6 4.4V25l4.9 1.5v-4z" />
          </svg>
        </button>
      </div>
    </div>
  );
}
