import { useState, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import type { AgentCard, TaskView, WorkbenchState } from '../../src/protocol.ts'
import { Butler } from '../../src/client/Butler.tsx'
import { floatOrbView } from '../../src/client/floatOrb.ts'
import { ButlerInbox, type ButlerControls } from '../../src/client/ButlerInbox.tsx'
import { STYLE } from '../../src/client/style.ts'
import { PARTICLE_STYLE } from '../../src/client/particleStyle.ts'
import { BUTLER_LAYOUT_STYLE, BUTLER_COMPOSER_STYLE } from '../../src/client/butlerLayoutStyle.ts'
import 'dsh-ui-theme/base.css'
import 'dsh-ui-theme/design-platform.css'

const AT = '2026-10-23T10:00:00.000Z'

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

const claudeCard: AgentCard = {
  id: 'agent:me:claude-1',
  name: 'Claude 助手',
  owner: 'me',
  hand: 'claude',
  runtime: { family: 'claude' },
  model: { name: 'claude-3-5-sonnet' },
  shared: { to: 'workspace' },
  created_at: AT,
  updated_at: AT,
}

const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input), location.href)
  const ok = (json: unknown = { ok: true }): Response =>
    new Response(JSON.stringify(json), { headers: { 'content-type': 'application/json' } })

  // 场景 3: 交办请求挂起以展示持续发送与Composer走光态
  if (url.pathname === '/butler/item') {
    return new Promise(() => {})
  }
  // 10-27:交代后服务端回「已处理」的那种回执(维护者在装机版浮窗撞到的那一块),看它收成一行、不挤滚动区。
  if (url.pathname === '/butler/say') {
    return ok({ say_id: 'say-demo', say: { screen: '把 Kimi 的 token 用量接进「消耗数据」面板,任务书在仓库,按验收条件核。' }, items: [{ title: '用量接进消耗面板', status: 'done' }, { title: '派给 Kimi', status: 'done' }] })
  }
  if (url.pathname === '/collab/canvas') return ok({ layout: { goals: {}, notes: {} } })
  if (url.pathname.startsWith('/particle/settings')) return ok({ preset: { id: 'default', label: '默认', settings: {} }, paused: false })
  if (url.pathname === '/pause' || url.pathname === '/ring/test') return ok({ ok: true })
  return ok({ ok: true })
}) as typeof fetch

