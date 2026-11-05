import { describe, expect, it, beforeAll, vi } from 'vitest';

// 证明 holo 的 scale(face) 与 head 两个旋钮独立、有界——修掉旧 oy「飞出屏/只剩头」的核心。
// computeAutoFit 是头部锚点自适应：给定 target{headScreenY, faceScreenFrac} 解出 stage transform。
// holo 传 IDENTITY_DELTA，故 effective === computeAutoFit 输出，face/head 精确成立、互不干扰。
// live2dEngine 顶层会加载 Cubism 运行时(需 window.Live2DCubismCore)，先打桩再动态 import。

type AutoFitInput = import('../features/live2d/live2dEngine').AutoFitInput;
let computeAutoFit: (i: AutoFitInput) => { scale: number; offsetX: number; offsetY: number };

beforeAll(async () => {
  vi.stubGlobal('Live2DCubismCore', {});
  (globalThis as unknown as { window: { Live2DCubismCore: object } }).window ||= {} as never;
  (globalThis as unknown as { window: { Live2DCubismCore: object } }).window.Live2DCubismCore = {};
  ({ computeAutoFit } = await import('../features/live2d/live2dEngine'));
});

const BASE = {
  width: 1280,
  rawHeight: 720,
  modelBaseWidth: 1000,
  modelBaseHeight: 2000,
  scaleMultiplier: 1,
  verticalOffset: 0,
  modelTransform: { scale: 1, offsetX: 0, offsetY: 0 },
  headAnchorY: 0.16,
  headSizeNorm: 0.18,
};

describe('holo framing: scale(face) vs head 独立、有界', () => {
  it('改 head 不改大小，但竖向 offsetY 随之单调移动', () => {
    const high = computeAutoFit({ ...BASE, target: { headScreenY: 0.15, faceScreenFrac: 0.11 } });
    const low = computeAutoFit({ ...BASE, target: { headScreenY: 0.35, faceScreenFrac: 0.11 } });
    expect(low.scale).toBeCloseTo(high.scale, 6);           // 大小不变
    expect(low.offsetY).toBeGreaterThan(high.offsetY);      // head 更大=更靠下=offsetY 更大
  });

  it('改 face(scale) 改大小（更大的 faceScreenFrac→更大 scale）', () => {
    const small = computeAutoFit({ ...BASE, target: { headScreenY: 0.2, faceScreenFrac: 0.09 } });
    const big = computeAutoFit({ ...BASE, target: { headScreenY: 0.2, faceScreenFrac: 0.18 } });
    expect(big.scale).toBeGreaterThan(small.scale * 1.5);
  });

  it('★核心：整个 URL 参数域内 offsetY 始终有界（不像旧 oy 飞出屏）★', () => {
    // holoStage 限定 scale∈[0.2,3]→faceScreenFrac∈[0.022,0.33]，head∈[0.02,0.6]
    for (const faceScreenFrac of [0.022, 0.11, 0.33]) {
      for (const headScreenY of [0.02, 0.2, 0.6]) {
        const fit = computeAutoFit({ ...BASE, target: { headScreenY, faceScreenFrac } });
        // 头部锚点自适应把 offsetY 解到「让头落在 headScreenY(∈屏内)」，天然有界；
        // 旧 oy 是裸增量(系数=屏高)，用户填 ±0.5/整数就飞屏。这里恒 <1.5。
        expect(Math.abs(fit.offsetY)).toBeLessThan(1.5);
      }
    }
  });
});
