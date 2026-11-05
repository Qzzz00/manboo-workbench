/**
 * 一份动作草案 → 一份新布局(2026-09-22,「用自然语言改布局」)。
 *
 * ## 这个文件**只做映射,不做几何**
 *
 * 每一种 kind 都在下面这张表里指到 `client/layout.ts` 里一个**已经存在、已经有用例**的
 * 纯函数。没有一处在算坐标、算百分比、算谁该排在谁前面 —— 那些算法两个月来一直住在
 * layout.ts 里,箭头和拖拽把手用的就是它们。事务官改布局与用户自己点箭头,走的必须是
 * **同一条路**:否则"事务官挪的"和"我自己挪的"迟早会排出两种不一样的结果。
 *
 * | kind | 落到哪个函数 |
 * |---|---|
 * | `move` (上/下) | `moveModule(layout, id, ±1, orientation)` |
 * | `move` (左/右) | 找到同排的那个邻居 → `swapModules` |
 * | `region` | 反复 `moveLandscapeModule`,直到 `landscapeArrangement` 说它在目标区域里 |
 * | `hide` / `show` | `toggleHidden`(**只在方向对的时候调**,所以它是幂等的) |
 * | `rename` | `renameModule` |
 * | `resize` height,模块 | `resizeModule` |
 * | `resize` height,`deck` | `resizeLandscapeDeck` |
 * | `resize` width,竖屏 | `resizeRowPair`(与同一行里那个伙伴) |
 * | `resize` width,横屏底部 | `resizeLandscapeDeckPair`(与底部那一排里的邻居) |
 * | `swap` | `swapModules` |
 *
 * ## 一次调用是**原子**的
 *
 * `applyLayoutActs` 在一份布局上顺次跑完所有动作,中途没有任何一次落盘。调用方拿到的
 * 要么是"全跑完的那一份",要么是一条错误 —— 不会出现"三个动作落了两个"。
 *
 * ## 动作跑了等于没跑,不是错
 *
 * 「把已经藏起来的随手记再藏一次」「把已经在最上面那格再往上挪」——这些都**原样返回**,
 * 并在 `applied` 里如实标 `changed: false`。事务官据此说一句「它本来就是藏着的」,
 * 而不是报一个用户看不懂的错(同 layout.ts 里"挪不动就原样返回,不折返不循环"的规矩)。
 */
import type { LayoutAct, LayoutModule, WorkbenchLayout } from './protocol.ts'
import { LAYOUT_ACT_KINDS, LAYOUT_DECK_TARGET } from './protocol.ts'
import {
  LANDSCAPE_PINNED_IDS,
  MODULE_IDS,
  branchModules,
  landscapeArrangement,
  moveLandscapeModule,
  moveModule,
  renameModule,
  resizeLandscapeDeck,
  resizeLandscapeDeckPair,
  resizeModule,
  resizeRowPair,
  swapModules,
  toggleHidden,
} from './client/layout.ts'

export type LayoutActOrientation = 'portrait' | 'landscape'

/** 一条动作跑完之后的交代。**每一条都回**,包括"什么都没变"的那些。 */
export interface LayoutActApplied {
  kind: LayoutAct['kind']
  module: string
  /** 这一条真的改到了布局没有。false = 它本来就是那样(幂等,不是错)。 */
  changed: boolean
  /** 没改到的时候,为什么。改到了就缺席。 */
  note?: string
}

export type LayoutActsResult =
  | { ok: true, layout: WorkbenchLayout, applied: LayoutActApplied[] }
  | { ok: false, error: string }

/** 布局是不是变了。**按 JSON 比**:所有变换都是纯函数、没改到就原样返回同一个引用,
 * 但 `withBranchModules` 这类每次都新建对象,所以不能只比引用。 */
function changed(before: WorkbenchLayout, after: WorkbenchLayout): boolean {
  return JSON.stringify(before) !== JSON.stringify(after)
}

function isKnownModule(id: string): boolean {
  return (MODULE_IDS as readonly string[]).includes(id)
}

/** 竖屏下,跟这一格同一行的其它模块(按 order)。行号缺席的模块自成一行。 */
function portraitRow(layout: WorkbenchLayout, id: string): readonly LayoutModule[] {
  const modules = [...branchModules(layout, 'portrait')].sort((left, right) => left.order - right.order)
  const self = modules.find(module => module.id === id)
  if (self === undefined) return []
  return modules.filter(module => module.row === self.row)
}

/**
 * 「往左 / 往右挪一格」的那个邻居是谁。
 *
 * - 横屏、在底部一排里 → 底部那一排里左右相邻的那一格;
 * - 横屏、在右侧栏里 → 右侧栏是**竖排**,左右没有邻居(回 undefined,动作成为一次空转);
 * - 竖屏 → 同一行里左右相邻的那一格(一行只有一格时同样没有邻居)。
 */
