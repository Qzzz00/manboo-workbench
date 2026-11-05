/**
 * 弹键盘时粒子球不缩(卡 fix/phone-keyboard-orb-stable)—— CSS 那一层的约定。
 *
 * vitest 跑在 jsdom 里、不排版(同 tests/orbSlotCss.test.ts 的理由),所以按文本钉三件事:
 *   1. 球那一格、以及排在它上下会挤它的那几条,**高度不用裸 vh** —— 一律 `var(--ba-vh, 1vh)`:
 *      没弹键盘时它就是 1vh(一个像素不差);键盘开着时 keyboardViewport 把它钉在「没弹键盘时」那一档。
 *   2. keyboard.css:键盘开着时整棵树按 --ba-app-h 排、多出来的由 body 裁掉(不许滚动,滚一下球就跟着上去了);
 *      三页的输入框都贴着键盘上沿(首页底部那一条、引导兜底页的输入行、通话页的字幕 + 打字框)。
 *   3. 不引入蓝色、不加动效(减少动效:抬输入框是一步到位,和系统自己的 adjustResize 一样)。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = resolve(__dirname, '../src');
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, ' ');
const STYLES = strip(readFileSync(resolve(SRC, 'styles.css'), 'utf8'));
const CARDS = strip(readFileSync(resolve(SRC, 'stage/stageCards.css'), 'utf8'));
const KB = strip(readFileSync(resolve(SRC, 'viewport/keyboard.css'), 'utf8'));

/** 媒体查询之外、选择器正好是它的那一条规则的声明块(取第一条)。 */
function topLevelRule(css: string, selector: string): string {
  let depth = 0;
  let start = 0;
  for (let i = 0; i < css.length; i += 1) {
    const ch = css[i];
    if (ch === '{') {
      const head = css.slice(start, i).trim();
      if (depth === 0 && head === selector) return css.slice(i + 1, css.indexOf('}', i));
      depth += 1;
      start = i + 1;
    } else if (ch === '}') {
      depth -= 1;
      start = i + 1;
    } else if (ch === ';' && depth === 0) {
      start = i + 1;
    }
  }
  return '';
}

describe('球那一格(以及会挤它的那几条)不用裸 vh', () => {
  const cases: [string, string, string][] = [
    ['styles.css', '.ba-scene__orb > *', 'width'],
    ['stageCards.css', '.ba-scene .ba-scene__orb > *', 'height'],
    ['styles.css', '.ba-chat', 'grid-template-rows'],
    ['styles.css', '.ba-call__subtitles', 'max-height'],
    // 事务官那句字幕 2026-09-25 夜起截到两行(line-clamp),不再有一个按屏高算的 max-height —— 它挤不动球了。
    ['styles.css', '.ba-missed', 'max-height'],
  ];
  for (const [file, selector, prop] of cases) {
    it(`${file} ${selector} 的 ${prop} 用 var(--ba-vh, 1vh)`, () => {
      const body = topLevelRule(file === 'styles.css' ? STYLES : CARDS, selector);
      expect(body).not.toBe('');
      const decl = new RegExp(`(?:^|;)\\s*${prop}:([^;]*)`).exec(body)?.[1] ?? '';
      expect(decl).toContain('var(--ba-vh, 1vh)');
      expect(decl.replace(/var\(--ba-vh, 1vh\)/g, '')).not.toMatch(/\d(\.\d+)?vh\b/);
    });
  }
});

