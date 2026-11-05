/**
 * 任务看板(设计稿 §3.5 + 2026-08-25 Ben 补的四层收敛)。
 *
 * ```
 * 项目   ← 顶部一排标签(原来是左侧泳道;四层展开之后左边排不开,Ben:"放到顶部当标签算了")
 *   冲刺 ← 标签下面那条:冲刺目标 + 组成版本号 + 起止 + 进度(SprintBar)
 *     模块 ← 横向泳道,带模块目标
 *       功能点 ← 卡片(TaskCard),竖列 = 状态
 * ```
 *
 * 状态是七列(2026-09-09,借 DSH-taskboard 的语义;Ben 亲口定的那四个一个字没改,
 * 只在两头各加了一段——表与理由见 protocol.ts 的 TaskStatus)。**摆的方向可切**
 * (2026-08-25 Ben:"任务卡片可以有横排和竖排的切换";2026-09-09 加第三个):
 *
 * - `module-rows`(缺省):模块是横向泳道、状态是竖列 → 改状态**左右拖**,改模块上下拖
 * - `module-columns`:模块是竖列(在上)、状态是横向行 → 改状态**上下拖**,改模块左右拖
 * - `status-columns`:**只按状态分列,不分模块泳道** → 一屏回答"现在各状态各有几件"
 *
 * 三种共用同一个格子渲染(renderCell),差别只在网格怎么摆——不是三套界面,
 * 所以拖拽/建卡/折叠这些行为在三个方向下逐字一致,不会有一边修了另一边没修。
 *
 * ## 本期不做:agent 认领并干
 *
 * DSH-taskboard 的另一半是「agent 用工具认领任务、干完提交人审」。**那是「写入=派活」,
 * 不在本期**:要先改 PRD §7.4(决策记录 2026-09-09「事务官对其它 Agent 的写入边界」)。
 * 这里只做人手拖动/点按改状态,「等我确认」那一列的卡也只可能是 Ben 自己放进去的。
 *
 * ## 不可改清单第 5 条的延伸约束(PRD §9)
 *
 * 事务层永远只问"卡在哪、需要什么帮助",**不得建议删除待办**。这块界面里没有一处
 * 会自己冒出"这条很久没动,要不要删/归档":判断卡片新旧的代码根本不存在(读 updated_at
 * 只为把完成格排序),完成格的折叠只按**条数**、且「更早 · N 张」那行一直写着确切数字;
 * 删冲刺/删模块不级联删卡,失去归属的卡退回「未归模块」泳道继续待着。唯一带「删」字的
 * 地方是 Ben 自己点的那两个按钮,都要点两下。
 *
 * ## 为什么拖拽是手写的原生 HTML5 拖放
 *
 * 2026-08-25 按 Ben 的要求先查了 DSH 插件市场:dsh-kanban 与 dsh-web-ui/dsh-task-board
 * 两个看板插件都把卡片存在浏览器 localStorage 里(清一次浏览器数据就没了,服务端与
 * 展示台都看不见),而 Ben 要的是 tasks.json 这个事实源,数据模型对不上;后者还盯着
 * rc.6 的 AppFrame,我们 pin 在 0.1.1-rc.2。两家都没公开拖拽实现。dnd-kit 则要新增依赖,
 * 而本插件的依赖是逐个 pin 死并 link 到 DSH 本体的。所以参考不安装,拖拽用浏览器内建的
 * draggable/dragover/drop——零新依赖。
 *
 * 拖拽之外**每张卡都有 ←/→ 按钮**:这不是无障碍摆设,是本仓库既有纪律(见 ModuleBox
 * 的模块头注释)——按钮路径是唯一保证能用的交互面,拖拽是补充。
 */
import { useEffect, useState } from 'react'
import type { DragEvent as ReactDragEvent } from 'react'
import type {
  AgentEntryView,
  AgentId,
  BoardModule,
  ProjectBoardMeta,
  SessionView,
  SprintVersion,
  SprintView,
  TaskPriority,
  TaskStatus,
  TaskView,
  UsageTotals,
  WorkbenchProject,
} from '../protocol.ts'
import { AGENT_IDS, TASK_PRIORITIES, TASK_STATUSES, canTransition, scheduleRiskText } from '../protocol.ts'
import {
  ASSIGNEE_TITLES,
  ATTENTION_STATUSES,
  DONE_PREVIEW_COUNT,
  PRIORITY_TITLES,
  STATUS_TITLES,
  attentionCounts,
  buildLanes,
  laneIsEmpty,
  visibleLanes,
  buildProjectTabs,
  daysLeft,
  laneProgress,
  sprintProgress,
  sprintsOf,
  tasksInCell,
  tasksInStatus,
  type Lane,
} from './boardModel.ts'
import type { BoardAxis } from './projectsView.ts'
import { SprintBar, type SprintPatch } from './SprintBar.tsx'
import { TaskCard, type TaskPatch } from './TaskCard.tsx'
import { TaskDialog } from './TaskDialog.tsx'
import type { ProgressActions } from './ProgressBlock.tsx'
import type { VeilTarget } from './useVeilSlot.ts'
import { Meter } from './Meter.tsx'
import { confirmedSplit } from './portfolio.ts'
import { otherReposLabel } from './ProjectZone.tsx'

/**
 * 「一条会话的账都没查到」时用的空表。**模块常量,不是行内字面量**:行内的话每次渲染
 * 都是新对象引用,底下的卡会跟着白白重渲染(先例见 Workbench.tsx 的 EMPTY_TASKS)。
 */
const EMPTY_USAGE: Readonly<Record<string, UsageTotals>> = {}

export interface CreateTaskArgs {
  title: string
  projectId?: string
  moduleId?: string
  source?: TaskView['source']
  /**
   * 建的是哪一种卡(2026-09-22)。**不传就是普通事项**,既有的每一条建卡路径一字不变。
   * `'feature'` = 需求卡 = 指挥台:建出来之后打开它,卡上就是四态那一整块。
   */
  kind?: TaskView['kind']
}

