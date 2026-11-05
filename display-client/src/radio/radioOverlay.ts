// U3 电台桌面「live2d 小浮窗（固定）」启动器：复用桌宠浮窗（Overlay 原生服务），
// 但传 fixed=true 禁拖动（Ben 要求：用之前浮窗代码，只是不支持挪位置）。
// 自动管理：进入主界面 → 显示；离开主界面 → 隐藏（RadioApp 按 page 状态驱动，见 ensureFixedOverlayShown/Hidden）。
// 无原生/无 SAW 授权时安全降级：进入主界面时若未授权 → 拉起 SAW 授权页（用户授权后下次进入才会显示）。
import {
  overlayAvailable, overlayHasPermission, overlayRequestPermission,
  overlayIsRunning, overlayStart, overlayStop, overlayWaitReady,
} from '../lib/overlayPlugin.ts';
import type { PetSettings } from '../lib/petSettingsStore.ts';

// 双生 DJ 角色（与电台主页同一模型），pet.html 按 avatarId 从 avatarData 解析。
const OVERLAY_AVATAR = 'shuangsheng-dj';

// 主界面「live2d 小浮窗（固定）」贴纸格子的设计坐标（radio.css .radio-tile-live2d：
// left:244 top:50 width:228 height:228，480×640 设计画布）。U3 真机物理分辨率同为 480×640，
// 故设计坐标可直接当屏幕原始像素传给原生（见 OverlayWindow 的 fixedXPx/fixedYPx/fixedWidthPx/fixedHeightPx）。
// 只在这台机器上生效；换机型需重新核对物理分辨率是否仍等于设计画布。
const TILE_X_PX = 244;
const TILE_Y_PX = 50;
const TILE_SIZE_PX = 228;

// 头部取景（胸部以上，耳朵不超浮窗顶部）：角色默认「上半身特写」构图偏松，真机拖调收紧。
// hs(headSizeNorm) 越小角色越大；ha(headAnchorY) 越大角色越往上移、越小越往下移
// （精确推导见 computeAutoFit：desiredModelY = headScreenY*rawHeight + modelPixelHeight*(1-ha)，
// ha 增大 → (1-ha) 变小 → modelY 变小 → 模型整体上移；与 DJ 页 transform.offsetY 的方向相反，别搞混）。
// Ben 反馈「偏小/偏靠上」，故比第一版更小的 hs（更大）+ 更小的 ha（更往下）。
const FRAMING_HEAD_SIZE_NORM = 0.105;
const FRAMING_HEAD_ANCHOR_Y = 0.24;

// 浮窗启动到「Live2D 首帧真渲染出来」的等待上限：超时仍收 loading（原生事件桥失效兜底），
// 避免 Ben 反馈的「进主界面浮窗还没加载好就先显示了」——不再靠 overlayStart() resolve 就收 loading，
// 那只代表 startForegroundService 调用已派发，WebView 还没画出角色。
const READY_TIMEOUT_MS = 6000;

// 固定浮窗设置：与用户在主 App 里为桌宠浮窗调的 PetSettings（widthDp/aspect/bg 等）无关——
// 这里几何固定用像素覆盖（见下方 xPx/widthPx），背景固定透明（Ben 要求），不读/不受 localStorage 影响。
const FIXED_OVERLAY_SETTINGS: PetSettings = { bg: false, chibi: false, gyro: false, widthDp: TILE_SIZE_PX, aspect: '1:1' };

/** 进入主界面：若未运行则起浮窗并等 Live2D 真就绪（无 SAW 授权则拉起授权页，静默降级）。全程不抛。 */
export async function ensureFixedOverlayShown(): Promise<void> {
  if (!overlayAvailable()) return;
  try {
    if (await overlayIsRunning()) return;
    if (!(await overlayHasPermission())) {
      await overlayRequestPermission();
      return;
    }
    await overlayStart(OVERLAY_AVATAR, FIXED_OVERLAY_SETTINGS, undefined, {
      fixed: true,
      xPx: TILE_X_PX,
      yPx: TILE_Y_PX,
      widthPx: TILE_SIZE_PX,
      heightPx: TILE_SIZE_PX,
      // 浮窗切原生 SDK 渲染（提帧率 + 保物理，与 DJ 页一致）；透明悬浮由 pet 页 transparentClear
      // → clearColor=#00000000 实现（原生 GL 空白处露桌面）。Ben 第五轮要求「浮窗改 SDK」。
      rendererMode: 'native',
      framingHeadSizeNorm: FRAMING_HEAD_SIZE_NORM,
      framingHeadAnchorY: FRAMING_HEAD_ANCHOR_Y,
    });
    await overlayWaitReady(READY_TIMEOUT_MS);
  } catch {
    /* 原生缺失/授权取消等一律不打断桌面 */
  }
}

/** 离开主界面：若运行中则停浮窗。全程不抛。 */
export async function ensureFixedOverlayHidden(): Promise<void> {
  if (!overlayAvailable()) return;
  try {
    if (await overlayIsRunning()) await overlayStop();
  } catch {
    /* 忽略 */
  }
}
