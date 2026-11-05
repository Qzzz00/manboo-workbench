/**
 * 未接来电那张卡**不许抢舞台的高度**(2026-09-22,Ben 真机 0.2.56/0.2.57:「横屏展示台没了」)。
 *
 * ## 病灶
 *
 * `App.tsx` 里舞台那一格是一个 `.ba-pane ba-pane--stage`(`.ba-pane { height: 100% }`),
 * 里面先 `<MissedCalls>`(在文档流里)、后 `<StagePage>`(`.ba-scene` 自己也是 `height: 100%`)。
 *
 * 两个 100% 叠在同一格里:未接卡吃掉多少,舞台就被顶出屏幕多少。
 * 横屏总共只有约 393px 高,一张卡(标题 + 一行 + `--ba-safe-top`)就够把底下那条
 * (通话键 + 输入框)整条顶没 —— 那正是 Ben 说的「展示台没了」。
 * 0.2.55 那张卡能按「知道了」藏掉,0.2.56 起它常驻,于是这件事才显出来。
 *
 * ## 为什么钉的是「结构 + CSS 文本」,不是量高度
 *
 * vitest 跑在 jsdom 里且**没有开 `css: true`**(样式表根本没被应用,见
 * tests/orbSlotCss.test.ts 头上那一段,以及记忆里「jsdom 漏样式表→测试假红」那一条)——
 * `.ba-scene__body` 在 jsdom 里高度恒为 0,量不出「被挤没了」。
 * 所以这一份钉两层:
 *
 * 1. **结构**:横屏下未接卡与 `.ba-scene` 确实是 `.ba-pane--stage` 的两个直接孩子
 *    —— 下面那条 CSS 选择器 `.ba-pane--stage > .ba-missed` 能选中的前提;
 * 2. **CSS 文本**:横屏那一段里它是 `position: absolute`(不进文档流)、封顶半屏、自己滚;
 *    竖屏封顶 40vh 且舞台 `flex: 1 1 auto` 拿剩下的全部。
 *
 * **代价如实写着**:这保证的是「那几条规则在」,不是「真机上舞台真的满高」。
 * 这张卡没有真机验证(手机归统筹用)。
 *
 * 读 CSS 前先把注释整个剥掉 —— 注释里到处写着这些类名,不剥会被自己的注释骗出假绿
 * (orbSlotCss 那一份的教训)。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, act, waitFor, fireEvent } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { App } from '../src/App';
import { MissedCalls, MISSED_CLEAR_LABEL, MISSED_CLOSE_LABEL, MISSED_OPEN_LABEL } from '../src/call/MissedCalls';
import { parseCallLog } from '../src/call/incomingModel';
import { createTokenStore, type KeyValueStore } from '../src/api/tokenStore';
import { createSettingsStore } from '../src/settings/settingsStore';

vi.mock('@capacitor/app', () => ({
  App: { getLaunchUrl: async () => ({ url: '' }), addListener: async () => ({ remove: async () => {} }) },
}));
vi.mock('capacitor-zeroconf', () => ({ ZeroConf: { watch: async () => { throw new Error('web'); }, unwatch: async () => {}, close: async () => {} } }));

const CSS = readFileSync(resolve(__dirname, '../src/styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ');

/**
 * `@media (… orientation: landscape …)` 那几段的**花括号里面**。
 * 按花括号配对切,不按 `}\n` 猜 —— 媒体查询里套着规则,数错一层就把半段规则漏掉。
 */
