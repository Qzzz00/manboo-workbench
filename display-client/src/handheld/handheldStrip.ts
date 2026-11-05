// 掌机底条：把桌宠浮窗从「小方块」拉成「满宽底边横条」。
//
// Ben 的形态：游戏画面顶到屏幕上方，底部黑边整条交给 Aiboo——左下角角色，
// 右边留给对话与功能按钮。**这是全局的**（玩游戏时、在别的 App 里都在），
// 只有 Aiboo 自己在前台时收起。
//
// 不需要改原生：OverlayPlugin 早就支持 fixed + xPx/yPx/widthPx/heightPx 固定几何
// （U3 电台桌面的贴纸格子浮窗在用），底条只是换一组数。

import {
  overlayStart,
  overlayStop,
  overlayHasPermission,
  overlayPrewarm,
  overlaySaveStripParams,
} from '../lib/overlayPlugin.ts';
import type { PetSettings } from '../lib/petSettingsStore.ts';
import { loadHandheldSettings, stripFramingFor, type HandheldSettings } from './handheldSettingsStore.ts';
import { handheldAvatarFor } from './handheldAvatars.ts';
import { loadStrategistConfig } from '../lib/strategist/strategistConfig.ts';
import { loadLastLaunched } from './handheldLaunchStore.ts';

/**
 * 底条高度（设备像素）。
 * 240 = 720 方屏减去 720×480 的游戏画面——Ben 的 RetroArch 早就配成
 * `custom_viewport 720×480 @ y=0`，这条黑边本来就是他为这个留的。
 */
export const STRIP_HEIGHT_PX = 240;

export type StripGeometry = { xPx: number; yPx: number; widthPx: number; heightPx: number };

/**
 * 算底条几何（纯函数，可测）。
 * 浮窗的 gravity 是 TOP|START，所以 y 要用「屏高 - 条高」自己算出来。
 * 条高超过屏高时钳到满屏，别产生负 y（那会把窗口顶到屏幕外）。
 */
export function computeStripGeometry(
  screen: { widthPx: number; heightPx: number },
  stripHeightPx: number = STRIP_HEIGHT_PX,
): StripGeometry {
  const h = Math.max(0, Math.min(stripHeightPx, screen.heightPx));
  return { xPx: 0, yPx: screen.heightPx - h, widthPx: screen.widthPx, heightPx: h };
}

/** 当前屏幕的设备像素尺寸。掌机 CSS 视口 480×480 × dpr 1.5 = 720×720。 */
export function currentScreenPx(): { widthPx: number; heightPx: number } {
  const dpr = window.devicePixelRatio || 1;
  return {
    widthPx: Math.round(window.screen.width * dpr),
    heightPx: Math.round(window.screen.height * dpr),
  };
}

/**
 * 底条里角色的取景。
 *
 * 角色只占左侧一个 240×240 的正方形，用角色自带的默认取景（那是给全身/主页画幅定的）
 * 会把头顶到条外——真机实测就是「只看得见下巴以下」。
 *
 * ★现在两个旋钮是**屏幕空间**的取景目标（headScreenY / faceScreenFrac），天然正交、
 * 每格物理意义固定（headScreenY 一格 0.005 = 240px 条上 1.2px）。
 * 默认值与区间见 handheldAvatars.ts / handheldSettingsStore.ts。
 *
 * ★历史坑，别改回去：
 *  ① v1 曾把滑块绑在 headSizeNorm/headAnchorY（**模型固有度量**）上。位移量
 *     = Δha × modelPixelHeight，而 modelPixelHeight ∝ 1/headSizeNorm → 位置灵敏度被
 *     大小缩放，这就是 Ben 报的「改大小位置就跑」（回归测试在 modelLayout.test.ts）。
 *  ② 另有两条已修的「滑块全程无反应」死因：SURFACE_FRAMING.petStrip 的 topClampMin=-3
 *     （240px 条里必须放开顶部钳制）+ nativeStage 对它的转发。两者缺一即复发。
 */

/** 底条用的桌宠设置：不要背景（要透出游戏画面）、不要 Q 版、不要陀螺仪（省电）。 */
const STRIP_PET_SETTINGS: PetSettings = {
  bg: false,
  chibi: false,
  gyro: false,
  widthDp: 260,
  aspect: '3:4',
};

/**
 * 底条原生 GL 目标帧率。★必须显式传：Live2DScene 默认 15，那是当年为 U1 Pro
 * （0.99GHz 单核）定的省电地板。底条这条路径以前从没传过，真机 logcat 实测吃的就是
 * target=15，而主页早就传 60 了。
 */
export const STRIP_NATIVE_TARGET_FPS = 60;

/**
 * 组装底条参数（纯函数，可测）。
 * **JS 是底条参数的唯一真相源**，按键侧（StripIntentStore → F10 回放）只回放不自己拼。
 */
/** 军师需要的上下文：服务端地址 + 当前 ROM。ROM 为空 = 没从桌面开过游戏，只能兜底问答。 */
export type StrategistStripCtx = {
  baseUrl: string;
  /** Aiboo 后台（语音走它，公网可达）。 */
  aibooBaseUrl?: string;
  rom?: { fileName: string; path: string };
};

