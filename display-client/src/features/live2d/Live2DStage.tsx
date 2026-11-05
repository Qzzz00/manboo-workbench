import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { AvatarManifest, ExpressionLayer, ParameterOverride } from './avatarManifest.ts';
import {
  applyExpressionMix,
  createLive2DRuntime,
  destroyRuntime,
  focusRuntime,
  focusRuntimeNormalized,
  getModelBounds,
  playAction,
  resetRuntimeFocus,
  resizeRuntime,
  setCostumeParamOverrides,
  setDepthParallaxBackground,
  setDepthParallaxScale,
  setFramingTarget,
  setMouthSyncOverrides,
  setParameterOverrides,
  setWatermarkVisibility,
  startMotion,
  teardownDepthLayer,
  triggerDizzyRuntime,
  updateStageTransform,
  type ModelBounds,
  type StageTransform,
  type RuntimeState,
} from './live2dEngine.ts';
import { depthDisplacement } from './depthDisplacement.ts';
import { deriveDepthUrl } from './deriveDepthUrl.ts';
import type { SurfaceKey } from './types.ts';
import { useDeviceTilt } from './useDeviceTilt.ts';
import { parallaxOffset } from './backgroundParallax.ts';
import { createDoubleTapDetector } from './doubleTap.ts';
// 低端机原生渲染路径：WebView 之下垫 GLSurfaceView 跑 Cubism，本组件不建 Pixi，
// 所有控制状态改经 nativeStage 桥接（表情拍平/构图数学仍在 JS，与 WebView 同一份逻辑）。
import {
  applyLayout as applyNativeLayout,
  applyNativeExpressionMix,
  destroyNativeStage,
  isBundledModelJson,
  nativeStageEnabled,
  parkNativeStage,
  playNativeAction,
  playNativeMotion,
  setNativeBackground,
  setNativeBackgroundParallax,
  setNativeFocus,
  setNativeMouthParams,
  setNativeParameterOverrides,
  setNativePersistentParams,
  setNativeWatermarkVisible,
  resetNativeFocus,
  showAvatarModel,
} from './nativeStage.ts';

export type Live2DStageProps = {
  avatar: AvatarManifest;
  expressionMix: ExpressionLayer[];
  /** 统一动作（折中方案首选）：nonce 变化即触发一次 playAction（自带 motion/expression 分流 + costume/emotion 生命周期）。 */
  action?: { id: string; nonce: number } | null;
  parameterOverrides: ParameterOverride[];
  mouthSyncOverrides?: ParameterOverride[];
  /** 持久参数覆盖（如 DJ 换装 Param67=1）：每帧硬写，不经平滑/过滤，也不被口型替换。 */
  costumeParamOverrides?: ParameterOverride[];
  watermarkVisible: boolean;
  transform: StageTransform;
  onModelBounds?: (bounds: ModelBounds) => void;
  backgroundUrl?: string | null;
  /** 环境动效预设：'soft'=光斑缓移+呼吸式明暗，'none'=关闭。默认 'soft'。仅移动端 CSS 生效。 */
  ambient?: 'none' | 'soft';
  motionName?: string;
  /** 当前界面取景目标（home/login/dj），决定 auto-fit 将脸放到哪里。默认 'home'。 */
  surface?: SurfaceKey;
  /**
   * 原生渲染的分数基准视口。缺省用舞台容器（主 App 里容器就是整屏，等价）。
   * ★把角色放进**子区域**的宿主（展示台左列）必须显式传整屏尺寸，
   * 否则分数按容器算、按整屏应用，角色会跑到屏幕中间。
   */
  viewportSize?: { width: number; height: number };
  /** 为 false 时禁用拖拽/缩放并隐藏提示（登录页/DJ 只读展示） */
  interactive?: boolean;
  /** 双击模型本体触发（拉取服务端人设）。仅在 interactive 时生效。 */
  onDoubleTap?: () => void;
  /** 体感互动开关：陀螺仪驱动视线跟随 + 摇一摇。仅在 interactive 时生效。 */
  sensorEnabled?: boolean;
  /** 摇一摇触发回调（由 App 接到 presence.applyEmotion）。 */
  onShake?: () => void;
  /** 竖向滑动切换角色（上滑 next / 下滑 prev）。仅在 interactive + 触摸时生效。 */
  onSwitchAvatar?: (dir: 'next' | 'prev') => void;
  /** 模型 runtime 就绪回调：首次创建完成、或原地切换到新模型完成（首帧可渲染）后触发。 */
  onReady?: () => void;
  /** 把内部 runtime 实例暴露给父组件（如 App 的 profile binding）。不改动现有 action 通道。 */
  onRuntimeReady?: (runtime: RuntimeState) => void;
  /** 原生渲染路径就绪回调（无 Pixi runtime 时的 profile binding 挂点）。 */
  onNativeReady?: () => void;
  /** 原生渲染目标帧率（仅原生路径生效）。默认 15；够强的设备（U3 八核）可上调提流畅度。 */
  nativeTargetFps?: number;
  /** 卸载时只 park 原生模型，供短暂离开主页后热恢复；默认彻底释放。 */
  preserveNativeOnUnmount?: boolean;
  /** 掌机主页完整帧请求号；普通页面不传。 */
  lifecycleRequestId?: number;
};

