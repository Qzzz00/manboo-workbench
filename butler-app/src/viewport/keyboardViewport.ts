/**
 * 弹键盘时粒子球不缩、输入框不盖内容 —— 接到页面上的那一层
 * (2026-09-24 卡 fix/phone-keyboard-orb-stable;2026-09-25 卡 fix/phone-keyboard-overlap 补上「内容区变矮 + 自己滚」)。
 *
 * 数怎么算在 keyboardModel.ts(连同「为什么安卓上页面会被压矮」);这里只做三件事:
 *
 * 1. **听**:window 的 resize、visualViewport 的 resize、焦点进出(focusin / focusout),
 *    以及 Keyboard 插件派到 window 上的 keyboardWillShow / DidShow / WillHide / DidHide
 *    (安卓那头 `bridge.triggerWindowJSEvent`,事件上带 keyboardHeight;网页里从来不会来,不影响)。
 * 2. **判**:焦点落在带 `data-ba-kb-page` 的那几页(首页舞台 / 通话 / 引导打字兜底页)的输入框里 → hold;
 *    键盘占着 → up;两样都没有 → idle。别的页(设置、配对……)的输入框一概不管,照旧交给系统。
 * 3. **写**(全部同步写在事件里,不经 React —— 经 React 就晚一帧,那一帧球会先缩一下再弹回来):
 *    - `<html data-ba-kb="hold|up">`;
 *    - `--ba-app-h` / `--ba-vh`:布局按没弹键盘时的视口排(keyboard.css 让 #root 用它,球那一格的 vh 都换成了 --ba-vh);
 *    - `--ba-safe-top` / `--ba-safe-bottom`:钉成没弹键盘时量到的值(键盘开着时 WebView 报的底部安全区会变,
 *      底部那一条的内边距跟着变就会把上面的球挤动几个像素);
 *    - `--ba-kb`(键盘占掉的高度)、`--ba-kb-shift`(底部输入框抬多高);
 *    - 键盘起来那一刻量一次页里的 `data-ba-kb-anchor`(球那一格):`--ba-kb-anchor-h`(格子高,钉住它)、
 *      `--ba-kb-anchor-gap`(球底到格底)、`--ba-kb-room`(球底到键盘上沿,通话页的字幕 + 打字框放在这里),写在那一页上;
 *    - `data-ba-kb-stick` 的那几格(字幕面板、引导对话流)滚到最底,键盘开着期间来了新字也贴底;
 *    - `data-ba-kb-fit` 那一格(内容区)在键盘起来时把 `data-ba-kb-into`(当前在看的那一块)滚进可视区,
 *      键盘收起时滚回顶上 —— 变矮与能滚这两件是 keyboard.css 干的,这里只管滚到哪(kbScrollInto)。
 *
 * 先 hold 再 up 是这一版的关键:点输入框那一刻(键盘还没起来)就把布局钉在当前视口 —— 与没钉时一模一样,
 * 看不出任何变化;等 WebView 被压矮时,布局已经不跟着它走了,球那一格一个像素都不动。
 */
import './keyboard.css';
import { kbFrame, kbLift, kbPlugin, kbRoom, kbScrollInto, kbStart, kbTyping, kbView, type KbFrame, type KbState, type KbView } from './keyboardModel';

/** 写在 <html> 上的那个属性。 */
export const KB_ATTR = 'data-ba-kb';
const PAGE = '[data-ba-kb-page]';
const ANCHOR = '[data-ba-kb-anchor]';
const STICK = '[data-ba-kb-stick]';
/** 内容区(键盘开着时变矮、自己滚的那一格)与它里面「当前在看的那一块」。 */
const FIT = '[data-ba-kb-fit]';
const INTO = '[data-ba-kb-into]';

const HTML_VARS = ['--ba-app-h', '--ba-vh', '--ba-kb', '--ba-kb-shift', '--ba-safe-top', '--ba-safe-bottom'] as const;
const PAGE_VARS = ['--ba-kb-anchor-h', '--ba-kb-anchor-gap', '--ba-kb-room'] as const;

/** 会弹键盘的 input 类型。 */
const TEXT_INPUTS = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number', '']);

function isEditable(el: Element | null): el is HTMLElement {
  if (el === null) return false;
  const tag = el.tagName;
  if (tag === 'TEXTAREA') { const t = el as HTMLTextAreaElement; return !t.readOnly && !t.disabled; }
  if (tag === 'INPUT') { const i = el as HTMLInputElement; return !i.readOnly && !i.disabled && TEXT_INPUTS.has(i.type); }
  return (el as HTMLElement).isContentEditable === true;
}

