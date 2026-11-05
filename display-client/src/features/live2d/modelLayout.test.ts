import { describe, it, expect, vi } from 'vitest';

// pixi-live2d-display accesses window at module load; mock it to keep tests env:node.
vi.mock('pixi-live2d-display/cubism4', () => ({ Live2DModel: class {} }));
vi.mock('pixi.js', () => ({ default: {}, Application: class {}, Sprite: class {} }));

import { computeModelLayout, REFERENCE_ASPECT, type ModelLayout, type ModelLayoutInput } from './live2dEngine.ts';

// 合成竖屏输入（aspect 412/900 ≈ 0.458，纯数学、不依赖角色数据）
const tall: ModelLayoutInput = {
  width: 412,
  rawHeight: 900,
  modelBaseWidth: 1000,
  modelBaseHeight: 2000,
  scaleMultiplier: 1,
  verticalOffset: 0,
  modelTransform: { scale: 1, offsetX: 0, offsetY: 0 },
  transform: { scale: 1, offsetX: 0, offsetY: 0 },
};

describe('computeModelLayout（基线：等价于旧 fitModel 数学）', () => {
  it('竖屏输入复现旧公式数值', () => {
    const out = computeModelLayout(tall);
    // baseScale = min(412/1000, 900/2000) = 0.412
    // totalScale = 0.412
    // modelX = 412*0.5 = 206
    // modelPixelHeight = 2000*0.412 = 824; top = 900-824 = 76（在 clamp [-180,495] 内）
    expect(out.totalScale).toBeCloseTo(0.412, 6);
    expect(out.modelX).toBeCloseTo(206, 6);
    expect(out.modelY).toBeCloseTo(900, 6);
    expect(out.modelPixelWidth).toBeCloseTo(412, 6);
    expect(out.modelPixelHeight).toBeCloseTo(824, 6);
  });
});

// 旧公式（height=rawHeight）本地复制，仅供对比「方屏旧行为会把头顶出框」。
function legacyTop(i: ModelLayoutInput): number {
  const h = i.rawHeight;
  const baseScale = Math.min(i.width / i.modelBaseWidth, h / i.modelBaseHeight);
  const totalScale = baseScale * i.scaleMultiplier * i.modelTransform.scale * i.transform.scale;
  let modelY = h * (1 - i.verticalOffset + i.modelTransform.offsetY + i.transform.offsetY);
  const modelH = i.modelBaseHeight * totalScale;
  const top = modelY - modelH;
  const clampedTop = Math.min(Math.max(top, -0.2 * h), 0.55 * h);
  if (clampedTop !== top) modelY = clampedTop + modelH;
  return modelY - modelH;
}

// 半身构图代表参数：模型比画框更高、并被上推（emulate calcMobileTransform 的负 offsetY）。
// 宽度选 504（= 9k，k=56），使 504/REFERENCE_ASPECT = 504*16/9 = 896 精确整数，
// 避免 Math.round 引入亚像素误差干扰"稳定取景"断言。
const bustParams = {
  modelBaseWidth: 1000,
  modelBaseHeight: 1100,
  scaleMultiplier: 1,
  verticalOffset: 0,
  modelTransform: { scale: 1, offsetX: 0, offsetY: 0 },
  transform: { scale: 1, offsetX: 0, offsetY: -0.2 },
} as const;

describe('REFERENCE_ASPECT 等效布局高度', () => {
  it('常量为 9/16', () => {
    expect(REFERENCE_ASPECT).toBeCloseTo(0.5625, 6);
  });

  it('常规竖屏（aspect < 参考）零回归：与旧公式逐字段一致', () => {
    const tallInput: ModelLayoutInput = { width: 412, rawHeight: 900, ...bustParams };
    // 412/900 = 0.458 < 0.5625 → layoutHeight = rawHeight，行为不变
    const out = computeModelLayout(tallInput);
    expect(out.modelY - out.modelPixelHeight).toBeCloseTo(legacyTop(tallInput), 6);
  });

  it('取景对宽高比稳定：同宽下方屏与参考屏头顶位置一致（按宽锚定）', () => {
    // width=504，504/REFERENCE_ASPECT=896（整除），refTall.rawHeight=896=layoutHeight → 无亚像素舍入
    const square: ModelLayoutInput = { width: 504, rawHeight: 504, ...bustParams };
    const refTall: ModelLayoutInput = { width: 504, rawHeight: Math.round(504 / REFERENCE_ASPECT), ...bustParams };
    const topSquare = (() => { const o = computeModelLayout(square); return o.modelY - o.modelPixelHeight; })();
    const topRef = (() => { const o = computeModelLayout(refTall); return o.modelY - o.modelPixelHeight; })();
    expect(topSquare).toBeCloseTo(topRef, 4); // 新逻辑：头顶位置只随宽度，不随高度抖动
  });

  it('方屏头部回到框内（旧公式会顶出框）', () => {
    const square: ModelLayoutInput = { width: 504, rawHeight: 504, ...bustParams };
    const out = computeModelLayout(square);
    const newTop = out.modelY - out.modelPixelHeight;
    // 头顶落在可视上半区，不被裁到框外
    expect(newTop).toBeGreaterThanOrEqual(0);
    expect(newTop).toBeLessThanOrEqual(0.45 * square.rawHeight);
    // 对照：旧公式头顶为负（被 clamp 顶到框外上沿 = 头被裁）
    expect(legacyTop(square)).toBeLessThan(newTop);
  });
});

