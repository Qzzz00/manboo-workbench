/**
 * 由 Workbench.tsx 拆出(2026-08-25 地基:六窗口并行前的接缝切分)。**逐字搬运,
 * 没有改一行行为**——原文件 1190 行,四块需求都要改它,不拆开必冲突。
 *
 * 例外一处:2026-08-25 把「收起」按钮的图标版补了回来。它本来就该在(08eee5a 已经
 * 改过一次),是被这次拆分连带合流给静默吃掉的,详见下面那段注释。
 */

import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react'

/** Title-bar dragging and keyboard movement share the existing layout save path. */
export function ModuleHeader({
  title, headingId, draggable, onToggleHidden, extra, aside, outside = false,
}: {
  title: string
  headingId: string
  draggable: boolean
  onToggleHidden: () => void
  extra?: ReactNode
  /** 标题行右端、收起键之前那一样(评审页各格头右上的「3 条记录 ›」这类)。 */
  aside?: ReactNode
  /** 画在卡外的一行弱字(窗口槽、项目区;评审页 `.slot-tabs`),不是卡里的标题行。 */
  outside?: boolean
}) {
  return (
    <div
      className={outside ? 'ben-wb__modhead ben-wb__modhead--outside' : 'ben-wb__modhead'}
      data-widget-draggable={draggable}
      tabIndex={draggable ? 0 : undefined}
      title={draggable ? '拖动标题调整位置 · Alt + 方向键移动 · Esc 取消' : undefined}
      aria-label={draggable ? `${title}，可拖动调整位置` : undefined}
      aria-keyshortcuts={draggable ? 'Alt+ArrowUp Alt+ArrowDown Alt+ArrowLeft Alt+ArrowRight' : undefined}
    >
      <h2 className="ben-wb__ttl" id={headingId}>{title}</h2>
      {extra}
      {aside !== undefined && <span className="ben-wb__modhead-aside">{aside}</span>}
      <div className="ben-wb__modbtns" role="group" aria-label={`${title} 布局操作`}>
        <button type="button" aria-label={`${title} 收起`} title="收起" onClick={onToggleHidden}>
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">
            <path
              d="M4 6.5 L8 3 L12 6.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path d="M4 12 H12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
      </div>
    </div>
  )
}

/**
 * 模块盒子的通用外壳(spec 模块盒子化,真机反馈:会话区增减把槽体顶走,贴合锚点漂移)：
 * `flex: 0 0 <basis_pct>%` 固定高度盒子(不参与 grow/shrink,内容多了不撑高、少了不缩水)
 * + 底边一根拖拽调高手柄。四种模块内容各自的渲染差异很大(projects/sessions 走
 * .ben-wb__card--fill,slot/widgets 各自的内部结构),这里只统一"盒子固定高度+底边手柄"
 * 这一层,不掺进内容差异——四处调用点各自负责自己的 {children}。
 */
