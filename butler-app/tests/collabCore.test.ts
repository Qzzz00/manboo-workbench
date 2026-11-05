/**
 * 真实 core 集成后的协作模型测试(2026-10-24,小K,阶段 2)。
 *
 * 数据源从「便签 acceptance 现算」升级为 core 的真实投影:
 * - GoalCondition + GoalBoardSummary(服务端现算状态,读侧口径唯一);
 * - NoteMessage + MessageDelivery(投递三态不混);
 * - TaskRelation(五种 + stale 现算);
 * - RunSegment(assigned→收场步,失联 24h = unknown);
 * - CapacityItem(在线/手上/未收场/上限 四事分开)。
 */
import { describe, expect, it } from 'vitest';
import {
  DELIVERY_STATUS_TITLES,
  RELATION_KIND_TITLES,
  RUN_STATUS_TITLES,
  capacityLine,
  conditionRowsFromBoard,
  deliveryTitle,
  guardActivityItems,
  guardBoardSummary,
  guardCapacity,
  guardLanMembers,
  guardRelations,
  guardRunSegments,
  runSegmentLine,
} from '../src/collab/collabCore';
import { guardGoalConditions, guardTaskCollab } from '../src/collab/collabState';

const GOAL: Record<string, unknown> = {
  id: 'goal:a',
  title: '目标甲',
  conditions: [
    {
      id: 'c-1', text: '能打开目标页', task_id: 't-1',
      verifications: [{ by: 'me', at: '2026-10-24T10:00:00+08:00', pass: true, round: 1 }],
      delivered_at: '2026-10-24T11:00:00+08:00',
      created_at: '2026-10-20T00:00:00+08:00', updated_at: '2026-10-24T10:00:00+08:00',
    },
    {
      id: 'c-2', text: '退回后旧核验失效', task_id: 't-2',
      verifications: [{ by: 'me', at: '2026-10-23T10:00:00+08:00', pass: true, round: 1 }],
      created_at: '2026-10-20T00:00:00+08:00', updated_at: '2026-10-23T10:00:00+08:00',
    },
    { id: 'c-3', text: '还没安排人做', created_at: '2026-10-20T00:00:00+08:00', updated_at: '2026-10-20T00:00:00+08:00' },
  ],
};

// 真实回包形状(契约 §1:`{summary:{…}}`,服务端现算)。
const BOARD_WIRE = {
  summary: {
    goal_id: 'goal:a',
    scope: '本目标',
    conditions: {
      total: 3,
      by_state: { pending: 1, doing: 0, blocked: 0, submitted: 0, rework: 1, verified: 0, delivered: 1 },
      items: [
        { id: 'c-1', text: '能打开目标页', state: 'delivered', task_id: 't-1', assignee: 'agent:kimi-1', last_receipt_at: '2026-10-24T09:00:00+08:00' },
        { id: 'c-2', text: '退回后旧核验失效', state: 'rework', task_id: 't-2', assignee: 'dsh' },
        { id: 'c-3', text: '还没安排人做', state: 'pending' },
        { id: 'c-bad', text: '坏条', state: 'not-a-state' },
      ],
    },
    tasks: { total: 2, by_status: { backlog: 0, todo: 0, doing: 1, confirm: 0, done: 1, blocked: 0, canceled: 0 }, canceled: 0, unscheduled: 1 },
  },
};
const BOARD = guardBoardSummary(BOARD_WIRE);

describe('guardGoalConditions:真实条件逐格守卫', () => {
  it('认得 conditions;坏格跳过;缺席 = 无条件', () => {
    const goals = guardGoalConditions([GOAL, { id: 'g-bad', title: 'x', conditions: [{ bad: true }] }, { id: 'g-none', title: 'y' }] as unknown as import('../src/collab/collabState').RawGoal[]);
    expect(goals[0]?.conditions).toHaveLength(3);
    expect(goals[1]?.conditions).toBeUndefined(); // 一条都认不出 = 无条件
    expect(goals[2]?.conditions).toBeUndefined();
  });
});

