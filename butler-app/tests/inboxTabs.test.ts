/**
 * 事项页分四个标签(2026-10-01,梳理见 docs/梳理-1001-手机事项页.md;维护者:「什么信息都在里面,太乱了」
 * 「历史记录,通话记录,定向搜索什么鬼东西都在里面」「还不分区,一滑走就找不到了」)。
 *
 * 钉:哪一样进哪个标签、哪几样搬出事项页、测试单子怎么认、办完按天分组、首页卡片落哪个标签。
 */
import { describe, expect, it, vi } from 'vitest';
import type { TaskView, WorkbenchState } from '../src/api/protocol';
import { emptyState } from '../src/api/protocol';
import {
  INBOX_TABS, callTasks, doneByDay, inboxBuckets, isTestTicket, reportItems, testTickets,
} from '../src/items/inboxTabs';

const NOW = '2026-10-01T21:30:00+08:00';

function task(over: Partial<TaskView> & { id: string; title: string }): TaskView {
  return { status: 'todo', direction: 'mine', created_at: NOW, updated_at: NOW, ...over } as TaskView;
}

function state(over: Partial<WorkbenchState> = {}): WorkbenchState {
  return { ...emptyState(), stale: false, now: NOW, ...over } as WorkbenchState;
}

describe('四个标签', () => {
  it('名字与顺序:在办 · 等你 · 排着 · 办完', () => {
    expect(INBOX_TABS.map((t) => t.label)).toEqual(['在办', '等你', '排着', '办完']);
  });

  const board = state({
    butler_inbox: {
      items: [
        { id: 'r1', kind: 'routine', title: '开工汇报', note: '…几百字…' },
        { id: 'c1', kind: 'confirm', title: '按清单真机走一遍', task_id: 'p1' },
        { id: 'k1', kind: 'risk', title: '工作台 排期赶不上' },
        { id: 'f1', kind: 'feed', title: '《FDE前沿部署工程师实战教程》', url: 'https://x' },
      ],
    },
    tasks: {
      tasks: [
        task({ id: 'a', title: '打磨自媒体布局', status: 'doing', mover: { who: 'agent', line: 'Claude 在做' } }),
        task({ id: 'm', title: '参赛网页:下载地址', mover: { who: 'me', line: '你来' } }),
        task({ id: 'o', title: '参赛文案', mover: { who: 'others', line: '等同事' } }),
        task({ id: 'd', title: '定核心体验流程', status: 'done', updated_at: '2026-10-01T09:00:00+08:00' }),
        task({ id: 'call', title: '和事务官通了个电话(8 秒)', status: 'done', origin: 'call' }),
        task({ id: 't', title: '[派活测试] 让 Kimi 用一句话回答:一周有几天?', status: 'canceled' }),
        task({ id: 't2', title: '【工作台自测】让 Manus 帮我查一下', status: 'todo', mover: { who: 'me', line: '你来' } }),
      ],
    },
  } as unknown as Partial<WorkbenchState>);

  it('★等你:只有要她拍板的(要不要加 / 有风险);汇报、资讯搜索结果不在这里', () => {
    expect(inboxBuckets(board).waiting.map((c) => c.id)).toEqual(['c1', 'k1']);
  });

  it('额度告警不算「事」(2026-10-23,卡 t-8e617888):维护者拍板「工作台消息即可」,手机事项页不摆', () => {
    const s = state({
      butler_inbox: {
        items: [
          { id: 'q1', kind: 'quota', title: 'Kimi 的 5 小时额度只剩约 10%', note: '15:21 重置 · 12:37 读到', at: NOW },
          { id: 'c1', kind: 'confirm', title: '按清单真机走一遍', task_id: 'p1' },
        ],
      },
    } as unknown as Partial<WorkbenchState>);
    // 不进出事页任何一个桶(等你只余 confirm);reportItems 只认 routine,也不会漏进去。
    expect(inboxBuckets(s).waiting.map((c) => c.id)).toEqual(['c1']);
    expect(reportItems(s).map((i) => i.id)).toEqual([]);
  });

  it('额度活用建议不算「事」(2026-10-28,卡 t-f68365f6):与额度告警同一纪律,手机事项页不摆', () => {
    const s = state({
      butler_inbox: {
        items: [
          { id: 's1', kind: 'spend', title: 'Kimi 的本周额度快重置了,还剩约 79%', note: '明天 08:00 重置 · 板上压着 2 件研发活(待排)', at: NOW },
          { id: 'c1', kind: 'confirm', title: '按清单真机走一遍', task_id: 'p1' },
        ],
      },
    } as unknown as Partial<WorkbenchState>);
    expect(inboxBuckets(s).waiting.map((c) => c.id)).toEqual(['c1']);
    expect(reportItems(s).map((i) => i.id)).toEqual([]);
  });

  it('★在办 = AI 与事务官手上的;排着 = 你来的 + 等别人的;测试单子哪儿都不出现', () => {
    const b = inboxBuckets(board);
    expect(b.doing.map((t) => t.id)).toEqual(['a']);
    expect(b.queued.map((t) => t.id)).toEqual(['m', 'o']);
  });

  it('★办完:去掉通话纪要与测试单子,只剩真正的事', () => {
    expect(inboxBuckets(board).done.map((t) => t.id)).toEqual(['d']);
  });

  it('汇报一页:收件箱里的例程汇报,原样', () => {
    expect(reportItems(board).map((i) => i.id)).toEqual(['r1']);
  });

  it('通话记录一页:通话纪要卡,新的在前', () => {
    const s = state({ tasks: { tasks: [
      task({ id: 'c-old', title: '和事务官通了个电话(5 秒)', status: 'done', origin: 'call', updated_at: '2026-09-28T10:00:00+08:00' }),
      task({ id: 'c-new', title: '和事务官通了个电话(8 秒)', status: 'done', origin: 'call', updated_at: '2026-09-30T19:15:00+08:00' }),
      task({ id: 'x', title: '别的事', status: 'done' }),
    ] } } as unknown as Partial<WorkbenchState>);
    expect(callTasks(s).map((t) => t.id)).toEqual(['c-new', 'c-old']);
  });
});