/** 看板能做的全部动作。一个对象透传,免得往下钻四层每层都摊开十个回调。 */
export interface BoardActions {
  createTask: (input: CreateTaskArgs) => void
  /** 改状态;跨泳道拖动时 moduleId 一并给(null = 退回未归模块)。 */
  moveTask: (id: string, status: TaskStatus, moduleId?: string | null) => void
  updateTask: (id: string, patch: TaskPatch) => void
  deleteTask: (id: string) => void
  createSprint: (projectId: string, name: string) => void
  updateSprint: (id: string, patch: SprintPatch) => void
  deleteSprint: (id: string) => void
  createModule: (sprintId: string, name: string) => void
  updateModule: (id: string, patch: { name?: string, goal?: string | null, versionLabel?: string | null }) => void
  deleteModule: (id: string) => void
  setProjectMeta: (projectId: string, patch: { priority?: TaskPriority | null, assignee?: AgentId | null }) => void
  /**
   * 停掉这条事项底下那次派活(2026-09-21)= 杀事务官报上来的那个 pid。
   *
   * **可选**:没接线的地方(既有的一批用例、手机端那份精简看板)整颗按钮不出现,
   * 行为与这件功能出现之前一字不差。
   */
  stopDispatch?: (id: string) => void
  /**
   * 「现在到哪」那一块的三颗按钮(2026-09-25 卡 N):当场按证据核一次 / 他说一句到哪了 / 派给负责人那一家。
   * 各回一句给他看的回执。**可选**:没接线的地方那一颗不画。
   */
  checkProgress?: (id: string) => Promise<string>
  sayProgress?: (id: string, text: string) => Promise<string>
  driveTask?: (id: string) => Promise<string>
}

export interface TaskBoardProps {
  tasks: readonly TaskView[]
  sprints: readonly SprintView[]
  modules: readonly BoardModule[]
  projectMeta: readonly ProjectBoardMeta[]
  projects: readonly WorkbenchProject[]
  /** 「从会话转卡」用。会话本身不自动进看板(2026-08-25 澄清:确认列只放 Ben 自己的卡)。 */
  sessions: readonly SessionView[]
  /** 服务端快照的时刻(ISO)。剩余天数/时间进度都按它算,不各处 Date.now()——
      那样同一屏上两处会差一拍,测试也钉不住。 */
  now: string
  /** 排布方向(2026-08-25 横排/竖排开关)。持久化在 layout.board_axis。 */
  axis: BoardAxis
  onAxisChange: (axis: BoardAxis) => void
  /**
   * 已关联会话各自的用量(/state.tasks.session_usage,键 `agent:session_id`)。
   * 查不到账的会话不在里面——卡面据此整段不显示,而不是写 0(D13)。缺省 = 一条都没有。
   */
  sessionUsage?: Readonly<Record<string, UsageTotals>> | undefined
  /** 收件箱最近一次归档的落点。挂「文件」类交付物时点一下就填上,免得手敲长路径。 */
  lastArchivedPath?: string | undefined
  actions: BoardActions
  /**
   * 「项目」在当前模板里叫什么(2026-09-21 布局模板)。**不传就是「项目」** ——
   * 那一大批既有用例与展示台一条没改。只影响这一层的三处措辞(顶部标签那一组的
   * aria-label、空态那句、「未归<项目>」),数据一个字不动。
   */
  projectWord?: string
  /** 弹层让开窗位(2026-09-11):透传给功能点弹窗。 */
  veil?: VeilTarget
  /**
   * 需求指挥台要打的那几条路由(2026-09-22)。原样透传给功能点弹窗 ——
   * **两个都没传就整块不画**,既有的一批用例与手机端那份精简看板一字不变。
   */
  baseUrl?: string | undefined
  fetchImpl?: typeof fetch | undefined
  /**
   * Agent 登记表里接上了的那几家(2026-09-25,卡 Z):卡面派活小标的名字与小头像颜色、
   * 弹窗里那排可点的负责人都读它。缺席 = 老行为(家名那张表、头像自带的颜色、只有人那几档)。
   */
  agents?: readonly AgentEntryView[] | undefined
  /** /state.tasks.problem:tasks.json 读不出来时那一句(此刻看板空着、改动不写)。缺席 = 一切正常。 */
  problem?: string | undefined
}

