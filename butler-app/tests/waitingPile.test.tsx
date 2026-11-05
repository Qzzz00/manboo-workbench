/**
 * 「等你」那一堆:同一份状态喂给手机,数字与电脑上相等(2026-09-25,卡 M 追加;统筹:维护者的硬规矩「同一件事的数字各处一致」)。
 *
 * 喂的是电脑那边同一份:workbench-plugin/tests/fixtures/waiting-state.json(电脑那边的用例核对过里面的 `waiting`
 * 就是工作台服务端那个函数算出来的,球下「等你 n」、「还有 N 件要你看」、「事务官」标签上的数都是它)。
 * 手机只读这一格,不自己数:首页「等你确认」那一格的数、行,点开之后那几页上摆着的加上「另外 N 件」,都得是这一个数。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { WorkbenchState } from '../src/api/protocol';
import { askCount, waitingPile } from '../src/asks/asksModel';
import { otherConfirms, otherWaiting, PROPOSAL_NOTE, stageCards, waitingRows } from '../src/stage/stageCardsModel';

const SAME = JSON.parse(readFileSync(resolve(process.cwd(), '..', 'workbench-plugin', 'tests', 'fixtures', 'waiting-state.json'), 'utf8')) as WorkbenchState;
const COUNT = SAME.waiting!.count;

describe('同一份状态喂给手机:「等你确认」的数就是电脑上那个数', () => {
  it('首页那一格:数 = 工作台算好的那一份;一件一行、顺序照它', () => {
    expect(COUNT).toBe(9);
    const card = stageCards(SAME).find((one) => one.id === 'confirm')!;
    expect(card.count).toBe(COUNT);
    expect(card.lines.length + (card.more ?? 0)).toBe(COUNT);
    expect(waitingRows(SAME).map((row) => row.kind)).toEqual(SAME.waiting!.items.map((item) => item.kind));
    // 有问你的 / 要你批的:整张卡点下去先到那一页。
    expect(card.to).toEqual({ page: 'asks' });
  });

  it('点开之后:那一页摆着的几张 + 「另外 N 件」= 那一格的数(两页都是)', () => {
    const cards = (SAME.questions ?? []).length + (SAME.approvals ?? []).length;
    expect(cards + otherWaiting(SAME, ['question', 'approval']).length).toBe(COUNT);
    expect(1 + otherConfirms(SAME).length).toBe(COUNT);
  });

  it('提议(小工具 / 布局 / 固化)手机上只说一句「在电脑上定」;办完了等你确认的带着事项 id', () => {
    const rows = waitingRows(SAME);
    expect(rows.filter((row) => row.kind === 'proposal').map((row) => row.note)).toEqual([PROPOSAL_NOTE, PROPOSAL_NOTE, PROPOSAL_NOTE]);
    expect(rows.filter((row) => row.kind === 'confirm').map((row) => row.taskId)).toEqual(['t-c1', 't-c2']);
  });

  it('老工作台没给那一格:按老办法凑(问你的、要你批的、等你点头的单子、办完了等你确认的)', () => {
    const { waiting: _w, ...old } = SAME;
    const pile = waitingPile(old as WorkbenchState);
    expect(pile.items.map((item) => item.kind)).toEqual(['question', 'approval', 'approval', 'plan', 'confirm', 'confirm']);
    expect(stageCards(old as WorkbenchState).find((one) => one.id === 'confirm')?.count).toBe(pile.count);
  });
});

describe('「等你确认」只放他不点头就卡住的事(2026-09-27,卡 WY)', () => {
  it('工作台给的那一份里还挂着事务官自己的提议:手机读的时候撤掉,不要他手动清', () => {
    const stale = {
      ...SAME,
      questions: [],
      approvals: [],
      waiting: {
        count: 3,
        items: [
          { key: 'question:1', kind: 'question', verb: '答', text: '「参赛视频」问你:进度要你说一句' },
          { key: 'confirm:2', kind: 'confirm', verb: '验收', text: '「要加上吗:真实界面素材」办完了,等你确认' },
          { key: 'confirm:3', kind: 'confirm', verb: '验收', text: '「黄历接上了」办完了,等你确认' },
        ],
      },
    } as unknown as WorkbenchState;
    const pile = waitingPile(stale);
    expect(pile.count).toBe(1);
    expect(pile.items[0]!.text).toContain('黄历接上了');
    expect(stageCards(stale).find((one) => one.id === 'confirm')?.count).toBe(1);
  });

  it('老办法凑那一份时照同一条规矩筛:派单提议、进度要你说一句、「待排」卡都不算', () => {
    const old = {
      questions: [
        { id: 'q1', session_id: 'progress:t-1', at: '2026-09-27T01:00:00.000Z', task_id: 't-1', task_title: '参赛视频', questions: [{ id: 'a', header: '进度要你说一句', question: '现在到哪了?', multi: false, options: [] }] },
        { id: 'q2', session_id: 'dispatch:t-2', at: '2026-09-27T01:00:00.000Z', task_id: 't-2', task_title: '打磨自媒体布局', questions: [{ id: 'a', header: '这张派给 Claude 开工', question: '派吗?', multi: false, options: [] }] },
        { id: 'q3', session_id: 's-1', at: '2026-09-27T01:00:00.000Z', task_id: 't-3', task_title: '导出 PDF', questions: [{ id: 'a', header: '用方案 A 还是 B', question: '你定', multi: false, options: [] }] },
      ],
      butler_inbox: { items: [
        { id: 'confirm:t-p', kind: 'confirm', title: '真实界面素材', status: 'backlog', task_id: 't-p' },
        { id: 'confirm:t-c', kind: 'confirm', title: '黄历接上了', status: 'confirm', task_id: 't-c' },
      ] },
    } as unknown as WorkbenchState;
    const pile = waitingPile(old);
    expect(pile.items.map((item) => item.text)).toEqual(['「导出 PDF」问你:用方案 A 还是 B', '黄历接上了']);
    expect(askCount(old)).toBe(1);
  });
});
