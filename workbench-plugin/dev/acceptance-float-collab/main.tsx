import { useState, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import type { AgentCard, CollabGoal, CollabPresence, TaskView, WorkbenchState } from '../../src/protocol.ts'
import { Butler } from '../../src/client/Butler.tsx'
import { ButlerInbox, type ButlerControls } from '../../src/client/ButlerInbox.tsx'
import { CollabZone } from '../../src/client/collab/CollabZone.tsx'
import { STYLE } from '../../src/client/style.ts'
import { COLLAB_STYLE } from '../../src/client/collab/collabStyle.ts'
import { MONO_STYLE } from '../../src/client/monoStyle.ts'
import { PARTICLE_STYLE } from '../../src/client/particleStyle.ts'
import 'dsh-ui-theme/base.css'
import 'dsh-ui-theme/design-platform.css'

const AT = '2026-10-22T10:00:00.000Z'
const today = new Date()
const dayAt = (offset: number, hm: string): string => {
  const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset)
  const [h, m] = hm.split(':').map(Number) as [number, number]
  d.setHours(h, m, 0, 0)
  return d.toISOString()
}

const kimiCard: AgentCard = {
  id: 'agent:me:kimi-1',
  name: '小K',
  owner: 'me',
  hand: 'kimi',
  runtime: { family: 'kimi' },
  model: { name: 'kimi-latest' },
  shared: { to: 'workspace' },
  created_at: AT,
  updated_at: AT,
}

const fridayGoal: CollabGoal = {
  id: 'g-friday',
  title: '周五(10-24)把仓库交接给研发',
  why: '按期交付',
  owner: 'me',
  status: 'open',
  created_at: AT,
  updated_at: AT,
}

const nextGoal: CollabGoal = {
  id: 'g-next',
  title: '下周目标：端到端连通验证',
  why: '提升可用性',
  owner: 'me',
  status: 'open',
  created_at: AT,
  updated_at: AT,
}

const fridayNotes: TaskView[] = Array.from({ length: 12 }, (_, i) => ({
  id: `fn-${i + 1}`,
  title: `事项 ${i + 1}：${['梳理核心模块', '整理配置文件', '清理调试日志', '补全验收文档', '交接环境准备', '确认分支策略', '打包验证测试', '准备测试数据', '跑通全量用例', '修复边界异常', '编写交接记录', '最终统筹检查'][i]}`,
  status: i < 5 ? 'done' : 'todo',
  goal_id: 'g-friday',
  source: { kind: 'manual' },
  created_at: dayAt(0, `09:${String(i * 5).padStart(2, '0')}`),
  updated_at: AT,
}))

const tasks: TaskView[] = [
  {
    id: 't-codex',
    title: 'Codex 编写的自动化测试与类型修复',
    status: 'doing',
    assignee: 'codex',
    goal_id: 'g-next',
    start: dayAt(0, '10:00'),
    end: dayAt(0, '11:15'),
    work_type: 'dev',
    source: { kind: 'manual' },
    created_at: AT,
    updated_at: AT,
  },
  {
    id: 't-kimi',
    title: '小K 负责的命令行智能体派活与回执',
    status: 'confirm',
    assignee: 'agent:me:kimi-1',
    goal_id: 'g-next',
    start: dayAt(0, '11:30'),
    end: dayAt(0, '12:45'),
    work_type: 'dev',
    source: { kind: 'manual' },
    created_at: AT,
    updated_at: AT,
  },
  {
    id: 't-long-1',
    title: '钩子备份同秒不再互盖：这是一个超长的三行标题便签内容用来验证高度与下排卡片不重叠',
    status: 'todo',
    goal_id: 'g-next',
    assignee: 'codex',
    source: { kind: 'manual' },
    created_at: dayAt(0, '10:00'),
    updated_at: AT,
  },
  {
    id: 't-long-2',
    title: '下一张紧挨着的便签卡片：应当平滑排在下方且完全不与上方长标题卡片产生重叠',
    status: 'todo',
    goal_id: 'g-next',
    assignee: 'agent:me:kimi-1',
    source: { kind: 'manual' },
    created_at: dayAt(0, '10:05'),
    updated_at: AT,
  },
  ...fridayNotes,
]

