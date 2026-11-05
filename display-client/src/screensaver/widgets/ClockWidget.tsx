import { useEffect, useState } from 'react';

export function ClockWidget() {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const showColon = now.getSeconds() % 2 === 0;
  const dateStr = now.toLocaleDateString('zh-CN', {
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  });

  return (
    <div className="ss-clock">
      <div className="ss-clock-time">
        {hh}
        <span className={`ss-colon${showColon ? '' : ' ss-colon-dim'}`}>:</span>
        {mm}
      </div>
      <div className="ss-clock-date">{dateStr}</div>
    </div>
  );
}
