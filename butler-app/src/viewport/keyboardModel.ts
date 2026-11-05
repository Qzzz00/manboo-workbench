/**
 * 弹键盘时按哪个视口排、输入框抬多高 —— 纯函数(2026-09-24,卡 fix/phone-keyboard-orb-stable)。
 *
 * ## 为什么要有这一层(维护者:「点击输入框,弹出了键盘,粒子球就变小了……这个适配纯多余」)
 *
 * `capacitor.config.ts` 里的 `Keyboard.resize: None` **只对 iOS 有效**(安卓那头的 setResizeMode 是 unimplemented)。
 * 安卓上真正让页面变矮的是 Capacitor 8 自带的 SystemBars:它在键盘弹起时给窗口底边垫上键盘的高度
 * (`v.setPadding(0, 0, 0, keyboardVisible ? imeInsets.bottom : …)`),WebView 于是整个被压矮 ——
 * `100%`、`vh`、弹性区全跟着缩,球那一格一缩,粒子画布的 ResizeObserver 就把球重画小了。
 *
 * 做法:**布局按「没弹键盘时」的视口排**(键盘弹起期间不变;横竖屏切换、真的改窗口大小才重算),
 * 于是球那一格一个像素都不动。
 *
 * 2026-09-25(卡 fix/phone-keyboard-overlap)补上后半截:上一版到这里就「只把输入框抬到键盘上沿,
 * 键盘下面那几张卡片被盖住就盖住」,维护者在 0.3.2 上撞见的就是这个 ——「正在办和呼出键盘的输入框会重叠在一起」。
 * 现在改成:整页的内容盒下边界收到键盘上沿(padding-bottom: shift),内容区跟着变矮、自己滚,输入框照常排在它下面。
 * 谁都不压谁,球照旧不缩。CSS 在 keyboard.css,那一份的文件头有完整的前因后果。
 *
 * 这里只算数(哪个高度算「没弹键盘时」、键盘占掉多少、「当前在看的那一块」要滚到哪);写到页面上的是 keyboardViewport.ts。
 */

/** 视口的一次读数(CSS px)。`visible` = 可见区高度(visualViewport;没有就等于 height)。 */
export interface KbView {
  width: number;
  height: number;
  visible: number;
}

export interface KbState {
  /** 没弹键盘时的视口:布局按它排。 */
  stable: { width: number; height: number };
  /** 视口上看得出来的、被键盘占掉的那一截(没有就是 0)。 */
  cover: number;
  /** Keyboard 插件怎么说(keyboardWillShow / DidShow 带高度;WillHide / DidHide 收)。 */
  plugin: { open: boolean; height: number };
  /** 此刻有没有可打字的东西在焦点上。 */
  typing: boolean;
  /**
   * 这台机器弹键盘时视口看得出来(被压矮 / 可见区变矮)。见过一次就记住:
   * 之后插件报的高度不再单独算数 —— 否则视口已经回来了、插件的「收」还没到,输入框会悬在半空。
   */
  tracks: boolean;
}

/** 一帧要写到页面上的数。 */
export interface KbFrame {
  /** idle = 什么都不冻(焦点不在那三页里);hold = 冻住布局、键盘还没起来;up = 键盘起来了。 */
  mode: 'idle' | 'hold' | 'up';
  /** 布局高度 = 没弹键盘时的视口高度(#root 用它)。 */
  appHeight: number;
  /** 1vh 按没弹键盘时算(球那一格的 vh 都换成了它)。 */
  vh: number;
  /** 键盘占掉的那一截:从「没弹键盘时」的底边量到键盘上沿。 */
  lift: number;
  /** 底部输入框抬多高 = lift 扣掉底部安全区(安全区那一截埋在键盘后面,输入框底边照旧离键盘 14px)。 */
  shift: number;
}

/** 小于 1px 的差当成没变(visualViewport 会给小数)。 */
const EPS = 1;

export function kbStart(view: KbView): KbState {
  return { stable: { width: view.width, height: view.height }, cover: 0, plugin: { open: false, height: 0 }, typing: false, tracks: false };
}

