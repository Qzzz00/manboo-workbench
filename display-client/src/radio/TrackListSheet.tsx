// 歌单覆盖层（Figma 深色版）：曲目平铺，当前曲黄色 + 均衡器动画。三空态（授权/无歌/加载）。
// 注意：类名 radio-sheet/radio-sheet-body、radio-track[--on]、标题「歌单（n）」、按钮文案均被 TrackListSheet.test 断言，勿改。
import { fmtTime, type RadioTrack, type ScanPhase } from './radioState.ts';

export function TrackListSheet({ tracks, phase, currentId, onPlayAt, onRescan, onRequestPermission, onClose }: {
  tracks: RadioTrack[];
  phase: ScanPhase;
  currentId: string | null;
  onPlayAt: (index: number) => void;
  onRescan: () => void;
  onRequestPermission: () => void;
  onClose: () => void;
}) {
  return (
    <div className="radio-sheet">
      <div className="radio-sheet-head">
        <div className="radio-sheet-title">歌单（{tracks.length}）</div>
        <div className="radio-sheet-actions">
          <button className="radio-sheet-close" onClick={onRescan} aria-label="重新扫描">⟳</button>
          <button className="radio-sheet-close" onClick={onClose}>✕</button>
        </div>
      </div>
      <div className="radio-sheet-body">
        {phase === 'denied' ? (
          <div className="radio-empty">
            <div>需要媒体权限才能读取 SD 卡音乐</div>
            <button onClick={onRequestPermission}>去授权</button>
          </div>
        ) : phase === 'empty' ? (
          <div className="radio-empty">
            <div>没有找到音乐<br />插入 SD 卡或把歌曲拷进 Music 文件夹</div>
            <button onClick={onRescan}>重新扫描</button>
          </div>
        ) : phase === 'loading' ? (
          <div className="radio-empty"><div>扫描中…</div></div>
        ) : (
          <ul className="radio-tracklist">
            {tracks.map((t, i) => (
              <li key={t.id}>
                <button
                  className={`radio-track${t.id === currentId ? ' radio-track--on' : ''}`}
                  onClick={() => onPlayAt(i)}
                >
                  <span className="radio-track-title">{t.title}</span>
                  <span className="radio-track-sub">
                    <span>{t.artist || '未知艺人'}</span>
                    <span>{fmtTime(t.durationMs)}</span>
                  </span>
                  {t.id === currentId ? (
                    <span className="radio-track-eq" aria-hidden><i /><i /><i /><i /></span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
