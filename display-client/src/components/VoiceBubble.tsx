import { useMemo } from 'react';

export type VoiceBubbleProps = {
  messageId: string;
  durationMs: number;
  isPlaying: boolean;
  isMine: boolean;
  onToggle: () => void;
};

function formatDuration(ms: number) {
  const seconds = Math.ceil(ms / 1000);
  return `${seconds}″`;
}

function calcWidth(ms: number) {
  const seconds = ms / 1000;
  const minW = 72;
  const maxW = 240;
  return Math.min(maxW, Math.max(minW, minW + (seconds / 20) * (maxW - minW)));
}

export function VoiceBubble({ messageId, durationMs, isPlaying, isMine, onToggle }: VoiceBubbleProps) {
  const width = useMemo(() => calcWidth(durationMs), [durationMs]);
  const durationText = useMemo(() => formatDuration(durationMs), [durationMs]);

  return (
    <button
      type="button"
      className={`voice-bubble ${isMine ? 'voice-bubble-mine' : ''} ${isPlaying ? 'voice-bubble-playing' : ''}`}
      style={{ width: `${width}px` }}
      onClick={onToggle}
      aria-label={isPlaying ? '停止播放' : '播放语音'}
      data-message-id={messageId}
    >
      <span className="voice-bubble-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
          {isPlaying && (
            <>
              <path d="M15.54 8.46a5 5 0 0 1 0 7.07" className="voice-wave voice-wave-1" />
              <path d="M19.07 4.93a10 10 0 0 1 0 14.14" className="voice-wave voice-wave-2" />
            </>
          )}
        </svg>
      </span>
      <span className="voice-bubble-text">{durationText}</span>
    </button>
  );
}
