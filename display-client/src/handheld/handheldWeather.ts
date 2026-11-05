// 掌机桌面天气：城市按**当前位置**取，不用写死的默认城市（Ben 要求）。
//
// 掌机没有屏保那条 JSI 定位桥（那是 DreamService 专属），系统 Geocoder 也不稳，
// 所以走 IP 定位——真机实测 ip-api.com 直接返回「深圳」+ 经纬度（该机在深圳）。
// 拿到经纬度后交给 open-meteo 取实时天气（与屏保 WeatherWidget 同一数据源）。
//
// 纯解析函数单独导出可测；真正的 fetch 编排不单测（只是把解析串起来）。

import { weatherCodeToCondition } from '../screensaver/lib/weatherCode.ts';

export type IpLocation = { lat: number; lon: number; city: string };
export type HandheldWeatherData = { tempC: number | null; condition: string; icon: string; city: string };

/** ip-api.com 响应 → 位置。中文城市名 + 坐标一次拿全。失败/字段缺 → null。 */
export function parseIpApi(d: unknown): IpLocation | null {
  const o = d as Record<string, unknown> | null;
  if (!o || o.status !== 'success') return null;
  if (typeof o.lat !== 'number' || typeof o.lon !== 'number') return null;
  const city = (typeof o.city === 'string' && o.city) || (typeof o.regionName === 'string' && o.regionName) || '本地';
  return { lat: o.lat, lon: o.lon, city: String(city) };
}

/** ipwho.is 响应 → 位置（https 回落源；城市名是英文，能用）。 */
export function parseIpWhois(d: unknown): IpLocation | null {
  const o = d as Record<string, unknown> | null;
  if (!o || o.success !== true) return null;
  if (typeof o.latitude !== 'number' || typeof o.longitude !== 'number') return null;
  return { lat: o.latitude, lon: o.longitude, city: String((typeof o.city === 'string' && o.city) || '本地') };
}

/** open-meteo 响应 + 已知城市名 → 展示数据。 */
export function parseOpenMeteo(d: unknown, city: string): HandheldWeatherData | null {
  const cur = (d as Record<string, unknown> | null)?.current as Record<string, unknown> | undefined;
  if (!cur) return null;
  const cond = weatherCodeToCondition(Number(cur.weather_code));
  return {
    tempC: typeof cur.temperature_2m === 'number' ? Math.round(cur.temperature_2m) : null,
    condition: cond.zh,
    icon: cond.icon,
    city,
  };
}

/** IP 定位：ip-api（中文城市）优先，回落 ipwho.is（https）。都失败 → null（不显示天气，绝不回落写死城市）。 */
async function fetchIpLocation(): Promise<IpLocation | null> {
  try {
    const r = await fetch('http://ip-api.com/json/?lang=zh-CN&fields=status,city,regionName,lat,lon');
    if (r.ok) {
      const p = parseIpApi(await r.json());
      if (p) return p;
    }
  } catch {
    /* 下一个源 */
  }
  try {
    const r = await fetch('https://ipwho.is/?fields=success,city,latitude,longitude');
    if (r.ok) {
      const p = parseIpWhois(await r.json());
      if (p) return p;
    }
  } catch {
    /* 没网就没网 */
  }
  return null;
}

/** 取当前位置的天气。任一环节失败 → null（调用方不渲染，桌面上不留空壳/错误默认）。 */
export async function fetchHandheldWeather(): Promise<HandheldWeatherData | null> {
  const loc = await fetchIpLocation();
  if (!loc) return null;
  try {
    const r = await fetch(
      `https://api.open-meteo.com/v1/forecast?current=temperature_2m,weather_code&latitude=${loc.lat}&longitude=${loc.lon}`,
    );
    if (!r.ok) return null;
    return parseOpenMeteo(await r.json(), loc.city);
  } catch {
    return null;
  }
}
