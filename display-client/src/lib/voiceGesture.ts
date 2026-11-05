// 长按触发录音的阈值（ms）
export const LONG_PRESS_MS = 350;

// 上滑取消的阈值（px）
export const CANCEL_SLIDE_PX = 80;

// 录音最短时间（ms）
export const MIN_RECORD_MS = 1000;

/**
 * 判断是否上滑超过阈值（取消录音）
 * @param startY 初始纵坐标
 * @param currentY 当前纵坐标
 * @param threshold 上滑阈值（默认 CANCEL_SLIDE_PX）
 * @returns 若上滑距离超过阈值 true，否则 false
 */
export function shouldCancelBySlide(startY: number, currentY: number, threshold: number = CANCEL_SLIDE_PX): boolean {
  return startY - currentY >= threshold;
}

/**
 * 判断录音时长是否过短
 * @param durationMs 录音时长（ms）
 * @param min 最短时长下限（默认 MIN_RECORD_MS）
 * @returns 若时长 < min 则 true，否则 false
 */
export function isTooShort(durationMs: number, min: number = MIN_RECORD_MS): boolean {
  return durationMs < min;
}
