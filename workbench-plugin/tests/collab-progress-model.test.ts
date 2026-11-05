import { describe, expect, it } from 'vitest'
import type { CollabGoal, CollabPresence, CollabSprint, SessionView, TaskView } from '../src/protocol.ts'
import {
  classifyExecutionTruth,
  dedupTasksParentChild,
  extractScopeName,
  partitionProductionTasks,
  summarizeProgress,
  type ProgressSummaryModel,
} from '../src/client/collab/progressModel.ts'

const AT = '2026-10-23T10:00:00.000Z'
const makeTask = (id: string, patch: Partial<TaskView> = {}): TaskView => ({
  id,
  title: id,
  status: 'todo',
  source: { kind: 'manual' },
  created_at: AT,
  updated_at: AT,
  ...patch,
})

describe('progressModel: 真实执行与状态判据 (classifyExecutionTruth)', () => {
  it('账面 doing 与进程派出状态不能代替实际运行账', () => {
    const t = makeTask('t1', {
      status: 'doing',
      dispatch: { family: 'codex', status: 'running', started_at: AT },
    })
    expect(classifyExecutionTruth(t)).toBe('waiting_receipt')
    expect(classifyExecutionTruth(t, { runs: [{ task_id: 't1', source: 'codex', started_at: AT, status: 'running' }] })).toBe('running')
  })

  it('账面 doing 且有活跃 Agent Presence (on_note) -> running (真实执行中)', () => {
    const t = makeTask('t1', { status: 'doing' })
    const presence: CollabPresence[] = [{
      actor: { kind: 'agent', id: 'agent:local:kimi' },
      state: 'working',
      at: AT,
      on_note: 't1',
    }]
    expect(classifyExecutionTruth(t, { presence, nowMs: Date.parse(AT) + 1000 })).toBe('running')
  })

  it('仅有关联会话 running 不能证明这件事项真实开工', () => {
    const t = makeTask('t1', {
      status: 'doing',
      conversation: { agent: 'dsh', session_id: 's-123' },
    })
    const sessions = [{ session_id: 's-123', status: 'running' }] as unknown as SessionView[]
    expect(classifyExecutionTruth(t, { sessions })).toBe('waiting_receipt')
  })

  it('账面 doing 但通道中排队 (dispatch_lane.state: queued) -> dispatched_queued (已派出未接单)', () => {
    const t = makeTask('t1', {
      status: 'doing',
      dispatch_lane: { family: 'codex', state: 'queued', since: AT, note: '排队等候' },
    })
    expect(classifyExecutionTruth(t)).toBe('dispatched_queued')
  })

  it('账面 doing 但 CLI/派活回合已结束 (dispatch.status: done) 无交回回执 -> turn_ended (回合结束待收口)', () => {
    const t = makeTask('t1', {
      status: 'doing',
      dispatch: { family: 'claude', status: 'done', started_at: AT },
    })
    expect(classifyExecutionTruth(t)).toBe('turn_ended')
  })

  it('账面 doing 但无实时运行证据 -> waiting_receipt (待执行回执/未知)', () => {
    const t = makeTask('t1', { status: 'doing' })
    expect(classifyExecutionTruth(t)).toBe('waiting_receipt')
  })

  it('status === confirm -> review (交回待验)', () => {
    const t = makeTask('t1', { status: 'confirm' })
    expect(classifyExecutionTruth(t)).toBe('review')
  })

  it('status === done 且具备实际发布或代码入库标记 (self_ship / published_at) -> delivered (当前可用)', () => {
    const t1 = makeTask('t1', {
      status: 'done',
      self_ship: { branch: 'feat/x', status: 'ok', started_at: AT },
    })
    const t2 = makeTask('t2', { status: 'done', published_at: '2026-10-23' })
    expect(classifyExecutionTruth(t1)).toBe('delivered')
    expect(classifyExecutionTruth(t2)).toBe('delivered')
  })

  it('status === done 但无发布标记 -> accepted (已验收待交付)', () => {
    const t = makeTask('t1', { status: 'done', done_at: AT })
    expect(classifyExecutionTruth(t)).toBe('accepted')
  })

  it('status === blocked 或带有 dispatch_block -> blocked (受阻)', () => {
    const t1 = makeTask('t1', { status: 'blocked', block_reason: 'approval' })
    const t2 = makeTask('t2', { status: 'todo', dispatch_block: { family: 'claude', kind: 'code', why: '窗口未开', at: AT } })
    expect(classifyExecutionTruth(t1)).toBe('blocked')
    expect(classifyExecutionTruth(t2)).toBe('blocked')
  })

  it('status === todo / backlog -> unstarted (未开始)', () => {
    expect(classifyExecutionTruth(makeTask('t1', { status: 'todo' }))).toBe('unstarted')
    expect(classifyExecutionTruth(makeTask('t2', { status: 'backlog' }))).toBe('unstarted')
  })

  it('status === canceled -> canceled (已取消)', () => {
    expect(classifyExecutionTruth(makeTask('t1', { status: 'canceled' }))).toBe('canceled')
  })
})

