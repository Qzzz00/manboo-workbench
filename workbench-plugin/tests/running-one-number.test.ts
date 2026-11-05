/** 公共分类后，舞台、球下、汇报和手机数业务事项；窗口槽数各家运行会话。
 * 老服务的混合 running 口径仍有兼容测试，不能与新业务数相加比较。
 */
import { describe, expect, it } from 'vitest'
import type { RunSegment, SessionView, TaskView, WorkbenchState } from '../src/protocol.ts'
import { buildButlerScene } from '../src/client/butlerSceneModel.ts'
import { butlerReportLine, orbStatusLine } from '../src/client/butlerInbox.ts'
import { deriveButlerInbox, executingItemCount } from '../src/server/butlerInbox.ts'
import { isHisSession, runningNow, runningOf, unlinkedRunningSessions } from '../src/running.ts'
import { needsYou, orbCounts } from '../src/client/orb.ts'
import { waitingOf } from '../src/waiting.ts'
import { executionOverview } from '../src/server/executionState.ts'
import { businessExecutionView } from '../src/client/businessExecutionModel.ts'
import { orbCellOf } from '../src/orbCell.ts'

const NOW = '2026-09-25T13:00:00.000Z'

const session = (more: Partial<SessionView> & Pick<SessionView, 'agent' | 'session_id'>): SessionView => ({
  project: '工作台', status: 'running', elapsed_sec: 60, unread: false, updated_at: '2026-09-25T12:59:00.000Z', ...more,
})

const task = (id: string, more: Partial<TaskView> = {}): TaskView => ({
  id, title: id, status: 'doing', direction: 'mine', source: { kind: 'manual' },
  created_at: '2026-09-25T12:00:00.000Z', updated_at: '2026-09-25T12:00:00.000Z', ...more,
})

/**
 * 09-25 21:00 维护者屏上那一刻,照真状态搭的:
 * - 一条真的在跑(统筹会话,没挂在事项上);
 * - 两条**能力体检探针**(cwd `/`,`claude -p` 探的一句,登录失败已经结束了 —— 这里按修好之后的样子给 error);
 * - 一条 `ben-cc`(桌面 App 里说完一轮等他打字)—— 空闲,不是「待确认」;
 * - 一件事务官派出去、在 Codex 里真跑着的活。
 */
function benScreenAt2100(): WorkbenchState {
  const sessions: SessionView[] = [
    session({ agent: 'claude', session_id: 'd9991aac', title: 'Desktop-workbench 统筹交接', status: 'running' }),
    session({ agent: 'claude', session_id: '8233a09f', title: 'What is 2+2?Reply w…', status: 'error', project: '未归类', selfcheck: { kind: 'caps', by: 'cwd' }, human_error: { line: 'Claude 命令行还没登录', action: 'login_claude', raw: 'Not logged in · Please run /login' } }),
    session({ agent: 'claude', session_id: 'd69c0851', title: 'What is 2+2?Reply w…', status: 'error', project: '未归类', selfcheck: { kind: 'caps', by: 'cwd' } }),
    session({ agent: 'claude', session_id: 'd23ceb3e', title: 'ben-cc', status: 'done', reason: 'idle_prompt', project: 'ben' }),
    session({ agent: 'codex', session_id: 'codex-1', title: '把导出做完' }),
  ]
  const tasks = [task('t-export', { links: [{ agent: 'codex', session_id: 'codex-1' }] })]
  const base: WorkbenchState = {
    agents: [
      { id: 'dsh', connected: true, online: true, waiting: 0, running: 0 },
      { id: 'claude', connected: true, online: true, waiting: 0, running: 1 },
      { id: 'codex', connected: true, online: true, waiting: 0, running: 1 },
      { id: 'kimi', connected: false, online: false, waiting: 0, running: 0 },
    ],
    sessions, quota: {}, stale: false, now: NOW,
    tasks: { tasks, sprints: [], modules: [], project_meta: [] },
    butler_inbox: { items: [] },
  }
  return { ...base, butler_inbox: deriveButlerInbox({ tasks: base.tasks, sessions: base.sessions }) }
}

