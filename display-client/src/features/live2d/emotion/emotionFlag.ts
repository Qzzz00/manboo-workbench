const KEY = 'aiboo:soullink-emotion';
export function isSoullinkEmotionEnabled(): boolean {
  try { return localStorage.getItem(KEY) === '1'; } catch { return false; }
}
export function setSoullinkEmotionEnabled(on: boolean): void {
  try { localStorage.setItem(KEY, on ? '1' : '0'); } catch { /* no-op */ }
}
