import { describe, expect, it } from 'vitest'
import type { LayoutModule } from '../src/protocol.ts'
import { migrateLayoutModules } from '../src/server/http.ts'

describe('migrateLayoutModules', () => {
  it('旧存档(无 usage)自动补一条并放进顶部行', () => {
    const migrated = migrateLayoutModules([
      { id: 'projects', order: 0, basis_pct: 28 },
      { id: 'slot', order: 1, basis_pct: 20 },
    ])
    const usage = migrated.find(m => m.id === 'usage')
    const projects = migrated.find(m => m.id === 'projects')
    expect(usage).toBeDefined()
    expect(usage?.row).toBe(projects?.row)
    expect((usage?.width_pct ?? 0) + (projects?.width_pct ?? 0)).toBe(100)
  })

  /**
   * 回归(2026-08-25 真机):客户端按「排序后**相邻**且 row 相同」分组成一行。
   * 迁移一开始把 usage 追加到列表末尾(order=max+1),row 虽然对得上,但中间隔着
   * slot/widgets,两者永远配不成一行——界面上顶部仍是项目区独占满宽,消耗数据
   * 掉到最底下自成一行。row 相同只是必要条件,**相邻才是充分条件**。
   */
  it('usage 必须紧挨在项目区后面,不能追加到末尾', () => {
    const migrated = migrateLayoutModules([
      { id: 'projects', order: 0, basis_pct: 34 },
      { id: 'slot', order: 1, basis_pct: 54 },
      { id: 'widgets', order: 2, basis_pct: 12 },
    ])
    const ordered = [...migrated].sort((left, right) => left.order - right.order).map(m => m.id)
    // 顺序必须是 projects → usage → quota 且连续:分组按"排序后相邻"做,
    // 中间插进别的模块就会把这一组拆散。
    // (末尾的 notes/files 是同一次迁移里 widgets 退休后换上的两栏,见下面那个 describe。)
    expect(ordered).toEqual(['projects', 'usage', 'quota', 'slot', 'notes', 'files'])

    const at = ordered.indexOf('usage')
    expect(ordered[at - 1]).toBe('projects')
  })

  /**
   * 回归(2026-08-25 真机):Ben 把项目区拖到 23.8% 过(那时那一行只放项目),
   * 迁移后同一行要多装一个数据面板,内容区只剩 34px,数据全在却一行都看不见。
   * 补 usage 这一次要把顶部行抬到可用高度——之后他想拖多矮都随他。
   */
  it('顶部行篇幅过矮时,补 usage 那一次抬到可用高度', () => {
    const migrated = migrateLayoutModules([
      { id: 'projects', order: 0, basis_pct: 23.78959653689452 },
      { id: 'slot', order: 1, basis_pct: 39.95 },
    ])
    // 要验的是**整行高度**够用。右列是 usage + quota 竖向堆叠,行高取两列所需高度的
    // 最大值,所以逐个断言单模块的 basis 没有意义——右列两个加起来才等于左列那一个。
    const basis = (id: string): number => migrated.find(m => m.id === id)?.basis_pct ?? 0
    expect(basis('projects')).toBe(48)
    expect(basis('usage') + basis('quota')).toBe(48)
    // 其他模块不受影响
    expect(basis('slot')).toBe(39.95)
  })

  it('顶部行本来就够高时不动它', () => {
    const migrated = migrateLayoutModules([
      { id: 'projects', order: 0, basis_pct: 55 },
      { id: 'slot', order: 1, basis_pct: 30 },
    ])
    const basis = (id: string): number => migrated.find(m => m.id === id)?.basis_pct ?? 0
    expect(basis('projects')).toBe(55)
    // 右列两个加起来等于左列(36 + 19 = 55),行高才对得上。
    expect(basis('usage') + basis('quota')).toBe(55)
  })

  it('order 重排后不重号', () => {
    const migrated = migrateLayoutModules([
      { id: 'projects', order: 0 },
      { id: 'slot', order: 1 },
      { id: 'widgets', order: 2 },
    ])
    // projects/slot 两条 + 补进来的 usage/quota + widgets 退休换成的 notes/files = 六条。
    const orders = migrated.map(m => m.order).sort((a, b) => a - b)
    expect(orders).toEqual([0, 1, 2, 3, 4, 5])
  })

  it('不改用户已经调过的其他模块高度', () => {
    const migrated = migrateLayoutModules([
      { id: 'projects', order: 0, basis_pct: 28 },
      { id: 'slot', order: 1, basis_pct: 55 },
      { id: 'widgets', order: 2, basis_pct: 12 },
    ])
    expect(migrated.find(m => m.id === 'slot')?.basis_pct).toBe(55)
    // widgets 这一条自己是**例外**:它在同一次迁移里退休成 notes/files 两栏,
    // 那一行的职责变了才抬到下限 24(理由见 http.ts 的 BOTTOM_ROW_MIN_BASIS)。
    // 这条用例守的是"**别的**模块高度不动"。
    expect(migrated.find(m => m.id === 'widgets')).toBeUndefined()
    expect(migrated.find(m => m.id === 'notes')?.basis_pct).toBe(24)
  })

  it('已经有 usage 的存档原样返回,不重复添加', () => {
    const existing: LayoutModule[] = [
      { id: 'projects', order: 0, basis_pct: 28, row: 0, width_pct: 70 },
      { id: 'usage', order: 1, basis_pct: 28, row: 0, width_pct: 30 },
    ]
    const migrated = migrateLayoutModules(existing)
    expect(migrated.filter(m => m.id === 'usage')).toHaveLength(1)
    expect(migrated.find(m => m.id === 'usage')?.width_pct).toBe(30)
  })

  it('认不出的脏 id 照旧被过滤掉', () => {
    const migrated = migrateLayoutModules([
      { id: 'projects', order: 0 },
      { id: '天知道这是啥', order: 1 },
    ])
    expect(migrated.some(m => m.id === '天知道这是啥')).toBe(false)
  })

  /**
   * 回归(2026-08-25 真机):usage 旧值 basis=8 是它跟项目区**左右并排**时拖出来的;
   * 搬进右列做竖向堆叠后,同一个数字含义完全变了——面板被压成只剩一条标题栏。
   * 所以"第一次进右列"这一次要按比例重新给,之后才保住用户自己拖的。
   */
  it('第一次搬进右列时重给高度,不照搬上一种布局下的旧值', () => {
    const migrated = migrateLayoutModules([
      { id: 'projects', order: 0, basis_pct: 34, row: 0, width_pct: 60 },
      { id: 'usage', order: 1, basis_pct: 8, row: 0, width_pct: 40 },
      { id: 'quota', order: 2, basis_pct: 18 },
    ])
    const basis = (id: string): number => migrated.find(m => m.id === id)?.basis_pct ?? 0
    expect(basis('usage')).toBe(31)
    expect(basis('quota')).toBe(17)
    expect(basis('usage') + basis('quota')).toBe(48)
  })

  it('已经在右列的,高度保住用户拖过的值', () => {
    const migrated = migrateLayoutModules([
      { id: 'projects', order: 0, basis_pct: 34, row: 0, col: 0, width_pct: 60 },
      { id: 'usage', order: 1, basis_pct: 9, row: 0, col: 1, width_pct: 40 },
      { id: 'quota', order: 2, basis_pct: 25, row: 0, col: 1, width_pct: 40 },
      { id: 'slot', order: 3, basis_pct: 40 },
    ])
    expect(migrated.find(m => m.id === 'usage')?.basis_pct).toBe(9)
    expect(migrated.find(m => m.id === 'quota')?.basis_pct).toBe(25)
  })
})

