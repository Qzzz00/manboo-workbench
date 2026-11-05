import { useEffect, useState } from 'react';

import { getNotifications, type NotificationItem } from '../lib/nativeBridge';

const REFRESH_MS = 5_000;

function fmtAgo(ms: number): string {
  const diff = Date.now() - ms;
  const m = Math.floor(diff / 60_000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m}分钟前`;
  const h = Math.floor(m / 60);
  return `${h}小时前`;
}

export function NotificationsWidget() {
  const [items, setItems] = useState<NotificationItem[]>([]);

  useEffect(() => {
    const load = () => setItems(getNotifications());
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => clearInterval(t);
  }, []);

  const latest = items.sort((a, b) => b.postTime - a.postTime).slice(0, 3);
  if (latest.length === 0) return null;

  return (
    <div className="ss-card">
      <div className="ss-card-title">🔔 通知</div>
      {latest.map((n) => (
        <div className="ss-notif-item" key={n.key}>
          <div className="ss-notif-head">
            <span className="ss-notif-app">{n.appLabel || n.title}</span>
            <span className="ss-notif-ago">{fmtAgo(n.postTime)}</span>
          </div>
          <div className="ss-notif-text">{n.title ? `${n.title}：` : ''}{n.text}</div>
        </div>
      ))}
    </div>
  );
}
