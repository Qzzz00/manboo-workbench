/**
 * 模块怎么分成 行 → 列:页面与服务端布局快照**同一份函数**(2026-09-25 卡 P 补三)。
 *
 * 以前是两份抄本(client/Workbench.tsx 的 moduleRows、server/layoutSnapshot.ts 的 groupLayoutRows),服务端还拿它
 * 换算过「看板在屏幕哪一块」让壳画光圈 —— 0.3.1 画到了左上角(而且只按竖屏那一份算,页面在横屏)。换算已经删了;
 * 布局快照还在(事务官的记忆:工作台长什么样),所以分组并成一份,这里钉两件:
 * ① 服务端导出的就是页面用的那一个函数(同一个对象,漂不了);
 * ② 规则本身:相邻且 row 相同才并一行,行内相邻且 col 相同才摞一列,缺 row / col 的各自独占。
 */
import { describe, expect, it } from 'vitest'
import { groupLayoutRows as shared } from '../src/layoutRows.ts'
import { groupLayoutRows as fromSnapshot } from '../src/server/layoutSnapshot.ts'
import type { LayoutModule } from '../src/protocol.ts'

const m = (id: string, row?: number, col?: number): LayoutModule =>
  ({ id, order: 0, ...(row === undefined ? {} : { row }), ...(col === undefined ? {} : { col }) }) as LayoutModule
const ids = (rows: LayoutModule[][][]) => rows.map(cols => cols.map(col => col.map(one => one.id)))

describe('分组规则只有一份', () => {
  it('★服务端布局快照用的就是页面那一个函数', () => {
    expect(fromSnapshot).toBe(shared)
  })

  it('默认竖屏:项目区 | 消耗数据 + 余额(右边摞一列);窗口槽独占一行;随手记 | 文件区', () => {
    const rows = shared([m('projects', 0, 0), m('usage', 0, 1), m('quota', 0, 1), m('slot', 1), m('notes', 2), m('files', 2)])
    expect(ids(rows)).toEqual([[['projects'], ['usage', 'quota']], [['slot']], [['notes'], ['files']]])
  })

  it('只并「相邻」的:同一 row 被别的模块隔开就拆成两行(上移 / 下移换的是顺序)', () => {
    expect(ids(shared([m('a', 0), m('b', 1), m('c', 0)]))).toEqual([[['a']], [['b']], [['c']]])
  })

  it('缺 row / col 的各自独占(旧存档读进来与从前逐帧一致)', () => {
    expect(ids(shared([m('a'), m('b'), m('c', 3), m('d', 3)]))).toEqual([[['a']], [['b']], [['c'], ['d']]])
  })
})
