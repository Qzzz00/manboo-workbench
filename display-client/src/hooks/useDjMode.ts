import { useEffect, useMemo, useRef, useState } from 'react';

import { getAvatarById } from '../features/live2d/avatarManifest';
import type { AvatarManifest, ParameterOverride } from '../features/live2d/avatarManifest';
import { computeMouthValue, type MouthSyncTarget } from '../features/live2d/mouthSync';
import type { StageTransform } from '../features/live2d/live2dEngine';
import { resolveDjFraming } from '../lib/mobileTransform';
import { useDj, type DjView } from '../screensaver/lib/djClient';
import type { Live2DController } from '../screensaver/lib/live2dController';
import { djModelFor } from '../features/live2d/djModels';
import { useDjModeConfig } from './useDjModeConfig';

const easeOutQuint = (t: number) => 1 - Math.pow(1 - t, 5);
const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

/**
 * App 内「DJ 电台」编排（不含渲染）。把进/出 DJ 的「升起位移 + 换装 ramp + 口型 + 播放器后端」
 * 收敛成纯状态，驱动**主 App 共享的那一个 Live2DStage**（不再新建第二个渲染器/上下文）：
 * - djAvatar：渲染用的完整换装模型（喂给共享 Stage 的 avatar；与主页轻量模型常驻同一上下文，秒切）。
 * - transform：当前 morph 构图。markReady 后从 enterFraming 升到 djFraming（复用登录→主页那套丝滑位移）。
 * - costumeOverrides：换装 Param67 0→1（穿上）；退场反向。
 * - mouthOverrides：DJ 口播能量驱动口型（只跟口播，不跟歌）。
 * - dj：播放器/节目单状态，喂给 DjPlayerWidget。
 * markReady 由 App 在共享 Stage「切到 DJ 模型完成(onReady)」且处于 DJ 模式时调用——此刻才启动升起+换装。
 */
export interface DjModeView {
  /** 渲染用完整换装模型（喂给共享 Stage 的 avatar）；这台机器上没有这个形象（仓库不带模型，10-21）时缺席。 */
  djAvatar: AvatarManifest | undefined;
  renderAvatarId: string;
  /** 当前 morph 构图（喂给共享 Stage 的 transform）。 */
  transform: StageTransform;
  costumeOverrides: ParameterOverride[];
  mouthOverrides: ParameterOverride[];
  dj: DjView;
  mode: string;
  setMode: (mode: string) => void;
  /** 专注番茄钟默认时长（分钟，用户可改，后端持久化）。 */
  pomodoroMin: number;
  setPomodoroMin: (min: number) => void;
  /** 休息「哄睡」开关：开则切纯音乐固定歌单(rest_lullaby)。 */
  lullaby: boolean;
  setLullaby: (on: boolean) => void;
  /** 当前口型张合 0..1（通勤双 Stage 按 dj.speaker 路由到对应主播）。 */
  mouthOpen: number;
  /** DJ 完整模型已激活（首帧可渲染）。chrome/背景据此淡入。 */
  ready: boolean;
  /** 背景/chrome 淡入标志（就绪且未退场）。 */
  bgIn: boolean;
  /** App 在共享 Stage onReady 且处于 DJ 模式时调用：标记 DJ 模型已激活，启动升起+换装。 */
  markReady: () => void;
  /** 触发退场动画（降回 + 脱装），结束后回调 onClosed（此时才真正退出 DJ、切回主页模型）。 */
  requestClose: () => void;
}

