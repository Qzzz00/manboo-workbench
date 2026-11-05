/**
 * ★ **答案来找她 —— 手机这一端**(2026-10-04,卡 `claude/answer-comes-to-her`,随 0.4.98)。
 *
 * 维护者原话(经工作台捎话):「我刚给事务官发信息,好消息是信息准确,回复也很快,
 * 坏消息是信息直接从正在办切到办完了,我是自己追过去点开查看的……这个交互你得想想咋整」。
 *
 * 钉三件事:
 *   ① 「问一句」的答案进球下那一行字幕(长的截一句、点一下展开全文);
 *   ② 办完先挂「刚办完 · 结果一句话」,她看过才进「办完」;
 *   ③ App 在后台时推一条通知,**正文就是答案本身**,不是「有回复了」。
 *
 * 外加**对照测试**:摆哪一条、摆哪几张,与工作台那个纯函数同一份夹具、同一个答案
 * (跨目录 import 走 `#answer-cell` 别名,理由在 `vitest.config.ts` 与 `answer-cell-module.d.ts`)。
 */
import { describe, expect, it } from 'vitest';
import { answerToShow as answerToShowPlugin, answerWorthNotifying, freshResultsOf } from '#answer-cell';
import type { AnswerView, AnswersView, TaskView, WorkbenchState } from '../src/api/protocol';
import { answerCaptionLines, answerCaptionOf, captionLinesOf } from '../src/stage/captionModel';
import { ANSWER_NOTICE_TITLE, answerNoticeFor } from '../src/stage/answerNotice';
import { freshResultRows } from '../src/stage/stageCardsModel';

const NOW = Date.parse('2026-10-04T18:00:00.000Z');

const answer = (more: Partial<AnswerView> = {}): AnswerView => ({
  id: 'a-1',
  question: '官网逐字稿改到第几版了',
  answer: '第三版,昨天 18:40 改完的。',
  at: '2026-10-04T17:59:00.000Z',
  ...more,
});

const cell = (items: readonly AnswerView[]): AnswersView => ({
  items,
  unseen: items.filter((one) => one.seen_at === undefined).length,
});

const task = (more: Partial<TaskView> = {}): TaskView => ({
  id: 't-1',
  title: '加个导出 PDF',
  status: 'done',
  direction: 'mine',
  source: { kind: 'manual' },
  created_at: '2026-10-04T17:00:00.000Z',
  updated_at: '2026-10-04T17:59:00.000Z',
  ...more,
} as TaskView);

function state(more: Record<string, unknown> = {}): WorkbenchState {
  return { agents: [], sessions: [], quota: {}, stale: false, now: '2026-10-04T18:00:00.000Z', ...more } as WorkbenchState;
}

describe('① 答案进球下那一行字幕', () => {
  it('有一条还没看过的回答时,字幕摆它(压过事项那一条)', () => {
    const lines = answerCaptionLines(answerCaptionOf(cell([answer()]))!);
    expect(lines.me?.text).toBe('官网逐字稿改到第几版了');
    expect(lines.butler?.text).toBe('第三版,昨天 18:40 改完的。');
    // ★ 带着 id:她点一下 = 展开全文 + 标「看过了」。
    expect(lines.butler?.answerId).toBe('a-1');
  });

  it('一条没看过的都没有 → 缺席,字幕让位回事项那一条(老行为一字不差)', () => {
    expect(answerCaptionOf(cell([answer({ seen_at: '2026-10-04T17:59:30.000Z' })]))).toBeUndefined();
    expect(answerCaptionOf(undefined)).toBeUndefined();
    // 没有回答时就是原来那条事项字幕,`answerId` 不出现。
    expect(captionLinesOf([]).butler?.answerId).toBeUndefined();
  });

  it('★ 摆哪一条与工作台那一处**同一个答案**(对照测试,同一份夹具)', () => {
    const view = cell([
      answer({ id: 'a-old', at: '2026-10-04T17:00:00.000Z' }),
      answer({ id: 'a-new', at: '2026-10-04T17:59:00.000Z' }),
      answer({ id: 'a-seen', at: '2026-10-04T17:58:00.000Z', seen_at: '2026-10-04T17:58:30.000Z' }),
    ]);
    expect(answerCaptionOf(view)?.id).toBe(answerToShowPlugin(view)?.id);
    expect(answerCaptionOf(view)?.id).toBe('a-old');
  });

  it('答案原文**一个字没截**(截多长是字幕那一格 CSS 的事)', () => {
    const long = '很'.repeat(400);
    expect(answerCaptionLines(answer({ answer: long })).butler?.text).toHaveLength(400);
  });

  it('她问的那一句丢了(老账)时上面那一行不出 —— 不编一句「你问了一句」', () => {
    const lines = answerCaptionLines(answer({ question: '' }));
    expect(lines.me).toBeUndefined();
    expect(lines.butler?.text).toBe('第三版,昨天 18:40 改完的。');
  });
});

