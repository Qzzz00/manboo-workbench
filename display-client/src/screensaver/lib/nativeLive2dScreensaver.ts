// 充电屏保的原生 Live2D 适配器（低端机路径）。
//
// 宿主是 DreamService 的裸 WebView（无 Capacitor），桥是 addJavascriptInterface 挂的
// window.AibooNativeLive2D（方法面与主 App 插件一致，参数为 JSON 字符串）。
// 构图/拍平/背景载荷全部复用 features/live2d 里同一份纯函数——两条原生宿主零漂移。
import {
  createAugmentedSettings,
  findIdleMotionKey,
  resolveIdleBeatKeys,
  type StageTransform,
} from '../../features/live2d/live2dEngine';
import {
  assetPathFromUrl,
  backgroundPayloadForUrl,
  computeLayoutFractions,
} from '../../features/live2d/nativeStage';
import { flattenExpressionState } from '../../features/live2d/paramFlatten';
import { getLive2DRendererPref } from '../../lib/deviceTier';
import type { AvatarManifest } from '../../features/live2d/types';
import type { SurfaceKey } from '../../features/live2d/types';

type BridgeShape = {
  available(): boolean;
  showModel(optsJson: string): void;
  setOverlayTargets(json: string): void;
  setPersistentParams(json: string): void;
  setMouthParams(json: string): void;
  playMotion(group: string): void;
  setLayout(json: string): void;
  setBackground(json: string): void;
  setBottomFade?(json: string): void;
  awaitNextFrame(): void;
  hide(): void;
};

declare global {
  interface Window {
    AibooNativeLive2D?: BridgeShape;
    __aibooNl2dResolve?: (result: unknown) => void;
    __aibooNl2dReject?: (message: string) => void;
  }
}

const HTML_ACTIVE_CLASS = 'native-live2d';
const MOUTH_THROTTLE_MS = 66;

type ActiveState = {
  avatar: AvatarManifest;
  canvasWidthPx: number;
  canvasHeightPx: number;
  paramDefaults: Map<string, number>;
  surface: SurfaceKey;
  transform: StageTransform;
  containerRect: { left: number; top: number; width: number; height: number };
};

let active: ActiveState | null = null;

function bridge(): BridgeShape | null {
  return typeof window !== 'undefined' ? window.AibooNativeLive2D ?? null : null;
}

/** 屏保是否走原生渲染：DreamService 注入了桥 + 核心 .so 可用。
 * 2026-07-29 起不再限低端机——与主 App/浮窗对齐，Android 三宿主统一走原生（见 deviceTier）。
 * 显式 renderer='webview' 覆盖（如 U3 固定浮窗要透明悬浮，原生 GL 路径背景/透明度支持不全）时强制走 Pixi。 */
export function screensaverNativeAvailable(): boolean {
  if (getLive2DRendererPref() === 'webview') return false;
  const b = bridge();
  if (!b) return false;
  try {
    return b.available();
  } catch {
    return false;
  }
}

export type NativeScreensaverOptions = {
  surface: SurfaceKey;
  transform: StageTransform;
  containerRect: { left: number; top: number; width: number; height: number };
  costume: { id: string; value: number }[];
  targetFps: number;
  /** 清屏色（#RRGGBB 不透明 / #AARRGGBB 带 alpha）。默认 #000000 不透明。
   * 浮窗悬浮传全透明 #00000000 → GL 空白处露出桌面（原生透明浮窗）。 */
  clearColor?: string;
};

/**
 * 加载并显示模型。控制器由调用方（Live2DScene）用下面的原语组装——
 * computeMouthValue/lipSync 参数解析等语义保持只在 Live2DScene 一处。
 * 失败抛错，调用方回落 WebView Pixi。
 */
