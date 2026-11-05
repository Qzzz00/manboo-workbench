// @vitest-environment node
/**
 * 「事务官交给我」那一半的派生(2026-09-10 事项收件箱)。
 *
 * 这一半**不落盘**:四个来源各有各的事实源,再存一份就要有人负责同步,而那个同步一定会漏。
 * 所以这里全是纯函数的用例——喂一份快照的四块进去,看拼出来的条目对不对。
 */
import { describe, expect, it } from 'vitest'
import type { MeetingView, SentinelWatch, SessionView, TaskView, WorkbenchProject } from '../src/protocol.ts'
import { isItemExecuting } from '../src/protocol.ts'
import { deriveButlerInbox } from '../src/server/butlerInbox.ts'

function task(over: Partial<TaskView> = {}): TaskView {
  return {
    id: 't1', title: '把展示台的黄历接上', status: 'confirm', source: { kind: 'manual' },
    created_at: '2026-09-10T01:00:00.000Z', updated_at: '2026-09-10T02:00:00.000Z',
    ...over,
  }
}

function session(over: Partial<SessionView> = {}): SessionView {
  return {
    agent: 'dsh', session_id: 's-1', project: '工作台', status: 'waiting',
    elapsed_sec: 300, unread: false, updated_at: '2026-09-10T02:00:00.000Z',
    ...over,
  }
}

function watch(over: Partial<SentinelWatch> = {}): SentinelWatch {
  return {
    id: 'w1', kind: 'file', target: '/tmp/a', note: '构建产物出来了',
    interval_sec: 60, cooldown_sec: 300, created_at: '2026-09-10T00:00:00.000Z', fires: 0,
    ...over,
  }
}

function project(over: Partial<WorkbenchProject> = {}): WorkbenchProject {
  return {
    id: 'p1', name: 'Aiboo', stage: 'MVP 开发', links: [], session_count: 0, idle: false,
    ...over,
  }
}

