/**
 * 自定义布局的纯函数(spec D12,§4)。
 *
 * 布局是用户数据:模块顺序/篇幅/显隐都可拖拽调整,持久化在服务端(D8 同一层),
 * 这里只管布局对象本身的变换,不碰持久化、不碰 DOM。
 *
 * 不可改清单第 1、4 条 —— 日结条与事务官浮窗的存在不可被拖拽/隐藏/删除
 * ——在这一层直接代码排除:FIXED_MODULES 里的 id 收到任何操作函数一律原样
 * 返回,不靠"提示词里写了别动它"这种软约束。
 */
import type { LandscapeLayout, LayoutModule, WorkbenchLayout } from '../protocol.ts'
import {
  LANDSCAPE_RAIL_MAX_PCT, LANDSCAPE_RAIL_MIN_PCT, LANDSCAPE_SIDE_MAX_PCT, LANDSCAPE_SIDE_MIN_PCT,
  LAYOUT_MODULE_IDS,
} from '../protocol.ts'
import { DEFAULT_LANDSCAPE_MODULES_DEF, DEFAULT_PORTRAIT_MODULES } from '../templates.ts'
import type { Orientation } from './orientation.ts'

/**
 * 可自定义的模块(spec §3 分区 2/4/5,不含日结条与事务官浮窗;A3 起不再有 sessions)。
 * 直接引用 protocol.ts 的 LAYOUT_MODULE_IDS——服务端 parseLayout 校验用的是同一份常量,
 * 不在这里另写一份字面量(终审 F1:两份字面量容易走漂)。
 */
export const MODULE_IDS = LAYOUT_MODULE_IDS
export type ModuleId = typeof MODULE_IDS[number]

/**
 * 仅文档化存在的两个固定项——日结条(foot)、事务官浮窗(butler)。它们不出现在
 * WorkbenchLayout.modules 里,这个常量只用来让 move/resize/toggle 认出这两个
 * id 并拒绝操作(不可改清单第 1、4 条,代码层排除)。
 */
export const FIXED_MODULES = ['foot', 'butler'] as const

const MIN_BASIS_PCT = 8
const MAX_BASIS_PCT = 70

/**
 * 默认布局(2026-08-25 版面重排)。三行:
 * - 行 0:左列项目区独占,右列消耗数据在上、余额在下(同 row 同 col = 竖向堆叠);
 * - 行 1:窗位叠独占;
 * - 行 2:随手记(40%)与系统文件夹(60%)并排——组件条退休后接手底部的那两栏。
 *
 * 高度 34 + 42 + 24 = 100。窗位叠让出 12 个点(54→42)给底部那一行:底部要装的
 * 不再是一条只放两个数字格的组件小条,而是随手记加一整格 Finder(Ben 2026-08-25 拍板)。
 * 所有值都落在服务端 /layout 的 clamp 区间 8–70(与客户端 resizeModule 同界)内。
 */
/**
 * 2026-09-21(布局模板):这两份排布**搬去了 src/templates.ts**,成了「做产品」模板的
 * portrait / landscape。这里改成 re-export —— 同一件事(默认布局长什么样)只有一个地方
 * 说得出口,不留两份字面量(F1)。值一个字没改:切回 product 模板就是今天这个样子。
 */
export const DEFAULT_LAYOUT: WorkbenchLayout = {
  modules: DEFAULT_PORTRAIT_MODULES,
  butler: { corner: 'br', min: false },
}

/**
 * 横屏那一版的默认排布(2026-09-18)。参考 Codex 早先那份原型的**结构**
 * (docs/prototypes/workbench-visual,Ben:「只参考布局就行」)——示例数据与它那套视觉
 * 一律不搬,黑白微光风格不变。
 *
 * 五个区域:
 *   ① 左侧窄栏 rail = 窗位叠标签竖排 + 场景条(窗口管理动作);宽度由 CSS 定,不入布局数据;
 *   ② 中间大区 stage = 窗位槽(原生窗贴合区,占最大);
 *   ③ 右侧栏 side = 项目执行(项目区,内含看板/冲刺/文件);
 *   ④ 底部一排 deck = 消耗数据 / 余额额度 / 随手记 / 系统文件夹,四格等宽;
 *   ⑤ 最底一行 = 日结 + 事务官状态条(.ben-wb__footbar,横竖两版共用,一字没动)。
 *
 * 字段怎么读(**跟竖屏不是同一套换算,别照着竖屏的直觉理解**):
 * - `width_pct`:只有 slot / projects 用,是中间大区与右侧栏的左右占比(那根竖拖拽条改的就是它);
 *   四个底部格恒等宽(CSS `flex:1 1 0`),它们的 width_pct 不参与排布。
 * - `basis_pct`:**只有四个底部格的那一份是真的**——底部一排的高度,四个恒相等;
 *   中间那一大条的高度是 `100 - 底部高度` 算出来的,不另存一份(存两份必走漂)。
 *   slot / projects 的 basis_pct 在横屏下不参与任何排布,存 70 只是为了让这条记录
 *   仍然落在服务端 /layout 的 clamp 区间 8–70 内、形状与竖屏一致。
 * - `row` / `col`:横屏不走竖屏那套"相邻同 row 归并"的分组(排布是写死的五个区域),
 *   留着是为了让同一份 LayoutModule 结构在两个分支里通用、服务端校验不必分叉。
 */
export const DEFAULT_LANDSCAPE_MODULES: readonly LayoutModule[] = DEFAULT_LANDSCAPE_MODULES_DEF

