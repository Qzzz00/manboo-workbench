import { registerPlugin, Capacitor } from '@capacitor/core';

import type { PetSettings } from './petSettingsStore';

/**
 * 桌宠浮窗原生插件（Overlay）的 TS wrapper。
 * 浏览器/非原生环境下 plugin 为 null，所有导出函数安全降级（返回 false / no-op）。
 */
export interface OverlayPluginDef {
  hasOverlayPermission(): Promise<{ granted: boolean }>;
  requestOverlayPermission(): Promise<void>;
  isRunning(): Promise<{ running: boolean }>;
  start(p: OverlayPluginRequest): Promise<void>;
  /** 隐藏预热持久化底条并启动服务，不把 MainActivity 收到后台。 */
  prewarm(p: OverlayPluginRequest): Promise<void>;
  stop(): Promise<void>;
  /** 只持久化底条参数不启动（侧键 F10 全局切换回放用）。参数面与 start 一致。 */
  saveStripParams(p: OverlayPluginRequest): Promise<void>;
  setDimensions(p: { widthDp: number; aspect: string }): Promise<void>;
  /** 底条取景热更新（不重启服务，evaluateJavascript 推给 pet 页）。服务没跑时原生侧 no-op。 */
  updateFraming(p: { headScreenY: number; faceScreenFrac: number }): Promise<void>;
  addListener(eventName: 'ready', cb: () => void): Promise<{ remove: () => Promise<void> }>;
}

type OverlayPluginRequest = {
  avatarId: string; widthDp?: number; aspect?: string; petQuery?: string; token?: string; aibooToken?: string; fixed?: boolean;
  xPx?: number; yPx?: number; widthPx?: number; heightPx?: number; touchThrough?: boolean; webTouchable?: boolean;
};

/** 把 PetSettings 折成 pet.html 的 URL 查询串（只带打开项，扩展新设置只改这里，原生不动）。 */
export function buildPetQuery(s: PetSettings, bgUrl?: string): string {
  const p = new URLSearchParams();
  if (s.bg) p.set('bg', '1');
  // bgUrl=主 App 解析出的后端角色背景（pet 页离线 avatar 没有 defaultBackground，需带进去）。
  if (s.bg && bgUrl) p.set('bgUrl', bgUrl);
  if (s.chibi) p.set('chibi', '1');
  if (s.gyro) p.set('gyro', '1');
  return p.toString();
}

const plugin = Capacitor.isNativePlatform() ? registerPlugin<OverlayPluginDef>('Overlay') : null;

export const overlayAvailable = (): boolean => plugin != null;

export async function overlayHasPermission(): Promise<boolean> {
  return plugin ? (await plugin.hasOverlayPermission()).granted : false;
}

export async function overlayRequestPermission(): Promise<void> {
  await plugin?.requestOverlayPermission();
}

export async function overlayIsRunning(): Promise<boolean> {
  return plugin ? (await plugin.isRunning()).running : false;
}

