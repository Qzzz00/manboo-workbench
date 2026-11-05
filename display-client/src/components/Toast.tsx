import { useEffect, useState } from 'react';
import { getToasts, subscribeToToasts, type ToastItem, type ToastType } from '../lib/toastStore.ts';
import {
  getNotificationPaused,
  subscribeNotificationPaused,
} from '../lib/notificationPause.ts';

function toastIcon(type: ToastType) {
  switch (type) {
    case 'error':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="18" height="18">
          <circle cx="12" cy="12" r="10" />
          <line x1="15" y1="9" x2="9" y2="15" />
          <line x1="9" y1="9" x2="15" y2="15" />
        </svg>
      );
    case 'warning':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="18" height="18">
          <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
          <line x1="12" y1="9" x2="12" y2="13" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
      );
    case 'info':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="18" height="18">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="16" x2="12" y2="12" />
          <line x1="12" y1="8" x2="12.01" y2="8" />
        </svg>
      );
  }
}

function ToastItemView({ toast }: { toast: ToastItem }) {
  return (
    <div className={`toast-item toast-${toast.type}`} role="alert">
      <span className="toast-icon">{toastIcon(toast.type)}</span>
      <span className="toast-message">{toast.message}</span>
    </div>
  );
}

export function ToastContainer() {
  const [items, setItems] = useState<ToastItem[]>(getToasts);
  const [paused, setPaused] = useState<boolean>(getNotificationPaused);

  useEffect(() => {
    return subscribeToToasts(() => setItems(getToasts()));
  }, []);

  useEffect(() => {
    return subscribeNotificationPaused(setPaused);
  }, []);

  if (paused || items.length === 0) return null;

  return (
    <div className="toast-container" aria-live="polite" aria-atomic="true">
      {items.map((toast) => (
        <ToastItemView key={toast.id} toast={toast} />
      ))}
    </div>
  );
}
