import { useCallback, useEffect, useRef, useState } from 'react';

let globalAudio: HTMLAudioElement | null = null;
let globalCallback: ((id: string | null) => void) | null = null;

function setGlobalAudio(audio: HTMLAudioElement | null, playingId: string | null) {
  globalAudio = audio;
  globalCallback?.(playingId);
}

type AudioPlayerState = {
  playingId: string | null;
  isPlaying: boolean;
  error: string | null;
};

export function useAudioPlayer() {
  const [state, setState] = useState<AudioPlayerState>({ playingId: null, isPlaying: false, error: null });
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    globalCallback = (playingId) => {
      setState((prev) => ({ ...prev, playingId, isPlaying: !!playingId, error: null }));
    };
    return () => {
      globalCallback = null;
    };
  }, []);

  const showError = useCallback((message: string) => {
    setState((prev) => ({ ...prev, error: message }));
    if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    errorTimerRef.current = setTimeout(() => {
      setState((prev) => ({ ...prev, error: null }));
    }, 3000);
  }, []);

  const togglePlay = useCallback((messageId: string, url: string) => {
    if (globalAudio) {
      const wasPlayingSame = globalAudio.dataset.messageId === messageId;
      globalAudio.pause();
      globalAudio.src = '';
      setGlobalAudio(null, null);
      if (wasPlayingSame) return;
    }

    const audio = new Audio(url);
    audio.dataset.messageId = messageId;
    audio.preload = 'auto';

    audio.addEventListener('ended', () => {
      if (globalAudio === audio) {
        setGlobalAudio(null, null);
      }
    });

    audio.addEventListener('error', () => {
      if (globalAudio === audio) {
        setGlobalAudio(null, null);
      }
    });

    audio.play().catch((err) => {
      showError('播放失败: ' + (err instanceof Error ? err.message : '未知错误'));
      if (globalAudio === audio) {
        setGlobalAudio(null, null);
      }
    });

    setGlobalAudio(audio, messageId);
  }, [showError]);

  const stopAll = useCallback(() => {
    if (globalAudio) {
      globalAudio.pause();
      globalAudio.src = '';
      setGlobalAudio(null, null);
    }
  }, []);

  useEffect(() => {
    return () => {
      if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    };
  }, []);

  return { ...state, togglePlay, stopAll };
}
