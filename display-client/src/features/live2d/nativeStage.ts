// 原生 Live2D 渲染层的 JS 侧编排（低端机路径）。
//
// 职责边界：JS 是大脑，原生是显示器。
// - 构图：复用 live2dEngine 的 computeAutoFit/computeModelLayout 纯函数算出像素布局，
//   折算成视口分数发给原生 → 与 WebView 渲染逐值等价（同一套数学、同一份输入）。
// - 模型清单：复用 createAugmentedSettings（动作命名组注入 + 低端纹理降档）。
// - 表情/参数：由 paramFlatten 拍平成参数 map 走 setOverlayTargets（与 WebView 的
//   buildMixedParameters 同语义）；口型/换装分通道硬写。
// - 本模块持有单例状态：一个 App 同时至多一个原生模型（对齐 WebView「一个上下文一个模型」）。
import { Capacitor } from '@capacitor/core';
import {
  NativeLive2D,
  isNativeLive2DPluginAvailable,
  type NativeLive2DLayout,
  type NativeLive2DParamInfo,
} from '../../lib/nativeLive2dBridge.ts';
import {
  SURFACE_FRAMING,
  computeAutoFit,
  computeModelLayout,
  createAugmentedSettings,
  findIdleMotionKey,
  resolveIdleBeatKeys,
  type ModelBounds,
  type StageTransform,
} from './live2dEngine.ts';
import { shouldUseNativeLive2D } from '../../lib/deviceTier.ts';
import { clearExpressionFileCache, flattenExpressionState, type ExpressionFilePayload } from './paramFlatten.ts';
import { getAvatarAction, getAvatarNeutralExpressionId } from './avatarManifest.ts';
import type { AvatarManifest, ExpressionLayer, ParameterOverride, UnifiedAction } from './avatarManifest.ts';
import type { SurfaceKey } from './types.ts';
import {
  createLifecycleTrace,
  recordLifecyclePhase,
  type HandheldLifecycleTrace,
} from '../../lib/handheldLifecycleTrace.ts';

const HTML_ACTIVE_CLASS = 'native-live2d';
// 原生清屏底色：接近 shuangsheng 舞台渐变的深色，背景图加载前兜底。
const DEFAULT_CLEAR_COLOR = '#14090f';
// 无背景图时 GL 层实际清成的颜色。原生模式下 DOM 底色必须整面透明（否则盖死角色），
// 「屏幕底色」这件事就只剩 GL 能承担 —— 宿主要别的底色（如 holo 昼夜白/黑）走
// setNativeClearColor 覆盖；默认仍是 DEFAULT_CLEAR_COLOR，其余端零影响。
let clearColor: string = DEFAULT_CLEAR_COLOR;
const MOUTH_THROTTLE_MS = 66;
const FOCUS_THROTTLE_MS = 100;

export type NativeStageState = {
  avatar: AvatarManifest;
  canvasWidthPx: number;
  canvasHeightPx: number;
  /** 原生返回的参数表：paramFlatten 的 baseline/clamp 依据。 */
  paramInfo: Map<string, NativeLive2DParamInfo>;
  surface: SurfaceKey;
  transform: StageTransform;
  containerRect: { left: number; top: number; width: number; height: number };
  viewportSize?: { width: number; height: number };
  lastBounds: ModelBounds | null;
  /** 已提交给原生 renderer 的背景 URL；用于热恢复时只更新真实变化。 */
  backgroundUrl: string | null;
};

let active: NativeStageState | null = null;
let showToken = 0;
let activeTrace: HandheldLifecycleTrace | null = null;

/**
 * 生命周期串行链：destroyNativeStage(hide/releaseModel) 与 showAvatarModel(showModel)
 * 都走 Capacitor 桥，桥侧插件方法在线程池上并发执行、到达 GL 队列的顺序不保。
 * 实测竞态：切换时 releaseModel 偶发落在 showModel 的 load 之后 → 新模型刚 set 即被置 null
 * → 首帧回调永不触发 → JS 侧卡到 8s 安全定时器（连滑"卡死+丢手势"的真根因）。
 * 所有生命周期入口都挂到这条链上，保证桥调用按发出顺序到达原生。
 */
let lifecycleChain: Promise<void> = Promise.resolve();

