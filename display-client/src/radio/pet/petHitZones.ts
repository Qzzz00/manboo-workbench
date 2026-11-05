/**
 * 触摸/投喂的命中数学：ModelBounds + 各角色标定的 headAnchorY/headSizeNorm → 头区/嘴区。
 * ★坐标空间：bounds 原生路径=容器真实 px、Pixi 路径=480×640 布局 px（clientWidth 不受
 * CSS transform 影响），指针永远是真实 px——toStageSpace 按 nativeActive 分流换算。
 */
import type { ModelBounds } from '../../features/live2d/live2dEngine.ts';

const TAP_MAX_MOVE_PX = 10;
const TAP_MAX_MS = 350;
export const DESIGN_W = 480;
export const DESIGN_H = 640;

export type StagePoint = { x: number; y: number };
export type PetZone = 'head' | 'body' | 'none';
export type PetZoneRects = {
  head: { left: number; top: number; right: number; bottom: number };
  mouth: { x: number; y: number; r: number };
  model: { left: number; top: number; right: number; bottom: number };
};

/** 纯点击判定：位移 <10px 且 <350ms（与切页滑动 |dx|≥45 无重叠）。 */
export function decideTap(dx: number, dy: number, elapsedMs: number): boolean {
  return Math.abs(dx) < TAP_MAX_MOVE_PX && Math.abs(dy) < TAP_MAX_MOVE_PX && elapsedMs < TAP_MAX_MS;
}

type RectLike = { left: number; top: number; width: number; height: number };

/** 指针点 → bounds 所在空间（原生=容器真实 px；Pixi=设计 px）。 */
export function toStageSpace(clientX: number, clientY: number, rect: RectLike, nativeActive: boolean): StagePoint {
  const lx = clientX - rect.left;
  const ly = clientY - rect.top;
  if (nativeActive || rect.width <= 0 || rect.height <= 0) return { x: lx, y: ly };
  return { x: lx * (DESIGN_W / rect.width), y: ly * (DESIGN_H / rect.height) };
}

/** 指针点 → 480×640 设计坐标（DOM 定位：爱心粒子/拖拽贴图恒用设计坐标）。 */
export function toDesignSpace(clientX: number, clientY: number, rect: RectLike): StagePoint {
  if (rect.width <= 0 || rect.height <= 0) return { x: clientX - rect.left, y: clientY - rect.top };
  return { x: (clientX - rect.left) * (DESIGN_W / rect.width), y: (clientY - rect.top) * (DESIGN_H / rect.height) };
}

export function petZoneRects(b: ModelBounds, headAnchorY: number, headSizeNorm: number): PetZoneRects {
  const h = b.modelHeight;
  const cy = b.top + headAnchorY * h;
  const half = headSizeNorm * h * 0.5;
  const top = Math.min(b.bottom, Math.max(b.top, cy - half));
  return {
    head: { left: b.left, right: b.right, top, bottom: Math.max(top, Math.min(b.bottom, cy + half)) },
    // 嘴点取头带下沿往里一点（0.9×half），投喂松手判这里；初始值，真机可微调。
    mouth: { x: (b.left + b.right) / 2, y: Math.min(b.bottom, cy + half * 0.9), r: headSizeNorm * h * 0.35 },
    model: { left: b.left, right: b.right, top: b.top, bottom: b.bottom },
  };
}

export function petZoneAt(r: PetZoneRects, x: number, y: number): PetZone {
  const inModel = x >= r.model.left && x <= r.model.right && y >= r.model.top && y <= r.model.bottom;
  if (!inModel) return 'none';
  const inHead = x >= r.head.left && x <= r.head.right && y >= r.head.top && y <= r.head.bottom;
  return inHead ? 'head' : 'body';
}

export function inMouthZone(r: PetZoneRects, x: number, y: number): boolean {
  const dx = x - r.mouth.x;
  const dy = y - r.mouth.y;
  return dx * dx + dy * dy <= r.mouth.r * r.mouth.r;
}