export function TaskBoard({
  tasks, sprints, modules, projectMeta, projects, sessions, now, axis, onAxisChange,
  sessionUsage, lastArchivedPath, actions, veil, projectWord, baseUrl, fetchImpl, agents, problem,
}: TaskBoardProps) {
  const usage = sessionUsage ?? EMPTY_USAGE
  const word = projectWord ?? '项目'
  const tabs = buildProjectTabs(projects, tasks, projectMeta, word)
  /**
   * 页签只排他确认过的项目(2026-09-25,维护者:「引导说了两个项目,看板里还是一堆」):
   * 在 projects.json 里的那几个 + 「未归项目」。扫到的其余仓库收进末尾「其他仓库(N)」,点开才排出来。
   */
  const confirmedIds = new Set(confirmedSplit(projects).mine.map(project => project.id))
  const mainTabs = tabs.filter(tab => tab.id === undefined || confirmedIds.has(tab.id))
  const otherTabs = tabs.filter(tab => tab.id !== undefined && !confirmedIds.has(tab.id))
  const [projectId, setProjectId] = useState<string | undefined>((mainTabs[0] ?? tabs[0])?.id)
  const [othersOpen, setOthersOpen] = useState(false)
  // 选中的那个正好在「其他仓库」里(他从那一格点进去的,或者只有扫到的):那一格保持展开,选中的页签别藏起来。
  const showOthers = othersOpen || otherTabs.some(tab => tab.id === projectId)
  const [sprintId, setSprintId] = useState<string | undefined>(undefined)
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [overCell, setOverCell] = useState<string | null>(null)
  const [expandedDone, setExpandedDone] = useState<readonly string[]>([])
  const [sessionPickerOpen, setSessionPickerOpen] = useState(false)
  /** 打开详情弹窗的那张卡。Ben:就地展开"很反人类",编辑整个搬进弹窗。 */
  const [openTaskId, setOpenTaskId] = useState<string | null>(null)

  const nowMs = (() => {
    const parsed = Date.parse(now)
    return Number.isNaN(parsed) ? 0 : parsed
  })()

  const projectSprints = sprintsOf(sprints, projectId)
  const currentSprintId = projectSprints.some(sprint => sprint.id === sprintId)
    ? sprintId
    : projectSprints[0]?.id

  // 项目一换,冲刺得跟着落到新项目的第一个上。放 effect 而不是渲染期间直接算:
  // 选中的冲刺是用户状态,渲染期间悄悄改它会让"我明明点了别的冲刺"变成玄学。
  useEffect(() => { setSprintId(undefined) }, [projectId])

  /*
   * 空的「未归模块」不画、空的模块泳道收成一行(2026-09-25,卡 N;维护者:「底部还有什么未归类模块,
   * 都没有内容为什么还要显示」)。有卡的未归模块照旧画 —— 那些卡得有地方待着。
   * 拖着一张卡的时候空的那几栏(含未归模块)也摆出来当落点,收成一行 —— 不然拖不回「未归模块」。
   */
  const allLanes = buildLanes(modules, currentSprintId)
  const lanes = draggingId === null ? visibleLanes(allLanes, tasks, modules, projectId) : allLanes
  const progress = sprintProgress(tasks, modules, projectId, currentSprintId)

  const laneKey = (lane: Lane): string => lane.id ?? '__none__'
  const cellKey = (lane: Lane, status: TaskStatus): string => `${laneKey(lane)}:${status}`

  function handleDrop(event: ReactDragEvent<HTMLDivElement>, lane: Lane | undefined, status: TaskStatus): void {
    event.preventDefault()
    setOverCell(null)
    const id = event.dataTransfer?.getData('text/plain') || draggingId
    setDraggingId(null)
    if (id === null || id === '') return
    const task = tasks.find(candidate => candidate.id === id)
    if (task === undefined) return
    const sameLane = lane === undefined || (task.module_id ?? undefined) === lane.id
    if (task.status === status && sameLane) return
    // 转换表在客户端也拦一道(2026-09-09 七态):走不通的那一步压根不发请求。
    // 服务端照同一张表把关(protocol.ts 是唯一真相),但让 Ben 拖到一半才收到一句红字
    // 是很差的观感——去不了的格子在界面上本来就该是拒绝的。
    if (!canTransition(task.status, status).ok) return
    // 换了泳道就连模块归属一起改:泳道就是模块,拖过去却不改归属的话松手就跳回原处,
    // 那是坏掉的观感,不是"保守"。「按状态」那个方向没有泳道,只改状态。
    if (lane === undefined) { actions.moveTask(id, status); return }
    actions.moveTask(id, status, sameLane ? undefined : (lane.id ?? null))
  }

  const currentTab = tabs.find(tab => tab.id === projectId)
  const currentProject = projects.find(project => project.id === projectId)

  const renderTab = (tab: typeof tabs[number]) => (
    <button
      key={tab.id ?? '__none__'}
      type="button"
      className="ben-wb__ptab"
      data-on={tab.id === projectId}
      aria-pressed={tab.id === projectId}
      onClick={() => setProjectId(tab.id)}
    >
      {/* 优先级是标签左边一条竖色边(不是一句"高"):一排标签扫过去,
          哪个最急是靠颜色跳出来的,不是靠逐个读字。 */}
      <span className="ben-wb__ptab-bar" data-priority={tab.priority ?? ''} aria-hidden="true" />
      <span className="ben-wb__ptab-name">{tab.name}</span>
      {tab.assignee !== undefined && (
        <span className="ben-wb__task-who" data-agent={tab.assignee}>{ASSIGNEE_TITLES[tab.assignee]}</span>
      )}
      {tab.due !== undefined && (
        <span className="ben-wb__task-due" data-tight={daysLeft(tab.due, nowMs) <= 7}>
          {dueText(tab.due, nowMs)}
        </span>
      )}
      {/* 排期风险(2026-09-09):这一排标签就是看板的列头,风险跟着项目走。
          文案与项目区总览逐字相同(protocol.scheduleRiskText),两处不许各说各的。 */}
      {tab.risk !== undefined && (
        <span
          className="ben-wb__ptab-risk"
          data-risk={tab.risk.level}
          title={tab.risk.reason}
          aria-label={`${tab.name} 排期风险:${scheduleRiskText(tab.risk)}`}
        >
          {scheduleRiskText(tab.risk)}
        </span>
      )}
      <span className="ben-wb__board-count">{tab.count}</span>
      {tab.priority !== undefined && (
        <span className="ben-wb__sr">优先级 {PRIORITY_TITLES[tab.priority]}</span>
      )}
    </button>
  )

  return (
    <div className="ben-wb__board">
      {problem !== undefined && <p className="ben-wb__board-problem" role="alert">{problem}</p>}
      {/* —— 第一层:项目(顶部标签) —— */}
      <div className="ben-wb__ptabs" role="group" aria-label={word}>
        {tabs.length === 0
          ? <span className="ben-wb__board-pickempty">{`还没有${word}`}</span>
          : <>
              {mainTabs.map(tab => renderTab(tab))}
              {otherTabs.length > 0 && (
                <button
                  type="button"
                  className="ben-wb__ptab ben-wb__ptab--others"
                  aria-expanded={showOthers}
                  onClick={() => setOthersOpen(open => !(open || otherTabs.some(tab => tab.id === projectId)))}
                >
                  <span className="ben-wb__ptab-name">{otherReposLabel(otherTabs.length)}</span>
                  <span aria-hidden="true">{showOthers ? '−' : '+'}</span>
                </button>
              )}
              {showOthers && otherTabs.map(tab => renderTab(tab))}
            </>}
      </div>

      {projectId !== undefined && currentTab !== undefined && (
        <ProjectMetaRow
          key={projectId}
          tab={currentTab}
          {...(agents === undefined ? {} : { agents })}
          nowMs={nowMs}
          axis={axis}
          onAxisChange={onAxisChange}
          onChange={patch => actions.setProjectMeta(projectId, patch)}
          sessions={sessions}
          onPickSession={(session) => {
            actions.createTask({
              title: session.title ?? `${session.agent} 会话`,
              projectId,
              source: { kind: 'session', ref: session.session_id },
            })
            setSessionPickerOpen(false)
          }}
          /**
           * 「归到这张卡」(2026-09-09 费用归因的入口):从会话这一侧把它挂到**已有的**卡上,
           * 而不是每条会话都新建一张。这条是费用能归到卡上的前提——links 就是归因的依据。
           * 整组给回(原来那几条 + 这条),与弹窗里那个入口走同一条 update 路。
           */
          assignableTasks={tasks.filter(task => (task.project_id ?? undefined) === projectId)}
          onAssignSession={(session, taskId) => {
            const target = tasks.find(candidate => candidate.id === taskId)
            if (target === undefined) return
            const existing = target.links ?? []
            if (existing.some(link => link.agent === session.agent && link.session_id === session.session_id)) return
            actions.updateTask(taskId, {
              links: [...existing, { agent: session.agent, session_id: session.session_id }],
            })
            setSessionPickerOpen(false)
          }}
          pickerOpen={sessionPickerOpen}
          setPickerOpen={setSessionPickerOpen}
        />
      )}

      {/* —— 第二层:冲刺 —— */}
      {projectId === undefined
        ? (
            <p className="ben-wb__sprint-empty">
              这些卡还没归到项目。归进某个项目之后才排得进冲刺与模块。
            </p>
          )
        : (
            <SprintBar
              sprints={projectSprints}
              currentId={currentSprintId}
              progress={progress}
              attention={attentionCounts(tasks, projectId)}
              nowMs={nowMs}
              onSelect={setSprintId}
              onCreate={name => actions.createSprint(projectId, name)}
              onUpdate={actions.updateSprint}
              onDelete={actions.deleteSprint}
            />
          )}

      {/* —— 第三、四层:模块 × 状态。两种方向共用下面这个 renderCell —— */}
      {(() => {
        /** `lane === undefined` = 「按状态」那个方向:一列一态,不分泳道。 */
        const renderCell = (lane: Lane | undefined, status: TaskStatus) => {
          const key = lane === undefined ? '__all__' : laneKey(lane)
          const cell = `${key}:${status}`
          const cellTasks = lane === undefined
            ? tasksInStatus(tasks, projectId, status)
            : tasksInCell(tasks, modules, projectId, lane, status)
          const foldDone = status === 'done' && !expandedDone.includes(key)
          const shown = foldDone ? cellTasks.slice(0, DONE_PREVIEW_COUNT) : cellTasks
          const rest = cellTasks.length - shown.length
          return (
            <div
              key={cell}
              className="ben-wb__board-cell"
              data-over={overCell === cell}
              data-status={status}
              aria-label={`${lane === undefined ? '按状态' : lane.name} · ${STATUS_TITLES[status]}`}
              onDragOver={(event) => { event.preventDefault(); setOverCell(cell) }}
              onDragLeave={() => setOverCell(current => (current === cell ? null : current))}
              onDrop={event => handleDrop(event, lane, status)}
            >
              <span className="ben-wb__board-cell-heading"
                aria-label={`${lane === undefined ? '按状态' : lane.name} · ${STATUS_TITLES[status]}：${cellTasks.length} 件`}>
                {lane === undefined ? '按状态' : lane.name} · {STATUS_TITLES[status]}
                <span className="ben-wb__board-count">{cellTasks.length}</span>
              </span>
              {shown.map(task => (
                <TaskCard
                  key={task.id}
                  task={task}
                  sessions={sessions}
                  {...(agents === undefined ? {} : { agents })}
                  sessionUsage={usage}
                  nowMs={nowMs}
                  onOpen={() => setOpenTaskId(task.id)}
                  // 派活可撤销(2026-09-21)。没接这条动作时整颗按钮不画(TaskCard 自己判)。
                  onStopDispatch={actions.stopDispatch === undefined ? undefined : () => actions.stopDispatch?.(task.id)}
                  onDragStart={(event) => {
                    event.dataTransfer?.setData('text/plain', task.id)
                    setDraggingId(task.id)
                  }}
                  onDragEnd={() => { setDraggingId(null); setOverCell(null) }}
                />
              ))}
              {rest > 0 && (
                <button
                  type="button"
                  className="ben-wb__board-more"
                  onClick={() => setExpandedDone(current => [...current, key])}
                >
                  更早 · {rest} 张
                </button>
              )}
              {status === 'todo' && (
                <NewTaskInput
                  label={lane === undefined ? STATUS_TITLES.todo : lane.name}
                  moduleId={lane?.id}
                  projectId={projectId}
                  onCreate={actions.createTask}
                />
              )}
            </div>
          )
        }

        const moduleHead = (lane: Lane) => (
          <ModuleHead
            key={`head-${laneKey(lane)}`}
            lane={lane}
            axis={axis}
            progress={laneProgress(tasks, modules, projectId, lane)}
            versions={projectSprints.find(sprint => sprint.id === currentSprintId)?.versions ?? []}
            onUpdate={patch => { if (lane.id !== undefined) actions.updateModule(lane.id, patch) }}
            onDelete={() => { if (lane.id !== undefined) actions.deleteModule(lane.id) }}
          />
        )

        const statusHead = (status: TaskStatus) => (
          <span
            key={`col-${status}`}
            className="ben-wb__board-colname"
            data-status={status}
            // 「等我确认」「阻塞」是唯二在等 Ben 动手的两列,做成醒目样式;
            // 其余五列都不需要他此刻做什么。
            data-attention={ATTENTION_STATUSES.includes(status)}
          >
            {/* 列名与计数各自成 span:合在一起的话 textContent 会是「完成6」,
                按列名取元素的地方(测试、以后可能加的筛选)会全部取到那一坨。 */}
            <span className="ben-wb__board-coltitle">{STATUS_TITLES[status]}</span>
            <span className="ben-wb__board-count">
              {tasks.filter(task => task.status === status && (task.project_id ?? undefined) === projectId).length}
            </span>
          </span>
        )

        // 竖排:模块在上当列头,状态在下当行头。列数随模块数变,只能内联给。
        const columnsStyle = { gridTemplateColumns: `var(--wb-head) repeat(${lanes.length}, minmax(190px, 1fr))` }
        // 「按状态」:没有泳道那一列头,七列平分,不留角上那一格。
        const statusOnlyStyle = { gridTemplateColumns: `repeat(${TASK_STATUSES.length}, minmax(180px, 1fr))` }

        return (
          <div className="ben-wb__board-scroll" data-axis={axis}>
            {axis === 'module-rows' && (
              <>
                <div className="ben-wb__board-head">
                  <span className="ben-wb__board-corner" aria-hidden="true" />
                  {TASK_STATUSES.map(statusHead)}
                </div>
                {lanes.map(lane => laneIsEmpty(tasks, modules, projectId, lane)
                  // 空的模块泳道收成一行:名字 + 记一条,不画七个空格子(卡 N)。拖一张卡进来照样落在这一栏的「待办」。
                  ? (
                      <div className="ben-wb__board-lane" data-empty="true" key={laneKey(lane)}>
                        {moduleHead(lane)}
                        <div
                          className="ben-wb__lane-empty"
                          aria-label={`${lane.name} · 还没有卡`}
                          data-over={overCell === cellKey(lane, 'todo')}
                          onDragOver={(event) => { event.preventDefault(); setOverCell(cellKey(lane, 'todo')) }}
                          onDragLeave={() => setOverCell(null)}
                          // 拖进来只换这一栏,状态不动(拖的那张原来在哪一列就还在哪一列)。
                          onDrop={event => handleDrop(event, lane, tasks.find(task => task.id === draggingId)?.status ?? 'todo')}
                        >
                          <span className="ben-wb__lane-empty-note">这一栏还没有卡</span>
                          <NewTaskInput label={lane.name} moduleId={lane.id} projectId={projectId} onCreate={actions.createTask} />
                        </div>
                      </div>
                    )
                  : (
                      <div className="ben-wb__board-lane" key={laneKey(lane)}>
                        {moduleHead(lane)}
                        {TASK_STATUSES.map(status => renderCell(lane, status))}
                      </div>
                    ))}
              </>
            )}

            {axis === 'module-columns' && (
              <>
                <div className="ben-wb__board-head" style={columnsStyle}>
                  <span className="ben-wb__board-corner" aria-hidden="true" />
                  {lanes.map(moduleHead)}
                </div>
                {TASK_STATUSES.map(status => (
                  <div className="ben-wb__board-lane" key={status} style={columnsStyle}>
                    {statusHead(status)}
                    {lanes.map(lane => renderCell(lane, status))}
                  </div>
                ))}
              </>
            )}

            {/* 「按状态」:一列一态,所有模块的卡并进同一列。模块泳道整条不出现——
                它在这个方向上没有意义,留一条空头只是噪音。 */}
            {axis === 'status-columns' && (
              <>
                <div className="ben-wb__board-head" style={statusOnlyStyle}>
                  {TASK_STATUSES.map(statusHead)}
                </div>
                <div className="ben-wb__board-lane" style={statusOnlyStyle}>
                  {TASK_STATUSES.map(status => renderCell(undefined, status))}
                </div>
              </>
            )}

            {currentSprintId !== undefined && axis !== 'status-columns' && (
              <NewModuleInput sprintId={currentSprintId} onCreate={actions.createModule} />
            )}
          </div>
        )
      })()}

      {(() => {
        const open = tasks.find(task => task.id === openTaskId)
        if (open === undefined) return null
        const lane = lanes.find(candidate => candidate.id === (open.module_id ?? undefined))
        return (
          <TaskDialog
            task={open}
            moduleName={lane?.name ?? '未归模块'}
            sessions={sessions}
            sessionUsage={usage}
            branches={currentProject?.signals?.branches ?? []}
            repoPath={currentProject?.path}
            /* 「带入」的候选路径:收件箱刚归档到哪儿,以及这张卡当初是从哪个文件转来的。 */
            filePathHints={[
              ...(lastArchivedPath === undefined || lastArchivedPath === '' ? [] : [lastArchivedPath]),
              ...(open.source.kind === 'file' && open.source.ref !== undefined ? [open.source.ref] : []),
            ]}
            onClose={() => setOpenTaskId(null)}
            {...(veil === undefined ? {} : { veil })}
            {...(baseUrl === undefined ? {} : { deckBaseUrl: baseUrl })}
            {...(fetchImpl === undefined ? {} : { deckFetch: fetchImpl })}
            onMove={actions.moveTask}
            onUpdate={actions.updateTask}
            onDelete={(id) => { actions.deleteTask(id); setOpenTaskId(null) }}
            progressActions={progressActionsOf(actions)}
            {...(agents === undefined ? {} : { agents })}
            now={now}
          />
        )
      })()}
    </div>
  )
}