/**
 * 横屏底部那一排**默认**装着的四个模块 id,顺序即从左到右。
 *
 * 2026-09-20 起这四个同时也正好是横屏下**可以在区域之间挪动**的四个(见
 * LANDSCAPE_MOVABLE_IDS):窗位槽是中间大区、项目区是右侧栏最上那一格,两个都钉死。
 * "默认在底部"与"能挪"是两件事,名字只说得出一件,所以下面另起一个别名把另一件说清楚。
 */
export const LANDSCAPE_DECK_IDS = ['usage', 'quota', 'notes', 'files'] as const
/** 横屏上半那一条里,左右两块的 id(中间大区 / 右侧栏)。 */
export const LANDSCAPE_BAND_IDS = ['slot', 'projects'] as const

/**
 * 横屏下能被上/下箭头挪动的模块(2026-09-20「横屏模块挪区」)。
 *
 * 另外两个(slot / projects)是**钉死的**:窗位槽就是中间那块贴原生窗的大区,
 * 项目区就是右侧栏最上那一格——Ben 要的是"把底部那几格挪到项目区下面",
 * 项目区自己被挪走的话那句话就没有参照物了。它们的两个箭头一律 disabled。
 */
/** 横屏下位置钉死的两个模块(中间大区 / 右侧栏最上)。 */
export const LANDSCAPE_PINNED_IDS = LANDSCAPE_BAND_IDS
/**
 * 2026-09-21(布局模板):这份清单从「写死的那四个」改成「**除了钉死的两个以外的全部**」。
 *
 * 为什么必须改:运营模板往横屏里放了三个新模块(待办事项 / 发布计划 / 数据复盘)。
 * 留着写死的四个 id,新模块的上下箭头会一律 disabled、底边抓手也拖不动 —— 而它们
 * 跟随手记、系统文件夹是同一种东西(一格可以在底部一排与右侧栏之间来回的模块),
 * 没有任何理由不能挪。
 *
 * 对既有六个模块**逐字等价**:MODULE_IDS 减去 slot / projects 正好是原来那四个
 * (usage / quota / notes / files),顺序不同但这份清单只被 `.includes()` 用。
 */
export const LANDSCAPE_MOVABLE_IDS: readonly string[]
  = MODULE_IDS.filter(id => !(LANDSCAPE_PINNED_IDS as readonly string[]).includes(id))

/**
 * 底部一排高度的上下限(占整个模块区的百分比)。比竖屏那档 8–70 收得紧:
 * 低于 14 时四个格里的数字会被自己的标题挤没,高于 48 时中间那块窗位槽已经贴不下
 * 一扇正常的原生窗——而"贴得下一扇窗"正是横屏这一版存在的理由。两端都落在服务端
 * /layout 的 8–70 之内,所以拖到头也不会被服务端再夹一次(夹两次会让手感对不上)。
 */
const LANDSCAPE_DECK_MIN_PCT = 14
const LANDSCAPE_DECK_MAX_PCT = 48

function clampDeck(value: number): number {
  return Math.min(LANDSCAPE_DECK_MAX_PCT, Math.max(LANDSCAPE_DECK_MIN_PCT, value))
}

/** 深拷贝一份横屏默认排布——同 resetLayout,不与常量共享引用。 */
export function defaultLandscape(): LandscapeLayout {
  return { modules: DEFAULT_LANDSCAPE_MODULES.map(module => ({ ...module })) }
}

/**
 * 取当前方向那一份模块排布。横屏分支缺席(旧存档、从没在横屏上动过布局)时回默认横屏排布
 * ——**不回竖屏那一份**:竖屏的 row/col/basis 在横屏下没有任何合理解释。
 */
export function branchModules(layout: WorkbenchLayout, orientation: Orientation): readonly LayoutModule[] {
  if (orientation !== 'landscape') return layout.modules
  return layout.landscape?.modules ?? DEFAULT_LANDSCAPE_MODULES
}

/** 把改好的模块排布写回当前方向那一份,另一份一字不动。 */
export function withBranchModules(
  layout: WorkbenchLayout,
  orientation: Orientation,
  modules: readonly LayoutModule[],
): WorkbenchLayout {
  if (orientation !== 'landscape') return { ...layout, modules }
  return { ...layout, landscape: { ...layout.landscape, modules } }
}

/* ───────────────────────────────────────────────────────────────────────────
 * 横屏的「区域」(2026-09-20,Ben:「点击下面的消耗数据和余额/额度,想要拉到项目区的
 * 下面去,点击向上的箭头是无效的」)。
 *
 * 2026-09-18 那一版横屏排布是**写死的五个区域**:哪个模块画在哪儿由 Workbench.tsx 里
 * 一串 `visible('usage')` 决定,`order` 只在竖屏那一份里有意义。于是上下箭头调 moveModule
 * 换了 order、布局也确实落了盘,**渲染那一层根本不读它** —— 从用户那边看就是"点了没反应"。
 *
 * 这一节补的就是那个缺掉的概念:横屏有两个**能放模块的区域**——
 *   - `deck`:底部那一排,横排,左 → 右;
 *   - `side`:右侧栏,竖排,项目区之下,上 → 下。
 * 每个可挪动的模块记一个 `region`(缺席 = deck,旧存档因此原样不动),区域内的先后
 * 仍然看 `order`。**渲染从这里取区域和顺序**,箭头改的就是渲染读的那两个字段,
 * 于是"点了有反应"这件事在结构上成立,不是靠某处记得同步。
 *
 * 箭头的含义按它画的方向读,不绕:
 *   ↑ 在底部一排 = 上到右侧栏(落在最下,项目区之下);在右侧栏 = 与上面那格换位;
 *   ↓ 在右侧栏 = 与下面那格换位,已经是最下那格就回到底部一排最右;在底部一排 = 没有
 *     地方可去(它已经是最下面那一层),箭头 disabled。
 * **底部一排内部的左右顺序不走箭头**:一排格子是横着的,"上"在那里只能理解成"上到右栏",
 * 硬把它当"往左挪"会让 Ben 点了上箭头看见东西往左走(可推翻,见 docs/决策记录 2026-09-20)。
 * ─────────────────────────────────────────────────────────────────────────── */

