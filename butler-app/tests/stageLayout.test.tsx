/**
 * 舞台页的排布(2026-09-21 运营同事白板第三节;2026-09-22 Ben 拍板之后**主战场是竖屏**)。
 *
 * ## 2026-09-22 之后这一份管什么
 *
 * Ben 拍了「横屏就是展示台」:横屏 + 舞台标签换成 `display/DisplayPage.tsx` 那个 iframe
 * (钉在 tests/landscapeDisplay.test.tsx)。于是**舞台页那套「球 + 卡片」现在是竖屏的事**,
 * 这一份里原来用横屏挂 App 的几条都改成了竖屏 —— 断言一条没删,只换了方向。
 *
 * `stage/stageCards.css` 里那两段 `@media (orientation: landscape)` **没删,也不是死代码**:
 * 舞台页在横屏下照样出得来 —— 接起来的那一通、引导那一通、座机页上「打给事务官」,
 * 三条都是整屏的 `<StagePage>`,手机横着拿就走那两段。所以下面「横屏那一套规则在 CSS 里」
 * 那一节照旧钉着(全文见 docs/交接-0922-横屏回到展示台.md 第四节)。
 *
 * 两层分开测的理由没变:
 *
 * 1. **DOM 层**:组件不读屏幕尺寸、不做机型特判 —— 那颗「展开/收起字幕区」在竖屏下也在 DOM 里,
 *    藏它的是 CSS。
 * 2. **CSS 层**:jsdom 不跑布局,所以**按文本钉那几条规则在不在**。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { App } from '../src/App';
import { createTokenStore, type KeyValueStore } from '../src/api/tokenStore';
import { createSettingsStore } from '../src/settings/settingsStore';

vi.mock('@capacitor/app', () => ({
  App: { getLaunchUrl: async () => ({ url: '' }), addListener: async () => ({ remove: async () => {} }) },
}));
vi.mock('capacitor-zeroconf', () => ({ ZeroConf: { watch: async () => { throw new Error('web'); }, unwatch: async () => {}, close: async () => {} } }));

const CSS = readFileSync(resolve(__dirname, '../src/stage/stageCards.css'), 'utf8');

/**
 * 2026-10-03 傍晚(方案 B,主列只剩「正在办」「等你确认」两张):这一份假 /state 里那条事项
 * 挂上了一条**在跑的**会话,于是它落在「正在办」那一张里 —— 下面「卡片里看得见 /state 那条事项」
 * 那一条钉的是同一件事(以前它落在「今天要做」那一张,那张卡现在是球下那一排里的一颗图标)。
 */
const STATE = {
  now: '2026-09-21T10:00:00+08:00',
  stale: false,
  sessions: [{ agent: 'dsh', session_id: 's-1', project: '工作台', status: 'running', title: '写口播稿', elapsed_sec: 60, unread: false, updated_at: '2026-09-21T09:59:00+08:00' }],
  tasks: { tasks: [{ id: 't-1', title: '写口播稿', status: 'doing', direction: 'mine', created_at: 'a', updated_at: 'b', conversation: { agent: 'dsh', session_id: 's-1' } }] },
  butler_inbox: { items: [] },
};

function memory(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, async get(k) { return data.get(k) ?? null; }, async set(k, v) { data.set(k, v); }, async remove(k) { data.delete(k); } };
}

