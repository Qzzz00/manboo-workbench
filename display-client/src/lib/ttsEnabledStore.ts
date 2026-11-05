const KEY = 'llm-live2d:tts-enabled';

export function loadTtsEnabled(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw === null ? true : raw === 'true';
  } catch {
    return true;
  }
}

export function saveTtsEnabled(enabled: boolean) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(KEY, String(enabled));
  } catch {
    // ignore
  }
}
