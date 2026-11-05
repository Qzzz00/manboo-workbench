// 掌机桌面的可调设置：选中角色 + 每只角色各自的底条取景。
//
// ★为什么设置存在桌面这边而不是浮窗里：浮窗页跑在 pet.localhost，与桌面**不同源**，
// 两边 localStorage 不通。既有做法就是「桌面存、开浮窗时经 URL 参数下发」
// （见 overlayPlugin.buildPetQuery），这里沿用同一条路。
//
// ★v2 换了语义：滑块从「模型固有度量(headSizeNorm/headAnchorY)」改绑
// 「屏幕空间取景目标(headScreenY/faceScreenFrac)」。前者用作旋钮时，位置灵敏度会被
// 大小缩放（位移 = Δha × modelPixelHeight ∝ 1/headSizeNorm）= Ben 报的「改大小位置就跑」。
// 详见 docs/superpowers/specs/2026-07-30-handheld-live2d-strip-design.md §1。

import {
  DEFAULT_HANDHELD_AVATAR_ID,
  DEFAULT_STRIP_FRAMING,
  handheldAvatarFor,
  isValidHandheldAvatarId,
  type StripFraming,
} from './handheldAvatars.ts';

const KEY = 'aiboo:handheld-settings';

export type HandheldSettings = {
  /** 当前选中的角色（主页大角色与底条小角色同步换）。 */
  avatarId: string;
  /** 每只角色各自调过的底条取景。没调过的角色不出现在这里，读时回落注册表默认。 */
  stripFraming: Record<string, StripFraming>;
};

/**
 * 滑块区间（屏幕空间，物理意义固定）。
 * headScreenY：脸中心在条高的位置。条高 240 设备像素 → 一格 0.005 = 1.2px。
 *   给到 [-0.1, 1.1] 是让脸中心能推到条外一点（大身形角色要这个余量）。
 * faceScreenFrac：脸高占条高的比例。0.31 是当前默认，两端留足。
 */
export const HEAD_SCREEN_Y_RANGE = { min: -0.1, max: 1.1, step: 0.005 };
export const FACE_SCREEN_FRAC_RANGE = { min: 0.1, max: 0.9, step: 0.005 };

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

export function defaultHandheldSettings(): HandheldSettings {
  return { avatarId: DEFAULT_HANDHELD_AVATAR_ID, stripFraming: {} };
}

/** 夹一组取景到合法区间。两个数任一非法 → 返回 null（整条丢弃，别拿 NaN 当 0）。 */
function normalizeFraming(raw: unknown): StripFraming | null {
  const f = raw as Partial<StripFraming> | null | undefined;
  const y = Number(f?.headScreenY);
  const s = Number(f?.faceScreenFrac);
  if (!Number.isFinite(y) || !Number.isFinite(s)) return null;
  return {
    headScreenY: clamp(y, HEAD_SCREEN_Y_RANGE.min, HEAD_SCREEN_Y_RANGE.max),
    faceScreenFrac: clamp(s, FACE_SCREEN_FRAC_RANGE.min, FACE_SCREEN_FRAC_RANGE.max),
  };
}

/**
 * 把任意输入归一成合法设置。存取两侧都过这一关。
 * ★v1 结构 {stripHeadSizeNorm, stripHeadAnchorY} 没有对应字段，会自然落到默认——
 * 这是有意的：两版语义不同，换算过去毫无意义，而新默认与改造前成像等价。
 */
export function normalizeSettings(raw: Partial<HandheldSettings> | null | undefined): HandheldSettings {
  const avatarId = isValidHandheldAvatarId(raw?.avatarId)
    ? (raw?.avatarId as string)
    : DEFAULT_HANDHELD_AVATAR_ID;

  const stripFraming: Record<string, StripFraming> = {};
  const src = raw?.stripFraming;
  if (src && typeof src === 'object') {
    for (const [id, value] of Object.entries(src)) {
      // 剔掉下架/手改进来的角色 id，别把无效值永久留在存档里
      if (!isValidHandheldAvatarId(id)) continue;
      const f = normalizeFraming(value);
      if (f) stripFraming[id] = f;
    }
  }
  return { avatarId, stripFraming };
}

export function loadHandheldSettings(): HandheldSettings {
  try {
    const raw = localStorage.getItem(KEY);
    return normalizeSettings(raw ? (JSON.parse(raw) as Partial<HandheldSettings>) : null);
  } catch {
    // 存储不可用 / JSON 坏了：回默认，桌面绝不能因为读设置失败而起不来
    return defaultHandheldSettings();
  }
}

export function saveHandheldSettings(next: HandheldSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(normalizeSettings(next)));
  } catch {
    /* 存不进去就算了，本次会话内的值仍然生效 */
  }
}

/** 取某只角色的底条取景：调过的 > 注册表默认。 */
export function stripFramingFor(s: HandheldSettings, avatarId: string): StripFraming {
  return s.stripFraming[avatarId] ?? handheldAvatarFor(avatarId).stripFraming ?? DEFAULT_STRIP_FRAMING;
}

/** 写入某只角色的底条取景（不可变，返回新对象）。越界值在这里就夹住。 */
export function withStripFraming(
  s: HandheldSettings,
  avatarId: string,
  framing: StripFraming,
): HandheldSettings {
  const f = normalizeFraming(framing);
  if (!f) return s;
  return { ...s, stripFraming: { ...s.stripFraming, [avatarId]: f } };
}
