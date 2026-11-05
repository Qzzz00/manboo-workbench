import { Capacitor, registerPlugin } from '@capacitor/core';

/**
 * 屏保中心的 JS 薄封装（原生侧 ScreensaverPlugin.kt）。
 * 所有异步方法在非原生平台/原生异常时回安全默认值，绝不向 UI 抛异常。
 */

export interface ScreensaverState {
  applied: boolean;
  secureGranted: boolean;
  notifAccess: boolean;
  calendarGranted: boolean;
  locationGranted: boolean;
  avatarId: string;
  brightness: number; // 10–100
  fps: number; // 10–60
  server: string;
  city: string;
}

export interface ScreensaverConfigPatch {
  avatarId?: string;
  brightness?: number;
  fps?: number;
  server?: string;
  city?: string;
}

export const DEFAULT_SCREENSAVER_STATE: ScreensaverState = {
  applied: false,
  secureGranted: false,
  notifAccess: false,
  calendarGranted: false,
  locationGranted: false,
  avatarId: '',
  brightness: 45,
  fps: 15,
  server: '',
  city: '',
};

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** 原生返回的松散对象 → 结构化状态（缺键/脏类型回默认，数值夹取值域）。纯函数。 */
export function normalizeScreensaverState(raw: unknown): ScreensaverState {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const bool = (v: unknown) => v === true;
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const num = (v: unknown, dflt: number, lo: number, hi: number) =>
    typeof v === 'number' && Number.isFinite(v) ? clamp(Math.round(v), lo, hi) : dflt;
  return {
    applied: bool(r.applied),
    secureGranted: bool(r.secureGranted),
    notifAccess: bool(r.notifAccess),
    calendarGranted: bool(r.calendarGranted),
    locationGranted: bool(r.locationGranted),
    avatarId: str(r.avatarId),
    brightness: num(r.brightness, DEFAULT_SCREENSAVER_STATE.brightness, 10, 100),
    fps: num(r.fps, DEFAULT_SCREENSAVER_STATE.fps, 10, 60),
    server: str(r.server),
    city: str(r.city),
  };
}

interface ScreensaverNativePlugin {
  getState(): Promise<Record<string, unknown>>;
  apply(): Promise<{ applied?: boolean; needManual?: boolean }>;
  openDreamSettings(): Promise<void>;
  setConfig(patch: ScreensaverConfigPatch): Promise<void>;
  requestCalendarPermission(): Promise<Record<string, unknown>>;
  requestLocationPermission(): Promise<Record<string, unknown>>;
  enableNotificationAccess(): Promise<{ method?: string }>;
}

const plugin = registerPlugin<ScreensaverNativePlugin>('Screensaver');

export function isScreensaverSupported(): boolean {
  return Capacitor.isNativePlatform();
}

export async function getScreensaverState(): Promise<ScreensaverState> {
  if (!isScreensaverSupported()) return DEFAULT_SCREENSAVER_STATE;
  try {
    return normalizeScreensaverState(await plugin.getState());
  } catch {
    return DEFAULT_SCREENSAVER_STATE;
  }
}

export async function applyScreensaver(): Promise<{ applied: boolean; needManual: boolean }> {
  if (!isScreensaverSupported()) return { applied: false, needManual: true };
  try {
    const r = await plugin.apply();
    return { applied: r.applied === true, needManual: r.needManual === true };
  } catch {
    return { applied: false, needManual: true };
  }
}

export async function openDreamSettings(): Promise<void> {
  if (!isScreensaverSupported()) return;
  try {
    await plugin.openDreamSettings();
  } catch {
    // 系统页缺失：静默，UI 状态卡仍显示未应用
  }
}

export async function setScreensaverConfig(patch: ScreensaverConfigPatch): Promise<void> {
  if (!isScreensaverSupported()) return;
  try {
    await plugin.setConfig(patch);
  } catch {
    // 防崩
  }
}

export async function requestScreensaverPermission(kind: 'calendar' | 'location'): Promise<void> {
  if (!isScreensaverSupported()) return;
  try {
    if (kind === 'calendar') await plugin.requestCalendarPermission();
    else await plugin.requestLocationPermission();
  } catch {
    // 用户拒绝/系统异常：UI 重新 getState 拿真实状态
  }
}

export async function enableNotificationAccess(): Promise<'secure' | 'settings' | 'none'> {
  if (!isScreensaverSupported()) return 'none';
  try {
    const r = await plugin.enableNotificationAccess();
    return r.method === 'secure' ? 'secure' : 'settings';
  } catch {
    return 'none';
  }
}