export type OverlayStartCtx = {
  token?: string; fixed?: boolean;
    /** 固定几何（原始像素）：U3 电台桌面用，让浮窗精确落在主界面「live2d 小浮窗」贴纸格子上，不传则走默认拖动位置/尺寸。 */
    xPx?: number; yPx?: number; widthPx?: number; heightPx?: number;
    /** 强制桌宠页渲染后端（覆盖 pet.localhost 源 localStorage 的历史 aiboo:live2d-renderer 持久值）。
     * pet.localhost 与主 App 不同源，读不到主 App 的 pref；且旧值跨安装持久，必须显式传覆盖。
     * 'native'=原生 GL（透明 clear 悬浮，提帧率+保物理，U3 固定浮窗用）；'webview'=Pixi。
     * 见 src/pet/main.tsx 的 ?renderer=。 */
    rendererMode?: 'webview' | 'native';
    /** 头部取景覆盖（hs=headSizeNorm 越小角色越大，ha=headAnchorY 纵向锚点）：U3 固定浮窗要
     * 「胸部以上、耳朵不超浮窗顶部」的自定义构图，与角色自带默认值不同。见 src/pet/main.tsx 的 ?hs=&ha=。 */
    framingHeadSizeNorm?: number; framingHeadAnchorY?: number;
    /** 取景**目标**覆盖（屏幕空间，与上面那对模型度量不是一回事）：
     * hy=脸中心占条高的位置(越大越靠下)，ff=脸高占条高的比例(越大角色越大)。
     * 这两个天然正交，掌机底条的两个滑块绑的就是它们。见 src/pet/main.tsx 的 ?hy=&ff=
     * 与 docs/superpowers/specs/2026-07-30-handheld-live2d-strip-design.md §1。 */
    framingHeadScreenY?: number; framingFaceScreenFrac?: number;
    /** loading 剪影占位图 URL：Live2D 就绪前先画它，那 2.5 秒空窗期不再是"按了没反应"。 */
    silhouetteUrl?: string;
    /** 原生 GL 目标帧率。不传会吃 Live2DScene 默认的 15（U1 Pro 时代的省电地板）。 */
    nativeTargetFps?: number;
    /** 底条模式（掌机）：浮窗被拉成满宽横条，pet 页要换成「角色靠左 + 右侧对话/功能区」的布局，
     * 而不是默认的角色铺满。见 src/pet/main.tsx 的 ?strip=1。 */
    stripMode?: boolean;
  /** 触摸穿透：窗口整个 FLAG_NOT_TOUCHABLE，触摸直达下层应用。掌机底条用——
   * 否则模拟器画面底部的快捷按钮被 720×240 的条吃掉点不到（Ben 实报）。 */
  touchThrough?: boolean;
  /** 允许 WebView 自己接收触摸。掌机 Figma 底条按钮/按住说话需要它；普通桌宠仍由原生 touchCatcher 接管。 */
  webTouchable?: boolean;
  /** 掌机底条 UI 版本。pet 页用它进入 Figma 控制条布局。 */
  stripUi?: 'figma-handheld';
  /** 底条高度（设备像素）：原生截屏用它当裁剪量，去掉底条上的角色自己。见 ScreenCapture.kt。 */
  stripHeightPx?: number;
  /** 军师服务端根地址（无末尾斜杠）。token 不走这里，走 ctx.token 的 Intent extra。 */
  strategistBaseUrl?: string;
  /** 当前 ROM，供底条 resolve 知识包。 */
  romFileName?: string;
  romPath?: string;
  /** Aiboo 后台根地址（语音走它）。token 不进这里，走 aibooToken 的 Intent extra。 */
  aibooBaseUrl?: string;
  /** Aiboo 后台设备 token —— 与军师 token 是**两个**，别再互相覆盖。 */
  aibooToken?: string;
};

/**
 * 把 ctx 折进 petQuery。
 * ★必须由 overlayStart 与 overlaySaveStripParams **共用**：两条路径的参数面一旦漂，
 * F10 回放出来的就是另一套构图（"只落盘不启动"那条漏参数是很隐蔽的 bug）。
 */
function buildCtxPetQuery(settings: PetSettings, bgUrl?: string, ctx?: OverlayStartCtx): string {
  const q = new URLSearchParams(buildPetQuery(settings, bgUrl));
  if (ctx?.rendererMode) q.set('renderer', ctx.rendererMode);
  if (ctx?.framingHeadSizeNorm != null) q.set('hs', String(ctx.framingHeadSizeNorm));
  if (ctx?.framingHeadAnchorY != null) q.set('ha', String(ctx.framingHeadAnchorY));
  if (ctx?.framingHeadScreenY != null) q.set('hy', String(ctx.framingHeadScreenY));
  if (ctx?.framingFaceScreenFrac != null) q.set('ff', String(ctx.framingFaceScreenFrac));
  if (ctx?.silhouetteUrl) q.set('sil', ctx.silhouetteUrl);
  if (ctx?.nativeTargetFps != null) q.set('fps', String(ctx.nativeTargetFps));
  if (ctx?.stripHeightPx != null) q.set('sh', String(ctx.stripHeightPx));
  if (ctx?.strategistBaseUrl) q.set('sv', ctx.strategistBaseUrl);
  if (ctx?.romFileName) q.set('rom', ctx.romFileName);
  if (ctx?.romPath) q.set('romp', ctx.romPath);
  if (ctx?.aibooBaseUrl) q.set('ab', ctx.aibooBaseUrl);
  if (ctx?.stripUi) q.set('stripUi', ctx.stripUi);
  if (ctx?.stripMode) q.set('strip', '1');
  return q.toString();
}

