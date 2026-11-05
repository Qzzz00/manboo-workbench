/**
 * 首页球下面那一排小图标(2026-10-03 傍晚,卡「首页两卡 + 一排图标」= **方案 B**),
 * 以及它上一版留下的那几条「点不到」的 CSS 修法。
 *
 * ## 维护者 17:5x 看过示意图之后的原话
 *
 * > 只保留正在办和待确认两个是卡片,其他都和前面一样做成 icon 就 OK……
 * > 中间的球球还是要大的,这个事情是要适配 Live2D 的显示空间,省出来的空间 Live2D 也能放大。
 *
 * 于是首页从上到下:球 / Live2D 形象区 → 字幕 → **一排图标** → 两张卡并排各一半 → 输入条。
 * 「和前面一样」= 当天下午那张卡(「首页侧边小图标」)做的那两颗小图标;那一列**并进这一排**,
 * 只留一处(维护者:不要两处都有)。
 *
 * 2026-10-04(卡 `claude/phone-home-meeting-icon`,维护者:「再开张卡,把会议模式一样拿出来到右边的侧边栏上」)
 * 这一排多了**第六颗:会议**,排在资讯之后。原来它只在「记录 → 对话记录页 → 顶上那排小链接」里
 * (藏了三层,维护者在手机上找不到);记录面板里那颗照旧留着,是第二条路(同另外几颗)。
 *
 * ## 「点不到」是怎么回事(上一版查实的根因,这一版照旧钉着)
 *
 * 不是行没绑 onClick、也不是 hit 区域太小 —— 是**形象区漏出球那一格,压在底下的东西上**:
 *
 *   `avatars.css` 里 `.ba-scene .ba-scene__body .ba-scene__orb > .ba-avportrait` 压的是
 *   `stageCards.css` 的 `.ba-scene .ba-scene__orb > *`,把 `width / height / max-*` 都改成了 auto/none,
 *   **但没压掉那一条里的 `aspect-ratio: 1 / 1`**。于是这一层是
 *   `position: absolute; inset: 0; width: auto; height: auto; aspect-ratio: 1/1`:
 *   宽按 `inset: 0` 算 = 整屏宽,高按 `aspect-ratio` 算 = 同一个数 —— 跟球那一格真有多高无关。
 *   412×915 上球那一格只有 162px,这一层却是 412×412,**漏出去 250px**;它是定位元素、
 *   画在普通流内容之上,点击命中跟着画的顺序走 —— 底下的东西看得见、点不到。
 *
 * 这与 2026-09-22 来电页「接听、静音那 3 个按钮都不能按」是**同一种事故**
 * (tests/orbSlotCss.test.ts 的文件头),所以修法也同一套:格子兜住自己的孩子、装饰不吃点击。
 *
 * ## 为什么 CSS 那几条按文本钉
 *
 * vitest 跑在 jsdom 里且没有开 `css: true` —— 样式表没被应用,「谁盖住谁」在 jsdom 里演不出来
 * (orbSlotCss.test.ts 头上那一段写了为什么不开)。所以这一份:**DOM 那一层用例断言**
 * (五颗图标在、角标数对、点下去进哪一页 / 挂哪一块),**CSS 那一层按文本钉修法**。
 * 真排出来的三档数(412×915 / 375×667 / 873×393 横屏)在 docs/交接-1003-手机首页两卡一排图标.md。
 */
import { describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach } from 'vitest';
import {
  HOME_RAIL_LABEL, HomeRail, RAIL_CALLS_NAME, RAIL_MEETING_NAME, RAIL_MISSED_NAME, RAIL_NEWS_NAME,
  RAIL_NEWS_PODCAST_TEXT, RAIL_TODAY_NAME,
} from '../src/stage/HomeRail';
import { missedShownCount, missedShownGroups, parseCallLog } from '../src/call/incomingModel';
import { MEETING_TITLE, RECENT_SESSIONS_TITLE, PAGE_TITLES } from '../src/nav/navModel';

afterEach(() => { cleanup(); vi.useRealTimers(); });

