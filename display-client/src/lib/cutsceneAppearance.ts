// 形象继承状态 → Live2D 服饰覆盖（换装/发型）的解析。
// M1 桩：调色板为空（真实 costume_id→参数目录随 journey 定义，M-later 填充）。
// 伤痕(scar_id)预留字段，等 Live2D 模型 damage 层支持后再解析。

export interface AppearanceState {
  costume_id?: string;
  hairstyle_id?: string;
  scar_id?: string | null;
}

export interface ResolvedApparel {
  id: string;
  costumeParamOverrides: { id: string; value: number }[];
}

// costume_id → Live2D 参数覆盖目录。M1 空；后续按角色 wardrobe 填。
const COSTUME_CATALOG: Record<string, { id: string; value: number }[]> = {};

export const APPEARANCE_APPAREL_ID = 'journey-appearance';

// 解析出可喂给 presence.setApparel 的服饰；无已知映射时返回 null（M1 桩不产生可见变化，但状态已持久）。
export function resolveAppearanceApparel(appearance: AppearanceState | null | undefined): ResolvedApparel | null {
  if (!appearance || !appearance.costume_id) return null;
  const overrides = COSTUME_CATALOG[appearance.costume_id];
  if (!overrides || !overrides.length) return null;
  return { id: APPEARANCE_APPAREL_ID, costumeParamOverrides: overrides };
}
