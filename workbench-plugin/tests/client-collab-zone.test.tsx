import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { AgentEntryView, CollabPresence, TaskView, WorkbenchState } from '../src/protocol.ts'
import { CollabZone } from '../src/client/collab/CollabZone.tsx'

afterEach(cleanup)
beforeAll(() => {
  // React Flow 量尺寸要它;jsdom 没有。
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never
})

const AT = '2026-10-21T09:00:00.000Z'
const note = (id: string, patch: Partial<TaskView> = {}): TaskView => ({ id, title: id, status: 'todo', source: { kind: 'manual' }, created_at: AT, updated_at: AT, ...patch })

function stateWith(tasks: TaskView[], extra: Partial<NonNullable<WorkbenchState['tasks']>> = {}, registry: AgentEntryView[] = []): WorkbenchState {
  return {
    now: AT,
    sessions: [],
    tasks: { tasks, sprints: [], modules: [], project_meta: [], goals: [{ id: 'g-1', title: '座机打通', why: '出门也能接', owner: 'me', status: 'open', created_at: AT, updated_at: AT }], goal_sprints: [], agent_cards: [], session_proposals: [], ...extra },
    agent_registry: { entries: registry, asking: [], notices: [] },
  } as unknown as WorkbenchState
}

function fakeFetch() {
  const calls: { path: string, method: string, body?: Record<string, unknown> }[] = []
  const impl = (async (input: string, init?: RequestInit) => {
    const url = new URL(input)
    const method = init?.method ?? 'GET'
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body)) as Record<string, unknown>
    calls.push({ path: url.pathname, method, ...(body === undefined ? {} : { body }) })
    const json = url.pathname === '/collab/canvas' && method === 'GET'
      ? { layout: { goals: {}, notes: {} } }
      : url.pathname.endsWith('/trace') ? { events: [{ at: AT, step: 'assigned', family: 'codex' }] } : { ok: true }
    return new Response(JSON.stringify(json), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return { calls, impl }
}

/** 这一份钉的是目标视图;组件态(缺席 onExitFull)= 阅读模式,给了 onExitFull 才是画布(2026-10-24 设计 3.3)。 */
function zone(state: WorkbenchState, presence: CollabPresence[] = [], opts: { onExitFull?: () => void } = {}) {
  const fetch = fakeFetch()
  render(<div style={{ width: 1200, height: 800, position: 'relative' }}><CollabZone state={state} baseUrl="http://127.0.0.1:8791" fetchImpl={fetch.impl} presence={presence} visible initialView="goals" {...(opts.onExitFull === undefined ? {} : { onExitFull: opts.onExitFull })} /></div>)
  return fetch
}

const posts = (calls: ReturnType<typeof fakeFetch>['calls'], path: string) => calls.filter(one => one.method === 'POST' && one.path === path)

describe('协作区:按目标分区,便签贴在区里', () => {
  it('目标区与便签都在;老卡进「未归目标」', async () => {
    zone(stateWith([note('换铃声', { goal_id: 'g-1' }), note('老卡')]))
    expect(await screen.findByLabelText('目标 座机打通')).toBeInTheDocument()
    expect(screen.getByLabelText('目标 未归目标')).toBeInTheDocument()
    expect(screen.getByLabelText('便签 换铃声')).toBeInTheDocument()
    expect(screen.getByLabelText('便签 老卡')).toBeInTheDocument()
  })
  it('四样缺的那几样标在便签上', async () => {
    zone(stateWith([note('老卡')]))
    const card = await screen.findByLabelText('便签 老卡')
    expect(within(card).getByText('目标待定')).toBeInTheDocument()
    expect(within(card).getByText('没写做到什么算完')).toBeInTheDocument()
  })
})

describe('点章改状态;←/→ 照旧在', () => {
  it('点章弹七个,选「在做」→ /task/move', async () => {
    const user = userEvent.setup()
    const fetch = zone(stateWith([note('换铃声', { goal_id: 'g-1' })]))
    const card = await screen.findByLabelText('便签 换铃声')
    await user.click(within(card).getByRole('button', { name: /章:领了/ }))
    const group = within(card).getByRole('group', { name: '改成哪个章' })
    expect(within(group).getAllByRole('button').map(one => one.getAttribute('aria-label'))).toEqual(['待领', '领了', '在做', '等你', '做完', '卡住', '不做'])
    await user.click(within(group).getByRole('button', { name: '在做' }))
    await waitFor(() => expect(posts(fetch.calls, '/task/move').map(one => one.body)).toEqual([{ id: '换铃声', status: 'doing' }]))
  })
  it('选「做完」照表一格一格走(待办 → 在做 → 做完)', async () => {
    const user = userEvent.setup()
    const fetch = zone(stateWith([note('换铃声', { goal_id: 'g-1' })]))
    const card = await screen.findByLabelText('便签 换铃声')
    await user.click(within(card).getByRole('button', { name: /章:领了/ }))
    await user.click(within(within(card).getByRole('group', { name: '改成哪个章' })).getByRole('button', { name: '做完' }))
    await waitFor(() => expect(posts(fetch.calls, '/task/move').map(one => one.body?.status)).toEqual(['doing', 'done']))
  })
  it('→ 挪到右边那个章', async () => {
    const user = userEvent.setup()
    const fetch = zone(stateWith([note('换铃声', { goal_id: 'g-1' })]))
    const card = await screen.findByLabelText('便签 换铃声')
    await user.click(within(card).getByRole('button', { name: /往右挪一格/ }))
    await waitFor(() => expect(posts(fetch.calls, '/task/move')[0]?.body).toEqual({ id: '换铃声', status: 'doing' }))
  })
})

// 10-22 第三轮 4(维护者定 B):一个目标直接放进去,「等你」里一行已办说明;多个 / 没有目标才问。全程不出现「挂」。
describe('现在等你', () => {
  const G2 = { id: 'g-2', title: '登录页', owner: 'me', status: 'open', created_at: AT, updated_at: AT }
  const G1 = { id: 'g-1', title: '座机打通', why: '出门也能接', owner: 'me', status: 'open', created_at: AT, updated_at: AT }

  it('多个目标:一行选择器,默认选中提议的那个;换一个再「放进去」;两颗键下各一行后果', async () => {
    const user = userEvent.setup()
    const fetch = zone(stateWith([note('看样片', { status: 'confirm', goal_id: 'g-1' })], {
      goals: [G1, G2] as never,
      session_proposals: [{ agent: 'codex', session_id: 's-1', title: '修铃声', goal_id: 'g-1', at: AT }],
    }))
    const strip = screen.getByRole('region', { name: '现在等你' })
    expect(within(strip).getByRole('button', { name: '看样片' })).toBeInTheDocument()
    expect(within(strip).getByText('「修铃声」这条会话,放进哪个目标?')).toBeInTheDocument()
    const pick = within(strip).getByRole('combobox', { name: '「修铃声」放进哪个目标' })
    expect(pick).toHaveValue('g-1')
    expect([...(pick as HTMLSelectElement).options].map(one => one.textContent)).toEqual(['座机打通', '登录页', '新建目标…'])
    expect(within(strip).getByText('放进去:看板上多一张在做的便签,进度算进这个目标,以后在它下面跟进验收')).toBeInTheDocument()
    expect(within(strip).getByText('不进看板:看板不出现,以后不再问,这条会话照常跑')).toBeInTheDocument()
    expect(within(strip).getByRole('button', { name: '放进去' })).toHaveClass('ben-cl__primary')
    expect(within(strip).getByRole('button', { name: '不进看板' })).toHaveClass('ben-cl__secondary')
    await user.selectOptions(pick, 'g-2')
    await user.click(within(strip).getByRole('button', { name: '放进去' }))
    await waitFor(() => expect(posts(fetch.calls, '/collab/session/attach')[0]?.body).toMatchObject({ agent: 'codex', session_id: 's-1', goal_id: 'g-2' }))
    expect(await screen.findByText('放进了「登录页」')).toBeInTheDocument()
    expect(strip.textContent).not.toContain('挂')
  })

  // 10-28 任务书 11:对不上任何目标才问,问的时候带默认选项——默认「新建目标…」,名默认会话标题。
  it('有目标但都对不上(提议新目标):下拉里默认选中「新建目标…」,名默认会话标题', async () => {
    const user = userEvent.setup()
    const fetch = zone(stateWith([], {
      goals: [G1, G2] as never,
      session_proposals: [{ agent: 'codex', session_id: 's-1', title: '修铃声', new_goal_title: '修铃声', at: AT }],
    }))
    const strip = screen.getByRole('region', { name: '现在等你' })
    const pick = within(strip).getByRole('combobox', { name: '「修铃声」放进哪个目标' })
    expect(pick).toHaveValue('__new__')
    expect([...(pick as HTMLSelectElement).options].map(one => one.textContent)).toEqual(['座机打通', '登录页', '新建目标…'])
    expect(within(strip).getByRole('textbox', { name: '新目标叫什么' })).toHaveValue('修铃声')
    await user.click(within(strip).getByRole('button', { name: '放进去' }))
    await waitFor(() => expect(posts(fetch.calls, '/collab/session/attach')[0]?.body).toMatchObject({ agent: 'codex', session_id: 's-1', new_goal_title: '修铃声' }))
  })

  it('没有目标:下拉里只有「新建目标…」并选中,新目标名默认会话标题;「不进看板」记下', async () => {
    const user = userEvent.setup()
    const fetch = zone(stateWith([], {
      goals: [] as never,
      session_proposals: [{ agent: 'codex', session_id: 's-1', title: '修铃声', new_goal_title: '修铃声', at: AT }],
    }))
    const strip = screen.getByRole('region', { name: '现在等你' })
    const pick = within(strip).getByRole('combobox', { name: '「修铃声」放进哪个目标' })
    expect([...(pick as HTMLSelectElement).options].map(one => one.textContent)).toEqual(['新建目标…'])
    expect(within(strip).getByRole('textbox', { name: '新目标叫什么' })).toHaveValue('修铃声')
    await user.click(within(strip).getByRole('button', { name: '放进去' }))
    await waitFor(() => expect(posts(fetch.calls, '/collab/session/attach')[0]?.body).toMatchObject({ agent: 'codex', session_id: 's-1', new_goal_title: '修铃声' }))
    await user.click(within(strip).getByRole('button', { name: '不进看板' }))
    await waitFor(() => expect(posts(fetch.calls, '/collab/session/dismiss')[0]?.body).toMatchObject({ agent: 'codex', session_id: 's-1' }))
    expect(await screen.findByText('好,这条会话不进看板')).toBeInTheDocument()
  })

  it('一个目标(已直接放进去):一行已办说明 +「换目标」+「不进看板」,不出问句', async () => {
    const user = userEvent.setup()
    const fetch = zone(stateWith([note('修铃声', { status: 'doing', goal_id: 'g-1', assignee: 'claude', links: [{ agent: 'claude', session_id: 's-9' }] })], {
      session_placed: [{ agent: 'claude', session_id: 's-9', title: '修铃声', task_id: '修铃声', goal_id: 'g-1', at: AT }],
    }))
    const strip = screen.getByRole('region', { name: '现在等你' })
    expect(within(strip).getByText('「修铃声」已放进目标「座机打通」,负责 Claude,在做')).toBeInTheDocument()
    expect(within(strip).queryByText(/放进哪个目标\?/)).toBeNull()
    await user.selectOptions(within(strip).getByRole('combobox', { name: '「修铃声」换目标' }), '__new__')
    await user.click(within(strip).getByRole('button', { name: '换过去' }))
    await waitFor(() => expect(posts(fetch.calls, '/collab/session/placed')[0]?.body).toMatchObject({ agent: 'claude', session_id: 's-9', action: 'move', new_goal_title: '修铃声' }))
    await user.click(within(strip).getByRole('button', { name: '不进看板' }))
    await waitFor(() => expect(posts(fetch.calls, '/collab/session/placed')[1]?.body).toMatchObject({ action: 'remove' }))
    expect(strip.textContent).not.toContain('挂')
  })
})

describe('筛选:筛掉的变淡不消失', () => {
  it('按负责人筛 → 别的便签淡掉', async () => {
    const user = userEvent.setup()
    zone(stateWith([note('a', { goal_id: 'g-1', assignee: 'codex' }), note('b', { goal_id: 'g-1', assignee: 'me' })]))
    await screen.findByLabelText('便签 a')
    await user.click(screen.getByRole('button', { name: '筛选' }))
    const filters = screen.getByRole('group', { name: '筛选' })
    await user.click(within(filters).getByText('负责人'))
    await user.click(within(filters).getByLabelText('Codex'))
    expect(screen.getByLabelText('便签 a')).toHaveAttribute('data-dim', 'false')
    expect(screen.getByLabelText('便签 b')).toHaveAttribute('data-dim', 'true')
  })
})

describe('点便签开详情:七块', () => {
  it('七块都在;经手里有账上的那几步;「通过」= 留一句 + 照表走到做完', async () => {
    const user = userEvent.setup()
    const fetch = zone(stateWith([note('看样片', { status: 'confirm', goal_id: 'g-1', acceptance: ['能播'], from: { kind: 'said', quote: '帮我看看样片' } })]))
    const card = await screen.findByLabelText('便签 看样片')
    await user.click(within(card).getByRole('button', { name: '看样片' }))
    const dialog = screen.getByRole('dialog', { name: '便签:看样片' })
    for (const block of ['头', '前因后果', '经手', '各阶段产出', '文件与仓库', '留言', '等他的']) {
      expect(within(dialog).getByRole('region', { name: block })).toBeInTheDocument()
    }
    expect(within(dialog).getByText('出门也能接')).toBeInTheDocument()
    expect(within(dialog).getByText('帮我看看样片')).toBeInTheDocument()
    expect(await within(dialog).findByText(/派给 · Codex/)).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: '通过' }))
    await waitFor(() => expect(posts(fetch.calls, '/task/comment')[0]?.body).toMatchObject({ id: '看样片', verdict: 'pass' }))
    await waitFor(() => expect(posts(fetch.calls, '/task/move').map(one => one.body?.status)).toEqual(['done']))
  })
  it('窗口型那家的执行回放如实说没有记录', async () => {
    const user = userEvent.setup()
    zone(stateWith([note('问豆包', { goal_id: 'g-1', client_dispatch: { hand: 'window', family: 'doubao', status: 'sent', at: AT, text: 'x' } as never })]))
    await user.click(within(await screen.findByLabelText('便签 问豆包')).getByRole('button', { name: '问豆包' }))
    expect(screen.getByText(/这家没有记录,只有窗里看见的/)).toBeInTheDocument()
  })
})

