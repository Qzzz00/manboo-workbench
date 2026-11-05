import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  BoardModule, ProjectBoardMeta, SessionView, SprintView, TaskView, WorkbenchLayout, WorkbenchProject,
} from '../src/protocol.ts'
import { TaskBoard, type BoardActions } from '../src/client/TaskBoard.tsx'
import {
  attentionCounts, buildLanes, buildProjectTabs, daysLeft, laneProgress, sprintProgress, tasksInCell, timeProgress,
} from '../src/client/boardModel.ts'
import { parseVersionLines } from '../src/client/SprintBar.tsx'
import { boardAxisOf, projectsViewOf, setBoardAxis, setProjectsView } from '../src/client/projectsView.ts'

afterEach(cleanup)

const AT = '2026-08-25T09:00:00.000Z'
/** 快照时刻。剩余天数/时间进度全按它算,不用 Date.now()——那样测试会随日子变红。 */
const NOW = '2026-08-25T17:00:00+08:00'

function task(over: Partial<TaskView> = {}): TaskView {
  return { id: 'a', title: '卡片甲', status: 'todo', source: { kind: 'manual' }, created_at: AT, updated_at: AT, ...over }
}

function project(id: string, name: string, over: Partial<WorkbenchProject> = {}): WorkbenchProject {
  return { id, name, stage: 'MVP 开发', links: [], session_count: 0, idle: false, ...over }
}

function sprint(over: Partial<SprintView> = {}): SprintView {
  return { id: 's1', project_id: 'p1', name: '冲刺一', versions: [], created_at: AT, updated_at: AT, ...over }
}

function boardModule(over: Partial<BoardModule> = {}): BoardModule {
  return { id: 'm1', sprint_id: 's1', name: '播放模块', created_at: AT, updated_at: AT, ...over }
}

function session(over: Partial<SessionView> = {}): SessionView {
  return {
    agent: 'codex', session_id: 's1', project: 'Aiboo', status: 'waiting',
    elapsed_sec: 60, unread: false, updated_at: AT, ...over,
  }
}

const PROJECTS = [project('p1', 'Aiboo'), project('p2', '工作台')]

function board(over: Partial<Parameters<typeof TaskBoard>[0]> = {}) {
  const actions = {
    createTask: vi.fn(), moveTask: vi.fn(), updateTask: vi.fn(), deleteTask: vi.fn(),
    createSprint: vi.fn(), updateSprint: vi.fn(), deleteSprint: vi.fn(),
    createModule: vi.fn(), updateModule: vi.fn(), deleteModule: vi.fn(),
    setProjectMeta: vi.fn(),
  } satisfies BoardActions
  const onAxisChange = vi.fn()
  render(
    <TaskBoard
      tasks={[]}
      sprints={[sprint()]}
      modules={[boardModule()]}
      projectMeta={[]}
      projects={PROJECTS}
      sessions={[]}
      now={NOW}
      axis="module-rows"
      onAxisChange={onAxisChange}
      actions={actions}
      {...over}
    />,
  )
  return Object.assign(actions, { onAxisChange })
}

/** 一个格子 = 一条模块泳道 × 一个状态。aria-label 是 `${模块} · ${状态}`。 */
function cell(lane: string, status: string): HTMLElement {
  return screen.getByLabelText(`${lane} · ${status}`)
}

const dt = () => ({
  data: {} as Record<string, string>,
  setData(k: string, v: string) { this.data[k] = v },
  getData(k: string) { return this.data[k] ?? '' },
})

describe('四层收敛:项目 → 冲刺 → 模块 → 功能点', () => {
  it('项目在顶部当标签,不再是左侧泳道', () => {
    board({ tasks: [task({ project_id: 'p1', module_id: 'm1' })] })
    const tabs = screen.getByRole('group', { name: '项目' })
    expect(within(tabs).getByRole('button', { name: /Aiboo/ })).toBeInTheDocument()
    expect(within(tabs).getByRole('button', { name: /工作台/ })).toBeInTheDocument()
    // 左侧那一列现在是模块,不是项目。
    expect(screen.queryByLabelText('Aiboo · 待办')).not.toBeInTheDocument()
    expect(cell('播放模块', '待办')).toBeInTheDocument()
  })

  it('横向泳道 = 选中冲刺下的模块,末尾固定一条「未归模块」', () => {
    expect(buildLanes([boardModule({ id: 'm1', name: '播放' }), boardModule({ id: 'm2', name: '登录' })], 's1')
      .map(lane => lane.name)).toEqual(['播放', '登录', '未归模块'])
  })

  it('另一个冲刺的模块不会串进来', () => {
    expect(buildLanes([boardModule({ id: 'm9', sprint_id: 's9', name: '别人的' })], 's1').map(lane => lane.name))
      .toEqual(['未归模块'])
  })

  it('竖列是七个状态,顺序固定:主干五个在前,阻塞/取消两条旁路在后', () => {
    board()
    expect(screen.getAllByText(/^(待排|待办|进行中|等我确认|完成|阻塞|取消)$/).map(node => node.textContent))
      .toEqual(['待排', '待办', '进行中', '等我确认', '完成', '阻塞', '取消'])
  })

  it('「等我确认」那一列是醒目的——它是唯一一列在等 Ben 动手', () => {
    board({ tasks: [task({ project_id: 'p1', module_id: 'm1' })] })
    expect(cell('播放模块', '等我确认')).toHaveAttribute('data-status', 'confirm')
    expect(screen.getByText('等我确认').closest('.ben-wb__board-colname'))
      .toHaveAttribute('data-attention', 'true')
  })

  it('卡片落在「所属模块 × 当前状态」那一格', () => {
    board({
      tasks: [
        task({ id: 'a', title: '甲', status: 'doing', project_id: 'p1', module_id: 'm1' }),
        task({ id: 'b', title: '乙', status: 'todo', project_id: 'p1' }),
      ],
    })
    expect(within(cell('播放模块', '进行中')).getByText('甲')).toBeInTheDocument()
    expect(within(cell('未归模块', '待办')).getByText('乙')).toBeInTheDocument()
  })

  it('每个紧凑格都给出所属模块与真实状态计数，其他项目不混入', () => {
    board({ tasks: [
      task({ id: 'a', status: 'doing', project_id: 'p1', module_id: 'm1' }),
      task({ id: 'b', status: 'doing', project_id: 'p1', module_id: 'm1' }),
      task({ id: 'c', status: 'doing', project_id: 'p2', module_id: 'm1' }),
    ] })
    expect(screen.getByLabelText('播放模块 · 进行中：2 件')).toHaveTextContent('2')
    expect(screen.getByLabelText('播放模块 · 等我确认：0 件')).toHaveTextContent('0')
    // 空的「未归模块」不画(2026-09-25 卡 N:「都没有内容为什么还要显示」)。
    expect(screen.queryByLabelText('未归模块 · 进行中：0 件')).not.toBeInTheDocument()
  })

  it('切项目就换一整块看板(标签是第一层)', async () => {
    const user = userEvent.setup()
    board({
      tasks: [
        task({ id: 'a', title: '甲', project_id: 'p1', module_id: 'm1' }),
        task({ id: 'b', title: '乙', project_id: 'p2' }),
      ],
    })
    expect(screen.getByText('甲')).toBeInTheDocument()
    expect(screen.queryByText('乙')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /工作台/ }))
    expect(screen.queryByText('甲')).not.toBeInTheDocument()
    expect(within(cell('未归模块', '待办')).getByText('乙')).toBeInTheDocument()
  })

  it('归属链断了的卡不会凭空消失,落进「未归模块」', () => {
    const orphan = task({ id: 'a', title: '孤儿', project_id: 'p1', module_id: '已经删掉的模块' })
    expect(tasksInCell([orphan], [boardModule()], 'p1', { id: undefined, name: '未归模块' }, 'todo'))
      .toEqual([orphan])
  })
})

