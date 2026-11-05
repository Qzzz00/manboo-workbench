/**
 * 工作台那半边 `workbench-plugin/src/orbCell.ts` 的**类型门面**(2026-10-04,卡「球的颜色一处算」)。
 *
 * 只给 `tests/orbOneTruthParity.test.ts` 用:那一条要把同一份 /state 喂给两端的函数。
 * 真路径在 `vitest.config.ts` 的别名里(运行时跑的是插件那份真代码);这里只声明它回什么,
 * 好让这边的 tsc 不必把插件源码(ES2024 写法)拖进程序。
 */
declare module '#orb-cell' {
  import type { OrbView } from '../src/api/protocol';
  export function orbCellOf(state: unknown): OrbView;
}