function landscapeBlocks(css: string): string[] {
  const out: string[] = [];
  const head = /@media[^{]*orientation:\s*landscape[^{]*\{/g;
  while (head.exec(css) !== null) {
    let depth = 1;
    let at = head.lastIndex;
    while (at < css.length && depth > 0) {
      if (css[at] === '{') depth += 1;
      else if (css[at] === '}') depth -= 1;
      at += 1;
    }
    out.push(css.slice(head.lastIndex, at - 1));
  }
  return out;
}

const LANDSCAPE = landscapeBlocks(CSS).join('\n');

/** 某个选择器那一条规则的花括号里面(取第一条)。 */
function ruleOf(css: string, selector: string): string {
  const at = css.indexOf(`${selector} {`);
  return at < 0 ? '' : css.slice(at + selector.length + 2, css.indexOf('}', at));
}

const MISSED_LOG = {
  missed: 9,
  config: { enabled: true, done_call: true },
  entries: Array.from({ length: 9 }, (_, i) => ({
    id: `d${i}`, reason: 'done', item_id: 't9', title: '下班例程',
    at: `2026-09-22T09:0${i}:00.000Z`, state: 'missed',
  })),
};

const STATE = {
  now: '2026-09-22T18:00:00+08:00',
  stale: false,
  sessions: [],
  tasks: { tasks: [{ id: 't-1', title: '写口播稿', status: 'doing', direction: 'mine', created_at: 'a', updated_at: 'b' }] },
  butler_inbox: { items: [] },
};

function memory(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, async get(k) { return data.get(k) ?? null; }, async set(k, v) { data.set(k, v); }, async remove(k) { data.delete(k); } };
}

function jsonRes(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** 已经登录、引导做完的一台手机(同 stageLayout.test.tsx)。 */
function stores() {
  const kv = memory();
  kv.data.set('butler.pairing', JSON.stringify({ token: 'T', host: '10.0.0.9', port: 8795, deviceId: 'd1' }));
  const settings = memory();
  settings.data.set('butler.settings', JSON.stringify({ voiceEnabled: true, avatarId: null, onboarding: 'done', stage: 'particles', callProvider: 'livekit' }));
  return { tokenStore: createTokenStore(kv), settingsStore: createSettingsStore(settings) };
}

/** 把 jsdom 的 matchMedia 翻成"此刻是横屏"。**只有这一个开关**(同 stageLayout.test.tsx)。 */
function setOrientation(landscape: boolean): void {
  window.matchMedia = ((query: string) => ({
    matches: landscape && query.includes('landscape'),
    media: query,
    onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    dispatchEvent() { return false; },
  })) as unknown as typeof window.matchMedia;
}

/** 台账里九通未接的那台手机。 */
async function mountApp() {
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/state')) return jsonRes(200, STATE);
    if (url.endsWith('/call/log')) return jsonRes(200, MISSED_LOG);
    return jsonRes(503, { error: '没配' });
  });
  render(<App {...stores()} fetchImpl={fetchImpl as unknown as typeof fetch} />);
  await act(async () => {});
  // 舞台那一格里横屏是展示台、竖屏是舞台页(2026-09-22),所以等的是**那一格**,不是舞台页。
  await waitFor(() => expect(document.querySelector('.ba-pane--stage > .ba-scene, .ba-pane--stage > .ba-display')).toBeTruthy(), { timeout: 3000 });
  /*
   * 台账到了没有:横屏是那条薄横条(`.ba-missed`),竖屏是球那一栏边上那颗小图标的角标
   * (2026-10-03 卡「首页侧边小图标」起竖屏没点开之前压根没有 `.ba-missed`)。
   */
  await waitFor(() => expect(document.querySelector('.ba-missed, .ba-rail__badge')).toBeTruthy(), { timeout: 3000 });
}

afterEach(() => {
  setOrientation(false);
  try { sessionStorage.clear(); } catch { /* jsdom 没有就算了 */ }
});

/**
 * 2026-09-22 下午 Ben 拍了「横屏就是展示台」之后,这一格里横屏那一支从 `<StagePage>`
 * 换成了 `<DisplayPage>`(那个 iframe)。**未接卡那条薄横条照旧压在上面** ——
 * 同一份组件、同一条 `.ba-pane--stage > .ba-missed` 覆盖规则,不为展示台另做一份
 * (这一条 Ben 没说过,是那张卡替他定的,**可推翻**;见 docs/交接-0922-横屏回到展示台.md)。
 * 于是下面横屏那几条问的是 `.ba-display`,竖屏那条照旧问 `.ba-scene`。
 */
describe('未接卡与它下面那一页的结构', () => {
  it('★横屏下未接卡与**展示台**是 `.ba-pane--stage` 的两个直接孩子(覆盖那条选择器的前提)', async () => {
    setOrientation(true);
    await mountApp();
    const kids = [...document.querySelector('.ba-pane--stage')!.children];
    const missed = kids.findIndex(one => one.classList.contains('ba-missed'));
    const display = kids.findIndex(one => one.classList.contains('ba-display'));
    expect(missed).toBeGreaterThan(-1);
    expect(display).toBeGreaterThan(-1);
    // 顺序也钉住:卡在前、页在后。覆盖层要靠 z-index 压过它,正是因为它排在前面。
    expect(missed).toBeLessThan(display);
  });

  it('★横屏下那一页就是展示台那个 iframe,舞台页不在', async () => {
    setOrientation(true);
    await mountApp();
    expect(document.querySelector('.ba-display__frame')).toBeTruthy();
    expect(document.querySelector('.ba-scene')).toBeNull();
  });

  it('★展示台也要压得住:它写死的 z-index 低于未接卡那一条(不然它照 DOM 顺序画在卡上面)', () => {
    const display = /z-index:\s*(\d+)/.exec(ruleOf(CSS, '.ba-display'));
    const missed = /z-index:\s*(\d+)/.exec(ruleOf(LANDSCAPE, '.ba-pane--stage > .ba-missed'));
    expect(display, '.ba-display 要写死一个 z-index').toBeTruthy();
    expect(missed).toBeTruthy();
    expect(Number(display![1])).toBeLessThan(Number(missed![1]));
  });

  /**
   * 2026-09-25 晚(卡 fix/phone-home-card-fit,统筹小米真机):竖屏下未接卡**挪进舞台页、球的下面、卡片上面,收成一行**,
   * 不再是舞台页前面那个兄弟(它在球上面一件一行地铺开,太占地方,长标题还撑宽了整页)。
   *
   * 2026-10-03 下午(卡「首页侧边小图标」,维护者原话:「未接来电和各家的最近对话换个地方放,做成小图标放到侧边吧,
   * 而且现在的我还点击不到」):竖屏下**连那一行也不在主列里了** —— 收起来的样子就是球那一栏右边那颗小图标,
   * 点它才把原来那一块挂上来(`.ba-rail-sheet`,铺开的、回拨 / 清空 / 明细一个字没动)。
   * 横屏那条薄横条(这一份别处钉的那一支)一个字没动。
   */
  it('竖屏下是舞台页;未接收成球那一栏边上那颗小图标,点它才铺开;舞台那三块都在', async () => {
    setOrientation(false);
    await mountApp();
    const kids = [...document.querySelector('.ba-pane--stage')!.children];
    expect(kids.some(one => one.classList.contains('ba-missed'))).toBe(false);
    expect(kids.some(one => one.classList.contains('ba-scene'))).toBe(true);
    // 主列里就两格(球那一栏 / 卡片区):未接那一行不在里面。
    expect([...document.querySelector('.ba-scene__body')!.children].map(one => one.className.split(' ')[0]))
      .toEqual(['ba-scene__stage', 'ba-cards']);
    expect(document.querySelector('.ba-missed')).toBeNull();

    const icon = screen.getByRole('button', { name: /^未接来电/ });
    expect(icon.closest('.ba-scene__stage > .ba-rail')).toBeTruthy();
    await act(async () => { fireEvent.click(icon); });
    const sheet = document.querySelector('.ba-scene__stage > .ba-rail-sheet')!;
    expect(sheet.querySelector('.ba-missed')!.getAttribute('data-compact')).toBe('true');
    expect(document.querySelectorAll('.ba-missed__row').length).toBeGreaterThan(0);

    expect(document.querySelector('.ba-scene__body .ba-scene__stage')).toBeTruthy();
    expect(document.querySelector('.ba-scene__body .ba-cards')).toBeTruthy();
    expect(document.querySelector('.ba-scene__dock')).toBeTruthy();
  });
});

describe('薄横条那颗「展开 / 收起」', () => {
  const log = parseCallLog(MISSED_LOG);

  it('默认没铺下来(`data-open="false"`)——横屏一进来就盖掉半屏正是要修的那个毛病', () => {
    render(<MissedCalls log={log} onCallBack={async () => ({ ok: true })} onClear={async () => ({ ok: true })} />);
    expect(document.querySelector('.ba-missed')!.getAttribute('data-open')).toBe('false');
  });

  it('★点一下铺下来、再点一下收回去', () => {
    render(<MissedCalls log={log} onCallBack={async () => ({ ok: true })} onClear={async () => ({ ok: true })} />);
    fireEvent.click(screen.getByRole('button', { name: MISSED_OPEN_LABEL }));
    expect(document.querySelector('.ba-missed')!.getAttribute('data-open')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: MISSED_CLOSE_LABEL }));
    expect(document.querySelector('.ba-missed')!.getAttribute('data-open')).toBe('false');
  });

  it('那几行**一直在 DOM 里**(折叠是 CSS 的事),「清空」那颗一个字没动', () => {
    render(<MissedCalls log={log} onCallBack={async () => ({ ok: true })} onClear={async () => ({ ok: true })} />);
    expect(document.querySelectorAll('.ba-missed__row')).toHaveLength(1);
    expect(screen.getByRole('button', { name: MISSED_CLEAR_LABEL })).toBeTruthy();
  });
});

