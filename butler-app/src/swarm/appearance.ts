/**
 * 手机端的外观来源(2026-09-16,决策记录同日第 1 条):**继承 Mac 的那一份**。
 * 启动 GET /butler/appearance,拿到就 parseTuningPreset + sanitizeParticleSVG 后直接用——数量、大小、
 * 亮度、图标全跟 Mac;拿不到(404 没存过 / 连不上 / 工作台老版本)就用核心默认值,设置里写
 * 「未同步到 Mac 的外观」。本卡不做手机端单独调参。
 * /state.appearance_version 变了就重新拉。
 */
import type { ApiClient } from '../api/client';
import { TUNING_DEFAULTS, parseTuningPreset, sanitizeParticleSVG, type Tuning, type TuningPreset } from './core.js';

export const APPEARANCE_NOT_SYNCED_TEXT = '未同步到 Mac 的外观';
export const APPEARANCE_SYNCED_TEXT = '外观:与 Mac 同步';

export type AppearanceState =
  | { status: 'loading'; preset: TuningPreset }
  | { status: 'synced'; preset: TuningPreset; version: number; icon?: string }
  | { status: 'default'; preset: TuningPreset; note: string };

export function defaultPreset(): TuningPreset {
  return { kind: 'butler-swarm-v4', version: 1, settings: { ...TUNING_DEFAULTS }, svg: '', fill: false };
}

/** 服务端文档 → 本地可用的 preset。形状不对就 null(当没拿到)。 */
export function presetFromDoc(doc: unknown): { preset: TuningPreset; version: number; icon?: string } | null {
  if (typeof doc !== 'object' || doc === null) return null;
  const record = doc as { version?: unknown; preset?: unknown; icon?: unknown };
  if (typeof record.version !== 'number') return null;
  try {
    const preset = parseTuningPreset(JSON.stringify(record.preset));
    if (preset.svg !== '') preset.svg = sanitizeParticleSVG(preset.svg);
    return { preset, version: record.version, ...(typeof record.icon === 'string' && record.icon !== '' ? { icon: record.icon } : {}) };
  } catch {
    return null;
  }
}

export interface AppearanceFeed {
  get(): AppearanceState;
  subscribe(listener: () => void): () => void;
  /** 拉一次;永不抛。 */
  refresh(): Promise<void>;
  /** /state.appearance_version 变了就重新拉。 */
  notice(version: number | undefined): void;
}

export function createAppearanceFeed(client: ApiClient): AppearanceFeed {
  let state: AppearanceState = { status: 'loading', preset: defaultPreset() };
  const listeners = new Set<() => void>();
  let generation = 0;
  const publish = (next: AppearanceState) => { state = next; listeners.forEach((l) => l()); };

  async function refresh(): Promise<void> {
    const mine = ++generation;
    const r = await client.json<unknown>('/butler/appearance');
    if (mine !== generation) return;
    if (r.ok) {
      const parsed = presetFromDoc(r.data);
      if (parsed !== null) { publish({ status: 'synced', ...parsed }); return; }
    }
    // 404(没存过)/ 连不上 / 老版本工作台 / 形状不对:都退默认值并如实说明。已经同步过的不退。
    if (state.status !== 'synced') publish({ status: 'default', preset: defaultPreset(), note: APPEARANCE_NOT_SYNCED_TEXT });
  }

  return {
    get: () => state,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    refresh,
    notice(version) {
      if (version === undefined) return;
      if (state.status === 'synced' && state.version === version) return;
      void refresh();
    },
  };
}

export function settingsOf(state: AppearanceState): Tuning {
  return state.preset.settings;
}
