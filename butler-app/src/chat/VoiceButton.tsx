/**
 * 按住说话(独立的一颗键)。松手 → 16k WAV → POST /asr → 文字交给 onText;上滑松手取消。
 * 录音 hook 与浮层是 Aiboo 的(src/aiboo/);手势判读 2026-09-17 抽到 useHoldToTalk,与首页输入框共用一套,
 * **这颗键的样子与文案一个字没改**——引导页还在用它。首页 2026-09-24 起是输入框里那颗麦克风键
 * (composer/PhoneComposer.tsx,同一个 useHoldToTalk;它上面「麦克风还没打开就松手」「同一个错只说一次」那两条修正这里一并受益)。
 */
import { useCallback, type PointerEvent as ReactPointerEvent } from 'react';
import { VoiceRecordOverlay } from '../aiboo/VoiceRecordOverlay';
import { useHoldToTalk } from './useHoldToTalk';
import type { AsrResult } from '../api/voice';

interface Props {
  disabled?: boolean;
  disabledNote?: string;
  transcribe(wav: Blob): Promise<AsrResult>;
  onText(text: string): void;
  onError(text: string): void;
  onLevel?(level: number): void;
}

export function VoiceButton({ disabled = false, disabledNote, transcribe, onText, onError, onLevel }: Props) {
  const hold = useHoldToTalk({ transcribe, onText, onError, onLevel });

  const onDown = useCallback((e: ReactPointerEvent<HTMLButtonElement>) => {
    if (disabled) return;
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* 有的 WebView 不认这个 pointerId;捕获不到照样能录 */ }
    hold.begin(e.clientY);
  }, [disabled, hold]);

  return (
    <>
      <button
        type="button"
        className="ba-mic"
        data-recording={hold.recording}
        disabled={disabled}
        title={disabled ? disabledNote : '按住说话'}
        onPointerDown={onDown}
        onPointerMove={(e) => hold.move(e.clientY)}
        onPointerUp={() => { void hold.end(); }}
        onPointerCancel={() => hold.abort()}
        onContextMenu={(e) => e.preventDefault()}
        aria-label={disabled ? (disabledNote ?? '语音不可用') : '按住说话'}
      >
        {hold.recording ? '松开发送' : '按住说话'}
      </button>
      <VoiceRecordOverlay
        visible={hold.recording || hold.transcribing}
        elapsedMs={hold.elapsedMs}
        cancelHint={hold.cancelHint}
        transcribing={hold.transcribing}
        level={hold.level}
      />
    </>
  );
}