/**
 * 右侧栏里各格的默认高度占比(flex-grow,几个数之比就是高度之比,不必凑 100)。
 * 项目区占大头:它装着看板/冲刺/文件,一格只放得下两行的话就不是"项目执行"了。
 */
export const LANDSCAPE_SIDE_PROJECTS_DEFAULT_PCT = 50
export const LANDSCAPE_SIDE_DEFAULT_PCT = 25

export { LANDSCAPE_SIDE_MAX_PCT, LANDSCAPE_SIDE_MIN_PCT }

function clampSide(value: number): number {
  if (!Number.isFinite(value)) return LANDSCAPE_SIDE_DEFAULT_PCT
  return Math.min(LANDSCAPE_SIDE_MAX_PCT, Math.max(LANDSCAPE_SIDE_MIN_PCT, value))
}

function isMovable(id: string): boolean {
  return (LANDSCAPE_MOVABLE_IDS as readonly string[]).includes(id)
}

/**
 * 横屏此刻的区域排布:右侧栏从上到下(项目区恒在第一个)、底部一排从左到右。
 *
 * **含被收起的模块**——收起只是不画,它在区域里的位置还在那儿(再展开时回原位),
 * 跟竖屏那一份 sortedModules / visibleModules 的分工一致:排布在这里,显隐在调用方。
 */
export function landscapeArrangement(
  layout: WorkbenchLayout,
): { side: readonly LayoutModule[], deck: readonly LayoutModule[] } {
  const sorted = [...branchModules(layout, 'landscape')].sort((left, right) => left.order - right.order)
  const projects = sorted.find(module => module.id === 'projects')
  const side: LayoutModule[] = projects === undefined ? [] : [projects]
  const deck: LayoutModule[] = []
  for (const module of sorted) {
    if (!isMovable(module.id)) continue
    if (module.region === 'side') side.push(module)
    else deck.push(module)
  }
  return { side, deck }
}

/**
 * 把一份区域排布写回横屏分支。落盘的数组顺序**就是**最终顺序(slot → 右侧栏 → 底部一排),
 * order 跟着下标重排——服务端 sanitizeLandscapeModules 也按数组下标重排 order,
 * 两边对齐才不会出现"存下去是一个顺序、读回来是另一个"。
 *
 * 落进底部一排的那几格 basis_pct **一律改成同一个值**:底部是一排等高的格子,
 * 从右侧栏挪回来的那一格如果带着自己的旧高度,底部就会出现一格高一格矮(既有
 * resizeLandscapeDeck 守的也是这条)。挪进右侧栏的那一格 basis_pct 原样留着,
 * 它就是"回底部时该有多高"的记忆。
 */
function withLandscapeArrangement(
  layout: WorkbenchLayout,
  side: readonly LayoutModule[],
  deck: readonly LayoutModule[],
): WorkbenchLayout {
  const modules = branchModules(layout, 'landscape')
  const slot = modules.find(module => module.id === 'slot')
  // 底部一排的高度:排里还有格子就跟着现有的走;空了(最后一格刚被挪走)就用挪回来
  // 那一格自己记着的高度——不然"挪上去再挪回来"会把用户拖过的底部高度换成默认值。
  const deckPct = deck.length === 0
    ? 24
    : clampDeck(deck.find(module => module.region !== 'side' && module.basis_pct !== undefined)?.basis_pct
      ?? deck[0]?.basis_pct ?? 24)
  const next: LayoutModule[] = []
  if (slot !== undefined) next.push({ ...slot })
  for (const module of side) {
    next.push(module.id === 'projects'
      // 项目区不记 region:它钉在右侧栏最上,不是"被挪到"那儿的。
      ? { ...module, side_pct: module.side_pct ?? LANDSCAPE_SIDE_PROJECTS_DEFAULT_PCT }
      : { ...module, region: 'side', side_pct: module.side_pct ?? LANDSCAPE_SIDE_DEFAULT_PCT })
  }
  for (const module of deck) next.push({ ...module, region: 'deck', basis_pct: deckPct })
  return withBranchModules(layout, 'landscape', next.map((module, order) => ({ ...module, order })))
}

/** 横屏右侧栏里某一格的高度占比(flex-grow)。缺席时用默认值(项目区 50,别的 25)。 */
export function landscapeSidePct(layout: WorkbenchLayout, id: string): number {
  const found = branchModules(layout, 'landscape').find(module => module.id === id)
  const fallback = id === 'projects' ? LANDSCAPE_SIDE_PROJECTS_DEFAULT_PCT : LANDSCAPE_SIDE_DEFAULT_PCT
  return found?.side_pct === undefined ? fallback : clampSide(found.side_pct)
}

/**
 * 右侧栏里**看得见的那几格**高度占比之和。拖把手时要用它把"屏幕上挪了百分之几"换算成
 * "grow 加减多少":几个数之比才是高度之比,和不是 100,直接把 Δ百分比当 grow 加会偏。
 */