function jsonRes(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** 已经登录、引导做完的一台手机。 */
function stores() {
  const kv = memory();
  kv.data.set('butler.pairing', JSON.stringify({ token: 'T', host: '10.0.0.9', port: 8795, deviceId: 'd1' }));
  const settings = memory();
  settings.data.set('butler.settings', JSON.stringify({ voiceEnabled: true, avatarId: null, onboarding: 'done', stage: 'particles', callProvider: 'livekit' }));
  return { tokenStore: createTokenStore(kv), settingsStore: createSettingsStore(settings) };
}

/** 把 jsdom 的 matchMedia 翻成"此刻是横屏"。**只有这一个开关** —— 组件不读别的东西。 */
function setOrientation(landscape: boolean): void {
  window.matchMedia = ((query: string) => ({
    matches: landscape && query.includes('landscape'),
    media: query,
    onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    dispatchEvent() { return false; },
  })) as unknown as typeof window.matchMedia;
}

async function mountApp() {
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/state')) return jsonRes(200, STATE);
    return jsonRes(503, { error: '没配' });
  });
  render(<App {...stores()} fetchImpl={fetchImpl as unknown as typeof fetch} />);
  await act(async () => {});
  await waitFor(() => expect(document.querySelector('.ba-scene')).toBeTruthy(), { timeout: 3000 });
}

afterEach(() => {
  setOrientation(false);
  try { sessionStorage.clear(); } catch { /* jsdom 没有就算了 */ }
});

