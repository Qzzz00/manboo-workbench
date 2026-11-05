/**
 * 弹键盘时粒子球不缩(卡 fix/phone-keyboard-orb-stable)—— 接到 DOM 上的那一层。
 *
 * jsdom 不排版,所以这里钉的是**写到页面上的那几个数**(CSS 全靠它们):
 *   · <html data-ba-kb="hold|up">:焦点在舞台 / 通话 / 引导页的输入框里就先 hold(冻住布局),键盘起来是 up;
 *   · --ba-app-h / --ba-vh:布局按「没弹键盘时」的视口排 —— 键盘弹起期间不变,于是球那一格不变;
 *   · --ba-kb-shift:底部输入框抬起的高度 = 键盘高度(扣掉底部安全区);
 *   · 页面上的 --ba-kb-anchor-h / --ba-kb-anchor-gap / --ba-kb-room:通话页把字幕尾巴与打字框放进「球底到键盘上沿」那一截;
 *   · 收起(视口回来 + 焦点离开)之后这些全部撤掉,页面回到原样。
 * 真排版的证据在真 Chrome 里量(见 docs/交接-0924-键盘不缩球.md 的截图与数)。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installKeyboardViewport } from '../src/viewport/keyboardViewport';

const html = document.documentElement;
let dispose: (() => void) | null = null;

function setViewport(width: number, height: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
}
function resize(width: number, height: number): void {
  setViewport(width, height);
  window.dispatchEvent(new Event('resize'));
}
/** Capacitor 的 Keyboard 插件在安卓上就是这样派事件的:window 上一个带 keyboardHeight 的 Event。 */
function plugin(name: 'keyboardWillShow' | 'keyboardDidShow' | 'keyboardWillHide' | 'keyboardDidHide', keyboardHeight?: number): void {
  const ev = new Event(name) as Event & { keyboardHeight?: number };
  if (keyboardHeight !== undefined) ev.keyboardHeight = keyboardHeight;
  window.dispatchEvent(ev);
}
function rect(el: Element, top: number, height: number): void {
  el.getBoundingClientRect = () => ({ x: 0, y: top, top, left: 0, right: 443, bottom: top + height, width: 443, height, toJSON() { return {}; } }) as DOMRect;
}
const v = (el: HTMLElement, name: string) => el.style.getPropertyValue(name);

/** 一页「舞台」:球那一格(446 高,球 266 居中)+ 字幕面板(会滚)+ 输入框。 */
function stagePage() {
  document.body.innerHTML = `
    <div class="page" data-ba-kb-page="stage">
      <div class="cell" data-ba-kb-anchor="orb"><div class="ball"></div></div>
      <div class="panel" data-ba-kb-stick="bottom"><p>一</p><p>二</p></div>
      <textarea aria-label="说点什么"></textarea>
    </div>
    <input class="elsewhere" aria-label="设置页里的输入框" />
  `;
  const page = document.querySelector<HTMLElement>('.page')!;
  const cell = document.querySelector<HTMLElement>('.cell')!;
  rect(cell, 18, 646);
  rect(document.querySelector('.ball')!, 198, 266);
  const panel = document.querySelector<HTMLElement>('.panel')!;
  Object.defineProperty(panel, 'scrollHeight', { configurable: true, value: 400 });
  return { page, panel, textarea: document.querySelector('textarea')!, elsewhere: document.querySelector<HTMLInputElement>('.elsewhere')! };
}

/** 点输入框 → 键盘弹起(与安卓上的顺序一致:焦点先到,插件报高度,WebView 被压到 560)。 */
function openKeyboard(target: HTMLElement): void {
  target.focus();
  plugin('keyboardWillShow', 426);
  resize(443, 560);
  plugin('keyboardDidShow', 426);
}

beforeEach(() => {
  setViewport(443, 986);
  dispose = installKeyboardViewport(window);
});
afterEach(() => {
  dispose?.();
  dispose = null;
  document.body.innerHTML = '';
});

describe('焦点进到这三页的输入框里:先冻住布局(hold)', () => {
  it('★点输入框那一刻就按「没弹键盘时」的视口冻住 —— 键盘起来那一帧球不会先缩一下', () => {
    const { textarea } = stagePage();
    expect(html.hasAttribute('data-ba-kb')).toBe(false);
    textarea.focus();
    expect(html.getAttribute('data-ba-kb')).toBe('hold');
    expect(v(html, '--ba-app-h')).toBe('986px');
    expect(v(html, '--ba-vh')).toBe('9.86px');
    expect(v(html, '--ba-kb')).toBe('0px');
  });

  it('焦点在别的页(设置页那种)里:什么都不动,照旧交给系统', () => {
    const { elsewhere } = stagePage();
    openKeyboard(elsewhere);
    expect(html.hasAttribute('data-ba-kb')).toBe(false);
    expect(v(html, '--ba-app-h')).toBe('');
  });
});

