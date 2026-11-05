/**
 * 协作区模型测试(2026-10-24,卡「完整手机协作下级页」,小K)。
 *
 * 分桶口径照维护者 10-23 拍板的整体验收条件:
 * 同一批真实事项看 已完成 / 已开工 / 未开始 / 受阻 / 交回待验 / 取消单列;
 * 范围标明、父子不双计、取消不算达成;任务数只回答工作分布,条件进度按条件算。
 */
import { describe, expect, it } from 'vitest';
import type { TaskView } from '../src/api/protocol';
import {
  actorName,
  bucketOf,
  bucketCounts,
  boardRows,
  conditionRowsOf,
  activityOf,
  timeFactsOf,
  STALE_DAYS,
  type BoardRow,
} from '../src/collab/collabModel';
import { collabFields } from '../src/collab/collabState';
import { fieldsOf } from './collabFixtures';

function task(partial: Partial<TaskView> & { id: string; title: string; status: TaskView['status'] }): TaskView {
  return {
    created_at: '2026-10-20T09:00:00+08:00',
    updated_at: '2026-10-21T09:00:00+08:00',
    ...partial,
  } as TaskView;
}

describe('bucketOf:七态归六个桶,canceled 单列', () => {
  it.each([
    ['done', 'done'], ['doing', 'doing'], ['blocked', 'blocked'], ['confirm', 'confirm'], ['canceled', 'canceled'],
    ['backlog', 'todo'], ['todo', 'todo'],
  ] as const)('%s → %s', (status, bucket) => {
    expect(bucketOf(status)).toBe(bucket);
  });
});

describe('boardRows:父子不双计', () => {
  const fields = fieldsOf(new Map([
    ['g1', { children: ['g1-a', 'g1-b'] }],
  ]));

  it('有子卡的父卡收成一组,子卡不再单独出现', () => {
    const tasks = [
      task({ id: 'g1', title: '组', status: 'doing' }),
      task({ id: 'g1-a', title: '子A', status: 'done' }),
      task({ id: 'g1-b', title: '子B', status: 'todo' }),
      task({ id: 'solo', title: '独立卡', status: 'blocked' }),
    ];
    const rows = boardRows(tasks, fields);
    const groups = rows.filter((r) => r.kind === 'group');
    const singles = rows.filter((r) => r.kind === 'task').map((r) => (r as Extract<BoardRow, { kind: 'task' }>).task.id);
    expect(groups).toHaveLength(1);
    expect(groups[0].kind === 'group' && groups[0].group.parent.id).toBe('g1');
    expect(singles).toEqual(['solo']);
    // 组出现在「最该动」的桶:子B 未开始、子A 已完成 → 组在未开始里带汇总。
    const groupRow = groups[0];
    expect(groupRow.bucket).toBe('todo');
    if (groupRow.kind === 'group') {
      expect(groupRow.group.counts.done).toBe(1);
      expect(groupRow.group.counts.todo).toBe(1);
      expect(groupRow.group.total).toBe(2);
    }
  });

  it('全部子卡取消 → 组进取消桶,不算任何进展', () => {
    const tasks = [
      task({ id: 'g1', title: '组', status: 'canceled' }),
      task({ id: 'g1-a', title: '子A', status: 'canceled' }),
      task({ id: 'g1-b', title: '子B', status: 'canceled' }),
    ];
    const rows = boardRows(tasks, fields);
    expect(rows).toHaveLength(1);
    expect(rows[0].bucket).toBe('canceled');
  });

  it('父卡不在清单里(范围外)时,子卡按独立卡算,不丢', () => {
    const tasks = [task({ id: 'g1-a', title: '孤儿子卡', status: 'doing' })];
    const rows = boardRows(tasks, fields);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('task');
    expect(rows[0].bucket).toBe('doing');
  });

  it('组桶取「最该动」:受阻 > 交回待验 > 已开工 > 未开始 > 已完成', () => {
    const fs = fieldsOf(new Map([['g', { children: ['g-a', 'g-b', 'g-c'] }]]));
    const tasks = [
      task({ id: 'g', title: '组', status: 'doing' }),
      task({ id: 'g-a', title: 'a', status: 'done' }),
      task({ id: 'g-b', title: 'b', status: 'blocked' }),
      task({ id: 'g-c', title: 'c', status: 'confirm' }),
    ];
    expect(boardRows(tasks, fs)[0].bucket).toBe('blocked');
  });
});

