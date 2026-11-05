import { describe, expect, it } from 'vitest'
import type { SessionView, TaskView, WorkbenchState } from '../src/protocol.ts'
import { buildButlerScene, readSceneItem } from '../src/client/butlerSceneModel.ts'
import { deriveButlerInbox } from '../src/server/butlerInbox.ts'

const task = (id: string, status: TaskView['status'], more: Partial<TaskView> = {}): TaskView => ({ id, title: id, status, direction: 'mine', source: { kind: 'manual' }, created_at: '2026-09-15', updated_at: '2026-09-15', ...more })
const state = (tasks: TaskView[]): WorkbenchState => ({ agents: [], sessions: [], quota: {}, stale: false, now: '2026-09-15', tasks: { tasks, sprints: [], modules: [], project_meta: [] }, butler_inbox: { items: [] } })
const approvalSession = (more: Partial<SessionView> = {}): SessionView => ({ agent: 'dsh', session_id: 's-a', status: 'waiting', wait_reason: 'approval', title: '请审批', project: '', elapsed_sec: 1, unread: false, updated_at: '2026-09-15T10:00:00Z', ...more })
function withDerivedInbox(s: WorkbenchState): WorkbenchState {
  return { ...s, butler_inbox: deriveButlerInbox({ tasks: s.tasks, sessions: s.sessions }) }
}

