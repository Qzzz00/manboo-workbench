/**
 * 启动时序(2026-11-13):不是直接到图一,先判断有没有配 AI 模型。
 *
 *   首次流程没走完 → 弹窗「检测到未配置大模型api key,请先配置」 → 3 秒后自动到图二
 *   已走过引导 + 明确配好 → 不弹,直接进工作台
 *   问不到 / 本机存着旧 Key 但引导没走完 → 照样弹(真机返工)
 *
 * 这一层测的是 Workbench 那几处 early-return 的**先后**,不是纯函数;所以直接渲染
 * WorkbenchOverlay,用一个小 fakeServer 驱动 /account、/first-run、/credentials。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WORKBENCH_TITLE, WorkbenchOverlay, type MinimalWebSocket, type WorkbenchOverlayProps } from '../src/client/Workbench.tsx'
import { createWorkbenchStore } from '../src/client/store.ts'
import { API_KEY_STARTUP_COPY, API_KEY_STARTUP_DELAY_MS } from '../src/client/apiKeyStartup.ts'
import type { WorkbenchState } from '../src/protocol.ts'
import { UNUSED_STANDARD_PROPS } from './helpers/standardProps.ts'

/**
 * OSS 仓里 `store.ts` 指到上游 harness checkout 的 src,那份 checkout 没装 zustand,
 * vite 解析 `zustand/vanilla` 会直接把整个文件染红(既有 client-firstrun.test.tsx 同因)。
 * 本用例只关心启动那几处 early-return 的先后,不关心 store 真值,桩掉即可。
 */
vi.mock('../src/client/store.ts', () => ({
  createWorkbenchStore: () => ({
    create: () => ({
      // WorkbenchOverlayInner 开头有 `if (!state.open) return <ReturnToWorkbench/>`,
      // 桩里必须给 open:true,否则整屏根本不挂载。
      getSnapshot: () => ({ open: true, openingProjectId: null, error: null }),
      actions: { open: () => {}, close: () => {}, startOpening: () => {}, failOpening: () => {} },
    }),
  }),
}))

afterEach(() => { cleanup(); vi.useRealTimers() })

function snapshot(): WorkbenchState {
  return { agents: [], sessions: [], quota: {}, now: '2026-11-13T09:00:00+08:00', stale: false }
}

interface Call { url: string, method: string }

function fakeServer(options: {
  /** 不传 = 问不到(回一份状态快照,不是凭据结构)。 */
  deepseekConfigured?: boolean
  /** 让 /credentials 卡住,用来验证「探测没回来先空屏、不闪图一」。 */
  holdCredentials?: { promise: Promise<void> }
  /** 传了 = 已经走过引导(firstRunNeeded === false),用来验证「配好了就别拦」。 */
  firstRunDone?: boolean
} = {}) {
  const calls: Call[] = []
  const ok = (payload: unknown): Response =>
    ({ ok: true, status: 200, json: async () => payload }) as unknown as Response
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '').split('?')[0] ?? ''
    calls.push({ url: path, method: init?.method ?? 'GET' })
    if (path === '/account') return ok({ registered: true, logged_in: true, username: 'ben' })
    if (path === '/credentials') {
      if (options.holdCredentials !== undefined) await options.holdCredentials.promise
      return options.deepseekConfigured === undefined
        ? ok(snapshot())
        : ok({ deepseek: { configured: options.deepseekConfigured } })
    }
    if (path === '/first-run') return ok(options.firstRunDone ? { done_at: '2026-11-06T10:00:00+08:00' } : {})
    if (path === '/onboarding') return ok({ stage: 'opening', done: false })
    if (path === '/onboarding/turns') return ok({ turns: [], busy: false, ended: false, stage: 'opening', done: false })
    if (path === '/onboarding/detail') return ok({ stage: 'opening', done: false })
    if (path === '/setup/apk.json') return ok({ available: false, path: '/x', hint: '还没出过包' })
    if (path === '/model') return ok({ mode: 'own', ready: false, own_key_configured: false, base_url: 'https://api.deepseek.com/v1', model: 'deepseek-v4-flash' })
    if (path.startsWith('/config/')) return { ok: false, status: 404, json: async () => ({ error: 'x' }) } as unknown as Response
    if (init?.method === 'POST') return ok({ ok: true })
    return ok(snapshot())
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

function overlay(fetchImpl: typeof fetch) {
  const instance = createWorkbenchStore().create()
  const workspaceState = {
    items: [], phase: 'ready', archivedSessionIds: [], state: 'idle', error: null,
    baselinesReady: true, recentWorkspaceId: undefined,
  }
  const props: WorkbenchOverlayProps = {
    // 显式给 selector 标类型:OSS 仓缺私有 DSH 依赖时 PropsStore 退化成 any,
    // 不标会在 strict 下多出 3 条 TS7006(既有 client-firstrun.test.tsx 就是这么红的)。
    useStore: (selector: (state: unknown) => unknown) => selector(instance.getSnapshot()),
    actions: instance.actions,
    useWorkspaces: (selector: (state: unknown) => unknown) => selector(workspaceState as never),
    useSessions: (selector: (state: unknown) => unknown) => selector({} as never),
    ...UNUSED_STANDARD_PROPS,
    openWorkspace: async () => {},
    openSession: () => {},
    serviceFetch: fetchImpl,
    servicePollMs: 0,
    serviceWebSocket: (): MinimalWebSocket => ({ onmessage: null, onclose: null, close: () => {} }),
  }
  return render(<WorkbenchOverlay {...props} />)
}

