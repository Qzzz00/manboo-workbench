// 设备性能分级：区分「低端/老/小屏」设备，用于 Live2D **画质**降配（小纹理、关抗锯齿、降分辨率），
// 避免在弱 GPU + 小内存机器上因显存爆掉而卡顿/换页。判定结果缓存（设备能力不会中途变化）。
//
// 只管画质，不再决定渲染器——Android 一律走原生，见下方 shouldUseNativeLive2D。
// 已知它作为性能判据偏保守：RG Rotate 因 deviceMemory 上报 2 被判低端，实测却能稳跑 60fps。
// 用于选纹理尺寸尚可（它同时也是小屏机，2048 足够），但不要拿它推断「这台机器慢」。
//
// 判据（任一命中即视为低端）：
//   - navigator.deviceMemory ≤ 2GB（Chrome 63+ 才有；老 WebView 无此 API 时跳过）
//   - 屏幕物理短边 ≤ 540px（如 480×800 的 4 寸机）
//   - WebView 内核过老（Chrome 主版本 < 80）——强关联老/弱设备，且这类内核往往被 GPU 黑名单等困扰

let cached: boolean | undefined;

function chromeMajorVersion(): number | null {
  const m = /Chrom(?:e|ium)\/(\d+)/.exec(navigator.userAgent || '');
  return m ? parseInt(m[1], 10) : null;
}

export function isLowEndDevice(): boolean {
  if (cached !== undefined) return cached;
  let lowEnd = false;
  try {
    const dm = (navigator as unknown as { deviceMemory?: number }).deviceMemory;
    if (typeof dm === 'number' && dm > 0 && dm <= 2) lowEnd = true;

    const dpr = window.devicePixelRatio || 1;
    const shortSidePx = Math.min(window.screen.width, window.screen.height) * dpr;
    if (shortSidePx > 0 && shortSidePx <= 540) lowEnd = true;

    const cv = chromeMajorVersion();
    if (cv !== null && cv < 80) lowEnd = true;
  } catch {
    /* 探测失败：保守起见按非低端处理，不误伤主流设备 */
  }
  cached = lowEnd;
  return cached;
}

// 低端设备把 Live2D 模型纹理目录从 .4096 降到 .2048（4× 显存，防 OOM/换页），构建期已生成变体。
// 默认用 2048：480px 小屏上角色显示区约 400-600px，这档足够清晰又不糊；
// 1GB X08A 展示台可通过入口 texture=1024 显式降一档，不误伤其他低端设备。
export function resolveTexturePath(
  path: string,
  lowEnd: boolean,
  requestedSize: string | null,
): string {
  if (requestedSize === '1024') {
    return path.replace(/\.4096\//g, '.1024/');
  }
  if (!lowEnd) return path;
  return path.replace(/\.4096\//g, '.2048/');
}

export function downscaleTexturePath(path: string): string {
  let requestedSize: string | null = null;
  try {
    requestedSize = new URLSearchParams(window.location.search).get('texture');
  } catch {
    /* 非浏览器上下文没有 URL 参数，继续使用设备默认档 */
  }
  return resolveTexturePath(path, isLowEndDevice(), requestedSize);
}

// ---- 渲染后端选择（WebView PixiJS vs 原生 Cubism GLSurfaceView）----
//
// 背景：U1 Pro 级设备上 WebView 单帧 JS ~125ms（7-8fps），锁帧/降纹理/关物理全部无效；
// 原生 Cubism 实测 75-90ms/帧稳 13fps，最初以此作为「低端机专用」路径引入。
//
// 现状（2026-07-29 起）：Android 三宿主（主 App / 屏保 / 浮窗）一律走原生，不再按机型分流。
// 原因：分流意味着同一套构图/参数数学要在 PixiJS 与 Cubism 两处各维护一份；且原生路径实测
// 在中低端机上就有巨大余量（RG Rotate 单帧仅 13ms，可稳跑 60fps），没有理由只给弱机用。
// Web(GitHub Pages) 与 holo(Windows exe) 没有原生插件，pluginAvailable=false 自然回落 PixiJS，
// 故 Live2DStage 的 Pixi 分支不可删除。
//
// 注意：画质分档（贴图 2048/4096 等）与渲染器选择已解耦——见 isLowEndDevice/downscaleTexturePath，
// 它们此后只影响画质，不再决定用哪个渲染器。

export type Live2DRendererPref = 'auto' | 'native' | 'webview';

const RENDERER_PREF_KEY = 'aiboo:live2d-renderer';

export function getLive2DRendererPref(): Live2DRendererPref {
  try {
    const v = localStorage.getItem(RENDERER_PREF_KEY);
    if (v === 'native' || v === 'webview') return v;
  } catch { /* storage 不可用按 auto */ }
  return 'auto';
}

export function setLive2DRendererPref(pref: Live2DRendererPref): void {
  try {
    if (pref === 'auto') localStorage.removeItem(RENDERER_PREF_KEY);
    else localStorage.setItem(RENDERER_PREF_KEY, pref);
  } catch { /* ignore */ }
}

/**
 * 是否走原生 Live2D 渲染层。插件可用性由调用方传入（避免本模块依赖 @capacitor/core，
 * 保持 deviceTier 纯函数可测）。
 */
export function shouldUseNativeLive2D(pluginAvailable: boolean): boolean {
  if (!pluginAvailable) return false;
  const pref = getLive2DRendererPref();
  if (pref === 'webview') return false;
  if (pref === 'native') return true;
  // auto：插件随包即用原生。pluginAvailable 已把 Web/holo 挡在外面，故这里等价于「Android 恒原生」。
  return true;
}
