/**
 * 协作区进展可读摘要看样/验收入口 (卡 D1 专用)。
 *
 * 两种模式，分层明确：
 * - 夹具模式 (?scenario=multi|zero|stale)：UI 喂手工夹具事实，覆盖父子/演示隔离/陈旧快照等边界；
 * - 真实 API 模式 (?live=1&api=...)：页面只认真实 WorkbenchServer 的 /state 快照，
 *   轮询自动刷新（断线保留上次已知），UI 与真 API 之间不隔任何夹具。
 */
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { CollabGoal, CollabPresence, CollabSprint, TaskView, WorkbenchState } from '../../src/protocol.ts'
import { CollabZone } from '../../src/client/collab/CollabZone.tsx'
import { STYLE } from '../../src/client/style.ts'

const LIVE_POLL_MS = 700

/** 真实 API 驱动：轮询服务端 /state，断线时保留上次已知快照（与生产行为一致）。 */
function useLiveState(apiBase: string | undefined): WorkbenchState | undefined {
  const [liveState, setLiveState] = useState<WorkbenchState | undefined>(undefined)
  useEffect(() => {
    if (apiBase === undefined) return undefined
    let alive = true
    const pull = async () => {
      try {
        const res = await fetch(`${apiBase}/state`)
        if (!res.ok) return
        const next = (await res.json()) as WorkbenchState
        if (alive) setLiveState(next)
      } catch {
        // 连不上就保留上次已知快照，不报错不清空。
      }
    }
    void pull()
    const timer = setInterval(() => { void pull() }, LIVE_POLL_MS)
    return () => { alive = false; clearInterval(timer) }
  }, [apiBase])
  return liveState
}

const AT = '2026-10-23T10:00:00.000Z'
const nowMs = Date.now()

const makeTask = (id: string, title: string, patch: Partial<TaskView> = {}): TaskView => ({
  id,
  title,
  status: 'todo',
  source: { kind: 'manual' },
  created_at: AT,
  updated_at: AT,
  ...patch,
})

const goals: CollabGoal[] = [
  { id: 'g1', title: '座机打通', why: '出门也能接', owner: 'me', status: 'open', created_at: AT, updated_at: AT },
  { id: 'g2', title: '早报改成播客', owner: 'me', status: 'open', created_at: AT, updated_at: AT },
]

const sprints: CollabSprint[] = [
  { id: 's1', title: '冲刺一：核心通路', goal_ids: ['g1'], created_at: AT, updated_at: AT },
]

function getTasksForScenario(scenario: string): TaskView[] {
  if (scenario === 'zero') return []

  return [
    makeTask('t-p', '任务组：核心通路搭建', {
      children: ['t-c1', 't-c2'],
      goal_id: 'g1',
    }),
    makeTask('t-c1', '子任务1：协议对接', {
      status: 'todo',
      goal_id: 'g1',
      acceptance: ['8791 接口响应正常', '通过健康检查'],
    }),
    makeTask('t-c2', '子任务2：真实执行中的流式解析', {
      status: 'doing',
      goal_id: 'g1',
      dispatch: { family: 'codex', status: 'running', started_at: AT },
      acceptance: ['流式吐字延迟低于 200ms'],
    }),
    makeTask('t-delivered', '选题发布：事务官座机介绍短片', {
      status: 'done',
      published_at: '2026-10-23',
      goal_id: 'g2',
      acceptance: ['视频发布至平台'],
    }),
    makeTask('t-accepted', '已验收待交付：音频降噪补丁', {
      status: 'done',
      done_at: AT,
      goal_id: 'g1',
      acceptance: ['通过回声消除测试'],
    }),
    makeTask('t-review', '交回待验：头像对齐与高光修正', {
      status: 'confirm',
      receipt: { kind: 'done', text: '已交回：完成计算样式对齐', at: AT },
      goal_id: 'g1',
      acceptance: ['像素对齐无偏差'],
    }),
    makeTask('t-queued', '已派活在排队：日志清洗任务', {
      status: 'doing',
      dispatch_lane: { family: 'claude', state: 'queued', since: AT, note: '正在排队等待窗口' },
      goal_id: 'g1',
    }),
    makeTask('t-waiting', '待执行回执：外部接口轮询', {
      status: 'doing',
      goal_id: 'g1',
    }),
    makeTask('t-blocked', '受阻事项：等待审批发布权限', {
      status: 'blocked',
      block_reason: 'approval',
      assignee: 'agent:local:kimi',
      goal_id: 'g1',
      acceptance: ['获得授权凭据'],
    }),
    makeTask('t-unstarted', '未开始：撰写使用手册', {
      status: 'todo',
      assignee: 'me',
      goal_id: 'g2',
    }),
    makeTask('t-canceled', '已取消：旧版兼容代码清理', {
      status: 'canceled',
      goal_id: 'g1',
    }),
    makeTask('t-demo', '演示任务：自动备份演示', {
      demo: true,
      status: 'doing',
      goal_id: 'g1',
    }),
  ]
}

