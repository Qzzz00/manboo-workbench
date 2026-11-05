/**
 * 登录屏与「账号」那一节(2026-09-17,决策记录「登录就是账号密码」)。
 *
 * 这个文件回答四件事:
 * ① 没登录时整屏就是登录屏,工作台一个字都不出现;
 * ② 登录/注册成功之后**不用刷新**就换成工作台;
 * ③ **服务端没接账号(404)时照旧直接是工作台** —— 展示台、手机、既有的一大批用例都靠这一条;
 * ④ 设置里的用户名 / 改密码 / 退出登录。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, within, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AccountPanel } from '../src/client/account/AccountPanel.tsx'
import { ACCOUNT_NO_RELAY_FOOT, AccountScreen } from '../src/client/account/AccountScreen.tsx'
import { WorkbenchOverlay, type MinimalWebSocket, type WorkbenchOverlayProps } from '../src/client/Workbench.tsx'
import { createWorkbenchStore } from '../src/client/store.ts'
import type { WorkbenchState } from '../src/protocol.ts'
import { UNUSED_STANDARD_PROPS } from './helpers/standardProps.ts'
import { GROUP, openGroup } from './settingsGroup.ts'

afterEach(cleanup)

function snapshot(over: Partial<WorkbenchState> = {}): WorkbenchState {
  return { agents: [], sessions: [], quota: {}, now: '2026-09-17T10:00:00+08:00', stale: false, ...over }
}

interface Call { url: string, method: string, body?: Record<string, unknown> }

/**
 * 假服务端。`account` 是一份会被 POST 改掉的可变状态 —— 登录完再问一次 /account 要拿到新答案,
 * 那正是这一屏"不用刷新"的机关。
 */
function fakeServer(options: {
  account?: { registered: boolean, logged_in: boolean, username?: string } | 'missing'
  firstRunDone?: boolean
  failLogin?: string
  /** 登录之后 /account 仍然说没登录:模拟浏览器把 cookie 挡了。 */
  cookieBlocked?: boolean
  state?: WorkbenchState
} = {}) {
  const calls: Call[] = []
  const account = options.account ?? { registered: false, logged_in: false }
  const live = account === 'missing' ? undefined : { ...account }
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '').split('?')[0] ?? ''
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined
    calls.push({ url: path, method: init?.method ?? 'GET', ...(body === undefined ? {} : { body }) })
    const ok = (payload: unknown): Response => ({ ok: true, status: 200, json: async () => payload }) as unknown as Response
    const bad = (status: number, error: string): Response =>
      ({ ok: false, status, json: async () => ({ error }) }) as unknown as Response

    if (path === '/account') return live === undefined ? bad(404, '账号未启用') : ok(live)
    if (path === '/account/login') {
      if (options.failLogin !== undefined) return bad(401, options.failLogin)
      if (live !== undefined && options.cookieBlocked !== true) { live.logged_in = true; live.username = 'ben' }
      return ok({ ok: true, username: 'ben' })
    }
    if (path === '/account/register') {
      if (live !== undefined && options.cookieBlocked !== true) { live.registered = true; live.logged_in = true; live.username = 'ben' }
      return ok({ ok: true, username: 'ben' })
    }
    if (path === '/account/logout') {
      if (live !== undefined) live.logged_in = false
      return ok({ ok: true })
    }
    if (path === '/first-run') return ok(options.firstRunDone === false ? {} : { done_at: '2026-09-17T09:00:00.000Z' })
    if (path === '/setup/status') return ok({ items: [], all_ok: true, optional_pending: 0, checked_at: '2026-09-17T10:00:00.000Z' })
    if (path === '/setup/apk.json') return ok({ available: false, path: '/x' })
    if (path.startsWith('/config/')) return bad(404, 'x')
    if (init?.method === 'POST') return ok({ ok: true })
    return ok(options.state ?? snapshot())
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

