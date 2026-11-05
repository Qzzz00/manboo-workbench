import { describe, it, expect } from 'vitest';
import type { ModelBounds } from '../../features/live2d/live2dEngine.ts';
import { decideTap, inMouthZone, petZoneAt, petZoneRects, toDesignSpace, toStageSpace } from './petHitZones.ts';

// DJ 页典型 bounds（480×640 容器，模型高约 900、上缘探出屏幕——胸上构图常态）
const B: ModelBounds = { top: -160, bottom: 740, left: -60, right: 540, modelWidth: 600, modelHeight: 900 };

describe('decideTap', () => {
  it('位移 <10px 且 <350ms 才算点', () => {
    expect(decideTap(3, -4, 120)).toBe(true);
    expect(decideTap(12, 0, 120)).toBe(false);
    expect(decideTap(0, 11, 120)).toBe(false);
    expect(decideTap(2, 2, 350)).toBe(false);
    expect(decideTap(9, 9, 349)).toBe(true);
  });
});

describe('toStageSpace / toDesignSpace', () => {
  const rect = { left: 100, top: 50, width: 240, height: 320 }; // 半尺寸窗口（scale=0.5）
  it('原生路径：容器本地真实 px（不除缩放）', () => {
    expect(toStageSpace(220, 210, rect, true)).toEqual({ x: 120, y: 160 });
  });
  it('Pixi 路径：换算到 480×640 设计坐标（除缩放）', () => {
    expect(toStageSpace(220, 210, rect, false)).toEqual({ x: 240, y: 320 });
  });
  it('DOM 定位恒用设计坐标', () => {
    expect(toDesignSpace(220, 210, rect)).toEqual({ x: 240, y: 320 });
  });
  it('rect 宽高为 0 时不产生 NaN/Infinity', () => {
    const p = toStageSpace(220, 210, { left: 0, top: 0, width: 0, height: 0 }, false);
    expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
  });
});

describe('petZoneRects（hijiki anchor 0.284 / size 0.42 实值代入）', () => {
  const r = petZoneRects(B, 0.284, 0.42);
  // headCy = -160 + 0.284*900 = 95.6；half = 0.42*900/2 = 189
  it('头带：cy±half 且 clamp 进模型矩形', () => {
    expect(r.head.top).toBeCloseTo(-93.4, 1);
    expect(r.head.bottom).toBeCloseTo(284.6, 1);
    expect(r.head.left).toBe(B.left);
    expect(r.head.right).toBe(B.right);
  });
  it('嘴点在头带下沿附近、半径 = headSize 的 35%', () => {
    expect(r.mouth.x).toBeCloseTo(240, 5);
    expect(r.mouth.y).toBeCloseTo(95.6 + 189 * 0.9, 1);
    expect(r.mouth.r).toBeCloseTo(0.42 * 900 * 0.35, 5);
  });
  it('头带上缘探出屏幕的构图（ghostie 0.24/0.40）不产生倒置矩形', () => {
    const g = petZoneRects({ ...B, top: -400 }, 0.24, 0.40);
    expect(g.head.top).toBeLessThanOrEqual(g.head.bottom);
  });
  it('紧构图（bounds高度远小于modelHeight）头带被完整夹进模型矩形', () => {
    const tight = petZoneRects({ top: 0, bottom: 300, left: 0, right: 480, modelWidth: 480, modelHeight: 900 }, 0.7, 0.3);
    // headCy = 0 + 0.7*900 = 630；half = 0.3*900/2 = 135
    // 不夹的话 top=max(0,630-135)=495, bottom=min(300,630+135)=300 → top > bottom
    // 夹后 top = min(300, max(0, 495)) = 300, bottom = max(300, min(300, 765)) = 300
    expect(tight.head.top).toBeLessThanOrEqual(tight.head.bottom);
    expect(tight.head.top).toBeGreaterThanOrEqual(0);
    expect(tight.head.bottom).toBeLessThanOrEqual(300);
  });
});

describe('petZoneAt / inMouthZone', () => {
  const r = petZoneRects(B, 0.284, 0.42);
  it('头带内=head，模型内头带外=body，模型外=none', () => {
    expect(petZoneAt(r, 240, 100)).toBe('head');
    expect(petZoneAt(r, 240, 500)).toBe('body');
    expect(petZoneAt(r, -100, 100)).toBe('none');
  });
  it('嘴区是圆形判定', () => {
    expect(inMouthZone(r, r.mouth.x, r.mouth.y)).toBe(true);
    expect(inMouthZone(r, r.mouth.x + r.mouth.r + 1, r.mouth.y)).toBe(false);
  });
  it('紧构图下模型内底部不越界', () => {
    const tight = petZoneRects({ top: 0, bottom: 300, left: 0, right: 480, modelWidth: 480, modelHeight: 900 }, 0.7, 0.3);
    const z = petZoneAt(tight, 240, 299);
    expect(['head', 'body']).toContain(z);
  });
});