describe('deriveButlerInbox:四个来源', () => {
  it('等我确认的卡 → confirm 条,带七态与卡 id;交付物数量如实写在附注里', () => {
    const view = deriveButlerInbox({
      tasks: { tasks: [task({ deliverables: [{ kind: 'branch', ref: 'feat/x' }] })], sprints: [], modules: [], project_meta: [] },
      sessions: [],
    })

    expect(view.items).toHaveLength(1)
    expect(view.items[0]).toMatchObject({
      id: 'confirm:t1', kind: 'confirm', title: '把展示台的黄历接上', status: 'confirm', task_id: 't1',
      note: '1 件交付物',
    })
  })

  it('等我确认但一件交付物都没有 → 如实说「没有可验收的东西」(只提示,不改状态)', () => {
    const view = deriveButlerInbox({
      tasks: { tasks: [task()], sprints: [], modules: [], project_meta: [] },
      sessions: [],
    })
    expect(view.items[0]?.note).toBe('没有可验收的东西')
  })

  it('事务官标了四类拍板请求 → confirm 条原样带上 owner_ask(2026-10-26,卡「事务官页接管队列」)', () => {
    const ownerAsk = { kind: 'spend' as const, proposal: '买这个', basis: '核过的事实', by: 'butler', at: '2026-09-10T02:00:00.000Z' }
    const view = deriveButlerInbox({
      tasks: { tasks: [task({ owner_ask: ownerAsk }), task({ id: 't2', title: '没核完' })], sprints: [], modules: [], project_meta: [] },
      sessions: [],
    })
    expect(view.items[0]?.owner_ask).toEqual(ownerAsk)
    // 没标的不带这一格。
    expect(view.items[1]?.owner_ask).toBeUndefined()
  })

  it('等我确认的卡带 conversation → 条目把它原样带上(点开就能看那段对话)', () => {
    const view = deriveButlerInbox({
      tasks: {
        tasks: [task({ conversation: { agent: 'dsh', session_id: 'sess-9' } })],
        sprints: [], modules: [], project_meta: [],
      },
      sessions: [],
    })
    expect(view.items[0]?.conversation).toEqual({ agent: 'dsh', session_id: 'sess-9' })
  })

  it('别的六态一律不进来(只有「等我确认」才是事务官在找我)', () => {
    const view = deriveButlerInbox({
      tasks: {
        tasks: [
          task({ id: 'a', status: 'doing' }), task({ id: 'b', status: 'done' }),
          task({ id: 'c', status: 'blocked' }), task({ id: 'd', status: 'backlog' }),
          task({ id: 'e', status: 'todo' }), task({ id: 'f', status: 'canceled' }),
        ],
        sprints: [], modules: [], project_meta: [],
      },
      sessions: [],
    })
    expect(view.items).toHaveLength(0)
  })

  it('等审批的 DSH 会话 → session 条,带等待原因与会话 id', () => {
    const view = deriveButlerInbox({
      sessions: [session({ title: '改会话流的排序', wait_reason: 'approval' })],
    })

    expect(view.items[0]).toMatchObject({
      id: 'session:s-1', kind: 'session', title: '改会话流的排序', wait_reason: 'approval',
      conversation: { agent: 'dsh', session_id: 's-1' },
    })
  })

  it('别家(Claude/Codex/Kimi)的会话不进来——事务官是 DSH,别家的窗口在会话区自己有黄点', () => {
    const view = deriveButlerInbox({
      sessions: [session({ agent: 'claude', session_id: 'c-1' }), session({ agent: 'codex', session_id: 'x-1' })],
    })
    expect(view.items).toHaveLength(0)
  })

  it('在跑/刚完成/离线的 DSH 会话不进来(收件箱只收"在等我"的)', () => {
    const view = deriveButlerInbox({
      sessions: [
        session({ session_id: 'r', status: 'running' }),
        session({ session_id: 'd', status: 'done' }),
        session({ session_id: 'o', status: 'offline' }),
      ],
    })
    expect(view.items).toHaveLength(0)
  })

  it('哨兵与排期风险那两条投影会话**不重复计数**——它们各自有自己的一档', () => {
    const view = deriveButlerInbox({
      sessions: [
        session({ session_id: 'sentinel:w1' }),
        session({ session_id: 'schedule:p1' }),
      ],
    })
    expect(view.items).toHaveLength(0)
  })

  it('哨兵命中 → sentinel 条,说的是监视项自己那句话,带触发时刻', () => {
    const view = deriveButlerInbox({
      sessions: [],
      sentinel: [watch({ fires: 2, last_fired_at: '2026-09-10T03:00:00.000Z' })],
    })

    expect(view.items[0]).toMatchObject({
      id: 'sentinel:w1', kind: 'sentinel', title: '构建产物出来了', at: '2026-09-10T03:00:00.000Z',
    })
    // 哨兵那条"会话"是投影,DSH 里没有这条会话,点开会落空——所以不给它 conversation。
    expect(view.items[0]?.conversation).toBeUndefined()
  })

  it('还没命中过的哨兵不进来(在盯着 ≠ 有事找我)', () => {
    const view = deriveButlerInbox({ sessions: [], sentinel: [watch()] })
    expect(view.items).toHaveLength(0)
  })

  it('多条哨兵按触发时刻从新到旧', () => {
    const view = deriveButlerInbox({
      sessions: [],
      sentinel: [
        watch({ id: 'old', note: '旧的', fires: 1, last_fired_at: '2026-09-10T01:00:00.000Z' }),
        watch({ id: 'new', note: '新的', fires: 1, last_fired_at: '2026-09-10T05:00:00.000Z' }),
      ],
    })
    expect(view.items.map(item => item.title)).toEqual(['新的', '旧的'])
  })

  it('排期「赶不上」→ risk 条,附注是服务端算好的那句话(事务官只转述)', () => {
    const view = deriveButlerInbox({
      sessions: [],
      projects: [project({ risk: { level: 'late', eta: '2026-09-20', reason: '按最近 14 天 1 条的速度,剩 9 条', window_days: 14 } })],
    })
    expect(view.items[0]).toMatchObject({ id: 'risk:p1', kind: 'risk', title: 'Aiboo 排期赶不上' })
    expect(view.items[0]?.note).toContain('9-20')
  })

  it('宽裕/紧/无法判断都不进来——只有「赶不上」才值得开口', () => {
    const view = deriveButlerInbox({
      sessions: [],
      projects: [
        project({ id: 'a', risk: { level: 'ample', reason: '算过了', window_days: 14 } }),
        project({ id: 'b', risk: { level: 'tight', reason: '算过了', window_days: 14 } }),
        project({ id: 'c', risk: { level: 'unknown', reason: '算过了', window_days: 14 } }),
        project({ id: 'd' }),
      ],
    })
    expect(view.items).toHaveLength(0)
  })
})

