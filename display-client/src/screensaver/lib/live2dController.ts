/**
 * 屏保 Live2D 控制句柄。Live2DScene 在模型就绪后通过 onReady 暴露给上层，
 * DJ 播放器用它驱动口型与情绪，无需直接接触底层 runtime。
 */
export interface Live2DController {
  /** 传入 0..1 的音频能量，驱动嘴部参数（已在内部映射到模型参数范围）。 */
  setMouth(level01: number): void;
  /** DJ 段落情绪（calm/warm/hype/chill/melancholy），best-effort 映射到表情。 */
  setEmotion(emotion: string | null): void;
  /** 设置持久参数覆盖（如 DJ 换装 Param67=1）；传空数组恢复默认造型。 */
  setCostume(params: { id: string; value: number }[]): void;
  /**
   * 归一化朝向 [-1,1]（陀螺仪/指针 parallax）：驱动头+眼+身、物理自然跟随。
   * 可选：低端机原生 GL 路径暂无 focus 通道（P4 补），故调用方须 `?.` 守卫。
   */
  setFocus?(nx: number, ny: number): void;
  /**
   * 按当前取景重算构图并下发（**不重载模型**）。
   * 掌机底条的取景热更新用：改完 SURFACE_FRAMING.petStrip 后调一次即成像——
   * 走重启浮窗那条路要 2.5 秒重载模型，设置页的实时预览就没了。
   * 可选：旧的 controller 实现可能没有，调用方须 `?.` 守卫。
   */
  refit?(): void;
  /**
   * DJ 口播文本产生时回调一段完整口播文本（intro/interlude 实时生成的那句话）。
   * 可选：仅 SoulLink 情绪层消费方（App DJ 编排）会提供实现，屏保/holo 不提供=零影响。
   * 用于把口播文本喂给情绪引擎驱动表情连续过渡（口型仍走 setMouth，不受影响）。
   */
  onSpeakText?(text: string): void;
}
