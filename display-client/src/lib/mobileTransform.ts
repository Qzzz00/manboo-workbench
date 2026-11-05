import type { AvatarManifest } from '../features/live2d/avatarManifest.ts';
import type { StageTransform } from '../features/live2d/live2dEngine.ts';
import type { StageFraming } from '../features/live2d/types.ts';

/** 自适应基准上的「无微调」增量：scale=1（乘）、offset=0（加）。 */
export const IDENTITY_DELTA: StageTransform = { scale: 1, offsetX: 0, offsetY: 0 };

// 绝对构图包装缓存：同一 framing 对象缓存同一 StageTransform 引用，
// 避免 React 层每次渲染（personaTransform 等）新建对象触发 Live2DStage 的 transform effect 反复 refit。
const absoluteFramingCache = new WeakMap<StageFraming, StageTransform>();

/** 把后台配置的单场景构图包装成「绝对构图」stage transform（供 homeFramingFor/loginFramingFor/djTarget 返回）。
 *  缺失（未配置）返回 undefined，调用方回落 IDENTITY_DELTA（auto-fit 增量语义）。
 *  放本文件（不依赖 pixi）便于纯函数单测与 EndingScene 等组件复用。 */
export function absoluteFramingFor(framing: StageFraming | undefined): StageTransform | undefined {
  if (!framing) return undefined;
  let cached = absoluteFramingCache.get(framing);
  if (!cached) {
    cached = { scale: framing.scale, offsetX: framing.offsetX, offsetY: framing.offsetY, absolute: true };
    absoluteFramingCache.set(framing, cached);
  }
  return cached;
}

/** 主页构图：后台配置 homeFraming 优先（绝对构图），未配置回落 IDENTITY_DELTA（auto-fit）。纯函数，便于单测。 */
export function resolveHomeFraming(avatar: { homeFraming?: StageFraming }): StageTransform {
  return absoluteFramingFor(avatar.homeFraming) ?? IDENTITY_DELTA;
}

/** 登录页构图：loginFraming → homeFraming → IDENTITY_DELTA 逐级回落。纯函数，便于单测。 */
export function resolveLoginFraming(
  avatar: { loginFraming?: StageFraming; homeFraming?: StageFraming },
): StageTransform {
  return absoluteFramingFor(avatar.loginFraming ?? avatar.homeFraming) ?? IDENTITY_DELTA;
}

/** DJ 页构图：后台配置 djFraming 优先（绝对构图），未配置回落 IDENTITY_DELTA。纯函数，便于单测。 */
export function resolveDjFraming(avatar: { djFraming?: StageFraming }): StageTransform {
  return absoluteFramingFor(avatar.djFraming) ?? IDENTITY_DELTA;
}

const STORAGE_KEY = 'llm-live2d:mobile-offsets';

function loadOffsets(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
  } catch {
    return {};
  }
}

export function saveMobileOffset(avatarId: string, delta: number) {
  const offsets = loadOffsets();
  offsets[avatarId] = (offsets[avatarId] || 0) + delta;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(offsets));
}

export function calcMobileTransform(avatar: AvatarManifest): StageTransform {
  const yumiScaleMultiplier = 0.27;
  const yumiVerticalOffset = 0.08;
  const targetScale = 0.83;
  const targetOffsetY = -0.82;
  const scale = targetScale * (yumiScaleMultiplier / avatar.scaleMultiplier) * (avatar.mobileScale ?? 1);
  const savedDelta = loadOffsets()[avatar.id] || 0;
  const offsetY = targetOffsetY - (yumiVerticalOffset - avatar.verticalOffset) + savedDelta + (avatar.mobileInitialOffsetY ?? 0);
  return { scale, offsetX: 0, offsetY };
}