describe('项目标签上的排期信息', () => {
  it('优先级/执行人/预期结束时间都上标签,不用点进去', () => {
    const tabs = buildProjectTabs(
      [project('p1', 'Aiboo', { ddl: { date: '2026-09-30', title: '上线' } })],
      [task({ project_id: 'p1' })],
      [{ project_id: 'p1', priority: 'high', assignee: 'codex' }] satisfies ProjectBoardMeta[],
    )
    expect(tabs[0]).toEqual({
      id: 'p1', name: 'Aiboo', priority: 'high', assignee: 'codex', due: '2026-09-30', count: 1,
    })
  })

  it('「未归项目」只在真有无主卡片时才占一格', () => {
    expect(buildProjectTabs(PROJECTS, [], []).map(tab => tab.name)).toEqual(['Aiboo', '工作台'])
    expect(buildProjectTabs(PROJECTS, [task({ id: 'x' })], []).map(tab => tab.name))
      .toEqual(['Aiboo', '工作台', '未归项目'])
  })

  it('项目设置默认收起，展开后负责人和优先级仍写入当前项目', async () => {
    const user = userEvent.setup()
    const actions = board()
    expect(screen.queryByRole('group', { name: 'Aiboo 优先级' })).not.toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'Aiboo 负责人' })).not.toBeInTheDocument()
    const settings = screen.getByRole('button', { name: '项目设置' })
    expect(settings).toHaveAttribute('aria-expanded', 'false')
    await user.click(settings)

    const prio = screen.getByRole('group', { name: 'Aiboo 优先级' })
    await user.click(within(prio).getByRole('button', { name: 'Aiboo 优先级 高' }))
    expect(actions.setProjectMeta).toHaveBeenCalledWith('p1', { priority: 'high' })

    const owner = screen.getByRole('group', { name: 'Aiboo 负责人' })
    await user.click(within(owner).getByRole('button', { name: 'Aiboo 负责人 Codex' }))
    expect(actions.setProjectMeta).toHaveBeenCalledWith('p1', { assignee: 'codex' })
    await user.click(settings)
    expect(screen.queryByRole('group', { name: 'Aiboo 负责人' })).not.toBeInTheDocument()
    await user.click(within(screen.getByRole('group', { name: '项目' })).getByRole('button', { name: /工作台/ }))
    await user.click(screen.getByRole('button', { name: '项目设置' }))
    await user.click(screen.getByRole('button', { name: '工作台 负责人 Claude' }))
    expect(actions.setProjectMeta).toHaveBeenCalledWith('p2', { assignee: 'claude' })
  })

  it('措辞是「负责人」不是「执行人」(Ben 2026-08-25 纠正)', () => {
    board()
    fireEvent.click(screen.getByRole('button', { name: '项目设置' }))
    expect(screen.getByRole('group', { name: 'Aiboo 负责人' })).toBeInTheDocument()
    expect(document.body.textContent ?? '').not.toContain('执行人')
  })

  it('项目的预期结束显示成剩余天数,只读,标明去总览改', () => {
    board({ projects: [project('p1', 'Aiboo', { ddl: { date: '2026-08-31', title: '上线' } }), PROJECTS[1] as WorkbenchProject] })
    fireEvent.click(screen.getByRole('button', { name: '项目设置' }))
    expect(screen.getAllByText('剩 6 天').length).toBeGreaterThan(0)
    expect(screen.getByText('(在总览里改)')).toBeInTheDocument()
  })
})

describe('冲刺那一层', () => {
  it('冲刺目标与组成版本号常显,不用点开', () => {
    board({
      sprints: [sprint({ goal: '把看板跑通', versions: [{ label: '客户端', version: 'V0.1' }, { label: '后端', version: 'V0.1' }] })],
    })
    expect(screen.getByText('把看板跑通')).toBeInTheDocument()
    expect(screen.getByText('客户端 V0.1')).toBeInTheDocument()
    expect(screen.getByText('后端 V0.1')).toBeInTheDocument()
  })

  it('没写目标就如实说「还没写」,不替他编一句', () => {
    board()
    expect(screen.getByText('还没写冲刺目标')).toBeInTheDocument()
    expect(screen.getByText('还没填版本号')).toBeInTheDocument()
  })

  it('没有冲刺时给一句人话 + 建冲刺入口', async () => {
    const user = userEvent.setup()
    const actions = board({ sprints: [], modules: [] })
    expect(screen.getByText(/还没有冲刺/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '＋ 新冲刺' }))
    await user.type(screen.getByLabelText('新冲刺的名字'), '冲刺一{Enter}')
    expect(actions.createSprint).toHaveBeenCalledWith('p1', '冲刺一')
  })

  it('多个冲刺可切换,泳道跟着换', async () => {
    const user = userEvent.setup()
    board({
      sprints: [sprint({ id: 's1', name: 'S1' }), sprint({ id: 's2', name: 'S2' })],
      modules: [boardModule({ id: 'm1', sprint_id: 's1', name: '播放' }), boardModule({ id: 'm2', sprint_id: 's2', name: '登录' })],
      tasks: [task({ id: 'a', project_id: 'p1', module_id: 'm1' }), task({ id: 'b', project_id: 'p1', module_id: 'm2' })],
    })
    expect(cell('播放', '待办')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'S2' }))
    expect(screen.queryByLabelText('播放 · 待办')).not.toBeInTheDocument()
    expect(cell('登录', '待办')).toBeInTheDocument()
  })

  it('编辑面能改目标与版本号', async () => {
    const user = userEvent.setup()
    const actions = board()
    await user.click(screen.getByLabelText('编辑冲刺 冲刺一'))

    await user.type(screen.getByLabelText('冲刺目标'), '把看板跑通')
    await user.tab()
    expect(actions.updateSprint).toHaveBeenCalledWith('s1', { goal: '把看板跑通' })

    await user.type(screen.getByLabelText('组成版本号'), '客户端 V0.1\n后端 V0.1')
    await user.tab()
    expect(actions.updateSprint).toHaveBeenCalledWith('s1', {
      versions: [{ label: '客户端', version: 'V0.1' }, { label: '后端', version: 'V0.1' }],
    })
  })

  it('版本号一行拆成「名字 + 版本」,最后一个空格之后是版本号', () => {
    // 标签本身可能带空格(「iOS 客户端」),所以按**最后一个**空格切,不是第一个。
    expect(parseVersionLines('客户端 V0.1\niOS 客户端 V0.2')).toEqual([
      { label: '客户端', version: 'V0.1' },
      { label: 'iOS 客户端', version: 'V0.2' },
    ])
  })

  it('版本号里空行与拆不出两半的行整行丢掉,不留读不懂的东西', () => {
    expect(parseVersionLines('\n  \n乱写的\n后端 V0.1')).toEqual([{ label: '后端', version: 'V0.1' }])
  })

  it('进度是纯计数,不做任何评价', () => {
    const modules = [boardModule({ id: 'm1' })]
    const tasks = [
      task({ id: 'a', project_id: 'p1', module_id: 'm1', status: 'done' }),
      task({ id: 'b', project_id: 'p1', module_id: 'm1', status: 'todo' }),
    ]
    expect(sprintProgress(tasks, modules, 'p1', 's1')).toEqual({ done: 1, total: 2 })
  })

  it('删冲刺要点两下,而且按钮上写明卡片会退回未归模块', async () => {
    const user = userEvent.setup()
    const actions = board()
    await user.click(screen.getByLabelText('编辑冲刺 冲刺一'))
    await user.click(screen.getByLabelText('删掉冲刺 冲刺一'))
    expect(actions.deleteSprint).not.toHaveBeenCalled()

    await user.click(screen.getByLabelText('确定删冲刺'))
    expect(actions.deleteSprint).toHaveBeenCalledWith('s1')
  })
})

describe('模块那一层', () => {
  it('泳道头显示模块目标;没写就如实说', () => {
    board({ modules: [boardModule({ goal: '能连播' })] })
    expect(screen.getByText('能连播')).toBeInTheDocument()

    cleanup()
    board()
    expect(screen.getByText('还没写模块目标')).toBeInTheDocument()
  })

  it('给当前冲刺加模块:平时收成一颗「＋ 新模块」,点了才展开输入框;Esc 收回', async () => {
    const user = userEvent.setup()
    const actions = board()
    expect(screen.queryByRole('textbox', { name: '给这个冲刺加一个模块' })).toBeNull()
    await user.click(screen.getByRole('button', { name: '给这个冲刺加一个模块' }))
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('textbox', { name: '给这个冲刺加一个模块' })).toBeNull()
    await user.click(screen.getByRole('button', { name: '给这个冲刺加一个模块' }))
    await user.type(screen.getByRole('textbox', { name: '给这个冲刺加一个模块' }), '登录模块{Enter}')
    expect(actions.createModule).toHaveBeenCalledWith('s1', '登录模块')
    expect(screen.getByRole('button', { name: '给这个冲刺加一个模块' })).toBeInTheDocument()
  })

  it('点开泳道头能改模块名与模块目标', async () => {
    const user = userEvent.setup()
    const actions = board()
    await user.click(screen.getByLabelText('模块 播放模块'))

    await user.type(screen.getByLabelText('播放模块 模块目标'), '能连播')
    await user.tab()
    expect(actions.updateModule).toHaveBeenCalledWith('m1', { goal: '能连播' })
  })

  it('删模块要点两下,按钮写明卡片会退回未归模块', async () => {
    const user = userEvent.setup()
    const actions = board()
    await user.click(screen.getByLabelText('模块 播放模块'))
    await user.click(screen.getByLabelText('播放模块 删掉模块'))
    expect(actions.deleteModule).not.toHaveBeenCalled()

    await user.click(screen.getByLabelText('播放模块 确定删模块'))
    expect(actions.deleteModule).toHaveBeenCalledWith('m1')
  })

  it('「未归模块」那条泳道没有改名/删除入口——它不是真模块', () => {
    board({ tasks: [task({ project_id: 'p1' })] })
    expect(screen.queryByLabelText('模块 未归模块')).not.toBeInTheDocument()
    expect(screen.getByText('还没归模块的卡')).toBeInTheDocument()
  })
})