export function landscapeSideTotal(layout: WorkbenchLayout): number {
  return landscapeArrangement(layout).side
    .filter(module => module.hidden !== true)
    .reduce((sum, module) => sum + landscapeSidePct(layout, module.id), 0)
}

/**
 * 拖右侧栏里相邻两格之间那根横把手:**只在这两格之间挪,两格之和恒定**。
 * 规则与底部一排那三根竖把手逐字相同(resizeLandscapeDeckPair),只是朝向不同——
 * 四条边界是同一种东西,不该因为朝向不同就长出第二套语义。
 */
export function resizeLandscapeSidePair(
  layout: WorkbenchLayout, topId: string, bottomId: string, deltaPct: number,
): WorkbenchLayout {
  if (topId === bottomId) return layout
  const { side } = landscapeArrangement(layout)
  const inSide = (id: string): boolean => side.some(module => module.id === id)
  if (!inSide(topId) || !inSide(bottomId)) return layout

  const topBase = landscapeSidePct(layout, topId)
  const bottomBase = landscapeSidePct(layout, bottomId)
  const sum = topBase + bottomBase
  const delta = Number.isFinite(deltaPct) ? deltaPct : 0
  const nextTop = Math.min(sum - LANDSCAPE_SIDE_MIN_PCT, Math.max(LANDSCAPE_SIDE_MIN_PCT, topBase + delta))

  return withBranchModules(layout, 'landscape', branchModules(layout, 'landscape').map((module) => {
    if (module.id === topId) return { ...module, side_pct: nextTop }
    if (module.id === bottomId) return { ...module, side_pct: sum - nextTop }
    return module
  }))
}

/** 右侧栏里从 index 往某个方向数,第一个**没被收起**的那一格在哪(没有就 -1)。 */
function nextVisibleIndex(list: readonly LayoutModule[], from: number, dir: -1 | 1): number {
  for (let i = from + dir; i >= 0 && i < list.length; i += dir) {
    if ((list[i] as LayoutModule).hidden !== true) return i
  }
  return -1
}

/**
 * 这个模块此刻还能不能往那个方向挪(箭头 disabled 就看它)。
 *
 * **disabled 必须与屏幕上看得见的位置一致**:被收起的那几格在数据里还占着位置,
 * 但用户看不见它们——"上面还有一格、只是收起了"这种情况点上箭头应该跨过去,
 * 而不是原地不动(既有竖屏那条路径有这个毛病,横屏这一版不复制它)。
 */
export function canMoveLandscape(layout: WorkbenchLayout, id: string, dir: -1 | 1): boolean {
  if (!isMovable(id)) return false
  const { side, deck } = landscapeArrangement(layout)
  const sideIndex = side.findIndex(module => module.id === id)
  if (sideIndex === -1) {
    // 底部一排:↑ 上到右侧栏(总有地方去);↓ 已经是最下面那一层,没有地方可去。
    return deck.some(module => module.id === id) && dir === -1
  }
  // 右侧栏:↓ 总有地方去(换位,或者回底部一排);↑ 要上面真有一格看得见的、且不是项目区。
  if (dir === 1) return true
  const target = nextVisibleIndex(side, sideIndex, -1)
  return target > 0
}

/**
 * 横屏的上/下箭头。挪不动(钉死的模块、撞到项目区、已经在最下面那一层)时**原样返回**
 * ——同竖屏那一支的规矩:不折返、不循环。
 */
export function moveLandscapeModule(layout: WorkbenchLayout, id: string, dir: -1 | 1): WorkbenchLayout {
  if (!canMoveLandscape(layout, id, dir)) return layout
  const { side, deck } = landscapeArrangement(layout)
  const sideIndex = side.findIndex(module => module.id === id)

  // 底部格 → 右侧栏最下(项目区之下)。width_pct 原样留着:挪回底部时还按原来那个宽度,
  // 不必重新拖一遍。
  if (sideIndex === -1) {
    const moved = deck.find(module => module.id === id)
    if (moved === undefined) return layout
    return withLandscapeArrangement(layout, [...side, moved], deck.filter(module => module.id !== id))
  }

  const target = nextVisibleIndex(side, sideIndex, dir)
  // 右侧栏最下那格再往下 → 回底部一排最右。
  if (dir === 1 && target === -1) {
    const moved = side[sideIndex] as LayoutModule
    return withLandscapeArrangement(layout, side.filter(module => module.id !== id), [...deck, moved])
  }
  if (target === -1 || target === 0) return layout

  // 同区域内换位(项目区在第 0 位,上面那条 target === 0 已经把它挡住了)。
  const swapped = [...side]
  swapped[sideIndex] = side[target] as LayoutModule
  swapped[target] = side[sideIndex] as LayoutModule
  return withLandscapeArrangement(layout, swapped, deck)
}

/**
 * 横屏底部一排现在多高(百分比)。一排格子恒等高,取第一个读得到的那个。
 * 2026-09-20 起**只认还在底部那一排里的格子**:挪进右侧栏的那一格 basis_pct 留着不动
 * (它是"回底部时该多高"的记忆),拿它当底部高度读会让底部跟着一个已经不在那儿的格子走。
 */
export function landscapeDeckPct(layout: WorkbenchLayout): number {
  const found = landscapeArrangement(layout).deck[0]
  return clampDeck(found?.basis_pct ?? 24)
}

/**
 * 调整横屏底部一排的高度。四个格**一起改成同一个值**——它们是一排等高的格子,
 * 各存各的高度就会出现"随手记比余额矮一截"那种没人想要的参差。
 *
 * 中间那一大条的高度不在这里改:它恒等于 `100 - 底部高度`(见 DEFAULT_LANDSCAPE_MODULES
 * 的注释),拖中间那两块的底边等价于反向拖底部一排,由调用方取负号。
 */
