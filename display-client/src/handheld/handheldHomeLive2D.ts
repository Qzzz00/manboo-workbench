import type { HandheldPage } from './handheldNavigation.ts';

export type HandheldHomeLive2DState = {
  page: HandheldPage;
  documentVisible: boolean;
  /** 浮窗服务已完成销毁，才允许主页申请自己的 Cubism renderer。 */
  overlayStopped: boolean;
  /** 横向翻页动画已结束，避免在 translateX 中按错误的容器位置量构图。 */
  pageReady: boolean;
  settingsOpen: boolean;
};

/** 主页遮罩的版本门：只有当前 request 的完整帧回调能揭开当前主页。 */
export type HomeSceneGate = {
  requestId: number;
  readyRequestId: number;
};

/** 在任何可能离开/遮挡主页的交接前先盖住，并开启新一轮完整帧请求。 */
export function coverHomeScene(gate: HomeSceneGate): HomeSceneGate {
  return { ...gate, requestId: gate.requestId + 1 };
}

/** 丢弃旧 Stage 的迟到 ready；只记录当前请求已经拿到完整帧。 */
export function markHomeSceneReady(gate: HomeSceneGate, requestId: number): HomeSceneGate {
  if (requestId !== gate.requestId) return gate;
  return { ...gate, readyRequestId: requestId };
}

export function isHomeSceneCovered(gate: HomeSceneGate): boolean {
  return gate.readyRequestId !== gate.requestId;
}

/** 只有原生主页确认 pause 后才执行设置 preview 的挂载动作。 */
export async function openSettingsAfterHomePark(
  parkHome: () => Promise<void>,
  mountSettings: () => void,
): Promise<boolean> {
  try {
    await parkHome();
  } catch {
    return false;
  }
  mountSettings();
  return true;
}

/** 同一进程内 Cubism 只能存在一个 renderer；这个门是主页模型的唯一挂载判据。 */
export function shouldMountHandheldHomeLive2D(state: HandheldHomeLive2DState): boolean {
  return state.page === 'home'
    && state.documentVisible
    && state.overlayStopped
    && state.pageReady
    && !state.settingsOpen;
}

/** 首次打开主页没有横向位移，别为不存在的动画白等；回主页仍需等容器坐标稳定。 */
export function homeStageMountDelayMs(isFirstHomeVisit: boolean, pageTransitionMs: number): number {
  return isFirstHomeVisit ? 0 : pageTransitionMs + 60;
}

/** 主页时钟始终输出带英文冒号的 24 小时制 HH:mm。 */
export function formatHandheldHomeTime(date: Date): string {
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}
