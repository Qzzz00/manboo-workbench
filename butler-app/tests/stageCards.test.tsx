/**
 * 首页球下面的卡片区(2026-09-21 起;2026-09-25 卡 feat/first-look-orb-top 重排;
 * 2026-10-03 傍晚卡「首页两卡 + 一排图标」= 方案 B,主列只剩两张并排)。这一份钉:
 *
 * 1. 五样各自是什么(`stageCards`,全份口径)+ **主列上画哪两张**(`homeCards`);横竖同一份 DOM;
 * 2. 「正在办」= 事务官在办的 + 各家客户端在跑、没挂在事项上的会话(与电脑首页球周围同一个口径);
 * 3. 「最近一次通话」读最新那张纪要卡,写**一句话摘要**;引导那一通也算;一张都没有才说没有;
 * 4. 「资讯」读首页自己拉的那份(今天的播客 / 几条资讯),真没有才说没有、并说清为什么;
 * 5. **整张卡都能点**(维护者 09-24 19:55:「交互不对」),去处各是各的。
 */
import { describe, expect, it, vi } from 'vitest';
import { act, render, screen, cleanup, fireEvent } from '@testing-library/react';
import { afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { StageCards } from '../src/stage/StageCards';
import {
  CALL_NONE_TEXT, CARD_ROWS, CARD_ROWS_SHORT, FEED_ASKING_TEXT, FEED_UNAVAILABLE_TEXT, HOME_CARD_IDS, ONBOARDING_DONE_CALL_TEXT, SETUP_LINE_TEXT, SHORT_SCENE_REM,
  callLine, cardRowsFor, feedCard, fitRows, otherConfirms, otherConfirmsTitle, setupLine, shortDue, stageCards,
  type NewsGlance, type StageCardTarget,
} from '../src/stage/stageCardsModel';
import { emptyState, type SessionView, type TaskView, type WorkbenchState } from '../src/api/protocol';
import { registryOf } from './registryFixture';
import type { NewsView } from '../src/feed/newsModel';
import type { AidjView } from '../src/feed/aidjModel';

afterEach(cleanup);

function mine(over: Partial<TaskView> & { id: string; title: string }): TaskView {
  return {
    status: 'todo',
    direction: 'mine',
    created_at: '2026-09-21T00:00:00Z',
    updated_at: '2026-09-21T01:00:00Z',
    ...over,
  };
}
function session(over: Partial<SessionView> = {}): SessionView {
  return { agent: 'codex', session_id: 'cx-1', project: '工作台', status: 'running', title: '参赛网页', elapsed_sec: 60, unread: false, updated_at: '2026-09-24T10:50:00Z', ...over };
}
function state(over: Partial<WorkbenchState> = {}): WorkbenchState {
  // 服务端每一拍都带登记表(卡 Q):各家的会话挂在各自条目上,名字从这里来。
  return { ...emptyState(), stale: false, now: '2026-09-24T19:05:00+08:00', agent_registry: registryOf(over.sessions ?? []), ...over };
}
const byId = (s: WorkbenchState, news?: NewsGlance) => new Map(stageCards(s, news).map((card) => [card.id, card]));

describe('事务官问你的话、要你批的事(2026-09-25,卡 M)', () => {
  const question = { id: 'q-1', session_id: 's', task_id: 't-1', task_title: '这个有点问题,你看三张卡片的左上角', at: 'x',
    questions: [{ id: 'c', header: '派活前对一遍', question: '都对就开工。', multi: false, options: [{ label: '都对,开工', text: '都对,开工' }] }] };
  const approval = { id: 'a-1', session_id: 's', task_title: '修小头像', tool: 'bash', at: 'x', say: '要开一个看不见的浏览器,把页面截下来看' };

  it('「等你确认」最前面是她问你的、要你批的;数算上它们;整张卡点下去先到那一页', () => {
    const confirm = byId(state({
      questions: [question], approvals: [approval],
      butler_inbox: { items: [{ id: 'confirm:t-9', kind: 'confirm', title: '已经办完的', task_id: 't-9' }] },
    } as unknown as Partial<WorkbenchState>)).get('confirm')!;
    expect(confirm.count).toBe(3);
    expect(confirm.lines.map((line) => line.text)).toEqual(['「这个有点问题,你看三张卡…」问你:派活前对一遍', '「修小头像」要开一个看不见的浏览器,把页面截下来…', '已经办完的']);
    expect(confirm.more).toBeUndefined();
    expect(confirm.to).toEqual({ page: 'asks' });
  });

  it('一件都没有时照旧(点下去去事项页那一段)', () => {
    expect(byId(state()).get('confirm')!.to).toEqual({ page: 'inbox', tab: 'waiting' });
    // 2026-10-01 事项页分标签:「正在办」落在办、「今天要做」落排着。
    expect(byId(state()).get('doing')!.to).toEqual({ page: 'inbox', tab: 'doing' });
    expect(byId(state()).get('today')!.to).toEqual({ page: 'inbox', tab: 'queued' });
  });
});

describe('五块卡片', () => {
  it('顺序:正在办(整行)→ 等你确认 · 今天要做 → 最近一次通话 · 资讯', () => {
    const cards = stageCards(state());
    expect(cards.map((c) => c.title)).toEqual(['正在办', '等你确认', '今天要做', '最近一次通话', '资讯']);
    expect(cards.filter((c) => c.wide === true).map((c) => c.id)).toEqual(['doing']);
  });

  it('★正在办 = 事务官在办的(挂着的会话在跑)+ Codex 那条在跑、没挂在事项上的;事务官自己的会话不单列', () => {
    const tasks = [
      mine({ id: 'a', title: '参赛网页架构收尾', status: 'doing', conversation: { agent: 'dsh', session_id: 'd-1' }, links: [{ agent: 'claude', session_id: 'cl-1' }] }),
      mine({ id: 'b', title: '还没开始的事', status: 'todo' }),
    ];
    const s = state({ tasks: { tasks }, sessions: [session({ agent: 'dsh', session_id: 'd-1' }), session({ agent: 'claude', session_id: 'cl-1' }), session(), session({ agent: 'kimi', session_id: 'k-1', status: 'waiting' })] });
    const doing = byId(s).get('doing')!;
    expect(doing.lines.map((l) => [l.text, l.note])).toEqual([['参赛网页架构收尾', 'Claude'], ['参赛网页', 'Codex']]);
    expect(doing.count).toBe(2);
    // 今天要做里不再重复正在办的那一件。
    expect(byId(s).get('today')!.lines.map((l) => l.text)).toEqual(['还没开始的事']);
  });

  it('正在办摆不下时最后一行是「还有 N 件」(总共三行);电脑没连上(快照旧)时不凭旧数据说在办', () => {
    const sessions = Array.from({ length: 5 }, (_, i) => session({ session_id: `cx-${i}`, title: `会话 ${i}` }));
    const doing = byId(state({ sessions })).get('doing')!;
    expect(doing.lines).toHaveLength(CARD_ROWS - 1);
    expect(doing.more).toBe(3);
    expect(doing.count).toBe(5);
    expect(byId(state({ sessions, stale: true })).get('doing')!.lines).toEqual([]);
  });

  it('今天要做 = 我交给事务官、还没办完的;数是总数,标题下面最多三行(摆不下时第三行是「还有 N 件」);通话纪要不算要做的事', () => {
    const tasks = [
      ...Array.from({ length: 5 }, (_, i) => mine({ id: `t-${i}`, title: `事项 ${i}` })),
      mine({ id: 'call', title: '和事务官通了个电话(4 秒)', status: 'todo' }),
      mine({ id: 'b', title: '办完了', status: 'done' }),
      mine({ id: 'd', title: '等我确认', status: 'confirm' }),
    ];
    const today = byId(state({ tasks: { tasks } })).get('today')!;
    expect(today.count).toBe(5);
    expect(today.lines.map((l) => l.text)).toEqual(['事项 0', '事项 1']);
    expect(today.more).toBe(3);
    // 屏矮(两行)时:一件 +「还有 4 件」。
    const short = new Map(stageCards(state({ tasks: { tasks } }), undefined, CARD_ROWS_SHORT).map((c) => [c.id, c])).get('today')!;
    expect(short.lines.map((l) => l.text)).toEqual(['事项 0']);
    expect(short.more).toBe(4);
  });

  it('等你确认也照行数摆:四条时两条 +「还有 2 件」,数是 4', () => {
    const items = Array.from({ length: 4 }, (_, i) => ({ id: `i-${i}`, kind: 'confirm' as const, title: `要你点头的第 ${i} 件` }));
    const confirm = byId(state({ butler_inbox: { items } })).get('confirm')!;
    expect(confirm.count).toBe(4);
    expect(confirm.lines).toHaveLength(2);
    expect(confirm.more).toBe(2);
  });

  it('等你确认 = 收件箱里 kind 是 confirm 那几条,别的种类不算', () => {
    const items = [
      { id: 'i-1', kind: 'confirm' as const, title: '这条要你点头' },
      { id: 'i-2', kind: 'sentinel' as const, title: '哨兵命中' },
    ];
    const confirm = byId(state({ butler_inbox: { items } })).get('confirm')!;
    expect(confirm.count).toBe(1);
    expect(confirm.lines.map((l) => l.text)).toEqual(['这条要你点头']);
  });
});

describe('最近一次通话', () => {
  it('★引导那一通(27 分钟)落的纪要卡:写那一句摘要,右边「几点 · 多长」;点下去是那张卡', () => {
    const tasks = [
      mine({ id: 'old', title: '和事务官通了个电话(34 秒)', status: 'done', created_at: '2026-09-24T09:33:06Z' }),
      mine({ id: 'onb', title: '引导通话(27 分钟)', status: 'done', origin: 'call', created_at: '2026-09-24T10:52:00Z', call: { kind: 'onboarding', summary: '引导走完了:项目(desktop-workbench)、授权、习惯都记下了', duration_seconds: 1620 } }),
    ];
    const call = byId(state({ tasks: { tasks } })).get('call')!;
    expect(call.lines).toHaveLength(1);
    expect(call.lines[0]!.text).toBe('引导走完了:项目(desktop-workbench)、授权、习惯都记下了');
    expect(call.lines[0]!.note).toMatch(/27 分钟$/);
    expect(call.to).toEqual({ page: 'calls', callId: 'onb' });
    expect(call.count).toBeUndefined();
  });

  it('这个字段出现之前的老纪要卡:正文就是它的标题,不编一句摘要', () => {
    const line = callLine(mine({ id: 'x', title: '和事务官通了个电话(34 秒)', created_at: '2026-09-24T09:33:06Z' }), '2026-09-24T19:05:00+08:00');
    expect(line.text).toBe('和事务官通了个电话(34 秒)');
  });

  it('★老数据:引导那一通没留纪要卡(09-25 之前挂断不写),引导走完比最近一张纪要还晚 → 写「引导走完了 · 几点」,点不开', () => {
    const tasks = [mine({ id: 'old', title: '和事务官通了个电话(34 秒)', status: 'done', created_at: '2026-09-24T09:33:06Z' })];
    const call = byId(state({ tasks: { tasks }, onboarding: { stage: 'done', done: true, done_at: '2026-09-24T10:51:50.678Z' } })).get('call')!;
    // 几点按跑测试这台机器的时区算(与 whenText 同一个算法),不写死 18:51。
    const at = new Date('2026-09-24T10:51:50.678Z');
    const hhmm = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
    expect(call.lines).toHaveLength(1);
    expect(call.lines[0]).toMatchObject({ id: 'onboarding-done', text: ONBOARDING_DONE_CALL_TEXT });
    expect(call.lines[0]!.note).toContain(hhmm);
    // 没有卡可开:不画那颗铺满的按钮(点了没反应比不能点更糟)。
    expect(call.to).toBeUndefined();
  });

  it('引导那一通有纪要卡、或引导走完之后又打过电话:照纪要卡写,不补那一句', () => {
    const onboarding = { stage: 'done', done: true, done_at: '2026-09-24T10:51:50.678Z' };
    const later = [mine({ id: 'late', title: '和事务官通了个电话(2 分钟)', status: 'done', origin: 'call', created_at: '2026-09-24T11:20:00Z', call: { kind: 'call', summary: '说了首页文案', duration_seconds: 120 } })];
    expect(byId(state({ tasks: { tasks: later }, onboarding })).get('call')!.lines[0]!.text).toBe('说了首页文案');
    const recorded = [mine({ id: 'onb', title: '引导通话(27 分钟)', status: 'done', origin: 'call', created_at: '2026-09-24T10:30:00Z', call: { kind: 'onboarding', summary: '引导走完了:都记下了', duration_seconds: 1620 } })];
    expect(byId(state({ tasks: { tasks: recorded }, onboarding })).get('call')!.lines[0]!.text).toBe('引导走完了:都记下了');
    // 没走完引导:不补。
    expect(byId(state({ onboarding: { stage: 'habits', done: false } })).get('call')!.lines).toEqual([]);
  });

  it('一张纪要都没有才说没有 —— 不再是「还没有通过电话」,也不是「还没接上」', () => {
    const call = byId(state()).get('call')!;
    expect(call.lines).toEqual([]);
    expect(call.empty).toBe(CALL_NONE_TEXT);
    expect(call.to).toBeUndefined();
  });
});

describe('资讯', () => {
  const view = (over: Partial<NewsView> = {}): NewsView => ({ date: '2026-09-24', groups: [], config: { version: 1, enabled: true, per_project: 5, podcast: true, podcast_minutes: 4, interests: [{ project_id: 'p', project_name: '工作台', keywords: ['agent'] }] }, last_run_at: 1, ...over });
  const aidj: AidjView = {
    status: 'ready', fetched_at: 1, config: { enabled: true, base_url: '', push_interests: true, token_set: true },
    program: { date: '2026-09-24', status: 'ready', topics: [{ id: 't1', title: 'OpenAI 发了新的 Agent SDK', summary: '', url: '', source: '' }], segments: [{ id: 's1', speaker: '小满', text: '早', duration_ms: 1000 }], hosts: ['小满', '阿本'], estimated_total_ms: 12 * 60_000 },
  };

  it('★早上那期双主播播客在:写「今天的资讯播客」+ 几分钟 + 头条;点下去是资讯页', () => {
    const feed = feedCard({ asked: true, unavailable: false, view: view(), aidj }, '2026-09-24T19:05:00+08:00');
    expect(feed.lines.map((l) => l.text)).toEqual(['今天的资讯播客', 'OpenAI 发了新的 Agent SDK']);
    // 附注只写多长(主播在资讯页里):那一格最多占一行的 40%,「小满 / 阿本 · 约 12 分钟」在手机上永远放不下。
    expect(feed.lines[0]!.note).toBe('12 分钟');
    expect(feed.to).toEqual({ page: 'news' });
  });

  it('最多两条:有跟项目有关的几条时,第二条写那个(头条让位),卡片放得下', () => {
    const item = { id: 'n1', project_id: 'p', project_name: '工作台', title: 'Agent 工作台的三种交互', url: '', why: '', score: 1, follow_up: false, date: '2026-09-24', at: 1 };
    const feed = feedCard({ asked: true, unavailable: false, view: view({ groups: [{ project_id: 'p', project_name: '工作台', items: [item, { ...item, id: 'n2' }] }] }), aidj }, '2026-09-24T19:05:00+08:00');
    expect(feed.lines.map((l) => l.text)).toEqual(['今天的资讯播客', '2 条跟你的项目有关']);
    expect(feed.lines[1]!.note).toBe('Agent 工作台的三种交互');
  });

  it('只有工作台自己合成的那段:也写「今天的资讯播客」', () => {
    const feed = feedCard({ asked: true, unavailable: false, view: view({ podcast: { date: '2026-09-24', script: '稿子', file: 'x.mp3', at: Date.parse('2026-09-24T00:30:00Z') } }), aidj: null }, '2026-09-24T19:05:00+08:00');
    expect(feed.lines[0]?.text).toBe('今天的资讯播客');
  });

  it('还没问到 / 老工作台没接 / 真没有:三句话各说各的,真没有时说清为什么', () => {
    expect(feedCard(undefined, '').empty).toBe(FEED_ASKING_TEXT);
    expect(feedCard({ asked: true, unavailable: true }, '').empty).toBe(FEED_UNAVAILABLE_TEXT);
    expect(feedCard({ asked: true, unavailable: false, view: view({ last_error: '中转没配搜索' }), aidj: null }, '').empty).toBe('中转没配搜索');
  });
});

/**
 * 2026-10-03 傍晚(卡「首页两卡 + 一排图标」= 维护者看过示意图之后拍的方案 B)。她的原话:
 *
 * > 只保留正在办和待确认两个是卡片,其他都和前面一样做成 icon 就 OK……中间的球球还是要大的,
 * > 这个事情是要适配 Live2D 的显示空间,省出来的空间 Live2D 也能放大。
 *
 * 所以**主列上只画两张、并排各占一半**({@link homeCards});另三张(今天要做 / 最近一次通话 / 资讯)
 * 搬成球下那一排图标(tests/homeRail.test.tsx 那一份),内容在各自那一页上。
 * `stageCards` 照旧产出五样 —— 它是「那五样各自是什么」的全份口径,上面那几节一个字没改。
 */
describe('画出来是什么样', () => {
  it('★主列上只有两张:正在办 / 等你确认;**都不占整行**(并排各一半);数与行照着 /state 画', () => {
    render(<StageCards state={state({ tasks: { tasks: [mine({ id: 'a', title: '写口播稿', due: '2026-09-22' })] } })} />);
    expect(screen.getByText('正在办')).toBeTruthy();
    expect(screen.getByText('等你确认')).toBeTruthy();
    const cards = [...document.querySelectorAll('.ba-cards__card')];
    expect(cards.map((one) => one.getAttribute('data-card'))).toEqual(['doing', 'confirm']);
    expect(cards.map((one) => one.getAttribute('data-wide'))).toEqual(['false', 'false']);
  });

  it('★另三张**不在主列里**(搬成球下那一排图标了):卡片区里找不到它们的标题', () => {
    render(<StageCards state={state({ tasks: { tasks: [mine({ id: 'a', title: '写口播稿', due: '2026-09-22' })] } })} onOpen={() => {}} />);
    for (const title of ['今天要做', '最近一次通话', '资讯']) {
      expect(screen.queryByText(title)).toBeNull();
      expect(screen.queryByRole('button', { name: `打开「${title}」` })).toBeNull();
    }
    // 那三样本身没被删掉 —— `stageCards` 照旧产出五样(那是它们各自是什么的那一份口径)。
    expect(stageCards(state()).map((one) => one.id)).toEqual(['doing', 'confirm', 'today', 'call', 'feed']);
    expect(HOME_CARD_IDS).toEqual(['doing', 'confirm']);
  });

  it('「正在办」半宽时「哪一家在办」跟在标题后面(标题优先),不再独占右边一格', () => {
    const sessions = [session({ session_id: 'cx-1', title: '写登录页' })];
    render(<StageCards state={state({ sessions })} />);
    const doing = document.querySelector('.ba-cards__card[data-card="doing"]')!;
    // 附注画在标题那一格**里面**(`.ba-cards__text > .ba-cards__note`),于是地方不够时它先没。
    expect(doing.querySelector('.ba-cards__text > .ba-cards__note')).toBeTruthy();
    expect(doing.querySelector('.ba-cards__line > .ba-cards__note')).toBeNull();
  });

  it('★整张卡都能点:两块卡各一颗铺满的按钮,点哪块去哪块的去处;没传 onOpen 时一颗都不画', () => {
    const seen: StageCardTarget[] = [];
    const { unmount } = render(<StageCards state={state({ tasks: { tasks: [mine({ id: 'a', title: '写口播稿' })] } })} onOpen={(to) => seen.push(to)} />);
    fireEvent.click(screen.getByRole('button', { name: '打开「正在办」' }));
    fireEvent.click(screen.getByRole('button', { name: '打开「等你确认」' }));
    expect(seen).toEqual([
      { page: 'inbox', tab: 'doing' },
      { page: 'inbox', tab: 'waiting' },
    ]);
    // 那颗「去看」不再有了(整张卡就是那颗键)。
    expect(screen.queryByRole('button', { name: '去看' })).toBeNull();
    unmount();
    render(<StageCards state={state()} />);
    expect(screen.queryByRole('button', { name: /^打开「/ })).toBeNull();
  });

  it('那三张卡自己的去处一个字没改(球下那一排照它们走)', () => {
    const tasks = [mine({ id: 'c', title: '引导通话(27 分钟)', status: 'done', origin: 'call', call: { kind: 'onboarding', summary: '引导走完了', duration_seconds: 1620 } })];
    const cards = byId(state({ tasks: { tasks } }), { asked: true, unavailable: false });
    expect(cards.get('today')!.to).toEqual({ page: 'inbox', tab: 'queued' });
    expect(cards.get('call')!.to).toEqual({ page: 'calls', callId: 'c' });
    expect(cards.get('feed')!.to).toEqual({ page: 'news' });
    // 没有数可数的那两块照旧不画数字。
    expect(cards.get('call')!.count).toBeUndefined();
    expect(cards.get('feed')!.count).toBeUndefined();
  });
});

/**
 * 2026-09-25 晚(卡 fix/phone-home-card-fit):统筹在小米 10S 真机上看到卡片里的字被硬裁(「今天要做」第二行露出上半截、
 * 「18:51」切掉一半、资讯那句拦腰切断)。现在每张卡标题下面固定几行,卡片高度由行数算、五张一样高。
 */
describe('行数固定', () => {
  it('fitRows:摆得下全摆;摆不下摆 rows-1 件,最后一行留给「还有 N 件」', () => {
    expect(fitRows([1, 2, 3], 3)).toEqual({ shown: [1, 2, 3] });
    expect(fitRows([1, 2, 3, 4], 3)).toEqual({ shown: [1, 2], more: 2 });
    expect(fitRows([1, 2, 3], 2)).toEqual({ shown: [1], more: 2 });
    expect(fitRows([], 3)).toEqual({ shown: [] });
  });

  it('cardRowsFor:舞台矮于 53.75 个字号高(860px)就两行;量不到就三行;大字档门槛跟着抬', () => {
    expect(SHORT_SCENE_REM * 16).toBe(860);
    expect(cardRowsFor(915, 16)).toBe(CARD_ROWS);
    expect(cardRowsFor(860, 16)).toBe(CARD_ROWS);
    expect(cardRowsFor(845, 16)).toBe(CARD_ROWS_SHORT);
    expect(cardRowsFor(740, 16)).toBe(CARD_ROWS_SHORT);
    expect(cardRowsFor(915, 18.4)).toBe(CARD_ROWS_SHORT);
    expect(cardRowsFor(0, 16)).toBe(CARD_ROWS);
    expect(cardRowsFor(Number.NaN, 16)).toBe(CARD_ROWS);
  });

  it('每张卡的行数都不超过给的行数(含「还有 N 件」那一行)', () => {
    const tasks = Array.from({ length: 9 }, (_, i) => mine({ id: `t-${i}`, title: `事项 ${i}` }));
    const items = Array.from({ length: 6 }, (_, i) => ({ id: `i-${i}`, kind: 'confirm' as const, title: `确认 ${i}` }));
    const sessions = Array.from({ length: 7 }, (_, i) => session({ session_id: `cx-${i}` }));
    for (const rows of [CARD_ROWS, CARD_ROWS_SHORT]) {
      for (const card of stageCards(state({ tasks: { tasks }, butler_inbox: { items }, sessions }), undefined, rows)) {
        expect(card.lines.length + (card.more === undefined ? 0 : 1)).toBeLessThanOrEqual(rows);
      }
    }
  });

  it('截止日写短:2026-09-22 → 9/22;认不出的原样', () => {
    expect(shortDue('2026-09-22')).toBe('9/22');
    expect(shortDue('2026-10-01T08:00:00Z')).toBe('10/1');
    expect(shortDue('下周一')).toBe('下周一');
    expect(byId(state({ tasks: { tasks: [mine({ id: 'a', title: '写口播稿', due: '2026-09-22' })] } })).get('today')!.lines[0]!.note).toBe('9/22');
  });

  it('「最近一次通话」附注另起一行(stacked),别的卡附注跟在同一行右边', () => {
    const cards = stageCards(state());
    expect(cards.filter((c) => c.stacked === true).map((c) => c.id)).toEqual(['call']);
  });

  it('行数跟着舞台的高度走:740px(字号 16)两行、915px 三行;舞台藏起来量到 0 时不改', () => {
    let notify: (() => void) | undefined;
    class FakeResizeObserver { constructor(cb: () => void) { notify = cb; } observe() {} unobserve() {} disconnect() {} }
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    document.documentElement.style.fontSize = '16px';
    let height = 740;
    const scene = document.createElement('div');
    scene.className = 'ba-scene';
    scene.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, left: 0, width: 360, height, right: 360, bottom: height, toJSON: () => ({}) }) as DOMRect;
    document.body.appendChild(scene);
    try {
      render(<StageCards state={state()} />, { container: scene });
      const rows = () => document.querySelector('.ba-cards')?.getAttribute('data-rows');
      expect(rows()).toBe(String(CARD_ROWS_SHORT));
      height = 0;
      act(() => notify?.());
      expect(rows()).toBe(String(CARD_ROWS_SHORT));
      height = 915;
      act(() => notify?.());
      expect(rows()).toBe(String(CARD_ROWS));
    } finally {
      cleanup();
      scene.remove();
      document.documentElement.style.fontSize = '';
      vi.unstubAllGlobals();
    }
  });

  it('画出来:卡片区带 data-rows(量不到时 3);「还有 N 件」是清单里的最后一行', () => {
    // 2026-10-03 傍晚(方案 B):「今天要做」不在主列了,这一条改用「等你确认」那一张钉同一套规矩。
    const items = Array.from({ length: 5 }, (_, i) => ({ id: `confirm:t${i}`, kind: 'confirm' as const, title: `确认 ${i}`, task_id: `t${i}` }));
    render(<StageCards state={state({ butler_inbox: { items } as WorkbenchState['butler_inbox'] })} />);
    expect(document.querySelector('.ba-cards')?.getAttribute('data-rows')).toBe(String(CARD_ROWS));
    const confirm = document.querySelector('.ba-cards__card[data-card="confirm"]')!;
    const rows = [...confirm.querySelectorAll('.ba-cards__list > li')].map((li) => li.textContent);
    expect(rows).toEqual(['确认 0', '确认 1', '还有 3 件']);
    expect(confirm.querySelector('.ba-cards__list > li:last-child')?.classList.contains('ba-cards__more')).toBe(true);
    // 「最近一次通话」那张卡照旧是 stacked(它的内容现在在通话记录那一页上)。
    expect(stageCards(state()).find((one) => one.id === 'call')?.stacked).toBe(true);
  });
});