export function resizeLandscapeDeck(layout: WorkbenchLayout, deltaPct: number): WorkbenchLayout {
  const modules = branchModules(layout, 'landscape')
  const next = clampDeck(landscapeDeckPct(layout) + deltaPct)
  // 2026-09-20:**只改还在底部那一排里的格子**。挪进右侧栏的那一格高度由 side_pct 管,
  // 它的 basis_pct 是"回底部时该多高"的记忆——拖底部一排的高度不该顺手改掉那份记忆。
  const inDeck = new Set(landscapeArrangement(layout).deck.map(module => module.id))
  return withBranchModules(layout, 'landscape', modules.map(module => (
    inDeck.has(module.id) ? { ...module, basis_pct: next } : module
  )))
}

/* ───────────────────────────────────────────────────────────────────────────
 * 横屏四条分栏把手(2026-09-18,Ben 截图:横屏只有「窗口槽 | 项目区」那一条能拖)。
 *
 * 四条边界各改一个数,四个数都落在 `layout.landscape` 这一支里:
 *   ① 左栏 | 窗口槽    → landscape.rail_pct            (本节)
 *   ② 窗口槽 | 项目区  → modules[slot/projects].width_pct(既有 resizeRowPair,一字没改)
 *   ③ 主区 | 底部一排  → modules[四格].basis_pct       (既有 resizeLandscapeDeck,一字没改)
 *   ④ 底部四格两两之间 → modules[四格].width_pct       (本节 resizeLandscapeDeckPair)
 * 竖屏那一份(顶层 modules)四条路径一条都不碰。
 * ─────────────────────────────────────────────────────────────────────────── */

/**
 * 左栏宽度的上下限(占整条上半区的百分比)。
 *
 * 下限 5:2560 宽的屏上是 128px,比缺席时那个 168px 再窄一档,标签名开始要省略号但还看得出
 * 是哪一个应用;再窄下去左栏就是一条谁也认不出来的灰带,而"把左栏拖没"应该走「收起窗口槽」
 * (左栏是窗位槽的应用栏,槽收起时它整条不画),不该是拖出来的意外——同 resizeRowPair 那条
 * 20–80 的理由。上限 30:再宽中间那块贴窗区就开始亏,而贴得下一扇窗是横屏这一版存在的理由。
 */
export { LANDSCAPE_RAIL_MAX_PCT, LANDSCAPE_RAIL_MIN_PCT }

/**
 * 左栏缺席时那个 168px 换算不出百分比(它是绝对值),拖动第一下要有个起点:调用方量得到
 * 真实几何时用量到的(Workbench.tsx 的 pointerdown 就是这么做的),量不到(jsdom、元素还没
 * 排版)才退回这个数。7 是 168/2560 ≈ 6.6 往上取的整数——Ben 那块屏上按住把手不动、
 * 松手,左栏不该肉眼可见地跳一下。
 */
export const LANDSCAPE_RAIL_FALLBACK_PCT = 7

function clampRail(value: number): number {
  if (!Number.isFinite(value)) return LANDSCAPE_RAIL_FALLBACK_PCT
  return Math.min(LANDSCAPE_RAIL_MAX_PCT, Math.max(LANDSCAPE_RAIL_MIN_PCT, value))
}

/**
 * 左栏现在多宽(百分比)。**没拖过就是 undefined**,不折算成百分比——缺席的含义是
 * "定死 168px"(见 protocol.ts LandscapeLayout.rail_pct),把它读成一个数字就等于
 * 替用户做了一次他没做过的拖动。
 */
export function landscapeRailPct(layout: WorkbenchLayout): number | undefined {
  const raw = layout.landscape?.rail_pct
  return raw === undefined ? undefined : clampRail(raw)
}

/** 写左栏宽度(绝对值,不是增量——拖动起点由调用方量真实几何得到,见声明处注释)。 */
export function setLandscapeRailPct(layout: WorkbenchLayout, pct: number): WorkbenchLayout {
  return {
    ...layout,
    landscape: { ...layout.landscape, modules: branchModules(layout, 'landscape'), rail_pct: clampRail(pct) },
  }
}

/**
 * 底部单格的最小宽度占比。四格之和恒为 100,任一格低于 10 就只剩一条标题都放不下的
 * 竖缝——同左栏那条理由:要让一格消失,走「收起」,不走拖拽。
 */
export const LANDSCAPE_DECK_CELL_MIN_PCT = 10

/** 底部某一格现在多宽(百分比)。缺省 25(四格等宽,DEFAULT_LANDSCAPE_MODULES 的那份)。 */
export function landscapeDeckWidth(layout: WorkbenchLayout, id: string): number {
  const found = branchModules(layout, 'landscape').find(module => module.id === id)
  return found?.width_pct ?? 25
}

/**
 * 拖底部四格中相邻两格之间那根把手:**只在这两格之间挪,两格之和恒定**。
 *
 * 为什么不复用 resizeRowPair:那一支写死了 `右 = 100 - 左`(竖屏一行里就两个模块,
 * 和必为 100)。底部是四格,拿它来拖第一根把手会把后两格挤成 0 —— 同一个名字两套语义
 * 比多一个函数糟得多。这里守的是"和恒定",不是"和等于 100"。
 *
 * 用户收起其中一两格时,剩下的格子 width_pct 之和不再是 100,CSS 那边按 flex-grow
 * 比例分(见 Workbench.tsx renderModule 的 grow),照样匀得开,不必在这里补 100。
 */
