// TTS 结束时间估算器。
// 订阅全局 TTS 状态，在语音开播时记录预估结束时刻；'playing' → 'idle' 转换时立即清 pending。

import { getTtsState, subscribeTtsState } from '../../../lib/tts.ts';

export interface TtsEndTracker {
  /**
   * 语音开播时调用。
   * @param durationMs 本次语音估算时长（ms）。传 0 或负值会被视为无有效时长。
   * @param startAtMs 起始时刻，默认 performance.now()。
   */
  noteUpcomingSpeech(durationMs: number, startAtMs?: number): void;
  /**
   * 若当前正在播语音且剩余时间 > 0，返回估算结束时刻（ms）；否则返回 null。
   */
  getExpectedTtsEndMs(now?: number): number | null;
  /** 取消 TTS 状态订阅。 */
  dispose(): void;
}

export function initTtsEndTracker(): TtsEndTracker {
  let pendingEndMs: number | null = null;

  const unsubscribe = subscribeTtsState((state) => {
    if (state !== 'playing') {
      pendingEndMs = null;
    }
  });

  return {
    noteUpcomingSpeech(durationMs: number, startAtMs = performance.now()) {
      if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs <= 0) {
        pendingEndMs = null;
        return;
      }
      pendingEndMs = startAtMs + durationMs;
    },
    getExpectedTtsEndMs(now = performance.now()): number | null {
      if (getTtsState() !== 'playing') return null;
      if (pendingEndMs === null) return null;
      const remaining = pendingEndMs - now;
      return remaining > 0 ? pendingEndMs : null;
    },
    dispose() {
      unsubscribe();
      pendingEndMs = null;
    },
  };
}
