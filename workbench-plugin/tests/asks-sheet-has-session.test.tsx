/**
 * **抽屉里要有会话那一条**(2026-09-28,卡 WQ;维护者 16:1x:「这个会话的东西没有进入到待确认的抽屉,
 * 这可是核心功能啊。」)。
 *
 * 根因:卡 DD 的「同一问只摆一处」把 `kind:'session'` 从那张表里整条撤掉,而**球下那一区与「要你看的」
 * 那一层读的是同一张表** —— 于是抽屉里一条都没有。现在分开:
 *   - 球下常驻那一区照旧按卡 DD 去重(屏幕上同一问只出现一处);
 *   - 「要你看的」那一层是他自己点开来看全部的,**一件不少**(与手机「等你确认」点开一致)。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ButlerInbox } from '../src/client/ButlerInbox.tsx'
import { waitingOf } from '../src/waiting.ts'
import type { PendingQuestionView, SessionView, WorkbenchState } from '../src/protocol.ts'

afterEach(() => { cleanup(); globalThis.localStorage?.clear() })

const NOW = '2026-09-28T08:20:00.000Z'
const BASE = 'http://127.0.0.1:8791'
const NAMES: Record<string, string> = { dsh: '事务官', claude: 'Claude', codex: 'Codex' }

/** 现场那一条:Codex 弹了个框问菜系(`by:'form'`,送不回去但选项点得下去)。 */
function askingCodex(): SessionView {
  return {
    agent: 'codex', session_id: 'c-777', project: '', status: 'waiting', elapsed_sec: 121, unread: true,
    updated_at: '2026-09-28T08:11:52.000Z', title: '做个测试,随便发个选项问题给我',
    ask: {
      kind: 'choose', question: '你最喜欢哪种菜系?', since: '2026-09-28T08:11:46.574Z',
      by: 'form', reply: 'desk', where: '这一问得在电脑上的 Codex 里回答(它那边弹了个框等你点)', reveal: true,
      press: true,
      options: [{ label: '川菜' }, { label: '粤菜' }, { label: '湘菜' }, { label: '江浙菜' }],
    },
  }
}

/** 事务官自己问的一问(球下那一区里摆得出来的一件,「展开」那颗键靠它出现)。 */
function question(): PendingQuestionView {
  return {
    id: 'q-1', session_id: 'dsh-1', at: '2026-09-28T08:12:00.000Z', task_id: 't-1', task_title: '国庆放假查一下',
    questions: [{ id: 'q-1a', question: '查到的那几天要不要记进日历', multi: false, options: [{ label: '要', text: '要' }, { label: '不用', text: '不用' }] }],
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

const quietFetch = (async (url: string) => new Response(
  JSON.stringify(String(url).includes('/sessions/digest') ? { agent: 'codex', session_id: 'c-777', rounds: [] } : { ok: true }),
  { status: 200, headers: { 'content-type': 'application/json' } },
)) as unknown as typeof fetch

function inboxProps(one: WorkbenchState) {
  return {
    state: one, baseUrl: BASE, fetchImpl: quietFetch, onOpenConversation: vi.fn(), draft: '', onDraftChange: vi.fn(), visible: true,
    controls: { paused: false, testRinging: false, onPause: vi.fn(), onTestRing: vi.fn(), onCancelWatch: vi.fn(), onDismissBrief: vi.fn(), proposals: [] },
  }
}

const sheetKeys = (container: HTMLElement): string[] =>
  [...container.querySelectorAll('.ben-wb__asks-sheet [data-ask]')].map(one => one.getAttribute('data-ask') ?? '')

describe('「要你看的」那一层里有会话那一条(卡 WQ)', () => {
  it('★球下那一区照旧只摆没上台的那件(卡 DD),抽屉摊开时两件都在 —— 会话那一条不再失踪', async () => {
    const one = state([askingCodex()], { questions: [question()] })
    const pile = waitingOf(one)
    expect(pile.items.map(item => item.key)).toEqual(['question:q-1', 'session:codex/c-777'])

    const { container, rerender } = render(<ButlerInbox {...inboxProps(one)} />)
    // 球下那一区:台上有卡的那条会话不摆(卡 DD 一个字没改)。
    const below = [...container.querySelectorAll('.ben-wb__asks > [data-ask], .ben-wb__asks [data-ask]')]
      .map(node => node.getAttribute('data-ask') ?? '')
    expect(below).toContain('question:q-1')
    expect(below).not.toContain('session:codex/c-777')

    // 摊开那一层(球下那一行的「展开」、事务官标签上的气泡、系统通知点进来都走这一条)→ 两件都在。
    rerender(<ButlerInbox {...inboxProps(one)} focusAsk={{ key: 'question:q-1', at: 1 }} />)
    expect(sheetKeys(container)).toEqual(['question:q-1', 'session:codex/c-777'])
    // 数说的是整份「等你」(与球下「等你 n」同一个数)。
    expect(screen.getByText('要你看的 2 件')).toBeInTheDocument()
  })

  it('★抽屉里那张会话卡上,它给的选项是**能点的键**(press:true)—— 点一下就替他答进去', async () => {
    const one = state([askingCodex()], { questions: [question()] })
    const { container } = render(<ButlerInbox {...inboxProps(one)} focusAsk={{ key: 'question:q-1', at: 1 }} />)
    const card = container.querySelector('.ben-wb__asks-sheet [data-ask="session:codex/c-777"]')
    expect(card).not.toBeNull()
    const buttons = [...card!.querySelectorAll('button.ben-wb__qask-option')].map(node => node.textContent ?? '')
    expect(buttons).toEqual(['川菜', '粤菜', '湘菜', '江浙菜'])
    // 剩下那半件如实说:要自己说一句才得去那家里说。
    expect(card!.textContent).toContain('上面那几项我能替你点')
  })
})