describe('没配 AI 来源:启动先弹窗', () => {
  it('第一眼是弹窗,不是图一;提示语用原话', async () => {
    overlay(fakeServer({ deepseekConfigured: false }).fetchImpl)
    const dialog = await screen.findByRole('dialog', { name: '未配置大模型密钥' })
    expect(dialog.textContent).toContain(API_KEY_STARTUP_COPY.title)
    // 弹窗期间图一那两颗按钮还没出现(不是「直接到图一」)。
    expect(screen.queryByRole('button', { name: '已经有在做的事' })).toBeNull()
    expect(screen.queryByRole('dialog', { name: '第一次用' })).toBeNull()
  })

  it('点了「立即去配置」:立刻到图二(模型服务 + 各家的登录与密钥),不经过图一', async () => {
    overlay(fakeServer({ deepseekConfigured: false }).fetchImpl)
    await userEvent.click(await screen.findByRole('button', { name: API_KEY_STARTUP_COPY.go }))
    expect(await screen.findByRole('region', { name: '模型与 AI 来源' })).toBeTruthy()
    expect(screen.getByText('模型服务')).toBeTruthy()
    expect(screen.queryByRole('dialog', { name: '未配置大模型密钥' })).toBeNull()
    expect(screen.queryByRole('button', { name: '已经有在做的事' })).toBeNull()
  })

  it('3 秒到点:自动跳到图二', async () => {
    overlay(fakeServer({ deepseekConfigured: false }).fetchImpl)
    await screen.findByRole('dialog', { name: '未配置大模型密钥' })
    expect(screen.queryByRole('region', { name: '模型与 AI 来源' })).toBeNull()
    await waitFor(() => expect(screen.getByRole('region', { name: '模型与 AI 来源' })).toBeTruthy(), {
      timeout: API_KEY_STARTUP_DELAY_MS + 4000,
    })
    expect(screen.queryByRole('dialog', { name: '未配置大模型密钥' })).toBeNull()
  })

  it('点「稍后再说」:关弹窗,按原流程进图一', async () => {
    overlay(fakeServer({ deepseekConfigured: false }).fetchImpl)
    await userEvent.click(await screen.findByRole('button', { name: API_KEY_STARTUP_COPY.skip }))
    expect(await screen.findByRole('dialog', { name: '第一次用' })).toBeTruthy()
    expect(screen.queryByRole('dialog', { name: '未配置大模型密钥' })).toBeNull()
  })

  it('探测没回来时先空屏,不先闪一下图一', async () => {
    let release: (() => void) | undefined
    const promise = new Promise<void>(resolve => { release = resolve })
    overlay(fakeServer({ deepseekConfigured: false, holdCredentials: { promise } }).fetchImpl)
    // 注意:网页 <main> 的 aria-label 是「工作台」(WORKBENCH_TITLE),
    // 「manboo事务官」是 Electron shell 的窗口标题,两者不是一回事。
    await waitFor(() => expect(screen.getByLabelText(WORKBENCH_TITLE)).toHaveAttribute('aria-busy', 'true'))
    expect(screen.queryByRole('dialog', { name: '第一次用' })).toBeNull()
    expect(screen.queryByRole('dialog', { name: '未配置大模型密钥' })).toBeNull()
    release?.()
    expect(await screen.findByRole('dialog', { name: '未配置大模型密钥' })).toBeTruthy()
  })

  it('启动确实问了一次 GET /credentials', async () => {
    const server = fakeServer({ deepseekConfigured: false })
    overlay(server.fetchImpl)
    await screen.findByRole('dialog', { name: '未配置大模型密钥' })
    expect(server.calls.some(call => call.url === '/credentials' && call.method === 'GET')).toBe(true)
  })
})

describe('真机返工(2026-11-13):旧版在这两种情况下直接放行进图一', () => {
  it('本机存着 DeepSeek Key(configured:true)但首次流程没走完:照样弹,3 秒后到图二', async () => {
    // 维护者截图那台机器:/credentials 回 true、/model ready:true,旧版「已配→放行」,
    // 于是每次启动都是图一。旗子还立着 = 配置这趟没走完,必须提醒。
    overlay(fakeServer({ deepseekConfigured: true }).fetchImpl)
    expect(await screen.findByRole('dialog', { name: '未配置大模型密钥' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '已经有在做的事' })).toBeNull()
    await waitFor(() => expect(screen.getByRole('region', { name: '模型与 AI 来源' })).toBeTruthy(), {
      timeout: API_KEY_STARTUP_DELAY_MS + 4000,
    })
  })

  it('/credentials 回的不是凭据结构(服务没起 / 返回 404):照样弹,不静默放行', async () => {
    overlay(fakeServer().fetchImpl)
    expect(await screen.findByRole('dialog', { name: '未配置大模型密钥' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '已经有在做的事' })).toBeNull()
  })
})

describe('真的配好了:不拦路', () => {
  it('已经走过引导(firstRunNeeded=false)且 Key 配好:不弹窗,直接进工作台', async () => {
    overlay(fakeServer({ deepseekConfigured: true, firstRunDone: true }).fetchImpl)
    await waitFor(() => expect(screen.getByLabelText(WORKBENCH_TITLE)).toBeTruthy())
    expect(screen.queryByRole('dialog', { name: '未配置大模型密钥' })).toBeNull()
    expect(screen.queryByRole('dialog', { name: '第一次用' })).toBeNull()
  })
})
