/**
 * 全息屏角色构图：默认值 + URL 参数覆盖。屏幕不可点、拖不动，只有真机上才看得准，
 * 所以 scale/竖向现场可调不用重打包——holo.html?scale=0.8&head=0.25。
 *
 * ★两个旋钮独立、有界、互不干扰（都喂给头部锚点自适应 SURFACE_FRAMING.holo）★：
 *  - scale：大小。乘在基准脸占屏比上（scale=1→基准，0.55→更小）。旧 oy 已弃(增益过大+和scale打架)。
 *  - head：竖向。头在屏幕竖向的位置(0靠顶 / 1靠底)。换 scale 不会移动头，换 head 不会改大小。
 * 纯函数、可测；App 用 setHoloFraming 下发。调好后把最终值焊进 SURFACE_FRAMING.holo。
 */

// 基准脸占屏比（scale=1 时）。与 live2dEngine SURFACE_FRAMING.holo.faceScreenFrac 对齐。
export const HOLO_BASE_FACE = 0.11;
export const HOLO_DEFAULT_HEAD = 0.20;
export const HOLO_DEFAULT_NATIVE_TARGET_FPS = 60;

export interface HoloFraming {
  /** 脸占屏比（大小）。 */
  faceScreenFrac: number;
  /** 头竖向位置（0靠顶/1靠底）。 */
  headScreenY: number;
}

// URL 参数名 + 合法闭区间。越界/非数值 → 回落默认。
const SCALE = { param: 'scale', min: 0.2, max: 3 };
const HEAD = { param: 'head', min: 0.02, max: 0.6 };
const FPS = { param: 'fps', min: 5, max: 60 };

function num(params: URLSearchParams, spec: { param: string; min: number; max: number }, fallback: number): number {
  const raw = params.get(spec.param);
  if (raw == null) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < spec.min || n > spec.max) return fallback;
  return n;
}

/** 从 location.search（含或不含前导 '?'）解析 holo 构图，未给/非法的字段回落默认。 */
export function resolveHoloFraming(search: string): HoloFraming {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const scale = num(params, SCALE, 1);
  const headScreenY = num(params, HEAD, HOLO_DEFAULT_HEAD);
  return { faceScreenFrac: HOLO_BASE_FACE * scale, headScreenY };
}

/**
 * 角色覆盖：`holo.html?avatar=<id>` 强制指定角色，优先于「上次所在角色」的本地记忆。
 * 用途是让同一个 holo 页按宿主选模型——例如 X08A 展示台走
 * `?avatar=shuangsheng-p20` 的完整模型低频物理变体，普通 holo 保持自身入口配置。
 * 只做取值与去空白，id 合法性由调用方用 getAvatarById 校验。
 */
export function resolveHoloAvatarId(search: string): string | null {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const raw = params.get('avatar');
  const id = raw?.trim();
  return id ? id : null;
}

/**
 * 全息屏开哪个形象:`?avatar=` 指名且这台机器上有 → 它;否则上次那个(还在的话);否则列表第一个;
 * 一个都没有(仓库不带模型,2026-10-21)→ null,舞台画粒子球。
 */
export function pickHoloAvatarId(input: {
  forced: string | null;
  last: string | null;
  known: (id: string) => boolean;
  first: string | undefined;
}): string | null {
  if (input.forced !== null && input.known(input.forced)) return input.forced;
  if (input.last !== null && input.known(input.last)) return input.last;
  return input.first ?? null;
}

/**
 * 原生舞台帧率上限：普通 holo 保留 60 的历史上限；低端展示台由入口显式传 `fps=24`。
 * 非数值或越界值回落默认，避免错误 URL 把舞台锁到不可用帧率。
 */
export function resolveHoloNativeTargetFps(search: string): number {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  return num(params, FPS, HOLO_DEFAULT_NATIVE_TARGET_FPS);
}
