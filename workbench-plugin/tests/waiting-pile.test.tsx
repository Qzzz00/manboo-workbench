/**
 * 「等你」那一堆:同一份状态喂给各处,数字相等(2026-09-25,卡 M 追加;统筹:维护者的硬规矩「同一件事的数字各处一致」)。
 *
 * 那一份状态在 tests/fixtures/waiting-state.json —— 手机那边的用例(butler-app/tests/waitingPile.test.tsx)喂的也是它。
 * 这里核对:
 *   - 服务端的那一个函数(src/waiting.ts `waitingOnHim`)算出来的,与那一份里手写的 `waiting` 一字不差(手机只读这一格);
 *   - 电脑上四处:球下「等你 n」、汇报条「等你 n 件」、球下那一区摆出来的那几张 /「要你看的 N 件」、「事务官」标签上的数与气泡,
 *     都是同一个数、同一堆。「额度还差一步」摆着,但不进数。
 */
import '@testing-library/jest-dom/vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TaskView, WaitingView, WorkbenchState } from '../src/protocol.ts'
import { waitingOf, waitingOnHim } from '../src/waiting.ts'
import { ButlerInbox } from '../src/client/ButlerInbox.tsx'
import { butlerReportLine } from '../src/client/butlerInbox.ts'
import { WorkbenchOverlay, type MinimalWebSocket, type WorkbenchOverlayProps } from '../src/client/Workbench.tsx'
import { createWorkbenchStore } from '../src/client/store.ts'
import { UNUSED_STANDARD_PROPS } from './helpers/standardProps.ts'

configure({ asyncUtilTimeout: 5_000 })
afterEach(() => { cleanup(); globalThis.localStorage?.clear() })

const FIXTURE = JSON.parse(readFileSync(resolve(process.cwd(), 'tests', 'fixtures', 'waiting-state.json'), 'utf8')) as WorkbenchState & { _说明?: string }
const { waiting: EXPECTED, _说明: _note, ...RAW } = FIXTURE
const PILE = EXPECTED as WaitingView
/** 服务端发出去的那一份:从原样的快照现算 `waiting`(同 http.ts composeState 最后那一行)。 */
const SERVED: WorkbenchState = { ...(RAW as WorkbenchState), waiting: waitingOnHim(RAW as WorkbenchState) }

