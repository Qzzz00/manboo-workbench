import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { AgentCard, AgentEntryView, MeetingView, TaskView, WorkbenchState } from '../src/protocol.ts'
import { CollabZone, TIMELINE_MODE_KEY } from '../src/client/collab/CollabZone.tsx'
import { themeOf } from '../src/client/collab/useHostTheme.ts'

// 这些用例看的是「按日期」那张日程。时间线缺省是人和 Agent 占用(决策记录 10-27「已拍板:呈现语义」),
// 先把偏好选成按日期,同用户切过一次一样。
beforeEach(() => { localStorage.setItem(TIMELINE_MODE_KEY, 'days') })

afterEach(cleanup)
beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never
})

const DAY = '2026-10-21'
const local = (day: string, hm: string): string => new Date(`${day}T${hm}:00`).toISOString()
const NOW = Date.parse(local(DAY, '12:24'))
const AT = local(DAY, '08:00')
const note = (id: string, patch: Partial<TaskView> = {}): TaskView => ({ id, title: id, status: 'todo', source: { kind: 'manual' }, created_at: AT, updated_at: AT, ...patch })

function stateWith(tasks: TaskView[], opts: { meetings?: MeetingView[], registry?: AgentEntryView[], extra?: Partial<NonNullable<WorkbenchState['tasks']>> } = {}): WorkbenchState {
  return {
    now: new Date(NOW).toISOString(),
    sessions: [],
    tasks: { tasks, sprints: [], modules: [], project_meta: [], goals: [], goal_sprints: [], agent_cards: [], session_proposals: [], squads: [], timers: [], mcp: [], ...opts.extra },
    agent_registry: { entries: opts.registry ?? [], asking: [], notices: [] },
    ...(opts.meetings === undefined ? {} : { meetings: { recent: opts.meetings } }),
  } as unknown as WorkbenchState
}