import {
  computeAutoFit,
  setPetStripFraming,
  SURFACE_FRAMING,
  type AutoFitInput,
} from './live2dEngine.ts';

describe('computeAutoFit（头部锚点自适应：脸大小/位置归一化）', () => {
  const target = { headScreenY: 0.3, faceScreenFrac: 0.16 };
  const base = {
    width: 412, rawHeight: 900,
    scaleMultiplier: 0.27, verticalOffset: 0.08,
    modelTransform: { scale: 1, offsetX: 0, offsetY: 0 },
    headAnchorY: 0.16, headSizeNorm: 0.18,
    target,
  };
  // 用 computeAutoFit 的输出回灌 computeModelLayout，校验脸落点/脸大小命中目标。
  function faceMetrics(modelBaseWidth: number, modelBaseHeight: number, headAnchorY: number, headSizeNorm: number) {
    const input: AutoFitInput = { ...base, modelBaseWidth, modelBaseHeight, headAnchorY, headSizeNorm };
    const fit = computeAutoFit(input);
    const layout = computeModelLayout({
      width: input.width, rawHeight: input.rawHeight,
      modelBaseWidth, modelBaseHeight,
      scaleMultiplier: input.scaleMultiplier, verticalOffset: input.verticalOffset,
      modelTransform: input.modelTransform, transform: { ...fit },
    });
    const layoutHeight = Math.max(input.rawHeight, input.width / REFERENCE_ASPECT);
    const modelTop = layout.modelY - layout.modelPixelHeight;
    const faceCenterPx = modelTop + headAnchorY * layout.modelPixelHeight;
    const faceHeightPx = headSizeNorm * layout.modelPixelHeight;
    return { faceCenterPx, faceHeightPx, layoutHeight };
  }

  it('脸中心命中 headScreenY*layoutHeight', () => {
    const m = faceMetrics(1000, 2000, 0.16, 0.18);
    expect(m.faceCenterPx).toBeCloseTo(target.headScreenY * m.layoutHeight, 3);
  });
  it('脸高命中 faceScreenFrac*layoutHeight', () => {
    const m = faceMetrics(1000, 2000, 0.16, 0.18);
    expect(m.faceHeightPx).toBeCloseTo(target.faceScreenFrac * m.layoutHeight, 3);
  });
  it('全身模型与半身模型收敛到同一屏幕脸大小/位置', () => {
    const fullBody = faceMetrics(1000, 2600, 0.10, 0.10); // 脸小、靠上
    const bust = faceMetrics(1000, 1200, 0.22, 0.30);     // 脸大、靠中
    expect(fullBody.faceHeightPx).toBeCloseTo(bust.faceHeightPx, 2);
    expect(fullBody.faceCenterPx).toBeCloseTo(bust.faceCenterPx, 2);
  });
});