describe('progressModel: presence 光标守卫 (member/idle/stale/moving 不能冒开工)', () => {
  const now = Date.parse(AT) + 1000
  const doingTask = () => makeTask('t1', { status: 'doing' })

  it('member 光标绑在 doing 任务上也不算真实执行 -> waiting_receipt', () => {
    const t = doingTask()
    const presence: CollabPresence[] = [{
      actor: { kind: 'member', account: 'ben' },
      state: 'working',
      at: AT,
      on_note: 't1',
    }]
    expect(classifyExecutionTruth(t, { presence, nowMs: now })).toBe('waiting_receipt')
  })

  it('idle / moving / stamping 的 Agent 光标不算真实执行 -> waiting_receipt', () => {
    const t = doingTask()
    for (const state of ['idle', 'moving', 'stamping'] as const) {
      const presence: CollabPresence[] = [{
        actor: { kind: 'agent', id: 'agent:local:kimi' },
        state,
        at: AT,
        on_note: 't1',
      }]
      expect(classifyExecutionTruth(t, { presence, nowMs: now })).toBe('waiting_receipt')
    }
  })

  it('超过 60 秒的过期 Agent working 光标不算真实执行 -> waiting_receipt', () => {
    const t = doingTask()
    const presence: CollabPresence[] = [{
      actor: { kind: 'agent', id: 'agent:local:kimi' },
      state: 'working',
      at: AT,
      on_note: 't1',
    }]
    expect(classifyExecutionTruth(t, { presence, nowMs: Date.parse(AT) + 61_000 })).toBe('waiting_receipt')
  })

  it('光标绑定的任务不在本范围(或已不在 doing)时不算 -> waiting_receipt', () => {
    const t = doingTask()
    const foreign: CollabPresence[] = [{
      actor: { kind: 'agent', id: 'agent:local:kimi' },
      state: 'working',
      at: AT,
      on_note: 't-other',
    }]
    expect(classifyExecutionTruth(t, { presence: foreign, nowMs: now })).toBe('waiting_receipt')
  })

  it('新鲜且 working 的 Agent 光标照旧算真实执行 -> running', () => {
    const t = doingTask()
    const presence: CollabPresence[] = [{
      actor: { kind: 'agent', id: 'agent:local:kimi' },
      state: 'working',
      at: AT,
      on_note: 't1',
    }]
    expect(classifyExecutionTruth(t, { presence, nowMs: now })).toBe('running')
  })
})