describe('② 首页先挂「刚办完 · 结果一句话」', () => {
  it('正文是结果那一句,右边那一格说清是哪一件', () => {
    const rows = freshResultRows(state({
      fresh_results: { items: [{ task_id: 't-1', title: '加个导出 PDF', result: '做好了,在设置里。', done_at: '2026-10-04T17:59:00.000Z' }] },
    }));
    expect(rows).toEqual([{ id: 't-1', text: '做好了,在设置里。', note: '加个导出 PDF' }]);
  });

  it('结果一句话取不到时只摆标题,**不编一句「这件事办完了」**', () => {
    const rows = freshResultRows(state({
      fresh_results: { items: [{ task_id: 't-1', title: '加个导出 PDF', done_at: '2026-10-04T17:59:00.000Z' }] },
    }));
    expect(rows).toEqual([{ id: 't-1', text: '加个导出 PDF' }]);
  });

  it('★ 老工作台没有这一格 → 一条都不摆(照旧现在的样子)', () => {
    expect(freshResultRows(state())).toEqual([]);
  });

  it('★ 摆哪几张**一个条件都不在手机上判**:与工作台那一处同一份答案(对照测试)', () => {
    const tasks = [
      task({ id: 't-done' }),
      task({ id: 't-seen', seen_result_at: '2026-10-04T17:59:30.000Z' } as never),
      task({ id: 't-casual', casual: true } as never),
      task({ id: 't-doing', status: 'doing' }),
    ];
    const plugin = freshResultsOf({ tasks: { tasks } }, NOW);
    // 工作台只给出那一张;手机把它原样摆出来,自己不加一道也不减一道门。
    expect(plugin.items.map((one: { task_id: string }) => one.task_id)).toEqual(['t-done']);
    expect(freshResultRows(state({ tasks: { tasks }, fresh_results: plugin })).map((row) => row.id)).toEqual(['t-done']);
  });
});

describe('③ 后台那条通知:正文就是答案本身', () => {
  it('App 在后台 + 有一条没看过 → 推一条,**正文是答案原文、抬头是她问的那一句**', () => {
    const notice = answerNoticeFor({ answers: cell([answer()]), foreground: false, notified: new Set() });
    expect(notice).toEqual({ id: 'a-1', title: '官网逐字稿改到第几版了', body: '第三版,昨天 18:40 改完的。' });
    // ★ 正文**不是**「有回复了」—— 那还得她点进来再找一遍,等于没治。
    expect(notice?.body).not.toMatch(/有回复|有新消息/);
  });

  it('App 在前台不推(答案已经在她眼前的字幕上了)', () => {
    expect(answerNoticeFor({ answers: cell([answer()]), foreground: true, notified: new Set() })).toBeUndefined();
  });

  it('电话里问的那一条不推(她刚在电话里听过了),两端同一条口径', () => {
    const one = answer({ where: 'call' });
    expect(answerNoticeFor({ answers: cell([one]), foreground: false, notified: new Set() })).toBeUndefined();
    // 工作台那一侧也不给电脑推。
    expect(answerWorthNotifying(one)).toBe(false);
  });

  it('推过的不再推(不在她通知栏里响第二次)', () => {
    expect(answerNoticeFor({ answers: cell([answer()]), foreground: false, notified: new Set(['a-1']) })).toBeUndefined();
  });

  it('看过了的不推;她问的那一句丢了时抬头有缺省话', () => {
    expect(answerNoticeFor({ answers: cell([answer({ seen_at: '2026-10-04T17:59:30.000Z' })]), foreground: false, notified: new Set() })).toBeUndefined();
    expect(answerNoticeFor({ answers: cell([answer({ question: '' })]), foreground: false, notified: new Set() })?.title).toBe(ANSWER_NOTICE_TITLE);
  });

  it('老工作台没有这一格 → 一条都不推', () => {
    expect(answerNoticeFor({ answers: undefined, foreground: false, notified: new Set() })).toBeUndefined();
  });
});
