/**
 * 后台任务挂在主会话卡里(2026-09-25,卡 Q;维护者:「一张卡片里有后台任务的说明,就是多一层的意思」)—— 手机这一半。
 *
 * 一条带 3 个后台任务的假会话(两个在跑、一个办完了;主会话自己已经说完了):首页「正在办」只数 1、那一行说「内含 3 项后台任务 · 在跑 2」;
 * 「各家正在办」一张卡;点开那条会话,「展开」之后三行。不露 id、型号。电脑那一半在 workbench-plugin/tests/client-session-children.test.tsx。
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { emptyState, type AgentEntryView, type SessionChildView, type WorkbenchState } from '../src/api/protocol';
import { PhoneSessionChildren } from '../src/items/InboxPage';
import { externalSessionCard } from '../src/items/itemsModel';
import { agentTitle, externalRunning, stageCards } from '../src/stage/stageCardsModel';

const NOW = '2026-09-25T12:30:00.000Z';

const CHILDREN: SessionChildView[] = [
  { id: 'a0734735cd33abd5', parent_session_id: 'parent-1', title: '卡 O:派活的眼睛', status: 'running', activity: { line: '在改文件', at: '2026-09-25T12:29:00.000Z' }, started_at: '2026-09-25T12:02:00.000Z', model: 'claude-opus-5-5' },
  { id: 'a0a4b8f355a4a0df0', parent_session_id: 'parent-1', title: '卡 T:在等你看内容', status: 'running', activity: { line: '在跑测试', at: '2026-09-25T12:28:00.000Z' }, started_at: '2026-09-25T12:01:00.000Z' },
  { id: 'acef92c3bb2825186', parent_session_id: 'parent-1', title: '卡 P:会话标题', status: 'done', started_at: '2026-09-25T11:00:00.000Z', ended_at: '2026-09-25T11:40:00.000Z' },
];

function stateWith(children: readonly SessionChildView[]): WorkbenchState {
  const claude: AgentEntryView = {
    id: 'claude', name: 'Claude', status: 'idle', gaps: {},
    sessions: [{
      agent: 'claude', session_id: 'parent-1', project: 'desktop-workbench', status: 'done', via: 'sessions', title: '统筹 0925',
      elapsed_sec: 1200, unread: false, updated_at: '2026-09-25T12:10:00.000Z', children,
    }],
    counts: { running: 0, waiting: 0, unread: 0 },
  };
  const self: AgentEntryView = { id: 'dsh', name: '事务官', self: true, status: 'idle', gaps: {}, sessions: [], counts: { running: 0, waiting: 0, unread: 0 } };
  return { ...emptyState(), stale: false, now: NOW, sessions: [], agent_registry: { entries: [self, claude], asking: [], notices: [] } } as WorkbenchState;
}

describe('手机:一张卡多一层', () => {
  it('★首页「正在办」只数这一条主会话一次,那一行带「内含 3 项后台任务 · 在跑 2」', () => {
    const s = stateWith(CHILDREN);
    const doing = stageCards(s).find((card) => card.id === 'doing')!;
    expect(doing.count).toBe(1);
    expect(doing.lines).toHaveLength(1);
    expect(doing.lines[0]?.note).toBe('Claude · 内含 3 项后台任务 · 在跑 2');
  });

  it('★「各家正在办」一张卡,卡上那一行;子任务不单独成卡', () => {
    const s = stateWith(CHILDREN);
    const cards = externalRunning(s).map((one) => externalSessionCard(one, NOW, agentTitle(one.agent, s)));
    expect(cards).toHaveLength(1);
    expect(cards[0]?.childrenLine).toBe('内含 3 项后台任务 · 在跑 2');
  });

  it('★点开:「展开」之后三行(描述 + 在跑 / 办完了 · 在做什么);不露 id、型号', () => {
    render(<PhoneSessionChildren items={CHILDREN} now={NOW} />);
    const section = screen.getByRole('region', { name: '后台任务' });
    expect(within(section).queryAllByRole('listitem')).toHaveLength(0);
    fireEvent.click(within(section).getByRole('button', { name: '展开' }));
    const rows = within(section).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect(rows[0]?.textContent).toContain('卡 O:派活的眼睛');
    expect(rows[0]?.textContent).toContain('在跑 · 在改文件 · 1 分钟前');
    expect(rows[2]?.textContent).toContain('办完了');
    expect(document.body.textContent).not.toContain('a0734735cd33abd5');
    expect(document.body.textContent).not.toContain('claude-opus');
  });

  it('后台任务都办完了、主会话也说完了:不算在办', () => {
    const s = stateWith(CHILDREN.map((child) => ({ ...child, status: 'done' as const })));
    expect(externalRunning(s)).toEqual([]);
    expect(stageCards(s).find((card) => card.id === 'doing')!.count).toBe(0);
  });
});
