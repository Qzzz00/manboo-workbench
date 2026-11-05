/**
 * 横屏模块挪区(2026-09-20,分支 fix/landscape-module-move)。
 *
 * Ben 原话:「横屏情况下,点击下面的消耗数据和余额/额度,想要拉到项目区的下面去,
 * 点击向上的箭头是无效的」。根因:横屏的五个区域是写死的,箭头只交换 order,
 * 而横屏渲染根本不看 order —— 点了当然没反应。
 *
 * 这份文件只钉纯函数那一层(不碰 DOM):**区域**(deck 底部一排 / side 右侧栏)是横屏
 * 布局里新的第一类概念,上下箭头改的是"这个模块待在哪个区域、在区域里排第几"。
 * 渲染那一层(箭头 disabled 与真实位置一致)在 tests/client-landscape-move.test.tsx。
 */
import { describe, expect, it } from 'vitest'
import {
  canMoveLandscape, DEFAULT_LAYOUT, landscapeArrangement, landscapeDeckPct, landscapeSidePct,
  landscapeSideTotal, LANDSCAPE_SIDE_DEFAULT_PCT, LANDSCAPE_SIDE_PROJECTS_DEFAULT_PCT,
  moveLandscapeModule, moveModule, resetLayout, resizeLandscapeDeck, resizeLandscapeSidePair,
} from '../src/client/layout.ts'
import { LANDSCAPE_SIDE_MIN_PCT } from '../src/protocol.ts'
import type { WorkbenchLayout } from '../src/protocol.ts'

/** 横屏起点:顶层竖屏那一份原样,横屏分支缺席(= 从没在横屏上动过布局的机器)。 */
function landscapeStart(): WorkbenchLayout {
  return { modules: DEFAULT_LAYOUT.modules.map(m => ({ ...m })), butler: { ...DEFAULT_LAYOUT.butler } }
}

/** 底部一排从左到右都有谁。 */
function deckIds(layout: WorkbenchLayout): string[] {
  return landscapeArrangement(layout).deck.map(m => m.id)
}

/** 右侧栏从上到下都有谁(项目区恒在最上)。 */
function sideIds(layout: WorkbenchLayout): string[] {
  return landscapeArrangement(layout).side.map(m => m.id)
}

// ───────────────────────────────────────────────────────────────────────────
describe('① 起点:旧存档缺 region 时四格全在底部一排', () => {
  it('横屏分支缺席时,右侧栏只有项目区,底部一排是四格', () => {
    const layout = landscapeStart()

    expect(sideIds(layout)).toEqual(['projects'])
    expect(deckIds(layout)).toEqual(['usage', 'quota', 'notes', 'files'])
  })

  it('存档里带着 2026-09-18 那一版横屏模块(没有 region 键)时,一格都不挪', () => {
    const layout: WorkbenchLayout = {
      ...landscapeStart(),
      landscape: {
        modules: [
          { id: 'slot', order: 0, basis_pct: 70, width_pct: 64 },
          { id: 'projects', order: 1, basis_pct: 70, width_pct: 36 },
          { id: 'usage', order: 2, basis_pct: 24, width_pct: 25 },
          { id: 'quota', order: 3, basis_pct: 24, width_pct: 25 },
          { id: 'notes', order: 4, basis_pct: 24, width_pct: 25 },
          { id: 'files', order: 5, basis_pct: 24, width_pct: 25 },
        ],
      },
    }

    expect(sideIds(layout)).toEqual(['projects'])
    expect(deckIds(layout)).toEqual(['usage', 'quota', 'notes', 'files'])
  })
})

