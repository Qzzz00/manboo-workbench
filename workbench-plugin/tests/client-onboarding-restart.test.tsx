/**
 * 引导开口前那一下重启,在界面上怎么过(2026-09-24,维护者真机两件事)。
 *
 * ① 原来「事务官正在重启,好把刚接上的模型服务认下来 —— 十几秒后自己回来,页面不用动。」用红字写在正中间,像报错。
 *    现在:一行灰字「稍等,正在准备…」+ 球的等待态;新进程回话了自己接着开会话、这一行消失;真一直没回来才红字。
 * ② 重启完说了一句,「在想…」停很久,他以为卡死:等过 8 秒补一句人话,过 30 秒给「再发一次」。
 */
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FirstRunFlow } from '../src/client/firstrun/FirstRunFlow.tsx'
import {
  OnboardingRestartingError, RESTART_POLL_MS, startOnboardingSessionThroughRestart,
} from '../src/client/firstrun/firstRunApi.ts'
import {
  RESEND_AFTER_MS, SLOW_AFTER_MS, stageViewOf, THINKING_SLOW, THINKING_SLOW_COLD, type StageSignals,
} from '../src/client/firstrun/onboardingStage.ts'
import { ONBOARDING_RESTART_TIMEOUT_TEXT, ONBOARDING_RESTARTING_NOTE, type WorkbenchState } from '../src/protocol.ts'

afterEach(() => { cleanup(); vi.useRealTimers() })

const json = (status: number, payload: unknown): Response =>
  ({ ok: status < 400, status, json: async () => payload }) as unknown as Response
const restarting = (): Response => json(503, { error: ONBOARDING_RESTARTING_NOTE, restarting: true })
const opened = (): Response => json(200, { stage: 'opening', session_id: 's1', first_message: 'x', seed: '开场', resumed: false })

/** 按顺序回这几样;回完了一直回最后一样。函数 = 抛错(模拟连不上)。 */
function script(...replies: (Response | (() => never))[]): typeof fetch {
  let k = 0
  return (async () => {
    const next = replies[Math.min(k++, replies.length - 1)]!
    if (typeof next === 'function') next()
    return next as Response
  }) as unknown as typeof fetch
}
const down = (): never => { throw new TypeError('Failed to fetch') }

describe('startOnboardingSessionThroughRestart(跨过那一下重启)', () => {
  it('「正在重启」→ 通知界面一次 → 重启途中连不上也照等 → 新进程回话了就把会话交回去', async () => {
    const onRestarting = vi.fn()
    const slept: number[] = []
    const result = await startOnboardingSessionThroughRestart('http://x', script(restarting(), restarting(), down, down, opened()), {
      onRestarting, sleep: async ms => { slept.push(ms) },
    })
    expect(result.session_id).toBe('s1')
    expect(onRestarting).toHaveBeenCalledTimes(1)
    expect(slept).toEqual([RESTART_POLL_MS, RESTART_POLL_MS, RESTART_POLL_MS, RESTART_POLL_MS])
  })

  it('没遇到过重启就连不上:照旧报错(失败不静默)', async () => {
    await expect(startOnboardingSessionThroughRestart('http://x', script(down), { sleep: async () => {} })).rejects.toThrow('Failed to fetch')
  })

  it('重启之后新进程给了真答复(4xx):照旧报,不当成「还没回来」', async () => {
    await expect(startOnboardingSessionThroughRestart('http://x', script(restarting(), json(409, { error: '引导已经完成' })), { sleep: async () => {} }))
      .rejects.toThrow('引导已经完成')
  })

  it('等太久(真失败)才报红字那句', async () => {
    let clock = 0
    await expect(startOnboardingSessionThroughRestart('http://x', script(restarting()), {
      sleep: async (ms) => { clock += ms }, now: () => clock, waitMs: 10_000,
    })).rejects.toThrow(ONBOARDING_RESTART_TIMEOUT_TEXT)
  })

  it('503 + restarting 认成「正在重启」,不是普通错误', async () => {
    await expect(startOnboardingSessionThroughRestart('http://x', script(restarting()), { sleep: async () => { throw new Error('stop') } }))
      .rejects.toThrow('stop')
    expect(new OnboardingRestartingError().message).toBe(ONBOARDING_RESTARTING_NOTE)
  })
})

