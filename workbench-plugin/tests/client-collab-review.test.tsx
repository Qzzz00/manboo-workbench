import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEntryView, MeetingView, SessionView, TaskView, WorkbenchState } from '../src/protocol.ts'
import { CollabZone, TIMELINE_MODE_KEY } from '../src/client/collab/CollabZone.tsx'

// 这些用例看的是「按日期」那张日程。时间线缺省是人和 Agent 占用(决策记录 10-27「已拍板:呈现语义」),
// 先把偏好选成按日期,同用户切过一次一样。
beforeEach(() => { localStorage.setItem(TIMELINE_MODE_KEY, 'days') })

afterEach(cleanup)
beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never
})

const DAY = '2026-10-21'
const local = (hm: string): string => new Date(`${DAY}T${hm}:00`).toISOString()
const NOW = Date.parse(local('12:24'))
const AT = local('08:00')
const note = (id: string, patch: Partial<TaskView> = {}): TaskView => ({ id, title: id, status: 'todo', source: { kind: 'manual' }, created_at: AT, updated_at: AT, ...patch })
const registry = [
  { id: 'codex', name: 'Codex', status: 'running' },
  { id: 'claude', name: 'Claude', status: 'idle' },
] as unknown as AgentEntryView[]

function stateWith(tasks: TaskView[], opts: { meetings?: MeetingView[], sessions?: SessionView[], extra?: Record<string, unknown> } = {}): WorkbenchState {
  return {
    now: new Date(NOW).toISOString(),
    sessions: opts.sessions ?? [],
    tasks: { tasks, sprints: [], modules: [], project_meta: [], goals: [], goal_sprints: [], agent_cards: [], session_proposals: [], squads: [], timers: [], mcp: [], ...opts.extra },
    agent_registry: { entries: registry, asking: [], notices: [] },
    ...(opts.meetings === undefined ? {} : { meetings: { recent: opts.meetings } }),
  } as unknown as WorkbenchState
}