describe('真实 deriveButlerInbox 会话事件投影', () => {
  it.each(['conversation', 'links'] as const)('通过 task.%s 关联无 task_id 的审批事件,只保留一件且阅读后消除提醒', field => {
    const reference = { agent: 'dsh', session_id: 's-a' } as const
    const s = withDerivedInbox({ ...state([task('task-a', 'doing', field === 'conversation' ? { conversation: reference } : { links: [reference] })]), sessions: [approvalSession()] })
    expect(s.butler_inbox?.items).toHaveLength(1)
    expect(s.butler_inbox?.items[0]).toMatchObject({ id: 'session:s-a', kind: 'session', conversation: reference })
    expect(s.butler_inbox?.items[0]?.task_id).toBeUndefined()
    const model = buildButlerScene(s)
    expect(model.items.map(item => item.id)).toEqual(['task-a'])
    expect(model.notice).toBe('confirmation')
    const read = readSceneItem({}, model.items[0]!)
    expect(buildButlerScene(s, read).notice).toBe('neutral')
    expect(s.tasks?.tasks[0]?.status).toBe('doing')
    const next = withDerivedInbox({ ...s, sessions: [approvalSession({ updated_at: '2026-09-15T11:00:00Z' })] })
    expect(buildButlerScene(next, read).notice).toBe('confirmation')
  })
  it('未关联会话保留独立事项,同 session_id 的另一 agent 不会错误合并', () => {
    const otherAgent = approvalSession({ agent: 'codex', status: 'running' })
    delete otherAgent.wait_reason
    const s = withDerivedInbox({ ...state([task('task-a', 'doing', { links: [{ agent: 'codex', session_id: 's-a' }] })]), sessions: [approvalSession(), approvalSession({ session_id: 'unlinked' }), otherAgent] })
    const model = buildButlerScene(s)
    expect(model.items.map(item => item.id)).toEqual(['task-a', 'session:s-a', 'session:unlinked'])
    expect(model.items[0]?.notice).toBe('neutral')
    expect(model.running).toBe(1)
    const read = model.items.reduce((seen, item) => readSceneItem(seen, item), {})
    const otherAgentChanged = withDerivedInbox({ ...s, sessions: s.sessions.map(session => session.agent === 'codex' ? { ...session, updated_at: '2026-09-15T11:00:00Z' } : session) })
    expect(buildButlerScene(otherAgentChanged, read).items.filter(item => item.id.startsWith('session:')).every(item => !item.unread)).toBe(true)
  })
  it('普通看板任务不因关联等待会话被提升为事务官事项', () => {
    const board = task('board-card', 'doing', { conversation: { agent: 'dsh', session_id: 's-a' } })
    delete board.direction
    const s = withDerivedInbox({ ...state([board]), sessions: [approvalSession()] })
    expect(buildButlerScene(s).items.map(item => item.id)).toEqual(['session:s-a'])
  })
  it('真实确认卡与同会话审批合并时,保留确认任务身份及交付回执', () => {
    // 2026-10-26(卡「事务官页接管队列」):带「确认」键的前提是事务官标了四类拍板请求(owner_ask)。
    const s = withDerivedInbox({ ...state([task('task-a', 'confirm', { conversation: { agent: 'dsh', session_id: 's-a' }, owner_ask: { kind: 'spend', proposal: '买这个', basis: '核过的事实', by: 'butler', at: '2026-09-15T10:00:00Z' } })]), sessions: [approvalSession({ project: '项目上下文' })] })
    const model = buildButlerScene(s)
    expect(model.items).toHaveLength(1)
    expect(model.items[0]).toMatchObject({ id: 'task-a', confirmTaskId: 'task-a', note: '没有可验收的东西' })
    expect(buildButlerScene(s, readSceneItem({}, model.items[0]!)).notice).toBe('neutral')
  })
  it('「等我确认」但没标四类拍板请求:不给「确认」键,只摆「事务官核验中」(待核验队列不摊给他)', () => {
    const s = withDerivedInbox({ ...state([task('task-a', 'confirm', { conversation: { agent: 'dsh', session_id: 's-a' } })]), sessions: [approvalSession({ project: '项目上下文' })] })
    const model = buildButlerScene(s)
    expect(model.items).toHaveLength(1)
    expect(model.items[0]?.id).toBe('task-a')
    expect(model.items[0]).not.toHaveProperty('confirmTaskId')
    expect(model.items[0]).toMatchObject({ label: '事务官核验中' })
    // 类别认不出(坏形状)同样不给。
    const bad = withDerivedInbox({ ...state([task('task-a', 'confirm', { conversation: { agent: 'dsh', session_id: 's-a' }, owner_ask: { kind: 'unknown' as never, proposal: 'x', basis: 'y', at: '2026-09-15T10:00:00Z' } })]), sessions: [approvalSession({ project: '项目上下文' })] })
    const badItem = buildButlerScene(bad).items[0]!
    expect(badItem).not.toHaveProperty('confirmTaskId')
    expect(badItem).toMatchObject({ label: '事务官核验中' })
  })
  it('独立审批事件的同快照与计时变化保持已读,新输出/审批版本重新提醒', () => {
    const s = withDerivedInbox({ ...state([]), sessions: [approvalSession()] })
    expect(s.butler_inbox?.items[0]?.at).toBeUndefined()
    const item = buildButlerScene(s).items[0]!, read = readSceneItem({}, item)
    expect(buildButlerScene(withDerivedInbox(s), read).notice).toBe('neutral')
    const ticking = withDerivedInbox({ ...s, now: '2026-09-15T10:01:00Z', sessions: [approvalSession({ elapsed_sec: 61, last_output_sec: 60 })] })
    expect(buildButlerScene(ticking, read).items[0]).toMatchObject({ version: item.version, unread: false })
    const renewed = withDerivedInbox({ ...s, sessions: [approvalSession({ updated_at: '2026-09-15T11:00:00Z' })] })
    expect(renewed.butler_inbox).toEqual(s.butler_inbox)
    expect(buildButlerScene(renewed, read).items[0]?.version).not.toBe(item.version)
    expect(buildButlerScene(renewed, read).notice).toBe('confirmation')
  })
  it('独立会话的新回执摘要与等待原因进入版本,未读标记不反向触发提醒', () => {
    const s = withDerivedInbox({ ...state([]), sessions: [approvalSession({ summary: '第一份回执' })] })
    const item = buildButlerScene(s).items[0]!, read = readSceneItem({}, item)
    const receipt = withDerivedInbox({ ...s, sessions: [approvalSession({ summary: '修订后的回执' })] })
    expect(buildButlerScene(receipt, read).notice).toBe('confirmation')
    const unreadFlag = withDerivedInbox({ ...s, sessions: [approvalSession({ summary: '第一份回执', unread: true })] })
    expect(buildButlerScene(unreadFlag, read).notice).toBe('neutral')
    const input = withDerivedInbox({ ...s, sessions: [approvalSession({ summary: '第一份回执', wait_reason: 'input' })] })
    expect(buildButlerScene(input, read).items[0]?.version).not.toBe(item.version)
    expect(buildButlerScene(input, read).notice).toBe('neutral')
  })
})

