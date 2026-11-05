/**
 * 「我照你说的摆好了」那张卡(2026-09-24 晚,卡 feat/onboarding-materialize)—— 电脑首页球下面那一摞的最上面。
 *
 * 单子是拿维护者那份存档的副本真排出来的(server/materialize.ts `buildPlan`),不是手写的假数据。钉住:
 *   - 按组摆出来(项目 / 冲刺 / 每天 / 桌面 / 记忆 / 撤掉 / 第一件),小字写负责人、截止、等你确认、为什么撤;
 *   - 他点「就这样」之前一条请求都不发;勾掉的、改过的原样交上去;
 *   - 占位的(窗口槽等卡 C、额度要他点)勾不上;
 *   - 落完只留一句回执,能「收起」。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { cleanup, render, screen, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EvolveProposalView, MaterializeStateView, TaskView, WorkbenchState } from '../src/protocol.ts'
import { MaterializeAsk } from '../src/client/MaterializeAsk.tsx'
import { ButlerInbox, type ButlerInboxProps } from '../src/client/ButlerInbox.tsx'
import { applyPayload, shouldShow } from '../src/client/materializeAskModel.ts'
import type { MaterializeArchive } from '../src/server/materialize.ts'
import { buildPlan, rulesExtract } from '../src/server/materialize.ts'

afterEach(() => { cleanup(); globalThis.localStorage?.clear() })

// jsdom 环境里 import.meta.url 不是 file://,夹具按工作目录(workbench-plugin)找。
const fixture = (name: string): string => readFileSync(resolve(process.cwd(), 'tests', 'fixtures', 'materialize', name), 'utf8')
const archive = JSON.parse(fixture('onboarding-0924.json')) as MaterializeArchive
const tasks = (JSON.parse(fixture('tasks-0924.json')) as { tasks: TaskView[] }).tasks

function view(over: Partial<MaterializeStateView> = {}): MaterializeStateView {
  const plan = buildPlan({
    now: new Date('2026-09-24T12:30:00Z'), today: '2026-09-24', archive, extraction: rulesExtract(archive, '2026-09-24'),
    board: { tasks, sprints: [], modules: [] },
    projects: { stored: [{ id: 'desktop-workbench', name: 'desktop-workbench', repoPath: '/Users/example/Documents/GitHub/desktop-workbench' }], repos: [{ id: 'echo', name: 'Echo', path: '/Users/example/Documents/GitHub/Echo' }] },
    routines: { morning: {}, evening: { at: '18:30' } }, quiet: { from: '23:00', to: '08:00' },
    apps: { enabled: ['claude', 'codex', 'kimi', 'wechat', 'wecom'] }, readClientFiles: '可以', currentVersion: '0.2.83',
    codexThread: { id: '01a0ccd1', title: '制作参赛网页' },
    wired: { tasks: true, projects: true, routines: true, quiet: true, feed: true, slot: false, quota: false, memories: true, dispatch: true },
  })
  return {
    id: plan.id, status: 'pending', line: plan.line, source: plan.source, counts: plan.counts, groups: plan.groups,
    rows: plan.rows.map(({ data: _data, ...row }) => row), created_at: plan.created_at, ...over,
  }
}

function stub(reply: Record<string, unknown> = { ok: true, line: '派出去了,做完叫你。' }, status = 200) {
  const calls: { path: string, body: Record<string, unknown> }[] = []
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ path: new URL(String(input)).pathname, body: typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {} })
    return new Response(JSON.stringify(reply), { status, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  return { impl, calls }
}

describe('我照你说的摆好了', () => {
  it('按组摆出来,小字写清;占位的勾不上;点「就这样」之前一条请求都不发', () => {
    const net = stub()
    render(<MaterializeAsk view={view()} baseUrl="http://x" fetchImpl={net.impl} />)
    const card = screen.getByRole('region', { name: '我照你说的摆好了' })
    expect(within(card).getByText('2 个项目、10 件事、撤掉 7 条旧的 · 等你点头')).toBeTruthy()
    for (const title of ['项目', '冲刺 · Spotlight 参赛 · 10-04', '每天', '桌面', '记忆', '撤掉(改成「取消」,不删)', '第一件']) {
      expect(within(card).getByText(title)).toBeTruthy()
    }
    expect(within(card).getByText('负责:Codex · 进行中')).toBeTruthy()
    expect(within(card).getByText('负责:我 · 等你确认')).toBeTruthy()
    // 两条 0.2.80 的都写着为什么撤。
    expect(within(card).getAllByText('照搬中午交接的旧清单:提到 0.2.80,现在已经 0.2.83')).toHaveLength(2)
    const slot = within(card).getByRole('checkbox', { name: '窗口槽:Claude、Codex、Kimi、微信、企业微信' }) as HTMLInputElement
    expect(slot.disabled).toBe(true)
    expect(slot.checked).toBe(false)
    expect(net.calls).toEqual([])
  })

  it('勾掉一件、改一件的标题与负责人 →「就这样」交上去的是他动过的那几样', async () => {
    const user = userEvent.setup()
    const net = stub()
    const v = view()
    render(<MaterializeAsk view={v} baseUrl="http://x" fetchImpl={net.impl} />)
    await user.click(screen.getByRole('checkbox', { name: '参赛视频' }))
    await user.click(screen.getByRole('button', { name: '改一下' }))
    const title = screen.getByRole('textbox', { name: '改标题:打磨自媒体布局' })
    await user.clear(title)
    await user.type(title, '打磨自媒体布局(新电脑)')
    await user.selectOptions(screen.getByRole('combobox', { name: '改负责人:打磨自媒体布局' }), 'codex')
    await user.click(screen.getByRole('button', { name: '就这样' }))
    const video = v.rows.find(row => row.title === '参赛视频')?.key as string
    const layout = v.rows.find(row => row.title === '打磨自媒体布局')?.key as string
    expect(net.calls).toEqual([{ path: '/onboarding/materialize/apply', body: { id: v.id, uncheck: [video], edits: { [layout]: { title: '打磨自媒体布局(新电脑)', owner: 'codex' } } } }])
  })

  it('没落成:把原话摆出来,单子还在', async () => {
    const user = userEvent.setup()
    const net = stub({ error: '正在落,等这一次落完' }, 409)
    render(<MaterializeAsk view={view()} baseUrl="http://x" fetchImpl={net.impl} />)
    await user.click(screen.getByRole('button', { name: '就这样' }))
    expect((await screen.findByRole('alert')).textContent).toBe('正在落,等这一次落完')
  })

  it('落完:只留一句回执与没落上的那几样;「收起」之后这张单子不再出来', async () => {
    const user = userEvent.setup()
    const net = stub()
    const done = view({
      status: 'applied', applied_at: new Date().toISOString(),
      result: { ok: false, line: '派出去了,做完叫你。有 1 样没落上,屏幕上写着是哪几样。', rows: [{ key: 'routine:morning', title: '早上 8 点半:播客和早报准备好', ok: false, note: '例程没接上' }] },
    })
    const { rerender } = render(<MaterializeAsk view={done} baseUrl="http://x" fetchImpl={net.impl} />)
    expect(screen.getByRole('status').textContent).toBe('派出去了,做完叫你。有 1 样没落上,屏幕上写着是哪几样。')
    expect(screen.getByText('早上 8 点半:播客和早报准备好:例程没接上')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '收起' }))
    rerender(<MaterializeAsk view={done} baseUrl="http://x" fetchImpl={net.impl} />)
    expect(screen.queryByRole('region', { name: '我照你说的摆好了' })).toBeNull()
  })

  it('落完超过十分钟自己收起;没有单子不渲染', () => {
    const at = Date.parse('2026-09-24T12:00:00Z')
    const done = view({ status: 'applied', applied_at: new Date(at).toISOString() })
    expect(shouldShow(done, at + 5 * 60_000, undefined)).toBe(true)
    expect(shouldShow(done, at + 11 * 60_000, undefined)).toBe(false)
    expect(shouldShow(undefined, at, undefined)).toBe(false)
    expect(applyPayload(view(), {})).toEqual({ id: view().id })
  })
})

describe('免打扰到几点也能「改一下」(统筹 09-25:默认 08:30)', () => {
  it('「改一下」里那一行给一个「到几点」的下拉;改成 8 点,标题跟着变,交上去的是 edits.to', async () => {
    const user = userEvent.setup()
    const net = stub()
    const v = view()
    render(<MaterializeAsk view={v} baseUrl="http://x" fetchImpl={net.impl} />)
    const quiet = v.rows.find(row => row.kind === 'quiet')
    expect(quiet?.time).toEqual({ from: '21:00', to: '08:30' })
    expect(screen.queryByRole('combobox', { name: /改到几点/ })).toBeNull()
    await user.click(screen.getByRole('button', { name: '改一下' }))
    await user.selectOptions(screen.getByRole('combobox', { name: `改到几点:${quiet?.title as string}` }), '08:00')
    expect(screen.getByText('晚上 9 点到早上 8 点不打扰')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '就这样' }))
    expect(net.calls[0]?.body).toEqual({ id: v.id, edits: { [quiet?.key as string]: { to: '08:00' } } })
  })
})

describe('摆在球下面「要你处理的」那一区(卡 A 的新首页)', () => {
  const EVOLVE: EvolveProposalView = {
    id: 'evolve:x', ask: '这 3 次你都在说「整理选题」—— 要不要把它固化下来?', sample: '整理选题', times: 3,
    says: ['整理选题 A', '整理选题 B', '整理选题 C'], suggested_way: 'skill',
    plans: { skill: '先是草稿', tool: '不替你发出去', template: '还没做' }, created_at: '2026-09-24T12:30:00.000Z',
  }
  function props(state: Partial<WorkbenchState>): ButlerInboxProps {
    return {
      state: { agents: [], sessions: [], quota: {}, now: '2026-09-24T12:30:00.000Z', stale: false, tasks: { tasks: [], sprints: [], modules: [], project_meta: [] }, butler_inbox: { items: [] }, ...state },
      baseUrl: 'http://127.0.0.1:8791', fetchImpl: stub().impl, onOpenConversation: vi.fn(), draft: '', onDraftChange: vi.fn(), visible: true,
      controls: { paused: false, testRinging: false, onPause: vi.fn(), onTestRing: vi.fn(), onCancelWatch: vi.fn(), onDismissBrief: vi.fn(), proposals: [] },
    }
  }

  it('在 asks 表第一个:排在固化提议前面,在球下面那一区里,最前面那一道光归它', () => {
    const v = view()
    render(<ButlerInbox {...props({ materialize: v, evolve: { pending: [EVOLVE] } })} />)
    const below = screen.getByRole('region', { name: /球下面/ })
    const asks = [...below.querySelectorAll('[data-ask]')].map(one => one.getAttribute('data-ask'))
    expect(asks).toEqual([`laid:${v.id}`, 'evolve:evolve:x'])
    expect(within(below).getByRole('region', { name: '我照你说的摆好了' })).toBeTruthy()
    const beams = [...document.querySelectorAll('[data-fx="ask"]')]
    expect(beams[0]?.getAttribute('data-fx-active')).toBe('true')
    expect(beams[0]?.querySelector('.ben-wb__laid')).not.toBeNull()
  })

  it('落完点「收起」:那一格整个不在表里(不留空框、不抢那道光)', async () => {
    const user = userEvent.setup()
    const done = view({ status: 'applied', applied_at: new Date().toISOString(), result: { ok: true, line: '派出去了,做完叫你。', rows: [] } })
    render(<ButlerInbox {...props({ materialize: done, evolve: { pending: [EVOLVE] } })} />)
    expect(document.querySelector(`[data-ask="laid:${done.id}"]`)).not.toBeNull()
    await user.click(screen.getByRole('button', { name: '收起' }))
    expect(document.querySelector(`[data-ask="laid:${done.id}"]`)).toBeNull()
    expect([...document.querySelectorAll('[data-ask]')].map(one => one.getAttribute('data-ask'))).toEqual(['evolve:evolve:x'])
  })
})

describe('真壳里摆不下时(卡 fix/materialize-card-fit):底栏钉在卡里,「看全部」把整张单子摊在事务官这一档上面', () => {
  const EVOLVE_NONE = { pending: [] }
  function inbox(state: Partial<WorkbenchState>, fetchImpl: typeof fetch = stub().impl): ButlerInboxProps {
    return {
      state: { agents: [], sessions: [], quota: {}, now: '2026-09-24T12:30:00.000Z', stale: false, tasks: { tasks: [], sprints: [], modules: [], project_meta: [] }, butler_inbox: { items: [] }, evolve: EVOLVE_NONE, ...state },
      baseUrl: 'http://127.0.0.1:8791', fetchImpl, onOpenConversation: vi.fn(), draft: '', onDraftChange: vi.fn(), visible: true,
      controls: { paused: false, testRinging: false, onPause: vi.fn(), onTestRing: vi.fn(), onCancelWatch: vi.fn(), onDismissBrief: vi.fn(), proposals: [] },
    }
  }

  it('卡是「卡头 / 行区 / 底栏」三截:「就这样」「改一下」「看全部」在底栏里,不在行区里', () => {
    render(<ButlerInbox {...inbox({ materialize: view() })} />)
    const card = document.querySelector('.ben-wb__scene-below .ben-wb__laid') as HTMLElement
    const foot = card.querySelector('.ben-wb__laid-foot') as HTMLElement
    const rows = card.querySelector('.ben-wb__laid-scroll') as HTMLElement
    for (const name of ['就这样', '改一下', '看全部']) {
      expect(within(foot).getByRole('button', { name })).toBeTruthy()
      expect(within(rows).queryByRole('button', { name })).toBeNull()
    }
    // 底栏排在行区后面(行区滚、底栏不滚)。
    expect(rows.compareDocumentPosition(foot) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // 单子等他点头时,这一档标着 data-laid=pending(球让一让的那条样式靠它)。
    expect(document.querySelector('.ben-wb__items--particle')?.getAttribute('data-laid')).toBe('pending')
  })

  it('「看全部」:整张单子摊在这一档上面(卡头有「收起」);在那里勾掉一件点「就这样」,交上去的是他动过的;「收起」回去', async () => {
    const user = userEvent.setup()
    const net = stub()
    const v = view()
    render(<ButlerInbox {...inbox({ materialize: v }, net.impl)} />)
    await user.click(screen.getByRole('button', { name: '看全部' }))
    const sheet = screen.getByRole('dialog', { name: '我照你说的摆好了(整张)' })
    expect(sheet.closest('.ben-wb__items--particle')).not.toBeNull()
    await user.click(within(sheet).getByRole('checkbox', { name: '参赛视频' }))
    await user.click(within(sheet).getByRole('button', { name: '就这样' }))
    const video = v.rows.find(row => row.title === '参赛视频')?.key as string
    expect(net.calls.find(call => call.path === '/onboarding/materialize/apply')?.body).toEqual({ id: v.id, uncheck: [video] })
    await user.click(within(sheet).getByRole('button', { name: '收起' }))
    expect(screen.queryByRole('dialog', { name: '我照你说的摆好了(整张)' })).toBeNull()
  })

  it('落好了:这一档不再标 pending;摊开着的那一张换成回执,「收起」一并收掉', async () => {
    const user = userEvent.setup()
    const v = view()
    const { rerender } = render(<ButlerInbox {...inbox({ materialize: v })} />)
    await user.click(screen.getByRole('button', { name: '看全部' }))
    const done = { ...v, status: 'applied' as const, applied_at: new Date().toISOString(), result: { ok: true, line: '派出去了,做完叫你。', rows: [] } }
    rerender(<ButlerInbox {...inbox({ materialize: done })} />)
    expect(document.querySelector('.ben-wb__items--particle')?.getAttribute('data-laid')).toBeNull()
    const sheet = screen.getByRole('dialog', { name: '我照你说的摆好了(整张)' })
    expect(within(sheet).getByRole('status').textContent).toBe('派出去了,做完叫你。')
    await user.click(within(sheet).getByRole('button', { name: '收起' }))
    expect(screen.queryByRole('dialog', { name: '我照你说的摆好了(整张)' })).toBeNull()
    expect(document.querySelector(`[data-ask="laid:${v.id}"]`)).toBeNull()
  })
})

