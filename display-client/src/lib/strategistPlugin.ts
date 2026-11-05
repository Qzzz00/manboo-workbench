// 军师原生桥（StrategistPlugin.kt）的 TS 封装。
// 浏览器环境 plugin 为 null，全部安全降级——桌面炸了用户就没地方去了。
import { registerPlugin, Capacitor } from '@capacitor/core';

export interface StrategistNative {
  capabilities(): Promise<{ screenshot: boolean; mic: boolean }>;
  captureScreenshot(opts: { cropBottomPx?: number; maxBytes?: number; delayMs?: number }): Promise<{
    jpegBase64: string;
    widthPx: number;
    heightPx: number;
    bytes: number;
  }>;
  requestMicPermission(): Promise<{ granted: boolean }>;
}

const plugin = Capacitor.isNativePlatform() ? registerPlugin<StrategistNative>('Strategist') : null;

export const strategistNativeAvailable = (): boolean => plugin != null;

export async function strategistCapabilities(): Promise<{ screenshot: boolean; mic: boolean }> {
  if (!plugin) return { screenshot: false, mic: false };
  try {
    return await plugin.capabilities();
  } catch {
    return { screenshot: false, mic: false };
  }
}

export async function captureScreenshot(opts: {
  cropBottomPx?: number;
  maxBytes?: number;
  delayMs?: number;
}): Promise<{ jpegBase64: string; widthPx: number; heightPx: number; bytes: number }> {
  if (!plugin) throw new Error('NO_NATIVE');
  return plugin.captureScreenshot(opts);
}

export async function requestMicPermission(): Promise<boolean> {
  if (!plugin) return false;
  try {
    return (await plugin.requestMicPermission()).granted;
  } catch {
    return false;
  }
}

/** 原生 reject 的 code → 用户看得懂、且**指向下一步动作**的中文。 */
export function classifyCaptureError(code: string): string {
  switch (code) {
    case 'SERVICE_DISABLED':
      return '截屏要先开无障碍：设置 → 无障碍 → Aiboo 按键（重装 App 后会被系统撤销，要再开一次）';
    case 'INTERVAL_TOO_SHORT':
      return '截太快了，等一秒再试';
    case 'NO_NATIVE':
      return '这个功能只在掌机上有';
    default:
      return '截屏失败了，再试一次看看';
  }
}
