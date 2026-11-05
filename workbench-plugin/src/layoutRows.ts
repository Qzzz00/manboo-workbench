/**
 * 模块怎么分成 行 → 列(2026-09-25 卡 P 补三:页面与服务端**同一份**)。
 *
 * 以前是两份抄本:页面 client/Workbench.tsx 的 `moduleRows`(真正决定界面长什么样的那一份)和服务端
 * server/layoutSnapshot.ts 的 `groupLayoutRows`(布局快照拿它描述「工作台长什么样」,光圈还拿它换算过
 * 「看板在屏幕哪一块」)。注释里自己写着「三处走漂就会算出一个页面上并不存在的版面」—— 0.3.1 光圈真的画错了地方。
 * 光圈那条换算已经删了(事务官的那行字改由页面挂在真实的元素上);布局快照还在(事务官的记忆:工作台长什么样),
 * 所以把分组规则并成这一份,两边都 import 它 —— 漂不了,不靠测试去追。
 *
 * 规则:
 * - 行:**只合并「排序后相邻」且 row 相同的模块**,不按 row 值全局归并 —— 否则 order 与 row 会打架:
 *   上移 / 下移换的是 order,若分组只看 row,把别的模块挪进这一对中间时它俩仍会被并回同一行,
 *   界面上「上移了却没动」(真机实证)。按相邻分组,挪进来就自然拆开。
 * - 列(2026-08-25 右侧上下堆叠):行内再按相邻且 col 相同合并成**竖向一列**。
 * - row / col 缺省的模块永不参与合并,各自独占 —— 旧存档读进来与从前逐帧一致。
 *
 * 纯函数:进来的顺序就是排好的顺序(调用方先按 order 排、先滤掉收起的)。
 */
import type { LayoutModule } from './protocol.ts'

export function groupLayoutRows<T extends Pick<LayoutModule, 'row' | 'col'>>(modules: readonly T[]): T[][][] {
  const rows: T[][][] = []
  for (const module of modules) {
    const lastRow = rows[rows.length - 1]
    const rowHead = lastRow?.[0]?.[0]
    const sameRow = lastRow !== undefined && rowHead !== undefined
      && module.row !== undefined && rowHead.row === module.row
    if (!sameRow) {
      rows.push([[module]])
      continue
    }
    const lastCol = lastRow[lastRow.length - 1]
    const colHead = lastCol?.[0]
    const sameCol = lastCol !== undefined && colHead !== undefined
      && module.col !== undefined && colHead.col === module.col
    if (sameCol) lastCol.push(module)
    else lastRow.push([module])
  }
  return rows
}
