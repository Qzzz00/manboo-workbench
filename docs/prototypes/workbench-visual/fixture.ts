import type { WorkbenchState } from '../../../workbench-plugin/src/protocol.ts'
import { DEFAULT_LAYOUT } from '../../../workbench-plugin/src/client/layout.ts'

export function previewState(): WorkbenchState {
  const now = '2026-09-15T14:20:00+08:00'
  const names = ['desktop-workbench', 'KOUKOU', 'miniprogram-3', 'miniprogram-4', 'Echo']
  const statuses = ['把手机端的第一条链路走通。', '课程内容已整理，等最后一轮确认。', '原型已完成，正在补齐空状态。', '', '校对完成，下一步是验证真实入口。']
  return {
    agents: [
      { id: 'dsh', online: true, connected: true, waiting: 0, running: 0 },
      { id: 'claude', online: true, connected: true, waiting: 1, running: 0 },
      { id: 'codex', online: true, connected: true, waiting: 0, running: 2 },
      { id: 'kimi', online: false, connected: false, waiting: 0, running: 0 },
    ],
    sessions: [], now, stale: false,
    quota: {
      dsh: { kind: 'balance', currency: 'CNY', total: '93.75', available: true },
      claude: { kind: 'quota', windows: [{ label: '5h', left_pct: 90 }, { label: '周', left_pct: 38 }] },
      codex: { kind: 'quota', windows: [{ label: '周', left_pct: 59 }] },
    },
    machine: { disk_pct: 84, disk_free_gb: 68, mem_gb: 16, cpu_idle_pct: 52, sampled_at: now },
    helper: { connected: false, authorized: false, reason: '仅视觉预览，未连接原生客户端' },
    layout: { ...DEFAULT_LAYOUT, modules: DEFAULT_LAYOUT.modules.map(module => ({ ...module })) },
    dock: { stack: ['Claude', 'Codex', 'Kimi', '企业微信', '微信', 'NetEaseMusic', '日历', 'Notion'].map(label => ({ key: label.toLowerCase(), label, running: label !== 'Kimi', current: label === 'Codex' })) },
    // 2026-09-21:补两条示例布局 —— 场景条(竖屏在窗位槽里、横屏收在左栏那颗「窗口布局」)
    // 原来在预览里永远缺席,截图上看不出它长什么样。名字与时间同样是假的。
    scenes: [
      { id: 'demo-code', name: '写代码', app_count: 3, saved_at: '2026-09-20T09:12:00+08:00' },
      { id: 'demo-talk', name: '开会', app_count: 2, saved_at: '2026-09-19T14:40:00+08:00' },
    ],
    projects: {
      projects: names.map((name, index) => ({
        id: `preview-project-${index}`, name, stage: index === 1 ? '需求梳理' : 'MVP 开发', links: [], session_count: index === 0 ? 3 : 0, idle: false,
        signals: { branch: 'main', dirty_count: [28, 0, 9, 174, 10][index] ?? 0, worktrees: index === 0 ? 10 : 0, cleanup_count: index === 0 ? 24 : 0, idle_days: index === 4 ? 5 : 0 },
        ...(statuses[index] ? { status: { text: statuses[index]!, review: 'confirmed' as const, author: '维护者', updated_at: now, stale: index === 4 } } : {}),
        risk: { level: index === 1 ? 'tight' : 'unknown', reason: index === 1 ? '还有两处内容需要确认' : '示例数据不足以判断排期', window_days: 14 },
      })),
      pending: [], scan_errors: [], scanned_at: now,
    },
    usage: {
      days: Array.from({ length: 30 }, (_, index) => {
        const date = new Date(Date.UTC(2026, 7, 17 + index)).toISOString().slice(0, 10)
        const patterns = [
          [0, .04, .09, .18, .28, .45, .58, .75, 1, .35],
          [.45, .09, 0, .75, .28, .04, 1, .58, .18, .35],
          [.18, .58, .04, .35, 0, .28, .75, .09, .45, 1],
        ]
        const intensity = patterns[Math.floor(index / 10)]![index % 10]!
        const scale = (value: number) => Math.round(value * intensity)
        const totals = { input: scale(3_200_000), output: scale(2_250_000), cache_write: scale(1_060_000), cache_read: scale(215_000_000) }
        return { date, by_project: { 'desktop-workbench': totals }, by_model: { 'gpt-5.6-sol': totals }, by_source: { codex: totals }, sessions: scale(19), messages: scale(1520), hour_counts: { '11': scale(8), '14': scale(4) } }
      }),
      sources: { codex: { status: 'ok' }, kimi: { status: 'error', note: '示例未接入' } }, scanned_at: now,
    },
    notes: [
      { id: 'preview-note-1', text: 'The AI-Native SDLC Playbook', created_at: now },
      { id: 'preview-note-2', text: '先把一条完整链路走通，再扩展能力。', created_at: now },
    ],
  }
}

