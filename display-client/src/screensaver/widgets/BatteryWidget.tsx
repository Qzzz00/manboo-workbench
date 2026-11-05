import { useEffect, useState } from 'react';

import { getBatteryLevel, getBatteryCharging, hasNativeBridge } from '../lib/nativeBridge';

/** 电量 + 充电指示（床头充电屏保贴心信息）。原生取真实值；浏览器用 Battery API 回落。 */
export function BatteryWidget() {
  const [level, setLevel] = useState<number | null>(null);
  const [charging, setCharging] = useState(false);

  useEffect(() => {
    if (hasNativeBridge()) {
      const read = () => {
        setLevel(getBatteryLevel());
        setCharging(getBatteryCharging());
      };
      read();
      const t = setInterval(read, 30_000);
      return () => clearInterval(t);
    }
    // 浏览器回落
    const navAny = navigator as unknown as { getBattery?: () => Promise<{ level: number; charging: boolean }> };
    if (navAny.getBattery) {
      navAny.getBattery().then((b) => {
        setLevel(Math.round(b.level * 100));
        setCharging(b.charging);
      });
    } else {
      setLevel(96);
      setCharging(true);
    }
    return undefined;
  }, []);

  if (level == null) return null;

  return (
    <div className="ss-battery">
      {charging && <span className="ss-battery-bolt">⚡</span>}
      {level}%
    </div>
  );
}