/**
 * 项目那一层的优先级 / 负责人 / 预期结束(Ben 纠正过措辞:是**负责人**,不是"执行人")。
 *
 * 当前负责人与优先级留在项目标题旁；低频编辑收进「项目设置」，原回调载荷不变。
 * 排布方向与会话转卡常显。切换项目重新关闭设置，避免把前一项目的编辑上下文带过去。
 *
 * 预期结束时间**只读**:项目的 DDL 归项目区管(projects.json 的 ProjectDdl),
 * 两处都能改的话同一个日期会有两个真相。
 */
/**
 * 项目那一排「负责人」可点的几家(2026-09-27,卡 HC「不写死各家 AI」)。
 *
 * 原来这里直接遍历 `AGENT_IDS` —— 全新 MacBook Air(只装了豆包办公与 Codex)上于是点得到
 * 没装的 Claude 与 Kimi。维护者:「每一个人电脑装的东西都不一样,千万不能写死」。
 * 现在**按登记表筛**:登记表里接上了的才列。
 *
 * ★ 一处**还没做到**:能当项目负责人的家名在协议里仍是闭集(`AgentId`,见 protocol.ts),
 * 所以豆包办公这类只有窗口那只手的家**列不进来** —— 要放开得把 `assignee` 一路(服务端
 * `materializeService.ts`、手机端 `api/protocol.ts`)一起改成开集,不是今晚这张卡的范围。
 * 卡上的「派给谁」那一排(`TaskDialog` 的 `assigneePicker`)早就是开集的,不受这条限制。
 *
 * `agents` 缺席(老宿主、登记表没接、那一大批直接造 props 的用例)→ 退回 `AGENT_IDS`,
 * 行为与这一版之前一字不差(D13:查不到不许冒充没有)。
 * 已经选上的那一家永远留着:选的是谁必须看得出来,哪怕它已经从登记表里撤了。
 */