export function previewBoardState(): WorkbenchState {
  const state = previewState()
  const at = state.now
  state.layout = { ...state.layout!, projects_view: 'board' }
  state.tasks = {
    sprints: [{ id: 'preview-sprint', project_id: 'preview-project-0', name: '桌面体验精修', goal: '把常用入口收敛到一张工作台', versions: [{ label: '客户端', version: '0.2.25' }], starts_at: '2026-09-10', ends_at: '2026-09-22', created_at: at, updated_at: at }],
    modules: [{ id: 'preview-module', sprint_id: 'preview-sprint', name: '工作台界面', goal: '卡片与普通控件保持同套材质', created_at: at, updated_at: at }],
    project_meta: [{ project_id: 'preview-project-0', priority: 'mid', assignee: 'codex' }],
    tasks: ([
      { id: 'preview-doing', title: '统一工作台卡片材质', desc: '统一项目、统计与事项卡片的信息层级，保留原来的工作习惯。', status: 'doing', priority: 'mid', assignee: 'codex', links: [{ agent: 'codex', session_id: 'preview-session-doing', note: '统一卡片与控件视觉' }] },
      { id: 'preview-confirm', title: '确认手机端第一条链路', desc: '从手机配对到结果回传，第一条完整链路已整理，等你检查交付。', status: 'confirm', priority: 'high', assignee: 'dsh', conversation: { agent: 'dsh', session_id: 'preview-session-confirm' } },
      { id: 'preview-done', title: '整理项目交接说明', desc: '已整理入口、当前结论与待办，下一次接手可以从这里继续。', status: 'done', priority: 'low', assignee: 'claude', links: [{ agent: 'claude', session_id: 'preview-session-done' }] },
      { id: 'preview-blocked', title: '等待本机入口验证', desc: '需要你确认真机测试的时间。事项保留，当前没有继续执行。', status: 'blocked', priority: 'mid', assignee: 'codex', block_reason: 'input', links: [{ agent: 'codex', session_id: 'preview-session-blocked' }] },
    ] as const).map(task => ({ ...task, direction: 'mine', project_id: 'preview-project-0', module_id: 'preview-module', due: '2026-09-22', source: { kind: 'manual' }, created_at: at, updated_at: at })),
  }
  state.sessions = ([
    { agent: 'codex', session_id: 'preview-session-doing', status: 'running', title: '统一卡片与控件视觉', unread: false },
    { agent: 'dsh', session_id: 'preview-session-confirm', status: 'waiting', title: '检查手机端交付', unread: true, wait_reason: 'approval' },
    { agent: 'claude', session_id: 'preview-session-done', status: 'done', title: '整理项目交接说明', unread: true },
    { agent: 'codex', session_id: 'preview-session-blocked', status: 'waiting', title: '等待本机验证时间', unread: false, wait_reason: 'input' },
  ] as const).map(session => ({ ...session, project: 'desktop-workbench', elapsed_sec: 120, updated_at: at }))
  state.butler_inbox = { items: [{ id: 'confirm:preview-confirm', kind: 'confirm', task_id: 'preview-confirm', title: '确认手机端第一条链路', note: '第一条链路的交付，等你看一眼。', status: 'confirm', at, conversation: { agent: 'dsh', session_id: 'preview-session-confirm' } }] }
  return state
}