describe('测试单子', () => {
  it('★认得出这几种前缀(10-01 真机上那 20 条)', () => {
    for (const title of [
      '[派活测试] 让豆包用一句话回答:一年有几个月?',
      '[统筹自测] 测一下外层提问',
      '[统筹自测·通知2] 请用提问弹窗',
      '[统筹自测·升级] 底座刚换到新版',
      '[测试·统筹验证,可忽略] 我的规矩有哪些?',
      '【工作台自测】查一下今年国庆法定假期放几天',
      '[测试] 我的规矩有哪些?',
    ]) expect(isTestTicket(title)).toBe(true);
  });
  it('她自己的事不误伤', () => {
    for (const title of ['参赛网页:下载地址', '测试一下新的布局', '【参赛】文案', '验证自我迭代能力', '和事务官通了个电话(8 秒)']) {
      expect(isTestTicket(title)).toBe(false);
    }
  });
  it('设置里删的那一摞:看板上所有测试单子(不管办没办完、谁交代的)', () => {
    const s = state({ tasks: { tasks: [
      task({ id: 't1', title: '[派活测试] 一', status: 'canceled' }),
      task({ id: 't2', title: '【工作台自测】二', direction: 'theirs' as TaskView['direction'] }),
      task({ id: 'ok', title: '正经事' }),
    ] } } as unknown as Partial<WorkbenchState>);
    expect(testTickets(s).map((t) => t.id)).toEqual(['t1', 't2']);
  });
});

describe('办完按天分组', () => {
  it('今天 / 昨天 / 更早写日期,组内新的在前', () => {
    const groups = doneByDay([
      task({ id: 'a', title: 'a', status: 'done', updated_at: '2026-10-01T09:00:00' }),
      task({ id: 'b', title: 'b', status: 'done', updated_at: '2026-09-30T20:00:00' }),
      task({ id: 'c', title: 'c', status: 'done', updated_at: '2026-10-01T18:00:00' }),
      task({ id: 'd', title: 'd', status: 'canceled', updated_at: '2026-09-28T08:00:00' }),
    ], new Date(2026, 9, 1, 21, 30));
    expect(groups.map((g) => [g.label, g.tasks.map((t) => t.id)])).toEqual([
      ['今天', ['c', 'a']],
      ['昨天', ['b']],
      ['9-28', ['d']],
    ]);
  });

  /**
   * 「今天」是电脑的今天(/state.now),不是手机自己的今天 —— 手机的钟歪了、时区不同,
   * 这一行写的日子就要跟卡上那句「今天 20:17」(friendlyWhen 用的也是 /state.now)对不上。
   */
  it('★按电脑的时钟分(/state.now 那个字符串),不看手机自己的钟', () => {
    const done = [task({ id: 'a', title: 'a', status: 'done', updated_at: '2026-10-01T09:00:00+08:00' })];
    expect(doneByDay(done, '2026-10-01T21:30:00+08:00')[0].label).toBe('今天');
    expect(doneByDay(done, '2026-10-02T09:00:00+08:00')[0].label).toBe('昨天');
    expect(doneByDay(done, '2026-10-05T09:00:00+08:00')[0].label).toBe('10-1');
  });

  it('电脑的时刻读不出来(还没连上那份占位 now 是空的)才退回手机的钟', () => {
    // 手机的钟也钉死,不然跨零点那一瞬这条用例自己会闪红(卡上这次红的就是拿墙钟赌)。
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-12-25T10:00:00+08:00'));
      const done = [task({ id: 'a', title: 'a', status: 'done', updated_at: '2026-12-25T01:00:00+08:00' })];
      expect(doneByDay(done, emptyState().now)[0].label).toBe('今天');
      expect(doneByDay(done, '读不懂的时刻')[0].label).toBe('今天');
      expect(doneByDay(done, undefined)[0].label).toBe('今天');
    } finally {
      vi.useRealTimers();
    }
  });
});
