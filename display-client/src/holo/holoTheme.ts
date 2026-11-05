/**
 * 全息屏昼夜主题（纯逻辑，可单测）：
 *   - 白天 day  ：白底黑字 + DJ 换装（shuangsheng-dj，Param67=1）——现状。
 *   - 黑夜 night ：黑底白字 + 初始态（Param67=0）+ 试穿外套（Param57，毛衣观感，值真机标定）。
 * 切换入口 = 双击角色（见 HoloApp）。副作用（DOM data 属性 / presence 换装）全部交给调用侧，
 * 本模块零渲染/零 IO（localStorage 经 try/catch 软降级），可被 vitest(node 环境) 锁死。
 */
import type { ParameterOverride } from '../features/live2d/avatarManifest.ts';

export type HoloTheme = 'day' | 'night';

const STORAGE_KEY = 'holo:theme';

/**
 * 夜间换装：显式把换装 Param67 归 0（脱掉 DJ 装、回初始形象），并试穿外套 Param57=1
 * 制造「毛衣」观感。★Param57 的具体值待真机标定★，不合适就调这一处。
 */
export const NIGHT_COSTUME_OVERRIDES: ParameterOverride[] = [
  { id: 'Param67', value: 0 },
  { id: 'Param57', value: 1 },
];

/** 昼夜互切。 */
export function toggleTheme(theme: HoloTheme): HoloTheme {
  return theme === 'day' ? 'night' : 'day';
}

/** 从 localStorage 读上次主题；无 storage / 非法值一律回 'day'（现状白天）。 */
export function loadHoloTheme(): HoloTheme {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) === 'night' ? 'night' : 'day';
  } catch {
    return 'day';
  }
}

/** 持久化主题（常开设备重启保留）；无 storage 静默降级。 */
export function saveHoloTheme(theme: HoloTheme): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, theme);
  } catch {
    /* SSR / 隐私模式无 storage，忽略 */
  }
}

/**
 * 决定当前主题该挂哪层换装（HoloStage 据此 setApparel / removeApparel）。
 * 两层互斥：夜挂 night、日挂 dj。返回 null 表示该层应被移除。
 *   - 白天：挂 DJ 换装（djView ramp 提供的 overrides，空数组则不挂）。
 *   - 黑夜：挂夜间换装（初始 + 外套），DJ 换装移除。
 */
export function resolveThemeApparel(
  theme: HoloTheme,
  djCostumeOverrides: ParameterOverride[],
): { dj: ParameterOverride[] | null; night: ParameterOverride[] | null } {
  if (theme === 'night') {
    return { dj: null, night: NIGHT_COSTUME_OVERRIDES };
  }
  return {
    dj: djCostumeOverrides.length > 0 ? djCostumeOverrides : null,
    night: null,
  };
}
