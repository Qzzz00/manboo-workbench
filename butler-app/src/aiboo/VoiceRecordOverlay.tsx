// 来源:Aiboo origin/main 7c55ce12 src/components/VoiceRecordOverlay.tsx —— 原样,只把 className 加了 ba- 前缀(voice-record-* → ba-voice-record-*)
//
// 2026-09-25(卡 S「手机在哪都能用」)加了一处:「识别中」挂了 8 秒还没回,补一行「网有点慢,还在转文字」。
// 在外面第一次按住说话要先进房间、再经房间转文字,弱网上可能要十来秒;验收清单:任何等待超过 8 秒要有说明。
import { useEffect, useState } from 'react';

/** 「识别中」挂多久还没回就补一句。 */
export const TRANSCRIBE_SLOW_MS = 8000;
export const TRANSCRIBE_SLOW_TEXT = '网有点慢,还在转文字';

type Props = {
  visible: boolean;
  elapsedMs: number;
  cancelHint: boolean;
  transcribing: boolean;
  /** 0~1 实时音量，驱动声波高度 */
  level?: number;
};

function fmt(ms: number): string {
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${(total % 60).toString().padStart(2, '0')}`;
}

const BARS = 9;

export function VoiceRecordOverlay({ visible, elapsedMs, cancelHint, transcribing, level = 0 }: Props) {
  // 「识别中」挂久了补一句(见文件头 2026-09-25 那段)。钩子放在最前面:下面有提前返回。
  const [slow, setSlow] = useState(false);
  const waiting = visible && transcribing;
  useEffect(() => {
    setSlow(false);
    if (!waiting) return;
    const timer = setTimeout(() => setSlow(true), TRANSCRIBE_SLOW_MS);
    return () => clearTimeout(timer);
  }, [waiting]);

  if (!visible) return null;

  if (transcribing) {
    return (
      <div className="ba-voice-record-overlay" aria-live="polite">
        {/* 包一层 panel(与录音那一屏同一个排法):补的那句排在气泡正下方,不被外层的网格拉到半屏去。 */}
        <div className="ba-voice-record-panel">
          <div className="ba-voice-record-bubble is-transcribing">
            <div className="ba-voice-record-spinner" aria-hidden />
            <span className="ba-voice-record-bubble-text">识别中<span className="ba-voice-record-dots"><i>.</i><i>.</i><i>.</i></span></span>
          </div>
          {slow && <div className="ba-voice-record-hint">{TRANSCRIBE_SLOW_TEXT}</div>}
        </div>
      </div>
    );
  }

  return (
    <div className="ba-voice-record-overlay" aria-live="polite">
      <div className="ba-voice-record-panel">
        <div className={`ba-voice-record-bubble${cancelHint ? ' is-cancel' : ''}`}>
          {cancelHint ? (
            <span className="ba-voice-record-cancel-icon" aria-hidden>✕</span>
          ) : (
            <div className="ba-voice-record-wave" aria-hidden>
              {Array.from({ length: BARS }).map((_, i) => {
                // 中间高两侧低 + 实时音量驱动
                const center = 1 - Math.abs(i - (BARS - 1) / 2) / ((BARS - 1) / 2);
                const h = 18 + Math.min(1, level) * (24 + center * 26);
                return <i key={i} style={{ height: `${h}px`, animationDelay: `${i * 70}ms` }} />;
              })}
            </div>
          )}
        </div>
        <div className="ba-voice-record-timer">{fmt(elapsedMs)}</div>
        <div className={`ba-voice-record-hint${cancelHint ? ' is-cancel' : ''}`}>
          {cancelHint ? '松开手指，取消发送' : '手指上滑，取消发送'}
        </div>
      </div>
    </div>
  );
}