function fakeFetch(routes: Record<string, unknown> = {}) {
  const calls: { path: string, method: string, body?: Record<string, unknown> }[] = []
  const impl = (async (input: string, init?: RequestInit) => {
    const url = new URL(input)
    const method = init?.method ?? 'GET'
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body)) as Record<string, unknown>
    calls.push({ path: url.pathname, method, ...(body === undefined ? {} : { body }) })
    const hit = routes[`${method} ${url.pathname}`]
    const json = hit ?? (url.pathname === '/collab/canvas' ? { layout: { goals: {}, notes: {} } } : url.pathname.endsWith('/trace') ? { events: [] } : { ok: true })
    return new Response(JSON.stringify(json), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return { calls, impl }
}
const posts = (calls: ReturnType<typeof fakeFetch>['calls'], path: string) => calls.filter(one => one.method === 'POST' && one.path === path)

function zone(state: WorkbenchState, opts: { width?: number, onExpand?: () => void, routes?: Record<string, unknown> } = {}) {
  const fetch = fakeFetch(opts.routes)
  render(
    <div style={{ position: 'relative' }}>
      <CollabZone
        state={state}
        baseUrl="http://127.0.0.1:8791"
        fetchImpl={fetch.impl}
        presence={[]}
        visible
        nowMs={NOW}
        {...(opts.width === undefined ? { timelineWidth: 1228 } : { width: opts.width, timelineWidth: opts.width })}
        {...(opts.onExpand === undefined ? {} : { onExpand: opts.onExpand })}
      />
    </div>,
  )
  return fetch
}

describe('① 一套组件、三种摆法', () => {
  it('窗口槽宽:名片栏露着、三天', () => {
    zone(stateWith([note('a', { start: local('11:00') })]))
    expect(screen.getByRole('complementary', { name: '名片' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: '时间线' })).toHaveAttribute('data-days', '3')
  })
  it('项目区那格(840):两天;名片栏收成入口,点开浮出来;「全屏」整屏只剩协作区', async () => {
    const user = userEvent.setup()
    const onExpand = vi.fn()
    zone(stateWith([note('a', { start: local('11:00') })]), { width: 840, onExpand })
    expect(screen.getByRole('region', { name: '时间线' })).toHaveAttribute('data-days', '2')
    expect(screen.queryByRole('complementary', { name: '名片' })).toBeNull()
    await user.click(screen.getByRole('button', { name: /^\d+ 张名片$/ }))
    expect(screen.getByRole('complementary', { name: '名片' })).toHaveAttribute('data-floating', 'true')
    await user.click(screen.getByRole('button', { name: '全屏' }))
    expect(onExpand).toHaveBeenCalled()
  })
  it('400 宽:一天', () => {
    zone(stateWith([note('a', { start: local('11:00') })]), { width: 400 })
    expect(screen.getByRole('region', { name: '时间线' })).toHaveAttribute('data-days', '1')
  })
})

describe('② 已发生的经过与未来安排同屏', () => {
  it('在跑的会话、交回的那一刻都上时间线;没排期的仍在「未排时间」', async () => {
    const user = userEvent.setup()
    const sessions = [{ agent: 'codex', session_id: 's1', project: 'p', status: 'running', elapsed_sec: 3600, unread: false, updated_at: local('12:20'), title: '修歌词错位' }] as unknown as SessionView[]
    zone(stateWith([
      note('提机接通', { status: 'confirm', receipt: { kind: 'done', text: '做完:1', at: local('10:30'), by: 'claude' } }),
      note('下午那件', { start: local('15:00'), end: local('16:00') }),
      note('没排的'),
    ], { sessions }))
    const tl = screen.getByRole('region', { name: '时间线' })
    expect(within(tl).getByLabelText('会话 修歌词错位')).toBeInTheDocument()
    expect(within(tl).getByLabelText('经过 交回 · 提机接通')).toBeInTheDocument()
    expect(within(tl).getByLabelText('便签 下午那件')).toBeInTheDocument()
    expect(within(tl).getByLabelText('现在')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /^未排时间 \d+$/ }))
    expect(within(screen.getByRole('dialog', { name: '未排时间' })).getByText('没排的')).toBeInTheDocument()
  })
})

describe('④ 头像 + 名称的可点标签', () => {
  const tasks = [
    note('Codex 的', { start: local('11:00'), assignee: 'codex', collaborators: ['me'] }),
    note('Claude 的', { start: local('13:00'), assignee: 'claude' }),
  ]
  it('点卡上的标签:选中这个人,相关的突出、其余原位变淡;再点取消', async () => {
    const user = userEvent.setup()
    zone(stateWith(tasks))
    const card = screen.getByLabelText('便签 Codex 的')
    const label = within(card).getByRole('button', { name: '看 Codex 的相关事项' })
    await user.click(label)
    expect(label).toHaveAttribute('aria-pressed', 'true')
    expect(card).toHaveAttribute('data-related', 'true')
    expect(screen.getByLabelText('便签 Claude 的')).toHaveAttribute('data-dim', 'true')
    await user.click(within(screen.getByLabelText('便签 Codex 的')).getByRole('button', { name: '看 Codex 的相关事项' }))
    expect(screen.getByLabelText('便签 Claude 的')).toHaveAttribute('data-dim', 'false')
  })
  // 10-22 拍板 18 照原型 `.people-strip`:头第三行是一排成员标签(「全部成员」+ 每人头像与名字),点谁看谁的,再点一次或点「全部成员」回来。
  it('默认全部成员;点「你」看协作的那件;点别人按人筛', async () => {
    const user = userEvent.setup()
    zone(stateWith(tasks))
    const strip = screen.getByRole('group', { name: '成员' })
    expect(within(strip).getByRole('button', { name: '全部成员' })).toHaveAttribute('aria-pressed', 'true')
    await user.click(within(strip).getByRole('button', { name: '看 我 的相关事项' }))
    expect(within(screen.getByLabelText('便签 Codex 的')).getByText('协作')).toBeInTheDocument()
    expect(screen.getByLabelText('便签 Claude 的')).toHaveAttribute('data-dim', 'true')
    await user.click(within(strip).getByRole('button', { name: '看 Claude 的相关事项' }))
    expect(screen.getByLabelText('便签 Claude 的')).toHaveAttribute('data-related', 'true')
    expect(screen.getByLabelText('便签 Codex 的')).toHaveAttribute('data-dim', 'true')
    await user.click(within(strip).getByRole('button', { name: '全部成员' }))
    expect(screen.getByLabelText('便签 Codex 的')).toHaveAttribute('data-dim', 'false')
  })
})