function fakeFetch(github: Record<string, unknown> = { state: 'unconfigured' }) {
  const calls: { path: string, method: string, body?: Record<string, unknown> }[] = []
  const impl = (async (input: string, init?: RequestInit) => {
    const url = new URL(input)
    const method = init?.method ?? 'GET'
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body)) as Record<string, unknown>
    calls.push({ path: url.pathname, method, ...(body === undefined ? {} : { body }) })
    const json = url.pathname === '/collab/canvas' ? { layout: { goals: {}, notes: {} } }
      : url.pathname === '/collab/github' ? github
        : url.pathname === '/dispatch/skills' ? { builtin: ['huashu-report', 'huashu-design'], mine: [{ id: 'g-scoped-implementation', name: '范围内实现', description: '接任务包后只在范围内改' }] }
          : url.pathname === '/token/personal' ? { tokens: [] }
            : url.pathname.endsWith('/trace') ? { events: [] } : { ok: true }
    return new Response(JSON.stringify(json), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return { calls, impl }
}

function zone(state: WorkbenchState, opts: { width?: number, github?: Record<string, unknown> } = {}) {
  const fetch = fakeFetch(opts.github)
  render(<div style={{ position: 'relative' }}><CollabZone state={state} baseUrl="http://127.0.0.1:8791" fetchImpl={fetch.impl} presence={[]} visible nowMs={NOW} timelineWidth={opts.width ?? 1228} /></div>)
  return fetch
}
const posts = (calls: ReturnType<typeof fakeFetch>['calls'], path: string) => calls.filter(one => one.method === 'POST' && one.path === path)

describe('时间线视图', () => {
  const tasks = [
    note('派活评审', { start: local(DAY, '11:30'), end: local(DAY, '12:00'), work_type: 'meeting', assignee: 'me' }),
    note('接上续线程', { start: local(DAY, '11:30'), end: local(DAY, '12:30'), kind: 'feature', assignee: 'codex' }),
    note('明天那件', { start: local('2026-10-22', '14:00'), end: local('2026-10-22', '15:00') }),
    note('没排时间的'),
  ]
  it('默认是时间线;窗口槽宽度显示三天,今天 / 明天 / 后天;「现在」线', () => {
    zone(stateWith(tasks))
    const tl = screen.getByRole('region', { name: '时间线' })
    expect(tl).toHaveAttribute('data-days', '3')
    expect(within(tl).getByLabelText('今天 · 10 月 21 日')).toHaveTextContent('10 月 21 日周三')
    expect(within(tl).getByLabelText('后天 · 10 月 23 日')).toHaveTextContent('10 月 23 日周五')
    expect(within(tl).getByLabelText('现在')).toBeInTheDocument()
    expect(screen.getByText('10 月 21 日 — 23 日')).toBeInTheDocument()
  })
  it('组件宽度 400 只显示一天', () => {
    zone(stateWith(tasks), { width: 400 })
    expect(screen.getByRole('region', { name: '时间线' })).toHaveAttribute('data-days', '1')
  })
  it('卡带类型底色;同刻并排;未排时间进底部入口', async () => {
    const user = userEvent.setup()
    zone(stateWith(tasks))
    expect(screen.getByLabelText('便签 派活评审')).toHaveAttribute('data-type', 'meeting')
    expect(screen.getByLabelText('便签 接上续线程')).toHaveAttribute('data-type', 'dev')
    await user.click(screen.getByRole('button', { name: '未排时间 1' }))
    expect(within(screen.getByRole('dialog', { name: '未排时间' })).getByText('没排时间的')).toBeInTheDocument()
  })
  it('卡头一行「类型 · 时段」(类型名读类型表,缺省「研发与设计」);高的卡再写「目标 · 验收 N 条」与为什么;矮的只留标题(评审页协作区原型 `.event-head` / `.event-project` / `.event-summary`)', () => {
    const goals = [{ id: 'g1', title: '远程派单', project_id: 'p1', created_at: AT, updated_at: AT }]
    const long = note('写清交回', { start: local(DAY, '09:00'), end: local(DAY, '11:30'), work_type: 'dev', goal_id: 'g1', acceptance: ['甲', '乙', '丙'], desc: '交回时先说检查结果' })
    zone({ ...stateWith([...tasks, long], { extra: { goals } as never }), projects: { projects: [{ id: 'p1', name: '示例项目', stage: '', links: [], session_count: 0, idle: false }], pending: [], scan_errors: [], scanned_at: AT } } as unknown as WorkbenchState)
    const meeting = screen.getByLabelText('便签 派活评审')
    expect(meeting).toHaveAttribute('data-size', 'compact')
    const tall = screen.getByLabelText('便签 写清交回')
    expect(tall).toHaveAttribute('data-size', 'long')
    expect(within(tall).getByText('研发与设计')).toBeInTheDocument()
    expect(within(tall).getByText('· 09:00–11:30')).toBeInTheDocument()
    // 10-22 统筹定 19:照稿写所属项目(便签自己的项目,没有就取目标的项目,都没有写「未归目标」)
    expect(within(tall).getByText('示例项目 · 验收 3 条')).toBeInTheDocument()
    expect(within(tall).getByText('交回时先说检查结果')).toBeInTheDocument()
    const normal = screen.getByLabelText('便签 接上续线程')
    expect(normal).toHaveAttribute('data-size', 'normal')
    expect(within(normal).queryByText(/验收/)).toBeNull()
  })
  it('同刻装不下:窄列收成「该时段 3 件」(原型 `.overlap-group`),点开三件都在', async () => {
    const user = userEvent.setup()
    const three = ['甲', '乙', '丙'].map(id => note(id, { start: local(DAY, '11:00'), end: local(DAY, '12:00') }))
    zone(stateWith(three), { width: 400 })
    const more = screen.getByRole('button', { name: /^该时段 3 件/ })
    // 评审页协作区原型 `.overlap-group`:件数一行,下面小字「时段 · 最多 N 件并行」
    expect(more).toHaveTextContent('11:00–12:00 · 最多 3 件并行')
    await user.click(more)
    for (const id of ['甲', '乙', '丙']) expect(screen.getByRole('button', { name: id })).toBeInTheDocument()
  })
  // 日期一段照原型 `.date-nav`:「10 月 21 日 — 23 日」,回来那颗写「今天」
  it('‹ › 翻日期;「今天」回来', async () => {
    const user = userEvent.setup()
    zone(stateWith(tasks))
    await user.click(screen.getByRole('button', { name: '往后' }))
    expect(screen.getByText('10 月 24 日 — 26 日')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '今天' }))
    expect(screen.getByText('10 月 21 日 — 23 日')).toBeInTheDocument()
  })
  it('头三行照原型:标题与工具 / 视图、项目、筛选、日期 / 成员', () => {
    zone(stateWith(tasks))
    const head = document.querySelector('.ben-cl__head')!
    expect([...head.children].map(one => one.className)).toEqual(['ben-cl__top', 'ben-cl__toolbar', 'ben-cl__people'])
    const top = head.querySelector('.ben-cl__top') as HTMLElement
    expect(within(top).getByRole('button', { name: /^\d+ 张名片$/ })).toBeInTheDocument()
    expect(within(top).getByRole('button', { name: '设置' })).toBeInTheDocument()
    const toolbar = head.querySelector('.ben-cl__toolbar') as HTMLElement
    expect(within(toolbar).getByRole('combobox', { name: '项目' })).toHaveValue('')
    expect(within(toolbar).getByRole('button', { name: '筛选' })).toBeInTheDocument()
  })
  it('时间线里点章也能改状态(拖动不改时间不改状态,时间只在详情里改)', async () => {
    const user = userEvent.setup()
    const fetch = zone(stateWith(tasks))
    const card = screen.getByLabelText('便签 接上续线程')
    await user.click(within(card).getByRole('button', { name: /章:领了/ }))
    await user.click(within(card).getByRole('button', { name: '在做' }))
    await waitFor(() => expect(posts(fetch.calls, '/task/move')[0]?.body).toEqual({ id: '接上续线程', status: 'doing' }))
  })
})

