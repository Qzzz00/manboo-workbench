import { useEffect, useRef, useState } from 'react';

import {
  createLive2DRuntime,
  destroyRuntime,
  applyExpressionMix,
  setFramingTarget,
  setMouthSyncOverrides,
  setCostumeParamOverrides,
  updateStageTransform,
  resizeRuntime,
  focusRuntimeNormalized,
  type StageTransform,
} from '../features/live2d/live2dEngine';
import {
  getAvatarById,
  resolveAvatarManifestById,
  readLipSyncParamIds,
  getAvatarExpressionIds,
  getAvatarNeutralExpressionId,
} from '../features/live2d/avatarManifest';
import { computeMouthValue } from '../features/live2d/mouthSync';
import type { AvatarManifest, SurfaceKey } from '../features/live2d/types';
import type { Live2DController } from './lib/live2dController';
import { fetchActiveDjAvatarId } from './lib/djAvatar';
import { isDjModeActive, djActiveAvatarId } from './lib/djMode';
import { getNativeScreensaverFps, getNativeScreensaverAvatarId } from './lib/nativeBridge';
import { DJ_MODEL_MAP, djConfigForModelAvatar } from '../features/live2d/djModels';
import { IDENTITY_DELTA } from '../lib/mobileTransform';
// 低端机原生渲染路径：DreamService 在 WebView 之下垫 GLSurfaceView（与主 App 同一套
// Cubism 控制器），本组件不建 Pixi，控制经 window.AibooNativeLive2D 桥。
import {
  applyNativeScreensaverLayout,
  destroyNativeScreensaver,
  screensaverNativeAvailable,
  setNativeBottomFade,
  setNativeBottomBar,
  waitNativeScreensaverCompositeFrame,
  setNativeScreensaverCostume,
  setNativeScreensaverExpression,
  setNativeScreensaverMouth,
  showNativeScreensaverModel,
} from './lib/nativeLive2dScreensaver';

type Runtime = Awaited<ReturnType<typeof createLive2DRuntime>>;

const DEFAULT_AVATAR_ID = 'shuangsheng';

/** 非 DJ 场景的屏保角色：客户端指定优先，未设/无效回落默认。 */
function preferredIdleAvatarId(): string {
  const pref = getNativeScreensaverAvatarId();
  return pref && getAvatarById(pref) ? pref : DEFAULT_AVATAR_ID;
}
// 屏保是长时间充电态运行，降帧到 15 进一步减少 GPU 负载/发热（Live2D 待机动作 15fps 可接受）
const TARGET_FPS = 15;

// DJ 情绪 → 表情关键词（按优先级匹配 avatar.expressions 中已存在的 key，找不到回落 neutral）。
const EMOTION_SYNONYMS: Record<string, string[]> = {
  warm: ['warm', 'smile', 'happy', 'gentle', 'soft'],
  hype: ['hype', 'excited', 'happy', 'joy', 'smile'],
  calm: ['calm', 'neutral', 'relax', 'gentle'],
  chill: ['chill', 'relax', 'calm', 'cool'],
  melancholy: ['melancholy', 'sad', 'down', 'cry', 'sorrow'],
};

type Live2DSceneProps = {
  onReady?: (controller: Live2DController) => void;
  /** 显式指定角色（App 内 DJ 模式传入当前对话角色）；不传则后台解析后端启用的 DJ 角色（屏保用法）。 */
  avatarId?: string;
  /** 取景覆盖（桌宠浮窗传 'pet' 走上半身特写）；不传按 DJ/home 自动。 */
  framing?: SurfaceKey;
  /** 参数覆盖（如桌宠 Q 版触发的「变小」参数）：模型就绪即持久硬写，在构图之前应用。 */
  costume?: { id: string; value: number }[];
  /** 舞台 transform 增量（scale 乘、offset 加），叠加在 auto-fit 之上。DJ 真机拖定用。 */
  stageTransform?: StageTransform;
  /** 头部度量覆盖：auto-fit 用它算缩放/定位。Q 版大头需比原始更大的 headSizeNorm，否则被过放大。 */
  framingHead?: { headSizeNorm?: number; headAnchorY?: number };
  /** Pixi 渲染分辨率上限（DPR）。屏保省电封顶 1.5；桌宠小窗要清晰须放开到近设备 DPR，否则被上采样变糊。 */
  resolutionCap?: number;
  /** 透明清屏（原生渲染路径）：桌宠/固定浮窗悬浮时 GL 空白处露出桌面。屏保不传（不透明）。 */
  transparentClear?: boolean;
  /**
   * 底部软边渐隐（从顶部起算比例，0=顶 1=底）。桌宠「上半身+透明悬浮」用它防赛博截肢。
   * Pixi 路径由 pet.css 的 mask-image 负责；此 prop 只驱动原生 GL 路径——CSS 遮罩盖不到 SurfaceView。
   */
  bottomFade?: { start: number; end: number } | null;
  /** 掌机底栏：由原生 GL 在模型之前绘制，确保模型覆盖底栏、WebView 按钮覆盖模型。 */
  bottomBar?: { heightFraction: number; color: string } | null;
  /**
   * 目标帧率（原生 GL 与 Pixi 两条路径都吃）。
   * ★不传会落到 15 的默认地板——那是当年为 U1 Pro（0.99GHz 单核）定的省电值。
   * 掌机底条这类能跑 60 的场景必须显式传，否则观感很差（真机 logcat 实测吃过 target=15）。
   */
  targetFps?: number;
};