describe('右下对话气泡 = 事务官输入口带当前便签', () => {
  it('选中一张(没开会话)→ /butler/item 带 refs', async () => {
    const user = userEvent.setup()
    const fetch = zone(stateWith([note('换铃声', { goal_id: 'g-1' })]))
    await user.click(within(await screen.findByLabelText('便签 换铃声')).getByRole('button', { name: '换铃声' }))
    await user.click(screen.getByRole('button', { name: '关上' }))
    // 关上详情后选中的那张不再是「当前便签」,所以重新点开再从气泡说:气泡读的是此刻开着的那张。
    await user.click(within(screen.getByLabelText('便签 换铃声')).getByRole('button', { name: '换铃声' }))
    await user.click(screen.getByRole('button', { name: '记一件事' }))
    const bubble = screen.getByRole('dialog', { name: '跟事务官说' })
    expect(within(bubble).getByText('正在说:换铃声')).toBeInTheDocument()
    await user.type(within(bubble).getByRole('textbox', { name: '对事务官说' }), '派给 Codex')
    await user.click(within(bubble).getByRole('button', { name: '发给事务官' }))
    await waitFor(() => expect(posts(fetch.calls, '/butler/item')[0]?.body).toEqual({ text: '派给 Codex', refs: [{ kind: 'item', id: '换铃声' }] }))
  })
})

