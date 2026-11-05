/**
 * 展示台左栏 Live2D 形象的取景(2026-09-30 / 10-01)。
 *
 * 维护者 09-30:「在左侧的位置保持居中,有背景的最好不要露出背景的边缘来,就是铺满,但是角色的显示上,主体要完整」。
 * 10-01 看了第一版效果图纠正:「大部分都不太行,底部都是黑的,没有覆盖满;几个没有背景的,应该是小腿下半截
 * 在屏幕之外的……下面的八月十二是盖在上面的」。
 *
 * 所以规则是(第一版那套「角色整个装进黄历上方、铺不满就渐隐收边」作废):
 *   · **有背景的铺满**整个左栏,黄历直接压在画面上(外面垫一层渐暗);优先级:
 *     头顶在画面里 > 底部铺满 > 左右铺满 > 顶边铺满(场景上半截不规则、四边全铺就得切头的那几个,让出顶边 / 左右上角);
 *   · 角色**头顶在画面里、左右居中**,放大到小腿下半截({@link LEG_CROP})出屏;
 *     不迁就宽度(坐姿 / 带尾巴的两侧出屏,10-01);有背景时「铺满」压过这一条,宁可放大;
 *   · 每个形象可以带 `zoom`(再放大一档)与 `nudge`(手动挪),给规则摆不好的个别形象;
 *   · 没背景的纯角色同样放大到小腿出屏。
 *
 * 每个形象带两个框(按模型包围盒归一化到 0..1):`subject` 角色本体、
 * `backdrop` 场景里完全不透明的最大矩形(纯角色为 null)。纯函数,用例钉住。
 */

export interface Box { x0: number; y0: number; x1: number; y1: number }

export interface FrameInput {
  /** 左栏(画框)像素尺寸。 */
  view: { w: number; h: number };
  /** 模型包围盒在缩放 1 时的像素尺寸。 */
  model: { w: number; h: number };
  subject: Box;
  backdrop: Box | null;
  /**
   * 主体框下面还有多少可以出屏(占主体框高的比例),缺省 {@link LEG_CROP}。
   * 坐姿那几个把主体框只框到大腿、这里给 0:框的下沿贴住画面底,垂下的腿出屏(10-01 第四轮,8 九尾狐、15 三花猫)。
   */
  legCrop?: number;
  /** 在规则算出的倍数上再放大多少(1 = 不放大)。头顶仍在画面里。 */
  zoom?: number;
  /** 手动微调,按画框比例:x 向右、y 向下(10-01,61 和服长椅「整体要朝右朝下」)。底部铺满照旧保住。 */
  nudge?: { x: number; y: number };
  /**
   * `'bust'`:竖屏首页那一格(又宽又矮)只留上半身 —— 头顶留白、画面底边落在主体 {@link BUST_SHOW} 处;
   * 背景照样四边铺满,横屏左栏那几个手调(zoom / nudge)不用;legCrop 0 的坐姿放下 {@link BUST_SHOW_SEATED}(10-01「竖屏只留上半身嘛」)。缺省 `'full'`。
   */
  crop?: 'full' | 'bust';
}

export interface Frame {
  scale: number;
  /** 模型包围盒左上角在画框里的位置。 */
  x: number;
  y: number;
}

/** 角色最下面这一截(小腿下半)可以出屏:占角色高度的比例。 */
export const LEG_CROP = 0.18;
/** 半身取景时画面里放下主体框的多少(从头顶往下)。 */
export const BUST_SHOW = 0.48;
/** 坐姿那几个(legCrop 0)主体框本来只框到大腿,半身要放下得多些,不然只剩一颗头(10-01 九尾狐)。 */
export const BUST_SHOW_SEATED = 0.8;
/** 头顶离画框上沿留多少(占画框高)。 */
export const TOP_GAP = 0.03;

function clamp(value: number, lo: number, hi: number): number {
  if (lo > hi) return (lo + hi) / 2;
  return Math.min(hi, Math.max(lo, value));
}