/** 主 App 等原生完整帧；Surface 丢失时必须有界，不能永久卡住 React 生命周期。 */
export async function waitForNativeShowFrame(
  lifecycleTraceId?: number,
  showImpl: (options?: { lifecycleTraceId?: number }) => Promise<void> = (options) => NativeLive2D.show(options),
  timeoutMs = 3000,
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      showImpl(lifecycleTraceId === undefined ? undefined : { lifecycleTraceId }),
      new Promise<void>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('native composite frame timeout')), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

// ---- 可用性 ----

let cachedDecision: boolean | undefined;

/** 本次会话是否走原生渲染层（判定缓存；插件在包但 .so 失效的情况由 showModel 失败兜底回 WebView）。 */
export function nativeStageEnabled(): boolean {
  if (cachedDecision === undefined) {
    cachedDecision = shouldUseNativeLive2D(isNativeLive2DPluginAvailable());
  }
  return cachedDecision;
}

/**
 * 模型是否为随包本地资产：只认 public/live2D/ 下的内置模型。
 * 服务端下载的角色（avatars/... 落在 app data，不在 APK assets）与远端 URL 都走 WebView。
 */
export function isBundledModelJson(modelJson: string): boolean {
  if (/^(data|blob):/i.test(modelJson)) return false;
  if (/^(https?:)?\/\//i.test(modelJson) && !modelJson.startsWith(window.location.origin)) return false;
  return assetPathFromUrl(modelJson).startsWith('public/live2D/');
}

/** URL/路径 → 相对 web 根的干净路径（去 origin、去 './'、去前导 '/'、解码）。 */
function normalizeAppPath(url: string): string {
  let path = url;
  try {
    if (/^https?:\/\//i.test(url)) path = new URL(url).pathname;
  } catch { /* 保持原样 */ }
  try {
    path = decodeURI(path);
  } catch { /* 未编码路径原样使用 */ }
  // Vite base='./' 时资产 URL 以 './' 开头；assets 路径不接受相对段
  return path.replace(/^(\.\/)+/, '').replace(/^\/+/, '');
}

/**
 * 页面 URL/路径 → APK assets 路径。两种宿主：
 * - 主 App（Capacitor http://localhost/）：web 根即 assets/public/ → 加 'public/' 前缀；
 * - 屏保（appassets.androidplatform.net/assets/…）：URL 已含 assets 根路径 → 去 'assets/' 即可。
 */
export function assetPathFromUrl(url: string): string {
  const path = normalizeAppPath(url);
  if (path.startsWith('assets/')) return path.slice('assets/'.length);
  return `public/${path}`;
}

export function getNativeStageState(): NativeStageState | null {
  return active;
}

// ---- 生命周期 ----

export type ShowAvatarOptions = {
  surface: SurfaceKey;
  transform: StageTransform;
  containerRect?: { left: number; top: number; width: number; height: number };
  /**
   * 分数基准视口。缺省沿用「舞台容器」——主 App/holo 里容器就是整屏，两者等价。
   * ★但当宿主把角色放进**子区域**时（展示台的左列），容器 ≠ 整屏：
   * anchorXFrac 按容器宽算出来、却被原生按整屏宽应用，角色会跑到屏幕中间。
   * 这种宿主必须显式传真实屏幕尺寸。
   */
  viewportSize?: { width: number; height: number };
  costumeParams?: Record<string, number>;
  backgroundUrl?: string | null;
  /** 原生渲染目标帧率。默认 15（极低端地板，如 U1 Pro）。够强的设备（如 U3 八核）可传更高。 */
  targetFps?: number;
  /** 掌机主页的稳定帧请求号；只用于固定字段生命周期日志。 */
  lifecycleRequestId?: number;
};

/**
 * 加载并显示角色模型。重复调用同 avatar 幂等（只更新构图），不同 avatar 先卸旧模型。
 * 失败时抛错，调用方（Live2DStage）回落 WebView 渲染。
 */
export async function showAvatarModel(
  avatar: AvatarManifest,
  options: ShowAvatarOptions,
): Promise<NativeStageState> {
  const trace = options.lifecycleRequestId === undefined
    ? null
    : createLifecycleTrace('[handheld-home]', options.lifecycleRequestId);
  activeTrace = trace;
  recordLifecyclePhase(trace, 'request');
  return showAvatarModelAttempt(avatar, options, true, trace);
}

async function showAvatarModelAttempt(
  avatar: AvatarManifest,
  options: ShowAvatarOptions,
  retryHotTimeout: boolean,
  trace: HandheldLifecycleTrace | null,
): Promise<NativeStageState> {
  const token = ++showToken;
  const requestedBackgroundUrl = options.backgroundUrl ?? null;

  if (active && active.avatar.modelJson === avatar.modelJson) {
    const hotState = active;
    hotState.avatar = avatar;
    await applyLayoutAndWait(options);
    if (token !== showToken) throw new Error('superseded');
    if (hotState.backgroundUrl !== requestedBackgroundUrl) {
      await setActiveNativeBackground(hotState, requestedBackgroundUrl);
      if (token !== showToken) throw new Error('superseded');
    }
    try {
      await waitForNativeShowFrame(options.lifecycleRequestId);
    } catch (error) {
      if (token !== showToken) throw new Error('superseded');
      if (retryHotTimeout && (error as Error)?.message === 'native composite frame timeout') {
        const recoveryGeneration = token + 1;
        await destroyNativeStage();
        // destroy 等待原生 pause/release 时，导航、park 或新 show 都会推进 generation。
        // 只有仍持有 recovery generation 的请求才有资格启动唯一一次 cold retry。
        if (showToken !== recoveryGeneration) throw new Error('superseded');
        activeTrace = trace;
        return showAvatarModelAttempt(avatar, options, false, trace);
      }
      throw error;
    }
    if (token !== showToken) throw new Error('superseded');
    recordLifecyclePhase(trace, 'composite_ready');
    document.documentElement.classList.add(HTML_ACTIVE_CLASS);
    return hotState;
  }

  const response = await fetch(encodeURI(avatar.modelJson));
  if (!response.ok) throw new Error(`model settings fetch failed: ${response.status}`);
  const rawSettings = (await response.json()) as Record<string, unknown>;
  const settings = createAugmentedSettings(rawSettings, avatar);
  // 原生端按 modelDir + 相对路径读 assets；增强 settings 里的 url 字段仅 WebView 用，剔除防混淆。
  delete (settings as { url?: unknown }).url;

  const modelDir = assetPathFromUrl(avatar.modelJson).replace(/[^/]+$/, '');
  const idleMotionGroup = findIdleMotionKey(avatar);
  const idleBeatGroups = resolveIdleBeatKeys(avatar);

  if (token !== showToken) throw new Error('superseded'); // 竞态：期间切了角色

  // 等此前的 destroyNativeStage(hide/releaseModel) 落地再发 showModel（见 lifecycleChain 注释）。
  await lifecycleChain;
  if (token !== showToken) throw new Error('superseded');

  const backgroundPayload = await backgroundPayloadForUrl(requestedBackgroundUrl);
  if (token !== showToken) throw new Error('superseded');
  await NativeLive2D.setBackground(backgroundPayload);
  if (token !== showToken) throw new Error('superseded');

  const result = await NativeLive2D.showModel({
    settingsJson: JSON.stringify(settings),
    modelDir,
    idleMotionGroup,
    idleBeatGroups,
    persistentParams: options.costumeParams ?? {},
    targetFps: options.targetFps ?? 15,
    backgroundColor: clearColor,
    lifecycleTraceId: options.lifecycleRequestId,
    layout: { anchorXFrac: 0.5, bottomYFrac: 0.95, widthFrac: 0.9, heightFrac: 0.9 },
  });

  if (token !== showToken) throw new Error('superseded');

  // 首次调用 setBackground 时原生 GL host 可能尚未由 showModel 建立；层建好后重提同一载荷，
  // 让最终 show() 的 composite gate 真正等待到背景与稳定构图同帧。
  await NativeLive2D.setBackground(backgroundPayload);
  if (token !== showToken) throw new Error('superseded');

  resetExpressionChannels(); // 新模型：清 playAction 分层与 exp3 缓存
  active = {
    avatar,
    canvasWidthPx: result.canvasWidthPx,
    canvasHeightPx: result.canvasHeightPx,
    paramInfo: new Map(result.params.map((p) => [p.id, p])),
    surface: options.surface,
    transform: options.transform,
    containerRect: options.containerRect ?? viewportRect(),
    ...(options.viewportSize === undefined ? {} : { viewportSize: options.viewportSize }),
    lastBounds: null,
    backgroundUrl: requestedBackgroundUrl,
  };
  await applyLayoutAndWait(options);
  if (token !== showToken) throw new Error('superseded');
  await waitForNativeShowFrame(options.lifecycleRequestId);
  if (token !== showToken) throw new Error('superseded');
  recordLifecyclePhase(trace, 'composite_ready');

  // showModel 的首帧仍是占位构图；真实布局后的下一张完整帧落地后才让 WebView 穿透。
  document.documentElement.classList.add(HTML_ACTIVE_CLASS);
  return active;
}

/** 暂停原生层并移除页面透明态；模型、纹理与背景全部保留，供主页热恢复。 */
export async function parkNativeStage(): Promise<void> {
  // 先作废所有尚未完成的 show：否则设置页已经拿到 pause 确认后，旧 cold load 仍可能
  // 继续调用 show()，把主页 renderer 在预览层背后重新唤醒。
  showToken++;
  document.documentElement.classList.remove(HTML_ACTIVE_CLASS);
  const trace = activeTrace;
  if (isNativeLive2DPluginAvailable()) await NativeLive2D.hide();
  recordLifecyclePhase(trace, 'parked');
}

/** 兼容旧调用方；新生命周期语义统一称 park。 */
export const hideNativeStage = parkNativeStage;

/** 彻底卸载（切非原生路径/组件卸载）。 */
export async function destroyNativeStage(): Promise<void> {
  const trace = activeTrace;
  showToken++;
  active = null;
  resetExpressionChannels();
  document.documentElement.classList.remove(HTML_ACTIVE_CLASS);
  const run = lifecycleChain.then(async () => {
    if (!isNativeLive2DPluginAvailable()) return;
    try {
      await NativeLive2D.hide();
      await NativeLive2D.releaseModel();
    } catch { /* ignore */ }
  });
  lifecycleChain = run.catch(() => {});
  await run;
  recordLifecyclePhase(trace, 'destroyed');
  if (activeTrace === trace) activeTrace = null;
}

/** DOM 帘幕真正撤下时记录；请求号不匹配则忽略旧 ready。 */
export function markNativeStageRevealed(requestId: number): void {
  if (activeTrace?.id !== requestId) return;
  recordLifecyclePhase(activeTrace, 'revealed');
}

// ---- 构图 ----

function viewportRect() {
  return { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
}

/**
 * 与 live2dEngine.fitModel 完全同构：autoFit 基准 × 用户增量 → computeModelLayout，
 * 再折算成「相对视口」分数发给原生。同时产出 ModelBounds 供 App 定位气泡等。
 * 纯函数导出：主 App（nativeStage 单例）与屏保适配器共用，构图数学只此一份。
 */
export function computeLayoutFractions(input: {
  avatar: AvatarManifest;
  canvasWidthPx: number;
  canvasHeightPx: number;
  surface: SurfaceKey;
  transform: StageTransform;
  containerRect: { left: number; top: number; width: number; height: number };
  viewportWidth: number;
  viewportHeight: number;
}): { layout: NativeLive2DLayout; bounds: ModelBounds } {
  const { avatar, containerRect } = input;
  const width = containerRect.width || 800;
  const rawHeight = containerRect.height || 800;

  // 绝对构图（后台 home/login/dj 页面配置的 loginFraming/homeFraming/djFraming）：
  // 与 Pixi 路径(live2dEngine.ts fitModel)对齐——直接按绝对语义施加 + 视口包含钳制。
  if (input.transform.absolute === true) {
    const layout = computeModelLayout({
      width,
      rawHeight,
      modelBaseWidth: input.canvasWidthPx,
      modelBaseHeight: input.canvasHeightPx,
      scaleMultiplier: avatar.scaleMultiplier,
      verticalOffset: avatar.verticalOffset,
      modelTransform: avatar.modelTransform,
      transform: { scale: input.transform.scale, offsetX: input.transform.offsetX, offsetY: input.transform.offsetY },
      containment: true,
    });

    const vw = input.viewportWidth || width;
    const vh = input.viewportHeight || rawHeight;
    const nativeLayout: NativeLive2DLayout = {
      anchorXFrac: (containerRect.left + layout.modelX) / vw,
      bottomYFrac: (containerRect.top + layout.modelY) / vh,
      widthFrac: layout.modelPixelWidth / vw,
      heightFrac: layout.modelPixelHeight / vh,
    };

    const bounds: ModelBounds = {
      top: layout.modelY - layout.modelPixelHeight,
      bottom: layout.modelY,
      left: layout.modelX - layout.modelPixelWidth * 0.5,
      right: layout.modelX + layout.modelPixelWidth * 0.5,
      modelWidth: layout.modelPixelWidth,
      modelHeight: layout.modelPixelHeight,
    };
    return { layout: nativeLayout, bounds };
  }

  const autoBase = computeAutoFit({
    width,
    rawHeight,
    modelBaseWidth: input.canvasWidthPx,
    modelBaseHeight: input.canvasHeightPx,
    scaleMultiplier: avatar.scaleMultiplier,
    verticalOffset: avatar.verticalOffset,
    modelTransform: avatar.modelTransform,
    headAnchorY: avatar.headAnchorY ?? 0.16,
    headSizeNorm: avatar.headSizeNorm ?? 0.18,
    target: SURFACE_FRAMING[input.surface],
  });

  const effective: StageTransform = {
    scale: autoBase.scale * input.transform.scale,
    offsetX: autoBase.offsetX + input.transform.offsetX,
    offsetY: autoBase.offsetY + input.transform.offsetY,
  };

  const layout = computeModelLayout({
    width,
    rawHeight,
    modelBaseWidth: input.canvasWidthPx,
    modelBaseHeight: input.canvasHeightPx,
    scaleMultiplier: avatar.scaleMultiplier,
    verticalOffset: avatar.verticalOffset,
    modelTransform: avatar.modelTransform,
    transform: effective,
    // ★与 Pixi 路径(live2dEngine.ts fitModel)对齐：预设里的 topClampMin 必须转发。
    // 此前原生路径漏转，petFull/petStrip 的「放开钳制」在原生上从未生效——
    // 底条位置滑块死透的根因之一（另一半在 SURFACE_FRAMING.petStrip 的注释里）。
    topClampMin: SURFACE_FRAMING[input.surface].topClampMin,
  });

  const vw = input.viewportWidth || width;
  const vh = input.viewportHeight || rawHeight;
  const nativeLayout: NativeLive2DLayout = {
    anchorXFrac: (containerRect.left + layout.modelX) / vw,
    bottomYFrac: (containerRect.top + layout.modelY) / vh,
    widthFrac: layout.modelPixelWidth / vw,
    heightFrac: layout.modelPixelHeight / vh,
  };

  const bounds: ModelBounds = {
    top: layout.modelY - layout.modelPixelHeight,
    bottom: layout.modelY,
    left: layout.modelX - layout.modelPixelWidth * 0.5,
    right: layout.modelX + layout.modelPixelWidth * 0.5,
    modelWidth: layout.modelPixelWidth,
    modelHeight: layout.modelPixelHeight,
  };
  return { layout: nativeLayout, bounds };
}

export function computeNativeLayout(
  state: NativeStageState,
): { layout: NativeLive2DLayout; bounds: ModelBounds } {
  return computeLayoutFractions({
    avatar: state.avatar,
    canvasWidthPx: state.canvasWidthPx,
    canvasHeightPx: state.canvasHeightPx,
    surface: state.surface,
    transform: state.transform,
    containerRect: state.containerRect,
    // 视口基准用舞台容器（恒定），不用 window.innerHeight：键盘弹出时 innerHeight 缩小，
    // 而原生 GL 层已锁全高不随键盘收缩（见 NativeLive2DPlugin），分数基准必须与 GL 层一致。
    viewportWidth: state.viewportSize?.width || state.containerRect.width || window.innerWidth,
    viewportHeight: state.viewportSize?.height || state.containerRect.height || window.innerHeight,
  });
}

type NativeLayoutInput = {
  surface?: SurfaceKey;
  transform?: StageTransform;
  containerRect?: { left: number; top: number; width: number; height: number };
};

function updateNativeLayoutState(input: NativeLayoutInput): {
  layout: NativeLive2DLayout;
  bounds: ModelBounds;
} | null {
  if (!active) return null;
  if (input.surface) active.surface = input.surface;
  if (input.transform) active.transform = input.transform;
  if (input.containerRect) active.containerRect = input.containerRect;

  const next = computeNativeLayout(active);
  active.lastBounds = next.bounds;
  return next;
}

/** 更新构图输入（surface/transform/容器矩形任一变化后调用）并下发。返回新 bounds。 */
export function applyLayout(input: NativeLayoutInput): ModelBounds | null {
  const next = updateNativeLayoutState(input);
  if (!next) return null;
  void NativeLive2D.setLayout(next.layout).catch(() => { /* 层未建时无害 */ });
  return next.bounds;
}

/** 首次交接/热恢复用：确认真实构图已提交，再申请下一张完整帧。 */
async function applyLayoutAndWait(input: NativeLayoutInput): Promise<ModelBounds | null> {
  const next = updateNativeLayoutState(input);
  if (!next) return null;
  await NativeLive2D.setLayout(next.layout);
  return next.bounds;
}

// ---- 背景 ----

export type NativeBackgroundPayload =
  | { color: string; clearImage: true }
  | { assetPath: string }
  | { dataUrl: string };

/**
 * 背景 URL → 原生 setBackground 载荷（主 App 与屏保适配器共用）：
 * 同源静态路径（Capacitor/appassets 下都是随包资产）直接给 assets 路径；
 * 远端/data URL 走 canvas 重编码成 dataUrl（跨域污染/加载失败回落纯色）。
 */
export async function backgroundPayloadForUrl(url: string | null): Promise<NativeBackgroundPayload> {
  if (!url) return { color: clearColor, clearImage: true };
  const crossOrigin = /^(https?:)?\/\//i.test(url) && !url.startsWith(window.location.origin);
  const inlineData = /^(data|blob):/i.test(url);
  if (!crossOrigin && !inlineData) {
    return { assetPath: assetPathFromUrl(url.split('?')[0]) };
  }
  try {
    return { dataUrl: await reencodeImageToDataUrl(url, 1280) };
  } catch {
    return { color: clearColor, clearImage: true };
  }
}

/**
 * 覆盖「无背景图时」的 GL 清屏色（#RRGGBB 或 #AARRGGBB）。原生模式下 DOM 整面透明，
 * 这就是用户看到的屏幕底色。已在渲染且当前没有背景图时立即重清，方便运行时切主题。
 */
export function setNativeClearColor(hex: string): void {
  if (clearColor === hex) return;
  clearColor = hex;
  if (active && !active.backgroundUrl) {
    void NativeLive2D.setBackground({ color: hex, clearImage: true });
  }
}

/**
 * 原生模式下 DOM 背景层全透明（html.native-live2d 的 CSS），背景改由原生 GL 画。
 */
export async function setNativeBackground(url: string | null): Promise<void> {
  const t = (window as unknown as { AibooTrace?: { log(m: string): void } }).AibooTrace;
  if (!active) { t?.log('setNativeBackground 跳过：无 active'); return; }
  if (active.backgroundUrl === url) {
    t?.log('setNativeBackground 早退：记账值已等于目标 ' + (url || 'null'));
    return;
  }
  t?.log('setNativeBackground ' + (active.backgroundUrl || 'null') + ' → ' + (url || 'null'));
  await setActiveNativeBackground(active, url);
}

async function setActiveNativeBackground(state: NativeStageState, url: string | null): Promise<void> {
  const payload = await backgroundPayloadForUrl(url);
  await NativeLive2D.setBackground(payload);
  // 异步图片重编码期间可能已经切了模型；不能把旧请求的 URL 写进新 state。
  const t = (window as unknown as { AibooTrace?: { log(m: string): void } }).AibooTrace;
  t?.log('setBackground 已下发 ' + (url || 'null') + ' 记账写回=' + (active === state));
  if (active === state) state.backgroundUrl = url;
}

function reencodeImageToDataUrl(url: string, maxEdge: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('no 2d context');
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', 0.82));
      } catch (error) {
        reject(error);
      }
    };
    img.onerror = () => reject(new Error(`bg image load failed: ${url}`));
    img.src = url;
  });
}