/*
 * 「在跑几件」2026-10-29 改口后从任务日志那一本账推(executionOverview 第三个参数,生产由 http.ts
 * 用 runSegmentsOf 接上)。这份单测的世界没有真账,按来源账的同一世界推片段:每条在跑的业务
 * 来源 = 一条 running 业务片段 —— 与改口前的计数世界保持一致。
 */
const runsOf = (task: TaskView): readonly RunSegment[] =>
  (task.execution_sources ?? []).filter(one => one.state === 'running' && one.role === 'business')
    .map(one => ({ task_id: task.id, source: one.agent, status: 'running', role: 'business', started_at: '' }))

function classifiedAt2100(extra: TaskView[] = []): WorkbenchState {
  const base = benScreenAt2100()
  const business = { ...base.tasks!.tasks[0]!, execution_sources: [{
    task_id: 't-export', agent: 'codex', session_id: 'codex-1', role: 'business' as const,
    role_origin: 'explicit_task' as const, state: 'running' as const, rounds: [],
  }] }
  const tasks = { ...base.tasks!, tasks: [business, ...extra] }
  const execution = executionOverview(tasks.tasks, true, runsOf)
  return { ...base, tasks, execution, running: runningNow({ ...base, tasks, execution }) }
}

const linkedSource = (id: string, role: 'coordination' | 'unclassified'): TaskView => {
  const value = task(id, {
    source: { kind: 'session' }, execution_role: { kind: role, origin: role === 'coordination' ? 'user' : 'automatic_session' },
    links: [{ agent: 'codex', session_id: `source-${id}` }],
    execution_sources: [{ task_id: id, agent: 'codex', session_id: `source-${id}`, role,
      role_origin: role === 'coordination' ? 'user' : 'automatic_session', state: 'running', rounds: [] }],
  })
  delete value.direction
  return value
}

