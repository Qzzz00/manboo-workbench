// 来源:Aiboo origin/main 1f430c3f admin-ui/src/shared/components/toast.tsx
/** 极简 toast：模块级状态 + 订阅，不引第三方库。 */
import { useEffect, useState } from 'react';

export interface ToastItem {
  id: number;
  kind: 'success' | 'error' | 'info';
  message: string;
}

let items: ToastItem[] = [];
let seq = 1;
const listeners = new Set<(v: ToastItem[]) => void>();

function emit(): void {
  for (const l of listeners) l(items);
}

const TOAST_DURATIONS: Record<ToastItem['kind'], number> = {
  success: 4000,
  error: 6000,
  info: 4000,
};

export function pushToast(kind: ToastItem['kind'], message: string): void {
  const item: ToastItem = { id: seq++, kind, message };
  items = [...items, item];
  emit();
  setTimeout(() => {
    items = items.filter((t) => t.id !== item.id);
    emit();
  }, TOAST_DURATIONS[kind]);
}

export const toast = {
  success: (m: string) => pushToast('success', m),
  error: (m: string) => pushToast('error', m),
  info: (m: string) => pushToast('info', m),
};

export function ToastHost() {
  const [list, setList] = useState<ToastItem[]>(items);
  useEffect(() => {
    listeners.add(setList);
    return () => {
      listeners.delete(setList);
    };
  }, []);
  return (
    <div className="toast-wrap">
      {list.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`}>
          {t.message}
        </div>
      ))}
    </div>
  );
}