describe('widgets → notes + files 迁移(2026-08-25 版面重排)', () => {
  /** 已经补过右列(usage/quota)的存档,只差组件条退休这一步。 */
  const TOP_ROW_DONE = [
    { id: 'projects', order: 0, basis_pct: 34, row: 0, col: 0, width_pct: 60 },
    { id: 'usage', order: 1, basis_pct: 22, row: 0, col: 1, width_pct: 40 },
    { id: 'quota', order: 2, basis_pct: 12, row: 0, col: 1, width_pct: 40 },
    { id: 'slot', order: 3, basis_pct: 54, row: 1 },
  ]

  it('旧存档里的 widgets 换成同一行的 notes(40%) + files(60%),位置不变', () => {
    const migrated = migrateLayoutModules([
      ...TOP_ROW_DONE,
      { id: 'widgets', order: 4, basis_pct: 12, row: 2 },
    ])
    expect(migrated.map(m => m.id)).toEqual(['projects', 'usage', 'quota', 'slot', 'notes', 'files'])
    const notes = migrated.find(m => m.id === 'notes')
    const files = migrated.find(m => m.id === 'files')
    expect(notes?.width_pct).toBe(40)
    expect(files?.width_pct).toBe(60)
    expect(notes?.row).toBe(2)
    expect(files?.row).toBe(2)
    // 这一行的职责变了(从一条只放两个数字格的组件小条,变成随手记 + 一整格 Finder),
    // 按补 usage 那次的先例抬到下限 24;**别的模块的高度一律不动**——那是 Ben 自己调过的。
    expect(notes?.basis_pct).toBe(24)
    expect(files?.basis_pct).toBe(24)
    expect(migrated.find(m => m.id === 'slot')?.basis_pct).toBe(54)
  })

  it('Ben 已经把组件条拖得比 24 还高 → 尊重他的值,不往下压', () => {
    const migrated = migrateLayoutModules([
      ...TOP_ROW_DONE,
      { id: 'widgets', order: 4, basis_pct: 40, row: 2 },
    ])
    expect(migrated.find(m => m.id === 'notes')?.basis_pct).toBe(40)
    expect(migrated.find(m => m.id === 'files')?.basis_pct).toBe(40)
  })

  it('widgets 被收起过 → 两栏都跟着收起(不擅自替他展开)', () => {
    const migrated = migrateLayoutModules([
      ...TOP_ROW_DONE,
      { id: 'widgets', order: 4, basis_pct: 12, row: 2, hidden: true },
    ])
    expect(migrated.filter(m => m.id === 'notes' || m.id === 'files').every(m => m.hidden === true)).toBe(true)
  })

  it('更老的存档(widgets 没有 row 字段) → 给一个新行号,两栏才并得起来', () => {
    const migrated = migrateLayoutModules([
      ...TOP_ROW_DONE,
      { id: 'widgets', order: 4, basis_pct: 12 },
    ])
    const notes = migrated.find(m => m.id === 'notes')
    // 现有最大行号是 1(slot),所以新行号是 2——既不会被并进 slot 那一行,也不撞已有行。
    expect(notes?.row).toBe(2)
    expect(migrated.find(m => m.id === 'files')?.row).toBe(2)
    expect(notes?.row).toBe(migrated.find(m => m.id === 'files')?.row)
  })

  it('迁移是幂等的:再跑一遍不重复插', () => {
    const once = migrateLayoutModules([
      ...TOP_ROW_DONE,
      { id: 'widgets', order: 4, basis_pct: 12, row: 2 },
    ])
    expect(migrateLayoutModules(once)).toEqual(once)
  })

  it('已经没有 widgets 的存档不受影响(不会平白多出 notes/files)', () => {
    const migrated = migrateLayoutModules(TOP_ROW_DONE)
    expect(migrated.map(m => m.id)).toEqual(['projects', 'usage', 'quota', 'slot'])
  })
})