export function assigneeChips(
  agents: readonly AgentEntryView[] | undefined,
  current?: AgentId,
): readonly { id: AgentId, name: string }[] {
  const known = agents === undefined ? undefined : new Set(agents.map(one => one.id))
  return AGENT_IDS
    .filter(id => known === undefined || known.has(id) || id === current)
    .map(id => ({ id, name: agents?.find(one => one.id === id)?.name ?? ASSIGNEE_TITLES[id] ?? id }))
}

function ProjectMetaRow({
  tab, nowMs, axis, onAxisChange, onChange, sessions, onPickSession,
  assignableTasks, onAssignSession, pickerOpen, setPickerOpen, agents,
}: {
  tab: { name: string, priority?: TaskPriority, assignee?: AgentId, due?: string }
  nowMs: number
  axis: BoardAxis
  onAxisChange: (axis: BoardAxis) => void
  onChange: (patch: { priority?: TaskPriority | null, assignee?: AgentId | null }) => void
  sessions: readonly SessionView[]
  onPickSession: (session: SessionView) => void
  /** 当前项目下的卡,供「归到已有的卡」列出来。一张都没有时那个入口整个不出现。 */
  assignableTasks: readonly TaskView[]
  onAssignSession: (session: SessionView, taskId: string) => void
  pickerOpen: boolean
  setPickerOpen: (value: boolean) => void
  /**
   * Agent 登记表里接上了的那几家(2026-09-27,卡 HC)。这一排「负责人」原来遍历写死的
   * `AGENT_IDS` —— 于是全新 Air 上点得到没装的 Claude 与 Kimi、点不到装着的豆包办公。
   * 缺席 = 老宿主 / 登记表没接 → 退回 `AGENT_IDS`(D13:查不到不许冒充没有)。
   */
  agents?: readonly AgentEntryView[] | undefined
}) {
  /** 正在给哪条会话挑卡(`agent:session_id`)。null = 没在挑。 */
  const [assignFor, setAssignFor] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  return (
    <div className="ben-wb__pmeta">
      <div className="ben-wb__project-title">
        <h2>{tab.name}</h2>
        <span>{tab.assignee === undefined ? '负责人未定' : ASSIGNEE_TITLES[tab.assignee]}</span>
        {tab.priority !== undefined && <span data-priority={tab.priority}>{PRIORITY_TITLES[tab.priority]}优先级</span>}
      </div>
      <div className="ben-wb__board-bar" role="group" aria-label="看板工具">
        <button
          type="button"
          className="ben-wb__project-settings-toggle"
          aria-expanded={settingsOpen}
          onClick={() => setSettingsOpen(open => !open)}
        >项目设置</button>
        {/* 横排 / 竖排(2026-08-25 Ben)。两种都不是"更好的那个",看模块多还是卡多。 */}
        <div className="ben-wb__axis" role="group" aria-label="卡片排布方向">
          <button
            type="button"
            data-on={axis === 'module-rows'}
            aria-pressed={axis === 'module-rows'}
            title="模块在左,状态是竖列——改状态左右拖"
            onClick={() => onAxisChange('module-rows')}
          >
            横排
          </button>
          <button
            type="button"
            data-on={axis === 'module-columns'}
            aria-pressed={axis === 'module-columns'}
            title="模块在上,状态是横行——改状态上下拖"
            onClick={() => onAxisChange('module-columns')}
          >
            竖排
          </button>
          <button
            type="button"
            data-on={axis === 'status-columns'}
            aria-pressed={axis === 'status-columns'}
            title="只按状态分列,不分模块泳道——一屏看清各状态各有几件"
            onClick={() => onAxisChange('status-columns')}
          >
            按状态
          </button>
        </div>
        <button
          type="button"
          className="ben-wb__board-pick"
          aria-expanded={pickerOpen}
          onClick={() => setPickerOpen(!pickerOpen)}
        >
          从会话转卡
        </button>
        {pickerOpen && (
          <div className="ben-wb__board-picklist" role="group" aria-label="把会话转成卡片">
            {sessions.length === 0
              ? <span className="ben-wb__board-pickempty">现在没有会话</span>
              : sessions.map((session) => {
                  const key = `${session.agent}:${session.session_id}`
                  const name = session.title ?? `${session.agent} 会话`
                  // 已经归在某张卡上的不再列那张卡:再归一次是空操作,给他这个按钮只会让他以为没生效。
                  const targets = assignableTasks.filter(task => !(task.links ?? [])
                    .some(link => link.agent === session.agent && link.session_id === session.session_id))
                  return (
                    <span className="ben-wb__board-pickrow" key={key}>
                      <button type="button" onClick={() => onPickSession(session)}>{name}</button>
                      {/* 「归到已有的卡」:本项目一张卡都没有时整个不出现——
                          摆一个点开只有空列表的按钮,比没有这个按钮更费解(同分支下拉那条)。 */}
                      {assignableTasks.length > 0 && (
                        <button
                          type="button"
                          className="ben-wb__board-assign"
                          aria-label={`把「${name}」归到已有的卡`}
                          aria-expanded={assignFor === key}
                          onClick={() => setAssignFor(assignFor === key ? null : key)}
                        >
                          归到已有的卡
                        </button>
                      )}
                      {assignFor === key && (
                        <span className="ben-wb__board-assignlist">
                          {targets.length === 0
                            ? <span className="ben-wb__board-pickempty">没有可归的卡</span>
                            : targets.map(task => (
                                <button
                                  key={task.id}
                                  type="button"
                                  onClick={() => { onAssignSession(session, task.id); setAssignFor(null) }}
                                >
                                  归到「{task.title}」
                                </button>
                              ))}
                        </span>
                      )}
                    </span>
                  )
                })}
          </div>
        )}
      </div>
      {settingsOpen && (
      <div className="ben-wb__project-settings" role="group" aria-label={`${tab.name} 项目设置`}>
      <div className="ben-wb__pmeta-item">
        <span className="ben-wb__pmeta-tag">优先级</span>
        <div className="ben-wb__chips" role="group" aria-label={`${tab.name} 优先级`}>
          {TASK_PRIORITIES.map(priority => (
            <button
              key={priority}
              type="button"
              className="ben-wb__chip"
              data-priority={priority}
              data-on={tab.priority === priority}
              aria-pressed={tab.priority === priority}
              aria-label={`${tab.name} 优先级 ${PRIORITY_TITLES[priority]}`}
              // 再点一下当前那档 = 取消,不必另设"未定"按钮。
              onClick={() => onChange({ priority: tab.priority === priority ? null : priority })}
            >
              {PRIORITY_TITLES[priority]}
            </button>
          ))}
        </div>
      </div>

      <div className="ben-wb__pmeta-item">
        <span className="ben-wb__pmeta-tag">负责人</span>
        <div className="ben-wb__chips" role="group" aria-label={`${tab.name} 负责人`}>
          {assigneeChips(agents, tab.assignee).map(({ id, name }) => (
            <button
              key={id}
              type="button"
              className="ben-wb__chip"
              data-agent={id}
              data-on={tab.assignee === id}
              aria-pressed={tab.assignee === id}
              aria-label={`${tab.name} 负责人 ${name}`}
              onClick={() => onChange({ assignee: tab.assignee === id ? null : id })}
            >
              {name}
            </button>
          ))}
        </div>
      </div>

      <div className="ben-wb__pmeta-item">
        <span className="ben-wb__pmeta-tag">预期结束</span>
        {tab.due === undefined
          ? <em className="ben-wb__sprint-blank">未定(在总览里设)</em>
          : (
              <span className="ben-wb__pmeta-due" data-tight={daysLeft(tab.due, nowMs) <= 7}>
                {dueText(tab.due, nowMs)}
                <code>{tab.due}</code>
                <em className="ben-wb__sprint-blank">(在总览里改)</em>
              </span>
            )}
      </div>

      </div>
      )}
    </div>
  )
}

