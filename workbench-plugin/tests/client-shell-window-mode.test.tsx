/**
 * 壳窗口「前台 / 桌面」两档的**判断**(2026-09-18,Ben:「登录和引导的时候,应该是和其他应用
 * 一样,能在顶部的,现在写死是底部」)。
 *
 * 这个文件钉的是 src/client/shellWindowMode.ts —— 整条链路上唯一有分支的地方:
 * 什么时候该 front、什么时候该 desktop、什么时候**什么都别发**。
 * 壳那半截(真的去设 NSWindow.level、activate)在 workbench-app/run-tests.sh 里;
 * 服务端那条路由在 tests/server-shell-window-mode.test.ts 里。
 *
 * 判定跟 Workbench 底部那两处整屏早退是同一份状态、同一套判断——所以这里的每一条
 * 都能一句话对上"此刻屏上是哪一屏"。
 */
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { decideWindowMode, postWindowMode } from '../src/client/shellWindowMode.ts'
import { WorkbenchOverlay, type MinimalWebSocket, type WorkbenchOverlayProps } from '../src/client/Workbench.tsx'
import { createWorkbenchStore } from '../src/client/store.ts'
import type { WorkbenchState } from '../src/protocol.ts'
import { UNUSED_STANDARD_PROPS } from './helpers/standardProps.ts'

afterEach(cleanup)

describe('decideWindowMode(什么时候该在最前面)', () => {
  it('还没问到 /account → 什么都不发(壳启动默认就是 front,不发即沿用)', () => {
    expect(decideWindowMode({ account: undefined, firstRunNeeded: undefined })).toBeUndefined()
    // 旗子先到、账号还没到也一样:此刻屏上是什么还说不准,不发就不会闪一下沉下去。
    expect(decideWindowMode({ account: undefined, firstRunNeeded: false })).toBeUndefined()
  })

  it('没登录 → front(整屏是登录/注册卡,那正是 Ben 说"看不见"的那一屏)', () => {
    expect(decideWindowMode({
      account: { enabled: true, view: { logged_in: false } },
      firstRunNeeded: undefined,
    })).toBe('front')
  })

  it('登录了但首次流程那面旗子还没问到 → 还是不发(同样是"还不知道")', () => {
    expect(decideWindowMode({
      account: { enabled: true, view: { logged_in: true } },
      firstRunNeeded: undefined,
    })).toBeUndefined()
  })

  it('登录了、首次流程没走完(引导整段在这一屏里)→ front', () => {
    expect(decideWindowMode({
      account: { enabled: true, view: { logged_in: true } },
      firstRunNeeded: true,
    })).toBe('front')
  })

  it('登录了、首次流程走完了(或点了「稍后/跳过」写了旗子)→ desktop,回到桌面级', () => {
    expect(decideWindowMode({
      account: { enabled: true, view: { logged_in: true } },
      firstRunNeeded: false,
    })).toBe('desktop')
  })

  it('这台服务没接账号(展示台 / 老用例 / 手机)→ desktop:没有登录屏也没有引导屏', () => {
    expect(decideWindowMode({ account: { enabled: false }, firstRunNeeded: undefined })).toBe('desktop')
  })

  /**
   * 一条完整的路:装完第一次打开 → 注册 → 三屏引导 → 进工作台。
   * 沿路只该翻两次档(front 一次、desktop 一次),中间那些"还不知道"不该发出任何东西——
   * Workbench 那边靠 sentWindowModeRef 做同档去重,这里钉的是判断本身不来回抖。
   */
  it('整条路:不知道 → 登录屏 → 引导 → 工作台,只有两次真正的换档', () => {
    const path = [
      { account: undefined, firstRunNeeded: undefined },
      { account: { enabled: true as const, view: { logged_in: false } }, firstRunNeeded: undefined },
      { account: { enabled: true as const, view: { logged_in: true } }, firstRunNeeded: undefined },
      { account: { enabled: true as const, view: { logged_in: true } }, firstRunNeeded: true },
      { account: { enabled: true as const, view: { logged_in: true } }, firstRunNeeded: false },
    ]
    expect(path.map(decideWindowMode)).toEqual([undefined, 'front', undefined, 'front', 'desktop'])
  })
})