function buildOverlayPluginRequest(
  avatarId: string,
  settings: PetSettings,
  bgUrl?: string,
  ctx?: OverlayStartCtx,
): OverlayPluginRequest {
  return {
    avatarId,
    widthDp: settings.widthDp,
    aspect: settings.aspect,
    petQuery: buildCtxPetQuery(settings, bgUrl, ctx),
    // 两类 token 只走 Intent extra，不进会被 loadUrl/logcat 记录的 petQuery。
    token: ctx?.token,
    aibooToken: ctx?.aibooToken,
    fixed: ctx?.fixed,
    xPx: ctx?.xPx,
    yPx: ctx?.yPx,
    widthPx: ctx?.widthPx,
    heightPx: ctx?.heightPx,
    touchThrough: ctx?.touchThrough,
    webTouchable: ctx?.webTouchable,
  };
}

export async function overlayStart(
  avatarId: string,
  settings: PetSettings,
  bgUrl?: string,
  ctx?: OverlayStartCtx,
): Promise<void> {
  await plugin?.start(buildOverlayPluginRequest(avatarId, settings, bgUrl, ctx));
}

/** 参数面与 start/saveStripParams 相同，唯一差别是调原生隐藏预热。 */
export async function overlayPrewarm(
  avatarId: string,
  settings: PetSettings,
  bgUrl?: string,
  ctx?: OverlayStartCtx,
): Promise<void> {
  await plugin?.prewarm(buildOverlayPluginRequest(avatarId, settings, bgUrl, ctx));
}

export async function overlayStop(): Promise<void> {
  await plugin?.stop();
}

/** 同 overlayStart 的参数面，但只落盘不启动——底条改由实体侧键（F10）呼出后，
 * JS 不再自动 start；不同步这份参数，按键侧将永远无的放矢。 */
export async function overlaySaveStripParams(
  avatarId: string,
  settings: PetSettings,
  bgUrl?: string,
  ctx?: OverlayStartCtx,
): Promise<void> {
  await plugin?.saveStripParams(buildOverlayPluginRequest(avatarId, settings, bgUrl, ctx));
}

/** 等浮窗 Live2D 首帧真就绪（原生 window.AibooOverlayReady.ready() 桥→'ready' 事件），
 * 超时兜底（原生缺失/事件丢失时不卡死 UI，见 radioOverlay.ts 的 loading 门）。
 * 每次调用都对称移除监听，避免反复进出主界面累积泄漏。 */
export async function overlayWaitReady(timeoutMs: number): Promise<void> {
  if (!plugin) return;
  let handle: { remove: () => Promise<void> } | null = null;
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => { if (done) return; done = true; resolve(); };
    const timer = window.setTimeout(finish, timeoutMs);
    plugin.addListener('ready', () => {
      window.clearTimeout(timer);
      finish();
    }).then((h) => { handle = h; if (done) void h.remove(); }).catch(() => finish());
  });
  if (handle) void (handle as { remove: () => Promise<void> }).remove();
}

/** 实时改浮窗尺寸/比例（原生 updateViewLayout，不重启）。 */
export async function overlaySetDimensions(widthDp: number, aspect: string): Promise<void> {
  await plugin?.setDimensions({ widthDp, aspect });
}

/**
 * 底条取景热更新：不重启服务，把新取景直接推给已在跑的浮窗（约 1 帧生效）。
 * 服务没在跑时原生侧静默 no-op。桌面设置页拖滑块用——重启那条路要重载模型（约 2.5 秒）。
 */
export async function overlayUpdateFraming(headScreenY: number, faceScreenFrac: number): Promise<void> {
  await plugin?.updateFraming({ headScreenY, faceScreenFrac });
}