describe('公共业务事项数与旧 running 兼容口径', () => {
  const state = benScreenAt2100()
  const running = runningNow(state)

  it('这一刻真的在跑的是 2 件:统筹那条散会话 + 派给 Codex 的那件活(两条探针一条都不算)', () => {
    expect(running.count).toBe(2)
    expect(running.items.map(one => one.key).sort()).toEqual(['session:claude/d9991aac', 'task:t-export'])
  })

  it('舞台与球下读公共业务任务数；老服务的散会话兼容口径单独保留', () => {
    const publicState = classifiedAt2100()
    expect(publicState.running).toMatchObject({ scope: 'classified_business_tasks', count: 1, observed_count: 1 })
    expect(buildButlerScene(publicState).running).toBe(1)
    expect(businessExecutionView(publicState).ids).toEqual(['t-export'])
    // 旧服务缺公共分类时仍走原兼容口径；它不是当前业务任务数。
    expect(buildButlerScene(state).running).toBe(running.count)
  })

  it('汇报条只报公共业务任务，不把统筹散会话写成业务执行', () => {
    const publicState = classifiedAt2100()
    const line = butlerReportLine(publicState, buildButlerScene(publicState).running)
    expect(line).toContain('业务任务执行 1 件')
    expect(line).not.toContain('运行会话 2 个')
  })

  it('同一事项多来源仍数一件，协调会话单列；未知总数不写零且已知执行让球保持在办', () => {
    const coordinated = classifiedAt2100([linkedSource('t-manager', 'coordination')])
    const task = coordinated.tasks!.tasks[0]!
    task.execution_sources = [...task.execution_sources!, { task_id: task.id, agent: 'kimi', session_id: 'source-kimi',
      role: 'business', role_origin: 'explicit_task', state: 'running', rounds: [] }]
    coordinated.execution = executionOverview(coordinated.tasks!.tasks, true, runsOf)
    coordinated.running = runningNow(coordinated)
    expect(coordinated.execution).toMatchObject({ observed_running_tasks: 1, observed_running_sessions: 2, complete: true })
    expect(coordinated.running).toMatchObject({ count: 1, observed_count: 1, excluded: [{ task_id: 't-manager', role: 'coordination' }] })
    expect(buildButlerScene(coordinated).running).toBe(1)
    expect(butlerReportLine(coordinated, buildButlerScene(coordinated).running)).toContain('业务任务执行 1 件')

    const unknown = classifiedAt2100([linkedSource('t-auto', 'unclassified')])
    expect(unknown.running?.count).toBeUndefined()
    expect(unknown.running?.observed_count).toBe(1)
    expect(buildButlerScene(unknown).running).toBeUndefined()
    expect(butlerReportLine(unknown, buildButlerScene(unknown).running)).not.toContain('业务任务执行 0 件')
    expect(orbCellOf(unknown).working).toBe(true)
    expect(orbCellOf({ ...unknown, stale: true }).working).toBe(false)
    expect(orbStatusLine({ questions: 0, approvals: 0, typing: false, focusRunning: false,
      running: buildButlerScene(unknown).running, observedRunning: businessExecutionView(unknown).observed })).toContain('总数未知')
  })

  it('窗口槽标签气泡 = 这一家切出来的那几件,加起来等于总数', () => {
    const perAgent = ['dsh', 'claude', 'codex', 'kimi'].map(agent => running.items.filter(one => one.agent === agent).length)
    expect(perAgent.reduce((a, b) => a + b, 0)).toBe(running.count)
    // Claude 那一颗白气泡此刻是 1(原来是 3:两条探针混进去了)。
    expect(running.items.filter(one => one.agent === 'claude')).toHaveLength(1)
  })

  it('手机首页「正在办」= 同一个数(手机读 state.running.count)', () => {
    // 手机那一半在 butler-app/src/stage/stageCardsModel.ts:`count: state.running?.count ?? rows.length`。
    // 这里断言它读的那一格与电脑同源,并且手机自己数的行数(去掉探针之后)也相等。
    const phoneRows = unlinkedRunningSessions(state).length + executingItemCount(state)!
    expect(phoneRows).toBe(running.count)
  })

  it('服务端 butler_inbox.executing 与这一份对得上(事项那一半)', () => {
    expect(executingItemCount(state)).toBe(running.items.filter(one => one.task_id !== undefined).length)
  })
})

/**
 * ★「等你 n」也各处一个数(2026-09-25,统筹在升级评估里顺手发现的):
 * `client/orb.ts` 的 `orbCounts` / `needsYou` 原来只数收件箱里 `kind: 'confirm'` 那一类,
 * 而「等你」那一堆是三样(要他答 / 要他批 / 要他验收)。他被问了一句话时球不变色、数也少一个。
 */
describe('★「等你 n」:球那一处与 waitingOnHim 同一个数', () => {
  function withQuestion(): WorkbenchState {
    const base = benScreenAt2100()
    return {
      ...base,
      // 一条「要他答」(不是 confirm):老写法数 0、球不变色。
      questions: [{ id: 'q1', session_id: 'dsh-1', at: NOW, task_title: '导出 PDF', questions: [{ id: 'q1a', question: '要不要连封面一起?', header: '封面', multi: false, options: [] }] }],
    }
  }

  it('orbCounts.waiting = waitingOf(state).count(要他答的那一条也算)', () => {
    const state = withQuestion()
    expect(waitingOf(state).count).toBe(1)
    expect(orbCounts(state)?.waiting).toBe(1)
  })

  it('★有一条要他答的,球就该变琥珀(原来只有 confirm 才变)', () => {
    expect(needsYou(withQuestion())).toBe(true)
    // 一件都没有时不变色。
    expect(needsYou(benScreenAt2100())).toBe(false)
  })

  it('服务端给了 waiting 那一格就以它为准(两端同一份)', () => {
    const state = { ...benScreenAt2100(), waiting: { count: 4, items: [] } }
    expect(orbCounts(state)?.waiting).toBe(4)
    expect(needsYou(state)).toBe(true)
  })
})