const baseState: WorkbenchState = {
  now: AT,
  agents: [],
  sessions: [
    {
      agent: 'codex',
      session_id: 's-1',
      project: 'workbench',
      status: 'running',
      elapsed_sec: 1200,
      unread: false,
      updated_at: AT,
      title: '浮窗两态与协作区头像渲染',
    },
  ],
  quota: {},
  stale: false,
  tasks: {
    tasks,
    sprints: [],
    modules: [],
    project_meta: [],
    goals: [fridayGoal, nextGoal],
    goal_sprints: [],
    agent_cards: [kimiCard],
    avatars: {
      me: { kind: 'preset', id: 'human-1' },
    },
    session_proposals: [],
  },
  meetings: { recent: [] },
  agent_registry: {
    entries: [
      { id: 'dsh', name: '事务官', self: true, status: 'idle', icon: true, sessions: [] },
      { id: 'codex', name: 'Codex', status: 'running', color: '#7ee787', icon: true, sessions: [] },
      { id: 'claude', name: 'Claude', status: 'idle', color: '#e8a273', icon: true, sessions: [] },
      { id: 'kimi', name: 'Kimi', status: 'idle', color: '#7b5eea', icon: true, sessions: [] },
    ],
    asking: [],
    notices: [],
  },
} as unknown as WorkbenchState

const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input), location.href)
  const ok = (json: unknown = { ok: true }): Response =>
    new Response(JSON.stringify(json), { headers: { 'content-type': 'application/json' } })
  if (url.pathname === '/collab/canvas') return ok({ layout: { goals: {}, notes: {} } })
  return ok()
}) as typeof fetch

