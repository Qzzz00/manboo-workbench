// 顶部状态栏（Figma 版式）：Wi-Fi/蓝牙图标 + 居中真实时间 + 电量。纯展示，pointer-events:none。
import { useEffect, useState } from 'react';

function fmtClock(d: Date): string {
  const h = d.getHours();
  const m = d.getMinutes();
  return `${h}:${String(m).padStart(2, '0')}`;
}

export function RadioStatusBar() {
  const [now, setNow] = useState(() => new Date());
  const [pct, setPct] = useState<number | null>(null);
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 20000);
    return () => window.clearInterval(t);
  }, []);
  useEffect(() => {
    // 真实电量（支持则显示，不支持静默保持满格）。
    const nav = navigator as unknown as { getBattery?: () => Promise<{ level: number; addEventListener: (e: string, cb: () => void) => void }> };
    if (!nav.getBattery) return;
    let stale = false;
    nav.getBattery().then((b) => {
      if (stale) return;
      const sync = () => setPct(Math.round(b.level * 100));
      sync();
      b.addEventListener('levelchange', sync);
    }).catch(() => {});
    return () => { stale = true; };
  }, []);
  const level = pct == null ? 100 : pct;
  return (
    <div className="radio-statusbar">
      <div className="radio-sb-left">
        <img src="/radio/sb-wifi.svg" alt="" width={40} height={40} />
        <img src="/radio/sb-bt.svg" alt="" width={40} height={40} />
      </div>
      <div className="radio-sb-time">{fmtClock(now)}</div>
      <div className="radio-sb-right">
        <span className="radio-sb-pct">{level}%</span>
        <span className="radio-sb-batt"><i style={{ width: `${level}%` }} /></span>
      </div>
    </div>
  );
}