describe('探针不算他的会话', () => {
  it('isHisSession:有 selfcheck 的一律不算', () => {
    expect(isHisSession({ selfcheck: { by: 'env', kind: 'caps' } })).toBe(false)
    expect(isHisSession({})).toBe(true)
  })

  it('★探针在跑着也不进「执行」、不进舞台(09-25 那两张假卡)', () => {
    const state = benScreenAt2100()
    // 把两条探针改成「真在跑」——就算它们真在跑,也不该出现在他眼前。
    const probing: WorkbenchState = {
      ...state,
      sessions: state.sessions.map(one => one.selfcheck === undefined ? one : { ...one, status: 'running' as const }),
    }
    expect(runningNow(probing).count).toBe(2)
    expect(buildButlerScene(probing).items.some(item => item.id.includes('8233a09f'))).toBe(false)
    expect(buildButlerScene(probing).items.some(item => item.id.includes('d69c0851'))).toBe(false)
  })
})

describe('数不出来就缺席,不填 0', () => {
  it('快照冻结(stale)→ count 缺席', () => {
    const frozen = { ...benScreenAt2100(), stale: true }
    expect(runningNow(frozen).count).toBeUndefined()
    expect(buildButlerScene(frozen).running).toBeUndefined()
  })

  it('任务板这一轮没给 → count 缺席', () => {
    const state = benScreenAt2100()
    const noTasks = { ...state }
    delete noTasks.tasks
    expect(runningNow(noTasks).count).toBeUndefined()
  })

  it('runningOf:服务端给了就用它(两端同一份),没给就就地算', () => {
    const state = benScreenAt2100()
    const server = { count: 7, items: [] }
    expect(runningOf({ ...state, running: server }).count).toBe(7)
    expect(runningOf(state).count).toBe(2)
  })
})

/**
 * ★★窗口型 Agent 也进同一份账(2026-09-26,卡 WS)。维护者:「新加的是不是状态不全,
 * 只有完成的,但是没有弹过待确认还有执行中的气泡」。
 *
 * 这一份钉两件事:
 * ① 窗口读出来的 `status:'running'` **本来就**计入 `/state.running`(服务端那一半早就对了);
 * ② 坞上那一格的白点必须切得出来 —— `running.items[].agent` 是**登记表 id**(新接上一家 = 包标识),
 *    而坞上那一格的键是 App 注册表的键(`c-antigravity`)。按键名直接比对 → 切出空数组 → 白点消失。
 *    这就是他看不见「执行中」的那一半根因(客户端那一半在 tests/client-dock.test.tsx 钉着)。
 */