describe('keyboard.css:键盘开着时按「没弹键盘时」的高度排', () => {
  it('★#root 用 --ba-app-h;html 与 body 裁掉多出来的那截(clip:连程序滚动都滚不了)', () => {
    expect(KB).toMatch(/html\[data-ba-kb\] #root\s*\{[^}]*height:\s*var\(--ba-app-h/);
    expect(KB).toMatch(/html\[data-ba-kb\],\s*html\[data-ba-kb\] > body\s*\{[^}]*overflow:\s*clip/);
  });

  /*
   * 2026-09-25(卡 fix/phone-keyboard-overlap)换了做法:上一版把底部那一条 `top: -shift` 抬到键盘上沿,
   * 排版还占着原地 —— 于是它画在卡片标题身上(维护者 0.3.2:「正在办和呼出键盘的输入框会重叠在一起」)。
   * 现在收的是**整页内容盒的下边界**,内容区(flex: 1)自动让出同样一截、自己滚。
   */
  it('★首页:整页内容盒的下边界收到键盘上沿(padding-bottom: --ba-kb-shift),通话中那一页不走这套', () => {
    expect(KB).toMatch(/html\[data-ba-kb="up"\] \.ba-scene:not\(\[data-call="true"\]\)\s*\{[^}]*padding-bottom:\s*var\(--ba-kb-shift/);
  });

  it('★首页:内容区(data-ba-kb-fit)自己滚,里面球那一栏按内容高(不被压扁)', () => {
    expect(KB).toMatch(/html\[data-ba-kb="up"\][^{]*\[data-ba-kb-fit\]\s*\{[^}]*overflow-y:\s*auto/);
    expect(KB).toMatch(/html\[data-ba-kb="up"\][^{]*\[data-ba-kb-fit\]\s*\{[^}]*overscroll-behavior:\s*contain/);
    expect(KB).toMatch(/\[data-ba-kb-fit\] > \.ba-scene__stage\s*\{[^}]*flex:\s*0 0 auto/);
  });

  it('★不许再把底部那一条抬到内容上面(重叠就是这么来的)', () => {
    expect(KB).not.toMatch(/\.ba-scene__dock[^{]*\{[^}]*top:\s*calc\(-1 \* var\(--ba-kb-shift/);
    // 卡 M(2026-09-25)把「等你批」那几行挪进了「等你确认」那一页,`.pc-approvals` 不再是 .ba-scene 的孩子:死规则一起去掉。
    expect(KB).not.toMatch(/\.pc-approvals/);
  });

  it('★引导打字兜底页:输入行(与它上面那两行说明)抬 --ba-kb-shift,对话流让出同样一截', () => {
    expect(KB).toMatch(/html\[data-ba-kb="up"\] \.ba-onboarding > \.ba-composer[^{]*\{[^}]*top:\s*calc\(-1 \* var\(--ba-kb-shift/);
    expect(KB).toMatch(/html\[data-ba-kb="up"\] \.ba-onboarding > \.ba-chat__thread\s*\{[^}]*max-height:\s*calc\(100% - var\(--ba-kb-shift/);
  });

  it('★球那一格(首页与通话页)在键盘开着时钉在量到的高度:打字期间别的东西长高也挤不动它', () => {
    const rule = /html\[data-ba-kb="up"\] \.ba-scene \.ba-scene__orb\s*\{([^}]*)\}/.exec(KB)?.[1] ?? '';
    expect(rule).toMatch(/min-height:\s*var\(--ba-kb-anchor-h/);
    expect(rule).toMatch(/max-height:\s*var\(--ba-kb-anchor-h/);
  });

  it('★通话页:字幕 + 打字框放进「球底到键盘上沿」那一截,三颗键藏到键盘后面', () => {
    expect(KB).toMatch(/\.ba-scene\[data-call="true"\] \.ba-call__captions\s*\{[^}]*--ba-kb-room/);
    expect(KB).toMatch(/\.ba-scene\[data-call="true"\] \.ba-call__type\s*\{[^}]*position:\s*sticky/);
    expect(KB).toMatch(/\.ba-scene\[data-call="true"\] \.ba-call__dock\s*\{[^}]*visibility:\s*hidden/);
  });

  it('不引入蓝色,底色一律走变量', () => {
    expect(KB).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(KB).not.toMatch(/\bblue\b|rgb\(/i);
  });

  it('不加动效(减少动效那条规矩:没有新的 transition / animation)', () => {
    expect(KB).not.toMatch(/transition|animation/);
  });
});