describe('功能点:改状态', () => {
  it('左右拖拽改状态', () => {
    const actions = board({ tasks: [task({ id: 'a', project_id: 'p1', module_id: 'm1' })] })
    const card = document.querySelector('[data-task-id="a"]') as HTMLElement
    const dataTransfer = dt()
    fireEvent.dragStart(card, { dataTransfer })
    fireEvent.drop(cell('播放模块', '进行中'), { dataTransfer })
    expect(actions.moveTask).toHaveBeenCalledWith('a', 'doing', undefined)
  })

  it('拖进别的泳道 = 连模块归属一起改', () => {
    // 待办 → 等我确认走不通(转换表管着),所以这里拖去「进行中」——这条用例要验的是
    // "换泳道连模块归属一起改",不是状态机本身。
    const actions = board({ tasks: [task({ id: 'a', project_id: 'p1', module_id: 'm1' }), task({ id: 'x', project_id: 'p1' })] })
    const card = document.querySelector('[data-task-id="a"]') as HTMLElement
    const dataTransfer = dt()
    fireEvent.dragStart(card, { dataTransfer })
    fireEvent.drop(cell('未归模块', '进行中'), { dataTransfer })
    expect(actions.moveTask).toHaveBeenCalledWith('a', 'doing', null)
  })

  it('空的「未归模块」平时不画;拖着卡时收成一行当落点,放进去只换归属、状态不动', () => {
    const actions = board({ tasks: [task({ id: 'a', project_id: 'p1', module_id: 'm1' })] })
    expect(screen.queryByLabelText('未归模块 · 还没有卡')).not.toBeInTheDocument()
    const card = document.querySelector('[data-task-id="a"]') as HTMLElement
    const dataTransfer = dt()
    fireEvent.dragStart(card, { dataTransfer })
    fireEvent.drop(screen.getByLabelText('未归模块 · 还没有卡'), { dataTransfer })
    expect(actions.moveTask).toHaveBeenCalledWith('a', 'todo', null)
    expect(screen.queryByLabelText('未归模块 · 还没有卡')).not.toBeInTheDocument()
  })

  it('拖回原地不发请求', () => {
    const actions = board({ tasks: [task({ id: 'a', project_id: 'p1', module_id: 'm1' })] })
    const card = document.querySelector('[data-task-id="a"]') as HTMLElement
    const dataTransfer = dt()
    fireEvent.dragStart(card, { dataTransfer })
    fireEvent.drop(cell('播放模块', '待办'), { dataTransfer })
    expect(actions.moveTask).not.toHaveBeenCalled()
  })

  it('弹窗里那排状态格能改状态(比 ←/→ 直观:当前在哪一列是看得见的)', async () => {
    const user = userEvent.setup()
    const actions = board({
      tasks: [task({ id: 'a', title: '甲', status: 'doing', project_id: 'p1', module_id: 'm1' })],
    })
    await user.click(screen.getByRole('button', { name: '甲' }))

    const steps = screen.getByRole('group', { name: '状态' })
    expect(within(steps).getByRole('button', { name: '进行中' })).toHaveAttribute('aria-pressed', 'true')

    await user.click(within(steps).getByRole('button', { name: '等我确认' }))
    expect(actions.moveTask).toHaveBeenCalledWith('a', 'confirm')
  })
})