describe('改时间只走明确字段', () => {
  it('详情里写日期 / 开始 / 结束 → /task/update {start, end};结束早于开始当场说', async () => {
    const user = userEvent.setup()
    const fetch = zone(stateWith([note('没排时间的')]))
    await user.click(screen.getByRole('button', { name: '未排时间 1' }))
    await user.click(screen.getByRole('button', { name: '排时间' }))
    const dialog = screen.getByRole('dialog', { name: '便签:没排时间的' })
    await user.type(within(dialog).getByLabelText('日期'), '2026-10-22')
    await user.type(within(dialog).getByLabelText('开始'), '14:00')
    await user.type(within(dialog).getByLabelText('结束'), '13:00')
    await user.click(within(dialog).getByRole('button', { name: '存时间' }))
    expect(within(dialog).getByRole('alert')).toHaveTextContent('结束要晚于开始')
    await user.clear(within(dialog).getByLabelText('结束'))
    await user.type(within(dialog).getByLabelText('结束'), '15:00')
    await user.click(within(dialog).getByRole('button', { name: '存时间' }))
    await waitFor(() => expect(posts(fetch.calls, '/task/update')[0]?.body).toEqual({
      id: '没排时间的', start: new Date('2026-10-22T14:00:00').toISOString(), end: new Date('2026-10-22T15:00:00').toISOString(),
    }))
  })
})

describe('会议卡:会前与会后同一张', () => {
  const done = {
    id: 'm1', title: '远程派活方案评审', date: DAY, started_at: local(DAY, '10:00'), ended_at: local(DAY, '10:30'), status: 'done', segments: 3,
    summary: '先验通手机,再做桌面入口。', unsure: [],
    todos: [{ id: 'td1', what: '验收保留熄屏场景' }, { id: 'td2', what: '接上续线程', task_id: '接上续线程' }],
    prep: { said: '', card_status: 'ready', card: { made_at: AT, questions: [{ q: '派单到了哪里', line: '', fallback: '' }] }, people: { value: [{ alias: '小李' }], from: 'said' } },
  } as unknown as MeetingView
  it('时间线上是一张会议卡;打开见纪要、决定、会前议题;「记成任务」走 /meeting/apply', async () => {
    const user = userEvent.setup()
    const fetch = zone(stateWith([note('接上续线程', { status: 'doing' })], { meetings: [done] }))
    const card = screen.getByLabelText('会议 远程派活方案评审')
    expect(card).toHaveAttribute('data-type', 'meeting')
    expect(within(card).getByRole('button', { name: '看 我 的相关事项' })).toBeInTheDocument()
    expect(within(card).getByText('小李')).toBeInTheDocument()
    await user.click(within(card).getByRole('button', { name: '查看纪要' }))
    const dialog = screen.getByRole('dialog', { name: '会议:远程派活方案评审' })
    expect(within(dialog).getByText('先验通手机,再做桌面入口。')).toBeInTheDocument()
    expect(within(dialog).getByText('派单到了哪里')).toBeInTheDocument()
    expect(within(within(dialog).getByRole('region', { name: '关联任务' })).getByText('接上续线程')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: '记成任务' }))
    await waitFor(() => expect(posts(fetch.calls, '/meeting/apply')[0]?.body).toEqual({ id: 'm1', todos: ['td1'] }))
  })
})