// ---- 参数/动作/口型/朝向通道 ----

export function setNativeOverlayTargets(params: Record<string, number>): void {
  if (!active) return;
  void NativeLive2D.setOverlayTargets({ params }).catch(() => {});
}

// 持久参数拆两个 JS 侧来源，对齐引擎每帧「先 costumeParamOverrides、后 profileCostumeParamOverrides」
// 的写入顺序：profile 装扮覆盖 legacy 换装（同名参数 profile 赢）。
let legacyPersistentParams: Record<string, number> = {};
let profileCostumeParams: Record<string, number> = {};

function publishPersistentParams(): void {
  if (!active) return;
  const params = { ...legacyPersistentParams, ...profileCostumeParams };
  void NativeLive2D.setPersistentParams({ params }).catch(() => {});
}

export function setNativePersistentParams(params: Record<string, number>): void {
  legacyPersistentParams = params;
  publishPersistentParams();
}

/** v2 profile 装扮参数（原生镜像，见 nativeV2ProfileBinding）：与 legacy 换装合并后下发。 */
export function setNativeProfileCostumeParams(params: Record<string, number>): void {
  profileCostumeParams = params;
  publishPersistentParams();
}

let mouthTimer: ReturnType<typeof setTimeout> | null = null;
let mouthPending: Record<string, number> | null = null;
let mouthLastSentAt = 0;

