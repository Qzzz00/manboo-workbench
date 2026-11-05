/**
 * 同一件「等你」只摆一处(2026-09-27,卡 DD;维护者截图拍板:**留球旁的卡**)。
 *
 * 现场:Muse「Main chat」、Claude「工作台记忆与编排优化方案评估」两张球旁的卡写着「等你动手 / 等你看:…」,
 * 球下「等你回答」那一区又各摆一行「Claude 在等你看:… 展开」—— 同一件事两处。
 *
 * 这一份钉住:
 *   ① 台上已经有卡、卡上写着那一问 → 球下那一区**整张 / 一行 /「展开」都不摆**;
 *   ② 台上摆不下(超过 `STAGE_SESSION_CARDS_MAX`)那一条 → 球下照旧摆;
 *   ③ 点台上那张卡 → 摊开的详情里有 `SessionAsk` 全部的答法(它明写的选项、我自己说、不用管这条 / 去回答);
 *   ④ 「等你 n」那些数不变(照旧 `pile.count`);只剩台上卡时球下不留空壳、不说「还有 N 件要你看」;
 *   ⑤ 走光跟着挪:「要他处理的第一件」是一张已在台上的会话卡时,光走在那张卡上,球下不走(强效果全屏仍只一个)。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ButlerInbox } from '../src/client/ButlerInbox.tsx'
import { STAGE_SESSION_CARDS_MAX, buildButlerScene, stageAskKeys } from '../src/client/butlerSceneModel.ts'
import { waitingOf } from '../src/waiting.ts'
import type { PendingQuestionView, SessionView, TaskView, WorkbenchState } from '../src/protocol.ts'

afterEach(() => { cleanup(); globalThis.localStorage?.clear() })

const NOW = '2026-09-27T07:20:00.000Z'
const BASE = 'http://127.0.0.1:8791'
const NAMES: Record<string, string> = { dsh: '事务官', claude: 'Claude', codex: 'Codex' }

/** 一条停着在等他的会话(卡上写「等你看:…」)。 */
function asking(patch: Partial<SessionView> = {}): SessionView {
  return {
    agent: 'claude', session_id: 's1', project: '', status: 'waiting', elapsed_sec: 120, unread: false,
    updated_at: '2026-09-27T07:18:00.000Z', title: '工作台记忆与编排优化方案评估',
    ask: {
      kind: 'review', question: '这一版的记忆合并口径你看行不行', since: '2026-09-27T07:18:00.000Z',
      by: 'model', reply: 'window', quote: '你看这样合并行不行',
      options: [{ label: '就这样办' }, { label: '再改一版' }],
    },
    ...patch,
  }
}

function state(sessions: SessionView[], patch: Partial<WorkbenchState> = {}): WorkbenchState {
  const ids = [...new Set(sessions.map(one => one.agent))]
  return {
    agents: [], sessions, quota: {}, stale: false, now: NOW,
    tasks: { tasks: [], sprints: [], modules: [], project_meta: [] },
    butler_inbox: { items: [] },
    agent_registry: {
      entries: ids.map(id => ({
        id, name: NAMES[id] ?? id, found: { how: 'sessions' as const, at: '', basis: '' }, sources: [],
        status: 'waiting' as const, gaps: {},
        sessions: sessions.filter(one => one.agent === id).map(one => ({ ...one, via: 'sessions' as const })),
        counts: { running: 0, waiting: 0, unread: 0 },
      })),
      asking: [], notices: [],
    },
    ...patch,
  }
}

/** 什么都不做的取数:`/sessions/digest` 那一路要 `rounds`,给一份空的(「最近几轮」读不出东西)。 */
const quietFetch = (async (url: string) => new Response(
  JSON.stringify(String(url).includes('/sessions/digest') ? { agent: 'claude', session_id: 's1', rounds: [] } : { ok: true }),
  { status: 200, headers: { 'content-type': 'application/json' } },
)) as unknown as typeof fetch