export function resizeLandscapeDeckPair(
  layout: WorkbenchLayout, leftId: string, rightId: string, deltaPct: number,
): WorkbenchLayout {
  if (isFixed(leftId) || isFixed(rightId) || leftId === rightId) return layout
  const modules = branchModules(layout, 'landscape')
  const left = modules.find(module => module.id === leftId)
  const right = modules.find(module => module.id === rightId)
  if (left === undefined || right === undefined) return layout

  const leftBase = left.width_pct ?? 25
  const rightBase = right.width_pct ?? 25
  const sum = leftBase + rightBase
  const delta = Number.isFinite(deltaPct) ? deltaPct : 0
  // 两端各留下限:左边夹到 [min, sum-min],右边跟着 sum 减出来,和一点不变。
  const nextLeft = Math.min(sum - LANDSCAPE_DECK_CELL_MIN_PCT, Math.max(LANDSCAPE_DECK_CELL_MIN_PCT, leftBase + delta))
  const nextRight = sum - nextLeft

  return withBranchModules(layout, 'landscape', modules.map((module) => {
    if (module.id === leftId) return { ...module, width_pct: nextLeft }
    if (module.id === rightId) return { ...module, width_pct: nextRight }
    return module
  }))
}

/**
 * 事务官浮窗落点,**按方向各读各的**(2026-09-18 决策记录)。横屏读 landscape.butler_pos,
 * 竖屏读顶层 butler.pos。横屏那份缺席时回 undefined —— 浮窗那边"没有 pos"就走 CSS
 * 的角落规则,而横屏的角落规则被 `--ben-wb-land-butler-bottom` 顶到了底部四格之上
 * (style.ts),正是"默认不压底部一排"那条。
 */
export function butlerPosOf(
  layout: WorkbenchLayout, orientation: Orientation,
): { x_pct: number, y_pct: number } | undefined {
  return orientation === 'landscape' ? layout.landscape?.butler_pos : layout.butler.pos
}

/** 写事务官浮窗落点到当前方向那一份,另一份一字不动。 */
export function withButlerPos(
  layout: WorkbenchLayout, orientation: Orientation, pos: { x_pct: number, y_pct: number },
): WorkbenchLayout {
  if (orientation !== 'landscape') return { ...layout, butler: { ...layout.butler, pos } }
  return {
    ...layout,
    landscape: { ...layout.landscape, modules: branchModules(layout, 'landscape'), butler_pos: pos },
  }
}

function isFixed(id: string): boolean {
  return (FIXED_MODULES as readonly string[]).includes(id)
}

function clampBasis(value: number): number {
  return Math.min(MAX_BASIS_PCT, Math.max(MIN_BASIS_PCT, value))
}

/**
 * 按当前 order 挪一位。撞到边界(已是第一/最后一个)原样返回,不折返、不循环。
 *
 * `orientation` 是 2026-09-18 横屏布局加的**末位可选参数**,缺省 'portrait' ——
 * 既有调用点与既有用例一个字都不用改,行为逐字不变;横屏那边传 'landscape',
 * 改的就是 layout.landscape.modules 那一份,竖屏那份不受影响。下面三个同理。
 */
export function moveModule(
  layout: WorkbenchLayout, id: string, dir: -1 | 1, orientation: Orientation = 'portrait',
): WorkbenchLayout {
  if (isFixed(id)) return layout
  // 2026-09-20:横屏走区域那一套(底部一排 ↔ 右侧栏),不是"在一维顺序里换一位"——
  // 换 order 这条路在横屏下渲染根本不读,就是 Ben 看到的"点了没反应"。竖屏一字未动。
  if (orientation === 'landscape') return moveLandscapeModule(layout, id, dir)
  const sorted = [...branchModules(layout, orientation)].sort((left, right) => left.order - right.order)
  const index = sorted.findIndex(module => module.id === id)
  if (index === -1) return layout
  const target = index + dir
  if (target < 0 || target >= sorted.length) return layout

  const swapped = [...sorted]
  const current = swapped[index] as LayoutModule
  const other = swapped[target] as LayoutModule
  swapped[index] = other
  swapped[target] = current

  return withBranchModules(layout, orientation, swapped.map((module, order) => ({ ...module, order })))
}

/** 篇幅加减,clamp 到 8–70(spec §7)。 */
export function resizeModule(
  layout: WorkbenchLayout, id: string, deltaPct: number, orientation: Orientation = 'portrait',
): WorkbenchLayout {
  if (isFixed(id)) return layout
  let touched = false
  const modules = branchModules(layout, orientation).map((module) => {
    if (module.id !== id) return module
    touched = true
    return { ...module, basis_pct: clampBasis((module.basis_pct ?? 0) + deltaPct) }
  })
  return touched ? withBranchModules(layout, orientation, modules) : layout
}

/**
 * 调整同一行内两个模块的宽度占比(2026-08-25:项目区 / 消耗数据 之间那根竖条)。
 *
 * 左右是一对零和关系:左边加多少右边就减多少,和恒为 100,否则那一行会留缝或溢出。
 * 两边都 clamp 到 20–80——低于 20 的那半窄到放不下任何内容,拖到那儿等于把模块弄没了,
 * 而"弄没"应该走「收起」,不该是拖出来的意外。
 */
