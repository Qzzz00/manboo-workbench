import { describe, expect, it } from 'vitest';
import {
  adjacentLoopMads,
  blendFrames,
  computeDiffRegion,
  findLoopValleyIndex,
  findMouthAnchor,
  rotateArray,
} from './exportUtils';

const W = 100, H = 100;
function blank(): Uint8ClampedArray { return new Uint8ClampedArray(W * H * 4).fill(0); }
function drawRect(img: Uint8ClampedArray, x: number, y: number, w: number, h: number, v: number) {
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) {
    const o = (yy * W + xx) * 4; img[o] = v; img[o + 1] = v; img[o + 2] = v; img[o + 3] = 255;
  }
}

describe('findMouthAnchor', () => {
  it('找到整数平移偏移', () => {
    const baseline = blank(); drawRect(baseline, 40, 50, 10, 8, 200);
    const frame = blank(); drawRect(frame, 43, 48, 10, 8, 200);   // 平移 (+3, -2)
    const m = findMouthAnchor(baseline, frame, W, { x: 38, y: 48, w: 14, h: 12 }, 8);
    expect(m.dx).toBe(3);
    expect(m.dy).toBe(-2);
    expect(m.residual).toBeLessThan(1);
  });
  it('内容对不上时残差高', () => {
    const baseline = blank(); drawRect(baseline, 40, 50, 10, 8, 200);
    const frame = blank();                                        // 空帧，无处可配
    const m = findMouthAnchor(baseline, frame, W, { x: 38, y: 48, w: 14, h: 12 }, 8);
    expect(m.residual).toBeGreaterThan(20);
  });

  it('孔径问题：region 内容光滑时上下文外扩窗口才能找到真偏移', () => {
    // 嘴 region 内是均匀皮肤（SAD 处处为 0，任意偏移都是假极小值）；
    // 结构（下巴/唇角类比）在 region 外 10px 处。真平移 (+3, -2)。
    const region = { x: 40, y: 40, w: 12, h: 10 };
    const baseline = blank();
    drawRect(baseline, region.x - 2, region.y - 2, region.w + 4, region.h + 4, 128); // region 及周边均匀
    drawRect(baseline, region.x - 10, region.y + 2, 4, 4, 240);                      // region 外的结构
    drawRect(baseline, region.x + region.w + 6, region.y + 4, 4, 4, 30);
    const frame = blank();
    drawRect(frame, region.x - 2 + 3, region.y - 2 - 2, region.w + 4, region.h + 4, 128);
    drawRect(frame, region.x - 10 + 3, region.y + 2 - 2, 4, 4, 240);
    drawRect(frame, region.x + region.w + 6 + 3, region.y + 4 - 2, 4, 4, 30);
    // 无上下文：region 内全均匀，找不到真偏移（残差在多个假位置同为最小）
    // 有上下文（每边外扩 16px）：唯一极小值在真偏移
    const m = findMouthAnchor(baseline, frame, W, region, 8, 16);
    expect(m.dx).toBe(3);
    expect(m.dy).toBe(-2);
    expect(m.residual).toBeLessThan(1);
  });

  it('上下文窗口在画布边缘自动收窄（不越界崩溃）', () => {
    const region = { x: 2, y: 2, w: 10, h: 8 };  // 贴画布左上角
    const baseline = blank(); drawRect(baseline, 2, 2, 10, 8, 200);
    const frame = blank(); drawRect(frame, 4, 3, 10, 8, 200);   // 平移 (+2, +1)
    const m = findMouthAnchor(baseline, frame, W, region, 4, 16);
    expect(m.dx).toBe(2);
    expect(m.dy).toBe(1);
  });

  it('残差只在原 region 上计量（上下文窗口仅用于选偏移，脸部形变不虚增嘴区残差）', () => {
    // region 内容在真偏移处完全一致；region 外（上下文内）的大块结构在帧里剧烈变亮度
    // （类比：身体动作使下巴/头发形变）。偏移仍应由上下文结构定位，但残差要反映嘴区本身。
    const region = { x: 40, y: 40, w: 12, h: 10 };
    const baseline = blank();
    drawRect(baseline, region.x, region.y, region.w, region.h, 128);
    drawRect(baseline, region.x - 14, region.y - 2, 12, 12, 240);  // 上下文大块结构
    const frame = blank();
    drawRect(frame, region.x + 3, region.y - 2, region.w, region.h, 128); // 嘴区平移 (+3,-2)，内容不变
    drawRect(frame, region.x - 14 + 3, region.y - 2 - 2, 12, 12, 40);     // 上下文结构平移后亮度剧变(240→40)
    const m = findMouthAnchor(baseline, frame, W, region, 8, 16);
    expect(m.dx).toBe(3);
    expect(m.dy).toBe(-2);
    expect(m.residual).toBeLessThan(1); // 嘴区在真偏移处逐像素一致 → 残差≈0（上下文形变不计入）
  });
});