describe('deriveButlerInbox:排序与空态', () => {
  it('四档同时命中 → 等审批的会话在最前,然后等我确认、哨兵、排期', () => {
    const view = deriveButlerInbox({
      tasks: { tasks: [task()], sprints: [], modules: [], project_meta: [] },
      sessions: [session({ wait_reason: 'approval' })],
      sentinel: [watch({ fires: 1, last_fired_at: '2026-09-10T03:00:00.000Z' })],
      projects: [project({ risk: { level: 'late', reason: '算过了', window_days: 14 } })],
    })
    expect(view.items.map(item => item.kind)).toEqual(['session', 'confirm', 'sentinel', 'risk'])
  })

  it('什么都没有 → 空列表(不是缺省:「这会儿没事找你」本身就是一句真话)', () => {
    expect(deriveButlerInbox({ sessions: [] }).items).toEqual([])
  })
})

describe('deriveButlerInbox:执行中的事项数(2026-09-16 口径统一)', () => {
  const mine = (id: string, sessionId: string, status: TaskView['status'] = 'doing'): TaskView =>
    task({ id, status, direction: 'mine', conversation: { agent: 'dsh', session_id: sessionId }, links: [{ agent: 'dsh', session_id: sessionId }] })
  const agents = [{ id: 'dsh', online: true, connected: true, waiting: 0, running: 1 }] as const

  it('★只数「mine + doing + 挂的会话真在 running」:会话早已 done 的 doing 卡不算(真机那两条)', () => {
    const tasks = { tasks: [mine('a', 's-a'), mine('b', 's-b'), mine('c', 's-c', 'confirm')], sprints: [], modules: [], project_meta: [] }
    const sessions = [session({ session_id: 's-a', status: 'running' }), session({ session_id: 's-b', status: 'done' }), session({ session_id: 's-c', status: 'running' })]
    expect(deriveButlerInbox({ tasks, sessions, agents: [...agents], stale: false }).executing).toBe(1)
  })

  it('与客户端 isItemExecuting 同一个定义:别家会话在跑、卡不是 mine、卡没 links 都不算', () => {
    const board = task({ id: 'board', status: 'doing', links: [{ agent: 'dsh', session_id: 's-a' }] })
    const noLinks = task({ id: 'nolinks', status: 'doing', direction: 'mine' })
    const tasks = { tasks: [board, noLinks], sprints: [], modules: [], project_meta: [] }
    const sessions = [session({ session_id: 's-a', status: 'running' })]
    expect(deriveButlerInbox({ tasks, sessions, agents: [...agents], stale: false }).executing).toBe(0)
    expect(isItemExecuting(board, { sessions, agents: [...agents], stale: false })).toBe(false)
  })

  it('任务板没接上 / 快照冻结 → 缺省,不填 0(0 会被读成"没事",真相是"不知道")', () => {
    expect(deriveButlerInbox({ sessions: [], agents: [], stale: false }).executing).toBeUndefined()
    const tasks = { tasks: [mine('a', 's-a')], sprints: [], modules: [], project_meta: [] }
    expect(deriveButlerInbox({ tasks, sessions: [session({ session_id: 's-a', status: 'running' })], agents: [...agents], stale: true }).executing).toBeUndefined()
    // agents 没给(老调用方)→ 按在线算,不因缺席把执行数压成 0
    expect(deriveButlerInbox({ tasks, sessions: [session({ session_id: 's-a', status: 'running' })] }).executing).toBe(1)
  })
})

describe('summary 跟着条目走(2026-09-15,手机端要念的那一句)', () => {
  it('等着的会话:带上 /state.sessions[] 里那条的 summary,没有就不占位', () => {
    const view = deriveButlerInbox({
      sessions: [
        session({ session_id: 's-1', summary: '改到一半,要你批一下写文件。' }),
        session({ session_id: 's-2' }),
      ],
    })
    const [a, b] = view.items
    expect(a?.summary).toBe('改到一半,要你批一下写文件。')
    expect(b).not.toHaveProperty('summary')
  })

  it('等我确认的卡:有会话就带那条会话的 summary;会话不在表里就不填', () => {
    const view = deriveButlerInbox({
      tasks: {
        tasks: [
          task({ id: 't1', conversation: { agent: 'dsh', session_id: 's-9' } }),
          task({ id: 't2', conversation: { agent: 'dsh', session_id: 's-gone' } }),
          task({ id: 't3' }),
        ],
        sprints: [], modules: [], project_meta: [],
      },
      sessions: [session({ session_id: 's-9', status: 'done', summary: '黄历接上了。' })],
    })
    const byId = new Map(view.items.map(item => [item.id, item]))
    expect(byId.get('confirm:t1')?.summary).toBe('黄历接上了。')
    expect(byId.get('confirm:t2')).not.toHaveProperty('summary')
    expect(byId.get('confirm:t3')).not.toHaveProperty('summary')
  })
})