describe('③ 会议卡:安排、参与人、记录、决定、后续任务串在一张卡', () => {
  const meeting = (patch: Partial<MeetingView> = {}): MeetingView => ({
    id: 'm1', title: '派活方案评审', date: DAY, started_at: local('09:00'), ended_at: local('09:40'), status: 'done', segments: 2,
    summary: '# 纪要', decisions: ['先验通手机,再做桌面入口'], unsure: [],
    todos: [{ id: 't1', what: '写验收清单', who: '小李' }],
    prep: { people: { value: [{ alias: 'Codex' }, { alias: '小李' }], from: 'said' } },
    ...patch,
  }) as unknown as MeetingView
  it('参与人是标签(对得上名片的能点);决定建便签 → /task/create 带这场会与那句原话', async () => {
    const user = userEvent.setup()
    const fetch = zone(stateWith([], { meetings: [meeting()] }))
    await user.click(screen.getByRole('button', { name: '查看纪要' }))
    const dialog = screen.getByRole('dialog', { name: '会议:派活方案评审' })
    const people = within(dialog).getByLabelText('参与人')
    expect(within(people).getByRole('button', { name: '看 Codex 的相关事项' })).toBeInTheDocument()
    expect(within(people).getByText('小李')).toBeInTheDocument()
    expect(within(dialog).getByRole('region', { name: '会议记录' })).toBeInTheDocument()
    expect(within(dialog).getByRole('region', { name: '后续任务' })).toHaveTextContent('写验收清单')
    const decisions = within(dialog).getByRole('region', { name: '决定' })
    await user.click(within(decisions).getByRole('button', { name: '建便签' }))
    const form = within(decisions).getByRole('form', { name: '从决定建便签:先验通手机,再做桌面入口' })
    await user.selectOptions(within(form).getByLabelText('谁负责'), 'codex')
    await user.type(within(form).getByLabelText('做到什么算完'), '手机上派出去能收回')
    await user.click(within(form).getByRole('button', { name: '贴便签' }))
    await waitFor(() => expect(posts(fetch.calls, '/task/create')[0]?.body).toMatchObject({
      note: true, title: '先验通手机,再做桌面入口', assignee: 'codex', acceptance: ['手机上派出去能收回'],
      from: { kind: 'meeting', ref: 'm1', quote: '先验通手机,再做桌面入口' },
    }))
  })
  it('从决定建过的便签:卡上那条挂「打开便签」,并进关联任务', async () => {
    const user = userEvent.setup()
    const made = note('d1', { title: '先验通手机', from: { kind: 'meeting', ref: 'm1', quote: '先验通手机,再做桌面入口' } })
    zone(stateWith([made], { meetings: [meeting()] }))
    await user.click(screen.getByRole('button', { name: '查看纪要' }))
    const dialog = screen.getByRole('dialog', { name: '会议:派活方案评审' })
    expect(within(within(dialog).getByRole('region', { name: '决定' })).getByRole('button', { name: '打开便签 · 先验通手机' })).toBeInTheDocument()
    expect(within(dialog).getByRole('region', { name: '关联任务' })).toHaveTextContent('先验通手机')
  })
  it('纪要里没有「已确定」的判断:照说,不拿别的充数', async () => {
    const user = userEvent.setup()
    zone(stateWith([], { meetings: [meeting({ decisions: [] })] }))
    await user.click(screen.getByRole('button', { name: '查看纪要' }))
    expect(screen.getByRole('region', { name: '决定' })).toHaveTextContent('没有标「已确定」')
  })
})

