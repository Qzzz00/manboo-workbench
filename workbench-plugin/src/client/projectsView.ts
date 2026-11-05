/**
 * 项目区「总览 ⇄ 看板」开关的纯函数(设计稿 §3.5)。
 *
 * 单独一个文件而不是并进 client/layout.ts:layout.ts 是「版面重排」那个窗口的地盘,
 * 两个窗口同时改同一个文件正是地基拆分要避免的事。这里只做布局对象的变换,
 * 不碰持久化、不碰 DOM——与 layout.ts 同一套纪律。
 */
import type { WorkbenchLayout } from '../protocol.ts'

export type ProjectsView = 'overview' | 'board'

/**
 * 看板排布方向(2026-08-25 横排/竖排开关;2026-09-09 加第三个「按状态」)。
 *
 * - `module-rows`:模块是横向泳道,状态是竖列
 * - `module-columns`:模块是竖列,状态是横向行
 * - `status-columns`:**只按状态分列,不分模块泳道**——模块多起来之后,"现在各状态
 *   各有几件"这个问题被几十条泳道摊平了,这个方向专门回答它
 */
export type BoardAxis = 'module-rows' | 'module-columns' | 'status-columns'

const BOARD_AXES: readonly BoardAxis[] = ['module-rows', 'module-columns', 'status-columns']

/** 缺省即横排(模块在左、状态是竖列)——旧存档、写坏的值读进来都与从前一致。 */
export function boardAxisOf(layout: WorkbenchLayout): BoardAxis {
  const axis = layout.board_axis
  return axis !== undefined && BOARD_AXES.includes(axis as BoardAxis) ? axis as BoardAxis : 'module-rows'
}

/** 换个方向。只动这一个字段,不碰模块显隐与宽高——方向跟版面是两件事。 */
export function setBoardAxis(layout: WorkbenchLayout, axis: BoardAxis): WorkbenchLayout {
  return { ...layout, board_axis: axis }
}

/** 缺省即总览——旧存档没有这个字段,读进来与从前一致。 */
export function projectsViewOf(layout: WorkbenchLayout): ProjectsView {
  return layout.projects_view === 'board' ? 'board' : 'overview'
}

/**
 * 切换项目区展示模式。**只翻这一个字段,不碰任何别的模块。**
 *
 * 2026-08-26 Ben 实机反馈推翻了原设计(设计稿 §3.5 的"切到看板时占满整行,消耗数据
 * 让位收起为一个标签"):
 *
 * > 项目区的总览和看板模式切换,把余额和消耗数据都顶掉了,他应该只在自己的区域内显示,
 * > 不应该这么大动作。我点击余额和消耗数据是能够把自己拉回来的,但是每次切换总览和看板
 * > 都要这样来一次……很废人。
 *
 * 关键在最后半句:收起是**持久化到布局**的,他手动展开回来之后,下一次切换又给收了——
 * 每来回一次就得手动收拾一次。一个纯粹的"换个视图"动作不该改动跟它无关的模块的显隐,
 * 更不该把这种改动写进他的布局存档。看板窄了他自己会拖,那是他的布局,不是这个开关的事。
 *
 * 收起邻居的那套(rowMatesOf,按「排序后相邻且 row 相同」现算同行成员)整个删掉,不是留着
 * 加开关——留着就还得有人维护它、还得解释它什么时候生效。
 */
export function setProjectsView(layout: WorkbenchLayout, view: ProjectsView): WorkbenchLayout {
  return { ...layout, projects_view: view }
}
