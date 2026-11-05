// 来源:Aiboo origin/main 1f430c3f admin-ui/src/features/avatars/defaults.ts
/** 新建角色默认值，对齐 ALL-143 §3.2 “新建页默认值”。 */
import type { Persona, Transform } from '@/shared/types';

export function defaultPersona(): Persona {
  return { tone: '', traits: [], styleRules: [] };
}

export function defaultTransform(): Transform {
  return {
    scaleMultiplier: 0.27,
    verticalOffset: 0.08,
    modelTransform: { scale: 8, offsetX: 0, offsetY: 1.3 },
    transformDefaults: { scale: 1, offsetX: 0, offsetY: 0 },
  };
}

/**
 * DashScope qwen3-tts 常用音色（datalist 候选，允许自定义输入未列出的音色）。
 * 项目全局默认为 Bunny；角色「音色」留空即回退该默认。
 */
export const QWEN_TTS_VOICES = [
  'Bunny',
  'Cherry',
  'Ethan',
  'Serena',
  'Chelsie',
  'Dylan',
  'Jada',
  'Sunny',
] as const;