// ───────────────────────────────────────────────────────────────────────────
describe('② 上箭头:底部格 → 右侧栏最下(Ben 要的那一下)', () => {
  it('消耗数据点一次上箭头,就出现在项目区下面', () => {
    const next = moveLandscapeModule(landscapeStart(), 'usage', -1)

    expect(sideIds(next)).toEqual(['projects', 'usage'])
    expect(deckIds(next)).toEqual(['quota', 'notes', 'files'])
  })

  it('余额/额度跟着上来,排在消耗数据下面(后来的落在最下)', () => {
    const next = moveLandscapeModule(moveLandscapeModule(landscapeStart(), 'usage', -1), 'quota', -1)

    expect(sideIds(next)).toEqual(['projects', 'usage', 'quota'])
    expect(deckIds(next)).toEqual(['notes', 'files'])
  })

  it('moveModule(..., "landscape") 走的是同一条路——调用点不必改', () => {
    const viaMove = moveModule(landscapeStart(), 'usage', -1, 'landscape')

    expect(sideIds(viaMove)).toEqual(['projects', 'usage'])
  })

  it('挪进右侧栏的那一格拿到默认高度占比,项目区仍占大头', () => {
    const next = moveLandscapeModule(landscapeStart(), 'usage', -1)

    expect(landscapeSidePct(next, 'projects')).toBe(LANDSCAPE_SIDE_PROJECTS_DEFAULT_PCT)
    expect(landscapeSidePct(next, 'usage')).toBe(LANDSCAPE_SIDE_DEFAULT_PCT)
    expect(landscapeSideTotal(next)).toBe(
      LANDSCAPE_SIDE_PROJECTS_DEFAULT_PCT + LANDSCAPE_SIDE_DEFAULT_PCT,
    )
  })
})

// ───────────────────────────────────────────────────────────────────────────
describe('③ 右侧栏内再上/再下:换位,项目区不可越过', () => {
  /** 项目区 + 消耗数据 + 余额(上下这个顺序)。 */
  function sideWithTwo(): WorkbenchLayout {
    return moveLandscapeModule(moveLandscapeModule(landscapeStart(), 'usage', -1), 'quota', -1)
  }

  it('下面那格再上一次 → 与上面那格换位', () => {
    const next = moveLandscapeModule(sideWithTwo(), 'quota', -1)

    expect(sideIds(next)).toEqual(['projects', 'quota', 'usage'])
    expect(deckIds(next)).toEqual(['notes', 'files'])
  })

  it('紧挨项目区那一格再上 → 原样返回(项目区固定在最上,不可越过)', () => {
    const start = sideWithTwo()
    const next = moveLandscapeModule(start, 'usage', -1)

    expect(next).toBe(start)
    expect(canMoveLandscape(start, 'usage', -1)).toBe(false)
  })

  it('上面那格往下 → 与下面那格换位(同区域内换位照旧)', () => {
    const next = moveLandscapeModule(sideWithTwo(), 'usage', 1)

    expect(sideIds(next)).toEqual(['projects', 'quota', 'usage'])
  })

  it('中间那格被收起时,上箭头跨过它——disabled 与看得见的位置一致', () => {
    const base = sideWithTwo()
    const hiddenUsage: WorkbenchLayout = {
      ...base,
      landscape: {
        ...base.landscape,
        modules: (base.landscape?.modules ?? []).map(m => (m.id === 'usage' ? { ...m, hidden: true } : m)),
      },
    }

    // 收起的那格在数据里还在原位,但屏幕上余额就紧挨着项目区——再往上没有地方可去。
    expect(canMoveLandscape(hiddenUsage, 'quota', -1)).toBe(false)
    expect(moveLandscapeModule(hiddenUsage, 'quota', -1)).toBe(hiddenUsage)
  })
})

// ───────────────────────────────────────────────────────────────────────────
describe('④ 下箭头:右侧栏最下那格 → 回底部一排最右', () => {
  it('右侧栏只有一格时,它往下就回底部一排,排在最右', () => {
    const start = moveLandscapeModule(landscapeStart(), 'usage', -1)
    const next = moveLandscapeModule(start, 'usage', 1)

    expect(sideIds(next)).toEqual(['projects'])
    expect(deckIds(next)).toEqual(['quota', 'notes', 'files', 'usage'])
  })

  it('回到底部的那一格跟着底部一排的高度走,不出现一格高一格矮', () => {
    // 先把底部一排拖高,再把消耗数据挪上去、挪回来。
    const taller = resizeLandscapeDeck(landscapeStart(), 8)
    const deckPct = landscapeDeckPct(taller)
    const back = moveLandscapeModule(moveLandscapeModule(taller, 'usage', -1), 'usage', 1)

    expect(landscapeDeckPct(back)).toBe(deckPct)
    for (const module of landscapeArrangement(back).deck) {
      expect(module.basis_pct).toBe(deckPct)
    }
  })

  it('底部格的下箭头是死的:它已经在最下面,没有地方可去', () => {
    const start = landscapeStart()

    expect(canMoveLandscape(start, 'usage', 1)).toBe(false)
    expect(moveLandscapeModule(start, 'usage', 1)).toBe(start)
  })

  it('底部格的上箭头永远可用;右侧栏最下那格的下箭头永远可用', () => {
    const start = landscapeStart()
    expect(canMoveLandscape(start, 'files', -1)).toBe(true)

    const moved = moveLandscapeModule(start, 'files', -1)
    expect(canMoveLandscape(moved, 'files', 1)).toBe(true)
  })
})