describe('postWindowMode(只管把结论送出去)', () => {
  it('POST /shell/window-mode,body 带 mode 与 source:\'app\',带 cookie', async () => {
    const calls: { url: string, init: RequestInit }[] = []
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return { ok: true, json: async () => ({ ok: true, mode: 'front' }) } as unknown as Response
    }) as unknown as typeof fetch

    expect(await postWindowMode('http://127.0.0.1:8791', 'front', fakeFetch)).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('http://127.0.0.1:8791/shell/window-mode')
    expect(calls[0]?.init.method).toBe('POST')
    expect(calls[0]?.init.credentials).toBe('include')
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ mode: 'front', source: 'app' })
  })

  it('服务端老版没这条路(404)→ false,不抛:这条路没有人在等答复', async () => {
    const fakeFetch = (async () => ({ ok: false }) as Response) as unknown as typeof fetch
    expect(await postWindowMode('http://127.0.0.1:8791', 'desktop', fakeFetch)).toBe(false)
  })

  /**
   * 2026-09-25(卡 fix/slot-current-empty):壳没连上时服务端照样回 HTTP 200 + `{ok:false}`。原来只看 HTTP,
   * 页面把"壳根本没收到"记成"已经是桌面档",新壳一直停在前台档、压在认领的窗上面(窗口槽一整块空的深色区)。
   */
  it('★HTTP 200 但 body 是 {ok:false}(壳没连上)→ false:这一条没送到,要再送', async () => {
    const fakeFetch = (async () => ({ ok: true, json: async () => ({ ok: false, reason: '工作台 App 未运行' }) }) as unknown as Response) as unknown as typeof fetch
    expect(await postWindowMode('http://127.0.0.1:8791', 'desktop', fakeFetch)).toBe(false)
  })

  it('网络整个不通 → false,不抛(壳没开时最坏也只是层级停在上一档)', async () => {
    const fakeFetch = (async () => { throw new Error('connect ECONNREFUSED') }) as unknown as typeof fetch
    expect(await postWindowMode('http://127.0.0.1:8791', 'front', fakeFetch)).toBe(false)
  })
})

/**
 * 接线那一截:判断对了不算数,得真的**在壳里、状态变了、只发一次**。
 *
 * 这几条钉的正是最容易接错的三处——发的时机(挂载后状态问回来才发)、发的资格
 * (浏览器里开的工作台标签不该有权掀壳的窗口)、以及不重发(一条多余的 front 会把正在
 * 用别的应用的人打断)。
 */
function snapshot(over: Partial<WorkbenchState> = {}): WorkbenchState {
  return { agents: [], sessions: [], quota: {}, now: '2026-09-18T10:00:00+08:00', stale: false, ...over }
}

interface Call { path: string, method: string, body?: Record<string, unknown> }

/** 假服务端:/account 与 /first-run 按参数回话,其余按既有先例给最省事的合法回包。 */
function fakeServer(account: unknown, firstRun: unknown) {
  const calls: Call[] = []
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '').split('?')[0] ?? ''
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined
    calls.push({ path, method: init?.method ?? 'GET', ...(body === undefined ? {} : { body }) })
    const ok = (payload: unknown): Response => ({ ok: true, status: 200, json: async () => payload }) as unknown as Response
    const bad = (status: number): Response => ({ ok: false, status, json: async () => ({ error: 'x' }) }) as unknown as Response
    if (path === '/account') return account === undefined ? bad(404) : ok(account)
    if (path === '/first-run') return firstRun === undefined ? bad(404) : ok(firstRun)
    if (path.startsWith('/config/')) return bad(404)
    if (path === '/setup/status') return ok({ items: [], all_ok: true, optional_pending: 0, checked_at: '2026-09-18T10:00:00.000Z' })
    if (path === '/setup/apk.json') return ok({ available: false, path: '/x' })
    if (init?.method === 'POST') return ok({ ok: true })
    return ok(snapshot())
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

function props(fetchImpl: typeof fetch): WorkbenchOverlayProps {
  const instance = createWorkbenchStore().create()
  const workspaceState = {
    items: [], phase: 'ready', archivedSessionIds: [], state: 'idle', error: null, baselinesReady: true,
    recentWorkspaceId: undefined,
  }
  return {
    useStore: selector => selector(instance.getSnapshot()),
    actions: instance.actions,
    useWorkspaces: selector => selector(workspaceState as never),
    useSessions: selector => selector({} as never),
    ...UNUSED_STANDARD_PROPS,
    openWorkspace: async () => {},
    openSession: () => {},
    serviceFetch: fetchImpl,
    servicePollMs: 0,
    serviceWebSocket: (): MinimalWebSocket => ({ onmessage: null, onclose: null, close: () => {} }),
  }
}

/** 壳内页面的标志就是这个 URL 参数(inShellApp 认它)。 */
function enterShell(): void {
  window.history.replaceState({}, '', '/?ben-workbench=app')
}

function modeCalls(calls: Call[]): unknown[] {
  return calls.filter(c => c.path === '/shell/window-mode').map(c => c.body)
}