/** "剩 6 天" / "今天" / "晚了 3 天"。裸日期要心算,这个不用。 */
function dueText(due: string, nowMs: number): string {
  const left = daysLeft(due, nowMs)
  return left < 0 ? `晚了 ${-left} 天` : left === 0 ? '今天' : `剩 ${left} 天`
}

/**
 * 泳道头:模块名 + 版本徽章 + 完成度条 + 模块目标。点开可改。
 *
 * 版本徽章(Ben 2026-08-25:"我预设的客户端模块或者后端模块……就是不好划分版本号"):
 * 模块指向冲刺里已有的**一条**组成版本。他按端拆模块就一一对应,按功能域拆就标一下
 * 算哪端——两种拆法都成立,版本号从此有明确归属。
 *
 * 「未归模块」那条没有可改的东西,只显示名字。
 */
function ModuleHead({ lane, axis, progress, versions, onUpdate, onDelete }: {
  lane: Lane
  /** 竖排时泳道头是**列头**(在最上面一行),排布紧凑一些。 */
  axis: BoardAxis
  progress: { done: number, total: number }
  versions: readonly SprintVersion[]
  onUpdate: (patch: { name?: string, goal?: string | null, versionLabel?: string | null }) => void
  onDelete: () => void
}) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState(lane.name)
  const [goal, setGoal] = useState(lane.goal ?? '')
  const [confirmDelete, setConfirmDelete] = useState(false)

  if (lane.id === undefined) {
    return (
      <div className="ben-wb__board-lanename" data-axis={axis}>
        <span className="ben-wb__lane-title">{lane.name}</span>
        <em className="ben-wb__sprint-blank">还没归模块的卡</em>
        <Meter done={progress.done} total={progress.total} label={`${progress.done}/${progress.total}`} />
      </div>
    )
  }

  const version = versions.find(entry => entry.label === lane.versionLabel)

  return (
    <div className="ben-wb__board-lanename" data-axis={axis}>
      <div className="ben-wb__lane-top">
        <button
          type="button"
          className="ben-wb__lane-title"
          aria-expanded={open}
          aria-label={`模块 ${lane.name}`}
          onClick={() => setOpen(value => !value)}
        >
          {lane.name}
        </button>
        {version !== undefined && (
          <span className="ben-wb__sprint-ver" title={`${version.label} ${version.version}`}>
            {version.label} {version.version}
          </span>
        )}
      </div>

      <Meter done={progress.done} total={progress.total} label={`${progress.done}/${progress.total}`} />

      {lane.goal === undefined || lane.goal === ''
        ? <em className="ben-wb__sprint-blank">还没写模块目标</em>
        : <span className="ben-wb__lane-goal" title={lane.goal}>{lane.goal}</span>}

      {open && (
        <div className="ben-wb__lane-editor">
          <input
            type="text"
            aria-label={`${lane.name} 改模块名`}
            value={name}
            onChange={event => setName(event.target.value)}
            onBlur={() => { if (name.trim() !== '' && name.trim() !== lane.name) onUpdate({ name: name.trim() }) }}
          />
          <textarea
            rows={2}
            aria-label={`${lane.name} 模块目标`}
            placeholder="这个模块在本次冲刺里要达成什么"
            value={goal}
            onChange={event => setGoal(event.target.value)}
            onBlur={() => {
              const next = goal.trim()
              if (next === (lane.goal ?? '')) return
              onUpdate({ goal: next === '' ? null : next })
            }}
          />
          <select
            aria-label={`${lane.name} 算哪条版本`}
            value={lane.versionLabel ?? ''}
            onChange={event => onUpdate({ versionLabel: event.target.value === '' ? null : event.target.value })}
          >
            <option value="">不指定版本</option>
            {versions.map(entry => (
              <option key={entry.label} value={entry.label}>{entry.label} {entry.version}</option>
            ))}
          </select>
          {versions.length === 0 && (
            <em className="ben-wb__sprint-blank">这个冲刺还没填组成版本号,先去冲刺条那里填</em>
          )}
          {confirmDelete
            ? (
                <>
                  <button type="button" className="ben-wb__task-del" aria-label={`${lane.name} 确定删模块`} onClick={onDelete}>
                    确定删?卡片会退回未归模块
                  </button>
                  <button type="button" onClick={() => setConfirmDelete(false)}>取消</button>
                </>
              )
            : (
                <button
                  type="button"
                  className="ben-wb__task-del"
                  aria-label={`${lane.name} 删掉模块`}
                  onClick={() => setConfirmDelete(true)}
                >
                  删掉模块
                </button>
              )}
        </div>
      )}
    </div>
  )
}

