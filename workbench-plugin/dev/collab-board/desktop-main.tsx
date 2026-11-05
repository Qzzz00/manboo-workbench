/**
 * 协作区桌面验收页(2026-10-24,小K collab-desktop-1024)。两种模式:
 * - 夹具模式(缺省):同 main.tsx 的假 fetch,加了父子任务组与更全的状态覆盖;
 * - 真实 API 模式(?live=1&api=http://127.0.0.1:9993):只认真实 WorkbenchServer 的 /state,
 *   轮询自动刷新,断线保留上次已知 —— UI 与真 API 之间不隔夹具。
 */
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { CollabPresence, TaskView, WorkbenchState } from '../../src/protocol.ts'
import { CollabZone } from '../../src/client/collab/CollabZone.tsx'
import { STYLE } from '../../src/client/style.ts'

const AT = '2026-10-21T09:00:00.000Z'
const today = new Date()
const dayAt = (offset: number, hm: string): string => {
  const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset)
  const [h, m] = hm.split(':').map(Number) as [number, number]
  d.setHours(h, m, 0, 0)
  return d.toISOString()
}
const note = (id: string, title: string, patch: Partial<TaskView> = {}): TaskView => ({
  id, title, status: 'todo', source: { kind: 'manual' }, created_at: AT, updated_at: AT, ...patch,
})

let tasks: TaskView[] = [
  note('t1', '铃声换成柔和的', { goal_id: 'g1', status: 'doing', assignee: 'codex', start: dayAt(0, '11:30'), end: dayAt(0, '12:30'), work_type: 'dev', from: { kind: 'said', quote: '铃声太吵了,换一首柔和的' }, acceptance: ['手机上响一次', '电脑上也响'] }),
  note('t2', '提机就接通', { goal_id: 'g1', status: 'confirm', assignee: 'claude', start: dayAt(0, '11:00'), end: dayAt(0, '11:30'), work_type: 'dev', from: { kind: 'meeting', ref: 'm-1021' }, acceptance: ['提起听筒 1 秒内接通'], receipt: { kind: 'done', text: '做完:1 提机 0.6 秒接通,录屏在 /tmp/pickup.mov', by: 'claude', at: '2026-10-21T08:30:00.000Z' } }),
  note('t3', '配网说明写一页', { goal_id: 'g1', status: 'todo', assignee: 'me', start: dayAt(1, '14:00'), end: dayAt(1, '15:30'), work_type: 'content', acceptance: ['不懂代码的人照着能配上'] }),
  note('t4', '剪 30 秒样片', { goal_id: 'g2', status: 'blocked', assignee: 'doubao', start: dayAt(0, '11:30'), end: dayAt(0, '12:00'), work_type: 'content', acceptance: ['30 秒内', '有字幕'], receipt: { kind: 'blocked', text: '卡住:素材文件夹没权限', at: AT } }),
  note('t5', '封面三选一', { goal_id: 'g2', status: 'confirm', assignee: 'codex', start: dayAt(2, '10:00'), collaborators: ['me'], acceptance: ['给三张'], receipt: { kind: 'objection', text: '有异议:第三张版权不清楚,建议换', at: '2026-10-21T08:50:00.000Z' } }),
  note('t6', '按清单真机走一遍', { status: 'todo' }),
  note('t7', '上周会上提的那件', { status: 'backlog', origin: 'meeting' }),
  note('t8', '子 · 真机提机接听', { id: 't8', status: 'done', acceptance: ['三秒内接通'] }),
  note('t9', '子 · 手机看材料', { id: 't9', status: 'doing', assignee: 'kimi' }),
  note('t10', '座机端到端走通', { id: 't10', status: 'doing', children: ['t8', 't9'], acceptance: ['子卡全部做完'] }),
]
let goals = [
  { id: 'g1', title: '座机出门也能接', why: '不用守着电脑,电话响了就接', owner: 'me' as const, status: 'open' as const, due: '2026-10-30', version: '0.4.140', created_at: AT, updated_at: AT, risk: { level: 'tight' as const, reason: '还剩 9 天,按最近速度要 8 天', window_days: 14 } },
  { id: 'g2', title: '周五发样片', why: '客户等着看方向', owner: 'me' as const, status: 'open' as const, created_at: AT, updated_at: AT },
  { id: 'g3', title: '早报改成播客', owner: 'me' as const, status: 'open' as const, created_at: AT, updated_at: AT },
]
let layout: unknown = { goals: {}, notes: {} }

