/**
 * 全局「暂停其他通知」开关。
 *
 * EndingScene 等沉浸式全屏场景打开时设置为 true，ToastContainer 等通知层据此
 * 暂停弹出，避免打断沉浸体验。本模块不依赖 React，可被任意运行时代码读写。
 */

let paused = false;
const listeners = new Set<(paused: boolean) => void>();

function notify() {
  for (const listener of listeners) {
    listener(paused);
  }
}

export function setNotificationPaused(next: boolean): void {
  if (paused === next) return;
  paused = next;
  notify();
}

export function getNotificationPaused(): boolean {
  return paused;
}

export function subscribeNotificationPaused(listener: (paused: boolean) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
