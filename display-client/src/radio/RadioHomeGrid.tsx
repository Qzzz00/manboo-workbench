// 主界面九宫格（严格对齐 Figma 2047:998，480×640 设计画布）：
//   行1: 音乐黑胶(8,50,228) | live2d 卡片(244,50,228×346，角色由固定浮窗画在其上，含底部通话按钮)
//   行2(左): 录音(8,286) 收音机(126,286)
//   行3+: 磨砂应用簇(8,404,228: 日历/学习/视频/更多应用) | 图片(244,404) 文件(362,404) | 计算器(244,522) 设置(362,522)
// 图标：设置/录音/视频/更多/图片=导出 Figma svg；计算器/学习=导出 png；音乐/收音机/日历/文件=CSS 还原(含交互/日期)。
// 交互：能确定映射的直连(音乐&收音机&通话→电台, 设置→设置, 更多应用→抽屉)；其余系统 tile 统一落「更多应用」抽屉避免死点。
import { type PlaybackView } from './radioState.ts';

export function RadioHomeGrid({
  view, onToggle, onNext, onPrev, onOpenRadio, onOpenMoreApps, onOpenSettings,
  cardLoading, inCall, callMicMuted, onStartCall, onToggleMic, onHangUp,
}: {
  view: PlaybackView;
  onToggle: () => void;
  onNext: () => void;
  onPrev: () => void;
  onOpenRadio: () => void;
  onOpenMoreApps: () => void;
  onOpenSettings: () => void;
  onLaunchApp: (pkg: string) => void;
  cardLoading: boolean;      // 小浮窗未就绪：卡片内转圈
  inCall: boolean;           // 通话中：底部显示 麦克风 + 挂断，否则显示 拨通
  callMicMuted: boolean;
  onStartCall: () => void;   // 拨通
  onToggleMic: () => void;   // 通话内静音切换
  onHangUp: () => void;      // 挂断
}) {
  const day = new Date().getDate();
  return (
    <div className="radio-home">
      {/* —— live2d 卡片：box-shadow 挖洞（自身透明 + 超大 spread 填满卡片以外为 #262626），被 .radio-home
          的 overflow:hidden 裁到本页范围内 → 能随页平移不外溢遮 DJ 页。DOM 提供底部渐变 + 通话控件 + 转圈。 —— */}
      <div className="radio-tile-live2d">
        {cardLoading ? <div className="rl2d-loading"><div className="radio-spinner" /></div> : null}
        <div className="rl2d-footer">
          {inCall ? (
            <>
              <button className={`rl2d-mic${callMicMuted ? ' rl2d-mic--muted' : ''}`} onClick={onToggleMic} aria-label={callMicMuted ? '取消静音' : '静音'}>
                <svg width="36" height="36" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <rect x="9" y="2.5" width="6" height="11" rx="3" fill="currentColor" />
                  <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                  {callMicMuted ? <path d="M4 3.5l16 17" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" /> : null}
                </svg>
              </button>
              <button className="rl2d-hangup" onClick={onHangUp} aria-label="挂断">
                <img src="/radio/hangup.svg" alt="" />
              </button>
            </>
          ) : (
            <button className="rl2d-call" onClick={onStartCall} aria-label="拨通，和她说话">
              <img src="/radio/call.svg" alt="" />
            </button>
          )}
        </div>
      </div>

      {/* —— 音乐黑胶迷你播放器 —— */}
      <div className="radio-tile radio-tile-player">
        <button className="rp-disc-wrap" onClick={onOpenRadio} aria-label="打开电台">
          <span className={`rp-disc${view.playing ? ' rp-disc--spin' : ''}`} />
          <span className="rp-note">♫</span>
        </button>
        <div className="rp-bar">
          <button onClick={onPrev} aria-label="上一首">
            <svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M6 6h2.2v12H6zm3.4 6l9 6V6z"/></svg>
          </button>
          <button className="rp-play" onClick={onToggle} aria-label="播放/暂停">
            {view.playing
              ? <svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M6.5 5h4v14h-4zm7 0h4v14h-4z"/></svg>
              : <svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>}
          </button>
          <button onClick={onNext} aria-label="下一首">
            <svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M15.8 6H18v12h-2.2zM6 18l9-6-9-6z"/></svg>
          </button>
        </div>
      </div>

      {/* —— 录音 / 收音机 —— */}
      <button className="radio-tile radio-tile-record" onClick={onOpenMoreApps} aria-label="录音">
        <img src="/radio/record.svg" alt="" />
      </button>
      <button className="radio-tile radio-tile-fm" onClick={onOpenRadio} aria-label="收音机">
        <span className="fm-top" />
        <span className="fm-grille"><span /></span>
        <span className="fm-cone fm-cone-l" />
        <span className="fm-cone fm-cone-r" />
        <span className="fm-tune"><i /><i /><i /></span>
        <span className="fm-antenna" />
      </button>

      {/* —— 磨砂应用簇 2×2 —— */}
      <div className="radio-cluster">
        <button className="radio-tile radio-tile-cal" onClick={onOpenMoreApps} aria-label="日历">
          <span className="cal-hook cal-hook-l" />
          <span className="cal-hook cal-hook-r" />
          <span className="cal-top" />
          <span className="cal-day">{day}</span>
        </button>
        <button className="radio-tile radio-tile-book" onClick={onOpenMoreApps} aria-label="学习">
          <img src="/radio/book.png" alt="" />
        </button>
        <button className="radio-tile radio-tile-video" onClick={onOpenMoreApps} aria-label="视频">
          <img src="/radio/video.svg" alt="" />
        </button>
        <button className="radio-tile radio-tile-more" onClick={onOpenMoreApps} aria-label="更多应用">
          <img src="/radio/more.svg" alt="" />
        </button>
      </div>

      {/* —— 图片 / 文件 / 计算器 / 设置 —— */}
      <button className="radio-tile radio-tile-gallery" onClick={onOpenMoreApps} aria-label="图片">
        <img src="/radio/photos.svg" alt="" />
      </button>
      <button className="radio-tile radio-tile-file" onClick={onOpenMoreApps} aria-label="文件">
        <span className="folder-paper" />
        <img className="folder-flap" src="/radio/folder-flap.svg" alt="" />
      </button>
      <button className="radio-tile radio-tile-calc" onClick={onOpenMoreApps} aria-label="计算器">
        <img src="/radio/calc.png" alt="" />
      </button>
      <button className="radio-tile radio-tile-settings" onClick={onOpenSettings} aria-label="设置">
        <img src="/radio/settings.svg" alt="" />
      </button>
    </div>
  );
}
