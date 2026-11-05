import type { JourneyNotification as JourneyNotificationType } from '../types/journey.ts';

interface JourneyNotificationProps {
  notification: JourneyNotificationType;
  onClick?: () => void;
}

export function JourneyNotification({ notification, onClick }: JourneyNotificationProps) {
  const styles: Record<JourneyNotificationType['type'], string> = {
    beat: 'bg-indigo-600 text-white',
    presence: 'bg-slate-100 text-slate-800 border border-slate-200',
    task: 'bg-emerald-50 text-emerald-800 border border-emerald-200',
    farewell: 'bg-rose-100 text-rose-900 border border-rose-200',
    silence: 'bg-transparent text-slate-400 opacity-60',
  };

  const labels: Record<JourneyNotificationType['type'], string> = {
    beat: '剧情节拍',
    presence: '她在想你',
    task: '任务',
    farewell: '告别准备',
    silence: '沉默期',
  };

  return (
    <div
      className={`rounded-xl p-4 shadow-sm cursor-pointer transition ${styles[notification.type]}`}
      onClick={onClick}
    >
      <div className="text-xs font-medium opacity-80 mb-1">{labels[notification.type]}</div>
      <div className="font-semibold">{notification.title}</div>
      <div className="text-sm mt-1 opacity-90">{notification.body}</div>
    </div>
  );
}