type DragState = {
  pointerId: number;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
};

export function Live2DStage({
  avatar,
  expressionMix,
  action,
  parameterOverrides,
  mouthSyncOverrides = [],
  costumeParamOverrides = [],
  watermarkVisible,
  transform,
  onModelBounds,
  backgroundUrl,
  ambient = 'soft',
  viewportSize,
  motionName,
  surface = 'home',
  interactive = true,
  onDoubleTap,
  sensorEnabled = false,
  onShake,
  onSwitchAvatar,
  onReady,
  onRuntimeReady,
  onNativeReady,
  nativeTargetFps,
  preserveNativeOnUnmount = false,
  lifecycleRequestId,
}: Live2DStageProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const bgImgRef = useRef<HTMLDivElement | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);
  // 背景视差位移上限（px）；必须与 .stage-bg__img CSS 的 scale(1.30) 配合确保边缘不露白。
  const BG_PARALLAX_MAX_PX = 16;
  // 景深位移强度上限（像素，DisplacementFilter.scale）。保守起步，真机手调（开放票1）。
  const DEPTH_MAX_SCALE = 90;
  const runtimeRef = useRef<Awaited<ReturnType<typeof createLive2DRuntime>> | null>(null);

  // 体感互动：陀螺仪倾角 → 视线跟随（复用 focus 通道）；摇一摇 → 程序化「被摇晕」演出（引擎内驱动）。
  // 仅在可交互且开关开启时订阅传感器（省电）。
  // 返回 recenterRef：双击时重校准陀螺仪基线到当前握持姿态。
  const tiltRecenterRef = useDeviceTilt({
    enabled: interactive && sensorEnabled,
    onTilt: (nx, ny) => {
      if (nativeActive) {
        // 原生模式：朝向经桥（内部节流）；背景画在 GL 层，CSS 视差动不到它，
        // 视差也走桥（同一份 parallaxOffset，方向换算在 nativeStage 里做）。
        if (nativeReadyRef.current) {
          setNativeFocus(nx, ny);
          const { x, y } = parallaxOffset(nx, ny, BG_PARALLAX_MAX_PX);
          setNativeBackgroundParallax(x, y, BG_PARALLAX_MAX_PX);
        }
        return;
      }
      const runtime = runtimeRef.current;
      if (runtime) focusRuntimeNormalized(runtime, nx, ny);
      if (document.visibilityState === 'hidden') return;

      if (depthActiveRef.current && runtime) {
        // 景深路径：写 DisplacementFilter 强度（depthDisplacement 已含反向）。
        const { sx, sy } = depthDisplacement(nx, ny, DEPTH_MAX_SCALE);
        setDepthParallaxScale(runtime, sx, sy);
        return;
      }

      // 回退路径：P1 CSS 平面视差（方向内联取反 + scale(1.30) overscan）。
      const bg = bgImgRef.current;
      if (bg) {
        const { x, y } = parallaxOffset(nx, ny, BG_PARALLAX_MAX_PX);
        // 背景逆着倾斜方向位移（视差纵深）：手机朝右倾→背景左移，角色仍朝右看。
        bg.style.transform = `translate3d(${-x}px, ${-y}px, 0) scale(1.30)`;
      }
    },
    onShake: () => {
      const runtime = runtimeRef.current;
      if (runtime) triggerDizzyRuntime(runtime);
      onShake?.();
    },
  });
  const transformRef = useRef(transform);
  const watermarkVisibleRef = useRef(watermarkVisible);
  const costumeParamOverridesRef = useRef(costumeParamOverrides);
  const surfaceRef = useRef(surface);
  const viewportSizeRef = useRef(viewportSize);
  viewportSizeRef.current = viewportSize;
  const dragStateRef = useRef<DragState | null>(null);
  // 双击检测（ALL-440）：纯逻辑实例，touch 放宽到 420ms/20px 容指腹抖动，
  // mouse/pen 保持 320ms/8px；pointercancel 只清拖动标记，不计 tap。
  const doubleTapRef = useRef<ReturnType<typeof createDoubleTapDetector>>(createDoubleTapDetector());
  const [status, setStatus] = useState('加载中');
  // 运行时就绪计数：每次 runtime 创建成功 +1，供景深背景 effect 依赖（换角色后重建景深层）。
  const [runtimeReadyTick, setRuntimeReadyTick] = useState(0);
  // 原生渲染路径失败标记（.so 缺失/加载失败等）：置位后本组件回落 WebView Pixi 渲染。
  const [nativeBroken, setNativeBroken] = useState(false);
  // 低端机 + 插件随包 + 模型为本地资产 → 原生渲染。avatar 变化时逐次判定（远端模型回 WebView）。
  const nativeActive = !nativeBroken && nativeStageEnabled() && isBundledModelJson(avatar.modelJson);
  const nativeReadyRef = useRef(false);
  // 当前是否处于景深路径（探测到深度图且建层成功）。ref 供高频 onTilt 读取。
  const [depthActive, setDepthActive] = useState(false);
  const depthActiveRef = useRef(false);

  useEffect(() => {
    depthActiveRef.current = depthActive;
  }, [depthActive]);

  useEffect(() => {
    transformRef.current = transform;
  }, [transform]);

  useEffect(() => {
    watermarkVisibleRef.current = watermarkVisible;
  }, [watermarkVisible]);

  useEffect(() => {
    costumeParamOverridesRef.current = costumeParamOverrides;
  }, [costumeParamOverrides]);

  useEffect(() => {
    surfaceRef.current = surface;
  }, [surface]);

  // 可见性暂停：页面进入后台/熄屏时停止背景动效，省电。
  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    const sync = () => {
      const hidden = document.visibilityState === 'hidden';
      shell.dataset.bgPaused = hidden ? 'true' : 'false';
      // 熄屏/切后台时把景深位移强度归零：后台传感器停传→onTilt 不再回调→
      // filter.scale 会冻结在非零值，GPU 每帧仍白算滤镜。硬归零一次，省电减热。
      const runtime = runtimeRef.current;
      if (hidden && runtime) setDepthParallaxScale(runtime, 0, 0);
    };
    sync();
    document.addEventListener('visibilitychange', sync);
    return () => document.removeEventListener('visibilitychange', sync);
  }, []);

  // 创建运行时：仅在「角色(avatar.id)」变化时重建（含首次挂载）。
  // 同一角色横跨登录/主页/DJ 全程是同一个模型实例（换装走 Param67 参数），切页不重建、不换模型。
  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    // 没有形象(NO_AVATAR,仓库不带模型):不加载、不报错,舞台留空。
    if (avatar.modelJson === '') {
      setStatus('还没有形象');
      return;
    }

    // ---- 原生渲染分支：不建 Pixi/WebGL，模型显示在 WebView 之下的 GLSurfaceView ----
    if (nativeActive) {
      let cancelledNative = false;
      setStatus(`Loading ${avatar.name}`);
      const rect = container.getBoundingClientRect();
      const costumeParams: Record<string, number> = {};
      for (const o of costumeParamOverridesRef.current) costumeParams[o.id] = o.value;

      void showAvatarModel(avatar, {
        surface: surfaceRef.current,
        transform: transformRef.current,
        containerRect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
        ...(viewportSizeRef.current === undefined ? {} : { viewportSize: viewportSizeRef.current }),
        costumeParams,
        backgroundUrl: backgroundUrl ?? null,
        targetFps: nativeTargetFps,
        lifecycleRequestId,
      })
        .then(async () => {
          if (cancelledNative) return;
          nativeReadyRef.current = true;
          await applyNativeExpressionMix(avatar, [{ key: 'neutral', weight: 1 }]);
          await setNativeWatermarkVisible(avatar, watermarkVisibleRef.current);
          const bounds = applyNativeLayout({
            surface: surfaceRef.current,
            transform: transformRef.current,
          });
          if (bounds) onModelBounds?.(bounds);
          setStatus('就绪');
          setRuntimeReadyTick((n) => n + 1); // 背景 effect 依赖它下发原生背景
          onReady?.();
          // onRuntimeReady 故意不回调：原生模式没有 Pixi runtime，badge 烘焙/参数面板
          // 以 runtime==null 自然降级；profile 触发走 onNativeReady → 原生镜像绑定。
          onNativeReady?.();
        })
        .catch((error) => {
          if (cancelledNative || (error as Error)?.message === 'superseded') return;
          setNativeBroken(true);
        });

      const nativeObserver = new ResizeObserver(() => {
        const c = containerRef.current;
        if (!c || !nativeReadyRef.current) return;
        const r = c.getBoundingClientRect();
        const bounds = applyNativeLayout({
          containerRect: { left: r.left, top: r.top, width: r.width, height: r.height },
        });
        if (bounds) onModelBounds?.(bounds);
      });
      nativeObserver.observe(container);

      return () => {
        cancelledNative = true;
        nativeReadyRef.current = false;
        nativeObserver.disconnect();
        if (preserveNativeOnUnmount) void parkNativeStage().catch(() => { /* cleanup 无后续 preview 可放行 */ });
        else void destroyNativeStage();
      };
    }

    let cancelled = false;
    setStatus(`Loading ${avatar.name}`);

    void createLive2DRuntime(container, avatar)
      .then(async (runtime) => {
        if (cancelled) {
          destroyRuntime(runtime);
          return;
        }

        runtimeRef.current = runtime;
        await applyExpressionMix(runtime, avatar, [{ key: 'neutral', weight: 1 }]);
        await setWatermarkVisibility(runtime, avatar, watermarkVisibleRef.current);
        setFramingTarget(runtime, surfaceRef.current);
        updateStageTransform(runtime, container, transformRef.current);
        setCostumeParamOverrides(runtime, costumeParamOverridesRef.current);
        onModelBounds?.(getModelBounds(runtime) ?? runtime.currentBounds);
        setStatus('就绪');
        setRuntimeReadyTick((n) => n + 1);
        onReady?.();
        onRuntimeReady?.(runtime);
      })
      .catch((error) => {
        console.error(error);
        setStatus('加载失败');
      });

    const observer = new ResizeObserver(() => {
      if (runtimeRef.current && containerRef.current) {
        resizeRuntime(runtimeRef.current, containerRef.current);
      }
    });

    observer.observe(container);

    return () => {
      cancelled = true;
      observer.disconnect();

      if (runtimeRef.current) {
        teardownDepthLayer(runtimeRef.current);
        destroyRuntime(runtimeRef.current);
        runtimeRef.current = null;
      }
    };
    // 只在切换到「另一个角色」时重建。avatar 对象因人设/transform/换装同步换引用时不重建，
    // 由下面的「同模型元数据」effect 原地更新。nativeActive 翻转（原生失败回落）时也重建。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [avatar.id, nativeActive]);

  // 同模型、仅元数据(scaleMultiplier/verticalOffset/modelTransform 等)变化时：原地更新引用并重新构图，不重载。
  useEffect(() => {
    if (nativeActive) {
      if (!nativeReadyRef.current) return;
      const bounds = applyNativeLayout({ transform: transformRef.current });
      if (bounds) onModelBounds?.(bounds);
      return;
    }
    const runtime = runtimeRef.current;
    const container = containerRef.current;
    if (!runtime || !container) return;
    if (runtime.avatar.modelJson !== avatar.modelJson) return; // 跨角色重建中，交给 create effect
    runtime.avatar = avatar;
    updateStageTransform(runtime, container, transformRef.current);
    onModelBounds?.(getModelBounds(runtime) ?? runtime.currentBounds);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [avatar]);

  // expressionMix 现由形象状态合成器（PresenceStore.compose）统一下发——它已把
  // ②服饰 + ③形态 + ①情绪 merge 成一张完整 mix，故这里整张应用不再会冲掉换装/变小。
  // 引擎内部的 costumeMix/emotionMix 分层（playAction 的 expression 分支）不再从聊天侧触发。
  useEffect(() => {
    if (nativeActive) {
      if (!nativeReadyRef.current) return;
      void applyNativeExpressionMix(avatar, expressionMix);
      return;
    }
    if (!runtimeRef.current) {
      return;
    }

    const summary = expressionMix.map((layer) => layer.key).join(' + ') || 'neutral';
    setStatus(`切换表情:  ${summary}`);
    void applyExpressionMix(runtimeRef.current, avatar, expressionMix)
      .then(() => setStatus('就绪'))
      .catch((error) => {
        console.error(error);
        setStatus('表情切换失败');
      });
  }, [avatar, expressionMix, nativeActive]);

  // 一次性动作（合成器 ④ gesture 层）：nonce 变化即触发一次 playAction。
  // 合成器只把 motion-source 的一次性动作经此下发（playAction→startMotion），不碰表情分层；
  // 服饰/形态/情绪已并入上面的 expressionMix 整张下发，故二者不冲突。
  useEffect(() => {
    if (nativeActive) {
      if (action && nativeReadyRef.current) playNativeAction(avatar, action.id);
      return;
    }
    if (!runtimeRef.current || !action) {
      return;
    }
    playAction(runtimeRef.current, avatar, action.id);
    // action 有意只依赖 nonce（同 id 重复触发也要重播），不依赖对象引用。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [avatar, action?.nonce, nativeActive]);

  useEffect(() => {
    if (nativeActive) {
      if (nativeReadyRef.current) void setNativeParameterOverrides(avatar, parameterOverrides);
      return;
    }
    if (!runtimeRef.current) {
      return;
    }

    void setParameterOverrides(runtimeRef.current, avatar, parameterOverrides).catch((error) => {
      console.error(error);
      setStatus('参数设置失败');
    });
  }, [avatar, parameterOverrides, nativeActive]);

  useEffect(() => {
    if (nativeActive) {
      setNativeMouthParams(mouthSyncOverrides); // 内部节流 66ms，未就绪时 no-op
      return;
    }
    if (!runtimeRef.current) {
      return;
    }

    setMouthSyncOverrides(runtimeRef.current, mouthSyncOverrides);
  }, [mouthSyncOverrides, nativeActive]);

  useEffect(() => {
    if (nativeActive) {
      const params: Record<string, number> = {};
      for (const o of costumeParamOverrides) params[o.id] = o.value;
      setNativePersistentParams(params);
      return;
    }
    if (!runtimeRef.current) {
      return;
    }
    setCostumeParamOverrides(runtimeRef.current, costumeParamOverrides);
  }, [costumeParamOverrides, nativeActive]);

  useEffect(() => {
    if (nativeActive) {
      if (nativeReadyRef.current) void setNativeWatermarkVisible(avatar, watermarkVisible);
      return;
    }
    if (!runtimeRef.current) {
      return;
    }

    void setWatermarkVisibility(runtimeRef.current, avatar, watermarkVisible).catch((error) => {
      console.error(error);
      setStatus('水印设置失败');
    });
  }, [avatar, watermarkVisible, nativeActive]);

  useEffect(() => {
    if (nativeActive) {
      if (!nativeReadyRef.current) return;
      const bounds = applyNativeLayout({ transform });
      if (bounds) onModelBounds?.(bounds);
      return;
    }
    if (!runtimeRef.current || !containerRef.current) {
      return;
    }

    updateStageTransform(runtimeRef.current, containerRef.current, transform);
    onModelBounds?.(getModelBounds(runtimeRef.current) ?? runtimeRef.current.currentBounds);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transform, nativeActive]);

  // 背景或运行时变化时：按命名约定探测深度图，成功建景深层→depth-active；
  // 无图/无约定/加载失败→拆层回退 P1 CSS 平面视差。
  useEffect(() => {
    if (nativeActive) {
      // 原生模式：背景由 GL 层绘制（DOM 背景层已被 html.native-live2d 隐藏），景深路径不适用。
      if (nativeReadyRef.current) {
        void setNativeBackground(backgroundUrl ?? null).catch((error: unknown) => {
          // 失败仍然交给当前可见帧继续承载，但**不能静默**：
          // 这里一吞，表现就是「配色翻过去了、背景没跟着回来」，而日志里什么都没有。
          const trace = (window as unknown as { AibooTrace?: { log(m: string): void } }).AibooTrace;
          trace?.log('setBackground 失败 url=' + (backgroundUrl ?? 'null')
            + ' err=' + (error instanceof Error ? error.message : String(error)));
        });
      }
      setDepthActive(false);
      return;
    }
    const runtime = runtimeRef.current;
    if (!runtime) return;

    const depthUrl = backgroundUrl ? deriveDepthUrl(backgroundUrl) : null;
    if (!backgroundUrl || !depthUrl) {
      teardownDepthLayer(runtime);
      setDepthActive(false);
      return;
    }

    let cancelled = false;
    void setDepthParallaxBackground(runtime, {
      backgroundTextureUrl: backgroundUrl,
      depthTextureUrl: depthUrl,
    }).then((active) => {
      if (cancelled) return;
      setDepthActive(active);
    });

    return () => {
      cancelled = true;
    };
    // runtimeReadyTick 变化=新 runtime 就绪，需重建景深层。
  }, [backgroundUrl, runtimeReadyTick, nativeActive]);

  // surface 变化时（主页↔DJ 切换，同一 runtime 复用）立即更新取景目标并重绘。
  useEffect(() => {
    if (nativeActive) {
      if (!nativeReadyRef.current) return;
      const bounds = applyNativeLayout({ surface, transform: transformRef.current });
      if (bounds) onModelBounds?.(bounds);
      return;
    }
    const runtime = runtimeRef.current;
    const container = containerRef.current;
    if (!runtime || !container) return;
    setFramingTarget(runtime, surface);
    updateStageTransform(runtime, container, transformRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [surface, nativeActive]);

  useEffect(() => {
    if (nativeActive) {
      if (motionName && nativeReadyRef.current) playNativeMotion(motionName);
      return;
    }
    if (!runtimeRef.current || !motionName) {
      return;
    }

    void startMotion(runtimeRef.current, avatar, motionName).catch((error) => {
      console.error(error);
    });
  }, [avatar, motionName, nativeActive]);

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (!interactive) return;
    const container = containerRef.current;
    if (!container) {
      return;
    }

    dragStateRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
    };
    doubleTapRef.current.reset();

    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (!interactive) return;
    const container = containerRef.current;
    const runtime = runtimeRef.current;
    const dragState = dragStateRef.current;
    if (!container) {
      return;
    }

    if (runtime && (event.pointerType === 'mouse' || event.pointerType === 'pen')) {
      focusRuntime(runtime, container, event.clientX, event.clientY);
    }

    if (!dragState || dragState.pointerId !== event.pointerId) {
      return;
    }

    dragState.lastX = event.clientX;
    dragState.lastY = event.clientY;

    const deltaX = event.clientX - dragState.startX;
    const deltaY = event.clientY - dragState.startY;

    // 仅用位移判定「是否算一次拖动」(用于排除双击)；touch 阈值放宽到 20px 容指腹抖动，
    // mouse/pen 保持 8px。构图改由后台配置驱动，APP 不再拖拽/缩放角色（避免误触）。
    doubleTapRef.current.trackMove(event.pointerType, deltaX, deltaY);
  }

  function handlePointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragStateRef.current;
    if (drag?.pointerId !== event.pointerId) {
      return;
    }

    dragStateRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
    setStatus('就绪');

    // 竖向滑动切换角色（仅触摸，保证 PC 行为不变）：位移足够大且以纵向为主时，上滑=下一个/下滑=上一个。
    if (onSwitchAvatar && event.pointerType === 'touch') {
      // Android WebView 甩动手势会被浏览器抢占，补发的 pointerup/cancel 坐标恒为 (0,0)——
      // 直接用会算出 dy=-startY 永远判成 next（「下滑变上滑」的根因）。改用最后已知坐标。
      const endX = event.clientX === 0 && event.clientY === 0 ? drag.lastX : event.clientX;
      const endY = event.clientX === 0 && event.clientY === 0 ? drag.lastY : event.clientY;
      const dx = endX - drag.startX;
      const dy = endY - drag.startY;
      if (Math.abs(dy) > 60 && Math.abs(dy) > Math.abs(dx) * 1.4) {
        onSwitchAvatar(dy < 0 ? 'next' : 'prev');
        return; // 已作为滑动处理，不再触发 tap/双击
      }
    }

    // 双击检测（ALL-440）：touch 420ms/20px、mouse/pen 320ms/8px（doubleTap 纯逻辑内部判定）。
    if (doubleTapRef.current.registerUp(event.pointerType)) {
      recenterFacing(); // 先回正朝向（同步），再异步刷新人设
      onDoubleTap?.();
    }
  }

  // pointercancel 与 pointerup 必须分开（ALL-440）：cancel 只清理当前 pointer/drag 状态，
  // 不计 tap、不更新 lastUpAt、不触发双击——Android WebView 抢手势补发的 cancel 不该污染下一次双击。
  function handlePointerCancel(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragStateRef.current;
    if (drag?.pointerId !== event.pointerId) {
      return;
    }
    dragStateRef.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // pointercancel 通常已自动释放捕获，忽略重复释放
    }
    doubleTapRef.current.cancel();
  }

  function handlePointerLeave() {
    if (runtimeRef.current) {
      resetRuntimeFocus(runtimeRef.current);
    }
  }

  // 双击回正：陀螺仪基线/门控锚点重校准到当前持机姿态（之后此姿势=正面），并把 focus 归零。
  // 基线只在传感器首帧锁定，持机角度变了角色就固定歪着；刷新配置只更新人设不会动朝向。
  function recenterFacing() {
    tiltRecenterRef.current?.();
    if (nativeActive) {
      if (nativeReadyRef.current) resetNativeFocus();
    } else {
      const runtime = runtimeRef.current;
      if (runtime) resetRuntimeFocus(runtime);
    }
  }

  return (
    <div
      className={`stage-shell${depthActive ? ' depth-active' : ''}`} data-avatar-id={avatar.id}
      ref={shellRef}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onPointerLeave={handlePointerLeave}
    >
      {backgroundUrl ? (
        <div className="stage-bg" aria-hidden="true">
          <div
            ref={bgImgRef}
            className="stage-bg__img"
            style={{ backgroundImage: `url(${backgroundUrl})` }}
          />
          {ambient === 'soft' ? <div className="stage-bg__ambient" /> : null}
        </div>
      ) : null}
      <div ref={containerRef} className="stage-canvas" />
      {interactive ? (
        <>
          <div className="stage-hint">双击模型可拉取最新人设/构图。</div>
          <div className="stage-status">{status}</div>
        </>
      ) : null}
    </div>
  );
}
