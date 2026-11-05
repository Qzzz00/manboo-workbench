/**
 * 球下那一区摆不下时(卡 fix/materialize-card-fit;统筹拍板:粒子球是主角,球不让,卡片收成行)。
 *
 * jsdom 没有布局,量不出那一区多高:这里把「量」换成一个可调的数(asksFit.measureAsksRoom),看 ButlerInbox 怎么摆。
 * 真布局下的样子与量出来的数在 docs/交接-0925-单子摆得下/(真壳 1475×812、1280×800、1920×1200)。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { cleanup, render, screen, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EvolveProposalView, MaterializeStateView, TaskView, WorkbenchState } from '../src/protocol.ts'
import type { MaterializeArchive } from '../src/server/materialize.ts'
import { buildPlan, rulesExtract } from '../src/server/materialize.ts'
import { ASKS_FULL_MIN, asksMode, asksSummaryText } from '../src/client/asksFit.ts'

const room = { value: undefined as number | undefined }
vi.mock('../src/client/asksFit.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/client/asksFit.ts')>()
  return { ...actual, measureAsksRoom: () => room.value }
})
// 在 mock 之后才拿 ButlerInbox(它 import 的是换过「量」的那一份)。
const { ButlerInbox } = await import('../src/client/ButlerInbox.tsx')

afterEach(() => { cleanup(); room.value = undefined; globalThis.localStorage?.clear() })

const fixture = (name: string): string => readFileSync(resolve(process.cwd(), 'tests', 'fixtures', 'materialize', name), 'utf8')
const archive = JSON.parse(fixture('onboarding-0924.json')) as MaterializeArchive
const tasks = (JSON.parse(fixture('tasks-0924.json')) as { tasks: TaskView[] }).tasks

function plan(): MaterializeStateView {
  const built = buildPlan({
    now: new Date('2026-09-24T12:30:00Z'), today: '2026-09-24', archive, extraction: rulesExtract(archive, '2026-09-24'),
    board: { tasks, sprints: [], modules: [] },
    projects: { stored: [{ id: 'desktop-workbench', name: 'desktop-workbench', repoPath: '/Users/example/Documents/GitHub/desktop-workbench' }], repos: [{ id: 'echo', name: 'Echo', path: '/Users/example/Documents/GitHub/Echo' }] },
    routines: { morning: {}, evening: { at: '18:30' } }, quiet: { from: '23:00', to: '08:00' },
    apps: { enabled: ['claude', 'codex', 'kimi', 'wechat', 'wecom'] }, readClientFiles: '可以', currentVersion: '0.2.83',
    codexThread: { id: '01a0ccd1', title: '制作参赛网页' },
    wired: { tasks: true, projects: true, routines: true, quiet: true, feed: true, slot: false, quota: false, memories: true, dispatch: true },
  })
  return { id: built.id, status: 'pending', line: built.line, source: built.source, counts: built.counts, groups: built.groups, rows: built.rows.map(({ data: _data, ...row }) => row), created_at: built.created_at }
}
const EVOLVE: EvolveProposalView = {
  id: 'evolve:x', ask: '这 3 次你都在说「**整理选题**」—— 要不要把它固化下来?', sample: '整理选题', times: 3,
  says: ['整理选题 A', '整理选题 B', '整理选题 C'], suggested_way: 'skill', plans: { skill: '先是草稿', tool: '不替你发出去', template: '还没做' }, created_at: '2026-09-24T12:30:00.000Z',
}
const QUOTA = {
  providers: [{ agent: 'claude', label: 'Claude', state: 'one_click' }, { agent: 'kimi', label: 'Kimi', state: 'login' }], one_click: true, line: 'Claude 要你点一次「全部接上」',
} as unknown as NonNullable<WorkbenchState['quota_connect']>

function stub() {
  const calls: { path: string, body: unknown }[] = []
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ path: new URL(String(input)).pathname, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined })
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  return { impl, calls }
}
function props(state: Partial<WorkbenchState>, fetchImpl: typeof fetch = stub().impl) {
  return {
    state: { agents: [], sessions: [], quota: {}, now: '2026-09-24T12:30:00.000Z', stale: false, tasks: { tasks: [], sprints: [], modules: [], project_meta: [] }, butler_inbox: { items: [] }, onboarding: { stage: 'done', done: true }, ...state } as WorkbenchState,
    baseUrl: 'http://127.0.0.1:8791', fetchImpl, onOpenConversation: vi.fn(), draft: '', onDraftChange: vi.fn(), visible: true,
    controls: { paused: false, testRinging: false, onPause: vi.fn(), onTestRing: vi.fn(), onCancelWatch: vi.fn(), onDismissBrief: vi.fn(), proposals: [] },
  }
}

describe('摆得下多少:整张 → 每张一行 → 只留一行「还有 N 件要你看」', () => {
  it('asksMode:量不出来 / 没有卡 → 整张;够高 → 整张;一行一张摆得下 → 每张一行(差 1px 以内算摆得下);再不够 → 只留一行', () => {
    expect(asksMode(undefined, 3)).toBe('full')
    expect(asksMode(20, 0)).toBe('full')
    expect(asksMode(ASKS_FULL_MIN, 2)).toBe('full')
    expect(asksMode(21, 1)).toBe('rows')
    expect(asksMode(20, 1)).toBe('rows')
    expect(asksMode(21, 3)).toBe('summary')
    expect(asksMode(144, 3)).toBe('rows')
    expect(asksSummaryText(3)).toBe('还有 3 件要你看')
  })

  it('真壳 1475×812 那样只剩一行:单子收成「标题 + 就这样 / 改一下 / 看全部」,点「就这样」照样交上去;「看全部」摊开整张', async () => {
    room.value = 21
    const user = userEvent.setup()
    const net = stub()
    const v = plan()
    render(<ButlerInbox {...props({ materialize: v }, net.impl)} />)
    expect(document.querySelector('.ben-wb__items--particle')?.getAttribute('data-asks-mode')).toBe('rows')
    const row = document.querySelector(`.ben-wb__askrow[data-ask="laid:${v.id}"]`) as HTMLElement
    expect(within(row).getByText('我照你说的摆好了')).toBeTruthy()
    for (const name of ['就这样', '改一下', '看全部']) expect(within(row).getByRole('button', { name })).toBeTruthy()
    // 行区那几十行一条都不在球下面(整张不摆)。
    expect(document.querySelector('.ben-wb__scene-below .ben-wb__laid-scroll')).toBeNull()
    await user.click(within(row).getByRole('button', { name: '就这样' }))
    expect(net.calls.find(call => call.path === '/onboarding/materialize/apply')?.body).toEqual({ id: v.id })
    await user.click(within(row).getByRole('button', { name: '看全部' }))
    expect(within(screen.getByRole('dialog', { name: '我照你说的摆好了(整张)' })).getByRole('button', { name: '就这样' })).toBeTruthy()
  })

  it('三张摆在这一区、只剩一行:只留「还有 2 件要你看 · 展开」(额度提醒摆着但不进数,卡 M 追加);展开是整张的几张(单子在那里是一行),「收起」回去', async () => {
    room.value = 21
    const user = userEvent.setup()
    const v = plan()
    render(<ButlerInbox {...props({ materialize: v, evolve: { pending: [EVOLVE] }, quota_connect: QUOTA })} />)
    expect(document.querySelector('.ben-wb__items--particle')?.getAttribute('data-asks-mode')).toBe('summary')
    const summary = document.querySelector('.ben-wb__askrow[data-ask="summary"]') as HTMLElement
    expect(within(summary).getByText('还有 2 件要你看')).toBeTruthy()
    expect(document.querySelector('.ben-wb__scene-below .ben-wb__evolveask')).toBeNull()
    await user.click(within(summary).getByRole('button', { name: '展开' }))
    const sheet = screen.getByRole('dialog', { name: '要你看的' })
    expect(within(sheet).getByText('要你看的 2 件')).toBeTruthy()
    expect(sheet.querySelector(`[data-ask="laid:${v.id}"] .ben-wb__laid--row`)).not.toBeNull()
    expect(within(sheet).getByRole('region', { name: '待确认的固化提议' })).toBeTruthy()
    expect(within(sheet).getByRole('region', { name: '额度还差一步' })).toBeTruthy()
    await user.click(within(sheet).getByRole('button', { name: '收起' }))
    expect(screen.queryByRole('dialog', { name: '要你看的' })).toBeNull()
  })

  it('三张、摆得下三行:每张一行(固化提议那句去掉 ** 记号,额度那张写「额度还差一步」),各带「展开」', () => {
    room.value = 144
    const v = plan()
    render(<ButlerInbox {...props({ materialize: v, evolve: { pending: [EVOLVE] }, quota_connect: QUOTA })} />)
    const rows = [...document.querySelectorAll('.ben-wb__scene-below .ben-wb__askrow')].map(one => one.getAttribute('data-ask'))
    expect(rows).toEqual([`laid:${v.id}`, 'evolve:evolve:x', 'quota'])
    expect(screen.getByText('这 3 次你都在说「整理选题」—— 要不要把它固化下来?')).toBeTruthy()
    expect(screen.getByText('额度还差一步')).toBeTruthy()
    expect(screen.getAllByRole('button', { name: '展开' })).toHaveLength(2)
  })

  it('够高:整张摆着(单子三截、行区滚)', () => {
    room.value = 400
    const v = plan()
    render(<ButlerInbox {...props({ materialize: v })} />)
    expect(document.querySelector('.ben-wb__items--particle')?.getAttribute('data-asks-mode')).toBe('full')
    expect(document.querySelector('.ben-wb__scene-below .ben-wb__laid-scroll')).not.toBeNull()
    expect(document.querySelector('.ben-wb__scene-below .ben-wb__askrow')).toBeNull()
  })
})