describe('接到 Workbench 上(壳内页面才发,状态变化才发)', () => {
  it('壳内 + 没登录 → 发一条 front', async () => {
    enterShell()
    const server = fakeServer({ registered: true, logged_in: false }, undefined)
    render(<WorkbenchOverlay {...props(server.fetchImpl)} />)
    await waitFor(() => { expect(modeCalls(server.calls)).toEqual([{ mode: 'front', source: 'app' }]) })
  })

  it('壳内 + 登录了 + 首次流程走完了 → 发一条 desktop(回到桌面级)', async () => {
    enterShell()
    const server = fakeServer({ registered: true, logged_in: true }, { done_at: '2026-09-18T02:00:00.000Z' })
    render(<WorkbenchOverlay {...props(server.fetchImpl)} />)
    await waitFor(() => { expect(modeCalls(server.calls)).toEqual([{ mode: 'desktop', source: 'app' }]) })
  })

  it('壳内 + 登录了 + 首次流程没走完 → front(引导整段在那一屏里)', async () => {
    enterShell()
    const server = fakeServer({ registered: true, logged_in: true }, {})
    render(<WorkbenchOverlay {...props(server.fetchImpl)} />)
    await waitFor(() => { expect(modeCalls(server.calls)).toEqual([{ mode: 'front', source: 'app' }]) })
  })

  it('不在壳里(浏览器标签)→ 一条都不发,哪怕没登录', async () => {
    window.history.replaceState({}, '', '/')
    const server = fakeServer({ registered: true, logged_in: false }, undefined)
    render(<WorkbenchOverlay {...props(server.fetchImpl)} />)
    // 等到 /account 真的问过了,再断言这一条都没发——不然测的只是"还没来得及发"。
    await waitFor(() => { expect(server.calls.some(c => c.path === '/account')).toBe(true) })
    expect(modeCalls(server.calls)).toEqual([])
  })

  it('这台服务没接账号(/account 404)→ desktop,而且只发一次', async () => {
    enterShell()
    const server = fakeServer(undefined, undefined)
    render(<WorkbenchOverlay {...props(server.fetchImpl)} />)
    await waitFor(() => { expect(modeCalls(server.calls)).toEqual([{ mode: 'desktop', source: 'app' }]) })
    // 轮询还在跑,状态没变就不该再发第二条。
    await new Promise(r => setTimeout(r, 50))
    expect(modeCalls(server.calls)).toEqual([{ mode: 'desktop', source: 'app' }])
  })
})

describe('没送到就再送(2026-09-25,卡 fix/slot-current-empty)', () => {
  it('★第一条 desktop 撞上壳还没连上({ok:false})→ 壳连上之后再送一条,送到了就不再送', async () => {
    enterShell()
    const calls: Call[] = []
    let helperConnected = false
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url).replace(/^https?:\/\/[^/]+/, '').split('?')[0] ?? ''
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined
      calls.push({ path, method: init?.method ?? 'GET', ...(body === undefined ? {} : { body }) })
      const ok = (payload: unknown): Response => ({ ok: true, status: 200, json: async () => payload }) as unknown as Response
      const bad = (status: number): Response => ({ ok: false, status, json: async () => ({ error: 'x' }) }) as unknown as Response
      if (path === '/account') return ok({ registered: true, logged_in: true })
      if (path === '/first-run') return ok({ done_at: '2026-09-18T02:00:00.000Z' })
      if (path.startsWith('/config/')) return bad(404)
      if (path === '/setup/status') return ok({ items: [], all_ok: true, optional_pending: 0, checked_at: '2026-09-18T10:00:00.000Z' })
      if (path === '/setup/apk.json') return ok({ available: false, path: '/x' })
      if (path === '/shell/window-mode') {
        // 壳没连上时服务端照样回 200,只是 body 里 ok:false(同 /snap 的先例)。
        const answer = helperConnected ? { ok: true, mode: 'desktop' } : { ok: false, reason: '工作台 App 未运行' }
        helperConnected = true // 送过第一条之后壳就连上了
        return ok(answer)
      }
      if (init?.method === 'POST') return ok({ ok: true })
      return ok(snapshot({ helper: { connected: helperConnected, authorized: helperConnected } }))
    }) as unknown as typeof fetch
    // 轮询要真的跑(helper.connected 从假变真靠它看见)。
    const p = { ...props(fetchImpl), servicePollMs: 30 }
    render(<WorkbenchOverlay {...p} />)
    await waitFor(() => { expect(modeCalls(calls)).toEqual([{ mode: 'desktop', source: 'app' }, { mode: 'desktop', source: 'app' }]) }, { timeout: 5000 })
    // 送到之后不再送。
    await new Promise(r => setTimeout(r, 200))
    expect(modeCalls(calls)).toHaveLength(2)
  })
})