/** jsdom 不排版:排布那几条按 CSS 文本钉规则在不在(同 stageLayout.test.tsx)。真排出来的样子看交接里的无头 Chrome 截图。 */
describe('行数固定:CSS 那一层', () => {
  const CSS = readFileSync(resolve(__dirname, '../src/stage/stageCards.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ');
  const block = (selector: string) => {
    const at = CSS.indexOf(`${selector} {`);
    expect(at, `没找到 ${selector}`).toBeGreaterThan(-1);
    return CSS.slice(at, CSS.indexOf('}', at));
  };

  /**
   * 2026-09-25 夜(卡 fix/phone-home-orb-first,统筹小米真机:每一行的下沿被切掉一截):卡片里**不写任何高度**。
   * 行数靠垫在底下的那几行「国」字(按真字体排),五张一样高靠网格的 1fr,截断靠「不换行 + 省略号」与 line-clamp。
   */
  it('卡片区不按屏高平分、不写死行高:网格行 1fr(= 最高那张的内容高),行高是倍数', () => {
    expect(CSS).not.toMatch(/max-height: 46%/);
    expect(CSS).not.toMatch(/--ba-card-h|--ba-card-lh/);
    expect(block('.ba-cards')).toMatch(/grid-auto-rows: 1fr/);
    expect(block('.ba-cards')).toMatch(/line-height: 1\.5/);
    expect(CSS).toMatch(/\.ba-cards\[data-rows="2"\] \{[^}]*--ba-card-rows: 2/);
    // 垫行:三行 / 两行的「国」。
    expect(CSS).toMatch(/\.ba-cards__space::before \{[^}]*content: '国\\A国\\A国'/);
    expect(CSS).toMatch(/\.ba-cards\[data-rows="2"\] \.ba-cards__space::before \{[^}]*content: '国\\A国'/);
  });

  it('一行的:不换行 + 省略号,上下垫 .2em 再收回(字形比行高高的字体不被切);卡片里没有 height / max-height', () => {
    expect(block('.ba-cards__text')).toMatch(/white-space: nowrap/);
    expect(block('.ba-cards__text')).toMatch(/text-overflow: ellipsis/);
    expect(block('.ba-cards__text')).toMatch(/padding-block: \.2em; margin-block: -\.2em/);
    for (const selector of ['.ba-cards__line', '.ba-cards__list', '.ba-cards__head', '.ba-cards__card', '.ba-cards__empty']) {
      expect(block(selector)).not.toMatch(/(^|[\s;{])(max-)?height:/);
    }
  });

  it('没有内容时那句话、「最近一次通话」那句摘要:按行数截(line-clamp)、带省略号,行高 normal(截在行底不切字)', () => {
    expect(block('.ba-cards__empty')).toMatch(/-webkit-line-clamp: var\(--ba-card-rows\)/);
    expect(block('.ba-cards__empty')).toMatch(/line-height: normal/);
    expect(CSS).toMatch(/\[data-stacked="true"\] \.ba-cards__text \{[^}]*-webkit-line-clamp: var\(--ba-card-rows-less\)/);
    expect(CSS).toMatch(/\[data-stacked="true"\] \.ba-cards__text \{[^}]*line-height: normal/);
  });
});

describe('引导落地那张单子在「等你确认」那一格置顶(卡 feat/onboarding-materialize,2026-09-25)', () => {
  const plan = {
    id: 'plan-1', status: 'pending' as const, line: '都摆好了', source: 'rules', counts: { projects: 2, tasks: 10, cancel: 7 },
    groups: [], rows: [], created_at: '2026-09-24T12:30:00Z',
  };
  const confirmItem = { id: 'confirm:t1', kind: 'confirm' as const, title: '定核心体验流程(四段)', task_id: 't1' };

  it('等他点头:置顶一行「我照你说的摆好了」(半宽那一格只摆得下这一行,不另写小字),数里算上它,整张卡点下去是那张单子', () => {
    const card = byId(state({ materialize: plan, butler_inbox: { items: [confirmItem] } as WorkbenchState['butler_inbox'] })).get('confirm');
    expect(card?.lines.map((line) => line.text)).toEqual([SETUP_LINE_TEXT, '定核心体验流程(四段)']);
    expect(card?.lines[0]?.note).toBeUndefined();
    expect(card?.count).toBe(2);
    expect(card?.to).toEqual({ page: 'setup' });
    expect(setupLine(state({ materialize: { ...plan, status: 'applying' } }))?.note).toBe('正在落…');
  });

  it('单子 + 三件待确认、三行(卡 fix/phone-home-card-fit):单子置顶、再一件、最后一行「还有 2 件」;数是 4', () => {
    const items = Array.from({ length: 3 }, (_, i) => ({ id: `confirm:t${i}`, kind: 'confirm' as const, title: `交回来的第 ${i} 件`, task_id: `t${i}` }));
    const card = byId(state({ materialize: plan, butler_inbox: { items } as WorkbenchState['butler_inbox'] })).get('confirm')!;
    expect(card.lines.map((line) => line.text)).toEqual([SETUP_LINE_TEXT, '交回来的第 0 件']);
    expect(card.more).toBe(2);
    expect(card.count).toBe(4);
  });

  it('otherConfirms:单子之外那几件,各带事项 id(单子那一页据此打开那一张)', () => {
    const got = otherConfirms(state({ materialize: plan, butler_inbox: { items: [confirmItem, { id: 'confirm:t2', kind: 'confirm', title: 'Kimi 的回答', note: '1 件交付物', task_id: 't2' }] } as WorkbenchState['butler_inbox'] }))
    expect(got).toEqual([
      { id: 'confirm:t1', kind: 'confirm', text: '定核心体验流程(四段)', taskId: 't1' },
      { id: 'confirm:t2', kind: 'confirm', text: 'Kimi 的回答', note: '1 件交付物', taskId: 't2' },
    ]);
    expect(otherConfirmsTitle(2)).toBe('另外 2 件等你确认');
  });

  it('落好了:那一行不在「等你确认」里,卡片照旧去事项页', () => {
    const card = byId(state({ materialize: { ...plan, status: 'applied' }, butler_inbox: { items: [confirmItem] } as WorkbenchState['butler_inbox'] })).get('confirm');
    expect(card?.lines.map((line) => line.text)).toEqual(['定核心体验流程(四段)']);
    expect(card?.count).toBe(1);
    expect(card?.to).toEqual({ page: 'inbox', tab: 'waiting' });
  });
});