/** 口型：节流 66ms trailing——TTS 逐帧回调直连桥会压垮 0.99GHz 单核。 */
export function setNativeMouthParams(overrides: ParameterOverride[]): void {
  if (!active) return;
  const params: Record<string, number> = {};
  for (const o of overrides) params[o.id] = o.value;
  mouthPending = params;

  const now = Date.now();
  const dueIn = Math.max(0, MOUTH_THROTTLE_MS - (now - mouthLastSentAt));
  if (mouthTimer !== null) return;
  mouthTimer = setTimeout(() => {
    mouthTimer = null;
    if (!mouthPending) return;
    mouthLastSentAt = Date.now();
    const payload = mouthPending;
    mouthPending = null;
    void NativeLive2D.setMouthParams({ params: payload }).catch(() => {});
  }, dueIn);
}

export function playNativeMotion(group: string): void {
  if (!active) return;
  void NativeLive2D.playMotion({ group }).catch(() => {});
}

let focusLastSentAt = 0;

/** 朝向（陀螺仪/指针）：节流 100ms 丢帧即可，原生 dragManager 自带平滑。 */
export function setNativeFocus(x: number, y: number): void {
  if (!active) return;
  const now = Date.now();
  if (now - focusLastSentAt < FOCUS_THROTTLE_MS) return;
  focusLastSentAt = now;
  void NativeLive2D.setFocus({ x, y }).catch(() => {});
}

