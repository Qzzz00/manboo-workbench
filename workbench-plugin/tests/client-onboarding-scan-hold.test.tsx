/**
 * 首次流程对话屏:「她在找你的项目」那一整段,球一直是执行中(2026-09-24 傍晚,卡 fix/scan-orb-working-whole-wait)。
 * 维护者拍板:粒子球就是 loading —— 从她开始找项目、读仓库那一刻,到她开口说结果为止,球一直是执行中;她一开口就回到说话的样子。
 * 钉住:
 *   - 服务端窗口开着(scanning:true)就执行中 + 灰字进度行(role=status);活儿做完在等她(held)照样是;
 *   - **她的下一句**(新的事务官回合)一出现就回去 —— 字幕换句,球做说话动作,不再有「事后补 0.6 秒」压在她说话上;
 *   - 老服务端(活儿做完就 scanning:false)照样撑到她开口;她那一轮收场了没说话也收;保险时限;收了的那一段不重开;
 *   - 执行中交核心原版的 working 形(莫比乌斯环,中心光团关)。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EMPTY_REPLY_WINDOW, nextReplyWindow, REPLY_WINDOW_MAX_MS, type ReplySignals, type ReplyWindow } from '../src/client/firstrun/scanHold.ts'
import { SCAN_LINE, SCAN_LIST_LINE, scanLineOf, scanProgressOf, stageViewOf, type ScanProgress } from '../src/client/firstrun/onboardingStage.ts'
import { FirstRunFlow } from '../src/client/firstrun/FirstRunFlow.tsx'
import type { WorkbenchState } from '../src/protocol.ts'

afterEach(() => { cleanup(); vi.useRealTimers() })

function reply(steps: readonly Partial<ReplySignals>[], from: ReplyWindow = EMPTY_REPLY_WINDOW): ReplyWindow {
  return steps.reduce<ReplyWindow>((win, step) => nextReplyWindow(win, { scan: undefined, her: '1', busy: true, now: 0, ...step }), from)
}

describe('等她开口的窗口(纯函数)', () => {
  const open: ScanProgress = { scanning: true, phase: 'list', id: 1 }
  it('服务端窗口开着就进;开窗之前她说的那句(「我看一下」)是记号,不算她的下一句', () => {
    expect(reply([{ scan: open, her: '1', now: 100 }])).toMatchObject({ open: true, id: 1, herMark: '1', shown: open })
  })
  it('★她的下一句一出现就收(同一拍里服务端也收了)', () => {
    const win = reply([{ scan: open, now: 0 }, { scan: { scanning: true, held: true, phase: 'read', current: 'x', id: 1 }, now: 2_000 }])
    expect(win.open).toBe(true)
    expect(reply([{ scan: { scanning: false, id: 1, lastRead: 'x' }, her: '3', now: 4_000 }], win).open).toBe(false)
  })
  it('老服务端(活儿做完就 scanning:false)、她还在想:照样开着,那一行留在读的那一句;她开口才收', () => {
    const win = reply([{ scan: open, now: 0 }, { scan: { scanning: false, lastRead: 'desktop-workbench' }, now: 2_000 }])
    expect(win.open).toBe(true)
    expect(scanLineOf(win.shown)).toBe('正在读 desktop-workbench 的说明…')
    expect(reply([{ scan: { scanning: false }, her: '2', now: 3_000 }], win).open).toBe(false)
  })
  it('服务端收了、她那一轮也收场了(一句没说):收', () => {
    expect(reply([{ scan: open, now: 0 }, { scan: { scanning: false, id: 1 }, busy: false, now: 1_000 }]).open).toBe(false)
  })
  it('保险:服务端好久没说「还开着」就收', () => {
    const win = reply([{ scan: open, now: 0 }])
    expect(reply([{ now: REPLY_WINDOW_MAX_MS - 1 }], win).open).toBe(true)
    expect(reply([{ now: REPLY_WINDOW_MAX_MS }], win).open).toBe(false)
  })
  it('收了的那一段服务端还报着也不重开;新的一段照开', () => {
    const closed = reply([{ scan: open, now: 0 }, { scan: open, her: '2', now: 1_000 }])
    expect(closed).toMatchObject({ open: false, closedId: 1 })
    expect(reply([{ scan: open, her: '2', now: 1_500 }], closed).open).toBe(false)
    expect(reply([{ scan: { scanning: true, id: 2 }, her: '2', now: 2_000 }], closed)).toMatchObject({ open: true, id: 2 })
  })
})

describe('进度文案', () => {
  it('list 阶段一句「正在看有哪些文件夹…」,repos 阶段带数与名字', () => {
    expect(scanLineOf({ scanning: true, phase: 'list', done: 0 })).toBe(SCAN_LIST_LINE)
    expect(scanLineOf({ scanning: true, phase: 'repos', done: 12, total: 40, current: '/Users/x/Documents/GitHub/foo' })).toBe(`${SCAN_LINE} 已看 12/40 · …/GitHub/foo`)
    expect(stageViewOf({ speaking: false, busy: true, pending: false, waiting: true, drafting: false, scan: { scanning: true, phase: 'list' } }))
      .toMatchObject({ cue: 'working', mode: 'working', status: SCAN_LIST_LINE })
  })
  it('finished_at 读成毫秒;窗口号 id 与 held 读出来', () => {
    expect(scanProgressOf({ scan: { scanning: false, done: 0, finished_at: '2026-09-24T10:00:00.000Z' } }))
      .toEqual({ scanning: false, done: 0, finishedAt: Date.parse('2026-09-24T10:00:00.000Z') })
    expect(scanProgressOf({ scan: { scanning: true, held: true, id: 3 } })).toEqual({ scanning: true, held: true, id: 3 })
  })
})

describe('对话屏', () => {
  function snapshot(): WorkbenchState {
    return { agents: [], sessions: [], quota: {}, now: '2026-09-24T10:00:00+08:00', stale: false }
  }
  /** 一台可以从外面改回包的假服务端。 */
  function server(initial: Record<string, unknown>) {
    let body: Record<string, unknown> = initial
    const fetchImpl = vi.fn(async (url: string) => {
      const path = String(url).replace(/^https?:\/\/[^/]+/, '').split('?')[0] ?? ''
      const after = Number(new URLSearchParams(String(url).split('?')[1] ?? '').get('after') ?? '0')
      const ok = (payload: unknown) => ({ ok: true, status: 200, json: async () => payload }) as unknown as Response
      if (path === '/onboarding/turns') {
        const turns = (body.turns as { seq: number }[] | undefined) ?? [{ seq: 1, role: 'assistant', text: '我找一下' }]
        return ok({ busy: true, ended: false, stage: 'projects', done: false, ...body, turns: turns.filter(turn => turn.seq > after) })
      }
      if (path === '/first-run') return ok({})
      return ok({ stage: 'projects', done: false })
    }) as unknown as typeof fetch
    return { fetchImpl, set: (next: Record<string, unknown>) => { body = next } }
  }

  it('服务端窗口开着:球进执行中(核心 working 形),球下一行灰字进度', async () => {
    const fx = server({ scan: { scanning: true, phase: 'repos', done: 12, total: 40, current: '/Users/x/Documents/GitHub/foo', id: 1 } })
    render(<FirstRunFlow baseUrl="http://x" fetchImpl={fx.fetchImpl} state={snapshot()} onDone={() => {}} turnsPollMs={0} initialStep="chat" />)
    const line = await screen.findByText(`${SCAN_LINE} 已看 12/40 · …/GitHub/foo`)
    expect(line.closest('[role="status"]')).not.toBeNull()
    const root = screen.getByRole('dialog', { name: '第一次用' })
    expect(root).toHaveAttribute('data-cue', 'working')
    expect(root.querySelector('.ben-wb__onb-orb')).toHaveAttribute('data-mode', 'working')
    expect(root.querySelector('.ben-wb__onb-orb')).toHaveAttribute('data-scene', 'onboarding')
    expect(root.textContent).not.toContain('她')
  })

  it('★活儿做完在等她(held):照样执行中;她的下一句一出来,同一拍就回去(字幕换句 → 说话)', async () => {
    const fx = server({ turns: [{ seq: 1, role: 'assistant', text: '我看一下。' }], scan: { scanning: true, held: true, phase: 'read', current: 'desktop-workbench', id: 1 } })
    render(<FirstRunFlow baseUrl="http://x" fetchImpl={fx.fetchImpl} state={snapshot()} onDone={() => {}} turnsPollMs={30} initialStep="chat" />)
    expect(await screen.findByText('正在读 desktop-workbench 的说明…')).toBeInTheDocument()
    const root = screen.getByRole('dialog', { name: '第一次用' })
    expect(root).toHaveAttribute('data-cue', 'working')
    fx.set({ turns: [{ seq: 1, role: 'assistant', text: '我看一下。' }, { seq: 2, role: 'assistant', text: '找到了,是 desktop-workbench。' }], busy: false, scan: { scanning: false, done: 0, id: 1, last_read: 'desktop-workbench' } })
    await waitFor(() => expect(root).toHaveAttribute('data-cue', 'speaking'))
    expect(screen.queryByText('正在读 desktop-workbench 的说明…')).toBeNull()
    expect(screen.getByText('找到了,是 desktop-workbench。')).toBeInTheDocument()
  })

  it('一次都没见到在找、她已经说完结果:不事后补显示(那会压在她说话上)', async () => {
    const fx = server({ turns: [{ seq: 1, role: 'assistant', text: '找到了。' }], busy: false, scan: { scanning: false, done: 0, id: 1, finished_at: new Date(Date.now() - 500).toISOString() } })
    render(<FirstRunFlow baseUrl="http://x" fetchImpl={fx.fetchImpl} state={snapshot()} onDone={() => {}} turnsPollMs={0} initialStep="chat" />)
    expect(await screen.findByText('找到了。')).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: '第一次用' })).not.toHaveAttribute('data-cue', 'working')
    expect(screen.queryByText(SCAN_LINE)).toBeNull()
  })
})