function App() {
  const query = new URLSearchParams(location.search)
  const scenario = query.get('scenario') ?? '01-butler-ball'
  const [min, setMin] = useState(scenario === '01-butler-ball')
  const [draft, setDraft] = useState('')
  // 展开态身里放的就是窗口槽里那页事务官(同一个组件,假数据走它的 props;
  // 样式全是它自己注入的 PARTICLE_STYLE 等真实样式表,看样台不另画一块)。
  const butlerControls: ButlerControls = {
    paused: false,
    testRinging: false,
    onPause: () => {},
    onTestRing: () => {},
    onCancelWatch: () => {},
    onDismissBrief: () => {},
    proposals: [],
  }

  useEffect(() => {
    // If popover requested for ball state
    if (scenario === '01-butler-ball' && query.get('popover') === '1') {
      setTimeout(() => {
        const ball = document.querySelector('.ben-wb__butler-ball-btn')
        if (ball) ball.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
      }, 50)
    }

    // For dialog-closed scenario, open the floating rail on narrow width so it is shown
    if (scenario === '02-dialog-closed') {
      setTimeout(() => {
        const toggle = document.querySelector('.ben-cl__rail-toggle') as HTMLElement | null
        if (toggle) toggle.click()
      }, 50)
    }

    // For dialog-open scenario, open floating rail then click 换头像
    if (scenario === '02-dialog-open') {
      setTimeout(() => {
        const toggle = document.querySelector('.ben-cl__rail-toggle') as HTMLElement | null
        if (toggle) toggle.click()
        setTimeout(() => {
          const editBtns = document.querySelectorAll('.ben-cl__card-edit')
          const kimiEditBtn = Array.from(editBtns).find(b => b.getAttribute('aria-label')?.includes('小K')) as HTMLElement | null
          if (kimiEditBtn) kimiEditBtn.click()
          else if (editBtns[0]) (editBtns[0] as HTMLElement).click()
        }, 50)
      }, 50)
    }
  }, [scenario])

  return (
    <div className="ben-wb" style={{ width: '100%', height: '100%', position: 'relative' }}>
      {/* 场景 1: 浮窗球态 */}
      {scenario === '01-butler-ball' && (
        <div style={{ position: 'relative', width: '100%', height: '100%' }}>
          <div style={{ padding: '24px', color: '#8b949e', fontSize: '14px' }}>
            <h2 style={{ color: '#fff', margin: '0 0 8px 0' }}>事务官浮窗 · 球态 (96px 直径)</h2>
            <p style={{ margin: 0 }}>收起态为 96px 直径粒子声纹球，右键或长按弹出叫停入口（全部暂停 / 试铃）</p>
          </div>
          <Butler
            conclusions={['正在执行 1 件', '浮窗两态打磨']}
            corner="br"
            min={true}
            narrowForced={false}
            paused={false}
            testRinging={false}
            onToggleMin={() => setMin(!min)}
            onMove={() => {}}
            onResize={() => {}}
            onPause={() => {}}
            onTestRing={() => {}}
          />
        </div>
      )}

      {/* 场景 1: 浮窗展开态 */}
      {scenario === '01-butler-expanded' && (
        <div style={{ position: 'relative', width: '100%', height: '100%' }}>
          <div style={{ padding: '24px', color: '#8b949e', fontSize: '14px' }}>
            <h2 style={{ color: '#fff', margin: '0 0 8px 0' }}>事务官浮窗 · 展开态 (最小 520 × 680)</h2>
            <p style={{ margin: 0 }}>身里就是窗口槽那页事务官(ButlerInbox 原组件),样式走它自己的真实样式表</p>
          </div>
          <Butler
            conclusions={['正在执行 1 件']}
            corner="br"
            min={false}
            narrowForced={false}
            paused={false}
            testRinging={false}
            size={{ w_px: 520, h_px: 680 }}
            onToggleMin={() => setMin(true)}
            onMove={() => {}}
            onResize={() => {}}
            onPause={() => {}}
            onTestRing={() => {}}
            page={
              <ButlerInbox
                state={baseState}
                baseUrl=""
                fetchImpl={mockFetch}
                onOpenConversation={() => {}}
                draft={draft}
                onDraftChange={setDraft}
                visible
                controls={butlerControls}
              />
            }
          />
        </div>
      )}

      {/* 场景 2: 换头像面板打开 (名片列隐藏) */}
      {scenario === '02-dialog-open' && (
        <div style={{ position: 'relative', width: '100%', height: '100%' }}>
          <CollabZone
            state={baseState}
            baseUrl=""
            fetchImpl={mockFetch}
            presence={[]}
            visible
            timelineWidth={1100}
            width={1100}
            initialView="timeline"
          />
        </div>
      )}

      {/* 场景 2: 换头像面板关闭 (名片列恢复) */}
      {scenario === '02-dialog-closed' && (
        <div style={{ position: 'relative', width: '100%', height: '100%' }}>
          <CollabZone
            state={baseState}
            baseUrl=""
            fetchImpl={mockFetch}
            presence={[]}
            visible
            timelineWidth={1100}
            width={1100}
            initialView="timeline"
          />
        </div>
      )}

      {/* 场景 3: 负责人芯片展示各家 Logo */}
      {scenario === '03-agent-chips' && (
        <div style={{ position: 'relative', width: '100%', height: '100%' }}>
          <CollabZone
            state={baseState}
            baseUrl=""
            fetchImpl={mockFetch}
            presence={[]}
            visible
            timelineWidth={1400}
            initialView="timeline"
          />
        </div>
      )}

      {/* 场景 4: 画布便签标题超长不重叠 */}
      {scenario === '04-note-wrap' && (
        <div style={{ position: 'relative', width: '100%', height: '100%' }}>
          <CollabZone
            state={baseState}
            baseUrl=""
            fetchImpl={mockFetch}
            presence={[]}
            visible
            width={1400}
            initialView="goals"
          />
        </div>
      )}

      {/* 场景 5: 周五目标恢复，独立画框 */}
      {scenario === '05-friday-goal' && (
        <div style={{ position: 'relative', width: '100%', height: '100%' }}>
          <CollabZone
            state={baseState}
            baseUrl=""
            fetchImpl={mockFetch}
            presence={[]}
            visible
            width={1400}
            initialView="goals"
          />
        </div>
      )}
    </div>
  )
}

const styleEl = document.createElement('style')
styleEl.textContent = `${STYLE}\n${COLLAB_STYLE}\n${MONO_STYLE}\n${PARTICLE_STYLE}`
document.head.appendChild(styleEl)

createRoot(document.getElementById('app')!).render(<App />)
