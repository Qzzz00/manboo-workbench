/**
 * 全息屏角色舞台：把原本散在 App.tsx 里的「DJ 换装 + 升起 + 构图」编排收进一个组件，
 * 只服务 holo。搬线不改引擎——底层仍是共享的 Live2DStage / useDjMode / presence。
 *
 * holo 恒处于 DJ 模式：所以这里的 Live2DStage props 全部固定成 DJ/holo 取值（不再有
 * `djModeOpen ? … : …` 三元）。换装唯一进模型的通道 = presence 服饰层的 costumeParamOverrides。
 */
import { useCallback, useEffect, useRef } from 'react';
import { Live2DStage } from '../features/live2d/Live2DStage.tsx';
import { IDENTITY_DELTA } from '../lib/mobileTransform.ts';
import type { AvatarManifest, ExpressionLayer, ParameterOverride } from '../features/live2d/avatarManifest.ts';
import type { PresenceStore } from '../features/live2d/presence/presenceStore.ts';
import type { RuntimeState } from '../features/live2d/live2dEngine.ts';
import type { DjModeView } from '../hooks/useDjMode.ts';
import { resolveThemeApparel, type HoloTheme } from './holoTheme.ts';
import { resolveHoloNativeTargetFps } from './holoStage.ts';

const EMPTY_EXPRESSION_MIX: ExpressionLayer[] = [];
const EMPTY_PARAM_OVERRIDES: ParameterOverride[] = [];

// 房间背景按主题走「反差」配对（Ben 定的，同时正好解决可读性）：
//   白天 = 黑紫 DJ 裙 + 深灰字(--holo-ink #404040) → 需要亮底 → 白粉房间
//   夜间 = 粉睡裙+外套 + 白字(#f2f2f2)            → 需要暗底 → 暗紫房间
// 原生模式下由 GL 层画（setBackground 的 assetPath），不经 DOM，不会挡住角色。
// 非原生（全息屏浏览器）holo.css 仍把 .stage-bg 隐藏，保持白/黑纯底不变。
const ROOM_BG: Record<HoloTheme, string> = {
  day: '/backgrounds/holo-room-day.jpg',
  night: '/backgrounds/holo-room-night.jpg',
};

export interface HoloStageProps {
  /** 实际渲染的模型（换装靠 Param67 叠在同一模型上，不换 avatar）。 */
  avatar: AvatarManifest;
  /** 形象合成器：DJ 换装 override 写进服饰层。 */
  presence: PresenceStore;
  /** 已合成的服饰参数（= composed.costumeParamOverrides），holo 唯一进模型的换装通道。 */
  costumeParamOverrides: ParameterOverride[];
  /** DJ 引擎视图：口型能量 + 换装 ramp + 升起编排。 */
  djView: DjModeView;
  /** 昼夜主题：day=DJ 换装(Param67=1)；night=初始+外套。决定挂哪层服饰。 */
  theme: HoloTheme;
  /** 拿到 runtime（供 v2 profile 绑定等，可选）。 */
  onRuntimeReady?: (runtime: RuntimeState) => void;
  /** 背景覆盖：不给就按 theme 走 holo 的昼夜房间配对。展示台用自己的底图。 */
  backgroundUrl?: string;
  /** 分数基准视口。宿主把角色放进子区域时（展示台左列）必须传整屏尺寸。 */
  viewportSize?: { width: number; height: number };
}

export function HoloStage({ avatar, presence, costumeParamOverrides, djView, theme, onRuntimeReady, backgroundUrl, viewportSize }: HoloStageProps) {
  const nativeTargetFps = resolveHoloNativeTargetFps(
    typeof window === 'undefined' ? '' : window.location.search,
  );

  // 按主题分流换装（两层互斥）：
  //   白天 → dj-costume（Param67 ramp，退场归零即移除）；
  //   黑夜 → night-costume（Param67=0 回初始 + 外套）。
  useEffect(() => {
    const { dj, night } = resolveThemeApparel(theme, djView.costumeOverrides);
    if (dj) presence.setApparel({ id: 'dj-costume', costumeParamOverrides: dj });
    else presence.removeApparel('dj-costume');
    if (night) presence.setApparel({ id: 'night-costume', costumeParamOverrides: night });
    else presence.removeApparel('night-costume');
  }, [presence, djView.costumeOverrides, theme]);

  // holo 恒 DJ：模型就绪即启动「升起+换装」编排。markReady 幂等（setReady(true)），
  // mount 与 stage onReady 各调一次都安全。用 ref 兜住 djView 身份，避免每次渲染重跑 effect。
  const djRef = useRef(djView);
  djRef.current = djView;
  const stageReadyRef = useRef(false);
  const markStageReady = useCallback(() => {
    stageReadyRef.current = true;
    djRef.current.markReady();
  }, []);
  useEffect(() => {
    markStageReady();
  }, [markStageReady]);

  // ★启动竞态兜底（真机踩过：双击切不出 DJ 装，一直是睡裙）。
  // useDjMode 在 open=false 期间会复位 ready，而 holo 的 open = 「自动登录已完成」——
  // 本组件开机即挂载、模型往往在登录回来之前就绪，那一次 markReady 被复位掉之后
  // **没有任何东西会再喂第二次**（mount effect 只跑一次，onReady 也早已触发过）。
  // 结果：入场编排永不执行 → costumeProgress 卡在 0 → 白天写下去的是 Param67 = 1×0 = 0，
  // 看起来就是「换装完全没生效」，且全程无报错。
  // 手机端不会命中：那边用户手动进 DJ 模式，open 先真、模型后建，顺序相反。
  useEffect(() => {
    if (stageReadyRef.current && !djView.ready) djRef.current.markReady();
  }, [djView.ready]);

  return (
    <Live2DStage
      avatar={avatar}
      expressionMix={EMPTY_EXPRESSION_MIX}
      action={null}
      parameterOverrides={EMPTY_PARAM_OVERRIDES}
      mouthSyncOverrides={djView.mouthOverrides}
      costumeParamOverrides={costumeParamOverrides}
      watermarkVisible={false}
      transform={IDENTITY_DELTA}
      surface="holo"
      backgroundUrl={backgroundUrl ?? ROOM_BG[theme]}
      viewportSize={viewportSize}
      motionName="idle"
      interactive={false}
      sensorEnabled={false}
      nativeTargetFps={nativeTargetFps}
      onReady={markStageReady}
      onRuntimeReady={onRuntimeReady}
    />
  );
}
