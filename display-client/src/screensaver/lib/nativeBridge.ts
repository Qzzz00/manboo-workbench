/**
 * 原生桥接抽象。
 *
 * 屏保运行在 DreamService 的 raw WebView（file:// 源），通过
 * `window.AibooNative`（Android @JavascriptInterface 注入）拿到日历/通知/电量/
 * 服务器地址/城市。所有原生方法都是同步的、返回基本类型或 JSON 字符串。
 *
 * 在普通浏览器（dev 预览）里 window.AibooNative 不存在 → 回落到 mock 数据，
 * 方便不接真机也能验证 UI。
 */

export type CalendarEvent = {
  title: string;
  begin: number; // epoch ms
  end: number; // epoch ms
  location?: string;
  allDay?: boolean;
};

export type NotificationItem = {
  key: string;
  pkg: string;
  appLabel?: string;
  title: string;
  text: string;
  postTime: number; // epoch ms
};

interface AibooNativeBridge {
  getServerBaseUrl?(): string;
  getWeatherCity?(): string;
  getScreensaverFps?(): number;
  getCalendarEventsJson?(): string;
  getNotificationsJson?(): string;
  getLocationJson?(): string;
  getBatteryLevel?(): number;
  isCharging?(): boolean;
  isNotificationAccessGranted?(): boolean;
  isCalendarGranted?(): boolean;
  isLocationGranted?(): boolean;
  /** 主 App 是否正处于 DJ 模式（带时间戳新鲜度判定，由主 App 写入 SharedPreferences）。 */
  isDjModeActive?(): boolean;
  /** 主 App 当前 DJ 角色 id（未在 DJ 模式则为空串）。 */
  getDjAvatarId?(): string;
  /** 客户端指定的屏保角色 id（未设置为空串）。 */
  getScreensaverAvatarId?(): string;
}

export type DeviceLocation = { lat: number; lon: number; city?: string };

declare global {
  interface Window {
    AibooNative?: AibooNativeBridge;
  }
}

export function hasNativeBridge(): boolean {
  return typeof window !== 'undefined' && !!window.AibooNative;
}

function safeCall<T>(fn: (() => T) | undefined, fallback: T): T {
  if (!fn) return fallback;
  try {
    const v = fn();
    return v === undefined || v === null ? fallback : v;
  } catch {
    return fallback;
  }
}

function parseArray<T>(raw: string): T[] {
  try {
    const v = JSON.parse(raw || '[]');
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}

export function getNativeServerBaseUrl(): string {
  return safeCall(window.AibooNative?.getServerBaseUrl?.bind(window.AibooNative), '');
}

export function getNativeWeatherCity(): string {
  return safeCall(window.AibooNative?.getWeatherCity?.bind(window.AibooNative), '');
}

/** 屏保刷新率(fps)，用户在屏保设置页配置；无原生桥/未设返回 0（调用方回落默认）。 */
export function getNativeScreensaverFps(): number {
  const v = safeCall(window.AibooNative?.getScreensaverFps?.bind(window.AibooNative), 0);
  return typeof v === 'number' && v > 0 ? v : 0;
}

export function getBatteryLevel(): number | null {
  if (!window.AibooNative?.getBatteryLevel) return null;
  const v = safeCall(window.AibooNative.getBatteryLevel.bind(window.AibooNative), -1);
  return v >= 0 ? v : null;
}

export function getBatteryCharging(): boolean {
  return safeCall(window.AibooNative?.isCharging?.bind(window.AibooNative), false);
}

/** 主 App 是否正处于 DJ 模式（无原生桥返回 false，由调用方回落处理）。 */
export function getNativeDjModeActive(): boolean {
  return safeCall(window.AibooNative?.isDjModeActive?.bind(window.AibooNative), false);
}

/** 主 App 当前 DJ 角色 id（无原生桥/未在 DJ 模式返回空串）。 */
export function getNativeDjAvatarId(): string {
  return safeCall(window.AibooNative?.getDjAvatarId?.bind(window.AibooNative), '');
}

/** 客户端指定的屏保角色 id（无原生桥/未设置返回空串，调用方回落默认）。 */
export function getNativeScreensaverAvatarId(): string {
  return safeCall(window.AibooNative?.getScreensaverAvatarId?.bind(window.AibooNative), '');
}

export function isNotificationAccessGranted(): boolean {
  return safeCall(
    window.AibooNative?.isNotificationAccessGranted?.bind(window.AibooNative),
    false,
  );
}

/** 设备最近一次已知位置（天气跟随本地）。无原生桥/未授权/取不到返回 null。 */
export function getDeviceLocation(): DeviceLocation | null {
  if (!window.AibooNative?.getLocationJson) return null;
  const raw = safeCall(window.AibooNative.getLocationJson.bind(window.AibooNative), '');
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    if (typeof v.lat === 'number' && typeof v.lon === 'number') {
      return { lat: v.lat, lon: v.lon, city: typeof v.city === 'string' ? v.city : undefined };
    }
  } catch {
    /* ignore */
  }
  return null;
}

export function getCalendarEvents(): CalendarEvent[] {
  if (window.AibooNative?.getCalendarEventsJson) {
    const raw = safeCall(window.AibooNative.getCalendarEventsJson.bind(window.AibooNative), '[]');
    return parseArray<CalendarEvent>(raw);
  }
  return mockCalendar();
}

export function getNotifications(): NotificationItem[] {
  if (window.AibooNative?.getNotificationsJson) {
    const raw = safeCall(window.AibooNative.getNotificationsJson.bind(window.AibooNative), '[]');
    return parseArray<NotificationItem>(raw);
  }
  return mockNotifications();
}

// ---- 浏览器 mock（仅当无原生桥接时使用）----

function mockCalendar(): CalendarEvent[] {
  const now = Date.now();
  const h = 3600_000;
  return [
    { title: '晨会 / Standup', begin: now + 1.5 * h, end: now + 2 * h, location: '会议室 A' },
    { title: '健身 🏃', begin: now + 5 * h, end: now + 6 * h },
    { title: '和朋友吃晚饭', begin: now + 9 * h, end: now + 11 * h, location: '市中心' },
  ];
}

function mockNotifications(): NotificationItem[] {
  const now = Date.now();
  const m = 60_000;
  return [
    { key: 'm1', pkg: 'com.tencent.mm', appLabel: '微信', title: '小明', text: '在吗？晚上一起？', postTime: now - 2 * m },
    { key: 'm2', pkg: 'com.android.email', appLabel: '邮件', title: 'GitHub', text: 'PR #42 已被合并', postTime: now - 18 * m },
    { key: 'm3', pkg: 'com.spotify', appLabel: '系统', title: '提醒', text: '记得喝水 💧', postTime: now - 40 * m },
  ];
}