export function useDjMode({
  open,
  sourceAvatarId,
  onClosed,
  enableMusicAnalyser = false,
  preferWebAudio = false,
  onSpokenText,
}: {
  open: boolean;
  sourceAvatarId: string;
  onClosed: () => void;
  /** 仅 holo 传 true：把音乐床重路由过 AudioContext 出真频谱喂波形。移动端缺省=纯直连。 */
  enableMusicAnalyser?: boolean;
  /** 强制 WebView <audio> 播放，跳过原生前台服务（展示台用：那条路在这台 ROM 上静默失败）。 */
  preferWebAudio?: boolean;
  /** 口播文本产生时回调（SoulLink 情绪源）：把这段口播文本上抛给 App，喂情绪引擎。可选。 */
  onSpokenText?: (text: string) => void;
}): DjModeView {
  const cfg = djModelFor(sourceAvatarId);
  const renderAvatarId = cfg?.modelAvatarId ?? sourceAvatarId;
  const djAvatar = getAvatarById(renderAvatarId);

  const [mode, setMode] = useState<string>('focus');
  const [mouthOpen, setMouthOpen] = useState(0);
  const [ready, setReady] = useState(false);
  const [exiting, setExiting] = useState(false);

  // DJ 终点构图：后台配置的 djFraming（完整换装模型 manifest 上）作为绝对构图直接施加；
  // 未配置回落 IDENTITY_DELTA（auto-fit）。dj 取景目标由 surface='dj' 决定。
  const djTarget = useMemo<StageTransform>(() => resolveDjFraming(djAvatar ?? {}), [djAvatar]);
  // 入场起点：比终点略低 0.18 → 随后竖直「升起」到位（读起来像角色起身）。
  const enterFraming = useMemo<StageTransform>(
    () => ({ scale: djTarget.scale, offsetX: djTarget.offsetX, offsetY: djTarget.offsetY + 0.18, absolute: djTarget.absolute }),
    [djTarget],
  );

  const [morphT, setMorphT] = useState<StageTransform>(enterFraming);
  const morphTRef = useRef<StageTransform>(enterFraming);
  useEffect(() => { morphTRef.current = morphT; }, [morphT]);
  const morphRaf = useRef(0);
  const enteredRef = useRef(false);

  // 换装进度 0→1（穿上）；退场 1→0。每帧硬写换装参数(持久层)，按进度缩放其值。
  const [costumeProgress, setCostumeProgress] = useState(0);
  const costumeProgressRef = useRef(0);
  useEffect(() => { costumeProgressRef.current = costumeProgress; }, [costumeProgress]);

  // onSpokenText 最新值 ref：controllerRef 是固定对象，其 onSpeakText 始终调最新的回调。
  const onSpokenTextRef = useRef(onSpokenText);
  useEffect(() => { onSpokenTextRef.current = onSpokenText; }, [onSpokenText]);

  // useDj 控制器桥接：口播能量 → React 状态 → 共享 Stage 的 mouthSyncOverrides（满帧主渲染）。
  const controllerRef = useRef<Live2DController>({
    setMouth: (lv: number) => setMouthOpen(lv),
    setEmotion: () => { /* 完整模型暂无表情层；口型仍走 mouthSyncOverrides */ },
    setCostume: () => { /* 换装走 costumeOverrides */ },
    onSpeakText: (text: string) => onSpokenTextRef.current?.(text),
  });
  // 模式配置（番茄时长 / 哄睡开关）：进 DJ 时拉取，用户改动回写后端。
  const { pomodoroMin, lullaby, setPomodoroMin, setLullaby } = useDjModeConfig(open);

  // 哄睡开 → 休息模式实际播放纯音乐固定歌单(rest_lullaby)；其余模式按所选。
  const effectiveMode = mode === 'rest' && lullaby ? 'rest_lullaby' : mode;

  // 模式：切换即用对应模式的节目单(后端每日各生成一套)，秒切。enabled=open → 退出 DJ 自动停播。
  const dj = useDj(controllerRef.current, open, effectiveMode, enableMusicAnalyser, preferWebAudio);

  const mouthSyncTarget: MouthSyncTarget = useMemo(
    () => ({ avatarId: renderAvatarId, parameterId: 'ParamMouthOpenY', min: 0, max: 1, neutral: 0 }),
    [renderAvatarId],
  );
  const mouthOverrides = useMemo<ParameterOverride[]>(() => {
    if (mouthOpen > 0.001) {
      return [{ id: mouthSyncTarget.parameterId, value: computeMouthValue(mouthOpen, mouthSyncTarget) }];
    }
    return [{ id: mouthSyncTarget.parameterId, value: mouthSyncTarget.neutral }];
  }, [mouthOpen, mouthSyncTarget]);

  const costumeOverrides = useMemo<ParameterOverride[]>(
    () => (cfg?.costume ?? []).map((c) => ({ id: c.id, value: c.value * costumeProgress })),
    [cfg, costumeProgress],
  );

  // 关闭后复位，保证下次进入从头开始（升起/换装/就绪标志都重置）。
  useEffect(() => {
    if (open) return;
    enteredRef.current = false;
    setReady(false);
    setExiting(false);
    setCostumeProgress(0);
    setMorphT(enterFraming);
    if (morphRaf.current) cancelAnimationFrame(morphRaf.current);
    // enterFraming 仅随角色变化；这里复位用当前角色的入场构图
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // 入场编排：DJ 模型激活(ready)后 → 同步「升起(构图 morph) + 穿上(Param67 ramp)」。
  useEffect(() => {
    if (!open || !ready || enteredRef.current) return;
    enteredRef.current = true;
    if (morphRaf.current) cancelAnimationFrame(morphRaf.current);
    const dur = 760;
    const start = performance.now();
    const from = enterFraming;
    const to = djTarget;
    const hasCostume = !!cfg?.costume?.length;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / dur);
      const e = easeOutQuint(t);
      setMorphT({
        scale: from.scale + (to.scale - from.scale) * e,
        offsetX: from.offsetX + (to.offsetX - from.offsetX) * e,
        offsetY: from.offsetY + (to.offsetY - from.offsetY) * e,
        absolute: !!(from.absolute || to.absolute),
      });
      if (hasCostume) setCostumeProgress(easeOutCubic(t)); // 换装与升起同步、略陡收尾
      if (t < 1) morphRaf.current = requestAnimationFrame(step);
    };
    morphRaf.current = requestAnimationFrame(step);
  }, [open, ready, enterFraming, djTarget, cfg]);

  function markReady() {
    setReady(true);
  }

  // 退场编排：从当前构图反向降回 enterFraming + 脱装(costume→0)，结束后才回调 onClosed（切回主页模型）。
  function requestClose() {
    if (exiting) { onClosed(); return; }
    setExiting(true);
    if (morphRaf.current) cancelAnimationFrame(morphRaf.current);
    const dur = 460;
    const start = performance.now();
    const from = morphTRef.current; // 从当前位置降（可能还没升完就退出）
    const to = enterFraming;
    const c0 = costumeProgressRef.current;
    const hasCostume = !!cfg?.costume?.length;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / dur);
      const e = easeOutQuint(t);
      setMorphT({
        scale: from.scale + (to.scale - from.scale) * e,
        offsetX: from.offsetX + (to.offsetX - from.offsetX) * e,
        offsetY: from.offsetY + (to.offsetY - from.offsetY) * e,
        absolute: !!(from.absolute || to.absolute),
      });
      if (hasCostume) setCostumeProgress(c0 * (1 - t));
      if (t < 1) morphRaf.current = requestAnimationFrame(step);
      else onClosed();
    };
    morphRaf.current = requestAnimationFrame(step);
  }

  useEffect(() => () => { if (morphRaf.current) cancelAnimationFrame(morphRaf.current); }, []);

  return {
    djAvatar,
    renderAvatarId,
    transform: morphT,
    costumeOverrides,
    mouthOverrides,
    dj,
    mode,
    setMode,
    pomodoroMin,
    setPomodoroMin,
    lullaby,
    setLullaby,
    mouthOpen,
    ready,
    bgIn: ready && !exiting,
    markReady,
    requestClose,
  };
}