/**
 * 最近一次会议那一档(2026-09-21 会议模式)。
 *
 * 只有**最近那一场**进收件箱:收件箱的价值在于短,把历次会议都铺出来就成了第二个文件夹。
 */
describe('⑤ 最近一次会议', () => {
  function meeting(over: Partial<MeetingView> = {}): MeetingView {
    return {
      id: 'm1', title: '产品周会', date: '2026-09-21', started_at: '2026-09-21T02:00:00.000Z',
      ended_at: '2026-09-21T03:00:00.000Z', status: 'done', segments: 6,
      todos: [{ id: 't1', what: '跑一遍转写' }, { id: 't2', what: '写交接' }], unsure: [],
      ...over,
    }
  }

  function itemsOf(over: Partial<MeetingView> = {}) {
    return deriveButlerInbox({ sessions: [], meetings: { recent: [meeting(over)] } }).items
  }

  it('没接会议服务 → 整档不出', () => {
    expect(deriveButlerInbox({ sessions: [] }).items.some(one => one.kind === 'meeting')).toBe(false)
    expect(deriveButlerInbox({ sessions: [], meetings: { recent: [] } }).items).toEqual([])
  })

  it('还在录的那一场不进来(人就在会上,蹦一条没有意义)', () => {
    expect(itemsOf({ status: 'recording' })).toEqual([])
  })

  it('梳理完了 → 「纪要好了 · N 条待办等你挑」,时刻用结束那一刻', () => {
    const [item] = itemsOf()
    expect(item?.kind).toBe('meeting')
    expect(item?.id).toBe('meeting:m1')
    expect(item?.title).toBe('会议「产品周会」的纪要好了')
    expect(item?.note).toBe('2 条待办等你挑')
    expect(item?.at).toBe('2026-09-21T03:00:00.000Z')
  })

  it('待办都建成卡了 / 一条都没梳理出来:两句话不一样,而且都不写「0 条待办」', () => {
    expect(itemsOf({ todos: [{ id: 't1', what: '跑一遍', task_id: 'task-1' }] })[0]?.note).toBe('待办都建成卡了')
    expect(itemsOf({ todos: [] })[0]?.note).toBe('没梳理出待办')
    expect(itemsOf({ todos: [] })[0]?.note).not.toContain('0')
  })

  it('转写中 / 梳理中都进来(他看得见进度)', () => {
    expect(itemsOf({ status: 'transcribing' })[0]?.title).toContain('正在转写')
    expect(itemsOf({ status: 'transcribing' })[0]?.note).toBe('6 段录音')
    expect(itemsOf({ status: 'summarizing' })[0]?.title).toContain('正在梳理')
  })

  it('失败那条**尤其要进来**,并把原话带上 ——「录了一小时结果什么都没有」不能只活在手机上', () => {
    const [item] = itemsOf({ status: 'failed', error: '转写没接上(8792 没起来)。原始录音还在。' })
    expect(item?.title).toBe('会议「产品周会」没整理成')
    expect(item?.note).toContain('原始录音还在')
  })

  it('放在最后一档:它不阻塞任何人', () => {
    const items = deriveButlerInbox({
      sessions: [session()],
      tasks: { tasks: [task()], sprints: [], modules: [], project_meta: [] },
      meetings: { recent: [meeting()] },
    }).items
    expect(items[items.length - 1]?.kind).toBe('meeting')
  })

  it('只看最近那一场(列表本身已经是最新在前)', () => {
    const items = deriveButlerInbox({
      sessions: [],
      meetings: { recent: [meeting({ id: 'new', title: '新的' }), meeting({ id: 'old', title: '旧的' })] },
    }).items
    expect(items.filter(one => one.kind === 'meeting')).toHaveLength(1)
    expect(items[0]?.title).toContain('新的')
  })
})