/**
 * 待办格底部那个输入框:回车即建卡,项目与模块自动带上所在的标签与泳道。
 * 「按状态」那个方向没有泳道,只带项目(label 那时是列名)。
 */
function NewTaskInput({ label, moduleId, projectId, onCreate }: {
  label: string
  moduleId: string | undefined
  projectId: string | undefined
  onCreate: (input: CreateTaskArgs) => void
}) {
  const [text, setText] = useState('')
  /**
   * 「当需求来办」(2026-09-22)。勾上建出来的是一张 `kind:'feature'` 的卡 ——
   * 打开它就是指挥台(梳理 → 拆解与派活 → 验收 → 记录)。
   *
   * **为什么要有这个勾而不是建完再改**:`/task/update` 故意不收 `kind`
   * (一条卡是不是需求由建它的时候决定,改它等于换一张卡)。而她不走命令行,
   * 所以建卡这一刻必须有一处能说出"这件事我要指挥着做"。默认不勾:
   * 看板上绝大多数卡仍然是普通事项,行为一字不变。
   */
  const [asFeature, setAsFeature] = useState(false)
  return (
    // ★ 那个勾**在 form 外面**:表单里只留那一个文本框,回车照样直接建卡
    //   (多一个字段就会挡掉浏览器的隐式提交 —— 她记一条从来都是打完按回车)。
    <div className="ben-wb__board-newrow">
      <form
        className="ben-wb__board-new"
        onSubmit={(event) => {
          event.preventDefault()
          if (text.trim() === '') return
          onCreate({
            title: text.trim(),
            ...(projectId === undefined ? {} : { projectId }),
            ...(moduleId === undefined ? {} : { moduleId }),
            ...(asFeature ? { kind: 'feature' as const } : {}),
          })
          setText('')
        }}
      >
        <input
          type="text"
          aria-label={`在 ${label} 记一条`}
          placeholder="记一条…"
          value={text}
          onChange={event => setText(event.target.value)}
        />
      </form>
      <label className="ben-wb__board-new-kind">
        <input
          type="checkbox"
          aria-label={`在 ${label} 当需求来办(卡上给指挥台)`}
          checked={asFeature}
          onChange={event => setAsFeature(event.target.checked)}
        />
        当需求办
      </label>
    </div>
  )
}