export function resizeRowPair(
  layout: WorkbenchLayout,
  leftId: string,
  rightId: string,
  deltaPct: number,
  orientation: Orientation = 'portrait',
): WorkbenchLayout {
  if (isFixed(leftId) || isFixed(rightId)) return layout
  const modules = branchModules(layout, orientation)
  const left = modules.find(module => module.id === leftId)
  const right = modules.find(module => module.id === rightId)
  if (left === undefined || right === undefined) return layout

  const leftBase = left.width_pct ?? 50
  const nextLeft = Math.min(80, Math.max(20, leftBase + deltaPct))
  const nextRight = 100 - nextLeft

  return withBranchModules(layout, orientation, modules.map((module) => {
    if (module.id === leftId) return { ...module, width_pct: nextLeft }
    if (module.id === rightId) return { ...module, width_pct: nextRight }
    return module
  }))
}

/** 显隐反转(spec D12 收起)。收起不等于消失——补偿见 hoistedAlerts。 */
export function toggleHidden(
  layout: WorkbenchLayout, id: string, orientation: Orientation = 'portrait',
): WorkbenchLayout {
  if (isFixed(id)) return layout
  let touched = false
  const modules = branchModules(layout, orientation).map((module) => {
    if (module.id !== id) return module
    touched = true
    return { ...module, hidden: !(module.hidden ?? false) }
  })
  return touched ? withBranchModules(layout, orientation, modules) : layout
}

/* ───────────────────────────────────────────────────────────────────────────
 * 下面两个是 2026-09-22「用自然语言改布局」新加的纯函数。它们存在的理由是:那一层
 * 的每一种动作都要能指到**这个文件里既有的一个函数**(src/layoutActs.ts 顶上有映射表),
 * 而 `rename` 与 `swap` 是原来唯独没有对应函数的两件事 —— 界面上只有箭头和抓手,
 * 没有"改个名""两格对调"的入口。新加的是入口,不是第二套几何。
 * ─────────────────────────────────────────────────────────────────────────── */

/**
 * 改一格的标题(2026-09-22)。
 *
 * **只写 `layout.titles` 这张表,一个几何字段都不碰** —— 标题跟模块画在哪儿、多高多宽
 * 是两件事,混在一起改的话"改个名"就会莫名其妙地把布局也动一下。
 *
 * 两个方向共用一份(同 butler / pureMode 那几样:它是"这一格叫什么",不是"怎么排"),
 * 所以这个函数没有 orientation 参数。
 *
 * 空标题 = **撤掉这一格的自定义名字**,落回模板给的那个;整张表空了就连 `titles` 这个键
 * 一起去掉(留一个 `{}` 在存档里,读的人会以为"他设过、只是设成了空")。
 */
export function renameModule(layout: WorkbenchLayout, id: string, title: string): WorkbenchLayout {
  if (isFixed(id)) return layout
  if (!(MODULE_IDS as readonly string[]).includes(id)) return layout
  const next: Record<string, string> = { ...layout.titles }
  const trimmed = title.trim()
  if (trimmed === '') delete next[id]
  else next[id] = trimmed
  if (Object.keys(next).length === 0) {
    const { titles: _dropped, ...rest } = layout
    return rest
  }
  return { ...layout, titles: next }
}

/**
 * 两格**位置整体对调**(2026-09-22)。
 *
 * 对调的是"画在哪儿"那几个字段(order / row / col / basis_pct / width_pct / region /
 * side_pct),**不是把两个 id 换过来** —— 换 id 的话 hidden 会跟着位置走,用户看到的是
 * "我让这两格换个位置,结果本来收起的那个冒出来了"。
 *
 * 这不是新的几何:没有一处在算坐标,只是把两个模块各自记着的那一组数原样交换。
 * 钉死的两格(横屏的窗位槽与项目区)与固定项(日结条 / 浮窗)一律拒绝,原样返回。
 */
export function swapModules(
  layout: WorkbenchLayout, leftId: string, rightId: string, orientation: Orientation = 'portrait',
): WorkbenchLayout {
  if (leftId === rightId) return layout
  if (isFixed(leftId) || isFixed(rightId)) return layout
  if (orientation === 'landscape' && (!isMovable(leftId) || !isMovable(rightId))) return layout
  const modules = branchModules(layout, orientation)
  const left = modules.find(module => module.id === leftId)
  const right = modules.find(module => module.id === rightId)
  if (left === undefined || right === undefined) return layout

  /** 这一格"画在哪儿"的那几个字段。缺席的保持缺席(不补默认值:那会把两格都写实一遍)。 */
  const placeOf = (module: LayoutModule): Partial<LayoutModule> => ({
    order: module.order,
    ...(module.row === undefined ? {} : { row: module.row }),
    ...(module.col === undefined ? {} : { col: module.col }),
    ...(module.basis_pct === undefined ? {} : { basis_pct: module.basis_pct }),
    ...(module.width_pct === undefined ? {} : { width_pct: module.width_pct }),
    ...(module.region === undefined ? {} : { region: module.region }),
    ...(module.side_pct === undefined ? {} : { side_pct: module.side_pct }),
  })
  const leftPlace = placeOf(left)
  const rightPlace = placeOf(right)
  /** 只保留"这一格是什么"的字段,位置那一组整组换掉(不是浅合并:否则旧的 region 会漏下来)。 */
  const keepOf = (module: LayoutModule): LayoutModule => ({
    id: module.id,
    order: module.order,
    ...(module.hidden === undefined ? {} : { hidden: module.hidden }),
  })

  return withBranchModules(layout, orientation, modules.map((module) => {
    if (module.id === leftId) return { ...keepOf(module), ...rightPlace } as LayoutModule
    if (module.id === rightId) return { ...keepOf(module), ...leftPlace } as LayoutModule
    return module
  }))
}

