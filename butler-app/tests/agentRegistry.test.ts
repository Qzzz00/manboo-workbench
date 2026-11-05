/**
 * 手机这一半的机制证明(2026-09-25,卡 Q「Agent 自动发现与统一接入」,设计第 7 条)。
 *
 * 电脑上运行时接上的一家(这里是「Foo AI」:读它的窗口读出来的、代码里没有它的名字),登记表一带过来,
 * 手机首页「正在办」、事项页「各家正在办」就有它 —— 名字、它那条对话的标题、在做什么都是登记表里的;
 * 他说「这不是 Agent」之后(登记表里没了它),手机上也就没有它。手机里没有任何一张「是哪几家」的名字表。
 */
import { describe, expect, it } from 'vitest';
import { externalSessionCard, inboxItemCard } from '../src/items/itemsModel';
import { agentColor, agentsBlockedLine, agentTitle, externalRunning, stageCards } from '../src/stage/stageCardsModel';
import { emptyState, type AgentEntryView, type WorkbenchState } from '../src/api/protocol';

const NOW = '2026-09-25T02:03:00.000Z';

/** 服务端登记表里那一家(形状同 workbench-plugin 的 AgentEntryView;读窗口读出来的当前那条对话)。 */
const FOO: AgentEntryView = {
  id: 'com.example.fooai',
  bundle_id: 'com.example.fooai',
  name: 'Foo AI',
  app_running: true,
  status: 'running',
  title: '周报怎么写',
  latest: '好的,这是本周周报的草稿。',
  read_at: NOW,
  bubble: { kind: 'started', text: 'Foo AI 开始跑了', at: NOW },
  gaps: {},
  sessions: [{
    agent: 'com.example.fooai', session_id: 'window:1a2b3c4d', project: 'Foo AI', status: 'running', via: 'window',
    title: '周报怎么写', summary: '好的,这是本周周报的草稿。', elapsed_sec: 60, unread: false, updated_at: NOW,
    activity: { line: '好的,这是本周周报的草稿。', at: '2026-09-25T02:01:00.000Z' },
  }],
  counts: { running: 1, waiting: 0, unread: 0 },
};

const SELF: AgentEntryView = { id: 'dsh', name: '事务官', self: true, status: 'idle', gaps: {}, sessions: [], counts: { running: 0, waiting: 0, unread: 0 } };

function state(entries: AgentEntryView[]): WorkbenchState {
  return { ...emptyState(), stale: false, now: NOW, sessions: [], agent_registry: { entries, asking: [], notices: [] } } as WorkbenchState;
}

describe('手机读登记表', () => {
  it('★运行时接上的一家:首页「正在办」有它那一行,名字与标题都是登记表里的', () => {
    const doing = stageCards(state([SELF, FOO])).find((card) => card.id === 'doing')!;
    expect(doing.lines.map((line) => [line.text, line.note])).toEqual([['周报怎么写', 'Foo AI']]);
    expect(doing.count).toBe(1);
  });

  it('★事项页「各家正在办」:同一个口径,那一行写「Foo AI · 进行中」与它在做什么', () => {
    const s = state([SELF, FOO]);
    const cards = externalRunning(s).map((one) => externalSessionCard(one, NOW, agentTitle(one.agent, s)));
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ title: '周报怎么写', label: 'Foo AI · 进行中 · 1 分钟', note: '好的,这是本周周报的草稿。 · 2 分钟前' });
  });

  it('★他说「这不是 Agent」(登记表里没了它):手机上也没有它', () => {
    const s = state([SELF]);
    expect(externalRunning(s)).toEqual([]);
    expect(stageCards(s).find((card) => card.id === 'doing')!.count).toBe(0);
  });

  it('事务官自己不单列(她的会话挂在事项上)', () => {
    const self: AgentEntryView = { ...SELF, sessions: [{ ...FOO.sessions[0]!, agent: 'dsh', session_id: 'd-1', via: 'sessions' }] };
    expect(externalRunning(state([self]))).toEqual([]);
  });
});

describe('外层那一句(登记表那一档)', () => {
  it('★「新接上一家:Foo AI」在手机上也是一张点得开的卡,带着那几颗键要用的 id(「要接上吗」那一问在「等你确认」里,见 agentAsk.test.tsx)', () => {
    const notice = inboxItemCard({ id: 'agent:new:n-1', kind: 'agent', title: '新接上一家:Foo AI', agent: { id: 'com.example.fooai', notice_id: 'n-1' } });
    expect(notice).toMatchObject({ title: '新接上一家:Foo AI', agent: { id: 'com.example.fooai', notice_id: 'n-1' } });
    // 别的档不带这一格。
    expect(inboxItemCard({ id: 'x', kind: 'confirm', title: '验收' }).agent).toBeUndefined();
  });
});

describe('电脑上读不了别家窗口时:「各家正在办」那里说清为什么,不是空白', () => {
  it('★没开「辅助功能」权限:照电脑上那一句,再说去电脑上哪儿点', () => {
    const s = { ...state([SELF]), agent_registry: { entries: [SELF], asking: [], notices: [], blocked: { kind: 'accessibility' as const, text: '还看不到 Muse、Manus 在忙什么:得给工作台开「辅助功能」权限', apps: ['Muse', 'Manus'] } } };
    expect(agentsBlockedLine(s)).toBe('还看不到 Muse、Manus 在忙什么:得给工作台开「辅助功能」权限 —— 在电脑上工作台顶上点「去打开」就行');
  });

  it('壳是旧版:原样那一句;不缺什么时没有这一句', () => {
    const old = { ...state([SELF]), agent_registry: { entries: [SELF], asking: [], notices: [], blocked: { kind: 'old_shell' as const, text: '这台电脑上的工作台 App 是旧版,还看不到别家 Agent 在忙什么 —— 装上新版工作台 App 就好' } } };
    expect(agentsBlockedLine(old)).toBe('这台电脑上的工作台 App 是旧版,还看不到别家 Agent 在忙什么 —— 装上新版工作台 App 就好');
    expect(agentsBlockedLine(state([SELF]))).toBeUndefined();
  });
});

describe('各家的颜色(卡 Q:从它 App 的图标来,电脑上它的小头像同一个色)', () => {
  it('★「各家正在办」那张卡前面的圆点用登记表里那一家的颜色;老工作台没给就照状态色', () => {
    const colored: AgentEntryView = { ...FOO, color: '#f0845f' };
    const s = state([SELF, colored]);
    const cards = externalRunning(s).map((one) => externalSessionCard(one, NOW, agentTitle(one.agent, s), agentColor(one.agent, s)));
    expect(cards[0]?.tint).toBe('#f0845f');
    expect(agentColor('com.example.fooai', state([SELF, FOO]))).toBeUndefined();
    expect(externalSessionCard(FOO.sessions[0]!, NOW, 'Foo AI').tint).toBeUndefined();
  });
});