function inboxProps(one: WorkbenchState) {
  return {
    state: one, baseUrl: BASE, fetchImpl: quietFetch, onOpenConversation: vi.fn(), draft: '', onDraftChange: vi.fn(), visible: true,
    controls: { paused: false, testRinging: false, onPause: vi.fn(), onTestRing: vi.fn(), onCancelWatch: vi.fn(), onDismissBrief: vi.fn(), proposals: [] },
  }
}

const asksKeys = (container: HTMLElement): string[] =>
  [...container.querySelectorAll('.ben-wb__asks [data-ask]')].map(one => one.getAttribute('data-ask') ?? '')

describe('台上那张卡已经摆了这一问 → 球下不再摆', () => {
  it('★卡上写着那一问 → 球下那一区一条都不摆;「等你 n」的数不变', () => {
    const one = state([asking()])
    const pile = waitingOf(one)
    expect(pile.count).toBe(1)
    expect(pile.items[0]!.key).toBe('session:claude/s1')

    const { container } = render(<ButlerInbox {...inboxProps(one)} />)
    // 台上那张卡摆着那一问。
    const card = container.querySelector('[data-task-card="session:claude/s1"]')
    expect(card).not.toBeNull()
    expect(card!.textContent).toContain('等你看:这一版的记忆合并口径你看行不行')
    // 球下那一区:整张、一行、「展开」都没有它。
    expect(asksKeys(container)).toEqual([])
    // 数照旧。
    expect(screen.getByText(/等你 1(?!\d)/, { selector: '.ben-wb__orb-counts' })).toBeInTheDocument()
  })

  it('★只剩台上卡时球下不留空壳:那一区里没有「还有 N 件要你看」这类指向球下的话', () => {
    const { container } = render(<ButlerInbox {...inboxProps(state([asking()]))} />)
    const below = container.querySelector('.ben-wb__asks')
    expect(below?.textContent ?? '').not.toContain('还有')
    expect(below?.textContent ?? '').not.toContain('要你看')
    expect(container.querySelector('[data-asks-mode]')).toBeNull()
  })

  it('★台上摆不下的那一条(超过上限被截掉)照旧在球下摆', () => {
    // 上限 + 1 条都在等他:排序按「在跑 → 等你 → …」再按 updated_at 倒序,所以最旧的那条被截掉。
    const many = Array.from({ length: STAGE_SESSION_CARDS_MAX + 1 }, (_, i) => asking({
      session_id: `s${i}`,
      // i 越大越旧;第 STAGE_SESSION_CARDS_MAX 条最旧,被截掉。
      updated_at: new Date(Date.parse('2026-09-27T07:18:00.000Z') - i * 60_000).toISOString(),
      title: `第 ${i} 条`,
    }))
    const one = state(many)
    const scene = buildButlerScene(one)
    const onStage = stageAskKeys(scene.stage)
    expect(onStage.size).toBe(STAGE_SESSION_CARDS_MAX)
    const cut = `session:claude/s${STAGE_SESSION_CARDS_MAX}`
    expect(onStage.has(cut)).toBe(false)

    const { container } = render(<ButlerInbox {...inboxProps(one)} />)
    expect(asksKeys(container)).toEqual([cut])
    expect(waitingOf(one).count).toBe(STAGE_SESSION_CARDS_MAX + 1)
  })

  it('★台上那张是事项卡(卡面没写那一问)时不算摆过:球下照旧摆', () => {
    // 事项在办、挂着的会话在跑(卡 T:按内容判出来的一问只挂 `ask`、不改运行状态),所以台上那张是**事项卡**:
    // 卡面写「进行中 · n 分钟」,那一问一个字都没写 —— 它还没在屏幕上出现过,球下照旧摆。
    const task: TaskView = {
      id: 't1', title: '记忆合并', status: 'doing', direction: 'mine', source: { kind: 'manual' }, created_at: NOW, updated_at: NOW,
      links: [{ agent: 'claude', session_id: 's1' }],
    }
    const one = state([asking({ status: 'running' })], { tasks: { tasks: [task], sprints: [], modules: [], project_meta: [] } })
    const scene = buildButlerScene(one)
    expect(scene.stage.map(item => item.id)).toEqual(['t1'])
    // 那条会话被事项卡代表了,台上没有一张写着这一问的会话卡。
    expect(stageAskKeys(scene.stage).has('session:claude/s1')).toBe(false)
    const { container } = render(<ButlerInbox {...inboxProps(one)} />)
    expect(asksKeys(container)).toEqual(['session:claude/s1'])
  })
})