describe('progressModel: 父子汇总不重复计数 (dedupTasksParentChild)', () => {
  it('若任务是父容器且其子任务在统计列表中，仅计子任务叶子项，不重复计入任务总数', () => {
    const parent = makeTask('p1', { children: ['c1', 'c2'], title: '父任务组' })
    const child1 = makeTask('c1', { title: '子任务 1' })
    const child2 = makeTask('c2', { title: '子任务 2' })
    const standalone = makeTask('s1', { title: '独立任务' })

    const result = dedupTasksParentChild([parent, child1, child2, standalone])
    expect(result.dedupedWorkTasks.map(t => t.id)).toEqual(['c1', 'c2', 's1'])
    expect(result.parentGroupTasks.map(t => t.id)).toEqual(['p1'])
  })

  it('若父任务的子任务未出现在当前统计范围内，父任务作为独立任务保留', () => {
    const parent = makeTask('p1', { children: ['external-1'], title: '跨范围父任务' })
    const standalone = makeTask('s1', { title: '独立任务' })

    const result = dedupTasksParentChild([parent, standalone])
    expect(result.dedupedWorkTasks.map(t => t.id)).toEqual(['p1', 's1'])
    expect(result.parentGroupTasks).toEqual([])
  })
})

describe('progressModel: 演示数据隔离与生产统计 (partitionProductionTasks)', () => {
  it('demo: true 的数据与生产数据严格隔离，不污染生产任务账', () => {
    const prod1 = makeTask('p1')
    const prod2 = makeTask('p2')
    const demo1 = makeTask('d1', { demo: true })

    const { production, demo } = partitionProductionTasks([prod1, prod2, demo1])
    expect(production.map(t => t.id)).toEqual(['p1', 'p2'])
    expect(demo.map(t => t.id)).toEqual(['d1'])
  })
})

describe('progressModel: 汇总与清单构建 (summarizeProgress)', () => {
  it('正确统计各状态数量、剩余数量及明细清单', () => {
    const tasks: TaskView[] = [
      makeTask('t-delivered', { status: 'done', published_at: '2026-10-23' }),
      makeTask('t-accepted', { status: 'done', done_at: AT }),
      makeTask('t-review', { status: 'confirm', receipt: { kind: 'done', text: '已交回代码', at: AT } }),
      makeTask('t-running', { status: 'doing', dispatch: { family: 'codex', status: 'running', started_at: AT } }),
      makeTask('t-waiting', { status: 'doing' }),
      makeTask('t-blocked', { status: 'blocked', block_reason: 'approval' }),
      makeTask('t-unstarted', { status: 'todo' }),
      makeTask('t-canceled', { status: 'canceled' }),
      makeTask('t-demo', { demo: true, status: 'doing' }),
    ]

    const goals: CollabGoal[] = [{
      id: 'g-1',
      title: '目标一',
      owner: 'me',
      status: 'open',
      created_at: AT,
      updated_at: AT,
    }]

    const summary: ProgressSummaryModel = summarizeProgress({
      tasks,
      goals,
      runs: [{ task_id: 't-running', source: 'codex', started_at: AT, status: 'running' }],
      nowMs: Date.parse(AT),
    })

    expect(summary.counts.delivered).toBe(1)
    expect(summary.counts.accepted).toBe(1)
    expect(summary.counts.review).toBe(1)
    expect(summary.counts.running).toBe(1)
    expect(summary.counts.waiting_receipt).toBe(1)
    expect(summary.counts.blocked).toBe(1)
    expect(summary.counts.unstarted).toBe(1)
    expect(summary.counts.canceled).toBe(1)
    expect(summary.demoCount).toBe(1)

    // 剩余工作 = accepted(待交付) + review + running + waiting_receipt + blocked + unstarted = 6
    // 注意: delivered 为已可用不计入剩余；canceled 单列不计入剩余
    expect(summary.counts.remaining).toBe(6)

    // 检查列表定位数据
    expect(summary.groups.delivered).toHaveLength(1)
    expect(summary.groups.accepted).toHaveLength(1)
    expect(summary.groups.review).toHaveLength(1)
    expect(summary.groups.running).toHaveLength(1)
    expect(summary.groups.waiting_receipt).toHaveLength(1)
    expect(summary.groups.blocked).toHaveLength(1)
    expect(summary.groups.unstarted).toHaveLength(1)
    expect(summary.groups.canceled).toHaveLength(1)

    // 受阻任务带有原因
    expect(summary.groups.blocked[0]?.waitReason).toBe('等审批')
  })

  it('目标能力条件提取：从所属任务的 acceptance 提取，未声明的标明尚未安排', () => {
    const tasks: TaskView[] = [
      makeTask('t1', {
        goal_id: 'g-1',
        acceptance: ['第一条条件通过', '第二条条件验证'],
        status: 'confirm',
      }),
      makeTask('t2', {
        goal_id: 'g-1',
        status: 'todo',
      }),
    ]

    const goals: CollabGoal[] = [{
      id: 'g-1',
      title: '核心链路打通',
      owner: 'me',
      status: 'open',
      created_at: AT,
      updated_at: AT,
    }]

    const summary = summarizeProgress({
      tasks,
      goals,
      filter: { goal: ['g-1'] },
      nowMs: Date.parse(AT),
    })

    expect(summary.scopeName).toBe('目标: 核心链路打通')
    expect(summary.capabilityConditions).toHaveLength(3) // 2 条有明确描述 + 1 条 t2 未写条件
    expect(summary.capabilityConditions[0]?.text).toBe('第一条条件通过')
    expect(summary.capabilityConditions[0]?.taskTitle).toBe('t1')
    expect(summary.capabilityConditions[2]?.text).toContain('未声明验收条件')
    expect(summary.capabilityConditions[2]?.unassigned).toBe(true)
  })

  it('旧快照检测：当服务端快照时间落后于当前时间 60 秒以上，标记快照过旧', () => {
    const tasks = [makeTask('t1')]
    const summary = summarizeProgress({
      tasks,
      serverNow: AT,
      nowMs: Date.parse(AT) + 120_000,
    })
    expect(summary.snapshotStale).toBe(true)
  })

  it('已取消事项不产出「尚未安排」验收条件噪音（取消单列，不进条件清单）', () => {
    const tasks: TaskView[] = [
      makeTask('t-live', { acceptance: ['活着的条件'] }),
      makeTask('t-dead', { status: 'canceled' }),
    ]
    const summary = summarizeProgress({ tasks, nowMs: Date.parse(AT) })
    expect(summary.capabilityConditions).toHaveLength(1)
    expect(summary.capabilityConditions[0]?.taskId).toBe('t-live')
  })
})