describe('横屏:未接卡不进文档流', () => {
  const rule = ruleOf(LANDSCAPE, '.ba-pane--stage > .ba-missed');

  it('★**绝对定位**——不占文档流,于是舞台拿得满那 100%', () => {
    expect(rule).not.toBe('');
    expect(rule).toMatch(/position:\s*absolute/);
  });

  it('★铺下来也最多占半屏,而且自己滚(不是把舞台盖死)', () => {
    expect(rule).toMatch(/max-height:\s*50vh/);
    expect(rule).toMatch(/overflow-y:\s*auto/);
  });

  it('★折叠着的时候那几行不画 —— 薄横条就是标题那一行', () => {
    expect(LANDSCAPE).toMatch(/\.ba-missed\[data-open="false"\]\s+\.ba-missed__list\s*\{[^}]*display:\s*none/);
  });

  it('★**居中定宽**,不盖舞台顶上那两颗 icon(看不见的覆盖层会把底下的键吃掉)', () => {
    expect(rule).toMatch(/left:\s*50%/);
    expect(rule).toMatch(/width:\s*min\(/);
    // 铺满整宽那种写法正是事故本身 —— 两颗 icon 在 .ba-scene__top 的左右两端。
    expect(rule).not.toMatch(/right:\s*0/);
  });

  it('★压得过舞台,又低于记录面板那一层(记录拉开时未接条不该浮在它前面)', () => {
    const z = /z-index:\s*(\d+)/.exec(rule);
    expect(z).toBeTruthy();
    const scrim = /z-index:\s*(\d+)/.exec(ruleOf(CSS, '.ba-scene__scrim'));
    expect(scrim).toBeTruthy();
    expect(Number(z![1])).toBeGreaterThan(0);
    expect(Number(z![1])).toBeLessThan(Number(scrim![1]));
  });

  it('覆盖层的落点是舞台那一格本身(`.ba-pane--stage` 是定位元素)', () => {
    expect(ruleOf(CSS, '.ba-pane--stage')).toMatch(/position:\s*relative/);
  });

  it('那颗「展开 / 收起」竖屏下整个不画,横屏下才画(组件不读屏幕尺寸)', () => {
    expect(ruleOf(CSS, '.ba-missed__bar')).toMatch(/display:\s*none/);
    expect(ruleOf(LANDSCAPE, '.ba-missed__bar')).toMatch(/display:\s*inline-block/);
  });
});

describe('竖屏:未接卡封顶,舞台拿剩下的全部', () => {
  it('★竖屏下这张卡最多 40vh 并且自己滚(九条也顶不掉展示台)', () => {
    const rule = ruleOf(CSS, '.ba-missed');
    // 40vh 写成 `calc(40 * var(--ba-vh, 1vh))`(2026-09-24,弹键盘时粒子球不缩):平时就是 40vh,键盘开着时按没弹键盘那一档算。
    expect(rule).toMatch(/max-height:\s*calc\(40 \* var\(--ba-vh, 1vh\)\)/);
    expect(rule).toMatch(/overflow-y:\s*auto/);
    // 上一张卡钉的那条(顶上按安全区留位)照旧在。
    expect(rule).toContain('--ba-safe-top');
  });

  it('★舞台那一格是 flex 列、舞台 `flex: 1 1 auto` —— 卡吃掉的那一截从剩余空间里扣,不是把舞台顶出屏幕', () => {
    expect(ruleOf(CSS, '.ba-pane--stage:not([hidden])')).toMatch(/display:\s*flex/);
    expect(ruleOf(CSS, '.ba-pane--stage:not([hidden])')).toMatch(/flex-direction:\s*column/);
    const scene = ruleOf(CSS, '.ba-pane--stage > .ba-scene');
    expect(scene).toMatch(/flex:\s*1 1 auto/);
    expect(scene).toMatch(/min-height:\s*0/);
  });

  it('`:not([hidden])` 不能省 —— `display: flex` 会压过 `hidden`,别的标签开着时这一格就藏不住了', () => {
    // 无条件的那条 `.ba-pane--stage { … }` 里不许出现 display。
    expect(ruleOf(CSS, '.ba-pane--stage')).not.toMatch(/display:/);
  });
});
