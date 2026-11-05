// 低端机原生 Live2D 渲染层的 Capacitor 桥（Java 侧 NativeLive2DPlugin）。
// 这里只做类型与注册；状态编排（拍平/分层/节流/构图）在 features/live2d/nativeStage.ts。
import { Capacitor, registerPlugin } from '@capacitor/core';

/** 构图分数（相对 WebView 视口）：锚点=模型画布盒底边中心。 */
export type NativeLive2DLayout = {
  anchorXFrac: number;
  bottomYFrac: number;
  widthFrac: number;
  heightFrac: number;
};

export type NativeLive2DParamInfo = { id: string; min: number; max: number; def: number };

export type NativeLive2DShowModelResult = {
  canvasWidthPx: number;
  canvasHeightPx: number;
  params: NativeLive2DParamInfo[];
};

export interface NativeLive2DPluginApi {
  ping(): Promise<{ ok: boolean; coreLoaded: boolean; layerActive: boolean }>;
  showModel(options: {
    /** 增强版 model3.json 文本（createAugmentedSettings 产物，纹理已按设备降档、动作已注入命名组） */
    settingsJson: string;
    /** assets 相对目录，如 'public/live2D/shuangsheng-dj/' */
    modelDir: string;
    /** 可选：逐纹理覆盖（assets 绝对路径）。缺省用 settingsJson 里的相对路径 */
    textures?: string[];
    idleMotionGroup?: string | null;
    idleBeatGroups?: string[];
    persistentParams?: Record<string, number>;
    targetFps?: number;
    /** Positive handheld request/presentation ID. Omit for ordinary non-handheld hosts. */
    lifecycleTraceId?: number;
    layout?: NativeLive2DLayout;
    backgroundColor?: string;
  }): Promise<NativeLive2DShowModelResult>;
  releaseModel(): Promise<void>;
  hide(): Promise<void>;
  /** Resolves only after the resumed native host has drawn a new complete background + model frame. */
  show(options?: { lifecycleTraceId?: number }): Promise<void>;
  setOverlayTargets(options: { params: Record<string, number> }): Promise<void>;
  setPersistentParams(options: { params: Record<string, number> }): Promise<void>;
  setMouthParams(options: { params: Record<string, number> }): Promise<void>;
  playMotion(options: { group: string }): Promise<void>;
  setFocus(options: { x: number; y: number }): Promise<void>;
  /** 陀螺仪背景视差：归一化偏移（[-1,1]，y 上正）。背景画在 GL 层时替代 CSS transform 视差。 */
  setBackgroundParallax(options: { x: number; y: number }): Promise<void>;
  setLayout(options: NativeLive2DLayout): Promise<void>;
  setBackground(options: {
    color?: string;
    assetPath?: string;
    dataUrl?: string;
    clearImage?: boolean;
  }): Promise<void>;
}

export const NativeLive2D = registerPlugin<NativeLive2DPluginApi>('NativeLive2D');

/** 插件是否随包（只代表原生侧注册了；.so 可用性由 ping().coreLoaded 判断）。 */
export function isNativeLive2DPluginAvailable(): boolean {
  try {
    return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('NativeLive2D');
  } catch {
    return false;
  }
}
