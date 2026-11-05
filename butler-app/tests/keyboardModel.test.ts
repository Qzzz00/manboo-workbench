/**
 * 弹键盘时粒子球不缩(2026-09-24,卡 fix/phone-keyboard-orb-stable)—— 纯函数那一层。
 *
 * 维护者原话:「手机上的粒子球,比如我点击输入框,弹出了键盘,粒子球就变小了……这个适配纯多余呢」。
 * 拍板三条:① 弹键盘时球的大小和位置都不变,键盘盖住下面的卡片;收起后原样回来,不闪、不跳;
 * ② 首页 / 通话页打字框 / 引导打字兜底页同一个规矩;③ 输入框在键盘上方、打的字看得见。
 *
 * 让球变小的那一环:安卓上 Capacitor 8 自带的 SystemBars 在键盘弹起时给窗口底边垫上键盘的高度
 * (`capacitor.config.ts` 里 `Keyboard.resize: None` 只对 iOS 有效),WebView 于是整个被压矮,
 * `vh` / `100%` / 弹性区全跟着缩,球那一格一缩,粒子画布(ResizeObserver)就跟着重画成小球。
 *
 * 这一份钉的是「按哪个视口排、输入框抬多高」这两个数:
 *   · 布局高度(appHeight / vh)按**没弹键盘时**的视口算 —— 键盘弹起期间不变,横竖屏切换、真的改窗口大小才重算;
 *   · 抬起的高度(lift / shift)= 键盘占掉的那一截,输入框贴着键盘上沿。
 */
import { describe, expect, it } from 'vitest';
import { kbFrame, kbLift, kbPlugin, kbRoom, kbStart, kbTyping, kbView, type KbView } from '../src/viewport/keyboardModel';

/** 维护者那台手机的 CSS 视口。 */
const PHONE: KbView = { width: 443, height: 986, visible: 986 };
/** 键盘弹起:WebView 被压到约 560(统筹给的模拟口径),键盘占掉 426。 */
const SQUEEZED: KbView = { width: 443, height: 560, visible: 560 };
const KB = 426;

function typingOpen() {
  let s = kbStart(PHONE);
  s = kbTyping(s, true);
  s = kbPlugin(s, { open: true, height: KB });
  return kbView(s, SQUEEZED);
}

