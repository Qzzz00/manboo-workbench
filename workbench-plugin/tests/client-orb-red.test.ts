/**
 * 电脑首页那颗球什么时候红(2026-09-25 晚,卡 fix/phone-home-card-fit)。
 *
 * 统筹真壳(0.2.88):电脑事务官页的球是红 / 粉红(执行中莫比乌斯带),手机那头是琥珀;此刻真正在等他的只有待确认那几件。
 * 今晚有过一条派活失败(t-5a426464,后来改成「取消」)和两通未接来电。维护者的规矩:**红色只用于真错误**。
 * 统筹定的口径:**有真失败且还没处理才红,待确认琥珀,其余中性** —— 两端同一口径(手机 swarm/orbState.isOpenFailure)。
 *
 * 这一份钉的是那个口径;数据照 23:33 那份 /state(只读取过一次)的形状手写,不连真服务。
 */
import { describe, expect, it } from 'vitest'
import type { CallOutView, SessionView, TaskClientDispatch, TaskDispatch, TaskView, WorkbenchState } from '../src/protocol.ts'
import { buildButlerScene } from '../src/client/butlerSceneModel.ts'
import { deriveButlerInbox } from '../src/server/butlerInbox.ts'

const at = '2026-09-24T15:33:11.000Z'
const task = (id: string, status: TaskView['status'], more: Partial<TaskView> = {}): TaskView => ({ id, title: id, status, direction: 'mine', source: { kind: 'manual' }, created_at: '2026-09-24T14:30:00Z', updated_at: '2026-09-24T14:30:00Z', ...more })
const failedWindowDispatch = { hand: 'window', family: 'kimi', status: 'failed', at: '2026-09-24T14:53:40.096Z', text: '派活', reason: '壳没说为什么,只说没送成' } as unknown as TaskClientDispatch
const claudeRunning: SessionView = { agent: 'claude', session_id: 'cl-1', status: 'running', title: '', project: '', elapsed_sec: 3600, unread: false, updated_at: at }
const missedCalls = {
  config: { enabled: true, quiet_from: '21:00', quiet_to: '08:30', done_call: false },
  entries: [
    { id: 'c-1', reason: 'failed', item_id: 't-5a426464', title: '[派活测试] 让 Kimi 用一句话回答:一年有几个季节?', at: '2026-09-24T14:53:44.000Z', state: 'missed', error: '响了 60 秒没人接' },
    { id: 'c-2', reason: 'confirm', item_id: 't-f27d6416', title: '[测试·统筹验证,可忽略] 我的规矩有哪些?', at: '2026-09-24T15:00:00.000Z', state: 'missed', error: '响了 60 秒没人接' },
  ],
} as unknown as CallOutView

function state(tasks: TaskView[], more: Partial<WorkbenchState> = {}): WorkbenchState {
  const base: WorkbenchState = {
    agents: [{ id: 'dsh', online: false, connected: false, waiting: 0, running: 0 }, { id: 'claude', online: true, connected: true, waiting: 0, running: 1 }],
    sessions: [claudeRunning], quota: {}, stale: false, now: at,
    tasks: { tasks, sprints: [], modules: [], project_meta: [] },
    call_out: missedCalls,
    ...more,
  } as WorkbenchState
  return { ...base, butler_inbox: deriveButlerInbox({ tasks: base.tasks, sessions: base.sessions }) }
}

describe('球的颜色:真失败没处理才红,待确认琥珀,其余中性', () => {
  it('★23:33 那份的形状:派活失败那件已取消 + 两通未接 + 一件等你确认 + Claude 在跑 → 琥珀(不红)', () => {
    const s = state([
      task('t-5a426464', 'canceled', { title: '[派活测试] 让 Kimi 用一句话回答:一年有几个季节?', assignee: 'kimi', origin: 'user', client_dispatch: failedWindowDispatch }),
      task('t-f27d6416', 'confirm', { title: '[测试·统筹验证,可忽略] 我的规矩有哪些?', origin: 'user' }),
    ])
    const model = buildButlerScene(s)
    expect(model.notice).toBe('confirmation')
    expect(model.items.some(item => item.notice === 'failed')).toBe(false)
    expect(model.running).toBe(1)
  })

  it('同一份去掉那件等你确认 → 中性(已取消的失败、未接来电都不染色)', () => {
    const s = state([task('t-5a426464', 'canceled', { client_dispatch: failedWindowDispatch })])
    expect(buildButlerScene(s).notice).toBe('neutral')
  })

  it('★还开着的一件派活没送成(窗口那只手)→ 红:那是真失败、还没处理', () => {
    const s = state([task('t-open', 'todo', { client_dispatch: failedWindowDispatch })])
    const model = buildButlerScene(s)
    expect(model.items.find(item => item.id === 't-open')?.notice).toBe('failed')
    expect(model.notice).toBe('failed')
  })

  it('卡在「阻塞 · 出错」上的那件 → 红;取消之后(阻塞原因跟着清掉)→ 不红', () => {
    expect(buildButlerScene(state([task('t-b', 'blocked', { block_reason: 'error' })])).notice).toBe('failed')
    expect(buildButlerScene(state([task('t-b', 'canceled')])).notice).toBe('neutral')
  })

  it('接口那只手派活没做成:还开着 → 红;已取消 → 收件箱不再挂「要我自己来吗?」,球也不红', () => {
    const dispatch = { family: 'deepseek', status: 'failed', started_at: '2026-09-24T14:00:00Z', ended_at: '2026-09-24T14:01:00Z', note: '中转超时' } as unknown as TaskDispatch
    const open = state([task('t-api', 'blocked', { dispatch, block_reason: 'error' })])
    expect(open.butler_inbox?.items.some(item => item.kind === 'dispatch')).toBe(true)
    expect(buildButlerScene(open).notice).toBe('failed')
    const canceled = state([task('t-api', 'canceled', { dispatch })])
    expect(canceled.butler_inbox?.items.some(item => item.kind === 'dispatch')).toBe(false)
    expect(buildButlerScene(canceled).notice).toBe('neutral')
  })

  it('收件箱里一条出错的事件,它那件事已经取消了(不在「我的」里、没挂到卡上)→ 不红', () => {
    // 不是「我的」那张(看板上别人的卡):收件箱这条出错事件不会挂到卡上,单独成一项。
    const board = task('t-x', 'canceled')
    delete (board as { direction?: TaskView['direction'] }).direction
    const s = state([board])
    const withEvent: WorkbenchState = { ...s, butler_inbox: { items: [{ id: 'ship:t-x:1', kind: 'ship', title: '改自己这条路停在某一步', wait_reason: 'error', task_id: 't-x' }] } } as WorkbenchState
    expect(buildButlerScene(withEvent).notice).not.toBe('failed')
  })
})
