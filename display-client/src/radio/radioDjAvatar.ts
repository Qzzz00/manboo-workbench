/**
 * 电台 DJ 角色的可选清单与持久化选择。
 *
 * 这三只都是 avatarData 里 listedInDrawer:false 的「模型专用」条目（不在主 App 选人抽屉露出），
 * 只有电台按 id 取用。清单写死在这里而不是扫 avatars——电台包里只随包这三只（见 u3 资源裁剪），
 * 列出主 App 的角色会指向没进包的模型。
 */

import type { StageTransform } from '../features/live2d/live2dEngine.ts';

export type RadioDjOption = {
  id: string;
  /** 设置页按钮上的短名（中文，Ben 面向的是自用桌面不是国际化产品）。 */
  label: string;
  /**
   * 主界面九宫格「live2d 卡片洞」里的构图（DJ 页不需要，那页 auto-fit 基线直接就位）。
   * ★为什么必须 per-model：transform.offsetY 是加性的（屏高比例），而 scale 是乘性的——
   * 三只模型的「总高/脸高」比值不同（headSizeNorm 各异），同一个 offsetY 缩放后产生的实际位移就不同，
   * 于是 DJ 页对齐的三只到了卡片里会各自错位。分开写是最省事的解法（也方便单独微调某一只）。
   */
  cardTransform: StageTransform;
};

export const RADIO_DJ_OPTIONS: RadioDjOption[] = [
  // 小黑猫替掉了原来的 tororo 小白猫（Ben 换角）。两只是同一套骨架只换贴图，故构图值直接沿用。
  // 要换回小白猫：把 id 改回 'tororo'、label 改回 '小白猫'（avatarData 里 tororo 条目与
  // public/live2D/tororo 资源都还在），并同步把 android/app/build.gradle 的
  // ignoreAssetsPatterns 里的 "!tororo" 去掉，否则 u3 包里没有这只的模型文件。
  { id: 'hijiki', label: '小黑猫', cardTransform: { scale: 0.63, offsetX: 0.246, offsetY: -0.3 } },
  { id: 'ghostpuppy', label: '幽灵狗', cardTransform: { scale: 0.54, offsetX: 0.246, offsetY: -0.28 } },
  // 小幽灵：headSizeNorm 放大后整只变大，飘带本来就会溢出卡片右缘（无所谓，是飘带尾巴），
  // 但「头」被卡片左缘切了 → offsetX 右移把头整个收进卡片，飘带继续溢出。
  { id: 'ghostie', label: '小幽灵', cardTransform: { scale: 0.60, offsetX: 0.252, offsetY: -0.30 } },
];

/** 取某只角色的卡片构图；未知 id → 默认那只的（绝不返回 undefined 让构图崩掉）。 */
export function cardTransformFor(id: string): StageTransform {
  return (RADIO_DJ_OPTIONS.find((o) => o.id === id) ?? RADIO_DJ_OPTIONS[0]).cardTransform;
}

export const DEFAULT_RADIO_DJ_ID = RADIO_DJ_OPTIONS[0].id;

const STORAGE_KEY = 'aiboo:radio-dj-avatar';

export function isValidRadioDjId(id: string | null | undefined): boolean {
  return !!id && RADIO_DJ_OPTIONS.some((o) => o.id === id);
}

/** 读上次选的 DJ；没存过/存了已下架的 id → 回落默认（绝不返回不在包里的模型 id）。 */
export function loadRadioDjId(): string {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (isValidRadioDjId(saved)) return saved as string;
  } catch { /* 隐私模式/存储不可用 → 默认 */ }
  return DEFAULT_RADIO_DJ_ID;
}

export function saveRadioDjId(id: string): void {
  if (!isValidRadioDjId(id)) return;
  try { localStorage.setItem(STORAGE_KEY, id); } catch { /* 存不了不影响本次会话 */ }
}
