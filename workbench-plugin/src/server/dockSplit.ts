/**
 * 窗位叠双窗堆叠的两个纯函数(spec 2026-08-25 窗位叠双窗堆叠)。
 *
 * 单独成文件而不塞进 dock.ts:这两件事都是"给定输入算出结果",不碰文件、不碰壳、
 * 不碰状态,单测能把边界钉死;dock.ts 那 700 行里全是 IO 与时序,混在一起就没法单测。
 */
import type { HelperRect } from '../protocol.ts'

/** 两半之间留的缝。不留缝两扇窗看起来是粘着的,留了就必须从两半里扣掉。 */
export const SPLIT_GAP_PX = 8

/**
 * 把槽位劈成两半:高 > 宽 劈上下,否则劈左右。
 *
 * **两半 + 中缝恒等于原尺寸**——不扣缝的话两扇加起来会超出槽位,窗口就压到槽外去了。
 * 极窄槽位(比缝还窄)时两半会被夹到 0 而不是负数:负宽传给 set_window_frame
 * 是未定义行为,宁可给 0 让它看起来是空的,也不能发一个非法矩形出去。
 */
export function splitSlot(slot: HelperRect): [HelperRect, HelperRect] {
  const vertical = slot.h > slot.w
  if (vertical) {
    const half = Math.max(0, (slot.h - SPLIT_GAP_PX) / 2)
    return [
      { x: slot.x, y: slot.y, w: slot.w, h: half },
      { x: slot.x, y: slot.y + half + SPLIT_GAP_PX, w: slot.w, h: half },
    ]
  }
  const half = Math.max(0, (slot.w - SPLIT_GAP_PX) / 2)
  return [
    { x: slot.x, y: slot.y, w: half, h: slot.h },
    { x: slot.x + half + SPLIT_GAP_PX, y: slot.y, w: half, h: slot.h },
  ]
}

/** frame 比对的容差。AX 报回来的坐标常带零点几的误差,一两像素不算"不同的窗"。 */
const FRAME_TOLERANCE_PX = 4

function sameFrame(left: HelperRect, right: HelperRect): boolean {
  return Math.abs(left.x - right.x) <= FRAME_TOLERANCE_PX
    && Math.abs(left.y - right.y) <= FRAME_TOLERANCE_PX
    && Math.abs(left.w - right.w) <= FRAME_TOLERANCE_PX
    && Math.abs(left.h - right.h) <= FRAME_TOLERANCE_PX
}

/**
 * 按 frame 反查这是第几扇窗。
 *
 * AX 窗口**没有稳定 id**,`standardWindows` 的下标还会随开关窗漂移,所以身份只能靠位置
 * 反查——而且下标只在**当次调用内**用来寻址,绝不落盘、不跨事件复用。
 *
 * **匹配到零扇或多扇都返回 undefined**:多扇对得上(比如两扇窗完全重叠)时,
 * 硬挑一个就是在猜,猜错会把用户另一扇窗挪走。调用方收到 undefined 应当如实降级(D13)。
 */
export function matchWindowIndex(
  windows: readonly { index: number, frame: HelperRect }[],
  target: HelperRect,
): number | undefined {
  const hits = windows.filter(window => sameFrame(window.frame, target))
  return hits.length === 1 ? hits[0]?.index : undefined
}