describe('点台上那张有一问的卡 → 直接摊开怎么答', () => {
  it('★摊开的详情里有它明写的选项、我自己说、不用管这条', async () => {
    render(<ButlerInbox {...inboxProps(state([asking()]))} />)
    await userEvent.click(screen.getByRole('button', { name: '查看事项:工作台记忆与编排优化方案评估' }))
    const sheet = await screen.findByRole('dialog', { name: '当前聚焦事项' })
    const ask = within(sheet).getByRole('group', { name: 'Claude 在等你看' })
    expect(within(ask).getByRole('button', { name: '就这样办' })).toBeInTheDocument()
    expect(within(ask).getByRole('button', { name: '再改一版' })).toBeInTheDocument()
    expect(within(ask).getByLabelText('我自己说')).toBeInTheDocument()
    expect(within(ask).getByRole('button', { name: '不用管这条' })).toBeInTheDocument()
    expect(within(ask).getByRole('button', { name: '它的原话' })).toBeInTheDocument()
  })

  it('★送不回去的那一问:摊开的详情里写清去哪儿答,并给「去回答」', async () => {
    const one = state([asking({ ask: { ...asking().ask!, reply: 'desk', where: '这一问得在电脑上的 Claude 里回答', reveal: true } })])
    render(<ButlerInbox {...inboxProps(one)} />)
    await userEvent.click(screen.getByRole('button', { name: '查看事项:工作台记忆与编排优化方案评估' }))
    const sheet = await screen.findByRole('dialog', { name: '当前聚焦事项' })
    expect(within(sheet).getByText('这一问得在电脑上的 Claude 里回答')).toBeInTheDocument()
    expect(within(sheet).getByRole('button', { name: '去回答' })).toBeInTheDocument()
  })

  it('★没有一问的会话卡点击行为不变:摊开的详情里没有那一区', async () => {
    const { ask: _ask, ...plain } = asking()
    render(<ButlerInbox {...inboxProps(state([{ ...plain, status: 'running' }]))} />)
    await userEvent.click(screen.getByRole('button', { name: '查看事项:工作台记忆与编排优化方案评估' }))
    const sheet = await screen.findByRole('dialog', { name: '当前聚焦事项' })
    expect(within(sheet).queryByRole('group', { name: /在等你/ })).toBeNull()
  })
})

/**
 * 通知与标签气泡点进来那条路(2026-09-27,卡 DD 追加,统筹定):送的键就是「等你」那一堆里的键
 * (标签气泡送 `waitingOf(state).items[0].key`,系统通知 `focus_ask` 送同一套),所以它**真会**指到
 * 一件已经在台上的会话。球下那一层里已经没有它了,再去摊那一层就是点进来什么也找不到(D13)。
 * 改成聚焦台上那张卡 —— 等同于点那张卡:「当前聚焦事项」整张摊开,里面就是可答的 `SessionAsk`。
 */