describe('conditionRowsFromBoard:服务端状态 + 核验留痕', () => {
  it('board 投影与条件账对上行:旧核验不算数;未知状态仍保留条件而明示未知', () => {
    expect(BOARD).not.toBeUndefined();
    const rows = conditionRowsFromBoard(BOARD!, guardGoalConditions([GOAL as never])[0]!.conditions!);
    expect(rows).toHaveLength(4);
    expect(rows.find((r) => r.id === 'c-bad')?.state).toBe('unknown');
    const delivered = rows.find((r) => r.id === 'c-1');
    expect(delivered?.state).toBe('delivered');
    expect(delivered?.deliveredAt).toBe('2026-10-24T11:00:00+08:00');
    const rework = rows.find((r) => r.id === 'c-2');
    expect(rework?.state).toBe('rework');
    // 旧核验(round=1)留痕保留但不再使条件 verified
    expect(rework?.verifications).toHaveLength(1);
    expect(rework?.verifications[0]?.round).toBe(1);
    const pending = rows.find((r) => r.id === 'c-3');
    expect(pending?.state).toBe('pending');
    expect(pending?.taskId).toBeUndefined();
  });

  it('条件不在 board 里(脏数据)不编造,跳过;认不出的回包 = undefined', () => {
    const rows = conditionRowsFromBoard({ ...BOARD!, items: BOARD!.items.slice(0, 1) }, GOAL.conditions as never);
    expect(rows).toHaveLength(1);
    expect(guardBoardSummary({ nope: true })).toBeUndefined();
    expect(guardBoardSummary({ summary: { goal_id: 'g', scope: '本目标' } })).toBeUndefined();
  });
});

describe('guardTaskCollab:round / messages / transitions', () => {
  it('逐格守卫:round 缺省 1,messages 带 deliveries,transitions 只追加', () => {
    const t = guardTaskCollab({
      id: 't-1', round: 3,
      messages: [
        { id: 'm-1', by: 'me', text: '@小K 看一下', at: '2026-10-24T10:00:00+08:00', intent: 'ask', mentions: ['agent:kimi-1'], deliveries: [{ to: 'agent:kimi-1', status: 'pending', at: '2026-10-24T10:00:00+08:00' }] },
        { bad: true },
      ],
      transitions: [{ from: 'todo', to: 'doing', at: '2026-10-24T09:00:00+08:00' }, 'junk'],
    });
    expect(t.round).toBe(3);
    expect(t.messages).toHaveLength(1);
    expect(t.messages?.[0]?.deliveries?.[0]?.status).toBe('pending');
    expect(t.transitions).toHaveLength(1);
    expect(guardTaskCollab({ id: 't-2' }).round).toBe(1);
  });
});

describe('留言投递三态不混', () => {
  it('状态名归一:pending=已受理待处理 / delivered=已送达 / accepted=已受理 / failed=失败(带原因)', () => {
    const ctx = { cards: { 'agent:kimi-1': '小K' }, members: {} };
    expect(deliveryTitle({ to: 'agent:kimi-1', status: 'pending', at: '' }, ctx)).toBe('小K:已受理待处理');
    expect(deliveryTitle({ to: 'me', status: 'delivered', at: '' }, ctx)).toBe('我:已送达');
    expect(deliveryTitle({ to: 'agent:kimi-1', status: 'accepted', at: '' }, ctx)).toBe('小K:已受理');
    // 未知名字失败:不当已邀请,带真实原因。
    expect(deliveryTitle({ to: 'agent:ghost', status: 'failed', at: '', error: 'unknown target: agent:ghost' }, ctx)).toContain('失败');
    expect(deliveryTitle({ to: 'agent:ghost', status: 'failed', at: '', error: 'unknown target: agent:ghost' }, ctx)).toContain('unknown target');
    expect(DELIVERY_STATUS_TITLES.failed).toContain('失败');
  });
});

describe('任务关系:五种 + stale 现算', () => {
  it('名归一 + 方向(从这张/到这张)+ stale 提示;wire 守卫吃真实回包', () => {
    expect(RELATION_KIND_TITLES).toMatchObject({ derived: '衍生', depends_on: '依赖', handoff: '交接', rejected_back: '验收退回', reference: '参考' });
    const rows = guardRelations({ relations: [
      { id: 'r-1', from_id: 't-1', to_id: 't-2', kind: 'handoff', note: '交回剪辑', round: 1, created_at: '' },
      { id: 'r-2', from_id: 't-2', to_id: 't-1', kind: 'rejected_back', note: '改音乐', round: 2, created_at: '' },
      { id: 'r-3', from_id: 't-1', to_id: 't-3', kind: 'handoff', round: 1, stale: true, created_at: '' },
      { bad: true },
    ] }, 't-1')!;
    expect(rows[0]?.direction).toBe('out');
    expect(rows[0]?.otherId).toBe('t-2');
    expect(rows[0]?.note).toBe('交回剪辑');
    expect(rows[1]?.direction).toBe('in');
    expect(rows[1]?.kindTitle).toBe('验收退回');
    expect(rows[2]?.stale).toBe(true);
    expect(rows).toHaveLength(3);
  });
});