export function ModuleBox({ id, title, basisPct, widthPct, stacked, noHandle, dragging, onResizeStart, onResizeMove, onResizeEnd, children }: {
  id: string
  title: string
  basisPct: number
  /**
   * 列内竖向堆叠模式(2026-08-25 右列:消耗数据 + 余额上下摞)。此时高度改用
   * **flex-grow 按比例分**,不用固定百分比:列容器有 11px 行间隙,固定百分比加起来
   * 正好 100% 再加间隙就溢出,底边被 overflow:hidden 裁掉,右列比左列矮一截
   * (Ben 截图实证"没对齐")。flex-grow 分的是"扣掉间隙之后"的剩余空间,两列底边自然齐平。
   */
  stacked?: boolean
  /**
   * 并排行内的宽度占比(2026-08-25 顶部分栏)。缺省表示独占一行,仍按 basisPct 定高
   * ——这条路径与改造前逐字节一致,旧布局不受影响。
   */
  widthPct?: number
  /**
   * 不画底边那根抓手(2026-09-27,卡 LY:横屏「小横线成对出现」)。
   *
   * 竖屏下这根抓手**就是**模块与下面那一块之间的那条边界,唯一的调高入口,照画。
   * 横屏不是:横屏五个区域之间每一条边界都已经有一根 `SplitHandle`(左栏|窗口槽、
   * 窗口槽|右侧栏、右侧栏上下两格之间、主区|底部一排、底部各格之间,2026-09-18 补齐),
   * 这根抓手再画一次就成了**同一条边界上挨着的两根短横线** —— 运营模板的右侧栏是
   * 三格竖排,于是「账号|选题池」「选题池|发布计划」「窗口槽|底部一排」三处各成一对
   * (维护者 2026-09-27 新 Air 截图);做产品模板右侧栏只有项目区一格,成对的只有
   * 窗口槽|底部一排那一处,不容易看出来,所以一直没被报出来。
   *
   * 而且横屏下这根抓手是**空的**:它改 `basis_pct`,横屏各格的尺寸读的是
   * `width_pct` / `side_pct` / 底部一排那个高度(renderModule 的 fill 档把 basis 当
   * flex-grow 传,传进来的是 grow 那个数),拖它一像素都不动。少画一根不丢任何能力。
   */
  noHandle?: boolean
  /** 抓手当前是否正被拖拽(驱动强调色,纯视觉,不参与换算)。 */
  dragging: boolean
  onResizeStart: (event: ReactPointerEvent<HTMLDivElement>, moduleId: string) => void
  onResizeMove: (event: ReactPointerEvent<HTMLDivElement>) => void
  onResizeEnd: (event: ReactPointerEvent<HTMLDivElement>) => void
  children: ReactNode
}) {
  return (
    <div
      className="ben-wb__mod"
      // 事务官动了这一块时,那一行字挂在这里(ActorNotes 按它找这一块;卡 P 补三)。
      data-module-box={id}
      style={stacked === true
        // 列内堆叠:按比例分掉扣除间隙后的剩余高度,宽度交给外层那一列。
        // **写三个长属性而不是 `flex: ${basisPct} 1 0` 那个简写**(2026-09-20):浏览器里
        // 两种写法逐字等价(grow / shrink / basis 三个值一模一样),但 jsdom 的 cssstyle
        // 不认简写里那个没带单位的 `0`,整条 flex **一个字都不落进 style 属性** ——
        // 于是"四格等宽"这类断言在测试里永远是真的(读到的是空字符串),截图导出的
        // DOM 里也没有这几个数。同一件事在测试里看不见,就等于没有被测到。
        ? { flexGrow: basisPct, flexShrink: 1, flexBasis: 0, minHeight: 0, minWidth: 0 }
        : widthPct === undefined
          ? { flex: `0 0 ${basisPct}%`, minHeight: 0 }
          // 行内:宽度由 widthPct 定,高度撑满行容器(行高已由父层按 basis_pct 定死)。
          : { flex: `0 1 ${widthPct}%`, minWidth: 0, minHeight: 0, height: '100%' }} // 0 1:给行内 11px 拖拽条让位,见 Workbench.tsx 同注
    >
      {children}
      {/* 底边拖拽调高手柄(真机反馈:6px 光边框只换光标、找不到——不是可发现的可用性
          affordance):12px 满宽热区 + 居中一根圆角短杠(灰→悬停变亮→拖拽变强调色),
          flex:none 占自己的固定高度,在 .ben-wb__mod 的 overflow:hidden 盒子内正常
          排布,不会被裁掉。pointerdown 记起点 Y + 起点布局,pointermove 换算成 Δpct
          经既有 resizeModule(clamp 8–70)实时应用,pointerup/cancel 收尾。持久化搭
          既有 800ms 去抖 POST /layout 的顺风车(applyLayout 路径),这里不额外处理。
          标题栏的 Alt + 方向键与收起按钮不受影响。 */}
      {noHandle !== true && (
      <div
        className="ben-wb__mod-handle"
        aria-label={`${title} 调整高度`}
        // F3(review):鼠标悬停给个原生 tooltip——抓手本身已经常显(真机反馈那一轮修的),
        // 但"这根短杠能拖"这件事本身还是不够明显,title 补一句人话,aria-label 不变
        // (那是给屏幕阅读器的可访问名,两者职责不同,不能互相替代)。
        title="拖动调整高度"
        data-dragging={dragging}
        onPointerDown={event => onResizeStart(event, id)}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeEnd}
        onPointerCancel={onResizeEnd}
      >
        <span className="ben-wb__mod-handle-grip" aria-hidden="true" />
      </div>
      )}
    </div>
  )
}

