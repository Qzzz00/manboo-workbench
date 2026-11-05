import { Capacitor } from '@capacitor/core';
import { getNativeServerBaseUrl, getNativeWeatherCity, getDeviceLocation } from './nativeBridge';
import { getNativeDeviceLocation } from '../../lib/djModeBridge';
import { AIBOO_DEFAULT_BASE_URL } from '../../lib/aibooDefault';

const SERVER_URL_KEY = 'llm-live2d:server-url';
const CITY_KEY = 'llm-live2d:weather-city';

function normalizeBase(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/**
 * 解析后端 base URL，优先级：
 * 1) 原生桥接（DreamService 注入的 SharedPreferences）
 * 2) URL 查询参数 ?server=
 * 3) localStorage（浏览器调试）
 * 4) dev 回落：http://localhost → 本地后端 3456
 * 5) 真机/生产默认：云端后端 your-aiboo-host:3456
 * 仅 SSR/无 window 时返回 ''（屏保据此进入"未连接"降级）。
 */
export function getServerBaseUrl(): string {
  const fromNative = getNativeServerBaseUrl();
  if (fromNative) return normalizeBase(fromNative);

  if (typeof window !== 'undefined') {
    const fromQuery = new URLSearchParams(window.location.search).get('server');
    if (fromQuery) return normalizeBase(fromQuery);

    try {
      const fromLs = localStorage.getItem(SERVER_URL_KEY);
      if (fromLs) return normalizeBase(fromLs);
    } catch {
      /* ignore */
    }

    const { protocol, hostname } = window.location;
    // 原生 App 的 webview 也是 http://localhost，要排除，否则误连手机本机
    if (!Capacitor.isNativePlatform() && protocol === 'http:' && ['localhost', '127.0.0.1'].includes(hostname)) {
      return 'http://localhost:3456';
    }
  }
  // 真机/生产默认：云端后端（构建时可用 VITE_AIBOO_BASE_URL 换，见 lib/aibooDefault.ts）
  return AIBOO_DEFAULT_BASE_URL;
}

/** 天气城市：原生桥接 → ?city= → localStorage → 空（后端用默认城市）。 */
export function getWeatherCity(): string {
  const fromNative = getNativeWeatherCity();
  if (fromNative) return fromNative.trim();

  if (typeof window !== 'undefined') {
    const fromQuery = new URLSearchParams(window.location.search).get('city');
    if (fromQuery) return fromQuery.trim();
    try {
      const fromLs = localStorage.getItem(CITY_KEY);
      if (fromLs) return fromLs.trim();
    } catch {
      /* ignore */
    }
  }
  return '';
}

let cachedDjCity: string | null = null;

/**
 * 解析设备所在城市名（与屏保 WeatherWidget 同一套来源），供 DJ 口播关联本地天气：
 * 设备定位 city → 经纬度反查(BigDataCloud) → getWeatherCity() 兜底。结果按会话缓存。
 */
export async function resolveDeviceCity(): Promise<string> {
  if (cachedDjCity) return cachedDjCity;
  // 1) 屏保上下文：AibooNative 同步桥；2) 主 App：Capacitor DjState 插件（异步）
  const loc = getDeviceLocation() ?? (await getNativeDeviceLocation().catch(() => null));
  if (loc?.city) {
    cachedDjCity = loc.city.trim();
    return cachedDjCity;
  }
  if (loc && typeof loc.lat === 'number' && typeof loc.lon === 'number') {
    try {
      const r = await fetch(
        `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${loc.lat}&longitude=${loc.lon}&localityLanguage=zh`,
      );
      if (r.ok) {
        const d = await r.json();
        const c = d.city || d.locality || d.principalSubdivision;
        if (c) {
          cachedDjCity = String(c).trim();
          return cachedDjCity;
        }
      }
    } catch {
      /* 反查失败：回落配置城市 */
    }
  }
  return getWeatherCity();
}
