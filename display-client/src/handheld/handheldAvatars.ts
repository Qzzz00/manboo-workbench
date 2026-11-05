/**
 * 掌机可选角色清单的**数据层**（持久化本身在 handheldSettingsStore）。
 *
 * 形状照 src/radio/radioDjAvatar.ts：注册表 + 未知 id 回落第一只。
 * ★别把 transform 散在组件里——电台侧就是这么收敛的，三只各一行、想单独微调也方便。
 */
import type { StageTransform } from '../features/live2d/live2dEngine.ts';
import type { ParameterOverride } from '../features/live2d/types.ts';
import { djModelFor } from '../features/live2d/djModels.ts';

/**
 * 底条取景目标（**屏幕空间**）。
 *   headScreenY    = 脸中心落在条高的哪个比例位置，越大越靠下
 *   faceScreenFrac = 脸高占条高的比例，越大角色越大
 * ★这两个在 computeAutoFit 里天然正交（位置基准是 rawHeight，与缩放无关）。
 * 老的 headSizeNorm/headAnchorY 是**模型固有度量**，不是取景旋钮——用它们当滑块，
 * 位置灵敏度会被大小缩放（位移 = Δha × modelPixelHeight ∝ 1/headSizeNorm），
 * 那就是 Ben 报的「改大小位置就跑」。详见 spec §1 与 modelLayout.test.ts 的正交性用例。
 */
export type StripFraming = { headScreenY: number; faceScreenFrac: number };

export type HandheldAvatarOption = {
  /** avatarData 里的 id */
  id: string;
  /** 设置页按钮上的短名（中文，Ben 面向的是自用桌面不是国际化产品） */
  label: string;
  /** 换装参数（双生 Param67=1）。每帧硬写，不写就是没换装的默认皮。 */
  costume: ParameterOverride[];
  /** 主页大角色构图增量（叠在 auto-fit 之上）。★每只必须单独标：offsetY 是加性的、
   *  scale 是乘性的，而三只「总高/脸高」比值不同，同一组值缩放后位移就不同。 */
  homeTransform: StageTransform;
  /** 底条头部度量覆盖。★仅在 avatarData 缺真值时给（目前只有双生）。 */
  stripFramingHead?: { headSizeNorm: number; headAnchorY: number };
  /** 底条取景默认目标。用户在设置页调过之后存进 handheldSettingsStore，按角色分别记。 */
  stripFraming: StripFraming;
  /** loading 剪影占位图（原图，剪影效果由 CSS filter 出，见 pet.css）。 */
  silhouette: string;
};

// 双生换装参数：唯一真相源是 djModels，这里**取**而不抄一份（另抄迟早漂）。
const SHUANGSHENG_COSTUME: ParameterOverride[] =
  djModelFor('shuangsheng')?.costume.map((c) => ({ id: c.id, value: c.value })) ?? [];

/**
 * 三只共用的底条取景默认值 = `SURFACE_FRAMING.petStrip` 的预设值。
 * ★之所以能共用：auto-fit 已经按各自的 headSizeNorm/headAnchorY 归一化过了，
 * 同一组屏幕空间目标对三只给出的是「脸一样大、在同一位置」。
 * ★之所以是这两个数：双生代入真度量(0.19/0.05)后与改造前的成像等价 → 零视觉变化。
 */
export const DEFAULT_STRIP_FRAMING: StripFraming = { headScreenY: 0.35, faceScreenFrac: 0.31 };

export const HANDHELD_AVATAR_OPTIONS: HandheldAvatarOption[] = [
  {
    id: 'shuangsheng-dj',
    label: '双生 DJ',
    costume: SHUANGSHENG_COSTUME,
    // 现值不动：这组是 7-29 真机标的，Ben 没抱怨过主页。
    homeTransform: { scale: 0.88, offsetX: 0, offsetY: 0.04 },
    // avatarData 没填 → 兜底 0.18/0.16 不是它的真比例。真值：全身人形头占约 1/8，
    // 脸中心落在模型顶下方 5%（ha 从模型顶部往下量，因为 anchor=(0.5,1)）。
    stripFramingHead: { headSizeNorm: 0.19, headAnchorY: 0.05 },
    stripFraming: DEFAULT_STRIP_FRAMING,
    silhouette: './live2D/shuangsheng-dj/strip-silhouette.png',
  },
  {
    id: 'ghostpuppy',
    label: '幽灵狗',
    costume: [],
    // 7-29 真机逐版量的方屏值。标度参考：offsetY 每 0.07 ≈ 移动 120px @720 屏。
    homeTransform: { scale: 1.45, offsetX: 0, offsetY: 0.14 },
    stripFraming: DEFAULT_STRIP_FRAMING,
    silhouette: './live2D/ghostpuppy/strip-silhouette.png',
  },
  {
    id: 'tororo',
    label: '小白猫',
    costume: [],
    // 浏览器 480×480 预标；真机会偏上约 7% 屏高，Ben 那边看着不对就报。
    homeTransform: { scale: 1.2, offsetX: 0, offsetY: 0.1 },
    stripFraming: DEFAULT_STRIP_FRAMING,
    silhouette: './live2D/tororo/strip-silhouette.png',
  },
];

export const DEFAULT_HANDHELD_AVATAR_ID = HANDHELD_AVATAR_OPTIONS[0].id;

export function isValidHandheldAvatarId(id: string | null | undefined): boolean {
  return !!id && HANDHELD_AVATAR_OPTIONS.some((o) => o.id === id);
}

/** 取某只角色的配置；未知 id → 第一只（绝不返回 undefined 让构图崩掉）。 */
export function handheldAvatarFor(id: string | null | undefined): HandheldAvatarOption {
  return HANDHELD_AVATAR_OPTIONS.find((o) => o.id === id) ?? HANDHELD_AVATAR_OPTIONS[0];
}