describe('★★窗口型 Agent:执行中进同一份账,坞上那一格切得出来', () => {
  /** 09-26 16:2x 生产 8791 那一刻(只读量出来的):Claude 两条会话在跑 + Antigravity 的窗口会话在跑。 */
  function benScreenAt1620(): WorkbenchState {
    const sessions: SessionView[] = [
      session({ agent: 'claude', session_id: 'd9991aac', title: 'Desktop-workbench 统筹交接', status: 'running' }),
      session({ agent: 'claude', session_id: 'd2ef4d6d', title: '修 server-butler-dispatch-http 上「豆包办公」那条…', status: 'running' }),
    ]
    return {
      agents: [], sessions, quota: {}, stale: false, now: NOW,
      tasks: { tasks: [], sprints: [], modules: [], project_meta: [] },
      butler_inbox: { items: [] },
      dock: {
        stack: [
          { key: 'claude', label: 'Claude', running: true, current: false },
          { key: 'c-antigravity', label: 'Antigravity', running: true, current: true },
        ],
        bundles: { claude: 'com.anthropic.claudefordesktop', 'c-antigravity': 'com.google.antigravity' },
      },
      agent_registry: {
        entries: [
          {
            id: 'claude', bundle_id: 'com.anthropic.claudefordesktop', name: 'Claude',
            found: { how: 'sessions', at: '', basis: '它的会话记录' }, sources: [], status: 'running', gaps: {},
            sessions: sessions.map(one => ({ ...one, via: 'sessions' as const })),
            counts: { running: 2, waiting: 0, unread: 0 },
          },
          {
            id: 'com.google.antigravity', bundle_id: 'com.google.antigravity', name: 'Antigravity',
            found: { how: 'activate', at: NOW, basis: '模型判成 Agent' },
            sources: [{ kind: 'window', label: '读它的窗口', ok: true }], app_running: true, status: 'running', gaps: {},
            sessions: [{
              agent: 'com.google.antigravity', session_id: 'window:5e0b9399', project: 'Antigravity',
              status: 'running', title: 'Initiating A New Conversa…', elapsed_sec: 42, unread: false,
              updated_at: '2026-09-26T08:08:00.000Z', via: 'window',
            }],
            counts: { running: 1, waiting: 0, unread: 0 },
          },
        ],
        asking: [],
        notices: [],
      },
    }
  }

  it('窗口型那条在跑的会话进 /state.running(与文件型那两条同一份账)', () => {
    const running = runningNow(benScreenAt1620())
    expect(running.count).toBe(3)
    expect(running.items.map(one => one.key).sort()).toEqual([
      'session:claude/d2ef4d6d', 'session:claude/d9991aac', 'session:com.google.antigravity/window:5e0b9399',
    ])
  })

  it('★★按坞上那一格的键直接比对切不出来(09-26 那条 bug);按登记表 id / 包标识才切得出来', () => {
    const state = benScreenAt1620()
    const running = runningNow(state)
    // 旧写法:坞上那一格的键是 c-antigravity,`items[].agent` 是包标识 → 一条都切不出来。
    expect(running.items.filter(one => one.agent === 'c-antigravity')).toHaveLength(0)
    // 现在的写法(client/DockTabBar.tsx 的 agentIdsOfTab):按 dock.bundles 认出登记表里那一家再切。
    const bundle = state.dock?.bundles?.['c-antigravity']
    const entry = state.agent_registry?.entries.find(one => one.bundle_id === bundle)
    const ids = new Set([entry?.id, entry?.bundle_id].filter((one): one is string => one !== undefined))
    expect(running.items.filter(one => ids.has(one.agent))).toHaveLength(1)
  })

  it('窗口会话切片可有三条，公共业务任务为零；两种单位不相加', () => {
    const state = benScreenAt1620()
    const legacy = runningNow(state)
    const execution = executionOverview([], true, runsOf)
    const publicState = { ...state, execution, running: runningNow({ ...state, execution }) }
    expect(buildButlerScene(publicState).running).toBe(0)
    const perEntry = (state.agent_registry?.entries ?? []).map(entry => legacy.items.filter(one => one.agent === entry.id).length)
    expect(perEntry.reduce((a, b) => a + b, 0)).toBe(3)
    expect(publicState.running.count).toBe(0)
  })

  it('★App 没开(offline)的窗口会话不算在跑', () => {
    const state = benScreenAt1620()
    const offline: WorkbenchState = {
      ...state,
      agent_registry: {
        ...state.agent_registry!,
        entries: state.agent_registry!.entries.map(entry => entry.id !== 'com.google.antigravity' ? entry : {
          ...entry, app_running: false, status: 'idle',
          sessions: entry.sessions.map(one => ({ ...one, status: 'offline' as const })),
          counts: { running: 0, waiting: 0, unread: 0 },
        }),
      },
    }
    expect(runningNow(offline).count).toBe(2)
  })
})