export function frameAvatar(input: FrameInput): Frame {
  const { view, model, subject, backdrop } = input;
  if (view.w <= 0 || view.h <= 0) return { scale: 0, x: 0, y: 0 };
  const mw = Math.max(model.w, 1);
  const mh = Math.max(model.h, 1);
  const sh = Math.max((subject.y1 - subject.y0) * mh, 1e-6);
  const top = view.h * TOP_GAP;
  if (input.crop === 'bust') return frameBust(input, mw, mh, sh, top);

  // 角色:头顶留一点,画面里放下 (1 - LEG_CROP) 那么高。**不以宽度为准**:坐姿 / 带尾巴的很宽,
  // 迁就宽度就缩在上半截「飘在半空」(10-01 维护者看 8 九尾狐、15 三花猫),两侧出屏可以。
  let scale = (view.h - top) / (sh * (1 - (input.legCrop ?? LEG_CROP))) * (input.zoom ?? 1);

  // 有背景:至少放大到四边铺满。
  if (backdrop !== null) {
    const bw = Math.max((backdrop.x1 - backdrop.x0) * mw, 1e-6);
    const bh = Math.max((backdrop.y1 - backdrop.y0) * mh, 1e-6);
    scale = Math.max(scale, view.w / bw, view.h / bh);
    // 但头顶必须在画面里、同时底部铺满:背景底边贴画框底边时,头顶离画框上沿至少 top。
    // 场景上半截不规则的那几个(59 吧台、61 和服长椅)在这里被拽回来,左右 / 顶边会露一点,外面渐隐接住。
    const span = (backdrop.y1 - subject.y0) * mh;
    if (span > 0) scale = Math.min(scale, (view.h - top) / span);
  }

  // 左右:角色居中;上下:头顶贴着留白。
  let x = view.w / 2 - (subject.x0 + subject.x1) / 2 * mw * scale;
  let y = top - subject.y0 * mh * scale;

  if (backdrop !== null) {
    // 左右:挪到背景刚好盖住(盖不住时居中)。
    x = clamp(x, view.w - backdrop.x1 * mw * scale, -backdrop.x0 * mw * scale);
    // 上下的优先级:头顶在画面里 > 底部铺满(10-01「底部都是黑的」)> 顶边铺满。倍数已按前两条收过,这里只挪。
    const bottomLo = view.h - backdrop.y1 * mh * scale;
    const headHi = top - subject.y0 * mh * scale;
    y = Math.min(y, -backdrop.y0 * mh * scale);
    if (y > headHi) y = headHi;
    y = Math.max(y, bottomLo);
  }
  if (input.nudge !== undefined) {
    x += input.nudge.x * view.w;
    y += input.nudge.y * view.h;
    // 往上挪时底部别露出来。
    if (backdrop !== null) y = Math.max(y, view.h - backdrop.y1 * mh * scale);
  }
  return { scale, x, y };
}

function frameBust({ view, subject, backdrop, legCrop }: FrameInput, mw: number, mh: number, sh: number, top: number): Frame {
  let scale = (view.h - top) / (sh * (legCrop === 0 ? BUST_SHOW_SEATED : BUST_SHOW));
  if (backdrop !== null) {
    const bw = Math.max((backdrop.x1 - backdrop.x0) * mw, 1e-6);
    const bh = Math.max((backdrop.y1 - backdrop.y0) * mh, 1e-6);
    scale = Math.max(scale, view.w / bw, view.h / bh);
  }
  let x = view.w / 2 - (subject.x0 + subject.x1) / 2 * mw * scale;
  let y = top - subject.y0 * mh * scale;
  if (backdrop !== null) {
    x = clamp(x, view.w - backdrop.x1 * mw * scale, -backdrop.x0 * mw * scale);
    // 头顶贴着留白;背景顶边盖不住就露一点(外面有渐隐接住);底边万一没盖满就整体往下挪。
    y = Math.max(y, view.h - backdrop.y1 * mh * scale);
  }
  return { scale, x, y };
}

/** 手机横屏左栏与桌面左栏的宽高比(背景框按这两个各量一个)。 */
export const PHONE_ASPECT = 288 / 393;
export const DESK_ASPECT = 396 / 800;

/**
 * 按画框宽高比挑背景框。背景框是「场景里、这个宽高比的最大全不透明矩形」,手机、桌面各量一个
 * (10-01:第一版用的是整张场景的最大矩形,又矮又宽,窄高的左栏按它铺满会放大过头)。
 */
export function backdropFor(set: { phone: Box; desk: Box } | null, view: { w: number; h: number }): Box | null {
  if (set === null) return null;
  const aspect = view.h > 0 ? view.w / view.h : PHONE_ASPECT;
  return Math.abs(aspect - PHONE_ASPECT) <= Math.abs(aspect - DESK_ASPECT) ? set.phone : set.desk;
}
