// 双击判定（ALL-440）：纯逻辑，分指针类型给不同阈值。
//
// 背景：真机指腹小幅抖动 + Android WebView 的 pointercancel 污染，导致旧实现（统一 8px/320ms、
// pointercancel 当 pointerup 处理）频繁识别失败。这里：
// - touch 放宽到 420ms 窗口 / 20px 位移（容指腹抖动）；
// - mouse/pen 保持更严的 320ms / 8px（PC 行为不大变）；
// - cancel 只清理拖动标记，不计 tap、不更新 lastUpAt、不触发双击。
// 竖滑切角色优先由调用方用 drag 坐标单独判定（dy>60 且 dy>dx*1.4），不进入本模块。

export type PointerKind = 'touch' | 'mouse' | 'pen';

export type DoubleTapDetectorOptions = {
  touchWindowMs?: number;
  touchMaxMovePx?: number;
  mouseWindowMs?: number;
  mouseMaxMovePx?: number;
  now?: () => number;
};

export interface DoubleTapDetector {
  /** pointerdown 时调用：重置本段拖动标记。 */
  reset(): void;
  /** pointermove 时调用：位移超过该指针类型阈值即标记为「拖动过」。 */
  trackMove(kind: PointerKind, dx: number, dy: number): void;
  /** pointerup 时调用：拖动过返回 false；否则按时间窗判定是否构成双击。 */
  registerUp(kind: PointerKind): boolean;
  /** pointercancel 时调用：只清理拖动标记，不计 tap、不更新 lastUpAt。 */
  cancel(): void;
}

export function createDoubleTapDetector(options: DoubleTapDetectorOptions = {}): DoubleTapDetector {
  const touchWindowMs = options.touchWindowMs ?? 420;
  const touchMaxMovePx = options.touchMaxMovePx ?? 20;
  const mouseWindowMs = options.mouseWindowMs ?? 320;
  const mouseMaxMovePx = options.mouseMaxMovePx ?? 8;
  const now = options.now ?? Date.now;

  // -Infinity：首击必不命中时间窗（now() 可能接近 0 的单调钟也不能误判双击）。
  let lastUpAt = Number.NEGATIVE_INFINITY;
  let moved = false;

  return {
    reset() {
      moved = false;
    },

    trackMove(kind, dx, dy) {
      const max = kind === 'touch' ? touchMaxMovePx : mouseMaxMovePx;
      if (Math.abs(dx) > max || Math.abs(dy) > max) moved = true;
    },

    registerUp(kind) {
      if (moved) return false;
      const windowMs = kind === 'touch' ? touchWindowMs : mouseWindowMs;
      const t = now();
      if (t - lastUpAt < windowMs) {
        lastUpAt = 0; // 触发后清零，避免三连击重复触发
        return true;
      }
      lastUpAt = t;
      return false;
    },

    cancel() {
      moved = false;
    },
  };
}
