import { useEffect, useRef, useState } from 'react';
import { useVoiceRecorder } from '../../../hooks/useVoiceRecorder.ts';
import type { VoiceFeedbackValue } from '../types.ts';

type VoiceFeedbackInputProps = {
  value: VoiceFeedbackValue | null;
  onChange: (value: VoiceFeedbackValue | null) => void;
  disabled?: boolean;
};

function formatSeconds(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function VoiceFeedbackInput({ value, onChange, disabled }: VoiceFeedbackInputProps) {
  const { state, startRecording, stopRecording, cancelRecording } = useVoiceRecorder();
  const [fallbackError, setFallbackError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    return () => {
      if (value && value.mimeType.startsWith('audio/')) {
        // Blob URL 由调用方持有，这里不 revoke
      }
    };
  }, [value]);

  const handleStart = () => {
    setFallbackError(null);
    void startRecording();
  };

  const handleStop = () => {
    const result = stopRecording();
    if (result) {
      onChange({
        kind: 'voice',
        blob: result.blob,
        mimeType: result.mimeType,
        durationMs: result.durationMs,
      });
    }
  };

  const handleFile = (file: File | null) => {
    setFallbackError(null);
    if (!file) return;
    if (!file.type.startsWith('audio/')) {
      setFallbackError('请选择音频文件');
      return;
    }
    onChange({
      kind: 'voice',
      blob: file,
      mimeType: file.type,
      durationMs: 0,
    });
  };

  const permissionDenied = state.status === 'error' && state.message.includes('权限');

  return (
    <div className="task-field">
      <span>录音反馈</span>

      {value && (
        <div className="task-voice-result">
          <audio controls src={URL.createObjectURL(value.blob)} className="task-voice-player" />
          <button type="button" className="task-secondary-button" onClick={() => onChange(null)} disabled={disabled}>
            重录
          </button>
        </div>
      )}

      {!value && (
        <>
          <button
            type="button"
            className={`task-media-button ${state.status === 'recording' ? 'task-recording' : ''}`}
            onMouseDown={handleStart}
            onMouseUp={handleStop}
            onMouseLeave={cancelRecording}
            onTouchStart={handleStart}
            onTouchEnd={handleStop}
            disabled={disabled || state.status === 'requesting'}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20">
              <path d="M12 2a3 3 0 0 1 3 3v7a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3z" />
              <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
              <line x1="12" y1="19" x2="12" y2="22" />
            </svg>
            {state.status === 'recording'
              ? `录音中 ${formatSeconds(state.elapsedMs)}`
              : state.status === 'requesting'
                ? '请求权限…'
                : '按住录音'}
          </button>

          {state.status === 'error' && <span className="task-input-error-text">{state.message}</span>}

          {permissionDenied && (
            <div className="task-manual-fallback">
              <span className="task-hint">麦克风权限被拒绝，可选择本地音频文件</span>
              <input
                ref={fileInputRef}
                type="file"
                accept="audio/*"
                className="task-hidden-input"
                onChange={(event) => handleFile(event.target.files?.[0] ?? null)}
                disabled={disabled}
              />
              <button
                type="button"
                className="task-secondary-button"
                onClick={() => fileInputRef.current?.click()}
                disabled={disabled}
              >
                选择音频文件
              </button>
            </div>
          )}
          {fallbackError && <span className="task-input-error-text">{fallbackError}</span>}
        </>
      )}
    </div>
  );
}
