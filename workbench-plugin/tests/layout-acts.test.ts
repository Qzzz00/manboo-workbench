// @vitest-environment node
/**
 * 动作草案 → 新布局(2026-09-22「用自然语言改布局」)。
 *
 * 这一份钉的是**映射**,不是几何:每一种 kind 跑出来的结果,必须与直接调 layout.ts 里
 * 那个对应的纯函数**一模一样**。几何本身早有用例(client-layout / client-landscape-regions),
 * 这里不重测一遍 —— 重测一遍等于把同一条规矩写了两份,两份迟早会分叉。
 */
import { describe, expect, it } from 'vitest'
import type { WorkbenchLayout } from '../src/protocol.ts'
import { LAYOUT_ACT_KINDS, LAYOUT_DECK_TARGET } from '../src/protocol.ts'
import {
  DEFAULT_LANDSCAPE_MODULES,
  DEFAULT_LAYOUT,
  landscapeArrangement,
  landscapeDeckPct,
  moveModule,
  resizeLandscapeDeck,
  resizeModule,
  toggleHidden,
} from '../src/client/layout.ts'
import { applyLayoutActs, parseLayoutActs } from '../src/layoutActs.ts'

function landscape(): WorkbenchLayout {
  return {
    modules: DEFAULT_LAYOUT.modules.map(module => ({ ...module })),
    butler: { corner: 'br', min: false },
    landscape: { modules: DEFAULT_LANDSCAPE_MODULES.map(module => ({ ...module })) },
  }
}

function portrait(): WorkbenchLayout {
  return { modules: DEFAULT_LAYOUT.modules.map(module => ({ ...module })), butler: { corner: 'br', min: false } }
}

function ok(result: ReturnType<typeof applyLayoutActs>) {
  if (!result.ok) throw new Error(result.error)
  return result
}