describe('名片栏与 Agent 小鼠标', () => {
  it('你 + 本机几家;小鼠标停在便签上,名片上写着在哪张', async () => {
    const registry = [
      { id: 'dsh', name: '事务官', self: true, status: 'idle' },
      { id: 'codex', name: 'Codex', status: 'running', color: '#7ee787' },
    ] as unknown as AgentEntryView[]
    // 正向场景是真实开工:那张便签在做(doing)。小鼠标只对 doing 的便签画
    // (collabModel.visiblePresence 的守门,2026-10-23 起 todo 上的 working 不再显示光标)。
    // 小鼠标是画布那一档的画法:全屏画布才画;组件态阅读模式便签上只有 working 圈。
    zone(stateWith([note('换铃声', { goal_id: 'g-1', status: 'doing' })], {}, registry), [{ actor: { kind: 'agent', id: 'codex' }, on_note: '换铃声', state: 'working', at: AT }], { onExitFull: () => {} })
    // 2026-10-27 起目标视图右边缺省是事项轨迹,名片栏点「N 张名片」才换过来。
    fireEvent.click(screen.getByRole('button', { name: /张名片$/ }))
    const rail = screen.getByRole('complementary', { name: '名片' })
    expect(within(rail).getByRole('button', { name: '看 我 的事' })).toBeInTheDocument()
    expect(within(rail).getByRole('button', { name: '在「换铃声」上' })).toBeInTheDocument()
    expect(await screen.findByLabelText('Codex 的小鼠标')).toBeInTheDocument()
    expect(screen.getByLabelText('便签 换铃声')).toHaveAttribute('data-working', 'true')
  })
  it('便签还是 todo(没开工):小鼠标不显示 —— 卡片上的字不代替已开工事实', async () => {
    const registry = [
      { id: 'codex', name: 'Codex', status: 'running', color: '#7ee787' },
    ] as unknown as AgentEntryView[]
    zone(stateWith([note('换铃声', { goal_id: 'g-1' })], {}, registry), [{ actor: { kind: 'agent', id: 'codex' }, on_note: '换铃声', state: 'working', at: AT }], { onExitFull: () => {} })
    await screen.findByLabelText('便签 换铃声')
    // 守门在 collabModel.visiblePresence:agent 光标只对 doing 的便签画;todo 上那个
    // presence 收掉,小鼠标不出现。(便签上那圈 working 高亮是另一条产品行为,不由这道门管。)
    expect(screen.queryByLabelText('Codex 的小鼠标')).toBeNull()
  })
  it('登记一个 Agent → /collab/agent/save', async () => {
    const user = userEvent.setup()
    const registry = [{ id: 'codex', name: 'Codex', status: 'running' }] as unknown as AgentEntryView[]
    const fetch = zone(stateWith([], {}, registry))
    // 2026-10-27 起目标视图右边缺省是事项轨迹,名片栏点「N 张名片」才换过来。
    fireEvent.click(screen.getByRole('button', { name: /张名片$/ }))
    const rail = screen.getByRole('complementary', { name: '名片' })
    await user.click(within(rail).getByRole('button', { name: '登记一个 Agent' }))
    await user.type(within(rail).getByLabelText('名字'), 'Ben 的代码 Agent')
    await user.selectOptions(within(rail).getByLabelText('哪只手'), 'codex')
    await user.click(within(rail).getByRole('button', { name: '登记' }))
    await waitFor(() => expect(posts(fetch.calls, '/collab/agent/save')[0]?.body).toEqual({ name: 'Ben 的代码 Agent', hand: 'codex', good_at: '' }))
  })
})