/** 头部度量覆盖并入 avatar（仅 headSizeNorm/headAnchorY，其余不动）：Q 版等特殊身形用。 */
function withFramingHead(
  avatar: AvatarManifest,
  head?: { headSizeNorm?: number; headAnchorY?: number },
): AvatarManifest {
  if (!head) return avatar;
  return {
    ...avatar,
    headSizeNorm: head.headSizeNorm ?? avatar.headSizeNorm,
    headAnchorY: head.headAnchorY ?? avatar.headAnchorY,
  };
}

/**
 * 屏保专用的薄 Live2D 封装：只渲染默认角色、禁用一切交互、限帧 30、息屏暂停。
 * 通过 onReady 暴露 setMouth / setEmotion 句柄给上层（DJ 口型/情绪）。
 */
export function Live2DScene({ onReady, avatarId: avatarIdProp, framing, costume, stageTransform, framingHead, resolutionCap, transparentClear, bottomFade, bottomBar, targetFps }: Live2DSceneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  // 先用指定/默认角色立即渲染；DJ 角色在后台解析，绝不阻塞首帧——否则慢网络/混合内容会黑屏数秒
  const [avatarId, setAvatarId] = useState<string>(avatarIdProp || preferredIdleAvatarId());

  // 显式指定 → 直接用该角色；否则按「主 App 是否正处于 DJ 模式」决定：
  //  - 未处于 DJ（或 App 未启动）→ 未换装的默认形象；
  //  - 处于 DJ → 取当前 DJ 角色（优先原生 flag，回落后端），映射到完整换装模型(shuangsheng→shuangsheng-dj)。
  useEffect(() => {
    if (avatarIdProp) {
      if (getAvatarById(avatarIdProp)) setAvatarId(avatarIdProp);
      return;
    }
    if (!isDjModeActive()) {
      setAvatarId(preferredIdleAvatarId());
      return;
    }
    let alive = true;
    (async () => {
      let id = djActiveAvatarId();
      if (!id) id = (await fetchActiveDjAvatarId()) || DEFAULT_AVATAR_ID;
      const mapped = DJ_MODEL_MAP[id]?.modelAvatarId ?? id;
      if (alive && getAvatarById(mapped)) setAvatarId(mapped);
    })().catch(() => {
      /* 取不到就保持默认 */
    });
    return () => {
      alive = false;
    };
  }, [avatarIdProp]);

  useEffect(() => {
    let disposed = false;
    let runtime: Runtime | null = null;
    let nativeMounted = false;
    let nativeRefitRaf = 0;
    let resolveNativeRefit: (() => void) | null = null;

    function refitNativeStage(container: HTMLElement): Promise<void> {
      if (!nativeMounted || disposed) return Promise.resolve();
      if (nativeRefitRaf) {
        window.cancelAnimationFrame(nativeRefitRaf);
        resolveNativeRefit?.();
      }
      return new Promise((resolve) => {
        resolveNativeRefit = resolve;
        nativeRefitRaf = window.requestAnimationFrame(() => {
          nativeRefitRaf = 0;
          resolveNativeRefit = null;
          if (!nativeMounted || disposed) {
            resolve();
            return;
          }
          const rect = container.getBoundingClientRect();
          applyNativeScreensaverLayout({
            containerRect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
          });
          resolve();
        });
      });
    }

    async function init() {
      const container = containerRef.current;
      if (!container) return;

      const base = getAvatarById(avatarId);
      if (!base) {
        console.error('[screensaver] 角色不存在:', avatarId);
        return;
      }

      // ---- 原生渲染分支（低端机）：不建 Pixi，角色画在 WebView 之下的 GL 层 ----
      if (screensaverNativeAvailable()) {
        try {
          const avatar: AvatarManifest = withFramingHead(await resolveAvatarManifestById(avatarId), framingHead);
          if (disposed) return;
          const djCfg = djConfigForModelAvatar(avatarId);
          const rect = container.getBoundingClientRect();
          await showNativeScreensaverModel(avatar, {
            surface: framing ?? (djCfg ? 'dj' : 'home'),
            transform: stageTransform ?? djCfg?.transform ?? IDENTITY_DELTA,
            containerRect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
            costume: costume ?? djCfg?.costume ?? [],
            targetFps: targetFps ?? (getNativeScreensaverFps() || TARGET_FPS),
            clearColor: transparentClear ? '#00000000' : undefined,
          });
          if (disposed) {
            destroyNativeScreensaver();
            return;
          }
          nativeMounted = true;
          // 原生 GL 的首帧布局原本只取 init 时的 DOM 矩形；掌机底条的 CSS 会把 stage 缩到左侧，
          // 若首测赶在最终样式/ResizeObserver 之前，就会残留旧位置。下一帧按真实矩形再下发一次。
          await refitNativeStage(container);
          if (disposed) return;

          // 原生 GL 的底部渐隐：必须在模型就绪后设（此前 glView 还没建，桥调用会被丢弃）。
          setNativeBottomFade(bottomFade ?? null);
          setNativeBottomBar(bottomBar ?? null);
          await waitNativeScreensaverCompositeFrame(3000);
          if (disposed) return;

          // 口型参数解析与 WebView 路径同源（LipSync 组优先，回落 ParamMouthOpenY）
          let nativeLipSyncParamId = 'ParamMouthOpenY';
          try {
            const ids = await readLipSyncParamIds(avatar.modelJson);
            if (ids && ids.length > 0) nativeLipSyncParamId = ids[0];
          } catch { /* 用默认 */ }
          const nativeNeutralId = getAvatarNeutralExpressionId(avatar);
          const nativeExpressionIds = getAvatarExpressionIds(avatar);

          const nativeController: Live2DController = {
            setMouth(level01: number) {
              const value = computeMouthValue(level01, {
                avatarId: avatar.id,
                parameterId: nativeLipSyncParamId,
                min: 0,
                max: 1,
                neutral: 0,
              });
              setNativeScreensaverMouth(nativeLipSyncParamId, value);
            },
            setEmotion(emotion: string | null) {
              const key = pickExpressionForEmotion(emotion, nativeExpressionIds, nativeNeutralId);
              setNativeScreensaverExpression(avatar, key);
            },
            setCostume(params: { id: string; value: number }[]) {
              setNativeScreensaverCostume(params);
            },
            refit() {
              // 只重算构图下发 setLayout，不碰模型——取景热更新省掉那 2.5 秒重载。
              applyNativeScreensaverLayout({});
            },
          };
          if (!disposed) onReady?.(nativeController);
          return;
        } catch (err) {
          console.warn('[screensaver] 原生渲染启动失败，回落 WebView Pixi', err);
          destroyNativeScreensaver();
          if (disposed) return;
        }
      }

      if (!window.Live2DCubismCore) {
        console.error('[screensaver] live2dcubismcore.min.js 未加载');
        return;
      }

      const avatar: AvatarManifest = withFramingHead(await resolveAvatarManifestById(avatarId), framingHead);
      if (disposed) return;

      runtime = await createLive2DRuntime(container, avatar);
      if (disposed) {
        destroyRuntime(runtime);
        runtime = null;
        return;
      }

      // 限帧降功耗（充电态不进 Doze，系统不替我们省电）
      // 刷新率可配（屏保设置页写入 ScreensaverPrefs，原生桥读出）；取不到回落 TARGET_FPS。
      runtime.app.ticker.maxFPS = targetFps ?? (getNativeScreensaverFps() || TARGET_FPS);

      // 降低渲染分辨率上限，进一步省电/降温：高 DPI 手机默认按 ~3x 渲染，
      // 片元着色开销随分辨率平方增长，封顶到 1.5x 可大幅降低 GPU 负载（略糊但屏保可接受）。
      try {
        const renderer = runtime.app.renderer as unknown as {
          resolution: number;
          resize: (w: number, h: number) => void;
        };
        const cap = resolutionCap ?? 1.5;
        if (renderer.resolution > cap) {
          renderer.resolution = cap;
          renderer.resize(container.clientWidth, container.clientHeight);
        }
      } catch (err) {
        console.warn('[screensaver] 分辨率封顶失败', err);
      }

      const neutralId = getAvatarNeutralExpressionId(avatar);
      try {
        await applyExpressionMix(runtime, avatar, [{ key: neutralId, weight: 1 }]);
      } catch (err) {
        console.warn('[screensaver] 初始表情失败', err);
      }

      // 口型参数（优先 model3.json LipSync 组，回落 ParamMouthOpenY）
      let lipSyncParamId = 'ParamMouthOpenY';
      try {
        const ids = await readLipSyncParamIds(avatar.modelJson);
        if (ids && ids.length > 0) lipSyncParamId = ids[0];
      } catch {
        /* 用默认 */
      }

      const expressionIds = getAvatarExpressionIds(avatar);

      const controller: Live2DController = {
        setMouth(level01: number) {
          if (!runtime) return;
          const value = computeMouthValue(level01, {
            avatarId: avatar.id,
            parameterId: lipSyncParamId,
            min: 0,
            max: 1,
            neutral: 0,
          });
          setMouthSyncOverrides(runtime, [{ id: lipSyncParamId, value }]);
        },
        setEmotion(emotion: string | null) {
          if (!runtime) return;
          const key = pickExpressionForEmotion(emotion, expressionIds, neutralId);
          applyExpressionMix(runtime, avatar, [{ key, weight: 1 }]).catch(() => {
            /* 表情切换失败不影响屏保 */
          });
        },
        setCostume(params: { id: string; value: number }[]) {
          if (!runtime) return;
          setCostumeParamOverrides(runtime, params);
        },
        refit() {
          // 取景热更新：SURFACE_FRAMING 改完重跑一次 fitModel（runtime.framingTarget
          // 持有的就是那个对象引用，所以不用重设 target）。
          const el = containerRef.current;
          if (runtime && el) resizeRuntime(runtime, el);
        },
        setFocus(nx: number, ny: number) {
          if (!runtime) return;
          focusRuntimeNormalized(runtime, nx, ny);
        },
      };

      // 屏保 DJ：完整模型换装(Param67=1) + 构图（用真机拖定的值，回落 IDENTITY_DELTA 让 auto-fit 决定）
      const djCfg = djConfigForModelAvatar(avatarId);
      // 参数覆盖：桌宠 Q 版（变小）优先，其次 DJ 换装。
      const effectiveCostume = costume ?? djCfg?.costume;
      if (effectiveCostume) setCostumeParamOverrides(runtime, effectiveCostume);
      try {
        setFramingTarget(runtime, framing ?? (djCfg ? 'dj' : 'home'));
        // transform 增量：桌宠 Q 版手调 > DJ 真机拖定 > 默认 auto-fit（IDENTITY）。
        updateStageTransform(runtime, container, stageTransform ?? djCfg?.transform ?? IDENTITY_DELTA);
      } catch {
        /* 构图失败不影响渲染 */
      }

      if (!disposed) onReady?.(controller);
    }

    init().catch((err) => console.error('[screensaver] Live2D 初始化失败', err));

    // 息屏 / 切后台时暂停渲染，回前台恢复
    const onVisibility = () => {
      if (!runtime) return;
      if (document.hidden) runtime.app.ticker.stop();
      else runtime.app.ticker.start();
    };
    document.addEventListener('visibilitychange', onVisibility);

    // 窗口尺寸变化（桌宠拖动大小/比例）→ 重设渲染器分辨率，避免 canvas 被位图缩放变糊。
    const resizeEl = containerRef.current;
    const resizeObserver = resizeEl
      ? new ResizeObserver(() => {
          if (runtime) resizeRuntime(runtime, resizeEl);
          else void refitNativeStage(resizeEl);
        })
      : null;
    if (resizeEl) resizeObserver?.observe(resizeEl);

    return () => {
      disposed = true;
      if (nativeRefitRaf) {
        window.cancelAnimationFrame(nativeRefitRaf);
        resolveNativeRefit?.();
      }
      resizeObserver?.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      destroyNativeScreensaver(); // 原生态：藏层+摘类（模型释放由 DreamService detach 兜底）
      if (runtime) {
        destroyRuntime(runtime);
        runtime = null;
      }
    };
    // onReady 在父层用 useCallback 固定；按 avatarId 重建（DJ 角色解析后切换）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [avatarId]);

  // DJ 完整模型用真机拖定的 transform，需关掉屏保给轻量模型加的 -10% CSS 抬升，避免叠加偏移
  const isDjModel = !!djConfigForModelAvatar(avatarId);
  return (
    <div
      ref={containerRef}
      className={isDjModel ? 'ss-live2d-stage ss-live2d-stage--dj' : 'ss-live2d-stage'}
    />
  );
}

function pickExpressionForEmotion(
  emotion: string | null,
  expressionIds: string[],
  neutralId: string,
): string {
  if (!emotion) return neutralId;
  const synonyms = EMOTION_SYNONYMS[emotion] || [emotion];
  for (const syn of synonyms) {
    const hit = expressionIds.find((id) => id.toLowerCase().includes(syn.toLowerCase()));
    if (hit) return hit;
  }
  return neutralId;
}