describe('每一种 kind 都落到 layout.ts 那个既有函数上', () => {
  it('move 上 = moveModule(-1)', () => {
    const base = portrait()
    const got = ok(applyLayoutActs(base, [{ kind: 'move', module: 'notes', dir: 'up' }], 'portrait'))
    expect(got.layout).toEqual(moveModule(base, 'notes', -1, 'portrait'))
    expect(got.applied[0]).toMatchObject({ kind: 'move', module: 'notes', changed: true })
  })

  it('move 下 = moveModule(+1)', () => {
    const base = portrait()
    const got = ok(applyLayoutActs(base, [{ kind: 'move', module: 'usage', dir: 'down' }], 'portrait'))
    expect(got.layout).toEqual(moveModule(base, 'usage', 1, 'portrait'))
  })

  it('move 左右 = 跟同一排的邻居换位(横屏底部一排)', () => {
    const base = landscape()
    const before = landscapeArrangement(base).deck.map(module => module.id)
    const got = ok(applyLayoutActs(base, [{ kind: 'move', module: 'notes', dir: 'left' }], 'landscape'))
    const after = landscapeArrangement(got.layout).deck.map(module => module.id)
    // 默认底部是 usage / quota / notes / files;notes 往左 → 跟 quota 对调。
    expect(before).toEqual(['usage', 'quota', 'notes', 'files'])
    expect(after).toEqual(['usage', 'notes', 'quota', 'files'])
  })

  it('move 左到头 = 没有邻居,原样返回并如实说一句', () => {
    const base = landscape()
    const got = ok(applyLayoutActs(base, [{ kind: 'move', module: 'usage', dir: 'left' }], 'landscape'))
    expect(got.layout).toEqual(base)
    expect(got.applied[0]?.changed).toBe(false)
    expect(got.applied[0]?.note).toContain('左边')
  })

  it('region side = 挪进右侧栏,落在项目区下面(Ben 那句原话)', () => {
    const base = landscape()
    const got = ok(applyLayoutActs(base, [{ kind: 'region', module: 'usage', region: 'side' }], 'landscape'))
    const { side, deck } = landscapeArrangement(got.layout)
    expect(side.map(module => module.id)).toEqual(['projects', 'usage'])
    expect(deck.map(module => module.id)).toEqual(['quota', 'notes', 'files'])
  })

  it('region side 幂等:已经在右侧栏里,再说一次不动', () => {
    const once = ok(applyLayoutActs(landscape(), [{ kind: 'region', module: 'usage', region: 'side' }], 'landscape'))
    const twice = ok(applyLayoutActs(once.layout, [{ kind: 'region', module: 'usage', region: 'side' }], 'landscape'))
    expect(twice.layout).toEqual(once.layout)
    expect(twice.applied[0]?.changed).toBe(false)
  })

  it('region deck = 挪回底部那一排', () => {
    const up = ok(applyLayoutActs(landscape(), [{ kind: 'region', module: 'usage', region: 'side' }], 'landscape'))
    const back = ok(applyLayoutActs(up.layout, [{ kind: 'region', module: 'usage', region: 'deck' }], 'landscape'))
    expect(landscapeArrangement(back.layout).side.map(module => module.id)).toEqual(['projects'])
    expect(landscapeArrangement(back.layout).deck.map(module => module.id)).toContain('usage')
  })

  it('region 在竖屏上不做事(竖屏没有区域这回事),如实说一句', () => {
    const base = portrait()
    const got = ok(applyLayoutActs(base, [{ kind: 'region', module: 'usage', region: 'side' }], 'portrait'))
    expect(got.layout).toEqual(base)
    expect(got.applied[0]?.note).toContain('竖屏')
  })

  it('region 碰钉死的两格 = 不动', () => {
    const base = landscape()
    for (const id of ['slot', 'projects']) {
      const got = ok(applyLayoutActs(base, [{ kind: 'region', module: id, region: 'deck' }], 'landscape'))
      expect(got.layout).toEqual(base)
      expect(got.applied[0]?.changed).toBe(false)
    }
  })

  it('hide = toggleHidden;已经藏着就不动(幂等)', () => {
    const base = portrait()
    const got = ok(applyLayoutActs(base, [{ kind: 'hide', module: 'notes' }], 'portrait'))
    expect(got.layout).toEqual(toggleHidden(base, 'notes', 'portrait'))
    const again = ok(applyLayoutActs(got.layout, [{ kind: 'hide', module: 'notes' }], 'portrait'))
    expect(again.layout).toEqual(got.layout)
    expect(again.applied[0]?.note).toContain('本来就是藏着的')
  })

  it('show = toggleHidden;本来就显示着就不动(幂等)', () => {
    const hidden = ok(applyLayoutActs(portrait(), [{ kind: 'hide', module: 'notes' }], 'portrait'))
    const shown = ok(applyLayoutActs(hidden.layout, [{ kind: 'show', module: 'notes' }], 'portrait'))
    expect(shown.layout.modules.find(module => module.id === 'notes')?.hidden).toBe(false)
    const again = ok(applyLayoutActs(shown.layout, [{ kind: 'show', module: 'notes' }], 'portrait'))
    expect(again.applied[0]?.changed).toBe(false)
  })

  it('rename 只写 titles,一个几何字段都不碰', () => {
    const base = portrait()
    const got = ok(applyLayoutActs(base, [{ kind: 'rename', module: 'projects', title: '账号' }], 'portrait'))
    expect(got.layout.titles).toEqual({ projects: '账号' })
    expect(got.layout.modules).toEqual(base.modules)
  })

  it('rename 成空串 = 撤掉这个自定义名字,titles 空了连键一起去掉', () => {
    const named = ok(applyLayoutActs(portrait(), [{ kind: 'rename', module: 'projects', title: '账号' }], 'portrait'))
    const cleared = ok(applyLayoutActs(named.layout, [{ kind: 'rename', module: 'projects', title: '' }], 'portrait'))
    expect('titles' in cleared.layout).toBe(false)
  })

  it('resize 高矮(模块)= resizeModule', () => {
    const base = portrait()
    const got = ok(applyLayoutActs(base, [{ kind: 'resize', module: 'projects', axis: 'height', delta_pct: 6 }], 'portrait'))
    expect(got.layout).toEqual(resizeModule(base, 'projects', 6, 'portrait'))
  })

  it('resize 高矮(底部那一排)= resizeLandscapeDeck', () => {
    const base = landscape()
    const got = ok(applyLayoutActs(base, [{ kind: 'resize', module: LAYOUT_DECK_TARGET, axis: 'height', delta_pct: 6 }], 'landscape'))
    expect(got.layout).toEqual(resizeLandscapeDeck(base, 6))
    expect(landscapeDeckPct(got.layout)).toBeGreaterThan(landscapeDeckPct(base))
  })

  it('resize 底部那一排在竖屏上不做事', () => {
    const base = portrait()
    const got = ok(applyLayoutActs(base, [{ kind: 'resize', module: LAYOUT_DECK_TARGET, axis: 'height', delta_pct: 6 }], 'portrait'))
    expect(got.layout).toEqual(base)
    expect(got.applied[0]?.note).toContain('底部那一排')
  })

  it('resize 宽窄 = 跟邻居分,两格之和不变(横屏底部)', () => {
    const base = landscape()
    const got = ok(applyLayoutActs(base, [{ kind: 'resize', module: 'usage', axis: 'width', delta_pct: 6 }], 'landscape'))
    const widthOf = (layout: WorkbenchLayout, id: string): number =>
      (layout.landscape?.modules.find(module => module.id === id)?.width_pct ?? 0)
    expect(widthOf(got.layout, 'usage')).toBe(31)
    expect(widthOf(got.layout, 'quota')).toBe(19)
    expect(widthOf(got.layout, 'usage') + widthOf(got.layout, 'quota')).toBe(50)
  })

  it('swap = 两格位置整体对调,收起状态跟着自己不跟着位置', () => {
    const hidden = ok(applyLayoutActs(portrait(), [{ kind: 'hide', module: 'notes' }], 'portrait'))
    const got = ok(applyLayoutActs(hidden.layout, [{ kind: 'swap', module: 'notes', other: 'files' }], 'portrait'))
    const notes = got.layout.modules.find(module => module.id === 'notes')
    const files = got.layout.modules.find(module => module.id === 'files')
    // 位置换了(默认 notes 40% / files 60%)。
    expect(notes?.width_pct).toBe(60)
    expect(files?.width_pct).toBe(40)
    // 收起状态没跟着换。
    expect(notes?.hidden).toBe(true)
    expect(files?.hidden).not.toBe(true)
  })
})