function makeState(scenario: string): WorkbenchState {
  const baseTasks: TaskView[] = [
    {
      id: 't-1',
      title: '梳理核心模块与配置',
      status: 'doing',
      direction: 'mine',
      source: { kind: 'manual' },
      created_at: AT,
      updated_at: AT,
    } as TaskView,
  ]

  const multiTasks: TaskView[] = [
    {
      id: 't-1',
      title: '梳理核心模块与配置',
      status: 'doing',
      direction: 'mine',
      source: { kind: 'manual' },
      created_at: AT,
      updated_at: AT,
    } as TaskView,
    {
      id: 't-2',
      title: '验证520x680浮窗滚动与独立弹性',
      status: 'doing',
      direction: 'mine',
      source: { kind: 'manual' },
      created_at: AT,
      updated_at: AT,
    } as TaskView,
    {
      id: 't-3',
      title: '多智能体长文本汇报与事实链路归档',
      status: 'confirm',
      direction: 'mine',
      source: { kind: 'manual' },
      created_at: AT,
      updated_at: AT,
    } as TaskView,
    {
      id: 't-4',
      title: '清理多余的构建与历史临时产物',
      status: 'todo',
      direction: 'mine',
      source: { kind: 'manual' },
      created_at: AT,
      updated_at: AT,
    } as TaskView,
    {
      id: 't-5',
      title: '准备外部研发交接文档与用例',
      status: 'todo',
      direction: 'mine',
      source: { kind: 'manual' },
      created_at: AT,
      updated_at: AT,
    } as TaskView,
  ]

  const askingQuestions = scenario === '02-narrow-520x680-asks-glowing' ? [
    {
      session_id: 's-q-waiting',
      tool_call_id: 'tc-1',
      questions: [{ question: '当前脚本需改动本地配置,是否确认继续？' }],
    } as never,
  ] : []

  const registryAsking = scenario === '02-narrow-520x680-asks-glowing' ? [
    {
      agent: 'codex',
      session_id: 's-q-waiting',
      tool_call_id: 'tc-1',
      questions: [{ question: '当前脚本需改动本地配置,是否确认继续？' }],
    } as never,
  ] : []

  const waitingState = scenario === '02-narrow-520x680-asks-glowing' ? {
    count: 1,
    items: [
      {
        kind: 'question',
        key: 'question:s-q-waiting',
        question: {
          session_id: 's-q-waiting',
          tool_call_id: 'tc-1',
          questions: [{ question: '当前脚本需改动本地配置,是否确认继续？' }],
        },
      },
    ],
  } : {
    count: 0,
    items: [],
  }

  const sessions = scenario === '04-narrow-520x680-multicards-scroll' ? [
    { agent: 'codex', session_id: 's-1', project: 'workbench', status: 'running', elapsed_sec: 140, unread: false, updated_at: AT, title: 'Codex 自动化构建测试' },
    { agent: 'kimi', session_id: 's-2', project: 'workbench', status: 'running', elapsed_sec: 80, unread: false, updated_at: AT, title: '小K 命令行分析' },
    { agent: 'claude', session_id: 's-3', project: 'workbench', status: 'idle', elapsed_sec: 420, unread: false, updated_at: AT, title: 'Claude 架构审查' },
    { agent: 'doubao', session_id: 's-4', project: 'workbench', status: 'idle', elapsed_sec: 600, unread: false, updated_at: AT, title: '豆包 资料收集' },
  ] : [
    { agent: 'codex', session_id: 's-1', project: 'workbench', status: 'running', elapsed_sec: 60, unread: false, updated_at: AT, title: '正在执行任务' },
  ]

  return {
    now: AT,
    agents: [],
    sessions: sessions as never,
    quota: {},
    stale: false,
    tasks: {
      tasks: (scenario === '04-narrow-520x680-multicards-scroll' || scenario === '06-fullscreen-1475x812') ? multiTasks : baseTasks,
      sprints: [],
      modules: [],
      project_meta: [],
      agent_cards: [kimiCard, claudeCard],
    },
    butler_inbox: {
      items: [],
      unread_count: 0,
      updated_at: AT,
    },
    questions: askingQuestions,
    waiting: waitingState,
    agent_registry: {
      entries: [
        { id: 'dsh', name: '事务官', self: true, status: 'idle', icon: true, sessions: [] },
        { id: 'codex', name: 'Codex', status: 'running', color: '#7ee787', icon: true, sessions: ['s-1'] },
        { id: 'kimi', name: 'Kimi', status: 'running', color: '#7b5eea', icon: true, sessions: ['s-2'] },
        { id: 'claude', name: 'Claude', status: 'idle', color: '#e8a273', icon: true, sessions: ['s-3'] },
      ],
      asking: registryAsking,
      notices: [],
    },
    first_use: {
      step: 'ready',
      done: true,
      ready: true,
      seen_at: AT,
      paths: [],
    } as never,
  } as unknown as WorkbenchState
}