export async function showNativeScreensaverModel(
  avatar: AvatarManifest,
  options: NativeScreensaverOptions,
): Promise<void> {
  const b = bridge();
  if (!b) throw new Error('native bridge missing');

  const response = await fetch(encodeURI(avatar.modelJson));
  if (!response.ok) throw new Error(`model settings fetch failed: ${response.status}`);
  const rawSettings = (await response.json()) as Record<string, unknown>;
  const settings = createAugmentedSettings(rawSettings, avatar);
  delete (settings as { url?: unknown }).url;

  const modelDir = assetPathFromUrl(avatar.modelJson).replace(/[^/]+$/, '');
  const costumeParams: Record<string, number> = {};
  for (const c of options.costume) costumeParams[c.id] = c.value;

  document.documentElement.classList.add(HTML_ACTIVE_CLASS);

  const result = await new Promise<{
    canvasWidthPx: number;
    canvasHeightPx: number;
    params: Array<{ id: string; def: number }>;
  }>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('showModel timeout')), 30000);
    window.__aibooNl2dResolve = (r) => {
      clearTimeout(timeout);
      resolve(r as never);
    };
    window.__aibooNl2dReject = (message) => {
      clearTimeout(timeout);
      reject(new Error(message));
    };
    b.showModel(
      JSON.stringify({
        settingsJson: JSON.stringify(settings),
        modelDir,
        idleMotionGroup: findIdleMotionKey(avatar),
        idleBeatGroups: resolveIdleBeatKeys(avatar),
        persistentParams: costumeParams,
        targetFps: options.targetFps,
        backgroundColor: options.clearColor ?? '#000000',
        layout: { anchorXFrac: 0.5, bottomYFrac: 0.95, widthFrac: 0.9, heightFrac: 0.9 },
      }),
    );
  });

  active = {
    avatar,
    canvasWidthPx: result.canvasWidthPx,
    canvasHeightPx: result.canvasHeightPx,
    paramDefaults: new Map(result.params.map((p) => [p.id, p.def])),
    surface: options.surface,
    transform: options.transform,
    containerRect: options.containerRect,
  };
  applyNativeScreensaverLayout({});
}

/** 构图更新（resize/初始化）。与主 App 同一份 computeLayoutFractions。 */
export function applyNativeScreensaverLayout(input: {
  containerRect?: { left: number; top: number; width: number; height: number };
}): void {
  const b = bridge();
  if (!b || !active) return;
  if (input.containerRect) active.containerRect = input.containerRect;
  const { layout } = computeLayoutFractions({
    avatar: active.avatar,
    canvasWidthPx: active.canvasWidthPx,
    canvasHeightPx: active.canvasHeightPx,
    surface: active.surface,
    transform: active.transform,
    containerRect: active.containerRect,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
  });
  b.setLayout(JSON.stringify(layout));
}

/**
 * 底部软边渐隐：原生 GL 路径的「防赛博截肢」。
 * Pixi 路径靠 pet.css 的 mask-image 实现，但 CSS 遮罩盖不到原生 GL 的 SurfaceView（独立系统图层），
 * 所以原生路径必须由 GL 侧擦 alpha。参数与那条 CSS 保持同一语义与同一组数值。
 * 桥方法在旧版原生包里可能不存在（可选签名），故做存在性判断，缺失时静默降级为不渐隐。
 */
export function setNativeBottomFade(fade: { start: number; end: number } | null): void {
  const b = bridge();
  if (!b || !active || typeof b.setBottomFade !== 'function') return;
  b.setBottomFade(JSON.stringify(fade ?? { start: 0, end: 0 }));
}

/** 掌机底栏先在 GL 内画，再画模型；WebView 按钮天然位于二者之上。 */
export function setNativeBottomBar(
  bottomBar: { heightFraction: number; color: string } | null,
): void {
  const b = bridge();
  if (!b || !active) return;
  b.setBackground(JSON.stringify({
    bottomBarHeightFraction: bottomBar?.heightFraction ?? 0,
    bottomBarColor: bottomBar?.color ?? '#00000000',
  }));
}

