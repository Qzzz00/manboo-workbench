export interface FullscreenAcceptDeps {
  /** 立即拉起通话（useCall.startCall）。 */
  startCall(): void;
  /** arm「切换结束后拉起通话」的 pending 标记（App 的 pendingCallAfterSwitchRef）。 */
  armPendingCall(): void;
  /** 程序化切角色（App 的 handleAvatarChange，含过渡遮罩/连滑排队）。 */
  switchAvatar(avatarId: string): void;
}

/**
 * 全屏来电接听的时序决策（纯函数，App.tsx 里只做依赖注入）：
 * - 目标就是当前角色：直接 startCall——handleAvatarChange 对同角色会早退，
 *   switching 周期不会启动，若仍 arm pending 会永久悬挂（本次来电被丢 +
 *   下次无关切角色时幻影 startCall）。该分支镜像原地接听路径。
 *   （全屏来电本只发给画外角色，但响铃期间用户可能恰好手动滑到该角色。）
 * - 目标是画外角色：先 arm pending 再切角色（顺序敏感：切换极快完成时
 *   App 的 switching effect 才能看到已 arm 的标记），等 switching 结束由
 *   effect 调 startCall。
 */
export function acceptFullscreenCall(
  targetAvatarId: string,
  currentAvatarId: string,
  deps: FullscreenAcceptDeps,
): void {
  if (targetAvatarId === currentAvatarId) {
    deps.startCall();
    return;
  }
  deps.armPendingCall();
  deps.switchAvatar(targetAvatarId);
}