export function previewButlerState(empty = false, executionCount?: number): WorkbenchState {
  const state = previewBoardState()
  const at = state.now
  state.dock = { stack: state.dock!.stack.map(tab => ({ ...tab, current: false })) }
  if (empty) {
    state.tasks = { ...state.tasks!, tasks: [] }
    state.butler_inbox = { items: [] }
    state.sessions = []
  } else {
    state.tasks = { ...state.tasks!, tasks: [...state.tasks!.tasks, ...([
      { id: 'preview-parallel', title: '校对课程成果汇报', desc: 'Claude 整理内容，Codex 检查引用；两个执行者协作完成同一件事。', status: 'doing', priority: 'mid', assignee: 'claude', links: [{ agent: 'claude', session_id: 'preview-session-parallel' }, { agent: 'codex', session_id: 'preview-session-review' }] },
      { id: 'preview-queued', title: '补齐下一轮验收清单', desc: '已记下，尚未分配执行会话，不代表 Agent 正在处理。', status: 'todo', priority: 'low', assignee: 'codex' },
      { id: 'preview-failed', title: '交付归档没有完成', desc: '示例执行会话明确返回错误；保留现场，等待处理。', status: 'blocked', block_reason: 'error', priority: 'mid', assignee: 'claude', links: [{ agent: 'claude', session_id: 'preview-session-failed' }] },
      { id: 'preview-canceled', title: '取消旧版封面方案', desc: '已取消，不是执行失败，也不再计入待办。', status: 'canceled', priority: 'low', assignee: 'claude' },
    ] as const).map(task => ({ ...task, direction: 'mine' as const, project_id: 'preview-project-0', module_id: 'preview-module', source: { kind: 'manual' as const }, created_at: at, updated_at: at }))] }
    state.sessions = [...state.sessions, ...([
      { agent: 'claude', session_id: 'preview-session-parallel', status: 'running', title: '校对汇报正文', unread: false },
      { agent: 'codex', session_id: 'preview-session-review', status: 'running', title: '检查引用', unread: false },
      { agent: 'claude', session_id: 'preview-session-failed', status: 'error', wait_reason: 'error', title: '交付归档失败', unread: true },
    ] as const).map(session => ({ ...session, project: 'desktop-workbench', elapsed_sec: 90, updated_at: at }))]
  }
  if (!empty && executionCount !== undefined) {
    const running = state.tasks!.tasks.filter(task => task.status === 'doing')
    const count = Math.max(0, Math.min(9, Math.round(executionCount)))
    const names = ['校验接口返回', '补齐空状态', '整理通话记录', '检查手机端链路', '生成今日摘要', '同步交付清单', '复核异常日志']
    const tasks = Array.from({ length: count }, (_, index) => running[index] ?? {
      ...running[0]!, id: `preview-extra-${index}`, title: names[index - 2]!, desc: '固定示例：这一件事独立执行，不连接真实客户端。',
      links: [{ agent: index % 2 === 0 ? 'codex' as const : 'claude' as const, session_id: `preview-extra-session-${index}` }],
    })
    const oldLinks = new Set(running.flatMap(task => task.links?.map(link => link.session_id) ?? []))
    const runningSessions = tasks.flatMap(task => task.links!.map(link => state.sessions.find(session => session.session_id === link.session_id) ?? {
      agent: link.agent, session_id: link.session_id, status: 'running' as const, title: task.title, project: 'desktop-workbench', elapsed_sec: 30, unread: false, updated_at: at,
    }))
    state.tasks = { ...state.tasks!, tasks: [...state.tasks!.tasks.filter(task => task.status !== 'doing'), ...tasks] }
    state.sessions = [...state.sessions.filter(session => !oldLinks.has(session.session_id)), ...runningSessions]
  }
  state.agents = state.agents.map(agent => ({
    ...agent,
    running: state.sessions.filter(session => session.agent === agent.id && session.status === 'running').length,
    waiting: state.sessions.filter(session => session.agent === agent.id && session.status === 'waiting').length,
  }))
  return state
}

export function createPreviewFetch(state: WorkbenchState, notify?: (message: string) => void): typeof fetch {
  return async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    if (url.origin !== 'https://preview.invalid') return Response.json({ error: '预览拒绝访问真实服务' }, { status: 403 })
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
    if (method !== 'GET') {
      const message = '仅视觉预览：此操作未执行，也没有发送到客户端。'
      if (!['/dock/rect', '/files/rect', '/dock/hover', '/layout'].includes(url.pathname)) notify?.(message)
      return Response.json({ error: message }, { status: 501 })
    }
    if (url.pathname === '/state') return Response.json(state)
    if (url.pathname === '/wiki/graph') return Response.json({
      version: 'preview', width: 500, height: 340, truncated: 0,
      nodes: [
        { id: 'p0', kind: 'project', label: 'desktop-workbench', path: '/preview/desktop-workbench', project_id: 'preview-project-0', x: 240, y: 164, r: 148, depth: 0 },
        ...['docs', 'workbench-plugin', 'display-client'].map((label, index) => ({ id: `dir-${index}`, kind: 'dir', label, path: `/preview/desktop-workbench/${label}`, project_id: 'preview-project-0', x: [179, 305, 225][index], y: [120, 140, 240][index], r: [56, 64, 50][index], depth: 1 })),
      ], notes: ['固定示例图谱；没有读取本机文件。'],
    })
    return Response.json({ error: '预览未提供该接口' }, { status: 404 })
  }
}