// ───────────────────────────────────────────────────────────────────────────
describe('⑤ 边界:四格全挪走、固定模块、竖屏不受影响', () => {
  it('四格全挪进右侧栏时底部一排为空(整条收起由渲染层负责)', () => {
    let layout = landscapeStart()
    for (const id of ['usage', 'quota', 'notes', 'files']) layout = moveLandscapeModule(layout, id, -1)

    expect(deckIds(layout)).toEqual([])
    expect(sideIds(layout)).toEqual(['projects', 'usage', 'quota', 'notes', 'files'])
    // 空了之后仍然读得出一个合法高度(下一格挪回来时要用它),不是 NaN。
    expect(Number.isFinite(landscapeDeckPct(layout))).toBe(true)
  })

  it('窗位槽与项目区两个方向都挪不动(中间大区 / 右侧栏最上那一格是钉死的)', () => {
    const start = landscapeStart()
    for (const id of ['slot', 'projects']) {
      for (const dir of [-1, 1] as const) {
        expect(canMoveLandscape(start, id, dir)).toBe(false)
        expect(moveLandscapeModule(start, id, dir)).toBe(start)
      }
    }
  })

  it('横屏挪来挪去,竖屏那一份一个字不动', () => {
    const start = landscapeStart()
    const next = moveLandscapeModule(start, 'usage', -1)

    expect(next.modules).toEqual(start.modules)
  })

  it('「恢复默认布局」把它们放回底部一排', () => {
    let layout = landscapeStart()
    for (const id of ['usage', 'quota']) layout = moveLandscapeModule(layout, id, -1)

    const reset = resetLayout('landscape', layout)

    expect(sideIds(reset)).toEqual(['projects'])
    expect(deckIds(reset)).toEqual(['usage', 'quota', 'notes', 'files'])
  })
})

// ───────────────────────────────────────────────────────────────────────────
describe('⑥ 右侧栏上下两格之间那根把手', () => {
  function sideWithOne(): WorkbenchLayout {
    return moveLandscapeModule(landscapeStart(), 'usage', -1)
  }

  it('拖高上面那格,下面那格跟着矮同样多——两格之和恒定', () => {
    const start = sideWithOne()
    const sum = landscapeSidePct(start, 'projects') + landscapeSidePct(start, 'usage')
    const next = resizeLandscapeSidePair(start, 'projects', 'usage', 6)

    expect(landscapeSidePct(next, 'projects')).toBe(landscapeSidePct(start, 'projects') + 6)
    expect(landscapeSidePct(next, 'projects') + landscapeSidePct(next, 'usage')).toBe(sum)
  })

  it('拖到头停得住:两端各留下限,拖不没(要让一格消失走「收起」)', () => {
    const start = sideWithOne()
    const sum = landscapeSidePct(start, 'projects') + landscapeSidePct(start, 'usage')

    const down = resizeLandscapeSidePair(start, 'projects', 'usage', -999)
    expect(landscapeSidePct(down, 'projects')).toBe(LANDSCAPE_SIDE_MIN_PCT)
    expect(landscapeSidePct(down, 'usage')).toBe(sum - LANDSCAPE_SIDE_MIN_PCT)

    const up = resizeLandscapeSidePair(start, 'projects', 'usage', 999)
    expect(landscapeSidePct(up, 'usage')).toBe(LANDSCAPE_SIDE_MIN_PCT)
    expect(landscapeSidePct(up, 'projects')).toBe(sum - LANDSCAPE_SIDE_MIN_PCT)
  })

  it('认不出的 id / 同一个 id 原样返回,不悄悄改别的格', () => {
    const start = sideWithOne()

    expect(resizeLandscapeSidePair(start, 'projects', 'notes', 5)).toBe(start)
    expect(resizeLandscapeSidePair(start, 'usage', 'usage', 5)).toBe(start)
    expect(resizeLandscapeSidePair(start, 'butler', 'usage', 5)).toBe(start)
  })

  it('横屏改右侧栏高度,竖屏那一份一个字不动', () => {
    const start = sideWithOne()
    const next = resizeLandscapeSidePair(start, 'projects', 'usage', 6)

    expect(next.modules).toEqual(start.modules)
  })
})