/** 回正朝向（双击）：强制发 focus 归零，绕开 100ms 节流（节流可能刚发过陀螺仪值把它吞掉）。 */
export function resetNativeFocus(): void {
  if (!active) return;
  focusLastSentAt = 0;
  void NativeLive2D.setFocus({ x: 0, y: 0 }).catch(() => {});
}

let parallaxLastSentAt = 0;

// 视差背景原生侧没有平滑（uniform 直写），必须贴近渲染帧率发才不硌；33ms≈30Hz 够顺。
const PARALLAX_THROTTLE_MS = 33;

/**
 * 陀螺仪背景视差（原生 GL 背景专用；WebView 路径走 CSS transform，见 Live2DStage）。
 * 入参即 parallaxOffset 的 px 结果，本函数折成归一化偏移并做 CSS→GL 方向换算：
 * CSS 背景逆倾斜移 (-x,-y)（y 下正）→ GL NDC（y 上正）就是 (-x, +y)。
 */
export function setNativeBackgroundParallax(offsetX: number, offsetY: number, maxPx: number): void {
  if (!active || maxPx <= 0) return;
  const now = Date.now();
  if (now - parallaxLastSentAt < PARALLAX_THROTTLE_MS) return;
  parallaxLastSentAt = now;
  void NativeLive2D.setBackgroundParallax({ x: -offsetX / maxPx, y: offsetY / maxPx }).catch(() => {});
}

