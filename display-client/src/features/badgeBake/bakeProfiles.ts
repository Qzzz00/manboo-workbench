/* 烘焙档位（profile）：一次待机烘焙的全部输入契约。
 *
 * 设计约束（spec 2026-07-07-badge-app-bake-preview-design.md §2）：
 * - 吧唧档 BADGE_PROFILE 固定 2.6s/10fps=26帧/466方形——PSRAM 预载 ~3.4MB 的帧预算墙，
 *   不是软限制；驱动用 F2 真机验证过的 sine 配方（见 bakeDriver SINE_BADGE_F2）。
 * - 魔力卡档 CARD_PROFILE=16s/60fps/motion+wobble/384×640 竖屏原生（M11 定稿配方），
 *   本期不投放，收编进同一库供卡通道接入时直接用。
 * - view.stageScale/OffsetX：把 466 方形取景放大裁切到目标分辨率（渲染层直出=不糊，
 *   构图与 ffmpeg scale+crop 等价；466 方形则恒等变换）。
 */

export type BakeDriverConfig =
  | { kind: 'sineBadgeF2' }
  | { kind: 'motion'; url: string; wobble: boolean; loopMult: number;
      /** 逐参数幅度带：value → center + (value-center)×scale。吧唧用它把 authored 全幅
       * 呼吸（翅膀=delta 大头）收进 F2 真机验证的「半开微动」带，PSRAM 预算的关键杠杆 */
      paramBand?: Record<string, { center: number; scale: number }> }
  /** Tier B：模型无 loop-authored idle 时，自然摆动层单独驱动（= 这些模型在 App 里的原生
   * 待机观感——库 CubismBreath 摆动本来就是它们的全部动）+ 程序化眨眼。
   * ampScale/localized=省预算档（spec 2026-07-10 预算内烘焙），语义见 wobbleDriver */
  | { kind: 'wobble'; periodS: number; ampScale?: number; localized?: boolean; blink?: boolean }
  /** 工具页实验逃生口：调用方自带求值闭包（周期由 resolved 侧给定） */
  | { kind: 'custom'; periodS: number; evalParams: (tSec: number) => Array<[string, number]>; evalEyes: (tSec: number) => Array<[string, number]> };

export type BakeView = {
  w: number;
  h: number;
  /** 舞台渲染缩放（1=恒等）；构图 = 466 方形按 scale 放大后平移 offsetX/offsetY 再裁到 w×h */
  stageScale: number;
  stageOffsetX: number;
  /** 垂直平移（负=上移，半身构图用）；缺省 0 与旧档位兼容 */
  stageOffsetY?: number;
};

export type BakeProfile = {
  fps: number;
  driver: BakeDriverConfig;
  view: BakeView;
  /** 每帧硬写参数（beforeModelUpdate 终审位），如换装 Param67=1；烘焙期间恒定 */
  pins?: Array<[string, number]>;
  /** 口型套件：idle 采集后在同一 patch 上下文里采 region+5档+逐帧锚点（A1 方案的素材面） */
  mouth?: { enabled: boolean };
  /** 预热圈数上限（缺省=证书级 60；组件档 6——小卡慢摆不需无缝证书，手机烤制求快） */
  warmupMaxCycles?: number;
};

/** 吧唧档基座（driver 由调用方按角色探测注入——Tier A 动作驱动 / Tier B 摆动驱动）。
 * 20fps×8s=160 帧（2026-07-10 flash 流式播放拆掉 PSRAM 预载墙后 Ben 提帧：10fps 观感
 * 「已经很卡」，20fps 接近预览顺滑；TE 分频 60/3 整除，流式实测余量 2× 档）。
 * T=8s 物理必收敛（魔力卡 M6/M8 实证 5-8 圈残差 0.003），证书才有干净 ✅。
 * F2 短周期（2.6s）实测物理闭不上（残差 4.5+/60 圈、接缝 7.09>全序列最大 6.54）——
 * 短周期近静配方（sineBadgeF2）保留作研究基线，不再是投放档。 */
export const BADGE_PROFILE_BASE: Omit<BakeProfile, 'driver'> = {
  fps: 20,
  view: { w: 466, h: 466, stageScale: 1, stageOffsetX: 0 },
};

const CARD_H_SCALE = 640 / 466;

/** 魔力卡档：M11 定稿（idle.motion3×2 + 自然摆动层 + 竖屏原生）。 */
export const CARD_PROFILE: BakeProfile = {
  fps: 60,
  driver: { kind: 'motion', url: '/live2D/shuangsheng/motions/idle.motion3.json', wobble: true, loopMult: 2 },
  view: { w: 384, h: 640, stageScale: CARD_H_SCALE, stageOffsetX: -(466 * CARD_H_SCALE - 384) / 2 },
};