const SRC = resolve(__dirname, '../src');
const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, ' ');
const css = (path: string) => strip(readFileSync(resolve(SRC, path), 'utf8'));
const AVATARS = css('avatars/avatars.css');
const RAIL = css('stage/homeRail.css');
const CARDS = css('stage/stageCards.css');
const STYLES = css('styles.css');
/**
 * 一条规则的花括号里面。**选择器要从行首起**(前面只许有空白)——
 * 用 `indexOf` 会把 `.ba-scene__orb .ba-particles { … }` 当成 `.ba-particles` 那一条
 * (写这一份时真被它骗了一次,同 orbSlotCss.test.ts 文件头那条教训)。
 */
function rule(text: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const found = new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(text);
  expect(found, `没找到 ${selector}`).toBeTruthy();
  return found![1]!;
}

const RAW_LOG = {
  missed: 3,
  config: { enabled: true, done_call: false },
  entries: [
    { id: 'c1', reason: 'confirm', item_id: 't-confirm', title: '我的规矩有哪些?', at: '2026-10-03T06:20:00Z', state: 'missed', error: '响了 60 秒没人接' },
    { id: 'c2', reason: 'failed', item_id: 't-cancel', title: '[派活测试] 让 Kimi 答一句', at: '2026-10-03T05:54:00Z', state: 'missed', error: '响了 60 秒没人接' },
    { id: 'c3', reason: 'failed', item_id: 't-open', title: '还开着的一件', at: '2026-10-03T05:40:00Z', state: 'missed', error: '响了 60 秒没人接' },
  ],
};
const LOG = parseCallLog(RAW_LOG);

/** 前五颗(2026-10-03 那两张卡的那一排;会议那颗是 10-04 加的,见 allSix)。 */
function allFive(over: Partial<Parameters<typeof HomeRail>[0]> = {}) {
  return {
    missed: { count: 2, onOpen: vi.fn() },
    history: { name: RECENT_SESSIONS_TITLE, onOpen: vi.fn() },
    today: { count: 3, onOpen: vi.fn() },
    calls: { onOpen: vi.fn() },
    news: { onOpen: vi.fn() },
    ...over,
  };
}

/** 六颗都给齐(调用方是 StagePage,它六样都接了)。 */
function allSix(over: Partial<Parameters<typeof HomeRail>[0]> = {}) {
  return { ...allFive(), meeting: { onOpen: vi.fn() }, ...over };
}

