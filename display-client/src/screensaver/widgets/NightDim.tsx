import { useEffect, useState } from 'react';

/**
 * 夜间自动压暗：床头充电场景下，深夜把整屏轻微调暗，护眼 + 减轻 OLED 负担。
 * 白天(7–21点)不压暗；22点起渐强，0–5点最深(~0.3)，6点回落。
 */
function dimForHour(h: number): number {
  if (h >= 7 && h <= 21) return 0;
  if (h === 22) return 0.15;
  if (h === 23) return 0.25;
  if (h >= 0 && h <= 5) return 0.3;
  if (h === 6) return 0.15;
  return 0;
}

export function NightDim() {
  const [dim, setDim] = useState(() => dimForHour(new Date().getHours()));

  useEffect(() => {
    const t = setInterval(() => setDim(dimForHour(new Date().getHours())), 5 * 60 * 1000);
    return () => clearInterval(t);
  }, []);

  if (dim <= 0) return null;
  return <div className="ss-nightdim" style={{ opacity: dim }} />;
}