/**
 * 卡 TM(2026-09-27):**模板写出来的排布,读路径不许再"迁移"一遍**。
 *
 * 怎么撞出来的:切到自媒体运营模板之后,服务端把模板那份竖排原样写进盘(templateStore
 * 的 applyTemplateToLayout 不跑迁移),但 `/state` 那条读路径(composeState)对竖排
 * 跑了一遍 `migrateLayoutModules` —— 运营那份里 usage / quota 是**收起着摆在底部一排**的
 * (没有 `col`),迁移把「已经是目标形态」判成 false,于是:
 *   ① 把 usage / quota 拔到项目区旁边(col:1),
 *   ② 把项目区的高度从模板给的 20% 顶到 TOP_ROW_MIN_BASIS(48%)。
 * 结果是**他看到的排布跟模板卡片上写的不是一套**:选题池 / 发布计划被项目区挤到屏幕下面去。
 *
 * 判据:布局里出现 todo / publish / review 任一个,这份布局一定是 2026-09-21 布局模板
 * 之后由模板(或用户在模板之上调过)写出来的 —— 那些迁移说的全是更早的旧存档形态,
 * 没有任何可迁的东西。**只保留过滤与重排 order 这两道**。
 */
describe('模板写出来的排布不再被迁移改形(卡 TM)', () => {
  const OPS_PORTRAIT: LayoutModule[] = [
    { id: 'slot', order: 0, basis_pct: 30, row: 0 },
    { id: 'projects', order: 1, basis_pct: 20, row: 1, col: 0, width_pct: 100 },
    { id: 'todo', order: 2, basis_pct: 14, row: 1, col: 0, width_pct: 100 },
    { id: 'publish', order: 3, basis_pct: 12, row: 1, col: 0, width_pct: 100 },
    { id: 'review', order: 4, basis_pct: 24, row: 2, width_pct: 34 },
    { id: 'notes', order: 5, basis_pct: 24, row: 2, width_pct: 24 },
    { id: 'files', order: 6, basis_pct: 24, row: 2, width_pct: 42 },
    { id: 'usage', order: 7, basis_pct: 22, row: 2, width_pct: 25, hidden: true },
    { id: 'quota', order: 8, basis_pct: 12, row: 2, width_pct: 25, hidden: true },
  ]

  it('★ 自媒体运营那份竖排原样通过,一格不挪、一个百分比不改', () => {
    expect(migrateLayoutModules(OPS_PORTRAIT)).toEqual(OPS_PORTRAIT)
  })

  it('项目区的高度不许被顶到 48%(模板给的是 20%)', () => {
    expect(migrateLayoutModules(OPS_PORTRAIT).find(m => m.id === 'projects')?.basis_pct).toBe(20)
  })

  it('收起着的 usage / quota 仍然留在底部那一排,不被拔到项目区旁边', () => {
    const migrated = migrateLayoutModules(OPS_PORTRAIT)
    for (const id of ['usage', 'quota']) {
      const found = migrated.find(m => m.id === id)
      expect(found?.col).toBeUndefined()
      expect(found?.row).toBe(2)
    }
  })

  it('过滤那一道照旧:幽灵 id 仍然剔掉,order 重排成下标', () => {
    const migrated = migrateLayoutModules([
      ...OPS_PORTRAIT,
      { id: 'sessions', order: 9 } as LayoutModule,
    ])
    expect(migrated.some(m => m.id === 'sessions')).toBe(false)
    expect(migrated.map(m => m.order)).toEqual(migrated.map((_, at) => at))
  })

  it('做产品那套(没有 todo / publish / review)照旧走迁移,行为一字不变', () => {
    const migrated = migrateLayoutModules([
      { id: 'projects', order: 0, basis_pct: 28 },
      { id: 'slot', order: 1, basis_pct: 20 },
    ])
    expect(migrated.map(m => m.id)).toEqual(['projects', 'usage', 'quota', 'slot'])
  })
})