function sideNeighbour(
  layout: WorkbenchLayout, id: string, dir: 'left' | 'right', orientation: LayoutActOrientation,
): string | undefined {
  const row = orientation === 'landscape'
    ? landscapeArrangement(layout).deck
    : portraitRow(layout, id)
  const index = row.findIndex(module => module.id === id)
  if (index === -1) return undefined
  const target = row[index + (dir === 'left' ? -1 : 1)]
  return target?.id
}

/** 这一格此刻在横屏的哪个区域。项目区钉在右侧栏最上,所以它恒为 `side`。 */
function regionOf(layout: WorkbenchLayout, id: string): 'side' | 'deck' | undefined {
  const { side, deck } = landscapeArrangement(layout)
  if (side.some(module => module.id === id)) return 'side'
  if (deck.some(module => module.id === id)) return 'deck'
  return undefined
}

/**
 * 把一格挪进指定区域:**反复调上/下箭头那一个函数**,直到它落进去。
 *
 * 为什么是"反复调"而不是直接写一个 `setRegion`:箭头那条路上有一堆已经验过的规矩
 * (项目区不可越过、收起的格子要跨过去、回底部时高度对齐、底部空了整条收起)。
 * 另写一个直接改 `region` 字段的函数,等于把那些规矩重写一遍——而重写一遍就是再错一遍。
 *
 * 循环上限 = 模块个数 + 1。`moveLandscapeModule` 挪不动时原样返回,所以真实情况下
 * 一步就到位;上限是**防死循环的保险**,不是算法的一部分。
 */
function intoRegion(layout: WorkbenchLayout, id: string, region: 'side' | 'deck'): WorkbenchLayout {
  const dir = region === 'side' ? -1 : 1
  let current = layout
  const limit = branchModules(layout, 'landscape').length + 1
  for (let i = 0; i < limit; i += 1) {
    if (regionOf(current, id) === region) return current
    const next = moveLandscapeModule(current, id, dir)
    if (!changed(current, next)) return current
    current = next
  }
  return current
}

/** 一条动作。回新布局 + 一句交代;拿不动的原样返回(不是错)。 */
function applyOne(
  layout: WorkbenchLayout, act: LayoutAct, orientation: LayoutActOrientation,
): { layout: WorkbenchLayout, note?: string } {
  const id = act.module
  switch (act.kind) {
    case 'move': {
      if (act.dir === 'up' || act.dir === 'down') {
        return { layout: moveModule(layout, id, act.dir === 'up' ? -1 : 1, orientation) }
      }
      if (act.dir === 'left' || act.dir === 'right') {
        const neighbour = sideNeighbour(layout, id, act.dir, orientation)
        if (neighbour === undefined) {
          return { layout, note: `「${id}」${act.dir === 'left' ? '左' : '右'}边没有别的格子可以换。` }
        }
        return { layout: swapModules(layout, id, neighbour, orientation) }
      }
      return { layout, note: '这一条没说往哪个方向挪。' }
    }
    case 'region': {
      if (orientation !== 'landscape') return { layout, note: '竖屏没有区域这回事,这一条跳过了。' }
      if (act.region !== 'side' && act.region !== 'deck') return { layout, note: '这一条没说挪去哪个区域。' }
      if ((LANDSCAPE_PINNED_IDS as readonly string[]).includes(id)) {
        return { layout, note: `「${id}」在横屏下是钉死的,挪不了。` }
      }
      return { layout: intoRegion(layout, id, act.region) }
    }
    case 'hide': {
      const found = branchModules(layout, orientation).find(module => module.id === id)
      if (found?.hidden === true) return { layout, note: '它本来就是藏着的。' }
      return { layout: toggleHidden(layout, id, orientation) }
    }
    case 'show': {
      const found = branchModules(layout, orientation).find(module => module.id === id)
      if (found !== undefined && found.hidden !== true) return { layout, note: '它本来就显示着。' }
      return { layout: toggleHidden(layout, id, orientation) }
    }
    case 'rename': {
      if (typeof act.title !== 'string') return { layout, note: '这一条没说新名字。' }
      return { layout: renameModule(layout, id, act.title) }
    }
    case 'swap': {
      if (typeof act.other !== 'string' || act.other === '') return { layout, note: '这一条没说跟谁换。' }
      if (!isKnownModule(act.other)) return { layout, note: `没有「${act.other}」这一格。` }
      return { layout: swapModules(layout, id, act.other, orientation) }
    }
    case 'resize': {
      const delta = typeof act.delta_pct === 'number' && Number.isFinite(act.delta_pct) ? act.delta_pct : 0
      if (delta === 0) return { layout, note: '这一条没说加减多少。' }
      // 底部那一整排的高度(横屏)。它不是一个模块,所以走自己那个函数。
      if (id === LAYOUT_DECK_TARGET) {
        if (orientation !== 'landscape') return { layout, note: '竖屏没有「底部那一排」。' }
        if (act.axis === 'width') return { layout, note: '底部那一排是横着的,调不了宽窄。' }
        return { layout: resizeLandscapeDeck(layout, delta) }
      }
      if (act.axis === 'width') {
        const neighbour = sideNeighbour(layout, id, 'right', orientation)
          ?? sideNeighbour(layout, id, 'left', orientation)
        if (neighbour === undefined) return { layout, note: `「${id}」旁边没有别的格子,宽窄是跟邻居分的。` }
        // 跟右邻居分时,自己加 delta;跟左邻居分时,自己是"右边那个",所以传给左邻居 -delta。
        const rightNeighbour = sideNeighbour(layout, id, 'right', orientation)
        const left = rightNeighbour === undefined ? neighbour : id
        const right = rightNeighbour ?? id
        const signed = rightNeighbour === undefined ? -delta : delta
        return orientation === 'landscape'
          ? { layout: resizeLandscapeDeckPair(layout, left, right, signed) }
          : { layout: resizeRowPair(layout, left, right, signed, orientation) }
      }
      return { layout: resizeModule(layout, id, delta, orientation) }
    }
    default:
      return { layout, note: '这一条我不认得。' }
  }
}