describe('一次调用是原子的', () => {
  it('三条动作顺次跑完,applied 逐条交代', () => {
    const got = ok(applyLayoutActs(landscape(), [
      { kind: 'region', module: 'usage', region: 'side' },
      { kind: 'region', module: 'quota', region: 'side' },
      { kind: 'hide', module: 'notes' },
    ], 'landscape'))
    expect(got.applied.map(one => one.changed)).toEqual([true, true, true])
    expect(landscapeArrangement(got.layout).side.map(module => module.id)).toEqual(['projects', 'usage', 'quota'])
  })

  it('认不出的模块 → 整次拒绝,一条都不落', () => {
    const result = applyLayoutActs(landscape(), [
      { kind: 'hide', module: 'notes' },
      { kind: 'hide', module: '不存在的格子' },
    ], 'landscape')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('不存在的格子')
  })

  it('空数组 → 拒绝', () => {
    expect(applyLayoutActs(landscape(), [], 'landscape').ok).toBe(false)
  })
})

describe('parseLayoutActs:从 HTTP 打进来的那一份', () => {
  it('七种 kind 全放行', () => {
    for (const kind of LAYOUT_ACT_KINDS) {
      const parsed = parseLayoutActs([{ kind, module: 'notes' }])
      expect('acts' in parsed).toBe(true)
    }
  })

  it('认不出的 kind → 明确报错(不悄悄当成别的动作)', () => {
    const parsed = parseLayoutActs([{ kind: 'delete', module: 'notes' }])
    expect('error' in parsed && parsed.error).toContain('delete')
  })

  const bad: readonly [string, unknown][] = [
    ['不是数组', { kind: 'hide' }],
    ['空数组', []],
    ['条目不是对象', ['hide']],
    ['没有 module', [{ kind: 'hide' }]],
    ['dir 不认得', [{ kind: 'move', module: 'notes', dir: 'sideways' }]],
    ['region 不认得', [{ kind: 'region', module: 'notes', region: 'middle' }]],
    ['axis 不认得', [{ kind: 'resize', module: 'notes', axis: 'depth' }]],
    ['delta_pct 不是数字', [{ kind: 'resize', module: 'notes', delta_pct: '6' }]],
    ['delta_pct 是 NaN', [{ kind: 'resize', module: 'notes', delta_pct: Number.NaN }]],
    ['title 不是字符串', [{ kind: 'rename', module: 'notes', title: 7 }]],
  ]
  for (const [name, value] of bad) {
    it(`${name} → 400`, () => { expect('error' in parseLayoutActs(value)).toBe(true) })
  }
})
