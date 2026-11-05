import { useEffect, useState } from 'react';

import { getCalendarEvents, type CalendarEvent } from '../lib/nativeBridge';

const REFRESH_MS = 60_000;

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

export function CalendarWidget() {
  const [events, setEvents] = useState<CalendarEvent[]>([]);

  useEffect(() => {
    const load = () => setEvents(getCalendarEvents());
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => clearInterval(t);
  }, []);

  const now = Date.now();
  const upcoming = events
    .filter((e) => e.end >= now)
    .sort((a, b) => a.begin - b.begin)
    .slice(0, 3);

  if (upcoming.length === 0) return null;

  return (
    <div className="ss-card">
      <div className="ss-card-title">📅 日程</div>
      {upcoming.map((e, i) => (
        <div className="ss-cal-item" key={`${e.begin}-${i}`}>
          <span className="ss-cal-time">{e.allDay ? '全天' : fmtTime(e.begin)}</span>
          <span className="ss-cal-title">{e.title}</span>
        </div>
      ))}
    </div>
  );
}
