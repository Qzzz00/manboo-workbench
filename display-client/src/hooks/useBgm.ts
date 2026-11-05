import { useCallback, useEffect, useRef, useState } from 'react';

export type UseBgmOptions = {
  /** 初始音量 0~1，默认 0.55 */
  volume?: number;
  /** 是否循环，默认 true */
  loop?: boolean;
  /** 淡入毫秒，默认 1200 */
  fadeInMs?: number;
  /** 淡出毫秒，默认 800 */
  fadeOutMs?: number;
};

export type UseBgmResult = {
  playing: boolean;
  error: string | null;
  /** 手动淡出停止 */
  stop: () => void;
};

function requestFrame(callback: (timestamp: number) => void): number {
  if (typeof requestAnimationFrame === 'function') {
    return requestAnimationFrame(callback);
  }
  return window.setTimeout(
    () => callback(typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()),
    16,
  );
}

function cancelFrame(handle: number): void {
  if (typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(handle);
    return;
  }
  window.clearTimeout(handle);
}

export function useBgm(
  url: string | null | undefined,
  options: UseBgmOptions = {},
): UseBgmResult {
  const { volume = 0.55, loop = true, fadeInMs = 1200, fadeOutMs = 800 } = options;
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const rafRef = useRef<number | null>(null);

  const stopRaf = useCallback(() => {
    if (rafRef.current !== null) {
      cancelFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  const fade = useCallback((
    audio: HTMLAudioElement,
    targetVolume: number,
    durationMs: number,
    onDone?: () => void,
  ) => {
    stopRaf();
    const startVolume = audio.volume;
    const startTime = performance.now ? performance.now() : Date.now();

    function step(now: number) {
      const elapsed = now - startTime;
      const t = Math.min(1, elapsed / durationMs);
      const eased = t * (2 - t); // easeOutQuad
      audio.volume = startVolume + (targetVolume - startVolume) * eased;
      if (t < 1) {
        rafRef.current = requestFrame(step);
      } else {
        rafRef.current = null;
        onDone?.();
      }
    }
    rafRef.current = requestFrame(step);
  }, [stopRaf]);

  const teardown = useCallback((audio: HTMLAudioElement) => {
    stopRaf();
    audio.pause();
    audio.src = '';
    audio.load();
  }, [stopRaf]);

  const stop = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) return;
    fade(audio, 0, fadeOutMs, () => {
      teardown(audio);
      audioRef.current = null;
      setPlaying(false);
    });
  }, [fadeOutMs, fade, teardown]);

  useEffect(() => {
    if (!url || typeof window === 'undefined') {
      if (audioRef.current) {
        teardown(audioRef.current);
        audioRef.current = null;
        setPlaying(false);
      }
      return;
    }

    setError(null);
    const audio = new Audio(url);
    audio.loop = loop;
    audio.volume = 0;
    audioRef.current = audio;

    function handleEnded() {
      if (!loop) {
        setPlaying(false);
      }
    }

    function handleError() {
      setError('配乐加载失败');
      setPlaying(false);
    }

    audio.addEventListener('ended', handleEnded);
    audio.addEventListener('error', handleError);

    audio.play().then(() => {
      setPlaying(true);
      fade(audio, volume, fadeInMs);
    }).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : '配乐播放失败');
      setPlaying(false);
    });

    return () => {
      audio.removeEventListener('ended', handleEnded);
      audio.removeEventListener('error', handleError);
      teardown(audio);
      audioRef.current = null;
      setPlaying(false);
    };
  }, [url, loop, volume, fadeInMs, fade, teardown]);

  useEffect(() => {
    return () => {
      stopRaf();
      const audio = audioRef.current;
      if (audio) {
        teardown(audio);
        audioRef.current = null;
      }
    };
  }, [stopRaf, teardown]);

  return { playing, error, stop };
}
