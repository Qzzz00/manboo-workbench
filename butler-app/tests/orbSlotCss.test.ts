/**
 * 球那个格子必须是**定位元素**(2026-09-22,Ben 真机:
 * 「一打开,接听、静音下面那 3 个按钮都不能按」)。
 *
 * ## 那三颗键为什么按不动
 *
 * `styles.css` 里 `.ba-orb` 是 `position: absolute; inset: 0` —— 它铺满的是
 * **最近的那个定位祖先**。来电页那个格子 `.ba-incoming__orb` 当时没有 `position`,
 * 于是球去铺了 `.ba-incoming`(`position: fixed`)整块屏:
 * 一层看不见的、盖住整屏的 `<div>` 压在三颗键上面(绝对定位元素画在普通流内容之上,
 * 点击命中也跟着画的顺序走)。三颗键一颗都按不动 —— 连纯本地的那颗「静音」也按不动,
 * 那正是「三颗全不灵」这个症状的由来。
 *
 * 座机页 `.ba-desk__orb` 从第一天起就写对了(deskPhone.css 里还留着为什么),
 * 来电页与话筒页这两处是后加的,漏了。
 * (话筒页 2026-09-28 并进了通话页 —— 球那一格从此就是舞台页的 `.ba-scene__orb`。)
 *
 * ## 为什么用读 CSS 文本的办法钉
 *
 * vitest 跑在 jsdom 里且**没有开 `css: true`** —— 样式表根本没被应用,
 * `getComputedStyle` 问不出 `position`,渲染出来的元素也没有尺寸,
 * 「谁盖住谁」在 jsdom 里演不出来。所以这一份钉的是**源文件里的那条约定**:
 * 凡是装球的格子,必须自己是定位元素。开 `css: true` 不在这张卡里做 ——
 * 记忆里那条「jsdom 漏样式表→测试假红」说的就是这一层不能随便动。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..');
const SRC = resolve(ROOT, 'src');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = resolve(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const FILES = walk(SRC);
const CSS = FILES.filter((f) => f.endsWith('.css'));
const TSX = FILES.filter((f) => f.endsWith('.tsx'));
/**
 * **注释先剥掉**。这一份用正则读 CSS,而注释里到处写着 `.ba-incoming__orb` 这样的类名;
 * 不剥的话「这个类名后面跟着的那对花括号」会认到下一条真规则上去 ——
 * 写这一份时就被自己的注释骗出过一次假绿(去掉 `position: relative` 它照样过)。
 */
const ALL_CSS = CSS.map((f) => readFileSync(f, 'utf8')).join('\n').replace(/\/\*[\s\S]*?\*\//g, ' ');

/**
 * 源码里「装球的那个格子」的类名。认法:一段 `className="…__orb…"` 的 `<div>`,
 * 里面直接写着 `<Orb` 或 `<ParticleStage`。
 * **不写死一张名单** —— 哪天又多一个球格子,这条用例自己就会看见它。
 */
function orbSlotClasses(): string[] {
  const found = new Set<string>();
  for (const file of TSX) {
    const text = readFileSync(file, 'utf8');
    const re = /className="([^"]*\b(ba-[a-z-]+__orb)\b[^"]*)"([\s\S]{0,1500}?)(<Orb\b|<ParticleStage\b|<\/div>)/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      if (match[4] === '</div>') continue;
      found.add(match[2]!);
    }
  }
  return [...found].sort();
}

/** 只认选择器正好是 `.ba-orb` 的那一条(`.ba-desk .ba-desk__orb .ba-orb {…}` 之类不算)。 */
const ORB_RULE = /(?:^|\n)\s*\.ba-orb\s*\{([^}]*)\}/;

/** 这个类名有没有一条规则给它定了位(`position: relative|absolute|fixed|sticky`)。 */
function isPositioned(className: string): boolean {
  const re = new RegExp(`\\.${className}\\b[^{}]*\\{([^}]*)\\}`, 'g');
  let match: RegExpExecArray | null;
  while ((match = re.exec(ALL_CSS)) !== null) {
    if (/position:\s*(relative|absolute|fixed|sticky)/.test(match[1]!)) return true;
  }
  return false;
}

describe('球那个格子', () => {
  it('`.ba-orb` 确实是绝对定位铺满的 —— 下面那条约定的前提', () => {
    const rule = ORB_RULE.exec(ALL_CSS);
    expect(rule).toBeTruthy();
    expect(rule![1]).toMatch(/position:\s*absolute/);
    expect(rule![1]).toMatch(/inset:\s*0/);
  });

  it('★**每一个装球的格子都是定位元素**(不然球会铺满整块屏,把底下的键全吃掉)', () => {
    const slots = orbSlotClasses();
    // 至少认出来电页、通话页这两个 —— 认不出来说明上面那个正则该修了。
    // (座机页 2026-09-25 整个去掉了;话筒页 2026-09-28 并进了通话页,球那一格就是 `.ba-scene__orb`。)
    expect(slots).toEqual(expect.arrayContaining(['ba-scene__orb', 'ba-incoming__orb']));
    expect(slots.filter((one) => !isPositioned(one))).toEqual([]);
  });

  it('★球不吃点击(它从头到尾是装饰,里面两层都 aria-hidden)', () => {
    const rule = ORB_RULE.exec(ALL_CSS);
    expect(rule![1]).toMatch(/pointer-events:\s*none/);
  });

  /**
   * 2026-10-03(卡「首页侧边小图标」):**粒子球那一支原来漏了这一条**。
   *
   * `.ba-orb` 是粒子球起不来时退回来的那颗,从第一天就写着 `pointer-events: none`(上面那条);
   * 真正天天在画的 `.ba-particles` 却没写 —— 于是它哪天漏出球那一格一点,底下的东西就点不动。
   * 10-03 真就发生了:形象区漏出去一个屏宽那么大的方块,首页「未接来电」「各家最近的对话」
   * 两行看得见、点不到(维护者:「而且现在的我还点击不到」;根因与量数在 tests/homeRail.test.tsx
   * 的文件头与 docs/交接-1003-手机首页侧边小图标.md)。
   * 里面没有一样东西是能点的:canvas 是 `aria-hidden`,旁边一个读屏用的隐藏 span 和一句说明。
   */
  it('★**粒子球也不吃点击** —— 两支球同一条纪律', () => {
    const rule = /(?:^|\n)\s*\.ba-particles\s*\{([^}]*)\}/.exec(ALL_CSS);
    expect(rule).toBeTruthy();
    expect(rule![1]).toMatch(/pointer-events:\s*none/);
  });

  it('来电页那三颗键在球的**后面**、而且不是球的孩子(DOM 顺序也别再出岔子)', () => {
    const page = readFileSync(resolve(SRC, 'call/IncomingCallPage.tsx'), 'utf8');
    const orbAt = page.indexOf('ba-incoming__orb');
    const keysAt = page.indexOf('ba-incoming__keys');
    expect(orbAt).toBeGreaterThan(-1);
    expect(keysAt).toBeGreaterThan(orbAt);
    // 球那一格里只有球:三颗键不在它里面。
    expect(page.slice(orbAt, keysAt)).not.toContain('ba-incoming__key');
  });
});