export function stripCtxFor(
  avatarId: string,
  settings: HandheldSettings,
  screen: { widthPx: number; heightPx: number },
  strategist?: StrategistStripCtx,
) {
  const geo = computeStripGeometry(screen);
  const opt = handheldAvatarFor(avatarId);
  const framing = stripFramingFor(settings, opt.id);
  return {
    fixed: true,
    ...geo,
    // 底条走原生 GL：透明清屏让游戏画面透出来，且提帧率保物理。
    rendererMode: 'native' as const,
    // strip=1 让 pet 页切成横条布局（角色靠左、右边留给对话/按钮）。
    stripMode: true,
    // Figma 版底条：整条底边就是 Aiboo 的控制面板，按钮必须进入 WebView。
    // webTouchable=true 让原生不再盖 touchCatcher；touchThrough=false 让 DOM 按钮拿得到触摸。
    stripUi: 'figma-handheld' as const,
    touchThrough: false,
    webTouchable: true,
    // ★头部度量覆盖：只在 avatarData 缺真值时下发（目前只有双生）。
    // 这**不是**取景旋钮——它描述模型本身，当旋钮用会让位置灵敏度被大小缩放。
    framingHeadSizeNorm: opt.stripFramingHead?.headSizeNorm,
    framingHeadAnchorY: opt.stripFramingHead?.headAnchorY,
    // 取景目标（屏幕空间、天然正交）：设置页两个滑块调的就是这两个。
    framingHeadScreenY: framing.headScreenY,
    framingFaceScreenFrac: framing.faceScreenFrac,
    // loading 剪影占位（Live2D 就绪前顶上那 2.5 秒）。
    silhouetteUrl: opt.silhouette,
    nativeTargetFps: STRIP_NATIVE_TARGET_FPS,
    // ★底条高度下发给原生截屏当裁剪量：底条几何的唯一真相源在这里，原生不自己猜，
    // 免得两边各持一份常数迟早漂（见 ScreenCapture.kt 的注释）。
    stripHeightPx: geo.heightPx,
    strategistBaseUrl: strategist?.baseUrl,
    aibooBaseUrl: strategist?.aibooBaseUrl,
    romFileName: strategist?.rom?.fileName,
    romPath: strategist?.rom?.path,
  };
}

function stripCtx(avatarId: string, cfg: ReturnType<typeof loadStrategistConfig>) {
  const last = loadLastLaunched();
  return stripCtxFor(avatarId, loadHandheldSettings(), currentScreenPx(), {
    baseUrl: cfg.baseUrl,
    aibooBaseUrl: cfg.aibooBaseUrl,
    // 上次从桌面开的那款游戏就是「现在在玩的」——按 HOME 回桌面再按 F10 出底条时，
    // 前台跑的必然是它。文件名从路径尾巴取（launchStore 只存了路径）。
    rom: last
      ? { fileName: last.romPath.split('/').pop() ?? last.romPath, path: last.romPath }
      : undefined,
  });
}

/** start/save/prewarm 的唯一参数入口，避免 F10 回放出另一套构图或认证上下文。 */
function buildStripOverlayRequest(avatarId: string) {
  const cfg = loadStrategistConfig();
  return {
    avatarId,
    settings: STRIP_PET_SETTINGS,
    ctx: {
      ...stripCtx(avatarId, cfg),
      // 军师问答与 Aiboo 语音是两个 token，都只走 Intent extra。
      token: cfg.deviceToken,
      aibooToken: cfg.aibooDeviceToken,
    },
  };
}

/**
 * 起底条。没有悬浮窗权限时静默不起——桌面不该因为这个弹东西打断玩游戏
 * （设置页的实时预览也走这条，所以没授权时预览没有、滑块照常能调能存）。
 * fixed=true 禁拖动（底条就该钉死），且原生侧不会把主 App 收到后台
 * （收后台是拖动桌宠的语义，底条不需要）。
 */
export async function startBottomStrip(avatarId: string): Promise<void> {
  const request = buildStripOverlayRequest(avatarId);
  if (!(await overlayHasPermission())) return;
  await overlayStart(request.avatarId, request.settings, undefined, request.ctx);
}

/** 隐藏启动底条，让原生在首个完整帧后驻留资源。 */
export async function prewarmBottomStrip(avatarId: string): Promise<void> {
  const request = buildStripOverlayRequest(avatarId);
  await overlayPrewarm(request.avatarId, request.settings, undefined, request.ctx);
}

/**
 * 把底条参数同步给原生（StripIntentStore），供实体侧键 F10 全局回放。
 * 桌面启动与设置变更时各调一次——底条已改成按键呼出，JS 不再自动 start，
 * 不落这份参数按键就无的放矢。
 */
export async function syncStripParams(avatarId: string): Promise<void> {
  const request = buildStripOverlayRequest(avatarId);
  await overlaySaveStripParams(request.avatarId, request.settings, undefined, request.ctx);
}

export async function stopBottomStrip(): Promise<void> {
  await overlayStop();
}