function ProgressTestApp() {
  const params = new URLSearchParams(window.location.search)
  const scenario = params.get('scenario') || 'multi'
  const isStale = scenario === 'stale'
  const isFull = params.get('full') === '1'
  const live = params.get('live') === '1'
  const apiBase = live ? (params.get('api') ?? 'http://127.0.0.1:9093') : undefined
  const liveState = useLiveState(apiBase)

  const [currentTasks, setCurrentTasks] = useState<TaskView[]>(() => getTasksForScenario(scenario))
  const [layout, setLayout] = useState<unknown>({ goals: {}, notes: {} })

  useEffect(() => {
    // 注入全局样式
    const styleEl = document.createElement('style')
    styleEl.textContent = STYLE
    document.head.appendChild(styleEl)
    return () => { styleEl.remove() }
  }, [])

  const serverTime = isStale ? new Date(nowMs - 120_000).toISOString() : new Date(nowMs).toISOString()

  const state: WorkbenchState = {
    now: serverTime,
    agents: [],
    sessions: [
      { agent: 'codex', session_id: 's-live', project: 'workbench', status: 'running', title: '流式代码编写' } as never,
    ],
    quota: {},
    stale: false,
    tasks: {
      tasks: currentTasks,
      sprints,
      modules: [],
      project_meta: [],
      goals,
      goal_sprints: [],
      agent_cards: [
        {
          id: 'agent:local:kimi',
          name: 'Kimi 编程',
          owner: 'me',
          hand: 'cli',
          runtime: { family: 'kimi' },
          project: { repo: '/Users/example/Documents/GitHub/desktop-workbench' },
          skills: [],
          shared: { to: 'none' },
          created_at: AT,
          updated_at: AT,
        },
      ],
      session_proposals: [],
    },
    agent_registry: {
      entries: [
        { id: 'agent:local:kimi', name: 'Kimi', role: 'coder', runtime: 'local', status: 'active' },
      ],
      asking: [],
      notices: [],
    },
  }

  const fakeFetchImpl: typeof fetch = async (input, init) => {    const url = new URL(String(input), 'http://127.0.0.1:3293')
    const pathname = url.pathname
    const method = init?.method ?? 'GET'

    if (pathname === '/collab/canvas') {
      if (method === 'GET') return new Response(JSON.stringify({ layout }), { status: 200, headers: { 'content-type': 'application/json' } })
      if (method === 'POST') {
        const body = JSON.parse(String(init?.body)) as { layout: unknown }
        setLayout(body.layout)
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
    }

    if (pathname === '/task/move' && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as { id: string, status: string }
      setCurrentTasks(prev => prev.map(t => t.id === body.id ? { ...t, status: body.status as never } : t))
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })
    }

    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })
  }

  // —— 真实 API 模式：整份 CollabZone 只吃真实 /state，fetch 不打断、不夹具 ——
  if (live) {
    if (liveState === undefined || apiBase === undefined) {
      return <div style={{ color: '#888', padding: 24, fontFamily: 'system-ui' }}>正在连接真实工作台服务…</div>
    }
    return (
      <div style={{ position: 'relative', width: '100%', height: '100%' }}>
        <CollabZone
          state={liveState}
          baseUrl={apiBase}
          fetchImpl={fetch}
          presence={[]}
          visible={true}
          initialView="goals"
          nowMs={Date.now()}
          {...(isFull ? { onExitFull: () => {} } : { onExpand: () => {} })}
        />
      </div>
    )
  }

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <CollabZone
        state={state}
        baseUrl="http://127.0.0.1:3293"
        fetchImpl={fakeFetchImpl}
        presence={[]}
        visible={true}
        initialView="goals"
        nowMs={nowMs}
        {...(isFull ? { onExitFull: () => {} } : { onExpand: () => {} })}
      />
    </div>
  )
}

const container = document.getElementById('app')
if (container) {
  createRoot(container).render(<ProgressTestApp />)
}
