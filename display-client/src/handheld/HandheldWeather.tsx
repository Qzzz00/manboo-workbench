import { useEffect, useState } from 'react';

import { fetchHandheldWeather, type HandheldWeatherData } from './handheldWeather.ts';

const REFRESH_MS = 10 * 60 * 1000;

/** 时间日期下方一行天气：图标 · 温度 · 状况 · 城市（城市按 IP 定位取）。取不到就整行不渲染。 */
export function HandheldWeather() {
  const [w, setW] = useState<HandheldWeatherData | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => {
      fetchHandheldWeather()
        .then((r) => {
          if (alive && r) setW(r);
        })
        .catch(() => {});
    };
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  if (!w) return null;

  return (
    <div className="hh-weather-row">
      <span className="hh-weather-icon">{w.icon}</span>
      <span className="hh-weather-temp">{w.tempC != null ? `${w.tempC}°` : '--'}</span>
      <span className="hh-weather-cond">{w.condition}</span>
      <span className="hh-weather-city">{w.city}</span>
    </div>
  );
}
