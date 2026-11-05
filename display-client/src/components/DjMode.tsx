import { DjPlayerWidget } from '../screensaver/widgets/DjPlayerWidget';
import type { DjModeView } from '../hooks/useDjMode';
import { FocusTimer } from './dj/FocusTimer';
import { CommutePodcastView } from './dj/CommutePodcastView';
import { CommuteDigBar } from './dj/CommuteDigBar';
import './dj-mode.css';

// 电台模式（与后端 server/dj/program.cjs MODES 对齐）。切换=换该模式当日节目单，秒切。
const DJ_MODES: { key: string; label: string }[] = [
  { key: 'commute', label: '通勤' },
  { key: 'focus', label: '专注' },
  { key: 'rest', label: '休息' },
];

/**
 * App 内「DJ 电台」UI 覆盖层（纯 chrome，不含渲染）。
 * 角色由**主 App 共享的那一个 Live2DStage**渲染（与主页/登录同一个 WebGL 上下文，秒切，不重建）；
 * 背景由共享 Stage 的 backgroundUrl 承载。本层只叠：暗角 scrim + 标题 + 关闭 + 模式条 + 播放器卡片，
 * 半透明、pointer-events 仅作用于控件，角色从下层透出。就绪前透明（露出主页角色覆盖切换空档）。
 */
export function DjMode({ view }: { view: DjModeView }) {
  const isCommute = view.mode === 'commute';
  return (
    <div
      className={`dj-mode-root${view.bgIn ? ' dj-mode-root--ready' : ''}${
        isCommute ? ' dj-mode-root--commute' : ''
      }`}
    >
      <div className="dj-mode-scrim" />

      <button type="button" className="dj-mode-close" onClick={view.requestClose} aria-label="退出电台">
        ✕
      </button>

      {/* 模式条移到顶部（取代原「AI 电台 ON AIR」标题），避免压在角色脸上。 */}
      <div className="dj-mode-modes" role="group" aria-label="电台模式">
        {DJ_MODES.map((m) => (
          <button
            key={m.key}
            type="button"
            className={`dj-mode-chip${view.mode === m.key ? ' dj-mode-chip--on' : ''}`}
            onClick={() => view.setMode(m.key)}
            aria-pressed={view.mode === m.key}
          >
            {m.label}
          </button>
        ))}
      </div>

      {/* 通勤：无 Live2D，话题卡片为主，讲到哪条滚到正中；底部最小化播放控制 + 深挖输入。 */}
      {isCommute && <CommutePodcastView view={view} />}

      {isCommute && (
        <div className="dj-mode-feature dj-mode-feature--commute">
          <CommuteDigBar view={view} />
        </div>
      )}

      {view.mode === 'focus' && (
        <div className="dj-mode-feature">
          <FocusTimer pomodoroMin={view.pomodoroMin} onChangeMin={view.setPomodoroMin} />
        </div>
      )}

      {view.mode === 'rest' && (
        <div className="dj-mode-feature">
          <label className="dj-rest-lullaby">
            <span className="dj-rest-lullaby-label">哄睡模式</span>
            <span className="dj-rest-lullaby-hint">
              {view.lullaby ? '安静纯音乐，伴你入睡' : '正常歌单'}
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={view.lullaby}
              className={`dj-switch${view.lullaby ? ' dj-switch--on' : ''}`}
              onClick={() => view.setLullaby(!view.lullaby)}
            >
              <span className="dj-switch-knob" />
            </button>
          </label>
        </div>
      )}

      <div className="dj-mode-bottom">
        {isCommute ? (
          <div className="dj-commute-miniplayer">
            <button
              type="button"
              className="dj-commute-mp-btn"
              onClick={() => view.dj.controls.prev()}
              aria-label="上一段"
            >
              ⏮
            </button>
            <button
              type="button"
              className="dj-commute-mp-btn dj-commute-mp-btn--play"
              onClick={() => view.dj.controls.playPause()}
              aria-label={view.dj.paused ? '播放' : '暂停'}
            >
              {view.dj.paused ? '▶' : '⏸'}
            </button>
            <button
              type="button"
              className="dj-commute-mp-btn"
              onClick={() => view.dj.controls.next()}
              aria-label="下一段"
            >
              ⏭
            </button>
          </div>
        ) : (
          <DjPlayerWidget state={view.dj} controls={view.dj.controls} />
        )}
      </div>
    </div>
  );
}