describe('功能点弹窗(Ben:就地展开"很反人类")', () => {
  it('点卡片开弹窗,看板本身一个输入框都不长出来', async () => {
    const user = userEvent.setup()
    board({ tasks: [task({ id: 'a', title: '甲', project_id: 'p1', module_id: 'm1' })] })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    // 卡片自己不含任何输入控件——那正是"反人类"的来源:打字时整块看板在动。
    // (格子底部那个「记一条」输入框是建卡入口,不属于卡片。)
    const card = document.querySelector('[data-task-id=a]') as HTMLElement
    expect(within(card).queryByRole('textbox')).not.toBeInTheDocument()
    expect(within(card).queryByRole('combobox')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '甲' }))
    expect(screen.getByRole('dialog', { name: '功能点 甲' })).toBeInTheDocument()
  })

  it('弹窗顶部说清"我在哪条泳道"——弹窗盖住看板之后没有别的线索', async () => {
    const user = userEvent.setup()
    board({ tasks: [task({ id: 'a', title: '甲', project_id: 'p1', module_id: 'm1' })] })
    await user.click(screen.getByRole('button', { name: '甲' }))
    expect(within(screen.getByRole('dialog')).getByText('播放模块')).toBeInTheDocument()
  })

  it('关窗三条路都通:✕ / 点遮罩 / Esc', async () => {
    const user = userEvent.setup()
    const open = async () => user.click(screen.getByRole('button', { name: '甲' }))
    board({ tasks: [task({ id: 'a', title: '甲', project_id: 'p1', module_id: 'm1' })] })

    await open()
    await user.click(screen.getByRole('button', { name: '关闭' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await open()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await open()
    fireEvent.click(document.querySelector('.ben-wb__dlg-scrim') as HTMLElement)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('点在弹窗内部不会关窗(在里面拖选文字松手时不该把刚打的字丢掉)', async () => {
    const user = userEvent.setup()
    board({ tasks: [task({ id: 'a', title: '甲', project_id: 'p1', module_id: 'm1' })] })
    await user.click(screen.getByRole('button', { name: '甲' }))

    fireEvent.click(screen.getByRole('dialog'))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('优先级与负责人是可点的色块,再点一下取消', async () => {
    const user = userEvent.setup()
    const actions = board({
      tasks: [task({ id: 'a', title: '甲', project_id: 'p1', module_id: 'm1', priority: 'high' })],
      // 负责人那一排里的几家 AI 从 Agent 登记表来(卡 Z:原来写死在 ASSIGNEE_PICKER 里)。
      agents: [
        { id: 'codex', bundle_id: 'com.openai.codex', name: 'Codex', found: { how: 'patrol', at: '', basis: '' }, sources: [], status: 'idle', gaps: {}, sessions: [], counts: { running: 0, waiting: 0, unread: 0 } },
      ],
    })
    await user.click(screen.getByRole('button', { name: '甲' }))
    const dialog = within(screen.getByRole('dialog'))

    await user.click(within(dialog.getByRole('group', { name: '优先级' })).getByRole('button', { name: '中' }))
    expect(actions.updateTask).toHaveBeenCalledWith('a', { priority: 'mid' })

    // 再点当前那档 = 取消,不必另设一个"未定"按钮。
    await user.click(within(dialog.getByRole('group', { name: '优先级' })).getByRole('button', { name: '高' }))
    expect(actions.updateTask).toHaveBeenCalledWith('a', { priority: null })

    await user.click(within(dialog.getByRole('group', { name: '负责人' })).getByRole('button', { name: 'Codex' }))
    expect(actions.updateTask).toHaveBeenCalledWith('a', { assignee: 'codex' })
  })

  it('改功能描述', async () => {
    const user = userEvent.setup()
    const actions = board({ tasks: [task({ id: 'a', title: '甲', project_id: 'p1', module_id: 'm1' })] })
    await user.click(screen.getByRole('button', { name: '甲' }))
    await user.type(screen.getByLabelText('功能描述'), '播完一首自动下一首')
    await user.tab()
    expect(actions.updateTask).toHaveBeenCalledWith('a', { desc: '播完一首自动下一首' })
  })

  it('删卡还是点两下,删完弹窗自己关掉', async () => {
    const user = userEvent.setup()
    const actions = board({ tasks: [task({ id: 'a', title: '甲', project_id: 'p1', module_id: 'm1' })] })
    await user.click(screen.getByRole('button', { name: '甲' }))

    await user.click(screen.getByRole('button', { name: '删掉' }))
    expect(actions.deleteTask).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: '确定删' }))
    expect(actions.deleteTask).toHaveBeenCalledWith('a')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})

describe('关联窗口(一个功能点可以有多个任务 ID、跨多家 Agent)', () => {
  const linked = task({
    id: 'a', title: '甲', status: 'doing', project_id: 'p1', module_id: 'm1',
    links: [
      { agent: 'codex', session_id: 'sess-1' },
      { agent: 'claude', session_id: 'sess-2' },
    ],
  })

  it('卡面上一个窗口一个状态点,不用点开就知道有没有人在跑', () => {
    board({ tasks: [linked], sessions: [session({ agent: 'codex', session_id: 'sess-1', status: 'running' })] })
    const dots = within(cell('播放模块', '进行中')).getByLabelText('关联 2 个窗口')
    expect(dots.querySelectorAll('[data-status=running]')).toHaveLength(1)
    // 交接走了的那条会话已经不在 sessions 里,如实显示成灰点,不假装还活着。
    expect(dots.querySelectorAll('[data-status=gone]')).toHaveLength(1)
  })

  it('弹窗里逐条列出:哪家、什么 ID、现在什么状态', async () => {
    const user = userEvent.setup()
    board({ tasks: [linked], sessions: [session({ agent: 'codex', session_id: 'sess-1', status: 'waiting' })] })
    await user.click(screen.getByRole('button', { name: '甲' }))

    const dialog = within(screen.getByRole('dialog'))
    expect(dialog.getByText('sess-1')).toBeInTheDocument()
    expect(dialog.getByText('等你确认')).toBeInTheDocument()
    // 状态是现查 sessions 的,查不到就如实说,不落盘一个会漂移的状态。
    expect(dialog.getByText('已结束 / 查不到')).toBeInTheDocument()
  })

  it('关联一个新窗口 = 原来那几条 + 新的一条(整组给回来)', async () => {
    const user = userEvent.setup()
    const actions = board({
      tasks: [linked],
      sessions: [session({ agent: 'kimi', session_id: 'sess-9', title: '接手的那个' })],
    })
    await user.click(screen.getByRole('button', { name: '甲' }))
    await user.click(screen.getByRole('button', { name: /关联一个窗口/ }))
    await user.selectOptions(screen.getByLabelText('挑一个窗口关联上来'), 'kimi:sess-9')

    expect(actions.updateTask).toHaveBeenCalledWith('a', {
      links: [
        { agent: 'codex', session_id: 'sess-1' },
        { agent: 'claude', session_id: 'sess-2' },
        { agent: 'kimi', session_id: 'sess-9' },
      ],
    })
  })

  it('解除关联只去掉那一条', async () => {
    const user = userEvent.setup()
    const actions = board({ tasks: [linked] })
    await user.click(screen.getByRole('button', { name: '甲' }))
    await user.click(screen.getByLabelText('解除关联 sess-1'))
    expect(actions.updateTask).toHaveBeenCalledWith('a', { links: [{ agent: 'claude', session_id: 'sess-2' }] })
  })

  it('已经关联上的窗口不会在挑选列表里重复出现', async () => {
    const user = userEvent.setup()
    board({ tasks: [linked], sessions: [session({ agent: 'codex', session_id: 'sess-1' })] })
    await user.click(screen.getByRole('button', { name: '甲' }))
    // 唯一那条会话已经关联过了,没有可加的,按钮禁用。
    expect(screen.getByRole('button', { name: /关联一个窗口/ })).toBeDisabled()
  })
})

describe('功能点:建卡、字段与转卡', () => {
  it('在某条模块泳道的待办格记一条 → 项目与模块自动带上', async () => {
    const user = userEvent.setup()
    const actions = board()
    await user.type(screen.getByLabelText('在 播放模块 记一条'), '连播{Enter}')
    expect(actions.createTask).toHaveBeenCalledWith({ title: '连播', projectId: 'p1', moduleId: 'm1' })
  })

  it('未归模块那条泳道建的卡只带项目', async () => {
    const user = userEvent.setup()
    const actions = board({ tasks: [task({ id: 'x', project_id: 'p1' })] })
    await user.type(screen.getByLabelText('在 未归模块 记一条'), '先记一条{Enter}')
    expect(actions.createTask).toHaveBeenCalledWith({ title: '先记一条', projectId: 'p1' })
  })

  it('卡面上直接看得到负责人与剩余天数,优先级是左边那条色边', () => {
    board({
      tasks: [task({
        id: 'a', title: '甲', project_id: 'p1', module_id: 'm1',
        priority: 'high', assignee: 'codex', due: '2026-08-31',
      })],
    })
    const cardCell = cell('播放模块', '待办')
    expect(within(cardCell).getByText('Codex')).toBeInTheDocument()
    // 裸日期要心算,"剩 6 天"不用。
    expect(within(cardCell).getByText('剩 6 天')).toBeInTheDocument()
    expect(cardCell.querySelector('[data-task-id=a]')).toHaveAttribute('data-priority', 'high')
  })

  it('过了预期结束时间就说"晚了 N 天",但只变色不评价——不提推迟也不提删', () => {
    board({
      tasks: [task({ id: 'a', title: '甲', project_id: 'p1', module_id: 'm1', due: '2026-08-20' })],
    })
    expect(within(cell('播放模块', '待办')).getByText('晚了 5 天')).toBeInTheDocument()
    for (const phrase of ['推迟', '要不要', '建议']) {
      expect(document.body.textContent ?? '').not.toContain(phrase)
    }
  })

  it('会话一键转卡:标题取会话标题,项目取当前标签', async () => {
    const user = userEvent.setup()
    const actions = board({ sessions: [session({ title: '在改额度采集', session_id: 's9' })] })
    await user.click(screen.getByRole('button', { name: '从会话转卡' }))
    await user.click(screen.getByRole('button', { name: '在改额度采集' }))
    expect(actions.createTask).toHaveBeenCalledWith({
      title: '在改额度采集', projectId: 'p1', source: { kind: 'session', ref: 's9' },
    })
  })

  it('会话不会自己变成卡片(确认列只放 Ben 自己的卡)', () => {
    board({ sessions: [session({ title: '在等你确认' })], tasks: [task({ project_id: 'p1', module_id: 'm1' })] })
    expect(within(cell('播放模块', '等我确认')).queryByText('在等你确认')).not.toBeInTheDocument()
  })
})

describe('完成列:每条泳道只展最近几张', () => {
  const many = Array.from({ length: 6 }, (_, i) => task({
    id: `d${i}`, title: `完成${i}`, status: 'done', project_id: 'p1', module_id: 'm1',
    updated_at: `2026-08-${String(10 + i).padStart(2, '0')}T09:00:00.000Z`,
  }))

  it('默认铺最近 3 张,其余折成一行写明确切张数', () => {
    board({ tasks: many })
    const done = cell('播放模块', '完成')
    expect(within(done).getAllByRole('article').map(node => node.textContent)).toEqual(['完成5', '完成4', '完成3'])
    expect(within(done).getByRole('button', { name: '更早 · 3 张' })).toBeInTheDocument()
  })

  it('点开就是全部,一张不少', async () => {
    const user = userEvent.setup()
    board({ tasks: many })
    await user.click(screen.getByRole('button', { name: '更早 · 3 张' }))
    expect(within(cell('播放模块', '完成')).getAllByRole('article')).toHaveLength(6)
  })

  it('列头计数是本项目全部,不是折起来那几张', () => {
    board({ tasks: many })
    const doneColumn = screen.getByText('完成').parentElement as HTMLElement
    expect(doneColumn.querySelector('.ben-wb__board-count')?.textContent).toBe('6')
  })
})

describe('改标题', () => {
  it('在弹窗里改完标题,失焦才提交', async () => {
    const user = userEvent.setup()
    const actions = board({ tasks: [task({ id: 'a', title: '甲', project_id: 'p1', module_id: 'm1' })] })
    await user.click(screen.getByRole('button', { name: '甲' }))

    const input = screen.getByLabelText('标题')
    await user.clear(input)
    await user.type(input, '甲改过了')
    // 还没失焦,一条都不该发——每敲一个字打一次服务端是另一种"反人类"。
    expect(actions.updateTask).not.toHaveBeenCalled()

    await user.tab()
    expect(actions.updateTask).toHaveBeenCalledWith('a', { title: '甲改过了' })
  })

  it('没改动就失焦,不打请求', async () => {
    const user = userEvent.setup()
    const actions = board({ tasks: [task({ id: 'a', title: '甲', project_id: 'p1', module_id: 'm1' })] })
    await user.click(screen.getByRole('button', { name: '甲' }))

    await user.click(screen.getByLabelText('标题'))
    await user.tab()
    expect(actions.updateTask).not.toHaveBeenCalled()
  })

  it('标题清空后失焦不提交——不留一张看不出是什么的卡', async () => {
    const user = userEvent.setup()
    const actions = board({ tasks: [task({ id: 'a', title: '甲', project_id: 'p1', module_id: 'm1' })] })
    await user.click(screen.getByRole('button', { name: '甲' }))

    await user.clear(screen.getByLabelText('标题'))
    await user.tab()
    expect(actions.updateTask).not.toHaveBeenCalled()
  })
})

/**
 * 不可改清单第 5 条的延伸约束(PRD §9,设计稿 §3.5):看板不得出现任何
 * "这条很久没动,要不要删/归档"式的自动清理提议。这里查的是**渲染出来的全部文字**。
 */
describe('不可改清单第 5 条延伸:看板不提任何清理建议', () => {
  it('放了一堆陈年老卡,界面上也没有一句清理提议', () => {
    board({
      tasks: [
        task({ id: 'old', title: '一年没动的', project_id: 'p1', module_id: 'm1', updated_at: '2025-01-01T00:00:00.000Z' }),
        ...Array.from({ length: 8 }, (_, i) => task({
          id: `d${i}`, title: `完成${i}`, status: 'done', project_id: 'p1', module_id: 'm1',
        })),
      ],
    })
    const text = document.body.textContent ?? ''
    for (const phrase of ['归档', '清理', '很久没动', '要不要删', '过期', '陈旧', '整理一下']) {
      expect(text).not.toContain(phrase)
    }
  })

  it('看板本身一个「删」字都没有;删卡的入口只在弹窗里,而且要点两下', async () => {
    const user = userEvent.setup()
    board({ tasks: [task({ id: 'a', title: '甲', project_id: 'p1', module_id: 'm1' })] })
    expect(document.body.textContent ?? '').not.toContain('删')

    await user.click(screen.getByRole('button', { name: '甲' }))
    expect(within(screen.getByRole('dialog')).getAllByRole('button')
      .filter(node => (node.textContent ?? '').includes('删'))
      .map(node => node.textContent)).toEqual(['删掉'])
  })
})

describe('总览 ⇄ 看板 的布局换算', () => {
  /** 与 main 的 DEFAULT_LAYOUT 同形:顶部行左列项目区,右列消耗数据 + 余额上下摞。 */
  const layout: WorkbenchLayout = {
    modules: [
      { id: 'projects', order: 0, basis_pct: 34, row: 0, col: 0, width_pct: 60 },
      { id: 'usage', order: 1, basis_pct: 22, row: 0, col: 1, width_pct: 40 },
      { id: 'quota', order: 2, basis_pct: 12, row: 0, col: 1, width_pct: 40 },
      { id: 'slot', order: 3, basis_pct: 54, row: 1 },
    ],
    butler: { corner: 'br', min: false },
  }

  it('缺省是总览——旧存档读进来与从前一致', () => {
    expect(projectsViewOf(layout)).toBe('overview')
  })

  it('切到看板:只翻 projects_view,一个模块都不碰(2026-08-26 Ben 反馈后改的语义)', () => {
    const next = setProjectsView(layout, 'board')
    expect(next.projects_view).toBe('board')
    expect(next.modules).toEqual(layout.modules)
    expect(next.butler).toEqual(layout.butler)
  })

  it('切回总览同理:除了那个字段,布局逐字不变', () => {
    const back = setProjectsView(setProjectsView(layout, 'board'), 'overview')
    expect(back.projects_view).toBe('overview')
    expect(back.modules).toEqual(layout.modules)
  })

  /**
   * Ben 报的原话:"我点击余额和消耗数据是能够把自己拉回来的,但是每次切换总览和看板
   * 都要这样来一次……很废人。" 收起是持久化的,他手动展开回来之后不该被下一次切换再收掉。
   */
  it('他手动展开回来的邻居,再切一次不会被重新收起(回归)', () => {
    const restored: WorkbenchLayout = {
      ...layout,
      projects_view: 'board',
      modules: layout.modules.map(module => (
        module.id === 'usage' || module.id === 'quota' ? { ...module, hidden: false } : module
      )),
    }
    const again = setProjectsView(setProjectsView(restored, 'overview'), 'board')
    expect(again.modules.find(module => module.id === 'usage')?.hidden).toBe(false)
    expect(again.modules.find(module => module.id === 'quota')?.hidden).toBe(false)
  })

  it('不改顺序,也不碰别的行', () => {
    const next = setProjectsView(layout, 'board')
    expect(next.modules.map(module => module.id)).toEqual(['projects', 'usage', 'quota', 'slot'])
    expect(next.modules.find(module => module.id === 'slot')).toEqual(layout.modules[3])
  })
})

describe('横排 / 竖排(2026-08-25 Ben:"任务卡片可以有横排和竖排的切换")', () => {
  const twoModules = [
    boardModule({ id: 'm1', name: '播放模块' }),
    boardModule({ id: 'm2', name: '登录模块' }),
  ]
  const cards = [
    task({ id: 'a', title: '甲', status: 'doing', project_id: 'p1', module_id: 'm1' }),
    task({ id: 'b', title: '乙', status: 'todo', project_id: 'p1', module_id: 'm2' }),
  ]

  it('缺省是横排——旧存档读进来与从前一致', () => {
    expect(boardAxisOf({ modules: [], butler: { corner: 'br', min: false } })).toBe('module-rows')
  })

  it('切方向只动 board_axis 一个字段,不碰模块显隐与宽高', () => {
    const layout: WorkbenchLayout = {
      modules: [{ id: 'projects', order: 0, row: 0, width_pct: 60 }, { id: 'usage', order: 1, row: 0, hidden: true }],
      butler: { corner: 'br', min: false },
      projects_view: 'board',
    }
    const next = setBoardAxis(layout, 'module-columns')
    expect(next.board_axis).toBe('module-columns')
    expect(next.modules).toEqual(layout.modules)
    expect(next.projects_view).toBe('board')
  })

  it('点「竖排」把方向报上去', async () => {
    const user = userEvent.setup()
    const actions = board()
    await user.click(within(screen.getByRole('group', { name: '卡片排布方向' })).getByRole('button', { name: '竖排' }))
    expect(actions.onAxisChange).toHaveBeenCalledWith('module-columns')
  })

  it('两个方向下格子完全一样多,而且每一格还是「那个模块 × 那个状态」', () => {
    board({ modules: twoModules, tasks: cards })
    // 横排:2 条泳道(两个模块;空的未归模块不画 —— 2026-09-25 卡 N)× 7 个状态
    const rowsCells = document.querySelectorAll('.ben-wb__board-cell').length
    expect(rowsCells).toBe(14)
    expect(within(cell('播放模块', '进行中')).getByText('甲')).toBeInTheDocument()

    cleanup()
    board({ modules: twoModules, tasks: cards, axis: 'module-columns' })
    expect(document.querySelectorAll('.ben-wb__board-cell')).toHaveLength(14)
    // 同一个格子的可访问名不变——换的是摆法,不是"哪张卡属于哪一格"。
    expect(within(cell('播放模块', '进行中')).getByText('甲')).toBeInTheDocument()
    expect(within(cell('登录模块', '待办')).getByText('乙')).toBeInTheDocument()
  })

  it('竖排时模块名在最上面一行当列头,状态名成了每一行的行头', () => {
    board({ modules: twoModules, axis: 'module-columns' })
    const head = document.querySelector('.ben-wb__board-head') as HTMLElement
    expect(within(head).getByRole('button', { name: '模块 播放模块' })).toBeInTheDocument()
    expect(within(head).getByRole('button', { name: '模块 登录模块' })).toBeInTheDocument()
    // 状态名不在表头里了,它们下沉成了行头。
    expect(within(head).queryByText('待办')).not.toBeInTheDocument()
    expect(screen.getByText('待办')).toBeInTheDocument()
  })

  it('竖排下拖拽照常:落进哪一格就是哪个模块 + 哪个状态(改状态变成上下拖)', () => {
    const actions = board({ modules: twoModules, tasks: cards, axis: 'module-columns' })
    const card = document.querySelector('[data-task-id=a]') as HTMLElement
    const dataTransfer = dt()
    fireEvent.dragStart(card, { dataTransfer })
    fireEvent.drop(cell('播放模块', '完成'), { dataTransfer })
    expect(actions.moveTask).toHaveBeenCalledWith('a', 'done', undefined)
  })

  it('竖排下建卡入口仍在每个模块的「待办」格里', async () => {
    const user = userEvent.setup()
    const actions = board({ modules: twoModules, axis: 'module-columns' })
    await user.type(screen.getByLabelText('在 登录模块 记一条'), '新的{Enter}')
    expect(actions.createTask).toHaveBeenCalledWith({ title: '新的', projectId: 'p1', moduleId: 'm2' })
  })
})

describe('排版尺度(Ben:"不是颜色的丰富度,而是字号和各区域的大小")', () => {
  it('原看板基础层仍使用五档变量；已批准的内部编排层可重设阅读字号', async () => {
    const { STYLE } = await import('../src/client/style.ts')
    const { COMPOSITION_STYLE } = await import('../src/client/composition.ts')
    const board = STYLE.slice(STYLE.indexOf('── 任务看板'), STYLE.indexOf(COMPOSITION_STYLE))
    // 硬编的 px 字号只允许出现在弹窗那一段(它比看板整体大一档,是另一个尺度)。
    const hardCoded = [...board.matchAll(/([\w.#>\[\]=:\-,\s]+)\{[^}]*font-size:(\d+(?:\.\d+)?)px/g)]
      .filter(match => !match[1]?.includes('__dlg'))
      .map(match => `${match[1]?.trim().split('\n').pop()} → ${match[2]}px`)
    expect(hardCoded).toEqual([])
  })

  it('五档字号确实拉开了差距(最大 / 最小 ≥ 1.4 倍)', async () => {
    const { STYLE } = await import('../src/client/style.ts')
    const scale = [...STYLE.matchAll(/--wb-t\d:(\d+(?:\.\d+)?)px/g)].map(match => Number(match[1]))
    expect(scale).toHaveLength(5)
    expect(Math.max(...scale) / Math.min(...scale)).toBeGreaterThanOrEqual(1.4)
  })
})

/**
 * 2026-08-25 实测踩过的坑,值得一条测试钉住。
 *
 * 基础样式里有一条 `.ben-wb button{font:inherit}`(特异度 0,1,1)。看板里大量元素本身
 * 就是 <button>(项目标签、模块名、卡片标题、优先级色块…),它们的样式如果写成单类
 * 选择器(0,1,0),`font` 简写会把 font-size 一并重置回继承值——**字号表定好了却完全
 * 不生效**,页面看着"好像有层级"其实全靠字重撑,而且这种失效不会报任何错。
 *
 * 修法是给这些规则加 `.ben-wb ` 祖先前缀抬到 (0,2,0)。这条测试守着"别再写回单类"。
 */
describe('按钮类的字号不能被基础样式的 font:inherit 打回去', () => {
  /** 渲染出来是 <button> 的看板类。加新按钮时要同步加进来。 */
  const BUTTON_CLASSES = [
    'ben-wb__ptab', 'ben-wb__chip', 'ben-wb__sprint-edit', 'ben-wb__lane-title',
    'ben-wb__board-more', 'ben-wb__board-pick', 'ben-wb__task-title', 'ben-wb__task-del',
    'ben-wb__dlg-addlink', 'ben-wb__dlg-close',
    // 2026-09-09 交付物与费用新加的两个按钮。
    'ben-wb__deliv-hint', 'ben-wb__board-assign',
  ]

  it('每条按钮类规则都带祖先前缀,特异度压得过 .ben-wb button', async () => {
    const { STYLE } = await import('../src/client/style.ts')
    // 行首直接是 `.ben-wb__xxx{` 就是裸单类选择器,会输给 .ben-wb button。
    const bare = BUTTON_CLASSES.filter(cls => new RegExp(`^\\.${cls}[{:\\[]`, 'm').test(STYLE))
    expect(bare).toEqual([])
  })

  it('那条基础规则还在(前提没变,这条守卫才有意义)', async () => {
    const { STYLE } = await import('../src/client/style.ts')
    expect(STYLE).toContain('.ben-wb button{font:inherit}')
  })
})

/**
 * 任务状态机上屏(2026-09-09,借 DSH-taskboard 的七态语义;插件不装、代码不抄)。
 * **本期只做人手拖动/点按改状态**——「agent 认领并干」不在本期(那是「写入=派活」,
 * 要先改 PRD §7.4,见 docs/决策记录.md 2026-09-09)。
 */
describe('七态:阻塞与取消两条旁路', () => {
  it('卡片落进阻塞列与取消列,和进行中分得开', () => {
    board({
      tasks: [
        task({ id: 'a', title: '卡住了', status: 'blocked', project_id: 'p1', module_id: 'm1' }),
        task({ id: 'b', title: '不做了', status: 'canceled', project_id: 'p1', module_id: 'm1' }),
        task({ id: 'c', title: '在做', status: 'doing', project_id: 'p1', module_id: 'm1' }),
      ],
    })
    expect(within(cell('播放模块', '阻塞')).getByText('卡住了')).toBeInTheDocument()
    expect(within(cell('播放模块', '取消')).getByText('不做了')).toBeInTheDocument()
    expect(within(cell('播放模块', '进行中')).getAllByRole('article')).toHaveLength(1)
  })

  it('卡面带上自己的状态,阻塞与等我确认在一眼扫过去时跳得出来', () => {
    board({ tasks: [task({ id: 'a', title: '卡住了', status: 'blocked', project_id: 'p1', module_id: 'm1' })] })
    expect(within(cell('播放模块', '阻塞')).getByRole('article')).toHaveAttribute('data-status', 'blocked')
  })

  it('取消的卡还在看板上——「不做了」不是「被系统扔了」', () => {
    board({ tasks: [task({ id: 'b', title: '不做了', status: 'canceled', project_id: 'p1', module_id: 'm1' })] })
    expect(screen.getByText('不做了')).toBeInTheDocument()
  })

  it('拖进阻塞列 = 改状态,和别的列逐字同一条路径', () => {
    const actions = board({
      tasks: [task({ id: 'a', title: '甲', status: 'doing', project_id: 'p1', module_id: 'm1' })],
    })
    const dataTransfer = dt()
    dataTransfer.setData('text/plain', 'a')
    fireEvent.drop(cell('播放模块', '阻塞'), { dataTransfer })
    expect(actions.moveTask).toHaveBeenCalledWith('a', 'blocked', undefined)
  })

  it('走不通的那一步不发请求——转换表在客户端也拦一道,不靠服务端回一句红字', () => {
    const actions = board({
      tasks: [task({ id: 'a', title: '甲', status: 'todo', project_id: 'p1', module_id: 'm1' })],
    })
    const dataTransfer = dt()
    dataTransfer.setData('text/plain', 'a')
    fireEvent.drop(cell('播放模块', '完成'), { dataTransfer })
    expect(actions.moveTask).not.toHaveBeenCalled()
  })

  it('弹窗里去不了的那几格置灰,并写明为什么(D13:拒绝要说原因)', async () => {
    const user = userEvent.setup()
    board({ tasks: [task({ id: 'a', title: '甲', status: 'todo', project_id: 'p1', module_id: 'm1' })] })
    await user.click(screen.getByRole('button', { name: '甲' }))
    const steps = screen.getByRole('group', { name: '状态' })

    expect(within(steps).getByRole('button', { name: '进行中' })).toBeEnabled()
    const done = within(steps).getByRole('button', { name: '完成' })
    expect(done).toBeDisabled()
    expect(done).toHaveAttribute('title', expect.stringContaining('不能直接改成'))
  })
})

describe('冲刺条:等我确认与阻塞的条数常显', () => {
  // 2026-10-26(卡「事务官页接管队列」):「等我确认」只数带四类拍板请求的。
  const ask = { kind: 'spend' as const, proposal: '买这个', basis: '核过的事实', by: 'butler', at: AT }
  const tasks = [
    task({ id: 'a', title: '甲', status: 'confirm', project_id: 'p1', module_id: 'm1', owner_ask: ask }),
    task({ id: 'b', title: '乙', status: 'confirm', project_id: 'p1', module_id: 'm1', owner_ask: ask }),
    task({ id: 'c', title: '丙', status: 'blocked', project_id: 'p1', module_id: 'm1' }),
  ]

  it('冲刺条上直接写着「等我确认 2」「阻塞 1」——不用点进哪一列去数', () => {
    board({ tasks })
    const bar = screen.getByLabelText('本冲刺待办事项')
    expect(bar.textContent).toContain('等我确认 2')
    expect(bar.textContent).toContain('阻塞 1')
  })

  it('「等我确认」但没标四类拍板请求的,不进这个数(事务官待核验队列,不摊给他)', () => {
    board({ tasks: [task({ id: 'a', title: '甲', status: 'confirm', project_id: 'p1', module_id: 'm1' }), task({ id: 'c', title: '丙', status: 'blocked', project_id: 'p1', module_id: 'm1' })] })
    const bar = screen.getByLabelText('本冲刺待办事项')
    expect(bar.textContent).not.toContain('等我确认')
    expect(bar.textContent).toContain('阻塞 1')
  })

  it('都是 0 就整条不显示,不占地方也不写「阻塞 0」', () => {
    board({ tasks: [task({ id: 'a', title: '甲', status: 'doing', project_id: 'p1', module_id: 'm1' })] })
    expect(screen.queryByLabelText('本冲刺待办事项')).not.toBeInTheDocument()
  })

  it('取消掉的卡不进冲刺进度的分母——不做了的事不该拉低完成率', () => {
    const scoped = [
      task({ id: 'a', status: 'done', project_id: 'p1', module_id: 'm1' }),
      task({ id: 'b', status: 'canceled', project_id: 'p1', module_id: 'm1' }),
      task({ id: 'c', status: 'todo', project_id: 'p1', module_id: 'm1' }),
    ]
    expect(sprintProgress(scoped, [boardModule()], 'p1', 's1')).toEqual({ done: 1, total: 2 })
    expect(laneProgress(scoped, [boardModule()], 'p1', { id: 'm1', name: '播放模块' })).toEqual({ done: 1, total: 2 })
  })
})

describe('第三种列轴:按任务状态(不分模块泳道)', () => {
  const tasks = [
    task({ id: 'a', title: '甲', status: 'doing', project_id: 'p1', module_id: 'm1' }),
    task({ id: 'b', title: '乙', status: 'doing', project_id: 'p1' }),
  ]

  it('缺省仍是横排;三个方向按钮都在', () => {
    board()
    const group = screen.getByRole('group', { name: '卡片排布方向' })
    expect(within(group).getAllByRole('button').map(node => node.textContent))
      .toEqual(['横排', '竖排', '按状态'])
  })

  it('切到「按状态」写进 layout(落盘字段扩的那个取值)', async () => {
    const user = userEvent.setup()
    const actions = board()
    await user.click(within(screen.getByRole('group', { name: '卡片排布方向' })).getByRole('button', { name: '按状态' }))
    expect(actions.onAxisChange).toHaveBeenCalledWith('status-columns')
  })

  it('按状态摆时不同模块的卡并进同一列——这一屏回答的是「现在各状态各有几件」', () => {
    board({ tasks, axis: 'status-columns' })
    const doing = screen.getByLabelText('按状态 · 进行中')
    expect(within(doing).getAllByRole('article').map(node => node.textContent?.slice(0, 1))).toEqual(['甲', '乙'])
    // 模块泳道整条不出现——它在这个方向上没有意义。
    expect(screen.queryByLabelText('播放模块 · 进行中')).not.toBeInTheDocument()
  })

  it('按状态摆时拖动只改状态,不动模块归属', () => {
    const actions = board({ tasks, axis: 'status-columns' })
    const dataTransfer = dt()
    dataTransfer.setData('text/plain', 'a')
    fireEvent.drop(screen.getByLabelText('按状态 · 等我确认'), { dataTransfer })
    expect(actions.moveTask).toHaveBeenCalledWith('a', 'confirm')
  })

  it('按状态摆时也能记一条,只带项目不带模块', async () => {
    const user = userEvent.setup()
    const actions = board({ tasks, axis: 'status-columns' })
    await user.type(screen.getByLabelText('在 待办 记一条'), '新的一条{Enter}')
    expect(actions.createTask).toHaveBeenCalledWith({ title: '新的一条', projectId: 'p1' })
  })

  it('boardAxisOf 认得第三个取值;认不出的值退回横排(旧存档/写坏都不炸)', () => {
    expect(boardAxisOf({ modules: [], butler: { corner: 'br', min: false }, board_axis: 'status-columns' }))
      .toBe('status-columns')
    expect(setBoardAxis({ modules: [], butler: { corner: 'br', min: false } }, 'status-columns').board_axis)
      .toBe('status-columns')
  })
})

/**
 * 「阻塞」列的卡可挂一个原因(2026-09-09 傍晚拍板第 4 条),在弹窗里选,
 * 用的是会话等待原因**同一套四个 id**(等审批 / 等你输入 / 额度不足 / 出错)。
 */
describe('阻塞原因', () => {
  it('阻塞的卡:弹窗里有一排四个原因色块,点一下挂上,再点一下清掉', async () => {
    const user = userEvent.setup()
    const actions = board({
      tasks: [task({ id: 'a', title: '甲', status: 'blocked', block_reason: 'quota', project_id: 'p1', module_id: 'm1' })],
    })
    await user.click(screen.getByRole('button', { name: '甲' }))

    const group = screen.getByRole('group', { name: '阻塞原因' })
    expect(within(group).getAllByRole('button').map(b => b.textContent)).toEqual(['等审批', '等你输入', '额度不足', '出错'])
    expect(within(group).getByRole('button', { name: '额度不足' })).toHaveAttribute('aria-pressed', 'true')

    await user.click(within(group).getByRole('button', { name: '等审批' }))
    expect(actions.updateTask).toHaveBeenCalledWith('a', { block_reason: 'approval' })

    await user.click(within(group).getByRole('button', { name: '额度不足' }))
    expect(actions.updateTask).toHaveBeenCalledWith('a', { block_reason: null })
  })

  it('不在阻塞列的卡,弹窗里没有这一排——原因只对「卡住」有意义', async () => {
    const user = userEvent.setup()
    board({ tasks: [task({ id: 'a', title: '甲', status: 'doing', project_id: 'p1', module_id: 'm1' })] })
    await user.click(screen.getByRole('button', { name: '甲' }))
    expect(screen.queryByRole('group', { name: '阻塞原因' })).not.toBeInTheDocument()
  })

  it('卡面上把原因标出来,扫一列就知道各自卡在哪;没挂原因的阻塞卡不标', () => {
    board({
      tasks: [
        task({ id: 'a', title: '甲', status: 'blocked', block_reason: 'approval', project_id: 'p1', module_id: 'm1' }),
        task({ id: 'b', title: '乙', status: 'blocked', project_id: 'p1', module_id: 'm1' }),
      ],
    })
    const blocked = cell('播放模块', '阻塞')
    expect(within(blocked).getByText('等审批')).toBeInTheDocument()
    expect(within(blocked).getAllByText(/等审批|等你输入|额度不足|出错/)).toHaveLength(1)
  })
})

/**
 * 交付物与费用(2026-09-09,待办第 5 条)。
 *
 * 借 Multica 那句「work lands in review, not in main」的**思路**:验收的对象是产物,不是
 * 一句「完成」;界面颗粒度按我们现有看板(卡上一个可选清单 + 一句提示),不另起审阅流。
 * 提示**不阻止**:七态转换表一个字没改——挡住他把卡拖进「等我确认」等于替他判断,
 * 而"东西还没交、先挂着"本来就是合法的一步。
 */
describe('交付物', () => {
  const REPO = '/Users/example/Documents/GitHub/Aiboo'
  const withBranches = [
    project('p1', 'Aiboo', {
      path: REPO,
      signals: {
        branch: 'main', dirty_count: 0, worktrees: 1, cleanup_count: 0, idle_days: 0,
        branches: ['main', 'claude/heuristic-noyce-41b305'],
      },
    }),
    project('p2', '工作台'),
  ]

  it('★进了「等我确认」却一件交付物都没有:卡面提示「没有可验收的东西」', () => {
    board({ tasks: [task({ id: 'a', title: '甲', status: 'confirm', project_id: 'p1', module_id: 'm1' })] })
    expect(within(cell('播放模块', '等我确认')).getByText('没有可验收的东西')).toBeInTheDocument()
  })

  it('挂了交付物就不提示,改成显示挂了几件', () => {
    board({
      tasks: [task({
        id: 'a', title: '甲', status: 'confirm', project_id: 'p1', module_id: 'm1',
        deliverables: [{ kind: 'branch', ref: 'claude/x' }, { kind: 'url', ref: 'https://a' }],
      })],
    })
    const slot = within(cell('播放模块', '等我确认'))
    expect(slot.queryByText('没有可验收的东西')).not.toBeInTheDocument()
    expect(slot.getByText('交付物 2')).toBeInTheDocument()
  })

  it('别的状态没有交付物是常态,不提示——那句话只在「等我确认」那一格有意义', () => {
    board({ tasks: [task({ id: 'a', title: '甲', status: 'doing', project_id: 'p1', module_id: 'm1' })] })
    expect(within(cell('播放模块', '进行中')).queryByText('没有可验收的东西')).not.toBeInTheDocument()
  })

  it('★提示不阻止:没有交付物照样拖得进「等我确认」', () => {
    const actions = board({ tasks: [task({ id: 'a', title: '甲', status: 'doing', project_id: 'p1', module_id: 'm1' })] })
    const dataTransfer = dt()
    dataTransfer.setData('text/plain', 'a')
    fireEvent.drop(cell('播放模块', '等我确认'), { dataTransfer })
    expect(actions.moveTask).toHaveBeenCalledWith('a', 'confirm', undefined)
  })

  it('branch 类从项目区扫到的分支里挑,挂上时连仓库路径一起记', async () => {
    const user = userEvent.setup()
    const actions = board({
      projects: withBranches,
      tasks: [task({ id: 'a', title: '甲', status: 'confirm', project_id: 'p1', module_id: 'm1' })],
    })
    await user.click(screen.getByRole('button', { name: '甲' }))
    await user.click(screen.getByRole('button', { name: /挂一件交付物/ }))
    await user.selectOptions(screen.getByLabelText('挑一条分支'), 'claude/heuristic-noyce-41b305')

    expect(actions.updateTask).toHaveBeenCalledWith('a', {
      deliverables: [{ kind: 'branch', ref: 'claude/heuristic-noyce-41b305', repo: REPO }],
    })
  })

  it('扫不到分支(仓库没接上/这条命令失败)时不摆一个空下拉,退回手敲', async () => {
    const user = userEvent.setup()
    board({ tasks: [task({ id: 'a', title: '甲', status: 'confirm', project_id: 'p1', module_id: 'm1' })] })
    await user.click(screen.getByRole('button', { name: '甲' }))
    await user.click(screen.getByRole('button', { name: /挂一件交付物/ }))

    expect(screen.queryByLabelText('挑一条分支')).not.toBeInTheDocument()
    expect(screen.getByLabelText('交付物的路径 / 分支名 / 链接')).toBeInTheDocument()
  })

  it('file 类把收件箱刚归档的落点、以及这张卡的来源文件带进来,点一下就填上', async () => {
    const user = userEvent.setup()
    const actions = board({
      lastArchivedPath: '/Users/example/Documents/GitHub/Aiboo/收件/合同.pdf',
      tasks: [task({
        id: 'a', title: '甲', status: 'confirm', project_id: 'p1', module_id: 'm1',
        source: { kind: 'file', ref: '/Users/example/Downloads/合同.pdf' },
      })],
    })
    await user.click(screen.getByRole('button', { name: '甲' }))
    await user.click(screen.getByRole('button', { name: /挂一件交付物/ }))
    await user.click(screen.getByRole('button', { name: '文件' }))
    // 两条都带进来:刚归档的落点,和这张卡当初是从哪个文件转来的。
    expect(screen.getByRole('button', { name: '用 /Users/example/Downloads/合同.pdf' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '用 /Users/example/Documents/GitHub/Aiboo/收件/合同.pdf' }))
    await user.click(screen.getByRole('button', { name: '挂上' }))

    expect(actions.updateTask).toHaveBeenCalledWith('a', {
      deliverables: [{ kind: 'file', ref: '/Users/example/Documents/GitHub/Aiboo/收件/合同.pdf' }],
    })
  })

  it('去掉一件只去掉那一条(整组给回来,同 links)', async () => {
    const user = userEvent.setup()
    const actions = board({
      tasks: [task({
        id: 'a', title: '甲', status: 'confirm', project_id: 'p1', module_id: 'm1',
        deliverables: [{ kind: 'branch', ref: 'feat/x' }, { kind: 'url', ref: 'https://a' }],
      })],
    })
    await user.click(screen.getByRole('button', { name: '甲' }))
    await user.click(screen.getByLabelText('去掉交付物 feat/x'))
    expect(actions.updateTask).toHaveBeenCalledWith('a', { deliverables: [{ kind: 'url', ref: 'https://a' }] })
  })
})

describe('费用归因(本卡消耗)', () => {
  const linked = task({
    id: 'a', title: '甲', status: 'doing', project_id: 'p1', module_id: 'm1',
    links: [{ agent: 'codex', session_id: 's-1' }, { agent: 'claude', session_id: 's-2' }],
  })

  it('★卡面把已关联会话的消耗加起来:口径同用量面板(入 + 缓存写 + 出,不含缓存读)', () => {
    board({
      tasks: [linked],
      sessionUsage: {
        'codex:s-1': { input: 20_000, output: 5_000, cache_read: 900_000, cache_write: 5_000 },
        'claude:s-2': { input: 0, output: 10_000, cache_read: 0, cache_write: 60_000 },
      },
    })
    // (20000+5000+5000) + (10000+60000) = 100000 → 10.0 万。缓存读的 90 万不进这个数。
    expect(within(cell('播放模块', '进行中')).getByText('10.0 万 token')).toBeInTheDocument()
  })

  it('★一条都查不到账时整段不显示——不写 0(0 会被读成"这张卡没花钱")', () => {
    board({ tasks: [linked], sessionUsage: {} })
    expect(within(cell('播放模块', '进行中')).queryByText(/token/)).not.toBeInTheDocument()
  })

  it('查得到几条就算几条,查不到的那条不占位也不当 0 拉低总数', () => {
    board({
      tasks: [linked],
      sessionUsage: { 'codex:s-1': { input: 5_000, output: 0, cache_read: 0, cache_write: 0 } },
    })
    expect(within(cell('播放模块', '进行中')).getByText('5000 token')).toBeInTheDocument()
  })

  it('没关联任何会话的卡不显示这一段', () => {
    board({ tasks: [task({ id: 'b', title: '乙', status: 'doing', project_id: 'p1', module_id: 'm1' })] })
    expect(within(cell('播放模块', '进行中')).queryByText(/token/)).not.toBeInTheDocument()
  })
})

describe('从会话流「归到这张卡」', () => {
  it('★挑一条会话 → 归到已有的某张卡:links 整组给回(原来那些 + 这条)', async () => {
    const user = userEvent.setup()
    const actions = board({
      tasks: [task({
        id: 'a', title: '甲', status: 'doing', project_id: 'p1', module_id: 'm1',
        links: [{ agent: 'claude', session_id: 'old' }],
      })],
      sessions: [session({ agent: 'codex', session_id: 'sess-9', title: '在跑的那个' })],
    })
    await user.click(screen.getByRole('button', { name: '从会话转卡' }))
    await user.click(screen.getByRole('button', { name: '把「在跑的那个」归到已有的卡' }))
    await user.click(screen.getByRole('button', { name: '归到「甲」' }))

    expect(actions.updateTask).toHaveBeenCalledWith('a', {
      links: [{ agent: 'claude', session_id: 'old' }, { agent: 'codex', session_id: 'sess-9' }],
    })
    expect(actions.createTask).not.toHaveBeenCalled()
  })

  it('已经归在这张卡上的会话不再列出来(重复归一次是空操作,不该给他这个按钮)', async () => {
    const user = userEvent.setup()
    board({
      tasks: [task({
        id: 'a', title: '甲', status: 'doing', project_id: 'p1', module_id: 'm1',
        links: [{ agent: 'codex', session_id: 'sess-9' }],
      })],
      sessions: [session({ agent: 'codex', session_id: 'sess-9', title: '在跑的那个' })],
    })
    await user.click(screen.getByRole('button', { name: '从会话转卡' }))
    await user.click(screen.getByRole('button', { name: '把「在跑的那个」归到已有的卡' }))
    expect(screen.queryByRole('button', { name: '归到「甲」' })).not.toBeInTheDocument()
    expect(screen.getByText('没有可归的卡')).toBeInTheDocument()
  })

  it('本项目一张卡都没有时,只有「新建卡」这条路,不摆一个点了没反应的按钮', async () => {
    const user = userEvent.setup()
    board({ tasks: [], sessions: [session({ agent: 'codex', session_id: 'sess-9', title: '在跑的那个' })] })
    await user.click(screen.getByRole('button', { name: '从会话转卡' }))
    expect(screen.queryByRole('button', { name: /归到已有的卡/ })).not.toBeInTheDocument()
  })
})

describe('排期风险(2026-09-09):看板列头与冲刺条同一口径', () => {
  const risk = (over: Partial<NonNullable<WorkbenchProject['risk']>> = {}) => ({
    level: 'late' as const, eta: '2026-09-19', window_days: 14, done_recent: 7, remaining: 5,
    reason: '按最近 14 天 7 条的速度,剩 5 条约 10 天做完,截止只剩 5 天',
    ...over,
  })

  it('项目标签上带等级与预计完成日,依据在 title 里', () => {
    board({ projects: [project('p1', 'Aiboo', { risk: risk() })] })
    const chip = screen.getByLabelText('Aiboo 排期风险:赶不上 · 预计 9-19 做完')
    expect(chip).toHaveAttribute('data-risk', 'late')
    expect(chip).toHaveAttribute('title', expect.stringContaining('按最近 14 天 7 条的速度'))
  })

  it('无法判断:只写「无法判断」,不给预计日', () => {
    board({
      projects: [project('p1', 'Aiboo', {
        risk: { level: 'unknown', reason: '没有任务卡,算不出速度', window_days: 14 },
      })],
    })
    expect(screen.getByLabelText('Aiboo 排期风险:无法判断')).toHaveAttribute('data-risk', 'unknown')
  })

  it('服务端没给 risk 时标签上整块不出现', () => {
    board()
    expect(screen.queryByLabelText(/排期风险/)).not.toBeInTheDocument()
  })

  it('宽裕与紧两档也照常显示', () => {
    board({
      projects: [
        project('p1', 'Aiboo', { risk: risk({ level: 'ample' }) }),
        project('p2', '工作台', { risk: risk({ level: 'tight', eta: '2026-09-13' }) }),
      ],
    })
    expect(screen.getByLabelText('Aiboo 排期风险:宽裕 · 预计 9-19 做完')).toHaveAttribute('data-risk', 'ample')
    expect(screen.getByLabelText('工作台 排期风险:紧 · 预计 9-13 做完')).toHaveAttribute('data-risk', 'tight')
  })

  it('冲刺条显示本冲刺的风险,口径与项目行同一句话', () => {
    board({ sprints: [sprint({ ends_at: '2026-09-14', risk: risk() })] })
    const chip = screen.getByLabelText('本冲刺排期风险:赶不上 · 预计 9-19 做完')
    expect(chip).toHaveAttribute('data-risk', 'late')
    expect(chip).toHaveAttribute('title', expect.stringContaining('截止只剩 5 天'))
  })

  it('冲刺没有 risk(没排结束日就算不出)时冲刺条上不出现这一块', () => {
    board({ sprints: [sprint()] })
    expect(screen.queryByLabelText('本冲刺排期风险:无法判断')).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/本冲刺排期风险/)).not.toBeInTheDocument()
  })

  it('冲刺「无法判断」时如实写出来,不藏也不编', () => {
    board({ sprints: [sprint({ risk: { level: 'unknown', reason: '没有截止日', window_days: 14 } })] })
    expect(screen.getByLabelText('本冲刺排期风险:无法判断')).toBeInTheDocument()
  })
})

describe('事项生命周期闭环(2026-09-16):弹窗里的回答与备注', () => {
  it('交付物里的「回答」按中文名显示,备注只读;手挂交付物的选项里没有「回答」(只由工作台挂)', async () => {
    const user = userEvent.setup()
    board({ tasks: [task({ id: 'a', title: '甲', status: 'confirm', project_id: 'p1', module_id: 'm1', deliverables: [{ kind: 'reply', ref: '我是 DeepSeek-V3', session_id: 's-1' }], note: '模型路由不可用' })] })
    await user.click(screen.getByRole('button', { name: '甲' }))
    expect(screen.getByText('回答')).toBeInTheDocument()
    expect(screen.getByText('我是 DeepSeek-V3')).toBeInTheDocument()
    expect(screen.getByRole('note', { name: '事务官备注' })).toHaveTextContent('模型路由不可用')
    await user.click(screen.getByRole('button', { name: /挂一件交付物/ }))
    const kinds = within(screen.getByRole('group', { name: '交付物是什么' })).getAllByRole('button').map(b => b.textContent)
    expect(kinds).toEqual(['分支', 'diff', '文件', '链接'])
  })
})

describe('tasks.json 读坏了(2026-10-21)', () => {
  it('看板顶上照原话显示那一句;读得好好的时候不显示', () => {
    board({ problem: '任务看板的文件 tasks.json 内容坏了、读不出来,原文件没动' })
    expect(screen.getByRole('alert')).toHaveTextContent('原文件没动')
    cleanup()
    board()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('冲刺条「等我确认」的数(2026-10-26,卡「事务官页接管队列」)', () => {
  const ask = { kind: 'pairing' as const, proposal: '配对这台', basis: '核过的事实', by: 'butler', at: AT }
  it('只数带四类拍板请求的;没标的是事务官待核验队列,不算等他动手', () => {
    const tasks = [
      task({ id: 'a', status: 'confirm', owner_ask: ask }),
      task({ id: 'b', status: 'confirm' }),
      task({ id: 'c', status: 'confirm', owner_ask: { ...ask, kind: 'unknown' as never } }),
      task({ id: 'd', status: 'blocked' }),
      task({ id: 'e', status: 'confirm', project_id: '别的项目', owner_ask: ask }),
    ]
    expect(attentionCounts(tasks, undefined)).toEqual({ confirm: 1, blocked: 1 })
    expect(attentionCounts(tasks, '别的项目')).toEqual({ confirm: 1, blocked: 0 })
  })
})