describe('bucketCounts:取消单列,只计叶事项', () => {
  it('按叶事项计数,不因子卡被收起而漏计', () => {
    const fields = fieldsOf(new Map([['g1', { children: ['g1-a'] }]]));
    const tasks = [
      task({ id: 'g1', title: '组', status: 'doing' }),
      task({ id: 'g1-a', title: '子', status: 'done' }),
      task({ id: 'x', title: 'x', status: 'canceled' }),
    ];
    const counts = bucketCounts(boardRows(tasks, fields));
    expect(counts.canceled).toBe(1);
    expect(counts.done).toBe(1); // 组行落在「最该动」的已完成桶(唯一子卡 done),子卡不单独占行
    expect(counts.todo).toBe(0);
  });
});

it('R4 递归混合父组按唯一叶卡计完成/待办/取消,跨父组重复引用不双计', () => {
  const fs = fieldsOf(new Map([['p', { children: ['nested', 't', 'c'] }], ['nested', { children: ['d'] }], ['p2', { children: ['d'] }]]));
  const tasks = [task({ id: 'p', title: '父组', status: 'doing' }), task({ id: 'nested', title: '嵌套组', status: 'doing' }), task({ id: 'p2', title: '另一组', status: 'todo' }), task({ id: 'd', title: '完成', status: 'done' }), task({ id: 't', title: '待办', status: 'todo' }), task({ id: 'c', title: '取消', status: 'canceled' })];
  expect(bucketCounts(boardRows(tasks, fs))).toEqual({ done: 1, doing: 0, todo: 1, blocked: 0, confirm: 0, canceled: 1 });
});

describe('conditionRowsOf:能力条件按条件算,不按卡数算', () => {
  it('acceptance 每条成一行,状态随承接事项的真实状态与回执', () => {
    const tasks = [
      task({ id: 't1', title: '做A', status: 'done' }),
      task({ id: 't2', title: '做B', status: 'confirm' }),
    ];
    const fields = fieldsOf(new Map([
      ['t1', { acceptance: ['能打开目标页', '能看见分桶'], receipt: { kind: 'done', text: '做完了', at: '2026-10-22T10:00:00+08:00', evidence: ['build/ok.png'] } }],
      ['t2', { acceptance: ['验收通过能交付'] }],
    ]));
    const rows = conditionRowsOf(tasks, fields);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ text: '能打开目标页', taskId: 't1', state: 'reached', receiptKind: 'done' });
    expect(rows[0].evidence).toContain('build/ok.png');
    expect(rows[1].state).toBe('reached');
    expect(rows[2]).toMatchObject({ text: '验收通过能交付', state: 'confirm' });
  });

  it('取消的事项的条件不算达成,单列 canceled', () => {
    const tasks = [task({ id: 't1', title: '做A', status: 'canceled' })];
    const fields = fieldsOf(new Map([['t1', { acceptance: ['作废的条件'] }]]));
    expect(conditionRowsOf(tasks, fields)[0].state).toBe('canceled');
  });

  it('没有 acceptance 的事项不进条件表(它没说自己做到什么算完)', () => {
    const tasks = [task({ id: 't1', title: '做A', status: 'done' })];
    expect(conditionRowsOf(tasks, fieldsOf(new Map()))).toHaveLength(0);
  });
});

describe('activityOf:连续活动流,来源/留言/回执/会话按时间归并', () => {
  const sessions = [
    { agent: 'dsh' as const, session_id: 's-1', status: 'running' as const, title: '实现目标页', updated_at: '2026-10-23T20:00:00+08:00', summary: undefined },
    { agent: 'codex' as const, session_id: 's-2', status: 'waiting' as const, title: undefined, updated_at: '2026-10-22T12:00:00+08:00', summary: undefined },
  ];

  it('留言、回执、来源、建卡、关联会话各就其位,新的在前', () => {
    const t = task({ id: 't1', title: '做A', status: 'confirm', created_at: '2026-10-20T09:00:00+08:00', links: [{ agent: 'codex', session_id: 's-2', note: '写测试' }] as unknown as TaskView['links'], conversation: { agent: 'dsh', session_id: 's-1' } });
    const fields = fieldsOf(new Map([['t1', {
      from: { kind: 'meeting', ref: 'm-1', quote: '会上定的' },
      comments: [{ id: 'c1', by: 'me', text: '改一下标题', at: '2026-10-21T08:00:00+08:00' }],
      receipt: { kind: 'done', text: '做完了', at: '2026-10-23T09:00:00+08:00' },
    }]]));
    const acts = activityOf(t, fields, sessions);
    const kinds = acts.map((a) => a.kind);
    expect(kinds).toContain('from');
    expect(kinds).toContain('comment');
    expect(kinds).toContain('receipt');
    expect(kinds).toContain('created');
    expect(kinds.filter((k) => k === 'session')).toHaveLength(2);
    // 排序:最新的(dsh 会话 20:00)在最前,建卡在最末。
    expect(acts[0].kind).toBe('session');
    expect(acts.at(-1)?.kind).toBe('created');
    const receipt = acts.find((a) => a.kind === 'receipt');
    expect(receipt && receipt.kind === 'receipt' && receipt.text).toBe('做完了');
  });

  it('认不出的来源 kind 原样摆,不编造', () => {
    const t = task({ id: 't1', title: 'x', status: 'todo' });
    const fields = fieldsOf(new Map([['t1', { from: { kind: 'weird' } }]]));
    const from = activityOf(t, fields, []).find((a) => a.kind === 'from');
    expect(from?.kind === 'from' && from.kindTitle).toBe('weird');
  });
});

