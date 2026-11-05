import { describe, expect, it } from 'vitest';
import type { WorkbenchState, TaskView } from '../src/api/protocol';
import { UNLOCK_WAIT_LABEL } from '../src/api/protocol';
import { inboxCards, mineGroups, itemCard, statusDot, conversationOf } from '../src/items/itemsModel';

function task(partial: Partial<TaskView> & Pick<TaskView, 'id' | 'status'>): TaskView {
  return { title: partial.id, created_at: '2026-09-14T01:00:00Z', updated_at: '2026-09-14T01:00:00Z', direction: 'mine', ...partial };
}

const state: WorkbenchState = {
  now: '2026-09-14T02:00:00Z', stale: false,
  sessions: [
    { agent: 'dsh', session_id: 's-1', project: 'p', status: 'running', elapsed_sec: 3, unread: false, updated_at: '2026-09-14T01:30:00Z' },
    { agent: 'dsh', session_id: 's-2', project: 'p', status: 'waiting', wait_reason: 'approval', elapsed_sec: 60, unread: false, updated_at: '2026-09-14T01:40:00Z' },
  ],
  tasks: { tasks: [
    task({ id: 't-1', status: 'doing', title: '补版本号', conversation: { agent: 'dsh', session_id: 's-1' }, updated_at: '2026-09-14T01:30:00Z' }),
    task({ id: 't-2', status: 'confirm', title: '整理交接', conversation: { agent: 'dsh', session_id: 's-2' }, updated_at: '2026-09-14T01:40:00Z' }),
    task({ id: 't-3', status: 'todo', title: '没开会话的', updated_at: '2026-09-14T01:10:00Z' }),
    task({ id: 't-4', status: 'done', title: '办完的', conversation: { agent: 'dsh', session_id: 's-9', archived_at: '2026-09-14T01:50:00Z' }, updated_at: '2026-09-14T01:50:00Z' }),
    task({ id: 't-5', status: 'blocked', title: '卡住的', block_reason: 'input', updated_at: '2026-09-14T01:20:00Z' }),
    task({ id: 'k-1', status: 'doing', title: '看板上普通的卡', direction: undefined }),
  ] },
  butler_inbox: { items: [
    { id: 'session:s-2', kind: 'session', title: '「整理交接」在等审批', wait_reason: 'approval', conversation: { agent: 'dsh', session_id: 's-2' } },
    { id: 'confirm:t-2', kind: 'confirm', title: '整理交接', status: 'confirm', task_id: 't-2', at: '2026-09-14T01:40:00Z', conversation: { agent: 'dsh', session_id: 's-2' } },
    { id: 'sentinel:w1', kind: 'sentinel', title: '磁盘剩 5%', at: '2026-09-14T01:45:00Z' },
    { id: 'risk:p1', kind: 'risk', title: 'Aiboo 赶不上', note: '预计 09-20' },
  ] },
};

describe('「事务官交给我的」', () => {
  it('顺序照服务端给的(等着的会话 → 等我确认 → 哨兵 → 排期),不重排', () => {
    expect(inboxCards(state).map((c) => c.id)).toEqual(['session:s-2', 'confirm:t-2', 'sentinel:w1', 'risk:p1']);
  });
  it('状态点:等我确认 = 蓝,其余 = 黄;有会话的才点得开', () => {
    const cards = inboxCards(state);
    expect(cards.map((c) => c.dot)).toEqual(['yellow', 'blue', 'yellow', 'yellow']);
    expect(cards.map((c) => c.sessionId)).toEqual(['s-2', 's-2', undefined, undefined]);
  });
  it('等待原因与七态翻成中文;note 原样带', () => {
    const cards = inboxCards(state);
    expect(cards[0].waitLabel).toBe('等审批');
    expect(cards[1].label).toBe('事务官核验中');
    expect(cards[3].note).toBe('预计 09-20');
  });
  it('confirm 带四类拍板请求(带方案与依据)的,才算「等我确认」标出来;没标的是事务官待核验队列(2026-10-26,卡「事务官页接管队列」)', () => {
    const marked: WorkbenchState = {
      ...state,
      butler_inbox: { items: [
        { id: 'confirm:t-2', kind: 'confirm', title: '整理交接', status: 'confirm', task_id: 't-2', at: '2026-09-14T01:40:00Z',
          owner_ask: { kind: 'publish', proposal: '发这一版', basis: '整包绿', by: 'butler', at: '2026-09-14T01:45:00Z' },
          conversation: { agent: 'dsh', session_id: 's-2' } },
      ] },
    };
    expect(inboxCards(marked)[0].label).toBe('等我确认');
    expect(inboxCards(state)[1].label).toBe('事务官核验中');
  });
  it('没有 butler_inbox 字段 → 空列表', () => {
    expect(inboxCards({ now: '', stale: true, sessions: [] })).toEqual([]);
  });
});