describe('computeAutoFit 方屏：大小按 layoutHeight、位置按 rawHeight（两者分离）', () => {
  // 方屏：rawHeight(900) < width/REFERENCE_ASPECT(=900/0.5625=1600) → layoutHeight=1600≠rawHeight。
  const square = {
    width: 900, rawHeight: 900,
    modelBaseWidth: 1000, modelBaseHeight: 2000,
    scaleMultiplier: 1, verticalOffset: 0.08,
    modelTransform: { scale: 1, offsetX: 0, offsetY: 0 },
    headAnchorY: 0.16, headSizeNorm: 0.18,
    target: { headScreenY: 0.3, faceScreenFrac: 0.16 },
  } satisfies AutoFitInput;

  function metrics() {
    const fit = computeAutoFit(square);
    const layout = computeModelLayout({
      width: square.width, rawHeight: square.rawHeight,
      modelBaseWidth: square.modelBaseWidth, modelBaseHeight: square.modelBaseHeight,
      scaleMultiplier: square.scaleMultiplier, verticalOffset: square.verticalOffset,
      modelTransform: square.modelTransform, transform: { ...fit },
    });
    const top = layout.modelY - layout.modelPixelHeight;
    return {
      faceCenterPx: top + square.headAnchorY * layout.modelPixelHeight,
      faceHeightPx: square.headSizeNorm * layout.modelPixelHeight,
    };
  }

  const layoutHeight = Math.max(square.rawHeight, square.width / REFERENCE_ASPECT); // 1600

  it('脸大小按 layoutHeight（方屏放大），不是 rawHeight', () => {
    const m = metrics();
    expect(m.faceHeightPx).toBeCloseTo(square.target.faceScreenFrac * layoutHeight, 2); // 0.16*1600=256
    expect(m.faceHeightPx).not.toBeCloseTo(square.target.faceScreenFrac * square.rawHeight, 1); // ≠0.16*900
  });
  it('脸位置按 rawHeight（实际屏，不偏矮），不是 layoutHeight', () => {
    const m = metrics();
    expect(m.faceCenterPx).toBeCloseTo(square.target.headScreenY * square.rawHeight, 2); // 0.30*900=270
    expect(m.faceCenterPx).not.toBeCloseTo(square.target.headScreenY * layoutHeight, 1); // ≠0.30*1600
  });
});

// ---- 掌机底条：取景目标 vs 模型度量（本轮改造的核心论据） ----

// 底条实况：720×240 设备像素的条，模型远高于条。headAnchorY 是这只模型的**真**度量。
const stripFit = {
  width: 240,
  rawHeight: 240,
  modelBaseWidth: 1000,
  modelBaseHeight: 2000,
  scaleMultiplier: 1,
  verticalOffset: 0,
  modelTransform: { scale: 1, offsetX: 0, offsetY: 0 },
  headAnchorY: 0.05,
  headSizeNorm: 0.19,
};
/** 模型里真实的脸中心位置（从模型顶部往下的比例）。auto-fit 不一定按这个值驱动。 */
const HA_TRUE = 0.05;

/**
 * 「模型里真实的那张脸」最终落在屏幕的哪个 y（px）。
 * ★关键：auto-fit 按传进去的 headAnchorY（=**声称**的脸位置）解 offsetY，
 * 而模型内容不会因为你改了声称值就跟着动——所以声称值与真值不一致时，
 * 真脸就会偏离被钉住的那个点。老滑块就是在改这个声称值。
 */
function realFaceCenterPx(
  headSizeNorm: number,
  headAnchorYClaim: number,
  target: { headScreenY: number; faceScreenFrac: number },
): number {
  const out = computeAutoFit({
    ...stripFit,
    headSizeNorm,
    headAnchorY: headAnchorYClaim,
    target,
  });
  const layoutHeight = Math.max(stripFit.rawHeight, stripFit.width / REFERENCE_ASPECT);
  const baseScale = Math.min(
    stripFit.width / stripFit.modelBaseWidth,
    layoutHeight / stripFit.modelBaseHeight,
  );
  const totalScale = baseScale * out.scale;
  const modelPixelHeight = stripFit.modelBaseHeight * totalScale;
  const modelY = layoutHeight * (1 + out.offsetY);
  return modelY - modelPixelHeight * (1 - HA_TRUE);
}

