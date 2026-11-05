/**
 * 主页沉浸模式计时器：30s 无触屏 → 隐藏聊天 UI（角色留下当"活屏保"），触屏/新消息唤回。
 * 纯状态机，不碰 DOM/React——由 useIdleUiHide hook 接线。
 */
export const IDLE_HIDE_MS = 30_000;

export type IdleHideController = {
  /** 进入/退出可隐藏状态。false（未登录/通话/DJ/打字/弹窗等豁免态）时强制显示且不计时。 */
  setActive(active: boolean): void;
  /** 用户触屏：唤回 UI 并重新计时。 */
  touch(): void;
  /** 外部事件（如新消息/主动演出到达）：唤回 UI 并重新计时。 */
  wake(): void;
  /** 清理计时器。 */
  dispose(): void;
};

export function createIdleHideController(
  onHiddenChange: (hidden: boolean) => void,
  timeoutMs: number = IDLE_HIDE_MS,
): IdleHideController {
  let active = false;
  let hidden = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clear = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const emit = (next: boolean) => {
    if (hidden === next) return;
    hidden = next;
    onHiddenChange(next);
  };

  const arm = () => {
    clear();
    timer = setTimeout(() => emit(true), timeoutMs);
  };

  // touch 与 wake 行为一致：唤回 + 重新计时。分成两个名字只为调用处语义清晰。
  const reveal = () => {
    if (!active) return;
    emit(false);
    arm();
  };

  return {
    setActive(next) {
      if (active === next) return;
      active = next;
      if (next) {
        arm();
      } else {
        clear();
        emit(false);
      }
    },
    touch: reveal,
    wake: reveal,
    dispose() {
      clear();
      active = false;
    },
  };
}
