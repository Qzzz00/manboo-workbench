/**
 * 守门:**手机首页弹键盘时,输入框不许盖住内容**(2026-09-25,卡 fix/phone-keyboard-overlap)。
 * 维护者在 Pixel 上热更新到 0.3.2 后撞见的原话:「发现现在正在办和呼出键盘的输入框会重叠在一起」。
 *
 * ## 这一份守的是什么
 *
 * 1. 机制三条在不在:整页内容盒的下边界收到键盘上沿、内容区自己滚、内容区里那一栏按内容高(见 keyboard.css);
 * 2. 按**统筹在小米 10S 上量到的那一档数**排一遍:键盘弹起后看得见的内容一块都没被输入框压住、球的尺寸一个像素没变;
 * 3. 反过来用 0.3.2 的老做法(把输入框 `top: -shift` 抬上去)排同一档数,**必须重现**维护者看到的重叠 ——
 *    量法抓不住老 bug 的话,它也守不住新机制;
 * 4. 输入框长高(打一长段)、收起键盘、横竖屏切换,规矩照旧;
 * 5. 真 StagePage 上的结构不变式:输入框是内容区的**兄弟**、排在它后面,卡片在内容区**里面** ——
 *    只要没人把这两件事改掉,重叠在排版上就不可能发生。
 *
 * ## 为什么要自己排一遍(而不是读 getBoundingClientRect)
 *
 * vitest 跑在 jsdom 里,**jsdom 不排版**(所有矩形都是 0,同 tests/keyboardCss.test.ts / orbSlotCss.test.ts 的处境)。
 * 所以这里带一个**只懂这一页的**小排版器:`.ba-scene` 的孩子从上往下摆,每一块的固有高度用真机上量到的数;
 * 而「键盘起来时收多少、内容区能不能滚」这三个开关是**从真的 keyboard.css 文本里读出来的** ——
 * 谁把机制删了或改了名字,开关就读不到,这一份立刻红。真排出来的样子在真机上量(见 docs/交接-0925-手机弹键盘不遮内容.md)。
 *
 * 小米 10S(MIUI,系统字号默认)0.3.2 上量到的那一档(CSS px):
 *   没弹键盘:innerHeight 851;输入框 textarea 737–786;「正在办」标题 355–390;
 *   弹了键盘:innerHeight / visualViewport 490;输入框 376–425(抬了 361 = 851 − 490);「正在办」标题还在 355–390 → 重叠。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { installKeyboardViewport } from '../src/viewport/keyboardViewport';
import { kbScrollInto } from '../src/viewport/keyboardModel';
import { StagePage } from '../src/stage/StagePage';
import { SessionContext, type Session } from '../src/session';
import { SettingsContext } from '../src/settings/SettingsContext';
import { createSettingsStore, DEFAULT_SETTINGS } from '../src/settings/settingsStore';
import { createApiClient } from '../src/api/client';
import { createVoiceApi } from '../src/api/voice';
import { createCallApi } from '../src/api/call';
import { createAppearanceFeed } from '../src/swarm/appearance';
import { emptyState } from '../src/api/protocol';
import type { FeedSnapshot, StateFeed } from '../src/api/stateFeed';
import { AvatarContext } from '../src/live2d/AvatarContext';
import { NO_AVATAR_TEXT, type AvatarState } from '../src/live2d/useAvatar';
import type { KeyValueStore } from '../src/api/tokenStore';
import { fakeChannel, fakeRouted } from './wbchFakes';

vi.mock('../src/aiboo/lipsyncPlayer', () => ({ playAudioBlob: async (_b: Blob, _m: () => void, onEnded?: () => void) => { onEnded?.(); }, stopSpeaking: () => {}, isSpeaking: () => false }));

const KB = readFileSync(resolve(__dirname, '../src/viewport/keyboard.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ');

// ── 真机那一档数(小米 10S,竖屏 393 × 851)──────────────────────────────────
/** 没弹键盘时的视口高。 */
const APP = 851;
/** 键盘弹起后看得见的那一截(innerHeight 与 visualViewport 都是这个数)。 */
const VISIBLE = 490;
/** 那台机器上 WebView 报的底部安全区是 0(所以输入框整整抬了 361)。 */
const SAFE_BOTTOM = 0;
/** 顶上那一排(设置 / 记录两颗 icon)。 */
const TOP = 50;
/** 字幕那一格(定高:他一行 + 她两行)。 */
const CAPTIONS = 100;
/** 卡片区:「正在办」整行 + 两排两列,连下面的内边距。 */
const CARDS = 383;
/** 底部那一条:内边距 10 + 打字框 49 + 那一排键 + 内边距 14(含安全区)—— 排出来打字框正好落在真机量到的 737。 */
const DOCK = 124;
/** 打字框在底部那一条里的位置。 */
const INPUT_IN_DOCK = { top: 10, height: 49 };
/** 底部那一条最下面那 14px 是内边距(键盘开着时这一截埋在键盘后面)。 */
const DOCK_PAD_BOTTOM = 14;
/** 卡片标题在卡片区里的位置(「正在办」是最上面那一张,整行)。 */
const TITLES = [
  { name: '正在办', top: 11, height: 35 },
  { name: '等你确认', top: 101, height: 35 },
  { name: '最近一次通话', top: 249, height: 35 },
];

