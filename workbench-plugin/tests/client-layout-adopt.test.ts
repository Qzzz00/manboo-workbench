/**
 * 卡 TM(2026-09-27):「在设置里切换自媒体布局,压根没有切换布局成功。」
 * 2026-10-28 追加:回声按**内容**判(交接-1027「12:0x 气泡」那节的治本第三条)。
 *
 * 这一份钉的是判据本身(`decideLayoutAdopt` / `layoutContentEqual`);界面上真的
 * 换过去那一步在 `tests/client-layout-live.test.tsx` 里对着渲染出来的模块盒子验,
 * 端到端的"服务端重排键序的回声不当成别人改的"在
 * `tests/client-butler-float-echo-1028.test.tsx` 里验。
 */
import { describe, expect, it } from 'vitest'
import { decideLayoutAdopt, layoutContentEqual } from '../src/client/layoutAdopt.ts'

const OLD = { modules: [{ id: 'projects', order: 0 }] }
const NEW = { modules: [{ id: 'slot', order: 0 }, { id: 'todo', order: 1 }] }

describe('decideLayoutAdopt(切了就要看得见)', () => {
  it('第一次:拿服务端那份当初始值', () => {
    expect(decideLayoutAdopt({
      incoming: OLD, seen: null, posted: null, pendingLocal: false, initialized: false,
    })).toBe('init')
  })

  it('服务端那份跟上一拍一模一样:什么都不做(绝大多数拍走这条)', () => {
    expect(decideLayoutAdopt({
      incoming: OLD, seen: OLD, posted: null, pendingLocal: false, initialized: true,
    })).toBe('keep')
  })

  it('★ 切了模板(服务端那份变了、不是我们改的):界面换过去', () => {
    expect(decideLayoutAdopt({
      incoming: NEW, seen: OLD, posted: null, pendingLocal: false, initialized: true,
    })).toBe('adopt')
  })

  it('本地正改着还没落盘:不许被服务端那份盖回去(布局是用户数据 D12)', () => {
    expect(decideLayoutAdopt({
      incoming: NEW, seen: OLD, posted: null, pendingLocal: true, initialized: true,
    })).toBe('keep')
  })

  it('这一变正是我们自己刚 POST 出去的那份:是回声,不动(不让他刚拖的那一下跳一下)', () => {
    expect(decideLayoutAdopt({
      incoming: NEW, seen: OLD, posted: NEW, pendingLocal: false, initialized: true,
    })).toBe('keep')
  })

  it('自己 POST 过之后别人又改了一次:照旧换过去(回声只豁免那一份)', () => {
    expect(decideLayoutAdopt({
      incoming: OLD, seen: NEW, posted: NEW, pendingLocal: false, initialized: true,
    })).toBe('adopt')
  })

  it('★ 服务端重排了键序、内容一字没变(它 parseLayout 重建对象就是这个形状):是回声,不动', () => {
    const posted = {
      modules: [{ id: 'slot', order: 0 }, { id: 'todo', order: 1 }],
      butler: { corner: 'br', min: false, pos: { x_pct: 63.9, y_pct: 4.2 } },
    }
    // 同一内容,键序整体倒过来(服务端重建:butler 在前、min 在 corner 前)。
    const echo = {
      butler: { min: false, corner: 'br', pos: { y_pct: 4.2, x_pct: 63.9 } },
      modules: [{ id: 'slot', order: 0 }, { id: 'todo', order: 1 }],
    }
    expect(decideLayoutAdopt({
      incoming: echo, seen: OLD, posted, pendingLocal: false, initialized: true,
    })).toBe('keep')
  })

  it('★ 回声里有一个值真被夹过了(内容变了):那是服务端动过的,照旧换过去', () => {
    const posted = { modules: [{ id: 'slot', order: 0 }], butler: { corner: 'br', min: false, pos: { x_pct: 3, y_pct: 99 } } }
    const echo = { butler: { corner: 'br', min: false, pos: { x_pct: 3, y_pct: 95 } }, modules: [{ id: 'slot', order: 0 }] }
    expect(decideLayoutAdopt({
      incoming: echo, seen: OLD, posted, pendingLocal: false, initialized: true,
    })).toBe('adopt')
  })
})

describe('layoutContentEqual(键序不敏感的深比较)', () => {
  it('键序不同的两个对象:内容相等', () => {
    expect(layoutContentEqual(
      { a: 1, b: { c: 2, d: [3, 4] } },
      { b: { d: [3, 4], c: 2 }, a: 1 },
    )).toBe(true)
  })

  it('键的数量不同:不相等', () => {
    expect(layoutContentEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false)
    expect(layoutContentEqual({ a: 1, b: 2 }, { a: 1 })).toBe(false)
  })

  it('数组按位比,长度不同不相等;嵌套数组里的对象键序也不敏感', () => {
    expect(layoutContentEqual([{ x: 1, y: 2 }], [{ y: 2, x: 1 }])).toBe(true)
    expect(layoutContentEqual([1, 2], [1, 2, 3])).toBe(false)
    expect(layoutContentEqual([1, 2], [2, 1])).toBe(false)
  })

  it('原始值按 Object.is:NaN 与 NaN 相等,0 与 -0 也认相等', () => {
    expect(layoutContentEqual(NaN, NaN)).toBe(true)
    expect(layoutContentEqual(0, -0)).toBe(true)
    expect(layoutContentEqual(1, '1')).toBe(false)
    expect(layoutContentEqual(null, undefined)).toBe(false)
  })
})