describe('头像标签:点谁看谁的,其余变淡;成员那一排', () => {
  const registry = [{ id: 'codex', name: 'Codex', status: 'running' }] as unknown as AgentEntryView[]
  const tasks = [
    note('甲', { start: local(DAY, '11:00'), end: local(DAY, '12:00'), assignee: 'codex' }),
    note('乙', { start: local(DAY, '14:00'), end: local(DAY, '15:00'), assignee: 'me', collaborators: ['codex'] }),
    note('丙', { start: local(DAY, '16:00'), end: local(DAY, '17:00'), assignee: 'me' }),
  ]
  it('点 Codex:甲标负责、乙标协作,丙变淡', async () => {
    const user = userEvent.setup()
    zone(stateWith(tasks, { registry }))
    await user.click(screen.getByRole('button', { name: '看 Codex 的事' }))
    expect(within(screen.getByLabelText('便签 甲')).getByText('负责')).toBeInTheDocument()
    expect(within(screen.getByLabelText('便签 乙')).getByText('协作')).toBeInTheDocument()
    expect(screen.getByLabelText('便签 丙')).toHaveAttribute('data-dim', 'true')
  })
  it('成员那一排点「你」:甲变淡', async () => {
    const user = userEvent.setup()
    zone(stateWith(tasks, { registry }))
    await user.click(within(screen.getByRole('group', { name: '成员' })).getByRole('button', { name: '看 我 的相关事项' }))
    expect(screen.getByLabelText('便签 甲')).toHaveAttribute('data-dim', 'true')
    expect(screen.getByLabelText('便签 丙')).toHaveAttribute('data-related', 'true')
  })
})

describe('空态', () => {
  it('一句结论、一句引导、一个按钮;不提冲刺和模块', async () => {
    const user = userEvent.setup()
    zone(stateWith([]))
    expect(screen.getByText('板上还没有事')).toBeInTheDocument()
    expect(screen.queryByText(/冲刺|模块/)).toBeNull()
    await user.click(screen.getByRole('button', { name: '跟事务官说一件事' }))
    expect(screen.getByRole('dialog', { name: '跟事务官说' })).toBeInTheDocument()
  })
})

