/**
 * 工作台那半边 `workbench-plugin/src/answerCell.ts` 的**类型门面**(2026-10-04,
 * 卡 `claude/answer-comes-to-her`)。
 *
 * 只给 `tests/answerComesToHerParity.test.ts` 用:那一条要把同一份夹具喂给两端的函数,
 * 断言「摆哪一条回答」「摆哪几张刚办完」两端一字不差。真路径在 `vitest.config.ts` 的别名里
 * (运行时跑的是插件那份真代码);这里只声明它回什么,好让这边的 tsc 不必把插件源码
 * (ES2024 写法)拖进程序。理由与 `orb-cell-module.d.ts` 逐字相同。
 */
declare module '#answer-cell' {
  import type { AnswerView, AnswersView, FreshResultsView } from '../src/api/protocol';
  export function answersCellOf(answers: readonly AnswerView[], nowMs: number): AnswersView;
  export function answerToShow(view: AnswersView | undefined): AnswerView | undefined;
  export function freshResultsOf(state: unknown, nowMs: number): FreshResultsView;
  export function answerWorthNotifying(answer: AnswerView): boolean;
}