/** 量一次安全区(env() 只有排版引擎认,用一个看不见的探针读计算值;jsdom 里就是 0)。 */
function measureSafe(doc: Document): { top: number; bottom: number } {
  const probe = doc.createElement('div');
  probe.setAttribute('aria-hidden', 'true');
  probe.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;visibility:hidden;pointer-events:none;'
    + 'padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)';
  (doc.body ?? doc.documentElement).appendChild(probe);
  const style = doc.defaultView?.getComputedStyle(probe);
  const top = Number.parseFloat(style?.paddingTop ?? '') || 0;
  const bottom = Number.parseFloat(style?.paddingBottom ?? '') || 0;
  probe.remove();
  return { top, bottom };
}

const px = (n: number): string => `${Math.round(n * 100) / 100}px`;

/**
 * 装上(main.tsx 启动时一次)。返回卸载函数(测试用;生产不卸)。
 */
export function installKeyboardViewport(win: Window = window): () => void {
  const doc = win.document;
  const html = doc.documentElement;
  const vv = win.visualViewport ?? null;
  const read = (): KbView => {
    const height = win.innerHeight;
    return { width: win.innerWidth, height, visible: Math.min(height, vv?.height ?? height) };
  };

  let state: KbState = kbStart(read());
  let safe = measureSafe(doc);
  /** 焦点所在的那一页(hold 住的那一页)。 */
  let page: HTMLElement | null = null;
  let mode: KbFrame['mode'] = 'idle';
  /** 键盘起来那一刻量到的球底(视口坐标);没有球那一格就是 null。 */
  let anchorBottom: number | null = null;
  let lastLift = 0;
  let stickObserver: MutationObserver | null = null;

  const setVar = (el: HTMLElement, name: string, value: string): void => { el.style.setProperty(name, value); };
  const clearPage = (el: HTMLElement | null): void => { if (el !== null) for (const name of PAGE_VARS) el.style.removeProperty(name); };
  const sticks = (el: HTMLElement): HTMLElement[] => [...el.querySelectorAll<HTMLElement>(STICK)];
  const stickToBottom = (el: HTMLElement): void => { for (const one of sticks(el)) one.scrollTop = one.scrollHeight; };
  /**
   * 内容区:把「当前在看的那一块」滚进可视区(能不动就不动,见 kbScrollInto)。
   * 这一格变矮、能滚是 keyboard.css 的事;这里只挑滚到哪。没标 data-ba-kb-into 的页面什么都不做 ——
   * 于是键盘弹起时页面纹丝不动,只是底下多了一截能滚的地方。
   */
  const fitIntoView = (el: HTMLElement): void => {
    for (const fit of [...el.querySelectorAll<HTMLElement>(FIT)]) {
      const target = fit.querySelector<HTMLElement>(INTO);
      if (target === null) continue;
      const box = fit.getBoundingClientRect();
      const height = fit.clientHeight > 0 ? fit.clientHeight : box.height;
      const rect = target.getBoundingClientRect();
      fit.scrollTop = kbScrollInto({ top: box.top, height, scrollTop: fit.scrollTop }, { top: rect.top, height: rect.height });
    }
  };
  /** 键盘收了:内容区回到顶上(不留一个「滚过一半」的首页)。 */
  const fitToTop = (el: HTMLElement | null): void => {
    if (el === null) return;
    for (const fit of [...el.querySelectorAll<HTMLElement>(FIT)]) fit.scrollTop = 0;
  };
  const stopSticking = (): void => { stickObserver?.disconnect(); stickObserver = null; };
  /** 键盘没占着的时候才量安全区:键盘开着时 WebView 报的底部安全区会变,那时候的数不要。 */
  const refreshSafe = (): void => { if (kbLift(state) === 0 && !state.plugin.open) safe = measureSafe(doc); };

  /** 键盘起来那一刻:量球那一格(此刻布局已经钉住,量到的就是没弹键盘时的样子)。 */
  function measureAnchor(el: HTMLElement): void {
    const anchor = el.querySelector<HTMLElement>(ANCHOR);
    if (anchor === null) { anchorBottom = null; return; }
    const cell = anchor.getBoundingClientRect();
    const ball = (anchor.firstElementChild ?? anchor).getBoundingClientRect();
    anchorBottom = ball.bottom;
    setVar(el, '--ba-kb-anchor-h', px(cell.height));
    setVar(el, '--ba-kb-anchor-gap', px(Math.max(0, cell.bottom - ball.bottom)));
  }

  function release(): void {
    html.removeAttribute(KB_ATTR);
    for (const name of HTML_VARS) html.style.removeProperty(name);
    clearPage(page);
    stopSticking();
    fitToTop(page);
    anchorBottom = null;
    lastLift = 0;
  }

  function update(): void {
    const active = doc.activeElement;
    const focusedPage = isEditable(active) ? active.closest<HTMLElement>(PAGE) : null;
    state = kbTyping(state, isEditable(active));
    // 刚要钉住(焦点进了这三页):先量一次安全区。别的焦点进出不量,省一次样式计算。
    if (mode === 'idle' && focusedPage !== null) refreshSafe();

    if (focusedPage !== null && focusedPage !== page) {
      // 换了一页(或第一次进来):上一页身上的数撤掉。
      clearPage(page);
      stopSticking();
      if (mode === 'up') mode = 'hold';
      page = focusedPage;
    }
    const lift = kbLift(state);
    // 焦点离开、键盘也收了(或者那一页整个被卸掉了):放开。键盘还占着就先别放 —— 放早了球会缩一下再弹回来。
    if (page !== null && (!page.isConnected || (focusedPage === null && lift === 0))) {
      release();
      page = null;
      mode = 'idle';
      return;
    }
    const frame = kbFrame(state, { holding: page !== null, safeBottom: safe.bottom });
    if (frame.mode === 'idle' || page === null) {
      if (mode !== 'idle') release();
      mode = 'idle';
      return;
    }

    setVar(html, '--ba-app-h', px(frame.appHeight));
    setVar(html, '--ba-vh', px(frame.vh));
    setVar(html, '--ba-safe-top', px(safe.top));
    setVar(html, '--ba-safe-bottom', px(safe.bottom));
    setVar(html, '--ba-kb', px(frame.lift));
    setVar(html, '--ba-kb-shift', px(frame.shift));

    if (frame.mode === 'up') {
      const entering = mode !== 'up';
      if (entering) {
        // 先在 hold 的样子(布局钉在没弹键盘时)下量球那一格,再切到 up。
        html.setAttribute(KB_ATTR, 'hold');
        measureAnchor(page);
      }
      if (anchorBottom !== null) setVar(page, '--ba-kb-room', px(kbRoom(frame, anchorBottom)));
      html.setAttribute(KB_ATTR, 'up');
      // 贴底:刚起来、或键盘高度变了(候选词条出来)时滚一次;之后来了新字由 MutationObserver 接着贴。
      // 内容区同一个时机:刚变矮 / 变矮的那一截变了,就把当前在看的那一块滚回可视区。
      if (entering || frame.lift !== lastLift) { stickToBottom(page); fitIntoView(page); }
      if (stickObserver === null && typeof MutationObserver !== 'undefined') {
        const held = page;
        stickObserver = new MutationObserver(() => stickToBottom(held));
        for (const one of sticks(held)) stickObserver.observe(one, { childList: true, subtree: true, characterData: true });
      }
    } else {
      // 键盘收了、焦点还在输入框里:内容区回到整高,滚过的那一截也归位(不留一个滚过一半的首页)。
      if (mode === 'up') { clearPage(page); stopSticking(); fitToTop(page); anchorBottom = null; }
      html.setAttribute(KB_ATTR, 'hold');
    }
    lastLift = frame.lift;
    mode = frame.mode;
  }

  // 视口变了(含横竖屏切换,安全区会跟着变):键盘没占着就重量一次安全区。
  const onResize = (): void => { state = kbView(state, read()); refreshSafe(); update(); };
  const onShow = (event: Event): void => {
    const height = Number((event as Event & { keyboardHeight?: unknown }).keyboardHeight);
    state = kbPlugin(state, Number.isFinite(height) ? { open: true, height } : { open: true });
    update();
  };
  const onHide = (): void => { state = kbPlugin(state, { open: false }); update(); };

  win.addEventListener('resize', onResize);
  vv?.addEventListener('resize', onResize);
  doc.addEventListener('focusin', update, true);
  doc.addEventListener('focusout', update, true);
  win.addEventListener('keyboardWillShow', onShow);
  win.addEventListener('keyboardDidShow', onShow);
  win.addEventListener('keyboardWillHide', onHide);
  win.addEventListener('keyboardDidHide', onHide);

  return () => {
    win.removeEventListener('resize', onResize);
    vv?.removeEventListener('resize', onResize);
    doc.removeEventListener('focusin', update, true);
    doc.removeEventListener('focusout', update, true);
    win.removeEventListener('keyboardWillShow', onShow);
    win.removeEventListener('keyboardDidShow', onShow);
    win.removeEventListener('keyboardWillHide', onHide);
    win.removeEventListener('keyboardDidHide', onHide);
    release();
    page = null;
    mode = 'idle';
  };
}
