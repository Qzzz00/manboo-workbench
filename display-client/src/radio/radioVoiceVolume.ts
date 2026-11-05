/**
 * 叫声音量的持久化（0..1）。
 *
 * ★为什么要独立于系统/音乐音量：叫声和音乐是两条完全独立的输出——音乐走原生 media3、
 * 音量受播放器与系统媒体音量控制；叫声走 WebView 里的 Web Audio，永远是素材本身的响度。
 * Ben 实测「音乐声音已经很小了，但它的叫声依然很大」正是这个原因，调系统音量没法把两者分开，
 * 所以必须给叫声一个自己的音量旋钮（设置页滑块）。
 */

const STORAGE_KEY = 'aiboo:radio-voice-volume';

/** 默认 0.45：Ben 反馈默认太吵。宁可偏小——嫌小可以调大，一进门就被吼一声体验很差。 */
export const DEFAULT_VOICE_VOLUME = 0.45;

const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : DEFAULT_VOICE_VOLUME);

export function loadVoiceVolume(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw == null) return DEFAULT_VOICE_VOLUME;
    const n = Number(raw);
    return Number.isFinite(n) ? clamp01(n) : DEFAULT_VOICE_VOLUME;
  } catch {
    return DEFAULT_VOICE_VOLUME; // 隐私模式/存储不可用
  }
}

export function saveVoiceVolume(v: number): void {
  try { localStorage.setItem(STORAGE_KEY, String(clamp01(v))); } catch { /* 存不了不影响本次会话 */ }
}