/**
 * 模块盒子的外壳参数(不含 children)。地基拆分后各模块组件(ProjectsModule 等)把渲染
 * 循环算好的这一包整体透传给 ModuleBox,不必各自重复声明一遍这八个字段。
 */
export type ModuleBoxProps = Omit<Parameters<typeof ModuleBox>[0], 'children'>

/**
 * 分栏把手(2026-09-18「横屏每条边界都要有分栏把手」)。
 *
 * **一份组件管所有边界**——竖屏顶部那对分栏、横屏的四条(左栏|窗口槽、窗口槽|项目区、
 * 主区|底部一排、底部四格两两之间)画的是同一个 DOM、同一套 CSS、同一块 11px 热区。
 * 提出来之前 Workbench.tsx 里有两处几乎一样的 `<div className="ben-wb__split">` 内联块,
 * 再按边界数铺开就是六处:六份同样的东西里改一处忘五处,是这个仓库已经吃过的亏
 * (先例:两份 DockTabBar 把同一枚蓝点标了两次已读)。
 *
 * `axis` 只改朝向,不改行为:'vertical' 是一根竖条、拖左右(col-resize),'horizontal'
 * 是一根横条、拖上下(row-resize)。换算(Δpx → Δ百分比)与落盘全在调用方,这里一个
 * 布局数字都不碰——同 ModuleBox 底边那根抓手的分工。
 */
export function SplitHandle({
  axis, label, dragging, onResizeStart, onResizeMove, onResizeEnd,
}: {
  axis: 'vertical' | 'horizontal'
  /** 可访问名,形如「调整 窗口槽 与 项目区 的宽度占比」。 */
  label: string
  /** 这根把手当前是否正被拖(驱动强调色,纯视觉)。 */
  dragging: boolean
  onResizeStart: (event: ReactPointerEvent<HTMLDivElement>) => void
  onResizeMove: (event: ReactPointerEvent<HTMLDivElement>) => void
  onResizeEnd: (event: ReactPointerEvent<HTMLDivElement>) => void
}) {
  return (
    <div
      className={axis === 'horizontal' ? 'ben-wb__split ben-wb__split--h' : 'ben-wb__split'}
      role="separator"
      // 一根**竖**条分的是左右两块,ARIA 里它自己的 orientation 就是 vertical(说的是这根
      // 分隔线的朝向,不是它调的那个维度)——竖屏那根原来就是这么标的,照搬不改。
      aria-orientation={axis}
      aria-label={label}
      data-split-axis={axis}
      // 同 ModuleBox 底边抓手:aria-label 给屏幕阅读器,title 给鼠标——"这根杠能拖"
      // 这件事光靠一根 4px 的灰杠还是不够明显(真机反馈那一轮的结论)。
      title={axis === 'horizontal' ? '拖动调整上下占比' : '拖动调整左右占比'}
      data-dragging={dragging}
      onPointerDown={onResizeStart}
      onPointerMove={onResizeMove}
      onPointerUp={onResizeEnd}
      onPointerCancel={onResizeEnd}
    >
      <span className="ben-wb__split-grip" aria-hidden="true" />
    </div>
  )
}
