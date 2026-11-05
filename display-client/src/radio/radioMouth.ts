/**
 * TTS 口型音量（onMouthChange 的 0..1 level）→ Live2DStage.mouthSyncOverrides。
 * 低于阈值视作嘴闭（空数组），既有 setMouthSyncOverrides 通道会把空数组还原为闭嘴、
 * 并自动路由到原生 GL（setNativeMouthParams）与 WebView，无需新原生桥。纯函数可测。
 */
import type { ParameterOverride } from '../features/live2d/avatarManifest.ts';

// 低于此能量视作不说话（避免底噪抖动让嘴微张）。
const MOUTH_OPEN_THRESHOLD = 0.02;

export function mouthOverridesForLevel(level: number): ParameterOverride[] {
  if (!Number.isFinite(level) || level <= MOUTH_OPEN_THRESHOLD) return [];
  const clamped = Math.min(1, Math.max(0, level));
  // 双命名兼容：两只猫(tororo/hijiki)是老 Cubism2 参数名 PARAM_MOUTH_OPEN_Y，两只幽灵是 ParamMouthOpenY。
  // 两个都写——模型上不存在的参数 id 在原生(Cubism 追加空槽)与 Pixi 侧都是安全 no-op。
  return [
    { id: 'ParamMouthOpenY', value: clamped },
    { id: 'PARAM_MOUTH_OPEN_Y', value: clamped },
  ];
}