describe('真实事务官事项适配', () => {
  it.each([
    ['waiting', 'approval', 'confirmation'],
    ['error', undefined, 'failed'],
    ['offline', undefined, 'neutral'],
  ] as const)('一位Agent仍运行、另一位%s时，仍计1件执行并保留需留意分组与提醒', (status, waitReason, notice) => {
    const s = state([task('mixed', 'doing', { links: [{ agent: 'dsh', session_id: 'running' }, { agent: 'codex', session_id: 'other' }] })])
    s.sessions = [
      { agent: 'dsh', session_id: 'running', status: 'running', project: '', elapsed_sec: 1, unread: false, updated_at: 'v1' },
      { agent: 'codex', session_id: 'other', status, project: '', elapsed_sec: 1, unread: false, updated_at: 'v1', ...(waitReason ? { wait_reason: waitReason } : {}) },
    ]
    const view = buildButlerScene(s)
    expect(view.running).toBe(1)
    expect(view.groups.attention.map(item => item.id)).toEqual(['mixed'])
    expect(view.items[0]?.executing).toBe(true)
    expect(view.notice).toBe(notice)
  })
  it.each(['confirm', 'done', 'canceled', 'todo', 'backlog'] as const)('%s事项不因旧链接仍running而计入执行', status => {
    const s = state([task('not-doing', status, { links: [{ agent: 'dsh', session_id: 'running' }] })])
    s.sessions = [{ agent: 'dsh', session_id: 'running', status: 'running', project: '', elapsed_sec: 1, unread: false, updated_at: 'v1' } satisfies SessionView]
    expect(buildButlerScene(s).running).toBe(0)
  })
  it('排队、记录进行中、确认、完成、阻塞与取消分别保留；只有真实运行会话计执行', () => {
    const s = state(['backlog', 'todo', 'doing', 'confirm', 'done', 'blocked', 'canceled'].map(status => task(status, status as TaskView['status'])))
    const view = buildButlerScene(s)
    expect(view.groups.queued.map(x => x.id)).toEqual(['backlog', 'todo'])
    expect(view.groups.working.map(x => x.id)).toEqual(['doing'])
    expect(view.groups.confirmation.map(x => x.id)).toEqual(['confirm'])
    expect(view.groups.completed.map(x => x.id)).toEqual(['done'])
    expect(view.groups.attention.map(x => x.id)).toEqual(['blocked'])
    expect(view.groups.canceled.map(x => x.id)).toEqual(['canceled'])
    expect(view.running).toBe(0)
  })
  it('同任务多来源只保留一件，重复执行链接只计一次', () => {
    const s = state([task('a', 'confirm'), task('b', 'doing', { links: [{ agent: 'dsh', session_id: 's' }, { agent: 'dsh', session_id: 's' }] })])
    s.butler_inbox = { items: [{ id: 'confirm:a', task_id: 'a', kind: 'confirm', title: 'a', at: 'v2' }] }
    s.sessions = [{ agent: 'dsh', session_id: 's', status: 'running', project: '', elapsed_sec: 1, unread: false, updated_at: 'v1' }]
    expect(buildButlerScene(s).items.map(x => x.id)).toEqual(['a', 'b'])
    expect(buildButlerScene(s).running).toBe(1)
    expect(buildButlerScene(s).items[1]?.executors).toHaveLength(1)
    expect(buildButlerScene(s).items[1]?.note).toBeUndefined()
  })
  it('待输入、离线不是失败；明确 error 才产生红色提醒', () => {
    const s = state([task('input', 'blocked', { block_reason: 'input' }), task('offline', 'doing', { links: [{ agent: 'dsh', session_id: 'off' }] })])
    s.sessions = [{ agent: 'dsh', session_id: 'off', status: 'offline', project: '', elapsed_sec: 0, unread: false, updated_at: 'v1' }]
    expect(buildButlerScene(s).items.every(x => x.notice !== 'failed')).toBe(true)
    expect(buildButlerScene(s).items[0]?.waitLabel).toBe('等你输入')
    s.tasks!.tasks = [task('failed', 'blocked', { block_reason: 'error' })]
    expect(buildButlerScene(s).notice).toBe('failed')
  })
  it('缺失不编零，冻结不继续宣称执行', () => {
    const s = state([])
    expect(buildButlerScene(s).running).toBe(0)
    delete s.tasks
    expect(buildButlerScene(s).running).toBeUndefined()
    expect(buildButlerScene({ ...state([]), stale: true }).frozen).toBe(true)
  })
  it('任务等审批用黄色提醒，等输入仍保留文字且不冒充审批', () => {
    const view = buildButlerScene(state([task('approval', 'blocked', { block_reason: 'approval' }), task('input', 'blocked', { block_reason: 'input' })]))
    expect(view.items[0]?.notice).toBe('confirmation')
    expect(view.items[1]?.notice).toBe('neutral')
  })
  it('阅读消除当前版本提醒；新的状态或回执会重新提醒，状态本身不变', () => {
    const s = state([task('a', 'confirm')])
    const item = buildButlerScene(s).items[0]!
    const read = readSceneItem({}, item)
    expect(buildButlerScene(s, read).notice).toBe('neutral')
    expect(s.tasks!.tasks[0]?.status).toBe('confirm')
    expect(buildButlerScene(state([task('a', 'done', { updated_at: 'v2' })]), read).notice).toBe('completed')
  })
})