describe('progressModel: 统计范围名称提取 (extractScopeName)', () => {
  it('指定目标时展示目标名，指定冲刺展示冲刺名，全部展示全部事项', () => {
    const goals: CollabGoal[] = [{ id: 'g-1', title: '目标A', owner: 'me', status: 'open', created_at: AT, updated_at: AT }]
    const sprints: CollabSprint[] = [{ id: 's-1', title: '冲刺一', goal_ids: ['g-1'], created_at: AT, updated_at: AT }]

    expect(extractScopeName({ goal: ['g-1'] }, goals, sprints)).toBe('目标: 目标A')
    expect(extractScopeName({ sprint: ['s-1'] }, goals, sprints)).toBe('冲刺: 冲刺一')
    expect(extractScopeName({ project: ['proj-1'] }, goals, sprints)).toBe('项目: proj-1')
    expect(extractScopeName({}, goals, sprints)).toBe('全部事项')
  })

  it('按负责人筛选时范围名说负责人，不再冒充「全部事项」', () => {
    expect(extractScopeName({ assignee: ['codex'] })).toBe('负责人: Codex')
  })

  it('按类型 / 标签 / 属性筛选时范围名说清各自维度', () => {
    expect(extractScopeName({ type: ['研发'] })).toBe('类型: 研发')
    expect(extractScopeName({ label: ['bug'] })).toBe('标签: bug')
    expect(extractScopeName({ prop: ['渠道=小红书'] })).toBe('属性: 渠道=小红书')
  })

  it('多维度组合时各维度都列出，范围名与筛选条件同源', () => {
    expect(extractScopeName({ assignee: ['codex'], label: ['bug'] })).toBe('负责人: Codex；标签: bug')
  })
})