describe('computeAutoFit：取景目标正交，模型度量不正交', () => {
  it('用真度量驱动时，改 faceScreenFrac 只动缩放，真脸位置不动', () => {
    const small = realFaceCenterPx(0.19, HA_TRUE, { headScreenY: 0.35, faceScreenFrac: 0.2 });
    const large = realFaceCenterPx(0.19, HA_TRUE, { headScreenY: 0.35, faceScreenFrac: 0.6 });
    expect(large).toBeCloseTo(small, 6);
    // 缩放确实变了（否则上面那条会因为"什么都没变"而假绿）
    const a = computeAutoFit({ ...stripFit, target: { headScreenY: 0.35, faceScreenFrac: 0.2 } });
    const b = computeAutoFit({ ...stripFit, target: { headScreenY: 0.35, faceScreenFrac: 0.6 } });
    expect(b.scale / a.scale).toBeCloseTo(3, 6);
  });

  it('改 headScreenY 只动位置，缩放不变；位移量恰好 = Δ × rawHeight（每格物理意义固定）', () => {
    const a = computeAutoFit({ ...stripFit, target: { headScreenY: 0.2, faceScreenFrac: 0.31 } });
    const b = computeAutoFit({ ...stripFit, target: { headScreenY: 0.7, faceScreenFrac: 0.31 } });
    expect(b.scale).toBeCloseTo(a.scale, 6);
    const moved =
      realFaceCenterPx(0.19, HA_TRUE, { headScreenY: 0.7, faceScreenFrac: 0.31 }) -
      realFaceCenterPx(0.19, HA_TRUE, { headScreenY: 0.2, faceScreenFrac: 0.31 });
    expect(moved).toBeCloseTo(0.5 * stripFit.rawHeight, 6);
  });

  // ★反面对照 = Ben 报的「改大小位置就跑」的数学证据。
  // 把 headAnchorY 当滑块拧到 0.15（真值 0.05）时，真脸偏离被钉住的点，
  // 偏移量 = H × (真值 − 声称值)，而 H ∝ 1/headSizeNorm ——
  // 于是"位置"的实际效果被"大小"缩放。这正是本轮要消灭的耦合。
  it('（对照）headAnchorY 当滑块用时，其位移效果被 headSizeNorm 缩放', () => {
    const target = { headScreenY: 0.35, faceScreenFrac: 0.31 };
    const pinned = target.headScreenY * stripFit.rawHeight;
    const deviate = (headSizeNorm: number) => realFaceCenterPx(headSizeNorm, 0.15, target) - pinned;
    // 声称值 ≠ 真值 → 确实偏了（不是 0，否则下面的比值无意义）
    expect(Math.abs(deviate(0.19))).toBeGreaterThan(10);
    // headSizeNorm 减半 → 模型放大一倍 → 同一个"位置档位"的实际位移也翻倍
    expect(deviate(0.095) / deviate(0.19)).toBeCloseTo(2, 4);
  });
});