// ---- 表情状态（拍平后走 overlay 通道，语义对齐 live2dEngine 的 expressionMix/playAction）----

let currentExpressionMix: ExpressionLayer[] = [];
let currentParameterOverrides: ParameterOverride[] = [];
let currentWatermarkVisible = false;
// playAction 分层（与引擎同构）：costume 持久、emotion 定时回落
let actionCostumeMix: ExpressionLayer[] = [];
let actionEmotionMix: ExpressionLayer[] = [];
let emotionResetTimer: ReturnType<typeof setTimeout> | null = null;
const DEFAULT_EMOTION_HOLD_MS = 3200;
let overlayRecomputeToken = 0;

function resetExpressionChannels(): void {
  currentExpressionMix = [];
  currentParameterOverrides = [];
  currentWatermarkVisible = false;
  actionCostumeMix = [];
  actionEmotionMix = [];
  profileCostumeParams = {};
  if (emotionResetTimer !== null) {
    clearTimeout(emotionResetTimer);
    emotionResetTimer = null;
  }
  overlayRecomputeToken++;
  clearExpressionFileCache();
}

async function fetchExpressionFile(url: string): Promise<ExpressionFilePayload> {
  const response = await fetch(encodeURI(url));
  if (!response.ok) throw new Error(`exp3 fetch failed ${response.status}: ${url}`);
  return (await response.json()) as ExpressionFilePayload;
}