/**
 * 泳道列表底下那一行:给当前冲刺加一个模块。
 *
 * 2026-09-25(卡 N):平时收成一颗小按钮「＋ 新模块」(维护者嫌看板底下空着的那一大行),点了才展开输入框;
 * 回车建好、Esc 或点开别处(输入框空着)收回去。
 */
function NewModuleInput({ sprintId, onCreate }: {
  sprintId: string
  onCreate: (sprintId: string, name: string) => void
}) {
  const [text, setText] = useState('')
  const [open, setOpen] = useState(false)
  if (!open) {
    return (
      <div className="ben-wb__lane-new" data-collapsed="true">
        <button type="button" className="ben-wb__lane-new-btn" aria-label="给这个冲刺加一个模块" onClick={() => setOpen(true)}>＋ 新模块</button>
      </div>
    )
  }
  return (
    <form
      className="ben-wb__lane-new"
      onSubmit={(event) => {
        event.preventDefault()
        if (text.trim() === '') return
        onCreate(sprintId, text.trim())
        setText('')
        setOpen(false)
      }}
    >
      <input
        type="text"
        aria-label="给这个冲刺加一个模块"
        placeholder="新模块叫什么…"
        value={text}
        // eslint-disable-next-line jsx-a11y/no-autofocus -- 他刚点了「＋ 新模块」,就是要打字
        autoFocus
        onChange={event => setText(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Escape') { setText(''); setOpen(false) } }}
        onBlur={() => { if (text.trim() === '') setOpen(false) }}
      />
    </form>
  )
}

/** 看板动作里「现在到哪」那三颗;一颗都没接 → 缺席(那一块只读)。 */
function progressActionsOf(actions: BoardActions): ProgressActions | undefined {
  if (actions.checkProgress === undefined && actions.sayProgress === undefined && actions.driveTask === undefined) return undefined
  return {
    ...(actions.checkProgress === undefined ? {} : { check: actions.checkProgress }),
    ...(actions.sayProgress === undefined ? {} : { say: actions.sayProgress }),
    ...(actions.driveTask === undefined ? {} : { drive: actions.driveTask }),
  }
}