const BASE = 'http://127.0.0.1:8791'
const quietFetch = (async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch

function inboxProps(state: WorkbenchState) {
  return {
    state, baseUrl: BASE, fetchImpl: quietFetch, onOpenConversation: vi.fn(), draft: '', onDraftChange: vi.fn(), visible: true,
    controls: { paused: false, testRinging: false, onPause: vi.fn(), onTestRing: vi.fn(), onCancelWatch: vi.fn(), onDismissBrief: vi.fn(), proposals: [] },
  }
}

describe('「等你」那一堆只有一个函数', () => {
  it('服务端算出来的与那一份里写的一字不差:问你的 → 要你批的 → 单子 → 提议 → 办完了等你确认的;额度提醒不在里面', () => {
    expect(waitingOnHim(RAW as WorkbenchState)).toEqual(PILE)
    expect(PILE.count).toBe(9)
    expect(PILE.items.map(item => item.kind)).toEqual(['question', 'approval', 'approval', 'plan', 'proposal', 'proposal', 'proposal', 'confirm', 'confirm'])
    expect(PILE.items.some(item => item.text.includes('额度'))).toBe(false)
  })

  it('两端读的那一份:服务端给了就用它,老服务没给就用同一个函数就地算', () => {
    expect(waitingOf(SERVED)).toBe(SERVED.waiting)
    expect(waitingOf(RAW as WorkbenchState)).toEqual(PILE)
  })

  it('单子正在落 / 落好了不算(他已经点过头);只有等他点头时才算', () => {
    const plan = (RAW as WorkbenchState).materialize!
    expect(waitingOnHim({ ...(RAW as WorkbenchState), materialize: { ...plan, status: 'applying' } }).count).toBe(8)
    expect(waitingOnHim({ ...(RAW as WorkbenchState), materialize: { ...plan, status: 'applied' } }).count).toBe(8)
  })

  it('章在「等我确认」、但没标四类拍板请求的,不进「等你」(2026-10-26,卡「事务官页接管队列」):那是事务官待核验队列,未知不自动放行', () => {
    const all = (RAW as WorkbenchState).tasks!.tasks
    const stripped = all.map(task => { const { owner_ask: _dropped, ...rest } = task; return rest })
    const view = waitingOnHim({ ...(RAW as WorkbenchState), tasks: { ...(RAW as WorkbenchState).tasks!, tasks: stripped } })
    // 两张 confirm 都撤掉标 → 只剩 7 件;confirm 一件不剩。
    expect(view.count).toBe(PILE.count - 2)
    expect(view.items.some(item => item.kind === 'confirm')).toBe(false)
    // 类别认不出(坏形状)同样不算,不自动放行。
    const bad = { kind: 'unknown', proposal: 'x', basis: 'y', at: '2026-09-25T06:30:00.000Z' } as unknown as NonNullable<TaskView['owner_ask']>
    const badKind = all.map(task => task.id === 't-c1' ? { ...task, owner_ask: bad } : task)
    const half = waitingOnHim({ ...(RAW as WorkbenchState), tasks: { ...(RAW as WorkbenchState).tasks!, tasks: badKind } })
    expect(half.count).toBe(PILE.count - 1)
    expect(half.items.some(item => item.key === 'confirm:t-c1')).toBe(false)
    expect(half.items.some(item => item.key === 'confirm:t-c2')).toBe(true)
  })
})

describe('同一份状态喂给电脑上各处,数字相等', () => {
  it('球下「等你 n」、汇报条、球下那一区摆出来的那几张:都是这一堆、这一个数', () => {
    const { container } = render(<ButlerInbox {...inboxProps(SERVED)} />)
    expect(screen.getByText(new RegExp(`等你 ${PILE.count}(?!\\d)`), { selector: '.ben-wb__orb-counts' })).toBeInTheDocument()
    expect(butlerReportLine(SERVED, 0)).toContain(`等你 ${PILE.count} 件`)
    // 量不出高度的环境里整张摆:摆出来的那几张就是这一堆(一件一张、顺序照它),「额度还差一步」另摆、不带这一堆的键。
    const shown = [...container.querySelectorAll('.ben-wb__asks [data-ask]')].map(one => one.getAttribute('data-ask'))
    expect(shown).toEqual(PILE.items.map(item => item.key))
    expect(screen.getAllByText(/Kimi 要你自己登一次|额度/).length).toBeGreaterThan(0)
  })

  it('「要你看的 N 件」那一层:N 就是这个数,里面一件一张;额度提醒排在「另外」后面', async () => {
    const { rerender } = render(<ButlerInbox {...inboxProps(SERVED)} />)
    rerender(<ButlerInbox {...inboxProps(SERVED)} focusAsk={{ key: PILE.items[0]!.key, at: 1 }} />)
    const sheet = await screen.findByRole('dialog', { name: '要你看的' })
    expect(within(sheet).getByText(`要你看的 ${PILE.count} 件`)).toBeInTheDocument()
    const inSheet = [...sheet.querySelectorAll('[data-ask]')].map(one => one.getAttribute('data-ask'))
    expect(inSheet).toEqual(PILE.items.map(item => item.key))
    expect(within(sheet).getByText('另外')).toBeInTheDocument()
  })

  it('办完了等你确认的那几张:「确认收下」走看板那条改状态路由,「看看」在工作台里摊开那一件', async () => {
    const calls: { url: string, body: unknown }[] = []
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) })
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    render(<ButlerInbox {...inboxProps(SERVED)} fetchImpl={fetchImpl} />)
    screen.getByRole('button', { name: '确认收下「黄历接上了」' }).click()
    await waitFor(() => expect(calls.filter(call => call.url.endsWith('/task/move')).map(call => call.body)).toEqual([{ id: 't-c1', status: 'done' }]))
    const card = screen.getByRole('group', { name: '「Kimi 的回答」办完了,等你确认' })
    within(card).getByRole('button', { name: '看看' }).click()
    const sheet = await screen.findByRole('dialog', { name: '当前聚焦事项' })
    expect(within(sheet).getByRole('heading', { name: 'Kimi 的回答' })).toBeInTheDocument()
  })

  it('悬浮球角标上的数、事务官那一页上的「等你 n」:同一个数', async () => {
    const instance = createWorkbenchStore().create()
    const workspaceState = { items: [], phase: 'ready', archivedSessionIds: [], state: 'idle', error: null, baselinesReady: true, recentWorkspaceId: undefined }
    // 叠里有一扇窗、没人在台前 = 事务官那一档露着,标签栏也在。
    const state: WorkbenchState = { ...SERVED, dock: { stack: [{ key: 'claude', label: 'Claude', running: true, current: false }] } }
    const props: WorkbenchOverlayProps = {
      useStore: selector => selector(instance.getSnapshot()),
      actions: instance.actions,
      useWorkspaces: selector => selector(workspaceState as never),
      useSessions: selector => selector({} as never),
      ...UNUSED_STANDARD_PROPS,
      openWorkspace: async () => {},
      openSession: () => {},
      serviceFetch: vi.fn(async (_url: string, init?: RequestInit) => ({ ok: true, json: async () => (init?.method === 'POST' ? { ok: true } : state) })) as unknown as typeof fetch,
      servicePollMs: 0,
      serviceWebSocket: (): MinimalWebSocket => ({ onmessage: null, onclose: null, close: () => {} }),
    }
    render(<WorkbenchOverlay {...props} />)
    // 浮窗展开时那一页里的「等你 n」;收成球之后,同一个数挂在球的角标上(2026-10-27 起「事务官」标签去掉了)。
    expect(await screen.findByText(new RegExp(`等你 ${PILE.count}(?!\\d)`), { selector: '.ben-wb__orb-counts' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '收起为球' }))
    const badge = await screen.findByRole('button', { name: `等你 ${PILE.count} 件,点一下摊开` })
    expect(badge).toHaveTextContent(String(PILE.count))
  })
})