/**
 * 顺次跑完一份动作草案。**一次调用一次原子**:中途不落盘,要么全跑完要么回一条错。
 *
 * 认不出的模块 id / 认不出的 kind 走**明确报错**,不是静默跳过 —— 静默跳过会让
 * 「我挪好了」这句话在什么都没发生的时候照样说出口。
 */
export function applyLayoutActs(
  layout: WorkbenchLayout, acts: readonly LayoutAct[], orientation: LayoutActOrientation,
): LayoutActsResult {
  if (acts.length === 0) return { ok: false, error: '一条动作都没有。' }
  const applied: LayoutActApplied[] = []
  let current = layout
  for (const act of acts) {
    if (typeof act?.module !== 'string' || act.module === '') return { ok: false, error: '有一条动作没说是哪一格。' }
    if (act.module !== LAYOUT_DECK_TARGET && !isKnownModule(act.module)) {
      return { ok: false, error: `没有「${act.module}」这一格。` }
    }
    const before = current
    const result = applyOne(current, act, orientation)
    current = result.layout
    const didChange = changed(before, current)
    applied.push({
      kind: act.kind,
      module: act.module,
      changed: didChange,
      ...(didChange ? {} : { note: result.note ?? '这一步没改到什么(它本来就是那样)。' }),
    })
  }
  return { ok: true, layout: current, applied }
}

/** 校验一份从 HTTP 打进来的动作数组。**认不出的键一律 400**,不悄悄当成别的动作。 */
export function parseLayoutActs(value: unknown): { acts: LayoutAct[] } | { error: string } {
  if (!Array.isArray(value)) return { error: 'actions 必须是数组' }
  if (value.length === 0) return { error: 'actions 不能是空数组' }
  const acts: LayoutAct[] = []
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) return { error: 'actions 里每一条都必须是对象' }
    const one = raw as Record<string, unknown>
    if (typeof one.kind !== 'string' || !(LAYOUT_ACT_KINDS as readonly string[]).includes(one.kind)) {
      return { error: `认不出的动作:${String(one.kind)}` }
    }
    if (typeof one.module !== 'string' || one.module === '') return { error: '每一条动作都要说是哪一格(module)' }
    const act: LayoutAct = { kind: one.kind as LayoutAct['kind'], module: one.module }
    if (one.dir !== undefined) {
      if (!['up', 'down', 'left', 'right'].includes(one.dir as string)) return { error: 'dir 只能是 up / down / left / right' }
      act.dir = one.dir as 'up' | 'down' | 'left' | 'right'
    }
    if (one.region !== undefined) {
      if (one.region !== 'side' && one.region !== 'deck') return { error: 'region 只能是 side / deck' }
      act.region = one.region
    }
    if (one.title !== undefined) {
      if (typeof one.title !== 'string') return { error: 'title 必须是字符串' }
      act.title = one.title
    }
    if (one.other !== undefined) {
      if (typeof one.other !== 'string') return { error: 'other 必须是字符串' }
      act.other = one.other
    }
    if (one.axis !== undefined) {
      if (one.axis !== 'height' && one.axis !== 'width') return { error: 'axis 只能是 height / width' }
      act.axis = one.axis
    }
    if (one.delta_pct !== undefined) {
      if (typeof one.delta_pct !== 'number' || !Number.isFinite(one.delta_pct)) return { error: 'delta_pct 必须是数字' }
      act.delta_pct = one.delta_pct
    }
    acts.push(act)
  }
  return { acts }
}