function snapshot(): WorkbenchState {
  return {
    now: new Date().toISOString(), agents: [],
    sessions: [{ agent: 'codex', session_id: 's-9', project: 'workbench', status: 'running', elapsed_sec: 5400, unread: false, updated_at: new Date().toISOString(), title: '修展示台的歌词错位' }], quota: {}, stale: false,
    agent_caps: {
      checked_at: AT,
      agents: [
        {
          family: 'codex', title: 'Codex',
          cells: {
            chat: { state: 'ok', via: 'window', note: '窗口那只手读得到它的对话' },
            edit: { state: 'ok', via: 'cli', note: '能直接改你电脑上的文件(在你指定的项目里,后台做)' },
            collect: { state: 'ok', via: 'cli', note: '后台做完把结果收回来' },
          },
          line: 'Codex 能聊天、能改本机文件(命令行)、能收回结果',
        },
        {
          family: 'kimi', title: 'Kimi',
          cells: {
            chat: { state: 'ok', via: 'window', note: '窗口那只手读得到它的对话' },
            edit: { state: 'ok', via: 'cli', note: '能直接改你电脑上的文件(在你指定的项目里,后台做)' },
            collect: { state: 'ok', via: 'cli', note: '后台做完把结果收回来' },
          },
          line: 'Kimi 能聊天、能改本机文件(命令行)、能收回结果',
        },
        {
          family: 'doubao', title: '豆包',
          cells: {
            chat: { state: 'ok', via: 'window', note: '窗口那只手读得到它的对话' },
            edit: { state: 'na', note: '只能聊天,改不了你电脑上的文件' },
            collect: { state: 'ok', via: 'window', note: '窗口里做完把结果读回来' },
          },
          line: '豆包 能聊天、能收回结果;改本机文件这一格它没有',
        },
      ],
      line: '这台电脑上有几家能干活',
    },
    tasks: {
      tasks, sprints: [], modules: [], project_meta: [], goals, goal_sprints: [], agent_cards: [
        // 一张命令行 Kimi 名片(有模型)、一张窗口豆包名片、一张老卡(hand 是登记表 id) —— 三种都摆出来对照。
        { id: 'agent:local:kimi', name: 'Kimi 编程', owner: 'me', hand: 'cli', runtime: { family: 'kimi' }, model: { name: 'kimi-for-coding', effort: 'high' }, project: { repo: '/Users/example/Documents/GitHub/desktop-workbench' }, instructions: 'docs/卡/agents/kimi-coder.md', good_at: '改前端组件', skills: ['huashu-report', 'g-scoped-implementation'], shared: { to: 'none' }, created_at: AT, updated_at: AT },
        { id: 'agent:local:doubao', name: '豆包文案', owner: 'me', hand: 'window', runtime: { family: 'doubao' }, good_at: '润色与起标题', shared: { to: 'none' }, created_at: AT, updated_at: AT },
        { id: 'agent:local:old', name: 'Codex 老卡', owner: 'me', hand: 'codex', good_at: '修 bug', shared: { to: 'none' }, created_at: AT, updated_at: AT },
      ],
      avatars: { claude: { kind: 'preset', id: 'agent-3' }, me: { kind: 'preset', id: 'human-1' } },
      session_proposals: [{ agent: 'codex', session_id: 's-9', title: '修展示台的歌词错位', new_goal_title: '修展示台的歌词错位', at: AT }],
    },
    meetings: { recent: [{
      id: 'm1', title: '远程派活方案评审', date: '', started_at: dayAt(0, '14:00'), ended_at: dayAt(0, '14:30'), status: 'done', segments: 3,
      summary: '手机离开电脑后,派单与交回分别要给出明确结果。先用一轮真机实测确认,再调整桌面的派活入口。', unsure: [],
      decisions: ['先验通手机,再做桌面入口', '交回必须对着验收编号答'],
      todos: [{ id: 'td1', what: '先验通手机,再做桌面入口' }, { id: 'td2', what: '提机就接通', task_id: 't2' }],
      prep: { said: '', card_status: 'ready', card: { made_at: AT, questions: [{ q: '派单到了哪里', line: '', fallback: '' }, { q: '结果怎么交回来', line: '', fallback: '' }] }, people: { value: [{ alias: '小李' }], from: 'said' } },
      timeline: [{ at: dayAt(0, '14:00'), text: '会议开始' }, { at: dayAt(0, '14:32'), text: '你确认了纪要' }],
    }] },
    agent_registry: {
      entries: [
        { id: 'dsh', name: '事务官', self: true, status: 'idle' },
        { id: 'codex', name: 'Codex', status: 'running', color: '#7ee787' },
        { id: 'claude', name: 'Claude', status: 'idle', color: '#e8a273' },
        { id: 'kimi', name: 'Kimi', status: 'running', color: '#9fc2ff' },
        { id: 'doubao', name: '豆包', status: 'idle' },
      ],
      asking: [], notices: [],
    },
  } as unknown as WorkbenchState
}

