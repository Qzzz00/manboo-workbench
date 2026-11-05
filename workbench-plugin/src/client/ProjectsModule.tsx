/**
 * 由 Workbench.tsx 的模块渲染循环拆出(2026-08-25 地基:六窗口并行前的接缝切分)。
 *
 * 2026-08-25 加过一层「总览 ⇄ 看板」开关;**2026-10-21 看板下线,换成协作区**
 * (`docs/设计-协作区-无限画布-2026-10-21.md`,待拍板 2 已定:替代,不并列 —— 一件事只有一份)。
 * **2026-10-22「总览」也退役**(维护者:「项目区那一排标签里下掉」;协作区 Pen A·30 / A·31 项目区那格就是协作区组件本身):
 * 给了 `collab` 这格就只放同一个协作区组件(按这格的宽度只显示一两天、名片栏收成入口),它右上角「展开」切到窗口槽里那一格。
 * 没接任务账(没给 `collab`)时照旧画项目行 —— 那是这格唯一拿得出来的东西,只是不再挂「总览」这个名字。
 * `layout.projects_view` 里存着 `board` / `overview` 的老布局照旧读得懂,一律按上面画。
 * 旧 `TaskBoard` / `TaskCard` / `TaskDialog` 文件再留一个版本(与 `sprints` / `modules` 字段同一档),下一版一起删。
 */

import type { Dispatch, ReactNode, SetStateAction } from 'react'
import type { ProjectRowsView } from './portfolio.ts'
import { ModuleBox, type ModuleBoxProps } from './ModuleBox.tsx'
import { ProjectZone } from './ProjectZone.tsx'
import { EmptyState } from './EmptyState.tsx'
import type { EmptyModule, EmptyView } from './emptyState.ts'

export function ProjectsModule({
  box, header, headingId, portfolio, expandedProjectId, setExpandedProjectId, handleConfirmStatus,
  empty, onEmptyAction, collab, tasksProblem,
}: {
  /** 项目区这格里放的协作区(同一个组件);给了这格就是它。 */
  collab?: ReactNode
  /** tasks.json 读不出来时那一句(`/state.tasks.problem`,2026-10-21 main)。缺席 = 读得好好的。 */
  tasksProblem?: string | undefined
  box: ModuleBoxProps
  header: ReactNode
  headingId: string
  portfolio: ProjectRowsView
  expandedProjectId: string | null
  setExpandedProjectId: Dispatch<SetStateAction<string | null>>
  handleConfirmStatus: (projectId: string, text: string) => void
  /**
   * 第一次用且一个项目、一张卡都没有(2026-09-18):整格换成空态 —— 第一次进来该看见的是"下一步做什么"。
   */
  empty?: EmptyView
  /** 空态那颗「开始引导」。不给就不画按钮(见 EmptyView.action)。 */
  onEmptyAction?: (module: EmptyModule) => void
}) {
  const showCollab = collab !== undefined
  return (
    <ModuleBox {...box}>
      {/* 标题在卡外那一行弱字里(10-22 拍板,同窗口槽),卡里整块给协作区。 */}
      {header}
      <section className="ben-wb__card ben-wb__card--fill ben-wb__projects" aria-labelledby={headingId}>
        {empty !== undefined && <EmptyState view={empty} {...(onEmptyAction === undefined ? {} : { onAction: onEmptyAction })} />}
        {empty === undefined && tasksProblem !== undefined && (
          // tasks.json 读不出来(2026-10-21 main):协作区那一屏照画,这一句挂在上面,看板改动一律不写。
          <p className="ben-wb__pj-calc ben-wb__pj-calc--error" role="alert">{tasksProblem}</p>
        )}
        {empty === undefined && showCollab && <div className="ben-wb__projects-collab">{collab}</div>}
        {empty === undefined && !showCollab && (
          <ProjectZone
            rows={portfolio.rows}
            otherRows={portfolio.otherRows}
            idleText={portfolio.idleText}
            pendingText={portfolio.pendingText}
            scanErrorTexts={portfolio.scanErrorTexts}
            blockedText={portfolio.blockedText}
            expandedId={expandedProjectId}
            onToggle={projectId => setExpandedProjectId(prev => (prev === projectId ? null : projectId))}
            onConfirmStatus={handleConfirmStatus}
          />
        )}
      </section>
    </ModuleBox>
  )
}
