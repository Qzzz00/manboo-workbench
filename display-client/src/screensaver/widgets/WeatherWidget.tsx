import { useEffect, useState } from 'react';

import { getServerBaseUrl, getWeatherCity } from '../lib/serverConfig';
import { getDeviceLocation } from '../lib/nativeBridge';
import { weatherCodeToCondition } from '../lib/weatherCode';

type Weather = {
  temp_c: number | null;
  condition: string;
  icon?: string;
  city: string;
};

const REFRESH_MS = 10 * 60 * 1000;

export function WeatherWidget() {
  const [w, setW] = useState<Weather | null>(null);

  useEffect(() => {
    let alive = true;

    async function reverseGeocodeCity(lat: number, lon: number): Promise<string | undefined> {
      // BigDataCloud 客户端反地理编码：免 key、开放 CORS，比 Android Geocoder 更可靠
      try {
        const r = await fetch(
          `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=zh`,
        );
        if (!r.ok) return undefined;
        const d = await r.json();
        return d.city || d.locality || d.principalSubdivision || undefined;
      } catch {
        return undefined;
      }
    }

    async function fromLocation(): Promise<Weather | null> {
      const loc = getDeviceLocation();
      if (!loc) return null;
      try {
        const r = await fetch(
          `https://api.open-meteo.com/v1/forecast?current=temperature_2m,weather_code&latitude=${loc.lat}&longitude=${loc.lon}`,
        );
        if (!r.ok) return null;
        const d = await r.json();
        const cur = d?.current ?? {};
        const cond = weatherCodeToCondition(cur.weather_code);
        const city = loc.city || (await reverseGeocodeCity(loc.lat, loc.lon)) || '本地';
        return {
          temp_c: typeof cur.temperature_2m === 'number' ? Math.round(cur.temperature_2m) : null,
          condition: cond.zh,
          icon: cond.icon,
          city,
        };
      } catch {
        return null;
      }
    }

    async function fromBackend(): Promise<Weather | null> {
      const base = getServerBaseUrl();
      if (!base) return null;
      const city = getWeatherCity();
      const q = city ? `?city=${encodeURIComponent(city)}` : '';
      try {
        const res = await fetch(`${base}/api/weather${q}`);
        if (!res.ok) return null;
        return (await res.json()) as Weather;
      } catch {
        return null;
      }
    }

    async function load() {
      // 优先跟随设备定位（直连 open-meteo），取不到再回落后端配置城市
      const result = (await fromLocation()) ?? (await fromBackend());
      if (alive && result) setW(result);
    }

    load();
    const t = setInterval(load, REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  if (!w) return null;

  return (
    <div className="ss-weather">
      <span className="ss-weather-icon">{w.icon || '🌡️'}</span>
      <span className="ss-weather-temp">{w.temp_c != null ? `${w.temp_c}°` : '--'}</span>
      <span className="ss-weather-meta">
        {w.condition} · {w.city}
      </span>
    </div>
  );
}
