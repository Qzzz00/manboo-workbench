import { Capacitor, registerPlugin } from '@capacitor/core';

/**
 * 桌面组件插件 JS 薄封装（原生侧 WidgetPlugin.kt）。
 * 非原生平台/原生异常一律回安全默认值，不向 UI 抛异常。
 */

export interface WidgetLoop {
  key: string;
  frames: number;
  fps: number;
}

export interface WidgetState {
  added: boolean;
  avatarId: string;
  activeLoop: string;
  loops: WidgetLoop[];
}

export const DEFAULT_WIDGET_STATE: WidgetState = {
  added: false,
  avatarId: '',
  activeLoop: '',
  loops: [],
};

/** 原生松散对象 → 结构化状态；loops 逐项校验，非法项丢弃。纯函数。 */
export function normalizeWidgetState(raw: unknown): WidgetState {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const loopsRaw = Array.isArray(r.loops) ? r.loops : [];
  const loops: WidgetLoop[] = [];
  for (const item of loopsRaw) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const key = str(o.key);
    if (!key) continue;
    if (typeof o.frames !== 'number' || o.frames <= 0) continue;
    loops.push({ key, frames: o.frames, fps: typeof o.fps === 'number' && o.fps > 0 ? o.fps : 12 });
  }
  return {
    added: r.added === true,
    avatarId: str(r.avatarId),
    activeLoop: str(r.activeLoop),
    loops,
  };
}

interface WidgetNativePlugin {
  getState(): Promise<Record<string, unknown>>;
  saveFrames(p: { avatarId: string; loopKey: string; fps: number; frames: string[] }): Promise<{ saved?: number }>;
  setActiveLoop(p: { avatarId: string; loopKey: string }): Promise<void>;
  requestPin(): Promise<{ requested?: boolean }>;
  refresh(): Promise<void>;
}

const plugin = registerPlugin<WidgetNativePlugin>('Widget');

function native(): boolean {
  return Capacitor.isNativePlatform();
}

export async function getWidgetState(): Promise<WidgetState> {
  if (!native()) return DEFAULT_WIDGET_STATE;
  try {
    return normalizeWidgetState(await plugin.getState());
  } catch {
    return DEFAULT_WIDGET_STATE;
  }
}

/** 写一环帧，返回实际落盘帧数（0=失败/非原生）。 */
export async function saveWidgetFrames(p: {
  avatarId: string;
  loopKey: string;
  fps: number;
  frames: string[];
}): Promise<number> {
  if (!native()) return 0;
  try {
    const r = await plugin.saveFrames(p);
    return typeof r.saved === 'number' ? r.saved : 0;
  } catch {
    return 0;
  }
}

export async function setActiveWidgetLoop(avatarId: string, loopKey: string): Promise<void> {
  if (!native()) return;
  try {
    await plugin.setActiveLoop({ avatarId, loopKey });
  } catch {
    // 防崩
  }
}

/** 一键添加到桌面；false=launcher 不支持 pin（UI 提示手动长按添加）。 */
export async function requestWidgetPin(): Promise<boolean> {
  if (!native()) return false;
  try {
    const r = await plugin.requestPin();
    return r.requested === true;
  } catch {
    return false;
  }
}