describe('事项生命周期闭环(2026-09-16):排队态与口径统一', () => {
  const now = '2026-09-16T10:00:00.000Z'
  const fresh = (id: string, more: Partial<TaskView> = {}): TaskView => task(id, 'todo', { created_at: '2026-09-16T09:59:50.000Z', updated_at: '2026-09-16T09:59:50.000Z', ...more })

  it('★刚建好、会话还没开出来的事项 = 排队(pending),不算执行', () => {
    const s = { ...state([fresh('new')]), now }
    const view = buildButlerScene(s)
    expect(view.items[0]).toMatchObject({ pending: true, executing: false, group: 'queued' })
    expect(view.running).toBe(0)
    expect(view.groups.queued.map(item => item.id)).toEqual(['new'])
  })

  it('会话开出来、卡进 doing 且会话 running → 执行;会话 done 而卡还在 doing → 既不执行也不排队', () => {
    const running = { agent: 'dsh', session_id: 's', status: 'running', project: '', elapsed_sec: 1, unread: false, updated_at: 'v1' } satisfies SessionView
    const s = { ...state([fresh('a', { status: 'doing', conversation: { agent: 'dsh', session_id: 's' }, links: [{ agent: 'dsh', session_id: 's' }] })]), now, sessions: [running] }
    expect(buildButlerScene(s).items[0]).toMatchObject({ pending: false, executing: true })
    const ended = { ...s, sessions: [{ ...running, status: 'done' as const }] }
    expect(buildButlerScene(ended).items[0]).toMatchObject({ pending: false, executing: false, group: 'working' })
    expect(buildButlerScene(ended).running).toBe(0)
  })

  it('「会话未开」的卡、建了很久的待办、已有会话的待办(你停了它)都不是排队', () => {
    const noSession = fresh('no', { note: '会话未开' })
    const old = task('old', 'todo', { created_at: '2026-09-16T09:00:00.000Z' })
    const stopped = fresh('stopped', { conversation: { agent: 'dsh', session_id: 's' }, note: '你停了它' })
    const view = buildButlerScene({ ...state([noSession, old, stopped]), now })
    expect(view.items.map(item => item.pending)).toEqual([false, false, false])
    expect(view.groups.queued).toHaveLength(3)
  })

  it('now 解析不出来(老测试的空串)→ 不排队,不编', () => {
    expect(buildButlerScene({ ...state([fresh('x')]), now: '' }).items[0]?.pending).toBe(false)
  })

  it('★执行数与服务端 butler_inbox.executing 同一口径(同一份快照、同一个函数)', () => {
    const s = state([
      task('a', 'doing', { links: [{ agent: 'dsh', session_id: 's-a' }] }),
      task('b', 'doing', { links: [{ agent: 'dsh', session_id: 's-b' }] }),
      task('c', 'doing', { links: [{ agent: 'codex', session_id: 's-c' }] }),
    ])
    s.sessions = [
      { agent: 'dsh', session_id: 's-a', status: 'running', project: '', elapsed_sec: 1, unread: false, updated_at: 'v1' },
      { agent: 'dsh', session_id: 's-b', status: 'done', project: '', elapsed_sec: 1, unread: false, updated_at: 'v1' },
      { agent: 'codex', session_id: 's-c', status: 'running', project: '', elapsed_sec: 1, unread: false, updated_at: 'v1' },
    ]
    s.agents = [{ id: 'dsh', online: true, connected: true, waiting: 0, running: 1 }, { id: 'codex', online: false, connected: true, waiting: 0, running: 0 }]
    const server = deriveButlerInbox({ tasks: s.tasks, sessions: s.sessions, agents: s.agents, stale: s.stale })
    const client = buildButlerScene({ ...s, butler_inbox: server, running: { count: 1, items: [{ key: 'task:a', task_id: 'a', agent: 'dsh', session_id: 's-a', text: 'a' }] } })
    expect(server.executing).toBe(1)
    expect(client.running).toBe(server.executing)
    expect(client.items.filter(item => item.executing).map(item => item.id)).toEqual(['a'])
  })

  it('进「等我确认」的事项:交付物里的回答进版本(回答变了要重新提醒)', () => {
    const a = task('a', 'confirm', { deliverables: [{ kind: 'reply', ref: '我是 DeepSeek', session_id: 's' }] })
    const view = buildButlerScene(state([a]))
    expect(view.items[0]?.group).toBe('confirmation')
    expect(view.items[0]?.reply).toBe('我是 DeepSeek')
    const read = readSceneItem({}, view.items[0]!)
    const changed = state([{ ...a, deliverables: [{ kind: 'reply', ref: '改了', session_id: 's' }] }])
    expect(buildButlerScene(changed, read).notice).toBe('confirmation')
  })
})

it('交回事项的来源会话留在该事项详情，不在舞台重复一张已交回卡', () => {
  const one = task('returned-task', 'confirm', { assignee: 'codex', links: [{ agent: 'codex', session_id: 'returned-source' }] })
  const s = withDerivedInbox({ ...state([one]), sessions: [approvalSession({ agent: 'codex', session_id: 'returned-source', status: 'done', unread: true })] })
  const model = buildButlerScene(s)
  expect(model.items.filter(item => item.id === one.id)).toHaveLength(1)
  expect(model.items.find(item => item.id === one.id)?.executors).toHaveLength(1)
  expect(model.stage.some(item => item.external?.session_id === 'returned-source')).toBe(false)
})