describe('「我交给事务官的」', () => {
  it('只算 direction=mine;等我确认的不在下半区;在办按最近改动排;办完单独一摞', () => {
    const groups = mineGroups(state);
    expect(groups.open.map((t) => t.id)).toEqual(['t-1', 't-5', 't-3']);
    expect(groups.finished.map((t) => t.id)).toEqual(['t-4']);
  });
  it('卡面:进行中白点、阻塞黄点、其余灰;没会话标「会话未开」、归档标「会话已归档」', () => {
    const [doing, blocked, todo] = mineGroups(state).open.map((t) => itemCard(t));
    expect(doing.dot).toBe('white');
    expect(blocked.dot).toBe('yellow');
    expect(blocked.waitLabel).toBe('等你输入');
    expect(todo.dot).toBe('gray');
    expect(todo.note).toBe('会话未开');
    const done = itemCard(mineGroups(state).finished[0]);
    expect(done.note).toBe('会话已归档');
    expect(done.label).toBe('完成');
  });
  /**
   * 「随手问一句不算一件事」(2026-09-25,卡 Y)。她答完自己收掉的那张卡进「完成」并盖 `casual` 章 ——
   * 手机上那一格说的是「只是问了一句」,不是「完成」:他没交代过一件活,写「完成」就是替一次闲聊记一笔功。
   */
  it('★「只是问了一句」那一张:那一格说「只是问了一句」,不说「完成」', () => {
    const casual = itemCard(task({ id: 't-9', status: 'done', casual: true, title: '一周有几天?', conversation: { agent: 'dsh', session_id: 's-9' } }));
    expect(casual.label).toBe('只是问了一句');
    // 没盖章的完成卡照旧说「完成」。
    expect(itemCard(task({ id: 't-10', status: 'done', title: '办完的' })).label).toBe('完成');
  });

  it('statusDot 与电脑端同一套', () => {
    expect(statusDot('doing')).toBe('white');
    expect(statusDot('blocked')).toBe('yellow');
    expect(statusDot('confirm')).toBe('blue');
    expect(statusDot('todo')).toBe('gray');
    expect(statusDot('done')).toBe('gray');
  });
});

describe('事项底下那段会话', () => {
  it('按 conversation.session_id 到 sessions 里现查;查不到就 undefined', () => {
    const t1 = state.tasks!.tasks[0];
    expect(conversationOf(state, t1)?.status).toBe('running');
    expect(conversationOf(state, state.tasks!.tasks[2])).toBeUndefined();
    expect(conversationOf(state, state.tasks!.tasks[3])).toBeUndefined();
  });
});

describe('派活排着等电脑解锁(2026-10-12,卡「锁屏派活排队」)', () => {
  it('★卡上挂着 dispatch_block.unlock → 「等什么」那一格说「等你解锁电脑(解锁就送)」,不说「等你输入」', () => {
    const card = itemCard(task({
      id: 't-lock', status: 'blocked', block_reason: 'input', direction: undefined,
      dispatch_block: { family: 'doubao', kind: 'chat', why: '电脑锁着屏…', unlock: true, at: '2026-10-12T01:00:00Z' },
    }));
    expect(card.waitLabel).toBe(UNLOCK_WAIT_LABEL);
  });
  it('没有那一格 → 照旧', () => {
    expect(itemCard(task({ id: 't-x', status: 'blocked', block_reason: 'input' })).waitLabel).toBe('等你输入');
  });
});
