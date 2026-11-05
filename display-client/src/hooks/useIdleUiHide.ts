import { useEffect, useMemo, useState } from 'react';
import { createIdleHideController } from '../lib/idleUiHide';

/**
 * 主页沉浸模式：active=true 时 30s 无触屏隐藏聊天 UI，任何触屏唤回。
 * 触屏监听挂 window 捕获阶段——UI 隐藏后 chat-panel 是 pointer-events:none，
 * 点击会落到 Live2D 舞台上（角色互动保留），这里仍能截获同一下点击做唤醒。
 */
export function useIdleUiHide(active: boolean): { hidden: boolean; wake: () => void } {
  const [hidden, setHidden] = useState(false);
  const controller = useMemo(() => createIdleHideController(setHidden), []);

  useEffect(() => {
    controller.setActive(active);
  }, [controller, active]);

  useEffect(() => {
    const onPointerDown = () => controller.touch();
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      controller.dispose();
    };
  }, [controller]);

  return { hidden, wake: controller.wake };
}