describe('① 这一排:六颗都在、顺序照维护者报的那个、点哪颗开哪一样', () => {
  it('★六颗、顺序是 未接来电 · 各家最近的对话 · 今天要做 · 最近一次通话 · 资讯 · 会议', () => {
    render(<HomeRail {...allSix()} />);
    const rail = document.querySelector<HTMLElement>('.ba-rail')!;
    expect(rail.getAttribute('aria-label')).toBe(HOME_RAIL_LABEL);
    const buttons = within(rail).getAllByRole('button');
    expect(buttons).toHaveLength(6);
    // 名字挂在 title 上(安卓长按的原生 tooltip),顺序就按它核。
    expect(buttons.map((one) => one.getAttribute('title'))).toEqual([
      RAIL_MISSED_NAME, RECENT_SESSIONS_TITLE, RAIL_TODAY_NAME, RAIL_CALLS_NAME, RAIL_NEWS_NAME, RAIL_MEETING_NAME,
    ]);
    /*
     * 六颗各自的图标(都逐字取自那份 Tabler 库,没有新来源)。2026-10-04 整排重选:
     * 维护者「图标的意思看着也很容易误解……重新选一批」+「未接来电和现在输入框的通话是同一个」。
     * 三颗话筒按记号分:不带记号的 `phone` 只在输入条上(打出去),这一排是打叉(没接到)与打勾(打过的)。
     * 为什么是这六个、各自的备选在 docs/交接-1004-手机首页会议图标.md 那张表里。
     */
    expect(buttons.map((one) => one.querySelector('.ba-icon')?.getAttribute('data-icon'))).toEqual([
      'phone-off', 'message-chatbot', 'clipboard-check', 'phone-check', 'file-text', 'headset',
    ]);
    // 输入条那颗「打出去」用的那个图,这一排里一颗都不许用(同一个图两个意思就是她撞上的那件事)。
    expect(buttons.some((one) => one.querySelector('[data-icon="phone"]') !== null)).toBe(false);
    expect(buttons.some((one) => one.querySelector('[data-icon="microphone"]') !== null)).toBe(false);
  });

  it('★点哪颗开哪一样(未接那颗开那一块,其余五颗各进自己那一页)', () => {
    const props = allSix();
    render(<HomeRail {...props} />);
    fireEvent.click(screen.getByRole('button', { name: `${RAIL_MISSED_NAME} 2` }));
    fireEvent.click(screen.getByRole('button', { name: `打开「${RECENT_SESSIONS_TITLE}」` }));
    fireEvent.click(screen.getByRole('button', { name: `${RAIL_TODAY_NAME} 3` }));
    fireEvent.click(screen.getByRole('button', { name: `打开「${RAIL_CALLS_NAME}」` }));
    fireEvent.click(screen.getByRole('button', { name: `打开「${RAIL_NEWS_NAME}」` }));
    fireEvent.click(screen.getByRole('button', { name: `打开「${RAIL_MEETING_NAME}」` }));
    expect(props.missed.onOpen).toHaveBeenCalledTimes(1);
    expect(props.history.onOpen).toHaveBeenCalledTimes(1);
    expect(props.today.onOpen).toHaveBeenCalledTimes(1);
    expect(props.calls.onOpen).toHaveBeenCalledTimes(1);
    expect(props.news.onOpen).toHaveBeenCalledTimes(1);
    expect(props.meeting.onOpen).toHaveBeenCalledTimes(1);
  });

  /*
   * 会议那颗(2026-10-04,卡 `claude/phone-home-meeting-icon`)。维护者原话:
   * 「再开张卡,把会议模式一样拿出来到右边的侧边栏上」——「一样」= 10-03 把那两行搬成小图标那件事,
   * 而那一列在方案 B 里已经并进了球下这一排,所以它是这一排里的**第六颗**。
   */
  it('★会议那颗:不带角标、也不带小点 —— 录音在会议页卸载时就停了,首页上没有「正在录」这回事', () => {
    render(<HomeRail {...allSix()} />);
    const meeting = screen.getByRole('button', { name: `打开「${RAIL_MEETING_NAME}」` });
    expect(meeting.querySelector('.ba-rail__badge')).toBeNull();
    expect(meeting.querySelector('.ba-rail__dot')).toBeNull();
    // 名字就是会议页返回头上那个字符串(读屏念的与到了之后看到的必须一样)。
    expect(meeting.getAttribute('title')).toBe(MEETING_TITLE);
  });

  it('★没给 meeting(首页没传 onOpenMeeting)→ 这一排照旧五颗,会议那颗整个不画', () => {
    render(<HomeRail {...allFive()} />);
    const rail = document.querySelector<HTMLElement>('.ba-rail')!;
    expect(within(rail).getAllByRole('button')).toHaveLength(5);
    expect(screen.queryByRole('button', { name: `打开「${RAIL_MEETING_NAME}」` })).toBeNull();
    expect(rail.querySelector('[data-icon="headset"]')).toBeNull();
  });

  it('★角标:只有未接与「今天要做」两颗有,写的是真数;**0 时不画角标,图标照旧在**', () => {
    const { rerender } = render(<HomeRail {...allFive({ missed: { count: 7, onOpen: vi.fn() }, today: { count: 4, onOpen: vi.fn() } })} />);
    const badges = () => [...document.querySelectorAll('.ba-rail__badge')].map((one) => one.textContent);
    expect(badges()).toEqual(['7', '4']);
    // 没有数可数的那三颗不画角标(数不出来就不写一个数,不编)。
    for (const name of [RECENT_SESSIONS_TITLE, RAIL_CALLS_NAME, RAIL_NEWS_NAME]) {
      expect(screen.getByRole('button', { name: `打开「${name}」` }).querySelector('.ba-rail__badge')).toBeNull();
    }

    rerender(<HomeRail {...allFive({ missed: { count: 0, onOpen: vi.fn() }, today: { count: 0, onOpen: vi.fn() } })} />);
    expect(badges()).toEqual([]);
    // 两颗图标都还在,读屏念得出它们是什么。
    expect(screen.getByRole('button', { name: `${RAIL_MISSED_NAME},一条都没有` })).toBeTruthy();
    expect(screen.getByRole('button', { name: `${RAIL_TODAY_NAME},一件都没有` })).toBeTruthy();
  });

  /*
   * 2026-10-03 晚(卡 `claude/phone-news-podcast-dot`):维护者被问「资讯那颗要不要一个角标」,
   * 选的是「要,只标播客有没有」—— 今天那期播客能听时亮一个小点,**不写数字**。
   */
  it('★资讯那颗:今天的播客能听时亮一个小点(不是数字角标);读屏念出来', () => {
    const props = allFive({ news: { podcast: true, onOpen: vi.fn() } });
    render(<HomeRail {...props} />);
    const news = screen.getByRole('button', { name: `${RAIL_NEWS_NAME},${RAIL_NEWS_PODCAST_TEXT}` });
    expect(news.querySelector('.ba-rail__dot')).toBeTruthy();
    // 是一个点,不是一个数:不借数字角标那一格,也不写字。
    expect(news.querySelector('.ba-rail__badge')).toBeNull();
    expect(news.querySelector('.ba-rail__dot')!.textContent).toBe('');
    expect(news.querySelector('.ba-rail__dot')!.getAttribute('aria-hidden')).toBe('true');
    // 名字照旧是「资讯」(长按飘的、title 上挂的都是它),点下去照旧进那一页。
    expect(news.getAttribute('title')).toBe(RAIL_NEWS_NAME);
    fireEvent.click(news);
    expect(props.news.onOpen).toHaveBeenCalledTimes(1);
  });

  it('★不能听 / 还没问到:不亮,读屏照旧「打开「资讯」」—— 不替她说「今天没有播客」(可能只是还没问到)', () => {
    const { rerender } = render(<HomeRail {...allFive({ news: { podcast: false, onOpen: vi.fn() } })} />);
    expect(document.querySelector('.ba-rail__dot')).toBeNull();
    expect(screen.getByRole('button', { name: `打开「${RAIL_NEWS_NAME}」` })).toBeTruthy();
    rerender(<HomeRail {...allFive()} />);
    expect(document.querySelector('.ba-rail__dot')).toBeNull();
    expect(screen.getByRole('button', { name: `打开「${RAIL_NEWS_NAME}」` })).toBeTruthy();
  });

  it('小点只挂在资讯那颗上 —— 别的四颗没有这个开关', () => {
    render(<HomeRail {...allFive({ news: { podcast: true, onOpen: vi.fn() } })} />);
    expect(document.querySelectorAll('.ba-rail__dot')).toHaveLength(1);
  });

  it('三位数的角标写「99+」—— 一颗 44px 的图标上不许排四位数', () => {
    render(<HomeRail missed={{ count: 128, onOpen: vi.fn() }} today={{ count: 100, onOpen: vi.fn() }} />);
    expect([...document.querySelectorAll('.ba-rail__badge')].map((one) => one.textContent)).toEqual(['99+', '99+']);
  });

  it('名字:读屏标签 + 长按 450ms 飘出来那几个字;**长按之后那一下不开页**(她在问这是什么)', () => {
    vi.useFakeTimers();
    const onOpen = vi.fn();
    render(<HomeRail history={{ name: RECENT_SESSIONS_TITLE, onOpen }} />);
    const button = screen.getByRole('button', { name: `打开「${RECENT_SESSIONS_TITLE}」` });
    expect(button.getAttribute('title')).toBe(RECENT_SESSIONS_TITLE);
    expect(document.querySelector('.ba-rail__name')).toBeNull();

    fireEvent.pointerDown(button);
    act(() => { vi.advanceTimersByTime(500); });
    expect(document.querySelector('.ba-rail__name')?.textContent).toBe(RECENT_SESSIONS_TITLE);
    fireEvent.pointerUp(button);
    fireEvent.click(button);
    expect(onOpen).not.toHaveBeenCalled();

    // 飘完自己没;再点一下照常开页。
    act(() => { vi.advanceTimersByTime(2000); });
    expect(document.querySelector('.ba-rail__name')).toBeNull();
    fireEvent.pointerDown(button);
    fireEvent.pointerUp(button);
    fireEvent.click(button);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('飘名字那一层挂在**这一排**上(不是挂在那一颗上):横排里第一颗左边就是屏幕边缘', () => {
    vi.useFakeTimers();
    render(<HomeRail {...allFive()} />);
    fireEvent.pointerDown(screen.getByRole('button', { name: `${RAIL_MISSED_NAME} 2` }));
    act(() => { vi.advanceTimersByTime(500); });
    const name = document.querySelector('.ba-rail__name')!;
    expect(name.parentElement?.classList.contains('ba-rail')).toBe(true);
  });

  it('没有去处的那一颗整个不画(点了没反应比不能点更糟,D13)', () => {
    render(<HomeRail missed={{ count: 1, onOpen: vi.fn() }} news={{ onOpen: vi.fn() }} />);
    const rail = document.querySelector<HTMLElement>('.ba-rail')!;
    expect(within(rail).getAllByRole('button').map((one) => one.getAttribute('title')))
      .toEqual([RAIL_MISSED_NAME, RAIL_NEWS_NAME]);
  });

  it('名字 = 到了之后那一页返回头上的字(读屏念的与看到的必须一样)', () => {
    expect(RECENT_SESSIONS_TITLE).toBe(PAGE_TITLES.history);
    expect(RAIL_NEWS_NAME).toBe(PAGE_TITLES.news);
    // 会议页不在 PAGE_TITLES 里(它是整屏一页、自己一面旗子),返回头认的是 MEETING_TITLE。
    expect(RAIL_MEETING_NAME).toBe(MEETING_TITLE);
    // 「今天要做」= 那张卡的标题(它点进去是事项页「还没开始的」那一段)。
    expect(RAIL_TODAY_NAME).toBe('今天要做');
    expect(RAIL_CALLS_NAME).toBe('最近一次通话');
  });
});

describe('② 角标那个数与点开之后那几行出自同一处', () => {
  it('★已收场的事引起的未接两处都不算:角标 2、组也只剩 2 组', () => {
    const hide = new Set(['t-cancel']);
    expect(missedShownCount(LOG, hide)).toBe(2);
    expect(missedShownGroups(LOG, hide).map((one) => one.item_id)).toEqual(['t-confirm', 't-open']);
  });

  it('全收场了:角标 0(于是那颗点下去不开那一块,只飘一句)', () => {
    expect(missedShownCount(LOG, new Set(['t-cancel', 't-open', 't-confirm']))).toBe(0);
  });

  it('同一件事的多通只算在它那一组里,数的是通数不是组数', () => {
    const many = parseCallLog({
      missed: 9,
      entries: Array.from({ length: 9 }, (_, i) => ({ id: `d${i}`, reason: 'failed', item_id: 't-x', title: '下班例程', at: '', state: 'missed' })),
    });
    expect(missedShownGroups(many)).toHaveLength(1);
    expect(missedShownCount(many)).toBe(9);
  });
});

/**
 * 这一节是**修「点不到」那几条**(上一版查实的根因,这一版一条没松)。顺序照着「为什么会盖住」排:
 * ① 形象区不许比球那一格大;② 球不许比它的格子大;③ 装饰不吃点击;④ 这一排与那一块不许盖别人。
 */
describe('③ 点不到:CSS 那一层的修法', () => {
  it('★形象区那一层 `aspect-ratio: auto` —— 不收它,`inset:0 + height:auto` 会算出一个屏宽那么高的方块', () => {
    const one = rule(AVATARS, '.ba-scene .ba-scene__body .ba-scene__orb > .ba-avportrait');
    expect(one).toMatch(/aspect-ratio:\s*auto/);
    // 前提:被它压的那一条里确实写着 1 / 1(哪天那边不写了,这条断言的理由就得重写)。
    expect(CARDS).toMatch(/\.ba-scene \.ba-scene__orb > \* \{[^}]*aspect-ratio: 1 \/ 1/s);
  });

  it('★形象区 `overflow: hidden` —— 里面谁都不许再漏到球那一格外面去', () => {
    expect(rule(AVATARS, '.ba-scene .ba-scene__body .ba-scene__orb > .ba-avportrait')).toMatch(/overflow:\s*hidden/);
  });

  it('★球自己两边都有 `max-*` 兜着 + `aspect-ratio` 保圆(格子比它矮时不许漏出去,照旧是个圆)', () => {
    const one = rule(AVATARS, '.ba-avportrait__orb > :first-child');
    expect(one).toMatch(/max-width:\s*100%/);
    expect(one).toMatch(/max-height:\s*100%/);
    expect(one).toMatch(/aspect-ratio:\s*1 \/ 1/);
    // 只给一个方向定尺寸:两个方向都写死 + max-* 会把球压成椭圆。
    expect(one).toMatch(/width:\s*auto/);
  });

  /**
   * ★方案 B 新加的三条(维护者:「中间的球球还是要大的……省出来的空间 Live2D 也能放大」)。
   * 上一版这里是 `height: min(60vw, 46vh)` —— 一个按**视口**算的上限:412×915 上 = 247px,
   * 格子长到 473px 也还是 247px,省出来的高度白白空着。
   */
  it('★球跟着形象区长大:`height: min(100%, 92vw)` —— 格子高就跟着格子,不再钉在 60vw 上', () => {
    const one = rule(AVATARS, '.ba-avportrait__orb > :first-child');
    expect(one).toMatch(/height:\s*min\(100%,\s*92vw\)/);
    expect(one).not.toMatch(/60vw/);
    // 通话 / 引导那两态的球不走这里,照旧按视口那条算(那两屏没有卡片区、没有这一排)。
    expect(CARDS).toMatch(/\.ba-scene \.ba-scene__orb > \* \{[^}]*height: min\(60vw/s);
  });

  it('★上限写在**定尺寸那一头**(不是 `max-width`)—— 不然它是个椭圆,不是圆', () => {
    /*
     * `aspect-ratio` 只在一个方向是 auto 时才成立:`height: 100%` 把高定死之后,
     * 宽按比例算出来再被 `max-width` 剪一刀,**高不会跟着回缩** ——
     * 412×915 上第一版真画出了一个 412×473 的椭圆(无头 Chrome 量到的)。
     */
    const one = rule(AVATARS, '.ba-avportrait__orb > :first-child');
    // 定尺寸那一格是 min(...);光写 `height: 100%` 再靠 max-width 剪宽就是那个椭圆。
    expect(one).toMatch(/(^|;)\s*height:\s*min\(/);
    expect(one).not.toMatch(/(^|;)\s*height:\s*100%/);
  });

  it('★`min-height: 0` —— CSS 里 min 压得过 max,不收它 `.ba-particles` 那条 220px 会把球顶出格子', () => {
    expect(rule(AVATARS, '.ba-avportrait__orb > :first-child')).toMatch(/min-height:\s*0/);
    // 前提:被它收的那一条确实在(哪天那边不写了,这条断言的理由就得重写)。
    expect(rule(STYLES, '.ba-particles')).toMatch(/min-height:\s*220px/);
  });

  it('★居中用 flex,不用 grid —— grid 的行按内容撑,百分比上限等于没有(stageCards.css 09-21 那一课)', () => {
    const one = rule(AVATARS, '.ba-avportrait__orb');
    expect(one).toMatch(/display:\s*flex/);
    expect(one).not.toMatch(/display:\s*grid/);
    expect(one).toMatch(/place-items|align-items:\s*center/);
  });

  it('★粒子球不吃点击(它从头到尾是装饰;退回来的那颗声纹球从第一天就这么写)', () => {
    expect(rule(STYLES, '.ba-particles')).toMatch(/pointer-events:\s*none/);
    expect(rule(STYLES, '.ba-orb')).toMatch(/pointer-events:\s*none/);
  });
});

describe('④ 这一排与未接那一块:不遮内容、不盖输入框', () => {
  it('★这一排在流里、横排居中,在球那一栏里最后一格(球与字幕在上、卡片区在下)', () => {
    const one = rule(RAIL, '.ba-rail');
    expect(one).toMatch(/flex:\s*0 0 auto/);
    expect(one).toMatch(/flex-direction:\s*row/);
    expect(one).toMatch(/justify-content:\s*center/);
    // 不再绝对定位(上一版是球那一栏右上角一列)。
    expect(one).not.toMatch(/position:\s*absolute/);
    // 球那一栏照旧是那一块的参照物。
    expect(rule(CARDS, '.ba-scene__stage')).toMatch(/position:\s*relative/);
  });

  /*
   * 六颗(2026-10-04 加了会议那颗)在最窄那一档上装不装得下:
   * 44px × 6 + gap 2px × 5 + 左右 padding 8px × 2 = **290px**,375 的屏还剩 85px。
   * 所以不许有「挤不下就换行 / 把图标压扁」那两条:换行会把这一排变成两行(球跟着矮一截),
   * 压扁会让 44px 的点击区缩水(09-22「三颗键按不动」那一类)。真排出来的数在
   * docs/交接-1004-手机首页会议图标.md(无头 Chrome,375 / 412 两档)。
   */
  it('★六颗在 375 上一行装得下:不换行、每颗不许被压扁(44px 的点击区是硬的)', () => {
    const one = rule(RAIL, '.ba-rail');
    expect(one).not.toMatch(/flex-wrap/);
    expect(rule(RAIL, '.ba-rail__btn')).toMatch(/flex:\s*0 0 auto/);
    // 一颗多宽、几颗、缝多宽、两边留多少 —— 上面那个 290 就是按这四个数算的。
    expect(rule(STYLES, '.ba-scene__icon--sm')).toMatch(/width:\s*44px/);
    expect(one).toMatch(/gap:\s*2px/);
    expect(one).toMatch(/padding:\s*0 8px/);
  });

  /*
   * 这一排与下面两张卡之间的距离(2026-10-04,维护者:「那排小按钮离下面的两张卡片太近了」)。
   * 原来是 2px(图标下沿到卡片上沿),现在走 styles.css 顶上那个变量。
   * 真排出来的数在 docs/交接-1004-手机首页会议图标.md 第四节(412×915 / 375×667 改前改后各一组)。
   */
  it('★那一排与卡片之间的距离走 styles.css 那份变量,不在这儿写一个 px、也不写 @media', () => {
    expect(rule(RAIL, '.ba-rail')).toMatch(/padding:\s*0 8px var\(--ba-gap-rail-cards\)/);
    // 变量本人在 styles.css 的 :root 里(横竖同一个数)。
    expect(rule(STYLES, ':root')).toMatch(/--ba-gap-rail-cards:\s*\d+px/);
    expect(RAIL).not.toContain('@media');
    // 卡片区自己的上边距照旧是 0 —— 两处都给,那个距离就是两个数相加,下一个人调不准。
    expect(rule(CARDS, '.ba-cards')).toMatch(/padding:\s*0 14px/);
  });

  it('★未接那一块挂在球那一栏上 —— 横屏下才不会铺到卡片区身上去', () => {
    const sheet = rule(RAIL, '.ba-rail-sheet');
    expect(sheet).toMatch(/position:\s*absolute/);
    expect(sheet).toMatch(/top:\s*0/);
    /*
     * 封顶 40vh + 自己滚:九条未接也不许铺到输入框上。vh 一律写成 `var(--ba-vh, 1vh)` ——
     * 弹键盘时 keyboardViewport 把它钉在没弹键盘那一档(卡 fix/phone-keyboard-orb-stable)。
     */
    expect(sheet).toMatch(/max-height:\s*calc\(40 \* var\(--ba-vh, 1vh\)\)/);
    expect(sheet).toMatch(/overflow-y:\s*auto/);
    // 横屏那一段**不该有**:挂对了参照物就不用为横屏另写一份(写了反而是两套)。
    expect(RAIL).not.toContain('@media');
  });

  it('那一块左右同宽 —— 球那一栏右边不再有常驻的一列要让位置(那一列并进了球下那一排)', () => {
    const sheet = rule(RAIL, '.ba-rail-sheet');
    expect(sheet).toMatch(/left:\s*8px/);
    expect(sheet).toMatch(/right:\s*8px/);
    expect(RAIL).not.toContain('--ba-rail-w');
  });

  it('那一块压得过卡片与形象区,又低于记录面板那一层(记录拉开时它不该浮在前面)', () => {
    const z = (text: string, selector: string) => Number(/z-index:\s*(\d+)/.exec(rule(text, selector))![1]);
    expect(z(RAIL, '.ba-rail-sheet')).toBeGreaterThan(0);
    expect(z(RAIL, '.ba-rail-sheet')).toBeLessThan(z(STYLES, '.ba-scene__scrim'));
  });

  it('资讯那颗的小点:贴右上角、圆的、不占地方、不吃点击;不用琥珀(那是「要你处理」那一档,播客不是)', () => {
    const dot = rule(RAIL, '.ba-rail__dot');
    expect(dot).toMatch(/position:\s*absolute/);
    expect(dot).toMatch(/top:/);
    expect(dot).toMatch(/right:/);
    expect(dot).toMatch(/border-radius:\s*(50%|999px)/);
    expect(dot).toMatch(/pointer-events:\s*none/);
    expect(dot).not.toContain('--ba-amber');
  });

  it('长按飘出来那几个字不占地方、不吃点击、不许把整页撑宽(它一来一走都不许动版面)', () => {
    const name = rule(RAIL, '.ba-rail__name');
    expect(name).toMatch(/position:\s*absolute/);
    expect(name).toMatch(/pointer-events:\s*none/);
    // 横排居中 + 自己封顶宽度:`nowrap` 的名字不许从屏幕两头溢出去。
    expect(name).toMatch(/left:\s*50%/);
    expect(name).toMatch(/max-width:\s*calc\(100% - 16px\)/);
  });
});

describe('⑤ 主列里不许再有那两行 / 那三张卡(高度全还给球)', () => {
  it('★`.ba-scene__recent` 那一段整个没了 —— 源码里一个字都不剩', () => {
    const page = readFileSync(resolve(SRC, 'stage/StagePage.tsx'), 'utf8');
    expect(page).not.toContain('className="ba-scene__recent"');
    // CSS 那一段也搬走了(留着就是死代码,下一个人会以为首页还有那一行)。
    expect(css('items/recentSessions.css')).not.toContain('.ba-scene__recent {');
  });

  /*
   * 方案 B 那一版首页不再问 `/feed`(资讯那一格不画了,白问);2026-10-03 晚维护者要了那颗小点,
   * 首页又问回来 —— 但**只为那颗点问**,判法与资讯那一页同一处(tests/newsPodcastDot.test.tsx)。
   * 什么时候问、什么时候不问是 StagePage 的行为,钉在 tests/StagePage.test.tsx。
   */
  it('★首页为资讯那颗的小点问 `/feed`,亮不亮认的是那一处判断(`glancePodcast`),不在首页另判一遍', () => {
    const page = strip(readFileSync(resolve(SRC, 'stage/StagePage.tsx'), 'utf8'));
    expect(page).toContain('useNewsGlance(');
    expect(page).toContain('glancePodcast(');
    // 首页自己不碰播客那几样字段(哪一样算「能听」只在 playablePodcast 里写一遍)。
    expect(page).not.toMatch(/canPlay\(|podcast\?\.file|\.podcast\.file/);
  });

  it('这一排的样子就是顶上那两颗 icon 的那一套(维护者:和前面一样做成 icon)', () => {
    const page = readFileSync(resolve(SRC, 'stage/HomeRail.tsx'), 'utf8');
    expect(page).toContain('ba-scene__icon ba-scene__icon--sm');
  });
});

describe('会议那颗的小点(2026-10-10 会前准备)', () => {
  it('prep 为 true → 亮点,读屏念会前准备;不给就照旧', async () => {
    const { render, screen, cleanup } = await import('@testing-library/react');
    const { HomeRail, RAIL_MEETING_NAME, RAIL_MEETING_PREP_TEXT } = await import('../src/stage/HomeRail');
    render(<HomeRail meeting={{ prep: true, onOpen: () => {} }} />);
    expect(screen.getByRole('button', { name: `${RAIL_MEETING_NAME},${RAIL_MEETING_PREP_TEXT}` }).querySelector('.ba-rail__dot')).not.toBeNull();
    cleanup();
    render(<HomeRail meeting={{ onOpen: () => {} }} />);
    expect(screen.getByRole('button', { name: `打开「${RAIL_MEETING_NAME}」` }).querySelector('.ba-rail__dot')).toBeNull();
  });
});