describe('登录屏本身', () => {
  it('还没注册过:默认落在「注册」,而且说人话', () => {
    render(
      <AccountScreen baseUrl="http://x" fetchImpl={fakeServer().fetchImpl} view={{ registered: false, logged_in: false }} onLoggedIn={() => {}} />,
    )
    expect(screen.getByRole('tab', { name: '注册' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText(/随便注册一个/)).toBeTruthy()
    expect(screen.getByRole('button', { name: '注册' })).toBeTruthy()
  })

  it('这台没接中转:本机账号照旧注册,底下那一行不说「存在服务器上」', () => {
    render(
      <AccountScreen baseUrl="http://x" fetchImpl={fakeServer().fetchImpl} view={{ registered: false, logged_in: false, on_server: false, relay_configured: false }} onLoggedIn={() => {}} />,
    )
    expect(screen.getByRole('button', { name: '注册' })).toBeTruthy()
    expect(screen.getByText(ACCOUNT_NO_RELAY_FOOT)).toBeTruthy()
    expect(screen.queryByText(/服务器/)).toBeNull()
  })

  it('不是浮在空白里的卡(2026-09-23):顶上是粒子黑洞(品牌主视觉,不是她的球),表单没有卡片容器', () => {
    render(
      <AccountScreen baseUrl="http://x" fetchImpl={fakeServer().fetchImpl} view={{ registered: false, logged_in: false }} onLoggedIn={() => {}} />,
    )
    const root = screen.getByRole('dialog', { name: '登录' })
    expect(root).toHaveClass('ben-wb__onb')
    const hero = root.querySelector('.ben-wb__brand-slot .ben-wb__brand-hero')
    const form = root.querySelector('form')
    expect(hero).not.toBeNull()
    expect(hero).toHaveAttribute('aria-hidden', 'true')
    // 她的球不在登录页上:登录成功那一下才从黑洞里「飞出来」
    expect(root.querySelector('.ben-wb__particle-orb')).toBeNull()
    expect(form).toHaveClass('ben-wb__account-form')
    expect(root.querySelector('.ben-wb__account-card')).toBeNull()
    // 黑洞在表单上面
    expect(hero!.compareDocumentPosition(form!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('注册过了:默认落在「登录」,没有「确认密码」那一格', () => {
    render(
      <AccountScreen baseUrl="http://x" fetchImpl={fakeServer({ account: { registered: true, logged_in: false, username: 'ben' } }).fetchImpl} view={{ registered: true, logged_in: false, username: 'ben' }} onLoggedIn={() => {}} />,
    )
    expect(screen.getByRole('tab', { name: '登录' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.queryByLabelText('确认密码')).toBeNull()
  })

  it('注册:把用户名/密码/确认密码交上去,然后回一个登录态', async () => {
    const server = fakeServer()
    const onLoggedIn = vi.fn()
    render(
      <AccountScreen baseUrl="http://x" fetchImpl={server.fetchImpl} view={{ registered: false, logged_in: false }} onLoggedIn={onLoggedIn} />,
    )
    await userEvent.type(screen.getByLabelText('用户名'), 'ben')
    await userEvent.type(screen.getByLabelText('密码'), 'hello')
    await userEvent.type(screen.getByLabelText('确认密码'), 'hello')
    await userEvent.click(screen.getByRole('button', { name: '注册' }))
    await waitFor(() => expect(onLoggedIn).toHaveBeenCalled())
    const post = server.calls.find(call => call.url === '/account/register')
    expect(post?.body).toEqual({ username: 'ben', password: 'hello', confirm: 'hello' })
  })

  it('忘了密码:「重置账号」确认后 POST /account/reset,切到注册页,并通知上层重新问一次(2026-09-17,不再叫人删文件)', async () => {
    const server = fakeServer({ account: { registered: true, logged_in: false, username: 'ben' } })
    const onReset = vi.fn()
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    try {
      render(
        <AccountScreen baseUrl="http://x" fetchImpl={server.fetchImpl} view={{ registered: true, logged_in: false, username: 'ben' }} onLoggedIn={() => {}} onReset={onReset} />,
      )
      expect(screen.queryByText(/account\.json/)).toBeNull()
      await userEvent.click(screen.getByRole('button', { name: '重置账号,重新注册' }))
      await waitFor(() => expect(onReset).toHaveBeenCalledTimes(1))
      expect(server.calls.some(call => call.url === '/account/reset' && call.method === 'POST')).toBe(true)
      expect(screen.getByRole('tab', { name: '注册', selected: true })).toBeTruthy()
    } finally {
      confirmSpy.mockRestore()
    }
  })

  it('「重置账号」在确认框里点了取消:什么都不发', async () => {
    const server = fakeServer({ account: { registered: true, logged_in: false, username: 'ben' } })
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    try {
      render(<AccountScreen baseUrl="http://x" fetchImpl={server.fetchImpl} view={{ registered: true, logged_in: false, username: 'ben' }} onLoggedIn={() => {}} />)
      await userEvent.click(screen.getByRole('button', { name: '重置账号,重新注册' }))
      expect(server.calls.some(call => call.url === '/account/reset')).toBe(false)
    } finally {
      confirmSpy.mockRestore()
    }
  })

  it('服务端说什么就显示什么(界面不自己另编一句)', async () => {
    const server = fakeServer({ account: { registered: true, logged_in: false }, failLogin: '用户名或密码不对' })
    render(
      <AccountScreen baseUrl="http://x" fetchImpl={server.fetchImpl} view={{ registered: true, logged_in: false }} onLoggedIn={() => {}} />,
    )
    await userEvent.type(screen.getByLabelText('用户名'), 'ben')
    await userEvent.type(screen.getByLabelText('密码'), 'x')
    await userEvent.click(screen.getByRole('button', { name: '登录' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('用户名或密码不对')
  })

  it('浏览器把 cookie 挡了:当场说清楚该换哪个地址,而不是让人反复输密码', async () => {
    const server = fakeServer({ account: { registered: true, logged_in: false }, cookieBlocked: true })
    const onLoggedIn = vi.fn()
    render(
      <AccountScreen baseUrl="http://x" fetchImpl={server.fetchImpl} view={{ registered: true, logged_in: false }} onLoggedIn={onLoggedIn} />,
    )
    await userEvent.type(screen.getByLabelText('用户名'), 'ben')
    await userEvent.type(screen.getByLabelText('密码'), 'hello')
    await userEvent.click(screen.getByRole('button', { name: '登录' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('127.0.0.1:3080')
    expect(onLoggedIn).not.toHaveBeenCalled()
  })
})

describe('工作台的那道门', () => {
  it('没登录:整屏是登录屏,看板一个字都不出现', async () => {
    const server = fakeServer({ account: { registered: true, logged_in: false, username: 'ben' } })
    render(<WorkbenchOverlay {...props(server.fetchImpl)} />)
    expect(await screen.findByRole('dialog', { name: '登录' })).toBeTruthy()
    expect(screen.queryByText('项目区')).toBeNull()
    expect(screen.queryByRole('button', { name: '设置' })).toBeNull()
  })

  it('登录成功 → 不用刷新就换成工作台', async () => {
    const server = fakeServer({ account: { registered: true, logged_in: false, username: 'ben' } })
    render(<WorkbenchOverlay {...props(server.fetchImpl)} />)
    await userEvent.type(await screen.findByLabelText('用户名'), 'ben')
    await userEvent.type(screen.getByLabelText('密码'), 'hello')
    await userEvent.click(screen.getByRole('button', { name: '登录' }))
    expect(await screen.findByRole('button', { name: '设置' })).toBeTruthy()
    expect(screen.queryByRole('dialog', { name: '登录' })).toBeNull()
  })

  it('已经登录着:直接就是工作台,登录屏不出现', async () => {
    const server = fakeServer({ account: { registered: true, logged_in: true, username: 'ben' } })
    render(<WorkbenchOverlay {...props(server.fetchImpl)} />)
    expect(await screen.findByRole('button', { name: '设置' })).toBeTruthy()
    expect(screen.queryByRole('dialog', { name: '登录' })).toBeNull()
  })

  it('**服务端没接账号(404):照旧直接是工作台**', async () => {
    const server = fakeServer({ account: 'missing' })
    render(<WorkbenchOverlay {...props(server.fetchImpl)} />)
    expect(await screen.findByRole('button', { name: '设置' })).toBeTruthy()
    expect(screen.queryByRole('dialog', { name: '登录' })).toBeNull()
  })
})

describe('设置里的「账号」一节', () => {
  it('显示用户名;「改密码」展开三格,保存时把当前密码一起交上去', async () => {
    const server = fakeServer({ account: { registered: true, logged_in: true, username: 'ben' } })
    render(
      <AccountPanel baseUrl="http://x" fetchImpl={server.fetchImpl} view={{ registered: true, logged_in: true, username: 'ben' }} onChanged={() => {}} />,
    )
    expect(screen.getByText('ben')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: '改密码' }))
    await userEvent.type(screen.getByLabelText('当前密码'), 'hello')
    await userEvent.type(screen.getByLabelText('新密码'), 'newpass')
    await userEvent.type(screen.getByLabelText('确认新密码'), 'newpass')
    await userEvent.click(screen.getByRole('button', { name: '保存新密码' }))
    await waitFor(() => {
      const post = server.calls.find(call => call.url === '/account/register')
      expect(post?.body).toEqual({ current_password: 'hello', password: 'newpass', confirm: 'newpass' })
    })
  })

  it('「退出登录」打那条路,并告诉上层去重新问一次', async () => {
    const server = fakeServer({ account: { registered: true, logged_in: true, username: 'ben' } })
    const onChanged = vi.fn()
    render(
      <AccountPanel baseUrl="http://x" fetchImpl={server.fetchImpl} view={{ registered: true, logged_in: true, username: 'ben' }} onChanged={onChanged} />,
    )
    await userEvent.click(screen.getByRole('button', { name: '退出登录' }))
    // 10-22 起先问一句(共用确认弹层「退出登录?」),点「退出」才打那条路
    expect(server.calls.some(call => call.url === '/account/logout')).toBe(false)
    await userEvent.click(within(screen.getByRole('dialog', { name: '退出登录?' })).getByRole('button', { name: '退出' }))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    expect(server.calls.some(call => call.url === '/account/logout' && call.method === 'POST')).toBe(true)
  })

  it('齿轮里点「退出登录」之后,界面回到登录屏', async () => {
    const server = fakeServer({ account: { registered: true, logged_in: true, username: 'ben' } })
    render(<WorkbenchOverlay {...props(server.fetchImpl)} />)
    await userEvent.click(await screen.findByRole('button', { name: '设置' }))
    // 2026-09-28(卡 SG):账号那一节收进「这台电脑」那一组,先切过去再点。
    await openGroup(GROUP.machine)
    await userEvent.click(await screen.findByRole('button', { name: '退出登录' }))
    await userEvent.click(within(screen.getByRole('dialog', { name: '退出登录?' })).getByRole('button', { name: '退出' }))
    expect(await screen.findByRole('dialog', { name: '登录' })).toBeTruthy()
  })
})

/**
 * 2026-09-23 从零重装验收第 4 件:登录页底部写「账号只存在这台电脑上,不会传到任何地方」,
 * 而 account-server.json 明明在(账号在服务器上)。这一行要与事实一致。
 */
describe('★ 登录页底下「账号存在哪」那一行与事实一致', () => {
  it('账号在服务器上:不再说「只存在这台电脑上」', () => {
    render(<AccountScreen baseUrl="http://x" view={{ registered: true, logged_in: false, username: 'ben', on_server: true }} onLoggedIn={() => {}} />)
    expect(screen.queryByText(/只存在这台电脑上/)).toBeNull()
    expect(screen.getByText(/账号在工作台的服务器上/)).toBeTruthy()
  })

  it('本机账号(老机器 / 服务器没有账号服务时退回的):那一句仍然是真的,照说', () => {
    render(<AccountScreen baseUrl="http://x" view={{ registered: true, logged_in: false, username: 'ben' }} onLoggedIn={() => {}} />)
    expect(screen.getByText(/账号只存在这台电脑上,不会传到任何地方/)).toBeTruthy()
  })

  it('还没注册:说注册会存到服务器上,连不上才先存本机', () => {
    render(<AccountScreen baseUrl="http://x" view={{ registered: false, logged_in: false }} onLoggedIn={() => {}} />)
    expect(screen.queryByText(/不会传到任何地方/)).toBeNull()
    expect(screen.getByText(/注册的账号存在工作台的服务器上/)).toBeTruthy()
  })

  it('账号在服务器上时「重置账号」确认框说的是退出这台电脑,不是删账号', async () => {
    const server = fakeServer({ account: { registered: true, logged_in: false, username: 'ben' } })
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    try {
      render(<AccountScreen baseUrl="http://x" fetchImpl={server.fetchImpl} view={{ registered: true, logged_in: false, username: 'ben', on_server: true }} onLoggedIn={() => {}} />)
      await userEvent.click(screen.getByRole('button', { name: '重置账号,重新注册' }))
      expect(confirmSpy.mock.calls[0]?.[0]).toContain('服务器上的账号不删')
    } finally {
      confirmSpy.mockRestore()
    }
  })
})