describe('布局按「没弹键盘时」的视口排', () => {
  it('★点输入框 → 键盘弹起(视口变矮 + 键盘高度事件):布局高度不变,抬起的高度等于键盘高度', () => {
    const frame = kbFrame(typingOpen(), { holding: true, safeBottom: 0 });
    expect(frame.mode).toBe('up');
    // 球那一格的尺寸全从这两个数来(styles.css / stageCards.css 里的 vh 都换成了 --ba-vh)。
    expect(frame.appHeight).toBe(986);
    expect(frame.vh).toBeCloseTo(9.86, 5);
    expect(frame.lift).toBe(KB);
    expect(frame.shift).toBe(KB);
  });

  it('★收起:插件先说收、视口后回来 —— 视口回来之前一直抬着(不先掉下去再被盖住);回来之后归零', () => {
    let s = typingOpen();
    s = kbPlugin(s, { open: false });
    expect(kbLift(s)).toBe(KB);
    s = kbView(s, PHONE);
    expect(kbLift(s)).toBe(0);
    const frame = kbFrame(kbTyping(s, false), { holding: false, safeBottom: 0 });
    expect(frame.mode).toBe('idle');
  });

  it('★收起:视口先回来、插件后到 —— 视口回来那一刻就归零,不等插件', () => {
    let s = typingOpen();
    s = kbView(s, PHONE);
    expect(kbLift(s)).toBe(0);
    expect(kbFrame(s, { holding: true, safeBottom: 0 }).appHeight).toBe(986);
  });

  it('收起后再弹一次,数跟第一次一样(不累积、不漂)', () => {
    let s = typingOpen();
    s = kbView(kbPlugin(s, { open: false }), PHONE);
    s = kbView(kbPlugin(s, { open: true, height: KB }), SQUEEZED);
    const frame = kbFrame(s, { holding: true, safeBottom: 0 });
    expect([frame.appHeight, frame.lift]).toEqual([986, KB]);
  });

  it('插件的事件比视口先到:先按插件报的高度抬;视口到了按视口', () => {
    let s = kbTyping(kbStart(PHONE), true);
    s = kbPlugin(s, { open: true, height: 430 });
    expect(kbLift(s)).toBe(430);
    s = kbView(s, SQUEEZED);
    expect(kbLift(s)).toBe(KB);
  });

  it('见过一次「键盘会把视口压矮」之后,插件报的高度不单独算数 —— 视口没动就不抬', () => {
    let s = typingOpen();
    s = kbView(kbPlugin(s, { open: false }), PHONE);
    s = kbPlugin(s, { open: true, height: KB });
    expect(kbLift(s)).toBe(0);
  });

  it('键盘只盖住、不压矮视口的机器(插件报高度,视口不动):按插件报的高度抬', () => {
    let s = kbTyping(kbStart(PHONE), true);
    s = kbPlugin(s, { open: true, height: 300 });
    s = kbView(s, PHONE);
    const frame = kbFrame(s, { holding: true, safeBottom: 0 });
    expect([frame.appHeight, frame.lift]).toEqual([986, 300]);
  });

  it('只有可见区变矮(visualViewport,布局视口不动):一样算键盘', () => {
    let s = kbTyping(kbStart(PHONE), true);
    s = kbView(s, { width: 443, height: 986, visible: 600 });
    expect(kbLift(s)).toBe(386);
    expect(kbFrame(s, { holding: true, safeBottom: 0 }).appHeight).toBe(986);
  });

  it('没在打字、插件也没说:视口变矮就是真的改了窗口大小 —— 布局跟着走,不抬', () => {
    const s = kbView(kbStart(PHONE), { width: 443, height: 700, visible: 700 });
    expect(kbLift(s)).toBe(0);
    expect(kbFrame(kbTyping(s, true), { holding: true, safeBottom: 0 }).appHeight).toBe(700);
  });

  it('横竖屏切换(宽度变了):按新视口重算,不当成键盘', () => {
    let s = kbTyping(kbStart(PHONE), true);
    s = kbView(s, { width: 986, height: 443, visible: 443 });
    expect(kbLift(s)).toBe(0);
    expect(kbFrame(s, { holding: true, safeBottom: 0 }).appHeight).toBe(443);
  });

  it('窗口真的变大了(键盘收着):布局跟着变大', () => {
    const s = kbView(kbStart(PHONE), { width: 443, height: 1000, visible: 1000 });
    expect(kbFrame(s, { holding: true, safeBottom: 0 }).appHeight).toBe(1000);
  });
});

describe('输入框抬多高', () => {
  it('★有手势条(底部安全区)时扣掉那一截:输入框底边照旧离键盘 14px,安全区那一截埋在键盘后面', () => {
    const frame = kbFrame(typingOpen(), { holding: true, safeBottom: 24 });
    expect(frame.lift).toBe(KB);
    expect(frame.shift).toBe(KB - 24);
  });

  it('键盘比安全区还矮(外接键盘只剩一条工具栏):不往下挪', () => {
    let s = kbTyping(kbStart(PHONE), true);
    s = kbView(s, { width: 443, height: 970, visible: 970 });
    expect(kbFrame(s, { holding: true, safeBottom: 24 }).shift).toBe(0);
  });

  it('没在 hold(焦点不在这三页里):什么都不冻、不抬 —— 设置页那些输入框照旧交给系统', () => {
    const frame = kbFrame(typingOpen(), { holding: false, safeBottom: 0 });
    expect(frame.mode).toBe('idle');
  });

  it('在 hold 但键盘还没起来:mode 是 hold(先冻住,键盘起来那一帧球不会先缩一下)', () => {
    const frame = kbFrame(kbTyping(kbStart(PHONE), true), { holding: true, safeBottom: 0 });
    expect(frame.mode).toBe('hold');
    expect(frame.lift).toBe(0);
    expect(frame.appHeight).toBe(986);
  });
});

describe('球底到键盘上沿那一截(通话页把字幕尾巴和打字框放在这里)', () => {
  it('= 键盘上沿 − 球的下沿;不会是负数', () => {
    const frame = kbFrame(typingOpen(), { holding: true, safeBottom: 0 });
    expect(kbRoom(frame, 464)).toBe(560 - 464);
    expect(kbRoom(frame, 600)).toBe(0);
  });
});