function App() {
  const query = new URLSearchParams(location.search)
  const scenario = query.get('scenario') ?? '01-narrow-520x680-idle'
  const isFullscreen = scenario === '06-fullscreen-1475x812'
  const isTyping = scenario === '03-narrow-520x680-typing-glowing'

  const [draft, setDraft] = useState(isTyping ? '请分析一下昨天的协作数据并输出总结报告' : '')
  const [min, setMin] = useState(new URLSearchParams(location.search).get('min') === '1')
  const [paused, setPaused] = useState(false)
  const [ringing, setRinging] = useState(false)

  // 10-27:悬浮球带状态与展开窗小窗版。?compact=1 用小窗版;?ball=waiting 给球一份「等你 3 件、有回复」的服务端那一格。
  const compact = query.get('compact') === '1'
  const baseState = makeState(scenario)
  const state: WorkbenchState = query.get('ball') === 'waiting'
    ? { ...baseState, orb: { notice: 'confirmation', working: true, blocked: 1, active_failure: false, waiting: true, calling: false, answer: true, fresh_result: true }, waiting: { count: 3, items: [{ key: 'question:1', kind: 'question', text: '需要你确认:Kimi 预计还需 ¥3.2' }, { key: 'approval:2', kind: 'approval', text: '等你批:Codex 要新建分支' }, { key: 'question:3', kind: 'question', text: '选题建议:「AI 工作台的一天」' }] } } as unknown as WorkbenchState
    : baseState

  const controls: ButlerControls = {
    paused,
    testRinging: ringing,
    onPause: () => setPaused(!paused),
    onTestRing: () => setRinging(!ringing),
    onCancelWatch: () => {},
    onDismissBrief: () => {},
    proposals: [],
  }

  useEffect(() => {
    // 场景 05: 自动打开抽屉
    if (scenario === '05-narrow-520x680-drawer-open') {
      setTimeout(() => {
        const drawerBtn = document.querySelector('.ben-wb__orb-drawer-btn') as HTMLElement | null
        if (drawerBtn) drawerBtn.click()
      }, 50)
    }

    // 场景 03: 自动触发提交进入真实交办发送/走光态
    if (scenario === '03-narrow-520x680-typing-glowing') {
      setTimeout(() => {
        const sendBtn = document.querySelector('.wb-cmp__send') as HTMLButtonElement | null
        if (sendBtn) sendBtn.click()
      }, 100)
    }
  }, [scenario])

  return (
    <div className="ben-wb" style={{ width: '100%', height: '100%', position: 'relative', overflow: 'hidden' }}>
      <style>{STYLE}</style>
      <style>{PARTICLE_STYLE}</style>
      <style>{BUTLER_LAYOUT_STYLE}</style>
      <style>{BUTLER_COMPOSER_STYLE}</style>

      {isFullscreen ? (
        <div style={{ width: '100%', height: '100%', position: 'relative' }}>
          <ButlerInbox
            state={state}
            baseUrl="http://127.0.0.1:3593"
            fetchImpl={mockFetch}
            onOpenConversation={() => {}}
            draft={draft}
            onDraftChange={setDraft}
            visible={true}
            controls={controls}
            orientation="landscape"
          />
        </div>
      ) : (
        <div style={{ width: '100%', height: '100%', position: 'relative' }}>
          <Butler
            conclusions={['正在执行 1 件', '浮窗布局验证']}
            corner="tl"
            min={min}
            narrowForced={false}
            pos={{ x_pct: 0, y_pct: 0 }}
            size={{ w_px: 520, h_px: 680 }}
            paused={paused}
            testRinging={ringing}
            onToggleMin={() => setMin(!min)}
            onMove={() => {}}
            onResize={() => {}}
            onPause={() => setPaused(!paused)}
            onTestRing={() => setRinging(!ringing)}
            onAsk={async () => true}
            onDismissBrief={() => {}}
            onCancelWatch={() => {}}
            orb={floatOrbView(state)}
            page={
              <ButlerInbox
                state={state}
                baseUrl="http://127.0.0.1:3593"
                fetchImpl={mockFetch}
                onOpenConversation={() => {}}
                draft={draft}
                onDraftChange={setDraft}
                visible={true}
                controls={controls}
                orientation="portrait"
                compact={compact}
                onLocate={() => {}}
              />
            }
          />
        </div>
      )}
    </div>
  )
}

const rootEl = document.getElementById('root')
if (rootEl) {
  createRoot(rootEl).render(<App />)
}