describe('通知 / 标签气泡点进来:那一件在台上就聚焦台上那张卡', () => {
  it('★系统通知点进来(focus_ask 送「等你」那一堆里的键)→ 不摊球下那一层,摊开的是台上那张卡的详情', async () => {
    const one = state([asking()])
    const key = waitingOf(one).items[0]!.key
    const { rerender } = render(<ButlerInbox {...inboxProps(one)} />)
    rerender(<ButlerInbox {...inboxProps(one)} focusAsk={{ key, at: 1 }} />)
    // 球下那一层没开。
    expect(screen.queryByRole('dialog', { name: '要你看的' })).toBeNull()
    // 摊开的是台上那张卡,里面能答。
    const sheet = await screen.findByRole('dialog', { name: '当前聚焦事项' })
    expect(within(sheet).getByRole('heading', { name: '工作台记忆与编排优化方案评估' })).toBeInTheDocument()
    const ask = within(sheet).getByRole('group', { name: 'Claude 在等你看' })
    expect(within(ask).getByRole('button', { name: '就这样办' })).toBeInTheDocument()
    expect(within(ask).getByLabelText('我自己说')).toBeInTheDocument()
  })

  it('★标签气泡点进来(排最前那一件)→ 同上;那一件没上卡时照旧摊球下那一层', async () => {
    // 排最前的是事务官自己那一问(没上卡)→ 照旧摊球下那一层。
    const question: PendingQuestionView = {
      id: 'q1', session_id: 'dsh-1', at: NOW, task_title: '记忆合并',
      questions: [{ id: 'a', header: '派活前对一遍', question: '先合哪一份', multi: false, options: [] }],
    }
    const withQuestion = state([asking()], { questions: [question] })
    const first = waitingOf(withQuestion).items[0]!.key
    expect(first).toBe('question:q1')
    const { rerender, unmount } = render(<ButlerInbox {...inboxProps(withQuestion)} />)
    rerender(<ButlerInbox {...inboxProps(withQuestion)} focusAsk={{ key: first, at: 1 }} />)
    expect(await screen.findByRole('dialog', { name: '要你看的' })).toBeInTheDocument()
    unmount()

    // 只剩会话那一件时,气泡送的就是它 → 聚焦台上那张卡,球下那一层不开。
    const onlySession = state([asking()])
    const alone = waitingOf(onlySession).items[0]!.key
    expect(alone).toBe('session:claude/s1')
    const second = render(<ButlerInbox {...inboxProps(onlySession)} />)
    second.rerender(<ButlerInbox {...inboxProps(onlySession)} focusAsk={{ key: alone, at: 2 }} />)
    expect(screen.queryByRole('dialog', { name: '要你看的' })).toBeNull()
    expect(await screen.findByRole('dialog', { name: '当前聚焦事项' })).toBeInTheDocument()
  })
})

describe('走光跟着挪到台上那张卡(这一屏的强效果最多一个)', () => {
  const activeFx = (root: Element | null): Element[] =>
    root === null ? [] : [...root.querySelectorAll('[data-fx="ask"][data-fx-active="true"]')]

  it('★要他处理的第一件已在台上 → 光走在那张卡上,球下不走', () => {
    const { container } = render(<ButlerInbox {...inboxProps(state([asking()]))} />)
    expect(activeFx(container.querySelector('[data-task-card="session:claude/s1"]'))).toHaveLength(1)
    expect(activeFx(container.querySelector('.ben-wb__asks'))).toHaveLength(0)
  })

  it('★球下还有没上卡的等你、且它排在最前 → 光照旧在球下,台上那张不走', () => {
    const question: PendingQuestionView = {
      id: 'q1', session_id: 'dsh-1', at: NOW, task_title: '记忆合并',
      questions: [{ id: 'a', header: '派活前对一遍', question: '先合哪一份', multi: false, options: [] }],
    }
    const one = state([asking()], { questions: [question] })
    const pile = waitingOf(one)
    expect(pile.items[0]!.key).toBe('question:q1')
    const { container } = render(<ButlerInbox {...inboxProps(one)} />)
    // 球下摆的只剩那一问(会话那条在台上),光在它身上。
    expect(asksKeys(container)).toEqual(['question:q1'])
    expect(activeFx(container.querySelector('.ben-wb__asks'))).toHaveLength(1)
    expect(activeFx(container.querySelector('[data-task-card="session:claude/s1"]'))).toHaveLength(0)
  })

  it('★台上在跑的卡不单独走光(卡 P 补三的旧口径)—— 只有等你的那张走', () => {
    const { ask: _ask, ...plain } = asking()
    const one = state([{ ...plain, session_id: 'run1', status: 'running', title: '在跑的一条' }, asking()])
    const { container } = render(<ButlerInbox {...inboxProps(one)} />)
    expect(activeFx(container.querySelector('[data-task-card="session:claude/run1"]'))).toHaveLength(0)
    expect(activeFx(container.querySelector('[data-task-card="session:claude/s1"]'))).toHaveLength(1)
  })
})