interface Box { top: number; bottom: number; height: number }
const box = (top: number, height: number): Box => ({ top, bottom: top + height, height });
/** 两块矩形竖着重叠了多少(≤ 0 = 没相交;这一页每一块都是通栏,横向不用比)。 */
const overlap = (a: Box, b: Box): number => Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
/** 那一块在框里看得见的部分(整块在框外就是 null)。 */
function clip(inner: Box, frame: Box): Box | null {
  const top = Math.max(inner.top, frame.top);
  const bottom = Math.min(inner.bottom, frame.bottom);
  return bottom - top > 0 ? { top, bottom, height: bottom - top } : null;
}

/** 机制的三个开关 + 老做法那一个,从真的 keyboard.css 里读。 */
interface Knobs {
  /** 键盘起来时整页内容盒的下边界收到键盘上沿。 */
  pad: boolean;
  /** 内容区自己滚。 */
  scroll: boolean;
  /** 内容区里球那一栏按内容高(不被压扁)。 */
  freeze: boolean;
  /** 老做法:把底部那一条抬上去(排版还占着原地)。 */
  lift: boolean;
}
function knobsFromCss(css: string): Knobs {
  return {
    pad: /html\[data-ba-kb="up"\] \.ba-scene:not\(\[data-call="true"\]\)\s*\{[^}]*padding-bottom:\s*var\(--ba-kb-shift/.test(css),
    scroll: /html\[data-ba-kb="up"\][^{]*\[data-ba-kb-fit\]\s*\{[^}]*overflow-y:\s*auto/.test(css),
    freeze: /\[data-ba-kb-fit\] > \.ba-scene__stage\s*\{[^}]*flex:\s*0 0 auto/.test(css),
    lift: /\.ba-scene__dock[^{]*\{[^}]*top:\s*calc\(-1 \* var\(--ba-kb-shift/.test(css),
  };
}
const NOW = knobsFromCss(KB);
/** 0.3.2 那一版的开关(维护者撞见重叠的那一版)。 */
const THEN: Knobs = { pad: false, scroll: false, freeze: false, lift: true };

/**
 * 小排版器:按 `.ba-scene` 的孩子从上往下摆。
 * `up` = 键盘起来了;`dock` = 底部那一条有多高(打一长段会长高);`scrollTop` = 内容区滚到哪。
 */
function layout(knobs: Knobs, opts: { up: boolean; dock?: number; scrollTop?: number }) {
  const dock = opts.dock ?? DOCK;
  const scrollTop = opts.scrollTop ?? 0;
  const lift = opts.up ? APP - VISIBLE : 0;
  const shift = Math.max(0, lift - SAFE_BOTTOM);
  // 整页:高度照旧钉在没弹键盘那一档(球不缩的前提);键盘起来时内容盒的下边界收 shift(padding-bottom)。
  const pageBottom = APP - (opts.up && knobs.pad ? shift : 0);
  // 内容区 = flex: 1,拿顶上那排与底部那一条之外剩下的全部。
  const fit = box(TOP, Math.max(0, pageBottom - TOP - dock));
  // 内容区里面:球那一格 + 字幕 + 卡片。球那一格在键盘开着时钉住(--ba-kb-anchor-h);
  // 没钉住(老做法)时它是 flex: 1,跟着内容区的高度走。
  const orbCell = opts.up && knobs.freeze
    ? APP - TOP - CAPTIONS - CARDS - DOCK  // 键盘弹起前量到的那一格,钉住
    : Math.max(0, fit.height - CAPTIONS - CARDS);
  const content = orbCell + CAPTIONS + CARDS;
  const scrolled = opts.up && knobs.scroll ? Math.min(scrollTop, Math.max(0, content - fit.height)) : 0;
  /** 内容坐标 → 屏幕坐标。 */
  const at = (top: number, height: number): Box => box(fit.top + top - scrolled, height);
  const orb = at(0, orbCell);
  const captions = at(orbCell, CAPTIONS);
  const cardsTop = orbCell + CAPTIONS;
  const titles = TITLES.map((t) => ({ name: t.name, rect: at(cardsTop + t.top, t.height) }));
  // 底部那一条:排在内容区后面。老做法把它「画」到别处(排版不动),于是它压在内容上。
  const dockTop = fit.bottom - (opts.up && knobs.lift ? shift : 0);
  const dockBox = box(dockTop, dock);
  const input = box(dockTop + INPUT_IN_DOCK.top, INPUT_IN_DOCK.height);
  return {
    shift,
    /** 整页看得见的那一截(html 是 clip 的,键盘那一块下面什么都看不见)。 */
    screen: box(0, opts.up ? VISIBLE : APP),
    fit,
    orb,
    captions,
    titles,
    dock: dockBox,
    input,
    content,
    scrolled,
    /** 球:min(60vw, 46 * --ba-vh),再被自己那一格兜住(stageCards.css 的 max-height: 100%)。 */
    ball: Math.min(Math.min(0.6 * 393, 46 * (APP / 100)), orbCell),
    canScroll: content - fit.height,
  };
}

/** 看得见的那些块(被内容区裁过、也被屏幕裁过)。 */
function visibleTitles(l: ReturnType<typeof layout>) {
  return l.titles
    .map((t) => ({ name: t.name, rect: clip(t.rect, l.fit) }))
    .map((t) => ({ name: t.name, rect: t.rect === null ? null : clip(t.rect, l.screen) }))
    .filter((t): t is { name: string; rect: Box } => t.rect !== null);
}

describe('① 机制三条都在(keyboard.css)', () => {
  it('★整页内容盒收到键盘上沿、内容区自己滚、球那一栏按内容高;不再把输入框抬上去', () => {
    expect(NOW).toEqual({ pad: true, scroll: true, freeze: true, lift: false });
  });

  it('★横屏那一段也在:两栏贴上沿、按内容高,滚的还是内容区那一个框', () => {
    expect(KB).toMatch(/@media \(orientation: landscape\)\s*\{[\s\S]*?\[data-ba-kb-fit\] > \*\s*\{[^}]*align-self:\s*flex-start/);
    expect(KB).toMatch(/\[data-ba-kb-fit\] > \.ba-cards\s*\{[^}]*height:\s*auto/);
  });
});

describe('② 小米 10S 那一档数:键盘弹起后谁都不压谁', () => {
  it('★看得见的卡片标题,一块都没被输入框(以及它那一条)压住', () => {
    const l = layout(NOW, { up: true });
    expect(l.shift).toBe(361);
    for (const t of visibleTitles(l)) {
      expect(overlap(t.rect, l.input), `${t.name} 与打字框`).toBeLessThanOrEqual(0);
      expect(overlap(t.rect, l.dock), `${t.name} 与底部那一条`).toBeLessThanOrEqual(0);
    }
    // 内容区的下沿正好落在底部那一条的上沿:挨着,不相交。
    expect(l.fit.bottom).toBe(l.dock.top);
    expect(overlap(l.fit, l.dock)).toBeLessThanOrEqual(0);
  });

  it('★输入框整条在看得见的那 490px 里,底边照旧离键盘 14px', () => {
    const l = layout(NOW, { up: true });
    expect(l.dock.bottom - DOCK_PAD_BOTTOM).toBe(VISIBLE - DOCK_PAD_BOTTOM);
    expect(l.input.bottom).toBeLessThan(VISIBLE);
    expect(clip(l.input, l.screen)).toEqual(l.input);
  });

  it('★球的尺寸一个像素没变(那一格钉住、--ba-vh 钉住);字幕照旧整块看得见', () => {
    const before = layout(NOW, { up: false });
    const after = layout(NOW, { up: true });
    expect(after.ball).toBe(before.ball);
    expect(after.orb.height).toBe(before.orb.height);
    expect(after.orb.top).toBe(before.orb.top);
    expect(clip(after.captions, after.fit)).toEqual(after.captions);
  });

  it('★卡片区没被盖住,是被裁在内容区外面 —— 一划就能看(内容区能滚 361px)', () => {
    const l = layout(NOW, { up: true });
    expect(l.canScroll).toBe(361);
    const doing = l.titles[0]!;
    // 用真代码里那个函数算「把正在办滚进可视区」要滚到哪。
    const to = kbScrollInto({ top: l.fit.top, height: l.fit.height, scrollTop: 0 }, { top: doing.rect.top, height: doing.rect.height });
    const rolled = layout(NOW, { up: true, scrollTop: to });
    const shown = visibleTitles(rolled).map((t) => t.name);
    expect(shown).toContain('正在办');
    for (const t of visibleTitles(rolled)) {
      expect(overlap(t.rect, rolled.input), `${t.name} 与打字框`).toBeLessThanOrEqual(0);
    }
  });
});

describe('③ 反过来:0.3.2 的老做法必须在这套量法下重现维护者看到的重叠', () => {
  it('★老做法:输入框抬到 379–428,「正在办」标题还在 355–390 —— 相交(与真机上量到的 376–425 对得上)', () => {
    const l = layout(THEN, { up: true });
    const before = layout(THEN, { up: false });
    expect(before.input.top).toBe(737);  // 真机:737–786(排版对齐真机的那一步)
    expect(l.input.top).toBe(376);       // 真机:376–425
    const doing = l.titles[0]!;
    expect(doing.rect.top).toBe(355);    // 真机:355–390
    expect(doing.rect.height).toBe(35);
    expect(overlap(doing.rect, l.input)).toBeGreaterThan(0);
  });

  it('★老做法下这份守门是红的(说明它抓得住)', () => {
    const l = layout(THEN, { up: true });
    const bad = visibleTitles(l).filter((t) => overlap(t.rect, l.dock) > 0);
    expect(bad.map((t) => t.name)).toContain('正在办');
  });
});

describe('④ 四种情况:弹起、收起、输入框长高、横竖屏切换', () => {
  it('★输入框长高(打一长段,那一条 124 → 220):内容区继续让,照样不重叠', () => {
    const l = layout(NOW, { up: true, dock: 220 });
    expect(l.fit.height).toBe(VISIBLE - TOP - 220);
    expect(l.fit.bottom).toBe(l.dock.top);
    for (const t of visibleTitles(l)) expect(overlap(t.rect, l.dock), t.name).toBeLessThanOrEqual(0);
    expect(l.input.bottom).toBeLessThan(VISIBLE);
  });

  it('★收起键盘:排版回到没弹键盘时一模一样(内容区整高、不滚、卡片全在)', () => {
    const l = layout(NOW, { up: false });
    expect(l.fit).toEqual(box(TOP, APP - TOP - DOCK));
    expect(l.canScroll).toBe(0);
    expect(visibleTitles(l).map((t) => t.name)).toEqual(TITLES.map((t) => t.name));
    expect(l.input.top).toBe(737);
    expect(l.dock.bottom).toBe(APP);
  });

  it('★横竖屏切换:宽度变了就整个按新视口重算(不当成键盘,见 keyboardModel.kbView)', async () => {
    const { kbStart, kbView, kbFrame } = await import('../src/viewport/keyboardModel');
    let s = kbStart({ width: 393, height: 851, visible: 851 });
    s = { ...s, typing: true };
    // 先弹键盘:布局钉在 851。
    s = kbView(s, { width: 393, height: 490, visible: 490 });
    expect(kbFrame(s, { holding: true, safeBottom: 0 })).toMatchObject({ mode: 'up', appHeight: 851, shift: 361 });
    // 转横屏(键盘还开着):宽度变了 → 按新视口重算,shift 归零,下一次视口变矮才重新算键盘。
    s = kbView(s, { width: 851, height: 393, visible: 393 });
    expect(kbFrame(s, { holding: true, safeBottom: 0 })).toMatchObject({ mode: 'hold', appHeight: 393, shift: 0 });
    s = kbView(s, { width: 851, height: 190, visible: 190 });
    expect(kbFrame(s, { holding: true, safeBottom: 0 })).toMatchObject({ mode: 'up', appHeight: 393, shift: 203 });
  });
});

describe('⑤ kbScrollInto:把当前在看的那一块滚进可视区,能不动就不动', () => {
  const frame = { top: 50, height: 300, scrollTop: 0 };
  it('整块已经看得见 → 不动', () => {
    expect(kbScrollInto(frame, { top: 60, height: 100 })).toBe(0);
  });
  it('在框下面 → 下沿贴到框的下沿', () => {
    expect(kbScrollInto(frame, { top: 400, height: 100 })).toBe(150);
  });
  it('在框上面(滚过头了)→ 上沿对齐', () => {
    expect(kbScrollInto({ ...frame, scrollTop: 200 }, { top: -20, height: 60 })).toBe(130);
  });
  it('比框还高 → 从它的上沿看起', () => {
    expect(kbScrollInto(frame, { top: 120, height: 500 })).toBe(70);
  });
  it('框还没排出来(高度 0,jsdom / 藏起来的页)→ 不动', () => {
    expect(kbScrollInto({ top: 0, height: 0, scrollTop: 7 }, { top: 0, height: 10 })).toBe(7);
  });
});

// ── 真 StagePage 上的结构不变式 ────────────────────────────────────────────
function memory(): KeyValueStore {
  const data = new Map<string, string>();
  return { async get(k) { return data.get(k) ?? null; }, async set(k, val) { data.set(k, val); }, async remove(k) { data.delete(k); } };
}
const pairing = { token: 't', host: 'h', port: 8791, deviceId: 'd' };
const fetchImpl = (async () => new Response(JSON.stringify({ error: '没配' }), { status: 503 })) as typeof fetch;
function staticFeed(): StateFeed {
  const snapshot: FeedSnapshot = { state: emptyState(), connected: true, error: undefined };
  return { get: () => snapshot, subscribe: () => () => {}, async refresh() {}, stop() {} };
}
function stageSession(): Session {
  const client = createApiClient({ pairing, fetchImpl, onUnauthorized: () => {} });
  const ready = async () => ({ configured: true, checked: true });
  return {
    pairing,
    client: fakeRouted(client, 'direct'),
    direct: client,
    feed: staticFeed(),
    voice: createVoiceApi(client),
    call: { ...createCallApi(client), status: ready, channelStatus: ready },
    channel: fakeChannel({}),
    appearance: createAppearanceFeed(client),
    settings: createSettingsStore(memory()),
    unpair: async () => {},
  };
}
const avatar: AvatarState = { status: 'placeholder', note: NO_AVATAR_TEXT, avatars: [] };
const settings = { ...DEFAULT_SETTINGS, voiceEnabled: true, onboarding: 'done' as const };
const html = document.documentElement;
let dispose: (() => void) | null = null;

function setViewport(width: number, height: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
}
/** 小米那一档:851 → 490,插件也报一声(安卓上两样都会来)。 */
function keyboard(open: boolean): void {
  const ev = new Event(open ? 'keyboardWillShow' : 'keyboardWillHide') as Event & { keyboardHeight?: number };
  if (open) ev.keyboardHeight = APP - VISIBLE;
  act(() => {
    window.dispatchEvent(ev);
    setViewport(393, open ? VISIBLE : APP);
    window.dispatchEvent(new Event('resize'));
  });
}

beforeEach(() => {
  setViewport(393, APP);
  dispose = installKeyboardViewport(window);
});
afterEach(() => {
  dispose?.();
  dispose = null;
  try { sessionStorage.clear(); } catch { /* jsdom 没有就算了 */ }
});

describe('⑥ 真首页上的结构不变式:重叠在排版上就不可能', () => {
  it('★输入框是内容区的兄弟、排在它后面;卡片在内容区里面', async () => {
    render(
      <SettingsContext.Provider value={{ settings, update: async () => {} }}>
        <SessionContext.Provider value={stageSession()}>
          <AvatarContext.Provider value={avatar}><StagePage /></AvatarContext.Provider>
        </SessionContext.Provider>
      </SettingsContext.Provider>,
    );
    await act(async () => {});
    const scene = document.querySelector('.ba-scene')!;
    const fit = scene.querySelector<HTMLElement>('[data-ba-kb-fit]')!;
    const dock = scene.querySelector<HTMLElement>('.ba-scene__dock')!;
    const input = screen.getByLabelText('打字说给事务官');
    // 内容区就是球 + 字幕 + 卡片那一整块。
    expect(fit.classList.contains('ba-scene__body')).toBe(true);
    expect(fit.querySelector('.ba-scene__orb[data-ba-kb-anchor]')).not.toBeNull();
    // 2026-10-03 傍晚(方案 B,维护者看过示意图):主列上只剩两张卡并排,另三张是球下那一排里的图标。
    const titles = [...fit.querySelectorAll('.ba-cards__title')].map((el) => el.textContent);
    expect(titles).toEqual(['正在办', '等你确认']);
    // 那一排也在内容区里(球那一栏最后一格),于是弹键盘时它跟着内容区滚,不参与那套高度计算。
    expect(fit.querySelector('.ba-scene__stage > .ba-rail')).not.toBeNull();
    // 输入框在内容区外面、是它的下一个兄弟:谁都不脱离文档流,就不可能重叠。
    expect(fit.contains(input)).toBe(false);
    expect(dock.contains(input)).toBe(true);
    expect(dock.parentElement).toBe(fit.parentElement);
    expect(fit.nextElementSibling).toBe(dock);

    // 弹键盘:布局照旧按 851 排(球不缩),收的是 shift = 361。
    act(() => { input.focus(); });
    keyboard(true);
    expect(html.getAttribute('data-ba-kb')).toBe('up');
    expect(html.style.getPropertyValue('--ba-app-h')).toBe(`${APP}px`);
    expect(html.style.getPropertyValue('--ba-kb-shift')).toBe(`${APP - VISIBLE}px`);
    // 键盘开着期间内容区照旧带着那些卡片(没有谁被挪出去、藏起来)。
    expect([...fit.querySelectorAll('.ba-cards__title')].length).toBe(titles.length);
    keyboard(false);
    act(() => { input.blur(); });
    expect(html.hasAttribute('data-ba-kb')).toBe(false);
  });
});

describe('⑦ 内容区:当前在看的那一块滚进可视区,收起键盘回到顶上', () => {
  /** 一页首页的骨架(jsdom 不排版,矩形自己钉)。 */
  function page() {
    document.body.innerHTML = `
      <div class="ba-scene" data-ba-kb-page="stage">
        <div class="ba-scene__body" data-ba-kb-fit="stage">
          <div class="ba-scene__stage">
            <div class="ba-scene__orb" data-ba-kb-anchor="orb"><div class="ball"></div></div>
            <div class="caps" data-ba-kb-into="caption"></div>
          </div>
          <div class="ba-cards"></div>
        </div>
        <div class="ba-scene__dock"><textarea aria-label="打字说给事务官"></textarea></div>
      </div>
    `;
    const fit = document.querySelector<HTMLElement>('[data-ba-kb-fit]')!;
    const rect = (el: Element, top: number, height: number): void => {
      el.getBoundingClientRect = () => ({ x: 0, y: top, top, left: 0, right: 393, bottom: top + height, width: 393, height, toJSON() { return {}; } }) as DOMRect;
    };
    rect(document.querySelector('.ba-scene__orb')!, TOP, 197);
    rect(document.querySelector('.ball')!, TOP, 197);
    // 键盘开着时内容区只剩 316 高(490 − 50 − 124),字幕那一格落在 344–444 → 得往上滚 78。
    rect(fit, TOP, 316);
    Object.defineProperty(fit, 'clientHeight', { configurable: true, value: 316 });
    rect(document.querySelector('.caps')!, 344, 100);
    return { fit, input: document.querySelector<HTMLTextAreaElement>('textarea')! };
  }

  it('★字幕在时把它滚进可视区;收起键盘滚回顶上', () => {
    const { fit, input } = page();
    act(() => { input.focus(); });
    expect(fit.scrollTop).toBe(0);
    keyboard(true);
    expect(html.getAttribute('data-ba-kb')).toBe('up');
    expect(fit.scrollTop).toBe(kbScrollInto({ top: TOP, height: 316, scrollTop: 0 }, { top: 344, height: 100 }));
    expect(fit.scrollTop).toBe(78);
    keyboard(false);
    expect(fit.scrollTop).toBe(0);
  });

  it('★没标「当前在看」的页面:弹键盘时一个像素都不滚', () => {
    const { fit, input } = page();
    fit.querySelector('.caps')!.removeAttribute('data-ba-kb-into');
    act(() => { input.focus(); });
    keyboard(true);
    expect(fit.scrollTop).toBe(0);
  });
});
