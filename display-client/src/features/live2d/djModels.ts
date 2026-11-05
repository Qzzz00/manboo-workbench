// 角色 → DJ 专用完整模型 + 换装参数 + 构图。
// 聊天/默认用轻量模型；DJ 模式与屏保 DJ 用完整模型并换装（单参数 Param67=1）。
// DjMode（App 内）与 Live2DScene（屏保）共用，避免两处映射漂移。
import type { StageTransform } from './live2dEngine.ts';

export type DjModelConfig = {
  /** 渲染用的完整模型 avatar id（注册在 avatarData）。 */
  modelAvatarId: string;
  /** 换装持久参数（每帧硬写），如 [{ id: 'Param67', value: 1 }]。 */
  costume: { id: string; value: number }[];
  /** 构图：完整模型比例与轻量版不同，这是真机拖好的值（屏保用它、DjMode 作默认）。 */
  transform?: StageTransform;
};

// 双生的换装/构图只此一份，变体条目共用，避免两处漂移。
const SHUANGSHENG_COSTUME = [{ id: 'Param67', value: 1 }];
// X08A 不显示黑色 DJ/万圣节装：只把换装参数归零，模型、动作与全部物理仍是完整版本。
const SHUANGSHENG_BASE_COSTUME = [{ id: 'Param67', value: 0 }];
// 真机拖定（2026-06）：完整模型上移居中
const SHUANGSHENG_DJ_TRANSFORM: StageTransform = { scale: 0.6275, offsetX: 0, offsetY: -1.15 };

export const DJ_MODEL_MAP: Record<string, DjModelConfig> = {
  shuangsheng: {
    modelAvatarId: 'shuangsheng-dj',
    costume: SHUANGSHENG_COSTUME,
    transform: SHUANGSHENG_DJ_TRANSFORM,
  },
  // ★弱机变体（完整模型 + 物理 30Hz，见 avatarData 的 shuangsheng-p30）。
  // 本表以「对话/选中的角色 id」为键，漏登记的后果是静默的：djModelFor 返回 null →
  // costumeOverrides 变空数组 → 换装完全不发生，但模型照常渲染、日志无任何异常。
  // 真机踩过（tsv 换 id 后双击切不出 DJ 装）。新增任何双生变体条目都必须同步登记到这里。
  'shuangsheng-p30': {
    // holo 直接渲染选中的 avatar，故渲染目标就是它自己。
    modelAvatarId: 'shuangsheng-p30',
    costume: SHUANGSHENG_COSTUME,
    transform: SHUANGSHENG_DJ_TRANSFORM,
  },
  // X08A 完整模型变体：68 条物理链降到 20Hz，并隐藏黑色 DJ/万圣节装。
  'shuangsheng-p20': {
    modelAvatarId: 'shuangsheng-p20',
    costume: SHUANGSHENG_BASE_COSTUME,
    transform: SHUANGSHENG_DJ_TRANSFORM,
  },
};

/** 把对话/启用角色映射到其 DJ 完整模型配置（没有则 null）。 */
export function djModelFor(avatarId: string): DjModelConfig | null {
  return DJ_MODEL_MAP[avatarId] ?? null;
}

/** 反查：正在渲染的完整模型 id 对应的 DJ 配置（屏保按 avatarId 反查换装/构图）。 */
export function djConfigForModelAvatar(modelAvatarId: string): DjModelConfig | null {
  for (const key of Object.keys(DJ_MODEL_MAP)) {
    if (DJ_MODEL_MAP[key].modelAvatarId === modelAvatarId) return DJ_MODEL_MAP[key];
  }
  return null;
}
