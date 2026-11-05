import { useCallback, useEffect, useRef, useState } from 'react';

export type UseSentenceRevealOptions = {
  /** 每句基础停留毫秒 */
  baseDelay?: number;
  /** 每个字符额外停留毫秒 */
  charDelay?: number;
  /** 是否自动开始；false 时调用 start() 开始 */
  autoStart?: boolean;
  /** 全部揭示完成回调 */
  onComplete?: () => void;
};

export type UseSentenceRevealResult = {
  /** 当前已揭示的句子数（从 1 开始） */
  visibleCount: number;
  /** 是否已全部揭示 */
  isComplete: boolean;
  /** 手动进入下一句（自动播放到最后时也可用于加速） */
  advance: () => void;
  /** 重新开始 */
  restart: () => void;
  /** 手动开始（autoStart=false 时有效） */
  start: () => void;
};

function sentenceDelay(sentence: string, baseDelay: number, charDelay: number): number {
  return Math.min(5000, Math.max(1200, baseDelay + sentence.length * charDelay));
}

export function useSentenceReveal(
  sentences: string[],
  options: UseSentenceRevealOptions = {},
): UseSentenceRevealResult {
  const { baseDelay = 1200, charDelay = 90, autoStart = true, onComplete } = options;
  const [visibleCount, setVisibleCount] = useState(0);
  const [started, setStarted] = useState(autoStart);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  const clearTimers = useCallback(() => {
    for (const timer of timersRef.current) {
      clearTimeout(timer);
    }
    timersRef.current = [];
  }, []);

  const schedule = useCallback(() => {
    clearTimers();
    if (sentences.length === 0 || !started) return;

    let accumulator = 0;
    for (let index = 0; index < sentences.length; index += 1) {
      accumulator += sentenceDelay(sentences[index] ?? '', baseDelay, charDelay);
      const timer = setTimeout(() => {
        setVisibleCount(index + 1);
        if (index === sentences.length - 1) {
          onComplete?.();
        }
      }, accumulator);
      timersRef.current.push(timer);
    }
  }, [sentences, baseDelay, charDelay, started, onComplete, clearTimers]);

  useEffect(() => {
    schedule();
    return clearTimers;
  }, [schedule, clearTimers]);

  const advance = useCallback(() => {
    setVisibleCount((current) => {
      if (current >= sentences.length) return current;
      const next = current + 1;
      if (next === sentences.length) {
        onComplete?.();
      }
      return next;
    });
  }, [sentences.length, onComplete]);

  const restart = useCallback(() => {
    setVisibleCount(0);
    schedule();
  }, [schedule]);

  const start = useCallback(() => {
    if (started) return;
    setStarted(true);
  }, [started]);

  return {
    visibleCount,
    isComplete: visibleCount >= sentences.length && sentences.length > 0,
    advance,
    restart,
    start,
  };
}