describe('设置', () => {
  const registry = [{ id: 'codex', name: 'Codex', status: 'running' }] as unknown as AgentEntryView[]
  async function openSettings(state: WorkbenchState, tab: string, github?: Record<string, unknown>) {
    const user = userEvent.setup()
    const fetch = zone(state, github === undefined ? {} : { github })
    await user.click(screen.getByRole('button', { name: '设置' }))
    await user.click(within(screen.getByRole('navigation', { name: '设置' })).getByRole('button', { name: tab }))
    return { user, fetch }
  }
  it('设置是盖在协作区上的一层:板子留在下面不换页;✕、Esc、点遮罩都关掉,不用再点一次「设置」(评审页 0cf75042 协作区组件)', async () => {
    const user = userEvent.setup()
    zone(stateWith([note('x')], { registry }))
    const open = async (): Promise<HTMLElement> => {
      await user.click(screen.getByRole('button', { name: '设置' }))
      const dialog = screen.getByRole('dialog', { name: '设置' })
      expect(within(dialog).getByRole('navigation', { name: '设置' })).toBeInTheDocument()
      // 板子还在下面:视图那一组照旧在,时间线照旧选着
      expect(within(screen.getByRole('group', { name: '视图' })).getByRole('button', { name: '时间线' })).toHaveAttribute('aria-pressed', 'true')
      return dialog
    }
    const closed = (): void => expect(screen.queryByRole('dialog', { name: '设置' })).toBeNull()
    await open()
    await user.click(screen.getByRole('button', { name: '关闭设置' }))
    closed()
    await open()
    await user.keyboard('{Escape}')
    closed()
    const dialog = await open()
    await user.click(dialog.parentElement as HTMLElement)
    closed()
  })

  it('Agent 名片:六段表单;没体检过的不进下拉、没有「去修」;存 → /collab/agent/save(hand 由家与体检推出)', async () => {
    const reg = [
      { id: 'codex', name: 'Codex', status: 'running' },
      { id: 'kimi', name: 'Kimi', status: 'unknown' },
    ] as unknown as AgentEntryView[]
    const mcp = [{ id: 'mc1', name: 'GitHub MCP', url_template: 'x', secret_names: [], created_at: AT, updated_at: AT }]
    const { user, fetch } = await openSettings(stateWith([note('x')], { registry: reg, extra: { mcp } }), 'Agent 名片')
    const form = screen.getByRole('form', { name: '登记一张 Agent 名片' })
    expect(within(form).queryByRole('option', { name: 'Kimi' })).toBeNull()
    expect(within(form).queryByRole('button', { name: /去修/ })).toBeNull()
    // 勾选列表分两组(本体 / 我的),数据来自 GET /dispatch/skills
    expect(within(form).getByText('本体 ·')).toBeInTheDocument()
    expect(within(form).getByText('我的 ·')).toBeInTheDocument()
    await user.type(within(form).getByLabelText('名字'), 'Ben 的代码 Agent')
    await user.selectOptions(within(form).getByLabelText('哪一家'), 'codex')
    await user.type(within(form).getByLabelText('擅长什么'), '前端')
    await user.click(within(form).getByLabelText('范围内实现'))
    await user.click(within(form).getByLabelText('huashu-report'))
    await user.click(within(form).getByLabelText('GitHub MCP'))
    // 共享收在折叠段里,展开才看得见
    await user.click(within(form).getByRole('button', { name: '共享' }))
    await user.click(within(form).getByLabelText('全工作室'))
    await user.type(within(form).getByLabelText('能动哪些仓库'), '/repo/a')
    await user.type(within(form).getByLabelText('每天上限(元)'), '20')
    await user.click(within(form).getByRole('button', { name: '存名片' }))
    await waitFor(() => expect(posts(fetch.calls, '/collab/agent/save')[0]?.body).toEqual({
      name: 'Ben 的代码 Agent', hand: 'window', good_at: '前端', skills: ['g-scoped-implementation', 'huashu-report'], mcp: ['mc1'],
      runtime: { family: 'codex' },
      budget: { minutes: 120 },
      shared: { to: 'workspace', repos: ['/repo/a'], budget_per_day: 20 },
    }))
  })
  it('Agent 名片:四样填了才提交(仓库/模型与强度/智能体文件);名片卡面显示「家 · 模型」(2026-10-22 卡 E)', async () => {
    const reg = [{ id: 'kimi', name: 'Kimi', status: 'idle' }] as unknown as AgentEntryView[]
    const existing = {
      id: 'agent:local:1' as AgentCard['id'], name: 'Kimi 编程', owner: 'me' as const, hand: 'kimi',
      runtime: { family: 'kimi' }, model: { name: 'kimi-for-coding' }, skills: ['g-scoped-implementation'],
      shared: { to: 'none' as const }, created_at: AT, updated_at: AT,
    }
    const { user, fetch } = await openSettings(stateWith([note('x')], { registry: reg, extra: { agent_cards: [existing] } }), 'Agent 名片')
    // 卡面(名片栏)显示「家 · 模型」(设置列表那行同样显示这份)
    expect(screen.getAllByText('kimi · kimi-for-coding').length).toBeGreaterThan(0)
    // 点「改」→ 回填四样 + 勾过的技能(哪一家选中 kimi,段3 出现)
    await user.click(screen.getByRole('button', { name: '改' }))
    const form = screen.getByRole('form', { name: '登记一张 Agent 名片' })
    expect(within(form).getByLabelText('哪一家')).toHaveValue('kimi')
    expect(within(form).getByLabelText('仓库(本地路径)')).toHaveValue('')
    expect(within(form).getByLabelText('范围内实现')).toBeChecked()
    await user.type(within(form).getByLabelText('仓库(本地路径)'), '/repo/k')
    await user.selectOptions(within(form).getByLabelText('强度'), 'high')
    await user.type(within(form).getByLabelText('智能体文件'), 'docs/卡/agents/kimi-coder.md')
    await user.click(within(form).getByRole('button', { name: '存名片' }))
    await waitFor(() => expect(posts(fetch.calls, '/collab/agent/save')[0]?.body).toEqual({
      id: 'agent:local:1', name: 'Kimi 编程', hand: 'window', good_at: '', skills: ['g-scoped-implementation'], mcp: [],
      runtime: { family: 'kimi' }, project: { repo: '/repo/k' },
      model: { name: 'kimi-for-coding', effort: 'high' }, instructions: 'docs/卡/agents/kimi-coder.md',
      budget: { minutes: 120 },
      shared: { to: 'none' },
    }))
  })

  it('Agent 名片:一只体检过的手都没有 → 一句话 + 去体检', async () => {
    const reg = [{ id: 'kimi', name: 'Kimi', status: 'unknown' }] as unknown as AgentEntryView[]
    await openSettings(stateWith([note('x')], { registry: reg }), 'Agent 名片')
    expect(screen.getByText(/一只体检通过的手都没有/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '去体检' })).toBeInTheDocument()
    expect(screen.queryByRole('form', { name: '登记一张 Agent 名片' })).toBeNull()
  })
  it('小队:建一个(组长 + 成员)', async () => {
    const { user, fetch } = await openSettings(stateWith([note('x')], { registry }), '小队')
    const form = screen.getByRole('form', { name: '建一个小队' })
    await user.type(within(form).getByLabelText('名字'), '前端组')
    await user.click(within(form).getByLabelText('Codex'))
    await user.click(within(form).getByRole('button', { name: '建小队' }))
    await waitFor(() => expect(posts(fetch.calls, '/collab/squad/save')[0]?.body).toEqual({ name: '前端组', leader: 'me', members: ['codex'] }))
  })
  it('定时派活:四样齐才存得上', async () => {
    const { user, fetch } = await openSettings(stateWith([note('x')], { registry }), '定时派活')
    const form = screen.getByRole('form', { name: '新建定时派活' })
    await user.type(within(form).getByLabelText('名字'), '每天核对')
    await user.type(within(form).getByLabelText('便签标题'), '核对今日结论')
    expect(within(form).getByRole('button', { name: '存这条定时' })).toBeDisabled()
    await user.type(within(form).getByLabelText('做到什么算完'), '列出三条')
    await user.click(within(form).getByRole('button', { name: '存这条定时' }))
    await waitFor(() => expect(posts(fetch.calls, '/collab/timer/save')[0]?.body).toMatchObject({
      name: '每天核对', trigger: { kind: 'cron', cron: '0 9 * * *' }, assignee: 'codex', template: { title: '核对今日结论', acceptance: ['列出三条'] },
    }))
  })
  it('MCP 库:缺密钥给「填」,值只发给本机、不显示', async () => {
    const mcp = [{ id: 'mc1', name: 'GitHub MCP', url_template: 'https://x/{{T}}', secret_names: ['GITHUB_TOKEN'], missing: ['GITHUB_TOKEN'], created_at: AT, updated_at: AT }]
    const { user, fetch } = await openSettings(stateWith([note('x')], { extra: { mcp } }), '工作室 MCP 库')
    await user.click(screen.getByRole('button', { name: '填 GITHUB_TOKEN' }))
    await user.type(screen.getByLabelText('GITHUB_TOKEN'), 's3cret')
    await user.click(screen.getByRole('button', { name: '存在本机' }))
    await waitFor(() => expect(posts(fetch.calls, '/collab/mcp/secret')[0]?.body).toMatchObject({ name: 'GITHUB_TOKEN', value: 's3cret' }))
    expect(screen.queryByText('s3cret')).toBeNull()
  })
  it('GitHub:没配 client id 如实说;连接中显示设备码', async () => {
    await openSettings(stateWith([note('x')]), '仓库与资源')
    expect(await screen.findByText(/没配 GitHub 应用的 client id/)).toBeInTheDocument()
    cleanup()
    await openSettings(stateWith([note('x')]), '仓库与资源', { state: 'pending', user_code: 'WDJB-MJHT', verification_uri: 'https://github.com/login/device' })
    expect(await screen.findByLabelText('设备码')).toHaveTextContent('WDJB-MJHT')
  })
})

describe('跟着宿主明暗', () => {
  it('宿主底色亮 → 亮版;读不到 → 暗版', () => {
    expect(themeOf('#efefef')).toBe('light')
    expect(themeOf('rgb(16, 16, 16)')).toBe('dark')
    expect(themeOf('')).toBe('dark')
  })
})