/** 重算拍平参数并下发 overlay（防乱序：token 竞态守卫，exp3 fetch 是异步的）。 */
async function recomputeOverlay(avatar: AvatarManifest): Promise<void> {
  if (!active) return;
  const token = ++overlayRecomputeToken;
  const paramInfo = active.paramInfo;
  try {
    const flat = await flattenExpressionState({
      avatar,
      expressionMix: currentExpressionMix,
      parameterOverrides: currentParameterOverrides,
      watermarkVisible: currentWatermarkVisible,
      baseline: (id) => paramInfo.get(id)?.def ?? 0,
      fetchExpressionFile,
    });
    if (token !== overlayRecomputeToken || !active) return;
    setNativeOverlayTargets(flat);
  } catch {
    // 非关键控制通道；不记录可能携带资源路径的 Error 对象。
  }
}

export async function applyNativeExpressionMix(avatar: AvatarManifest, mix: ExpressionLayer[]): Promise<void> {
  currentExpressionMix = mix;
  await recomputeOverlay(avatar);
}

export async function setNativeParameterOverrides(
  avatar: AvatarManifest,
  overrides: ParameterOverride[],
): Promise<void> {
  currentParameterOverrides = overrides;
  await recomputeOverlay(avatar);
}

export async function setNativeWatermarkVisible(avatar: AvatarManifest, visible: boolean): Promise<void> {
  currentWatermarkVisible = visible;
  await recomputeOverlay(avatar);
}

