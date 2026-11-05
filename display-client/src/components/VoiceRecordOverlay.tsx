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
  if (!visible) return null;

  if (transcribing) {
    return (
      <div className="voice-record-overlay" aria-live="polite">
        <div className="voice-record-bubble is-transcribing">
          <div className="voice-record-spinner" aria-hidden />
          <span className="voice-record-bubble-text">识别中<span className="voice-record-dots"><i>.</i><i>.</i><i>.</i></span></span>
        </div>
      </div>
    );
  }

  return (
    <div className="voice-record-overlay" aria-live="polite">
      <div className="voice-record-panel">
        <div className={`voice-record-bubble${cancelHint ? ' is-cancel' : ''}`}>
          {cancelHint ? (
            <span className="voice-record-cancel-icon" aria-hidden>✕</span>
          ) : (
            <div className="voice-record-wave" aria-hidden>
              {Array.from({ length: BARS }).map((_, i) => {
                // 中间高两侧低 + 实时音量驱动
                const center = 1 - Math.abs(i - (BARS - 1) / 2) / ((BARS - 1) / 2);
                const h = 18 + Math.min(1, level) * (24 + center * 26);
                return <i key={i} style={{ height: `${h}px`, animationDelay: `${i * 70}ms` }} />;
              })}
            </div>
          )}
        </div>
        <div className="voice-record-timer">{fmt(elapsedMs)}</div>
        <div className={`voice-record-hint${cancelHint ? ' is-cancel' : ''}`}>
          {cancelHint ? '松开手指，取消发送' : '手指上滑，取消发送'}
        </div>
      </div>
    </div>
  );
}