const listeners = new Set<() => void>()
const changed = (): void => { for (const fn of listeners) fn() }

// 夹具模式才拦 fetch;真实 API 模式(?live=1)一律走真网络,不隔夹具。
const liveApiWanted = new URLSearchParams(location.search).get('live') === '1'
const realFetch = window.fetch.bind(window)
if (!liveApiWanted) window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input), location.href)
  const body = init?.body === undefined ? {} : JSON.parse(String(init.body)) as Record<string, unknown>
  const ok = (json: unknown = { ok: true }): Response => new Response(JSON.stringify(json), { headers: { 'content-type': 'application/json' } })
  if (url.pathname === '/collab/canvas') {
    if ((init?.method ?? 'GET') === 'GET') return ok({ layout })
    layout = body.layout
    return ok()
  }
  if (url.pathname === '/task/move') { tasks = tasks.map(one => (one.id === body.id ? { ...one, status: body.status as TaskView['status'] } : one)); changed(); return ok() }
  if (url.pathname === '/task/update') {
    tasks = tasks.map((one) => {
      if (one.id !== body.id) return one
      const next = { ...one } as Record<string, unknown>
      for (const [key, value] of Object.entries(body)) {
        const field = key === 'goal_id' ? 'goal_id' : key
        if (value === null) delete next[field]
        else next[field] = value
      }
      return next as unknown as TaskView
    })
    changed()
    return ok()
  }
  if (url.pathname === '/collab/goal/create') { goals = [...goals, { id: `g${goals.length + 1}`, title: String(body.title), owner: 'me', status: 'open', created_at: AT, updated_at: AT }]; changed(); return ok() }
  if (url.pathname.endsWith('/trace')) return ok({ events: [{ at: AT, step: 'assigned', family: 'codex' }, { at: AT, step: 'sent', family: 'codex' }] })
  if (url.pathname === '/dispatch/skills') return ok({ builtin: ['huashu-report', 'huashu-design'], mine: [{ id: 'g-scoped-implementation', name: '范围内实现', description: '接任务包后只在范围内改' }] })
  if (url.pathname === '/collab/relay/agents/share') return ok({ error: '看样页:没真登记到工作室' })
  return ok({ ok: true, note: '看样页:这一下没真发出去' })
}) as typeof fetch
else window.fetch = realFetch

const params = new URLSearchParams(location.search)
const isFull = params.get('full') === '1'
const initialView = (params.get('view') as 'timeline' | 'goals' | 'channel' | undefined) ?? 'goals'
const liveApi = liveApiWanted ? (params.get('api') ?? '') : undefined