describe('键盘起来(up)', () => {
  it('★视口压到 560 + 键盘高度 426:布局高度仍是 986(球那一格不变),输入框抬 426', () => {
    const { textarea } = stagePage();
    openKeyboard(textarea);
    expect(html.getAttribute('data-ba-kb')).toBe('up');
    expect(v(html, '--ba-app-h')).toBe('986px');
    expect(v(html, '--ba-vh')).toBe('9.86px');
    expect(v(html, '--ba-kb')).toBe('426px');
    expect(v(html, '--ba-kb-shift')).toBe('426px');
  });

  it('★量一次球那一格:格子高、球底到格底的空、球底到键盘上沿那一截(通话页用)', () => {
    const { page, textarea } = stagePage();
    openKeyboard(textarea);
    expect(v(page, '--ba-kb-anchor-h')).toBe('646px');
    expect(v(page, '--ba-kb-anchor-gap')).toBe(`${18 + 646 - (198 + 266)}px`);
    expect(v(page, '--ba-kb-room')).toBe(`${560 - (198 + 266)}px`);
  });

  it('要贴底的那一格(字幕面板 / 引导对话流)滚到最底:最新那句在键盘上方看得见', () => {
    const { panel, textarea } = stagePage();
    openKeyboard(textarea);
    expect(panel.scrollTop).toBe(400);
  });

  it('键盘先起、视口后到(插件事件先到):先按插件的高度抬,视口到了按视口', () => {
    const { textarea } = stagePage();
    textarea.focus();
    plugin('keyboardWillShow', 430);
    expect(html.getAttribute('data-ba-kb')).toBe('up');
    expect(v(html, '--ba-kb')).toBe('430px');
    resize(443, 560);
    expect(v(html, '--ba-kb')).toBe('426px');
    expect(v(html, '--ba-app-h')).toBe('986px');
  });
});

describe('收起键盘:原样回来', () => {
  it('★插件先说收、视口后回来:视口回来之前一直抬着;回来且焦点离开之后,html 与页面上的数全撤掉', () => {
    const { page, textarea } = stagePage();
    openKeyboard(textarea);
    plugin('keyboardWillHide');
    textarea.blur();
    // 键盘还没退完(视口还是 560):不许先把布局放回去 —— 那一下球会缩一下再弹回来。
    expect(html.getAttribute('data-ba-kb')).toBe('up');
    expect(v(html, '--ba-app-h')).toBe('986px');
    resize(443, 986);
    plugin('keyboardDidHide');
    expect(html.hasAttribute('data-ba-kb')).toBe(false);
    for (const name of ['--ba-app-h', '--ba-vh', '--ba-kb', '--ba-kb-shift', '--ba-safe-top', '--ba-safe-bottom']) expect(v(html, name)).toBe('');
    for (const name of ['--ba-kb-anchor-h', '--ba-kb-anchor-gap', '--ba-kb-room']) expect(v(page, name)).toBe('');
  });

  it('按返回键收键盘、焦点还在输入框里:回到 hold(布局仍冻着,数与没弹键盘时一样)', () => {
    const { page, textarea } = stagePage();
    openKeyboard(textarea);
    plugin('keyboardWillHide');
    resize(443, 986);
    expect(html.getAttribute('data-ba-kb')).toBe('hold');
    expect(v(html, '--ba-app-h')).toBe('986px');
    expect(v(html, '--ba-kb')).toBe('0px');
    expect(v(page, '--ba-kb-room')).toBe('');
  });

  it('再弹一次,数跟第一次一样', () => {
    const { textarea } = stagePage();
    openKeyboard(textarea);
    plugin('keyboardWillHide');
    resize(443, 986);
    openKeyboard(textarea);
    expect([v(html, '--ba-app-h'), v(html, '--ba-kb'), v(html, '--ba-kb-shift')]).toEqual(['986px', '426px', '426px']);
  });

  it('页面在键盘开着时被卸掉(通话那头挂了):视口一回来就全撤,不留一个冻住的高度', () => {
    const { page, textarea } = stagePage();
    openKeyboard(textarea);
    page.remove();
    resize(443, 986);
    expect(html.hasAttribute('data-ba-kb')).toBe(false);
  });
});

describe('真的改了尺寸才重算', () => {
  it('横竖屏切换:按新视口重算', () => {
    const { textarea } = stagePage();
    textarea.focus();
    resize(986, 443);
    expect(v(html, '--ba-app-h')).toBe('443px');
    expect(html.getAttribute('data-ba-kb')).toBe('hold');
  });
});

describe('卸载', () => {
  it('卸掉之后不再听事件,html 上也不留东西', () => {
    const { textarea } = stagePage();
    openKeyboard(textarea);
    dispose?.();
    dispose = null;
    expect(html.hasAttribute('data-ba-kb')).toBe(false);
    expect(v(html, '--ba-app-h')).toBe('');
    resize(443, 986);
    textarea.focus();
    expect(html.hasAttribute('data-ba-kb')).toBe(false);
  });
});