export interface WidgetDrop {
  id: string | null
  region?: string
  after?: boolean
}

/** Pointer placement uses the same branch and region rules as keyboard movement. */
export function reorderWidget(
  layout: WorkbenchLayout, orientation: Orientation, sourceId: string, drop: WidgetDrop | null,
): WorkbenchLayout {
  if (drop === null || sourceId === drop.id || isFixed(sourceId)) return layout
  const modules = branchModules(layout, orientation)
  const source = modules.find(module => module.id === sourceId)
  if (source === undefined || source.hidden === true) return layout
  if (orientation === 'landscape') {
    if (!isMovable(sourceId) || (drop.region !== 'side' && drop.region !== 'deck')) return layout
    const arrangement = landscapeArrangement(layout)
    const side = arrangement.side.filter(module => module.id !== sourceId)
    const deck = arrangement.deck.filter(module => module.id !== sourceId)
    const list = drop.region === 'side' ? side : deck
    let index = drop.id === null ? list.length : list.findIndex(module => module.id === drop.id)
    if (index < 0) return layout
    if (drop.after === true && drop.id !== null) index++
    if (drop.region === 'side') index = Math.max(side[0]?.id === 'projects' ? 1 : 0, index)
    list.splice(index, 0, source)
    const same = (left: readonly LayoutModule[], right: readonly LayoutModule[]) =>
      left.length === right.length && left.every((module, at) => module.id === right[at]?.id)
    if (same(side, arrangement.side) && same(deck, arrangement.deck)) return layout
    return withLandscapeArrangement(layout, side, deck)
  }
  const target = modules.find(module => module.id === drop.id)
  if (target === undefined || target.hidden === true || isFixed(target.id)) return layout
  const swapped = swapModules(layout, sourceId, target.id, orientation)
  return withBranchModules(swapped, orientation, [...branchModules(swapped, orientation)].sort((a, b) => a.order - b.order))
}

/**
 * 恢复默认布局(spec §4"提供恢复默认布局")。纯函数,幂等——多次调用结果相同。
 *
 * 深拷贝返回,不与 DEFAULT_LAYOUT 共享引用:调用方一旦浅层原地改返回值
 * (比如 layout.butler.min = true),不能把这个改动永久写回常量本身。
 */
export function resetLayout(
  orientation: Orientation = 'portrait',
  current?: WorkbenchLayout,
): WorkbenchLayout {
  // 无参调用(既有调用点/用例)行为逐字不变:整份回到竖屏默认,没有横屏分支。
  if (current === undefined) {
    const base: WorkbenchLayout = {
      modules: DEFAULT_LAYOUT.modules.map(module => ({ ...module })),
      butler: { ...DEFAULT_LAYOUT.butler },
    }
    return orientation === 'landscape' ? { ...base, landscape: defaultLandscape() } : base
  }
  // 带上当前布局时**只恢复当前方向那一份**(2026-09-18):在横屏上点「恢复默认布局」,
  // 不该顺手把竖屏那一版辛苦拖出来的排布也一起抹掉——两个方向各记各的,恢复也各恢复各的。
  // 横屏那一份**整支换掉**:模块排布、左栏宽度(rail_pct)、横屏浮窗落点(butler_pos)
  // 一起回默认——`defaultLandscape()` 只有 modules 一项,另外两个可选字段就此缺席,
  // 而"缺席"正是它们各自的默认态(168px 左栏 / 右栏底部之上那个落点)。这跟竖屏那一支
  // 顺手把 `butler` 换回 DEFAULT_LAYOUT.butler(连带丢掉拖过的 pos)是同一条规矩:
  // 「恢复默认布局」恢复的是**这个方向上排过的一切**,不是"只恢复模块、位置留着"。
  if (orientation === 'landscape') return { ...current, landscape: defaultLandscape() }
  return {
    ...current,
    modules: DEFAULT_LAYOUT.modules.map(module => ({ ...module })),
    butler: { ...DEFAULT_LAYOUT.butler },
  }
}

/*
 * 收起补偿(spec §4"收起必有通知")的最后一支 `hoistedAlerts` **2026-10-13 退休了**,
 * 这一层不再产出任何"上浮文本"。
 *
 * 维护者看着真机截图问「顶部这个黄色框是啥意思」→「我认为是去掉这个黄框和里面的内容」。
 * 那个框就是这个函数的输出画出来的:projects 收起时,把 stale 或「DDL 剩 <=1 天」的项目
 * **名字**上浮一行(`.ben-wb__fixedalerts`)。它只有名字、没有一个字说为什么 —— 屏幕上
 * 就是三个字「工作台」顶在一条琥珀描边里。而 `daysLeftFromNow` 对早就过去的 DDL 回负数、
 * 同样 <=1,所以一条过期九天的 DDL 把这条横条永久钉在那儿。
 *
 * 退休的理由与前两支一样:**补偿的前提消失了**(sessions 那支让给了 DockTabBar 的徽章,
 * widgets 那支让给了顶条常显)。DDL / 排期这条信号现在有一个常显的主人 —— 事务官浮窗按
 * `client/butler.ts` 的 `butlerConclusions` 用整句话说(「X 今天交付,但已停 N 天」、
 * 「X 按当前速度赶不上 10-4」),不看模块收没收起;而「把它展开」那颗键就在原来那条横条
 * 底下那一行。一个只有名字的琥珀框不是通知,是噪音。
 *
 * 不要在这里"换个判据接着写"(那正是前两次退休时记下的教训):要让收起的模块里的信号
 * 继续说话,就接在那个常显的主人上,或者挂在那颗还原钮上。
 */