/** 等待原生 GL 真正画出下一张「背景/底栏 + 模型」合成帧。 */
export function waitNativeScreensaverCompositeFrame(timeoutMs = 3000): Promise<void> {
  const b = bridge();
  if (!b) return Promise.reject(new Error('native bridge missing'));
  return new Promise((resolve, reject) => {
    const onResolve = () => {
      clearTimeout(timeout);
      if (window.__aibooNl2dResolve === onResolve) window.__aibooNl2dResolve = undefined;
      if (window.__aibooNl2dReject === onReject) window.__aibooNl2dReject = undefined;
      resolve();
    };
    const onReject = (message: string) => {
      clearTimeout(timeout);
      if (window.__aibooNl2dResolve === onResolve) window.__aibooNl2dResolve = undefined;
      if (window.__aibooNl2dReject === onReject) window.__aibooNl2dReject = undefined;
      reject(new Error(message));
    };
    const timeout = setTimeout(() => onReject('native composite frame timeout'), timeoutMs);
    window.__aibooNl2dResolve = onResolve;
    window.__aibooNl2dReject = onReject;
    b.awaitNextFrame();
  });
}

/** 屏保背景（Screensaver.tsx 的 bgUrl）交给原生层画；非原生态 no-op。 */
export async function setNativeScreensaverBackground(url: string | null): Promise<void> {
  const b = bridge();
  if (!b || !active) return;
  const payload = await backgroundPayloadForUrl(url);
  b.setBackground(JSON.stringify(payload));
}

export function isNativeScreensaverActive(): boolean {
  return active !== null;
}

/** 屏保退出/回落时清理：藏层 + 摘 CSS 类（模型释放交给 DreamService detach）。 */
export function destroyNativeScreensaver(): void {
  active = null;
  document.documentElement.classList.remove(HTML_ACTIVE_CLASS);
  try {
    bridge()?.hide();
  } catch { /* ignore */ }
}

// ---- 控制原语（Live2DScene 用它们组装与 WebView 同形的 controller） ----

async function fetchExpressionFile(url: string) {
  const response = await fetch(encodeURI(url));
  if (!response.ok) throw new Error(`exp3 fetch failed ${response.status}`);
  return (await response.json()) as { Parameters?: Array<{ Id?: string; Value?: number; Blend?: string }> };
}

let mouthTimer: ReturnType<typeof setTimeout> | null = null;
let mouthPending: Record<string, number> | null = null;

/** 口型硬写（值已由调用方 computeMouthValue 映射）。节流 66ms 抵御逐音频帧回调。 */
export function setNativeScreensaverMouth(paramId: string, value: number): void {
  const b = bridge();
  if (!b || !active) return;
  mouthPending = { [paramId]: value };
  if (mouthTimer !== null) return;
  mouthTimer = setTimeout(() => {
    mouthTimer = null;
    const payload = mouthPending;
    mouthPending = null;
    if (payload) b.setMouthParams(JSON.stringify(payload));
  }, MOUTH_THROTTLE_MS);
}

let emotionToken = 0;

/** 表情：单 key 全权重 mix → paramFlatten 拍平 → overlay（与主 App 同一份语义）。 */
export function setNativeScreensaverExpression(avatar: AvatarManifest, key: string): void {
  const b = bridge();
  if (!b || !active) return;
  const token = ++emotionToken;
  void flattenExpressionState({
    avatar,
    expressionMix: [{ key, weight: 1 }],
    parameterOverrides: [],
    watermarkVisible: false,
    baseline: (id) => active?.paramDefaults.get(id) ?? 0,
    fetchExpressionFile,
  })
    .then((flat) => {
      if (token !== emotionToken || !active) return;
      b.setOverlayTargets(JSON.stringify(flat));
    })
    .catch(() => { /* 表情失败不影响屏保 */ });
}

/** 换装持久参数（DJ Param67 等）。 */
export function setNativeScreensaverCostume(params: { id: string; value: number }[]): void {
  const b = bridge();
  if (!b || !active) return;
  const map: Record<string, number> = {};
  for (const p of params) map[p.id] = p.value;
  b.setPersistentParams(JSON.stringify(map));
}
