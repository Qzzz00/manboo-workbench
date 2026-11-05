import type { CrisisResource } from '../lib/journeyApi.ts';

interface CrisisResourceReminderProps {
  resources: CrisisResource[];
  className?: string;
}

export function CrisisResourceReminder({ resources, className = '' }: CrisisResourceReminderProps) {
  if (resources.length === 0) return null;

  return (
    <div className={`rounded border border-rose-100 bg-rose-50 p-3 text-sm text-rose-950 ${className}`}>
      <div className="font-semibold">资源提醒</div>
      <div className="mt-2 space-y-2">
        {resources.map((item, index) => (
          <div key={`${item.title}-${index}`}>
            <div className="font-medium">{item.title}</div>
            <div className="text-rose-900/80">{item.description}</div>
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-rose-900">
              {item.phone ? <span>电话：{item.phone}</span> : null}
              {item.url ? (
                <a href={item.url} target="_blank" rel="noreferrer" className="underline">
                  查看链接
                </a>
              ) : null}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
