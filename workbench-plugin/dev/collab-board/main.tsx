/**
 * 协作区看样页(2026-10-21)。**全是假数据**:三个目标、一块「未归目标」、几张便签、一只 Codex 小鼠标;
 * fetch 在页面里拦下来(画布的摆法存在内存里,改章 / 挪目标只改这份假状态),不连 8791。
 * 给人看画布长什么样、点章 / 拖便签 / 开详情的手感;真跑要在 DSH 里装上插件。
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
]
// ?pileDemo=1:小K 同一时段叠五件(复现 10-28 真机「计划一格糊成一团」,看并列与「+N 件」)。
if (new URLSearchParams(location.search).get('pileDemo') === '1') {
  const pile = ['接口文档补全', '修登录跳转', '改首页文案', '回归一遍手机端', '整理发版说明']
  pile.forEach((title, i) => tasks.push(note(`k${i}`, title, { goal_id: 'g1', status: 'todo', assignee: 'kimi', start: dayAt(0, '09:00'), end: dayAt(0, `1${i}:00`) })))
  pile.slice(0, 4).forEach((title, i) => tasks.push(note(`n${i}`, `夜间 · ${title}`, { goal_id: 'g1', status: 'todo', assignee: 'kimi', start: dayAt(0, `0${i % 2}:00`), end: dayAt(0, '03:00') })))
}
// ?bigBoard=1:照 10-28 真机板子的形状(板上 150 张卡;目标 g1 下 32 件,21 件进行中、11 件已完成;轨迹回包约 36 KB、2.1 秒才回,
// 执行片段 1.6 秒)。看目标视图的显示区域与「在读执行记录」用;标题都是编的。
const bigBoard = new URLSearchParams(location.search).get('bigBoard') === '1'
if (bigBoard) {
  const kinds = ['codex', 'claude', 'kimi', 'doubao'] as const
  tasks = Array.from({ length: 150 }, (_, i) => note(`b${i}`, `第 ${i + 1} 件 · 内部同学试用里冒出来的事`, {
    goal_id: i < 32 ? 'g1' : i % 2 === 0 ? 'g2' : 'g3', assignee: kinds[i % 4], work_type: i % 3 === 0 ? 'content' : 'dev',
    status: i < 21 ? 'doing' : i < 32 ? 'done' : i < 60 ? 'doing' : 'todo',
    acceptance: ['照验收单走一遍'],
  }))
}
let goals = [
  { id: 'g1', title: '座机出门也能接', why: '不用守着电脑,电话响了就接', owner: 'me' as const, status: 'open' as const, due: '2026-10-30', version: '0.4.140', created_at: AT, updated_at: AT, risk: { level: 'tight' as const, reason: '还剩 9 天,按最近速度要 8 天', window_days: 14 } },
  { id: 'g2', title: '周五发样片', why: '客户等着看方向', owner: 'me' as const, status: 'open' as const, created_at: AT, updated_at: AT },
  { id: 'g3', title: '早报改成播客', owner: 'me' as const, status: 'open' as const, created_at: AT, updated_at: AT },
]
// ?smallGoal=1:照 10-28 17:0x 真机(785×766 窄窗)加一个只有 1 件、已完成的目标,排在最后;在「当前目标」里选它看阅读区跟不跟。
if (new URLSearchParams(location.search).get('smallGoal') === '1') {
  goals.push({ id: 'g4', title: '研究座机拓展坞硬件方案', owner: 'me' as const, status: 'open' as const, created_at: AT, updated_at: AT })
  tasks.push(note('s1', '列三种拓展坞方案', { goal_id: 'g4', status: 'done', assignee: 'claude', work_type: 'dev', acceptance: ['三种方案各写价格与接口'] }))
}
let layout: unknown = { goals: {}, notes: {} }
// ?staged=1:照真机数据分几拍到(10-28 18:4x 退修):先只有一部分卡、没有「等你」;1.5 秒后其余卡到齐(上面几节变高);
// 2.5 秒后「等你」那条会话到。看阅读区在没人动手时会不会被挤偏、还对不对着当前目标。
const staged = new URLSearchParams(location.search).get('staged') === '1'
let stage = staged ? 0 : 2
if (staged) {
  setTimeout(() => { stage = 1; changed() }, 1500)
  setTimeout(() => { stage = 2; changed() }, 2500)
}
const shownTasks = (): TaskView[] => (stage === 0 ? tasks.filter((_one, i) => i % 3 === 0 || _one.goal_id === 'g4') : tasks)

function snapshot(): WorkbenchState {
  return {
    now: new Date().toISOString(), agents: [],
    sessions: stage < 2 ? [] : [{ agent: 'codex', session_id: 's-9', project: 'workbench', status: 'running', elapsed_sec: 5400, unread: false, updated_at: new Date().toISOString(), title: '修展示台的歌词错位' }], quota: {}, stale: false,
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
      tasks: shownTasks(), sprints: [], modules: [], project_meta: [], goals, goal_sprints: [], agent_cards: [
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

window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input), location.href)
  const body = init?.body === undefined ? {} : JSON.parse(String(init.body)) as Record<string, unknown>
  const ok = (json: unknown = { ok: true }): Response => new Response(JSON.stringify(json), { headers: { 'content-type': 'application/json' } })
  if (url.pathname === '/collab/canvas') {
    if ((init?.method ?? 'GET') === 'GET') return ok({ layout })
    layout = body.layout
    return ok()
  }
  // 2026-10-27:事项轨迹的假回包(看样用,节点都是编的;真的由 GET /collab/trace 按任务日志与回执拼)。
  if (url.pathname === '/collab/trace') {
    const gid = url.searchParams.get('goal_id')
    if (bigBoard) {
      await new Promise(done => setTimeout(done, 2100))
      const at = (n: number): string => new Date(Date.now() - (200 - n) * 60_000).toISOString()
      const traces = tasks.filter(one => one.goal_id === gid).map((one, i) => ({
        task_id: one.id,
        nodes: [
          { at: at(i), kind: 'dispatch', to: one.assignee },
          { at: at(i + 1), kind: 'sent', actor: one.assignee },
          { at: at(i + 2), kind: 'start', actor: one.assignee },
          ...(one.status === 'doing' ? [] : [{ at: at(i + 9), kind: 'return', actor: one.assignee, text: '交回:按验收单走了一遍,截图与日志在交接里' }]),
        ],
        current: { state: one.status === 'doing' ? 'running' : one.status === 'done' ? 'done' : 'not_started', actor: one.assignee, since: at(i + 2) },
      }))
      return ok({ goal_id: gid, traces })
    }
    const at = (hm: string): string => dayAt(0, hm)
    const traces = tasks.filter(one => (one.goal_id ?? 'goal:unsorted') === gid).map(one => one.id === 't1'
      ? { task_id: 't1', nodes: [{ at: at('09:00'), kind: 'dispatch', to: 'codex' }, { at: at('09:12'), kind: 'start', actor: 'codex' }, { at: at('10:20'), kind: 'return', actor: 'codex', text: '第一版铃声换好' }, { at: at('10:20'), kind: 'artifact', actor: 'codex', evidence: ['ring/soft.mp3'] }, { at: at('10:35'), kind: 'rework', actor: 'me', text: '手机上还是吵' }, { at: at('10:50'), kind: 'dispatch', to: 'codex' }], current: { state: 'running', actor: 'codex', since: at('10:52') } }
      : one.id === 't2'
        ? { task_id: 't2', nodes: [{ at: at('08:00'), kind: 'dispatch', to: 'claude' }, { at: at('08:05'), kind: 'start', actor: 'claude' }, { at: at('08:30'), kind: 'return', actor: 'claude', text: '提机 0.6 秒接通' }, { at: at('08:30'), kind: 'artifact', actor: 'claude', evidence: ['/tmp/pickup.mov'] }], current: { state: 'awaiting_review', actor: 'claude', since: at('08:30') } }
        : one.id === 't4'
          ? { task_id: 't4', nodes: [{ at: at('09:30'), kind: 'dispatch', to: 'doubao' }, { at: at('09:40'), kind: 'blocked', actor: 'doubao', text: '素材文件夹没权限' }], current: { state: 'blocked', actor: 'doubao' } }
          : { task_id: one.id, nodes: [], current: { state: one.status === 'todo' || one.status === 'backlog' ? 'not_started' : 'unknown' } })
    return ok({ goal_id: gid, traces })
  }
  // 2026-10-27:人和 Agent 占用的假运行片段(看样用,时刻都是编的;真的由 GET /collab/runs 按任务日志拼)。
  if (url.pathname === '/collab/runs') {
    const gid = url.searchParams.get('goal_id')
    if (bigBoard) await new Promise(done => setTimeout(done, 1600))
    const at = (hm: string): string => dayAt(0, hm)
    const runs = [
      { task_id: 't1', agent: 'codex', source: 'codex', status: 'done', started_at: at('09:00'), execution_started_observed_at: at('09:12'), execution_finished_observed_at: at('10:20'), finished_at: at('10:20') },
      { task_id: 't1', agent: 'codex', source: 'codex', status: 'running', started_at: at('10:50'), execution_started_observed_at: at('10:52'), session_id: 's2' },
      { task_id: 't2', agent: 'claude', source: 'claude', status: 'done', started_at: at('08:00'), execution_started_observed_at: at('08:05'), execution_finished_observed_at: at('08:30'), finished_at: at('08:30') },
      { task_id: 't4', agent: 'doubao', source: 'doubao', status: 'dispatched', started_at: at('09:30') },
    ].filter(run => (tasks.find(one => one.id === run.task_id)?.goal_id ?? 'goal:unsorted') === gid)
    return ok({ runs })
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

const params = new URLSearchParams(location.search)
// ?flyDemo=1:2 秒后假装 Codex 交回了「铃声换成柔和的」(看飞线用;回执是编的)。
if (params.get('flyDemo') === '1') {
  setTimeout(() => {
    tasks = tasks.map(one => (one.id === 't1' ? { ...one, receipt: { kind: 'done', text: '做完:换成柔和铃声', by: 'codex', at: new Date().toISOString() } } : one))
    changed()
  }, 2000)
}
const isFull = params.get('full') === '1'
const initialView = (params.get('view') as 'timeline' | 'goals' | 'channel' | undefined) ?? 'goals'

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

// ?theme=light 看亮版(宿主底色令牌换成浅色)。
if (new URLSearchParams(location.search).get('theme') === 'light') document.documentElement.style.setProperty('--dsw-alias-bg-base', '#efefef')
const style = document.createElement('style')
style.textContent = STYLE
document.head.appendChild(style)
// 设置弹层的样式挂在 .ben-wb 前缀下(monoStyle),看样页包一层,和真宿主一致。
createRoot(document.getElementById('app') as HTMLElement).render(<div className="ben-wb" style={{ position: 'absolute', inset: 0 }}><App /></div>)

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
