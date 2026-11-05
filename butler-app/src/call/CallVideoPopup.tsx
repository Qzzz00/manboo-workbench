/**
 * 通话中弹出来的那个播放器(2026-10-12,周三演示「出图进可灵」那条链路的末尾)。
 *
 * 维护者原话:「看到视频之后推到手机端上,再打个电话过来,并且可以在手机上(通话过程中)看到视频。
 * 播放器以弹窗形式弹到通话页面上,给个关闭的 icon。」
 *
 * 形状上的两条:
 *   · **不盖满整屏、不要遮罩**:底下那条挂断 / 麦克风 / 字幕照旧点得到 ——
 *     盖住挂断键的弹窗等于把电话扣在她手里;
 *   · **在 App 里放**(`<video controls playsInline>`),不交给系统的播放器:电话还打着,
 *     跳出去一趟回来就是另一回事了(「收到的文件」那条路照旧交给原生,那是不在通话里的事)。
 *
 * 取字节与存盘不在这儿(StagePage 那一层调 `channel.pull`,与点卡片同一条路、同一张回执)。
 */
import { useState } from 'react';

/** 还在取的时候那一句。 */
export const CALL_VIDEO_PULLING_TEXT = '正在取这段视频…';
/** 放不了(安卓不认那个编码之类)时那一句。 */
export const CALL_VIDEO_BROKEN_TEXT = '这段视频手机上放不了,挂了电话到「文档 / 事务官」里看';

export interface CallVideoPopupProps {
  /** 文件名,摆在顶上一行。 */
  name: string;
  /** 能放的地址(存好了才有)。没有 = 还在取,或者取到了但这儿放不了(那时给 error)。 */
  src?: string;
  /** 没取到那句实话(原话照搬,不改写)。 */
  error?: string;
  onClose: () => void;
}

export function CallVideoPopup({ name, src, error, onClose }: CallVideoPopupProps) {
  const [broken, setBroken] = useState(false);
  return (
    <div className="ba-callvideo" role="dialog" aria-label={`视频 ${name}`}>
      <div className="ba-callvideo__head">
        <span className="ba-callvideo__name">{name}</span>
        <button type="button" className="ba-callvideo__close" aria-label="关掉视频" onClick={onClose}>×</button>
      </div>
      {error !== undefined
        ? <p className="ba-callvideo__note" role="status">视频没取到:{error}</p>
        : src === undefined
          ? <p className="ba-callvideo__note" role="status">{CALL_VIDEO_PULLING_TEXT}</p>
          : broken
            ? <p className="ba-callvideo__note" role="status">{CALL_VIDEO_BROKEN_TEXT}</p>
            : (
              <video
                className="ba-callvideo__video"
                controls
                playsInline
                autoPlay
                src={src}
                onError={() => setBroken(true)}
              />
            )}
    </div>
  );
}