describe('运行片段与容量(真实口径,不编)', () => {
  it('runSegmentLine:running/paused/done/failed/unknown 五种 + 暂停原因 + 收场', () => {
    expect(runSegmentLine({ task_id: 't', source: 'kimi', status: 'running', started_at: '2026-10-24T09:00:00+08:00' } as never)).toContain('有开工回执');
    expect(runSegmentLine({ task_id: 't', source: 'kimi', status: 'paused', started_at: '', pause_reason: '等她补充' } as never)).toContain('开工未知');
    expect(runSegmentLine({ task_id: 't', source: 'kimi', status: 'paused', started_at: '' } as never)).toContain('开工未知'); // 原因缺席也照摆
    expect(runSegmentLine({ task_id: 't', source: 'kimi', status: 'done', started_at: '', finished_at: '', outcome: 'replied' } as never)).toContain('执行已收场');
    expect(runSegmentLine({ task_id: 't', source: 'unknown', status: 'unknown', started_at: '' } as never)).toContain('未知');
    expect(RUN_STATUS_TITLES.unknown).toContain('未知');
  });

  it('capacityLine:在线/手上/未收场/上限 四事分开,上限取不到 = 未知;wire 守卫', () => {
    const items = guardCapacity({ items: [
      { id: 'me', online: true, active_jobs: 2, running_jobs: 1, limit: 'unknown' },
      { id: 'agent:kimi-1', online: false, active_jobs: 0, running_jobs: 0, limit: 3 },
      { bad: true },
    ] })!;
    expect(items).toHaveLength(2);
    expect(capacityLine(items[0]!)).toBe('me:在线 · 手上 2 件 · 实际执行 1 件 · 能接几件:未知');
    expect(capacityLine(items[1]!)).toBe('agent:kimi-1:离线 · 手上 0 件 · 实际执行 0 件 · 能接几件:3');
  });

  it('runs 守卫 + 活动流守卫:坏条跳过,按 at 升序', () => {
    const runs = guardRunSegments({ runs: [
      { task_id: 't-1', source: 'kimi', status: 'running', started_at: '2026-10-24T09:00:00+08:00' },
      { task_id: 't-1', source: 'kimi', status: 'paused', started_at: '2026-10-24T08:00:00+08:00', pause_reason: '等审批' },
      { bad: true },
    ] })!;
    expect(runs).toHaveLength(2);
    expect(runSegmentLine(runs[0]!)).toContain('有开工回执');
    expect(runSegmentLine(runs[1]!)).toContain('暂停');
    expect(runSegmentLine(runs[1]!)).toContain('等审批');

    const items = guardActivityItems({ items: [
      { type: 'transition', at: '2026-10-24T09:00:00+08:00', from: 'todo', to: 'doing' },
      { type: 'message', at: '2026-10-24T10:00:00+08:00', message: { id: 'm-1', by: 'me', text: 'hi', at: '2026-10-24T10:00:00+08:00', intent: 'record' } },
      { type: 'receipt', at: '2026-10-24T11:00:00+08:00', receipt: { kind: 'done', text: '做完', at: '2026-10-24T11:00:00+08:00', evidence: ['a.png'] } },
      { type: 'run', at: '2026-10-24T12:00:00+08:00', segment: { task_id: 't-1', source: 'kimi', status: 'running', started_at: '2026-10-24T09:00:00+08:00' } },
      { type: 'comment', at: '2026-10-24T09:30:00+08:00', comment: { id: 'c-1', by: 'me', text: '看看', at: '2026-10-24T09:30:00+08:00' } },
      { bad: true },
    ] })!;
    expect(items.map((one) => one.type)).toEqual(['transition', 'comment', 'message', 'receipt', 'run']);
  });

  it('未知的回包形状不伪装成空活动、关系、运行或容量', () => {
    expect(guardActivityItems({ legacy: [] })).toBeUndefined();
    expect(guardRelations({ legacy: [] }, 't-1')).toBeUndefined();
    expect(guardRunSegments({ legacy: [] })).toBeUndefined();
    expect(guardCapacity({ legacy: [] })).toBeUndefined();
    expect(guardLanMembers({ legacy: [] })).toBeUndefined();
    expect(guardActivityItems({ items: [] })).toEqual([]);
    expect(guardRelations({ relations: [] }, 't-1')).toEqual([]);
    expect(guardRunSegments({ runs: [] })).toEqual([]);
    expect(guardCapacity({ items: [] })).toEqual([]);
    expect(guardLanMembers({ members: [] })).toEqual([]);
  });
});
