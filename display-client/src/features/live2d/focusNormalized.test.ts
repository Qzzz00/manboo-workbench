import { describe, it, expect, vi } from 'vitest';

// pixi-live2d-display 在模块加载时访问 window；mock 掉以保持 env:node。
vi.mock('pixi-live2d-display/cubism4', () => ({ Live2DModel: class {} }));
vi.mock('pixi.js', () => ({ default: {}, Application: class {}, Sprite: class {} }));

import { focusRuntimeNormalized } from './live2dEngine.ts';

// 构造仅含 focusRuntimeNormalized 所需字段的最小 runtime。
function makeRuntime() {
  const calls: Array<[number, number]> = [];
  const runtime = {
    model: {
      internalModel: {
        focusController: {
          focus(x: number, y: number) {
            calls.push([x, y]);
          },
        },
      },
    },
    idleSuppressUntil: 0,
    idleBeatPhase: 'hold' as 'idle' | 'hold' | 'recover',
    idleBeatNextAt: 0,
    idleFocusX: 0.9,
    idleFocusY: 0.9,
    idleFocusTargetX: 0.9,
    idleFocusTargetY: 0.9,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { runtime: runtime as any, calls };
}

describe('focusRuntimeNormalized', () => {
  it('把归一化坐标直接喂给 focusController', () => {
    const { runtime, calls } = makeRuntime();
    focusRuntimeNormalized(runtime, 0.5, -0.3);
    expect(calls).toContainEqual([0.5, -0.3]);
  });

  it('接管时抑制待机拍（idleSuppressUntil 推到未来）', () => {
    const { runtime } = makeRuntime();
    const before = performance.now();
    focusRuntimeNormalized(runtime, 0.2, 0.2);
    expect(runtime.idleSuppressUntil).toBeGreaterThan(before);
  });

  it('正处于程序化拍时，接管会把相位归回 idle 并清零自管 focus', () => {
    const { runtime } = makeRuntime();
    focusRuntimeNormalized(runtime, 0.2, 0.2);
    expect(runtime.idleBeatPhase).toBe('idle');
    expect(runtime.idleFocusTargetX).toBe(0);
    expect(runtime.idleFocusTargetY).toBe(0);
  });
});