function upsertLayer(layers: ExpressionLayer[], key: string, weight: number): ExpressionLayer[] {
  const next = layers.filter((layer) => layer.key !== key);
  next.push({ key, weight });
  return next;
}

function applyLayeredExpression(avatar: AvatarManifest): void {
  const combined = [...actionCostumeMix, ...actionEmotionMix];
  const mix = combined.length > 0
    ? combined
    : [{ key: getAvatarNeutralExpressionId(avatar), weight: 1 }];
  void applyNativeExpressionMix(avatar, mix);
}

/** 统一动作入口（引擎 playAction 的原生镜像）：motion 分流 / costume 持久 / emotion 定时回落。 */
export function playNativeAction(
  avatar: AvatarManifest,
  actionId: string,
  options?: { emotionHoldMs?: number },
): void {
  if (!active) return;
  const action: UnifiedAction | undefined = getAvatarAction(avatar, actionId);

  if (!action) {
    if (emotionResetTimer !== null) clearTimeout(emotionResetTimer);
    emotionResetTimer = null;
    actionEmotionMix = [];
    applyLayeredExpression(avatar);
    return;
  }

  if (action.source === 'motion') {
    playNativeMotion(action.ref);
    return;
  }

  if (action.kind === 'costume') {
    actionCostumeMix = upsertLayer(actionCostumeMix, action.ref, 1);
    applyLayeredExpression(avatar);
    return;
  }

  actionEmotionMix = [{ key: action.ref, weight: 1 }];
  applyLayeredExpression(avatar);
  if (emotionResetTimer !== null) clearTimeout(emotionResetTimer);
  emotionResetTimer = setTimeout(() => {
    emotionResetTimer = null;
    actionEmotionMix = [];
    applyLayeredExpression(avatar);
  }, options?.emotionHoldMs ?? DEFAULT_EMOTION_HOLD_MS);
}

/** 原生桥联通探针；非原生平台 no-op。 */
export async function pingNativeLive2D(): Promise<boolean> {
  if (!Capacitor.isNativePlatform() || !isNativeLive2DPluginAvailable()) return false;
  try {
    const r = await NativeLive2D.ping();
    return r.ok && r.coreLoaded;
  } catch {
    return false;
  }
}