describe('⑤ 名片头像', () => {
  it('名片栏「换头像」→ 内置库选一张、预览、保存 → /collab/avatar/save {owner, preset}', async () => {
    const user = userEvent.setup()
    const fetch = zone(stateWith([]))
    await user.click(screen.getByRole('button', { name: '给 Codex 换头像' }))
    const dialog = screen.getByRole('dialog', { name: '更换头像 · Codex' })
    const grid = within(dialog).getByRole('group', { name: '机器人头像' })
    await user.click(within(grid).getByRole('button', { name: '机器人 3' }))
    expect(within(grid).getByRole('button', { name: '机器人 3' })).toHaveAttribute('aria-pressed', 'true')
    expect(within(dialog).getByLabelText('预览').querySelector('[data-custom=true]')).not.toBeNull()
    await user.click(within(dialog).getByRole('button', { name: '保存' }))
    await waitFor(() => expect(posts(fetch.calls, '/collab/avatar/save')[0]?.body).toEqual({ owner: 'codex', preset: 'agent-2' }))
  })
  it('取消什么都不动;你的名片给的是人物头像库', async () => {
    const user = userEvent.setup()
    const fetch = zone(stateWith([]))
    await user.click(screen.getByRole('button', { name: '给 我 换头像' }))
    const dialog = screen.getByRole('dialog', { name: '更换头像 · 我' })
    await user.click(within(within(dialog).getByRole('group', { name: '人物头像' })).getByRole('button', { name: '人物 1' }))
    await user.click(within(dialog).getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('dialog', { name: '更换头像 · 我' })).toBeNull()
    expect(fetch.calls.some(one => one.path.startsWith('/collab/avatar'))).toBe(false)
  })
  it('设过的头像各处标签同步;恢复默认先预览,保存才 → /collab/avatar/reset', async () => {
    const user = userEvent.setup()
    const fetch = zone(stateWith([note('x', { start: local('11:00'), assignee: 'codex' })], { extra: { avatars: { codex: { kind: 'photo', v: 7 } } } }))
    const img = within(screen.getByLabelText('便签 x')).getByRole('button', { name: '看 Codex 的相关事项' }).querySelector('img')
    expect(img).toHaveAttribute('src', 'http://127.0.0.1:8791/collab/avatar/codex.png?v=7')
    await user.click(screen.getByRole('button', { name: '给 Codex 换头像' }))
    const dialog = screen.getByRole('dialog', { name: '更换头像 · Codex' })
    await user.click(within(dialog).getByRole('button', { name: '恢复默认' }))
    expect(within(dialog).getByLabelText('预览').querySelector('img')).toHaveAttribute('src', expect.stringContaining('/agents/icon/codex'))
    expect(posts(fetch.calls, '/collab/avatar/reset')).toHaveLength(0)
    await user.click(within(dialog).getByRole('button', { name: '保存' }))
    await waitFor(() => expect(posts(fetch.calls, '/collab/avatar/reset')[0]?.body).toEqual({ owner: 'codex' }))
  })
  it('上传:格式不对就地说', async () => {
    const user = userEvent.setup({ applyAccept: false })
    zone(stateWith([]))
    await user.click(screen.getByRole('button', { name: '给 Codex 换头像' }))
    const dialog = screen.getByRole('dialog', { name: '更换头像 · Codex' })
    await user.click(within(dialog).getByRole('tab', { name: '上传图片' }))
    await user.upload(within(dialog).getByLabelText('选一张图片'), new File(['x'], 'a.gif', { type: 'image/gif' }))
    expect(within(dialog).getByRole('alert')).toHaveTextContent('PNG、JPG 或 WebP')
  })
})