/** 视口变了(resize / visualViewport resize)。 */
export function kbView(s: KbState, view: KbView): KbState {
  // 宽度变了:横竖屏切换或真的改了窗口大小 —— 整个按新视口重算,不当成键盘。
  if (Math.abs(view.width - s.stable.width) >= EPS) {
    return { ...s, stable: { width: view.width, height: view.height }, cover: 0 };
  }
  // 变高了:键盘收了,或窗口真的变大了。
  const height = Math.max(s.stable.height, view.height);
  const gap = height - Math.min(view.height, view.visible);
  if (gap < EPS) return { ...s, stable: { width: view.width, height }, cover: 0 };
  // 变矮了,而且在打字 / 插件说键盘开着 / 键盘本来就占着:是键盘。布局高度不动。
  if (s.typing || s.plugin.open || s.cover > 0) return { ...s, stable: { width: view.width, height }, cover: gap, tracks: true };
  // 没人在打字:是真的改了窗口大小(分屏、系统栏显隐),布局跟着走。
  return { ...s, stable: { width: view.width, height: view.height }, cover: 0 };
}

/** Keyboard 插件的事件。 */
export function kbPlugin(s: KbState, event: { open: boolean; height?: number }): KbState {
  return { ...s, plugin: event.open ? { open: true, height: event.height ?? s.plugin.height } : { open: false, height: 0 } };
}

/** 焦点变了。 */
export function kbTyping(s: KbState, typing: boolean): KbState {
  return s.typing === typing ? s : { ...s, typing };
}

/** 键盘此刻占掉多高(px)。视口看得出来就按视口;视口从来看不出来的机器才按插件报的高度。 */
export function kbLift(s: KbState): number {
  if (s.cover >= EPS) return Math.round(s.cover);
  if (s.plugin.open && !s.tracks) return Math.max(0, Math.round(s.plugin.height));
  return 0;
}

/**
 * 这一帧写什么。`holding` 由 DOM 那一层判(焦点在那三页的输入框里,或键盘还占着);
 * `safeBottom` 是没弹键盘时量到的底部安全区(手势条)。
 */
export function kbFrame(s: KbState, options: { holding: boolean; safeBottom: number }): KbFrame {
  const lift = kbLift(s);
  const appHeight = s.stable.height;
  const vh = appHeight / 100;
  if (!options.holding) return { mode: 'idle', appHeight, vh, lift, shift: 0 };
  return { mode: lift > 0 ? 'up' : 'hold', appHeight, vh, lift, shift: Math.max(0, lift - Math.max(0, options.safeBottom)) };
}

/** 球底到键盘上沿那一截(px,不为负):通话页把字幕尾巴与打字框放在这里。`anchorBottom` 是球的下沿(视口坐标)。 */
export function kbRoom(frame: KbFrame, anchorBottom: number): number {
  return Math.max(0, Math.round(frame.appHeight - frame.lift - anchorBottom));
}

/**
 * 把「当前在看的那一块」滚进内容区的可视范围 —— 算新的 scrollTop(2026-09-25,卡 fix/phone-keyboard-overlap)。
 *
 * `box` 是内容区那个框(`top` = 它的上沿,视口坐标;`height` = 看得见的那一段;`scrollTop` = 此刻滚到哪),
 * `target` 是那一块的矩形(`top` 同样是视口坐标)。**能不动就不动**:那一块已经整块看得见时原样返回 ——
 * 键盘弹起时页面不该无端跳一下。那一块比框还高、或在框上面时对齐它的上沿;在框下面时把它的下沿贴到框的下沿。
 */
export function kbScrollInto(box: { top: number; height: number; scrollTop: number }, target: { top: number; height: number }): number {
  if (!(box.height > 0)) return box.scrollTop;
  // 那一块在「内容坐标」里的上下沿(内容坐标 = 视口坐标 − 框的上沿 + 已经滚掉的那一截)。
  const top = target.top - box.top + box.scrollTop;
  const bottom = top + target.height;
  if (target.height >= box.height || top < box.scrollTop) return Math.max(0, Math.round(top));
  if (bottom > box.scrollTop + box.height) return Math.max(0, Math.round(bottom - box.height));
  return box.scrollTop;
}