describe('timeFactsOf:真实片段与未知分开,不填默认时间', () => {
  it('R1 start/end 是排期,不冒实际时间;没有执行时刻来源就未知', () => {
    const full = task({ id: 't', title: 'x', status: 'doing', due: '2026-10-30' });
    const fFull = timeFactsOf(full, fieldsOf(new Map([['t', { start: '2026-10-21T09:00:00+08:00', end: '2026-10-21T11:00:00+08:00' }]])), '2026-10-24T00:00:00+08:00');
    expect(fFull.plannedDate).toBe('2026-10-30');
    expect(fFull.actual).toBeUndefined();
    expect(fFull.plannedRange).toEqual({ start: '2026-10-21T09:00:00+08:00', end: '2026-10-21T11:00:00+08:00' });
    expect(fFull.unknown).toEqual(['实际时间']);

    const point = timeFactsOf(full, fieldsOf(new Map([['t', { start: '2026-10-21T09:00:00+08:00' }]])), '2026-10-24T00:00:00+08:00');
    expect(point.actual).toBeUndefined();

    const none = task({ id: 't2', title: 'y', status: 'todo', due: undefined });
    const fNone = timeFactsOf(none, fieldsOf(new Map()), '2026-10-24T00:00:00+08:00');
    expect(fNone.actual).toBeUndefined();
    expect(fNone.plannedDate).toBeUndefined();
    expect(fNone.unknown).toContain('计划时间');
    expect(fNone.unknown).toContain('实际时间');
  });

  it(`超过 ${STALE_DAYS} 天没动 = 记录过旧,不许装作在跑`, () => {
    const old = task({ id: 't', title: 'x', status: 'doing', updated_at: '2026-10-10T09:00:00+08:00' });
    expect(timeFactsOf(old, fieldsOf(new Map()), '2026-10-24T00:00:00+08:00').stale).toBe(true);
    const fresh = task({ id: 't', title: 'x', status: 'doing', updated_at: '2026-10-23T09:00:00+08:00' });
    expect(timeFactsOf(fresh, fieldsOf(new Map()), '2026-10-24T00:00:00+08:00').stale).toBe(false);
  });
});

describe('actorName:名归一,认不出的原样', () => {
  const ctx = { cards: { 'agent:kimi-1': '小K' }, members: { 'acct-9': '阿真' } };
  it('me/butler/agent:/member: 各归其名', () => {
    expect(actorName('me', ctx)).toBe('我');
    expect(actorName('butler', ctx)).toBe('事务官');
    expect(actorName('dsh', ctx)).toBe('事务官');
    expect(actorName('agent:kimi-1', ctx)).toBe('小K');
    expect(actorName('member:acct-9', ctx)).toBe('阿真');
  });
  it('没写的与认不出的如实', () => {
    expect(actorName(undefined, ctx)).toBe('没写谁来做');
    expect(actorName('agent:ghost', ctx)).toBe('agent:ghost');
    expect(actorName('member:who', ctx)).toBe('成员·who');
  });
});

describe('collabFields:守卫读取,坏数据不炸', () => {
  it('comments/receipt/children 逐格守卫,坏格跳过', () => {
    const f = collabFields({
      goal_id: 'g1',
      acceptance: ['a', 1, 'b'],
      comments: [{ id: 'c1', by: 'me', text: 'hi', at: '2026-10-20T00:00:00+08:00' }, { bad: true }],
      children: ['x', 2],
      start: 42,
    });
    expect(f.goalId).toBe('g1');
    expect(f.acceptance).toEqual(['a', 'b']);
    expect(f.comments).toHaveLength(1);
    expect(f.children).toEqual(['x']);
    expect(f.start).toBeUndefined();
  });
});