describe('adjacentLoopMads', () => {
  it('环形相邻 MAD：mads[i] = MAD(frame[i-1], frame[i])，mads[0] 是回卷对', () => {
    const px = (v: number) => new Uint8ClampedArray([v, v, v, 255]);
    const frames = [px(0), px(10), px(30)];
    const mads = adjacentLoopMads(frames);
    expect(mads.length).toBe(3);
    expect(mads[0]).toBeCloseTo((30 + 30 + 30 + 0) / 4, 5); // f2 vs f0（回卷）
    expect(mads[1]).toBeCloseTo((10 + 10 + 10 + 0) / 4, 5); // f0 vs f1
    expect(mads[2]).toBeCloseTo((20 + 20 + 20 + 0) / 4, 5); // f1 vs f2
  });
  it('少于 2 帧返回空数组', () => {
    expect(adjacentLoopMads([new Uint8ClampedArray(4)])).toEqual([]);
  });
});

describe('findLoopValleyIndex', () => {
  it('返回环形相邻 MAD 最小处的下标（速度谷）', () => {
    const px = (v: number) => new Uint8ClampedArray([v, v, v, 255]);
    // f0=0, f1=10, f2=30 → mads[0]=|30-0|=30(回卷), mads[1]=|0-10|=10, mads[2]=|10-30|=20
    // 最小值在下标 1
    const frames = [px(0), px(10), px(30)];
    expect(findLoopValleyIndex(frames)).toBe(1);
  });

  it('单帧序列返回 0', () => {
    const px = (v: number) => new Uint8ClampedArray([v, v, v, 255]);
    expect(findLoopValleyIndex([px(0)])).toBe(0);
  });

  it('双帧序列返回 0（两个环形转移 MAD 相等，取首个）', () => {
    const px = (v: number) => new Uint8ClampedArray([v, v, v, 255]);
    expect(findLoopValleyIndex([px(0), px(50)])).toBe(0);
  });

  it('平局取第一个最小下标', () => {
    const px = (v: number) => new Uint8ClampedArray([v, v, v, 255]);
    // f0=0, f1=5, f2=0, f3=5 → mads[0]=|5-0|=5(回卷), mads[1]=|0-5|=5, mads[2]=|5-0|=5, mads[3]=|0-5|=5
    // 全部相等，取下标 0
    const frames = [px(0), px(5), px(0), px(5)];
    expect(findLoopValleyIndex(frames)).toBe(0);
  });
});

describe('rotateArray', () => {
  it('从 start 下标旋转数组', () => {
    expect(rotateArray([0, 1, 2, 3, 4], 2)).toEqual([2, 3, 4, 0, 1]);
  });
  it('start=0 与越界取模', () => {
    expect(rotateArray([1, 2, 3], 0)).toEqual([1, 2, 3]);
    expect(rotateArray([1, 2, 3], 4)).toEqual([2, 3, 1]);
  });
});

describe('blendFrames', () => {
  it('末 K 帧与帧 0 按 w=(i+1)/(K+1) 线性混合，其余帧原样保留', () => {
    // 4 帧序列，单像素值分别为 [0, 40, 80, 120]；K=3 → 混合末 3 帧（index 1,2,3）与帧 0(=0)。
    const px = (v: number) => {
      const img = new Uint8ClampedArray(4);
      img[0] = v; img[1] = v; img[2] = v; img[3] = 255;
      return img;
    };
    const frames = [px(0), px(40), px(80), px(120)];
    const out = blendFrames(frames, 3);
    // 帧 0 不受影响
    expect(out[0][0]).toBe(0);
    // 帧 1 (index 1 = N-K+0，i=0): w=1/4 → 40*(1-0.25)+0*0.25 = 30
    expect(out[1][0]).toBe(30);
    // 帧 2 (i=1): w=2/4 → 80*0.5+0*0.5 = 40
    expect(out[2][0]).toBe(40);
    // 帧 3 (i=2): w=3/4 → 120*0.25+0*0.75 = 30
    expect(out[3][0]).toBe(30);
    // alpha 通道保持不透明
    expect(out[3][3]).toBe(255);
  });

  it('K 大于等于帧数时退化为不处理（避免把整段序列都拉向帧 0）', () => {
    const px = (v: number) => new Uint8ClampedArray([v, v, v, 255]);
    const frames = [px(0), px(100)];
    const out = blendFrames(frames, 5);
    expect(out[0][0]).toBe(0);
    expect(out[1][0]).toBe(100);
  });

  it('不修改输入数组（返回新数组）', () => {
    const px = (v: number) => new Uint8ClampedArray([v, v, v, 255]);
    const frames = [px(0), px(40), px(80), px(120)];
    const before = frames[1][0];
    blendFrames(frames, 3);
    expect(frames[1][0]).toBe(before);
  });
});

describe('computeDiffRegion', () => {
  it('返回差异包围盒(含 pad)并夹在画布内', () => {
    const a = blank(); const b = blank(); drawRect(b, 20, 30, 6, 4, 255);
    expect(computeDiffRegion(a, b, W, H, 8, 2)).toEqual({ x: 18, y: 28, w: 10, h: 8 });
  });
  it('无差异返回 null', () => {
    expect(computeDiffRegion(blank(), blank(), W, H, 8, 2)).toBeNull();
  });
});
