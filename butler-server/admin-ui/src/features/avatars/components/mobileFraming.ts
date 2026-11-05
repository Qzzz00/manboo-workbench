// 来源:Aiboo origin/main 1f430c3f admin-ui/src/features/avatars/components/mobileFraming.ts
/**
 * 移动端 home 构图数学：从主项目 src/features/live2d/live2dEngine.ts 移植的纯函数，
 * 让 Admin 预览与角色在手机上的真实位置一致。
 *
 * 客户端 home 构图链路（零依赖 PIXI）：
 *   ① computeAutoFit → 头部锚点自适应基准 transform
 *   ② React 侧 home framing = IDENTITY_DELTA（增量为零），故 effective == autoBase
 *   ③ computeModelLayout(effective) → 最终 totalScale / modelX / modelY，模型 anchor(0.5,1)
 *
 * headAnchorY/headSizeNorm 客户端默认 0.16/0.18（纯 auto-fit，不读 DB），此处保持一致。
 */

export const REFERENCE_ASPECT = 9 / 16;

/** 各界面取景目标（对齐 live2dEngine SURFACE_FRAMING）。预览只用 home。 */
export const HOME_FRAMING = { headScreenY: 0.3, faceScreenFrac: 0.19 };

export const DEFAULT_HEAD_ANCHOR_Y = 0.16;
export const DEFAULT_HEAD_SIZE_NORM = 0.18;

/** 老角色 DB transform 没有 modelTransform；客户端兜底为中性值（avatarData.ts），此处一致。 */
export const NEUTRAL_MODEL_TRANSFORM = { scale: 1, offsetX: 0, offsetY: 0 };

type ModelTransform = { scale: number; offsetX: number; offsetY: number };

export type MobileFramingInput = {
  /** 画布像素尺寸（预览容器 clientWidth/Height）。 */
  width: number;
  rawHeight: number;
  /** 模型在 scale=1 时的固有像素宽高（预览加载后由 model.width/height 得到）。 */
  modelBaseWidth: number;
  modelBaseHeight: number;
  scaleMultiplier: number;
  verticalOffset: number;
  /** 缺省（老角色）时按 NEUTRAL_MODEL_TRANSFORM 兜底。 */
  modelTransform?: ModelTransform;
  headAnchorY?: number;
  headSizeNorm?: number;
};

export type MobileLayout = { totalScale: number; modelX: number; modelY: number };

/** 入口归一化后的输入：可选项已全部填了默认值。 */
type ResolvedFramingInput = MobileFramingInput & {
  modelTransform: ModelTransform;
  headAnchorY: number;
  headSizeNorm: number;
};

// —— 移植：computeAutoFit（live2dEngine.ts）——
function computeAutoFit(input: ResolvedFramingInput): ModelTransform {
  const { width, rawHeight, modelBaseWidth, modelBaseHeight, scaleMultiplier, verticalOffset, modelTransform, headAnchorY, headSizeNorm } = input;
  if (!(modelBaseWidth > 0) || !(modelBaseHeight > 0)) return { scale: 1, offsetX: 0, offsetY: 0 };
  const layoutHeight = Math.max(rawHeight, width / REFERENCE_ASPECT);
  const baseScale = Math.min(width / modelBaseWidth, layoutHeight / modelBaseHeight);
  const fixedScale = baseScale * scaleMultiplier * modelTransform.scale;

  const denom = modelBaseHeight * headSizeNorm * fixedScale;
  const scale = denom > 0 ? (HOME_FRAMING.faceScreenFrac * layoutHeight) / denom : 1;

  const totalScale = fixedScale * scale;
  const modelPixelHeight = modelBaseHeight * totalScale;
  const desiredFaceCenter = HOME_FRAMING.headScreenY * rawHeight;
  const desiredModelY = desiredFaceCenter + modelPixelHeight * (1 - headAnchorY);
  const offsetY = desiredModelY / layoutHeight - (1 - verticalOffset + modelTransform.offsetY);

  return { scale, offsetX: 0, offsetY };
}

// —— 移植：computeModelLayout（live2dEngine.ts）——
function computeModelLayout(
  input: ResolvedFramingInput & { transform: ModelTransform },
): MobileLayout {
  const { width, rawHeight, modelBaseWidth, modelBaseHeight, scaleMultiplier, verticalOffset, modelTransform, transform } = input;
  const layoutHeight = Math.max(rawHeight, width / REFERENCE_ASPECT);

  const baseScale = Math.min(width / modelBaseWidth, layoutHeight / modelBaseHeight);
  const totalScale = baseScale * scaleMultiplier * modelTransform.scale * transform.scale;

  const modelX = width * (0.5 + modelTransform.offsetX + transform.offsetX);
  let modelY = layoutHeight * (1 - verticalOffset + modelTransform.offsetY + transform.offsetY);

  const modelPixelHeight = modelBaseHeight * totalScale;
  const top = modelY - modelPixelHeight;
  const clampedTop = Math.min(Math.max(top, -0.2 * rawHeight), 0.55 * rawHeight);
  if (clampedTop !== top) modelY = clampedTop + modelPixelHeight;

  return { totalScale, modelX, modelY };
}

/**
 * 端到端：算出与手机 home 画面一致的最终布局。
 * 模型需 anchor(0.5, 1)（底部居中），与客户端一致。
 */
export function computeMobileHomeLayout(input: MobileFramingInput): MobileLayout {
  const resolved = {
    ...input,
    modelTransform: input.modelTransform ?? NEUTRAL_MODEL_TRANSFORM,
    headAnchorY: input.headAnchorY ?? DEFAULT_HEAD_ANCHOR_Y,
    headSizeNorm: input.headSizeNorm ?? DEFAULT_HEAD_SIZE_NORM,
  };
  // home framing 增量为零（IDENTITY_DELTA），effective == autoBase。
  const effective = computeAutoFit(resolved);
  return computeModelLayout({ ...resolved, transform: effective });
}