describe('首次流程页上的样子', () => {
  function snapshot(): WorkbenchState {
    return { agents: [], sessions: [], quota: {}, now: '2026-09-24T10:00:00+08:00', stale: false }
  }
  /** 开会话第一次回「正在重启」、之后开成;交答案按真阶段机往前走。order 记下交答案与开会话的先后。 */
  function flowServer(start: string) {
    let stage = start
    let sessionCalls = 0
    const order: string[] = []
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const path = String(url).replace(/^https?:\/\/[^/]+/, '').split('?')[0]
      if (path === '/onboarding/session') { order.push('session'); return ++sessionCalls === 1 ? restarting() : opened() }
      if (path === '/onboarding') return json(200, { stage, done: false, ...(stage === 'opening' ? {} : { nickname: 'Ben' }) })
      if (path === '/onboarding/answer') {
        const key = (JSON.parse(String(init?.body)) as { key: string }).key
        order.push(key)
        stage = key === 'nickname' ? 'branch' : 'template'
        return json(200, { ok: true, stage, advanced: true, done: false })
      }
      if (path === '/setup/apk.json') return json(200, { available: false, path: '/x' })
      return json(200, {})
    }) as unknown as typeof fetch
    return { fetchImpl, order }
  }

  it('重启那几秒:灰字一行、没有红字(role=alert);新进程回话了自己往下走,那一行消失', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    // 2026-09-24 起称呼答完才开会话:重启那一下发生在称呼那一屏点「就这么叫」之后,灰字挂在称呼那一屏。
    const server = flowServer('opening')
    render(<FirstRunFlow baseUrl="http://x" fetchImpl={server.fetchImpl} state={snapshot()} onDone={() => {}} turnsPollMs={0} initialStep="intro" />)
    await act(async () => { screen.getByRole('button', { name: '已经有在做的事' }).click() })
    fireEvent.change(await screen.findByLabelText('称呼'), { target: { value: 'Ben' } })
    expect(server.order).toEqual([])
    await act(async () => { screen.getByRole('button', { name: '就这么叫' }).click() })
    const line = await screen.findByText(ONBOARDING_RESTARTING_NOTE)
    expect(line).toHaveAttribute('role', 'status')
    expect(line.className).not.toContain('firstrun-err')
    expect(screen.queryByRole('alert')).toBeNull()
    await act(async () => { await vi.advanceTimersByTimeAsync(RESTART_POLL_MS + 50) })
    // 重启完:自己开了会话、进对话屏;灰字那一行没了。称呼与分岔在开会话之前就记上了(阶段机落盘,重启不丢)。
    expect(await screen.findByLabelText('说一句')).toBeInTheDocument()
    expect(screen.queryByText(ONBOARDING_RESTARTING_NOTE)).toBeNull()
    expect(server.order).toEqual(['nickname', 'mode', 'session', 'session'])
  })

  it('称呼早就答过的那条路:重启那一下在出场屏上,灰字挂在两颗按钮下面;分岔先记、再开会话', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const server = flowServer('branch')
    render(<FirstRunFlow baseUrl="http://x" fetchImpl={server.fetchImpl} state={snapshot()} onDone={() => {}} turnsPollMs={0} initialStep="intro" />)
    await act(async () => { screen.getByRole('button', { name: '从一个新点子开始' }).click() })
    expect(await screen.findByText(ONBOARDING_RESTARTING_NOTE)).toHaveAttribute('role', 'status')
    await act(async () => { await vi.advanceTimersByTimeAsync(RESTART_POLL_MS + 50) })
    expect(await screen.findByLabelText('说一句')).toBeInTheDocument()
    expect(server.order).toEqual(['mode', 'session', 'session'])
  })
})

describe('等她回话太久:对话屏上', () => {
  it('过 30 秒:「在想…」下面补人话、给一颗「再发一次」,点了把刚才那句原样再说一遍', async () => {
    const said: unknown[] = []
    const at = '2026-09-24T01:00:00.000Z'
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const path = String(url).replace(/^https?:\/\/[^/]+/, '').split('?')[0]
      if (path === '/onboarding/turns') return json(200, { turns: [{ seq: 1, role: 'user', text: '我在做一个小程序', at }], busy: true, ended: false, stage: 'branch', done: false })
      if (path === '/onboarding/say') { said.push(JSON.parse(String(init?.body))); return json(200, { ok: true, session_id: 's1' }) }
      if (path === '/setup/apk.json') return json(200, { available: false, path: '/x' })
      return json(200, {})
    }) as unknown as typeof fetch
    const state: WorkbenchState = { agents: [], sessions: [], quota: {}, now: at, stale: false }
    render(<FirstRunFlow baseUrl="http://x" fetchImpl={fetchImpl} state={state} onDone={() => {}} turnsPollMs={0} initialStep="chat" now={() => Date.parse(at) + RESEND_AFTER_MS + 1000} />)
    expect(await screen.findByText(THINKING_SLOW_COLD)).toBeInTheDocument()
    await act(async () => { screen.getByRole('button', { name: '再发一次' }).click() })
    expect(said).toEqual([{ text: '我在做一个小程序' }])
  })
})

describe('等她回话太久(stageViewOf)', () => {
  const waiting = (waitedMs: number, over: Partial<StageSignals> = {}): StageSignals =>
    ({ speaking: false, busy: true, pending: false, waiting: true, drafting: false, waitedMs, ...over })
  it('8 秒内:照旧「在想…」,没有按钮', () => {
    const view = stageViewOf(waiting(SLOW_AFTER_MS - 1))
    expect(view.status).toBe('在想…')
    expect(view.resend).toBeUndefined()
  })
  it('过 8 秒补一句人话;刚重启 / 她还一句没回过时说「刚启动,第一句会慢一点」', () => {
    expect(stageViewOf(waiting(SLOW_AFTER_MS, { coldStart: true })).status).toBe(THINKING_SLOW_COLD)
    expect(stageViewOf(waiting(SLOW_AFTER_MS, { coldStart: false })).status).toBe(THINKING_SLOW)
    expect(THINKING_SLOW_COLD).toContain('刚启动,第一句会慢一点')
  })
  it('过 30 秒给「再发一次」;本地正在发(pending)时不给', () => {
    expect(stageViewOf(waiting(RESEND_AFTER_MS)).resend).toBe(true)
    expect(stageViewOf(waiting(RESEND_AFTER_MS, { pending: true })).resend).toBeUndefined()
  })
  it('没在等她(她已经回了):不补话、不给按钮', () => {
    const view = stageViewOf({ speaking: false, busy: false, pending: false, waiting: false, drafting: false, waitedMs: RESEND_AFTER_MS * 2 })
    expect(view.status).toBeUndefined()
    expect(view.resend).toBeUndefined()
  })
})