describe('computeModelLayout containment（绝对构图视口包含钳制）', () => {
  const base: ModelLayoutInput = {
    width: 412,
    rawHeight: 900,
    modelBaseWidth: 1000,
    modelBaseHeight: 2000,
    scaleMultiplier: 1,
    verticalOffset: 0,
    modelTransform: { scale: 1, offsetX: 0, offsetY: 0 },
    transform: { scale: 0.7, offsetX: 0, offsetY: -0.98 },
  };

  function bounds(layout: ModelLayout) {
    return {
      top: layout.modelY - layout.modelPixelHeight,
      bottom: layout.modelY,
      left: layout.modelX - layout.modelPixelWidth * 0.5,
      right: layout.modelX + layout.modelPixelWidth * 0.5,
    };
  }

  it('配置绝对构图时模型按配置摆放（scale/offsetX/offsetY 生效）', () => {
    const out = computeModelLayout({ ...base, containment: true });
    // totalScale = baseScale * transform.scale = 0.412 * 0.7（方屏适配 layoutHeight 下）
    expect(out.totalScale).toBeCloseTo(0.412 * 0.7, 6);
    // modelY = layoutHeight * (1 + offsetY) = 900 * 0.02；模型底在画面内
    expect(out.modelY).toBeGreaterThan(0);
    const b = bounds(out);
    expect(b.top).toBeLessThan(out.modelY);
  });

  it('极端 scale=5 被视口包含钳制：模型不超过 4× 视口适配', () => {
    const out = computeModelLayout({ ...base, transform: { scale: 5, offsetX: 0, offsetY: 0 }, containment: true });
    // 不含钳制时 totalScale = 0.412*5 = 2.06 → modelPixelHeight = 4120；
    // 钳制后夹到 fitScale*4 = 1.648（模型高 ≤ 4×视口适配），且模型主体仍在画面内。
    expect(out.totalScale).toBeCloseTo(0.412 * 4, 6);
    expect(out.modelPixelHeight).toBeLessThanOrEqual(900 * 4);
    const b = bounds(out);
    // 水平/竖直主体都在视口内（顶部钳制 + 底部/水平包含保证头部可见）
    expect(b.top).toBeLessThanOrEqual(out.modelY);
    expect(b.left).toBeGreaterThanOrEqual(-out.modelPixelWidth * 0.5 + 0.5);
    expect(b.right).toBeLessThanOrEqual(412 + out.modelPixelWidth * 0.5 - 0.5);
  });

  it('极端 offsetY=±3 被包含钳制后模型主体仍留在画面内', () => {
    // 上推 3 → 模型顶部被顶部钳制拉回，头部不消失
    const up = computeModelLayout({ ...base, transform: { scale: 0.7, offsetX: 0, offsetY: -3 }, containment: true });
    expect(bounds(up).top).toBeLessThanOrEqual(0.55 * 900 + 1e-6);
    // 下压 3 → 底部/顶部钳制保证模型可见
    const down = computeModelLayout({ ...base, transform: { scale: 0.7, offsetX: 0, offsetY: 3 }, containment: true });
    expect(bounds(down).top).toBeLessThanOrEqual(0.55 * 900 + 1e-6);
    // 模型底不越出视口下沿太多（模型能整身放入时整体在视口内）
    expect(bounds(down).bottom).toBeLessThanOrEqual(900 + 1e-6);
  });

  it('水平出血：包围盒宽于屏时 offsetX 仍有行程（画布留白模型可横移）', () => {
    // scale=1.3 → modelPixelWidth = 1000×0.412×1.3 = 535.6 > 412（包围盒已宽于屏）：
    // 无出血时直接居中（offsetX 全失效）；出血 25% 屏宽后 clamp 区间 [164.8, 247.2]，
    // offsetX=±0.1 完整生效（对应 Miku 类双马尾/方画布模型的横移诉求）。
    const wide = { ...base, transform: { scale: 1.3, offsetX: 0, offsetY: 0 }, containment: true as const };
    const centered = computeModelLayout(wide);
    expect(centered.modelX).toBeCloseTo(412 * 0.5, 6);
    const leftish = computeModelLayout({ ...wide, transform: { scale: 1.3, offsetX: -0.1, offsetY: 0 } });
    expect(leftish.modelX).toBeCloseTo(412 * 0.4, 6);
    // 超出出血上限仍被夹住：offsetX=-0.5 → 夹到 164.8，包围盒最多出屏 25% 屏宽
    const extreme = computeModelLayout({ ...wide, transform: { scale: 1.3, offsetX: -0.5, offsetY: 0 } });
    expect(extreme.modelX).toBeCloseTo(535.6 / 2 - 412 * 0.25, 6);
  });

  it('极端 offsetX=±3 被水平包含钳制后模型不整体移出视口', () => {
    const left = computeModelLayout({ ...base, transform: { scale: 0.7, offsetX: -3, offsetY: 0 }, containment: true });
    const bL = bounds(left);
    expect(bL.right).toBeGreaterThanOrEqual(0);
    expect(bL.left).toBeLessThanOrEqual(412);

    const right = computeModelLayout({ ...base, transform: { scale: 0.7, offsetX: 3, offsetY: 0 }, containment: true });
    const bR = bounds(right);
    expect(bR.left).toBeLessThanOrEqual(412);
    expect(bR.right).toBeGreaterThanOrEqual(0);
  });

  it('containment=false（增量路径）行为与改动前逐字段一致', () => {
    const noContain = computeModelLayout({ ...base, transform: { scale: 1, offsetX: 0, offsetY: -0.2 } });
    const legacy = legacyTop({ ...base, transform: { scale: 1, offsetX: 0, offsetY: -0.2 } });
    expect(noContain.modelY - noContain.modelPixelHeight).toBeCloseTo(legacy, 6);
    expect(noContain.totalScale).toBeCloseTo(0.412, 6);
  });
});

describe('setPetStripFraming', () => {
  it('就地改 SURFACE_FRAMING.petStrip，两条渲染路径下次取值即生效', () => {
    const before = { ...SURFACE_FRAMING.petStrip };
    setPetStripFraming({ headScreenY: 0.55, faceScreenFrac: 0.42 });
    expect(SURFACE_FRAMING.petStrip.headScreenY).toBe(0.55);
    expect(SURFACE_FRAMING.petStrip.faceScreenFrac).toBe(0.42);
    // topClampMin 是这条预设的命根子（底条位置滑块死因之一），不能被顺手抹掉
    expect(SURFACE_FRAMING.petStrip.topClampMin).toBe(before.topClampMin);
    setPetStripFraming(before);
    expect(SURFACE_FRAMING.petStrip.headScreenY).toBe(before.headScreenY);
  });

  it('非数字/NaN 不写入（坏值一旦进去整条底条构图就崩）', () => {
    const before = { ...SURFACE_FRAMING.petStrip };
    setPetStripFraming({ headScreenY: Number.NaN, faceScreenFrac: undefined });
    expect(SURFACE_FRAMING.petStrip.headScreenY).toBe(before.headScreenY);
    expect(SURFACE_FRAMING.petStrip.faceScreenFrac).toBe(before.faceScreenFrac);
  });
});