describe('舞台页那一份 DOM(2026-09-22 起:竖屏那一支)', () => {
  it('竖屏:球在上,卡片区在球那一栏后面(白板竖版「形象居中、下方卡片」)', async () => {
    setOrientation(false);
    await mountApp();
    const body = document.querySelector('.ba-scene__body');
    expect(body?.children[0]?.classList.contains('ba-scene__stage')).toBe(true);
    expect(body?.querySelector('.ba-scene__stage .ba-scene__orb')).toBeTruthy();
    /*
     * **主列里就两格**:球那一栏在上、卡片区在下。
     *
     * 2026-10-03 上午(卡「手机各家最近会话固定入口」)中间插过一条「各家最近的对话」常驻入口,
     * 当天下午(卡「首页侧边小图标」)连同「未接来电」那一行一起搬成了球那一栏右边那一列小图标
     * —— 维护者原话:「未接来电和各家的最近对话换个地方放,做成小图标放到侧边吧」。
     * 当天傍晚(卡「首页两卡 + 一排图标」,方案 B)那一列并进了**球那一栏里最后一格那一排**
     * (球下、卡片区上面),另三张卡也收成那一排里的图标 —— 所以主列照旧只有这两格。
     *
     * 往这一格里再加东西的卡要连着改这一条,**而且先回头读一遍那条「不许挤球」的规矩**。
     */
    expect([...(body?.children ?? [])].map((one) => one.className.split(' ')[0]))
      .toEqual(['ba-scene__stage', 'ba-cards']);
    // 那一排在球那一栏里,不在主列里。
    expect(document.querySelector('.ba-scene__stage > .ba-rail')).toBeTruthy();
  });

  /**
   * 2026-09-25 起多了整行的「正在办」(卡 feat/first-look-orb-top);
   * 2026-10-03 傍晚(方案 B,维护者看过示意图)主列只剩这两张、**并排各占一半**,
   * 另三张(今天要做 / 最近一次通话 / 资讯)是球下那一排里的图标(tests/homeRail.test.tsx)。
   */
  it('竖屏:主列两块卡并排(正在办 / 等你确认),另三张不在主列里', async () => {
    setOrientation(false);
    await mountApp();
    const cards = [...document.querySelectorAll<HTMLElement>('.ba-cards__card')];
    expect(cards.map((card) => card.dataset.card)).toEqual(['doing', 'confirm']);
    // 并排各一半:两列的网格里谁都不占整行。
    expect(cards.map((card) => card.dataset.wide)).toEqual(['false', 'false']);
    expect(CSS).toMatch(/\.ba-cards \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  });

  it('竖屏照旧有底部那条(通话键 + 输入框)与右上角的记录', async () => {
    setOrientation(false);
    await mountApp();
    expect(document.querySelector('.ba-scene__dock')).toBeTruthy();
    expect(screen.getByRole('button', { name: '记录' })).toBeTruthy();
    // 竖屏这一支**不是** iframe(横屏才是,见 tests/landscapeDisplay.test.tsx)。
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('卡片里看得见 /state 那条事项', async () => {
    setOrientation(false);
    await mountApp();
    // 卡片里那条 + 字幕里那条都可能写着它;这里问的是**卡片里**那一条。
    // 它落在「正在办」那一张(挂着的那条会话在跑),那一行后面还跟着「事务官」那个附注。
    await waitFor(
      () => expect([...document.querySelectorAll('.ba-cards__card[data-card="doing"] .ba-cards__text')].map(n => n.textContent ?? '').join('|')).toContain('写口播稿'),
      { timeout: 3000 },
    );
  });

  it('`data-landscape` 把方向写在壳上(截图与用例照它认方向)', async () => {
    setOrientation(false);
    await mountApp();
    expect(document.querySelector('.ba-shell')?.getAttribute('data-landscape')).toBe('false');
  });
});

/**
 * 这一节钉的是 `stage/stageCards.css` 里那两段媒体查询**还在**。
 *
 * 2026-09-22 之后它们管的不再是「横屏首页」,而是**横着拿手机接电话那一屏**
 * (接起来的那一通 / 引导那一通 / 座机页上「打给事务官」——三条都是整屏 `<StagePage>`)。
 * 删掉它们,那一屏在 390px 高里会把底下那条顶出屏幕,正是 09-21 量出来的老毛病。
 */
describe('横屏那一套规则在 CSS 里(现在服务的是横着接电话那一屏)', () => {
  it('`@media (orientation: landscape)` 那一段在,而且身子改成横排(球在左、卡片在右)', () => {
    const at = CSS.indexOf('@media (orientation: landscape)');
    expect(at).toBeGreaterThan(-1);
    const block = CSS.slice(at, CSS.indexOf('}\n', CSS.indexOf('.ba-cards {', at)));
    expect(block).toContain('.ba-scene__body { flex-direction: row');
    expect(block).toContain('.ba-scene__stage { flex: 0 0 42%');
  });

  it('球按**左栏**的宽算,不按整屏宽 —— 按 60vw 算会被左栏裁掉一半', () => {
    expect(CSS).toContain('.ba-scene .ba-scene__orb > * { height: min(36vw, 52vh); }');
  });

  it('球两边都有 max-* 兜着 + aspect-ratio 保圆 —— 格子比它矮时不许切掉一截', () => {
    expect(CSS).toMatch(/\.ba-scene \.ba-scene__orb > \* \{[^}]*aspect-ratio: 1 \/ 1[^}]*max-height: 100%/s);
  });

  it('横屏下字幕自己滚,不把底部那条顶出屏幕', () => {
    expect(CSS).toMatch(/\.ba-scene__captions \{[^}]*max-height: 32%[^}]*overflow-y: auto/);
  });

  it('卡片里每一行**一行截断**,不换行把别的卡片挤出屏幕', () => {
    expect(CSS).toMatch(/\.ba-cards__text \{[^}]*white-space: nowrap/);
  });

  it('很矮的横屏(≤420px 高,2400×1080 与 1920×1080 都落这一档)另有一档', () => {
    expect(CSS).toContain('@media (orientation: landscape) and (max-height: 420px)');
  });
});

/**
 * 横屏收尾那两条(2026-09-22 上午,交接-0921 第五节里剩下的 ⑤ 与 ⑥)。
 *
 * ⑤ 球只有 101–153px → 字幕区改成**可折叠**(默认折叠成一行),球随之放大到至少 220px;
 * ⑥ 「今日要做」一次只摆得下 2 行 → 卡片区**可纵向滚**,那一格列 4 行 + 「还有 N 件」。
 *
 * 2026-09-22 下午 Ben 拍了「横屏就是展示台」之后,这两条的**观感在首页上看不到了**
 * (首页横屏是展示台 iframe)。留着的理由两条,都写在这儿免得下一个人当成绕回去了:
 *   · DOM 那几条本来就是竖屏也在的(那颗按钮永远在 DOM 里,藏它的是 CSS)——
 *     所以下面几条挂 App 的改成**竖屏**挂,断言一个字没动;
 *   · CSS 那几条是横着接电话那一屏的排布,见上一节的段头。
 *
 * 同这一份里别处:**DOM 那一层用例断言、CSS 那一层按文本钉规则在不在**(jsdom 不跑布局)。
 */
describe('横屏收尾:字幕可折叠、球放大、卡片区能滚', () => {
  it('★字幕区默认折叠成一行,点一下展开、再点收回(组件不读屏幕尺寸,竖屏下 CSS 把按钮藏掉)', async () => {
    setOrientation(false);
    await mountApp();
    const captions = document.querySelector('.ba-scene__captions');
    expect(captions?.getAttribute('data-open')).toBe('false');
    expect(document.querySelector('.ba-scene__body')?.getAttribute('data-captions')).toBe('collapsed');

    const toggle = screen.getByRole('button', { name: '展开字幕区' });
    await act(async () => { toggle.click(); });
    expect(document.querySelector('.ba-scene__captions')?.getAttribute('data-open')).toBe('true');
    expect(document.querySelector('.ba-scene__body')?.getAttribute('data-captions')).toBe('open');

    await act(async () => { screen.getByRole('button', { name: '收起字幕区' }).click(); });
    expect(document.querySelector('.ba-scene__captions')?.getAttribute('data-open')).toBe('false');
  });

  it('那颗按钮在竖屏下也在 DOM 里(藏它的是 CSS,组件不读屏幕尺寸)', async () => {
    setOrientation(false);
    await mountApp();
    expect(screen.getByRole('button', { name: '展开字幕区' })).toBeTruthy();
    expect(CSS).toContain('.ba-scene__capstoggle { display: none; }');
  });

  it('★折叠着的时候球至少 220px(卡上那条数):**格子自己定高**,球填满它', () => {
    // 让球撑出格子会压到字幕(第一版实测就是球盖住了字幕上半行),所以定高的是那一格。
    expect(CSS).toMatch(/\.ba-scene__body\[data-captions="collapsed"\] \.ba-scene__orb \{[^}]*height: max\(220px/s);
    expect(CSS).toMatch(/\.ba-scene__body\[data-captions="collapsed"\] \.ba-scene__orb > \* \{[^}]*height: 100%/s);
  });

  it('折叠那一档里每一句一行之内截断(折的是高度,不是把字幕删掉)', () => {
    expect(CSS).toMatch(/\.ba-scene__captions\[data-open="false"\][^{]*\{[^}]*height: 1\.6em/);
    expect(CSS).toMatch(/\.ba-scene__captions\[data-open="false"\] \.ba-scene__caption \{[^}]*white-space: nowrap/);
  });

  it('★横屏下卡片区可以纵向滚(上一版是固定两行两列、整块不滚)', () => {
    const at = CSS.indexOf('@media (orientation: landscape)');
    const block = CSS.slice(at);
    expect(block).toMatch(/\.ba-cards \{[^}]*overflow-y: auto/);
    expect(block).toMatch(/\.ba-cards \{[^}]*align-content: start/);
  });

  /**
   * 2026-10-03 傍晚(方案 B):「今日要做」那张卡收成了球下那一排里的一颗图标,
   * 这一条改钉**「正在办」**那一张(它照旧在主列上,行数、「还有 N 件」那套规矩一个字没改)。
   * 那颗图标上的角标与那一页的那一条在 tests/homeRail.test.tsx。
   */
  it('★主列那两张列 rows 行 + 「还有 N 件」(数与清单出自同一份)', async () => {
    setOrientation(false);
    await mountApp();
    await waitFor(
      () => expect(document.querySelector('.ba-cards__card[data-card="doing"]')).toBeTruthy(),
      { timeout: 3000 },
    );
    // 这一份假 /state 里只有一条,所以不该出现「还有 N 件」——**一件不剩就整句不画**。
    const doing = document.querySelector('.ba-cards__card[data-card="doing"]');
    expect(doing?.querySelector('.ba-cards__more')).toBeNull();
  });
});