/** 真实 API 驱动:轮询 /state,断线保留上次已知(与生产行为一致)。 */
function useLiveState(apiBase: string | undefined): WorkbenchState | undefined {
  const [live, setLive] = useState<WorkbenchState | undefined>(undefined)
  useEffect(() => {
    if (apiBase === undefined || apiBase === '') return undefined
    let alive = true
    const pull = async (): Promise<void> => {
      try {
        const res = await fetch(`${apiBase}/state`)
        if (!res.ok) throw new Error('工作台服务未应答')
        const next = (await res.json()) as WorkbenchState
        if (alive) setLive(next)
      }
      catch { if (alive) setLive(previous => previous === undefined ? previous : { ...previous, stale: true }) }
    }
    void pull()
    const timer = setInterval(() => { void pull() }, 700)
    return () => { alive = false; clearInterval(timer) }
  }, [apiBase])
  return live
}

const presence: CollabPresence[] = [
  { actor: { kind: 'agent', id: 'kimi' }, on_note: 't1', state: 'working', at: new Date().toISOString() },
]

function App() {
  const [state, setState] = useState(snapshot)
  useEffect(() => {
    const fn = (): void => setState(snapshot())
    listeners.add(fn)
    const timer = setInterval(() => setState(snapshot()), 1000)
    return () => {
      listeners.delete(fn)
      clearInterval(timer)
    }
  }, [])
  return (
    <CollabZone
      state={state}
      baseUrl={location.origin}
      fetchImpl={window.fetch}
      presence={presence}
      visible
      initialView={initialView}
      {...(isFull ? { onExitFull: () => {} } : { onExpand: () => {} })}
    />
  )
}

function LiveApp({ apiBase }: { apiBase: string }) {
  const state = useLiveState(apiBase)
  if (state === undefined) return <p style={{ color: '#888', padding: 24, font: '12.5px/1.6 sans-serif' }}>在连真实服务…</p>
  return (
    <CollabZone
      state={state}
      baseUrl={apiBase}
      fetchImpl={window.fetch}
      presence={[]}
      visible
      initialView={initialView}
      {...(isFull ? { onExitFull: () => {} } : { onExpand: () => {} })}
    />
  )
}

// ?theme=light 看亮版(宿主底色令牌换成浅色)。
if (new URLSearchParams(location.search).get('theme') === 'light') document.documentElement.style.setProperty('--dsw-alias-bg-base', '#efefef')
const style = document.createElement('style')
style.textContent = STYLE
document.head.appendChild(style)
// 设置弹层的样式挂在 .ben-wb 前缀下(monoStyle),看样页包一层,和真宿主一致。
createRoot(document.getElementById('app') as HTMLElement).render((
  <div className="ben-wb" style={{ position: 'absolute', inset: 0 }}>
    {liveApi === undefined ? <App /> : <LiveApp apiBase={liveApi} />}
  </div>
))

// 截图开关(2026-10-22,卡「名片编辑表单重排」交接用,照 dev/readability-sample 的先例):
//   ?settings=1            载入后点开设置弹层
//   &tab=Agent 名片        切到 Agent 名片页签
//   &edit=<名片名>         点那张名片的「改」(走真实回填:哪一家选中、段3 出现、各栏有值)
//   &expand=share          再展开「共享」折叠段(缺省折着)
const shot = new URLSearchParams(location.search)
if (shot.get('settings') === '1') {
  const later = (ms: number, fn: () => void): void => { setTimeout(fn, ms) }
  later(700, () => document.querySelector<HTMLButtonElement>('button[aria-label="设置"]')?.click())
  const tab = shot.get('tab')
  if (tab !== null) later(1100, () => [...document.querySelectorAll<HTMLButtonElement>('.ben-cl__settings nav button')].find(one => one.textContent === tab)?.click())
  const edit = shot.get('edit')
  if (edit !== null) later(1500, () => [...document.querySelectorAll<HTMLButtonElement>('.ben-cl__setrow button')].find(one => one.textContent === '改' && one.closest('.ben-cl__setrow')?.querySelector('b')?.textContent === edit)?.click())
  if (shot.get('expand') === 'share') later(2000, () => [...document.querySelectorAll<HTMLButtonElement>('.ben-cl__form button')].find(one => one.textContent === '共享')?.click())
}
