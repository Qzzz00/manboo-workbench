/**
 * 顶上那两条细横幅(2026-09-17,决策记录「三个环节分开」):
 * 「还差一个授权:辅助功能 → 去授权」与「还没填 DeepSeek 密钥 → 去设置」。
 *
 * 要钉住的三件事:
 * - **没体检过时一条都不出**(/state.setup_alerts 缺席):「没查过」不是「差着」;
 * - 都齐了就整块消失,不留一条空横幅;
 * - 它们**不拦路** —— 工作台照常在下面,按钮只是"去那儿"的路。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NeedBar } from '../src/client/NeedBar.tsx'
import { WorkbenchOverlay, type MinimalWebSocket, type WorkbenchOverlayProps } from '../src/client/Workbench.tsx'
import { createWorkbenchStore } from '../src/client/store.ts'
import type { WorkbenchState } from '../src/protocol.ts'
import { UNUSED_STANDARD_PROPS } from './helpers/standardProps.ts'

afterEach(cleanup)

function snapshot(over: Partial<WorkbenchState> = {}): WorkbenchState {
  return { agents: [], sessions: [], quota: {}, now: '2026-09-17T10:00:00+08:00', stale: false, ...over }
}

interface Call { url: string, method: string, body?: Record<string, unknown> }

function fakeServer(state: WorkbenchState) {
  const calls: Call[] = []
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '').split('?')[0] ?? ''
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined
    calls.push({ url: path, method: init?.method ?? 'GET', ...(body === undefined ? {} : { body }) })
    const ok = (payload: unknown): Response => ({ ok: true, status: 200, json: async () => payload }) as unknown as Response
    const bad = (status: number): Response => ({ ok: false, status, json: async () => ({ error: 'x' }) }) as unknown as Response
    if (path === '/account' || path === '/first-run' || path.startsWith('/config/')) return bad(404)
    if (path === '/setup/status') return ok({ items: [], all_ok: true, optional_pending: 0, checked_at: '2026-09-17T10:00:00.000Z' })
    if (path === '/setup/apk.json') return ok({ available: false, path: '/x' })
    if (init?.method === 'POST') return ok({ ok: true })
    return ok(state)
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

describe('横幅本身', () => {
  it('还没体检过(alerts 缺席):一条都不画', () => {
    const { container } = render(<NeedBar baseUrl="http://x" fetchImpl={fakeServer(snapshot()).fetchImpl} onOpenSettings={() => {}} />)
    expect(container.textContent).toBe('')
  })

  it('两样都齐了:整块消失', () => {
    const { container } = render(
      <NeedBar
        baseUrl="http://x"
        fetchImpl={fakeServer(snapshot()).fetchImpl}
        alerts={{ accessibility: false, deepseek_key: false }}
        onOpenSettings={() => {}}
      />,
    )
    expect(container.textContent).toBe('')
  })

  it('缺授权:一条横幅 +「去授权」,点了就开系统设置那一页', async () => {
    const server = fakeServer(snapshot())
    render(
      <NeedBar
        baseUrl="http://x"
        fetchImpl={server.fetchImpl}
        alerts={{ accessibility: true, deepseek_key: false }}
        onOpenSettings={() => {}}
      />,
    )
    expect(screen.getByText(/还差一个授权:辅助功能/)).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: '去授权' }))
    await waitFor(() => {
      expect(server.calls.some(call => call.url === '/setup/open' && call.body?.pane === 'accessibility')).toBe(true)
    })
  })

  it('缺密钥:「去设置」把齿轮弹窗叫出来 —— 它不是登录的一部分', async () => {
    const server = fakeServer(snapshot())
    const onOpenSettings = vi.fn()
    render(
      <NeedBar
        baseUrl="http://x"
        fetchImpl={server.fetchImpl}
        alerts={{ accessibility: false, deepseek_key: true }}
        onOpenSettings={onOpenSettings}
      />,
    )
    await userEvent.click(screen.getByRole('button', { name: '去设置' }))
    expect(onOpenSettings).toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: '去授权' })).toBeNull()
  })

  it('去授权回来(窗口重新拿到焦点)→ 自己复查一次', async () => {
    const server = fakeServer(snapshot())
    render(
      <NeedBar
        baseUrl="http://x"
        fetchImpl={server.fetchImpl}
        alerts={{ accessibility: true, deepseek_key: false }}
        onOpenSettings={() => {}}
      />,
    )
    // 没点过「去授权」的时候,回到窗口不该白跑一次体检。
    window.dispatchEvent(new Event('focus'))
    expect(server.calls.some(call => call.url === '/setup/status')).toBe(false)

    await userEvent.click(screen.getByRole('button', { name: '去授权' }))
    window.dispatchEvent(new Event('focus'))
    await waitFor(() => expect(server.calls.some(call => call.url === '/setup/status')).toBe(true))
  })
})

describe('挂在工作台上', () => {
  it('两条都缺就两条都在,而且工作台照常在下面(不拦路)', async () => {
    const state = snapshot({ setup_alerts: { accessibility: true, deepseek_key: true } })
    render(<WorkbenchOverlay {...props(fakeServer(state).fetchImpl)} />)
    expect(await screen.findByText(/还差一个授权:辅助功能/)).toBeTruthy()
    expect(screen.getByText(/用自己的 DeepSeek Key,但还没填/)).toBeTruthy()
    expect(screen.getByRole('button', { name: '设置' })).toBeTruthy()
  })

  it('弄好了(下一拍 alerts 变假)→ 横幅消失', async () => {
    const state = snapshot({ setup_alerts: { accessibility: true, deepseek_key: false } })
    const { rerender } = render(<WorkbenchOverlay {...props(fakeServer(state).fetchImpl)} />)
    expect(await screen.findByText(/还差一个授权:辅助功能/)).toBeTruthy()

    const fixed = snapshot({ setup_alerts: { accessibility: false, deepseek_key: false } })
    rerender(<WorkbenchOverlay {...props(fakeServer(fixed).fetchImpl)} />)
    await waitFor(() => expect(screen.queryByText(/还差一个授权:辅助功能/)).toBeNull())
  })
})

/**
 * 第四条横幅:「手机现在看不到电脑上的文件:还差完全磁盘访问 → 去给」
 * (2026-10-13,维护者:「我在手机上每次看文件,电脑上似乎都有一个授权弹窗要点…
 * 不解决这个问题,那这个功能就废了,因为我要看文件的场景,说明我不在电脑桌前」)。
 *
 * 它出在横幅而不是只留在体检里:体检那一格是**可选项**(主路不靠它),
 * 而它坏掉的那件事维护者说"功能就废了"。
 */
describe('完全磁盘访问那一条', () => {
  it('那一格缺席:不画(没查过 / 判断不了,都不是"差着")', () => {
    const { container } = render(
      <NeedBar
        baseUrl="http://x"
        fetchImpl={fakeServer(snapshot()).fetchImpl}
        alerts={{ accessibility: false, deepseek_key: false }}
        onOpenSettings={() => {}}
      />,
    )
    expect(container.textContent).toBe('')
  })

  it('给过了(那一格为假):不画', () => {
    const { container } = render(
      <NeedBar
        baseUrl="http://x"
        fetchImpl={fakeServer(snapshot()).fetchImpl}
        alerts={{ file_access: false }}
        onOpenSettings={() => {}}
      />,
    )
    expect(container.textContent).toBe('')
  })

  it('★没给:一条横幅 +「去给」,点了就开**完全磁盘访问**那一页(不是辅助功能那一页)', async () => {
    const server = fakeServer(snapshot())
    render(
      <NeedBar
        baseUrl="http://x"
        fetchImpl={server.fetchImpl}
        alerts={{ file_access: true }}
        onOpenSettings={() => {}}
      />,
    )
    expect(screen.getByText(/手机现在看不到电脑上的文件/)).toBeTruthy()
    // ★横幅上**不许**出现"重启":10-13 按 TCC 日志量过,给完当场生效
    // (一个 10-12 21:17 起的 8791 在那次授权后没重启就读到 Allowed,见 fullDiskAccess.ts 文件头)。
    expect(screen.queryByText(/重启/)).toBeNull()
    expect(screen.getByText(/你不在电脑前也看得到文件/)).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: '去给' }))
    await waitFor(() => {
      expect(server.calls.some(call => call.url === '/setup/open' && call.body?.pane === 'all_files')).toBe(true)
    })
  })

  it('只有这一条缺的时候,辅助功能那一条不跟着冒出来', () => {
    render(
      <NeedBar
        baseUrl="http://x"
        fetchImpl={fakeServer(snapshot()).fetchImpl}
        alerts={{ file_access: true }}
        onOpenSettings={() => {}}
      />,
    )
    expect(screen.queryByText(/还差一个授权:辅助功能/)).toBeNull()
    expect(screen.queryByRole('button', { name: '去授权' })).toBeNull()
  })

  it('去给回来(窗口重新拿到焦点)→ 自己复查一次', async () => {
    const server = fakeServer(snapshot())
    render(
      <NeedBar
        baseUrl="http://x"
        fetchImpl={server.fetchImpl}
        alerts={{ file_access: true }}
        onOpenSettings={() => {}}
      />,
    )
    window.dispatchEvent(new Event('focus'))
    expect(server.calls.some(call => call.url === '/setup/status')).toBe(false)

    await userEvent.click(screen.getByRole('button', { name: '去给' }))
    window.dispatchEvent(new Event('focus'))
    await waitFor(() => expect(server.calls.some(call => call.url === '/setup/status')).toBe(true))
  })

  it('挂在工作台上:给完了(下一拍那一格变假)→ 这条消失', async () => {
    const state = snapshot({ setup_alerts: { accessibility: false, file_access: true } })
    const { rerender } = render(<WorkbenchOverlay {...props(fakeServer(state).fetchImpl)} />)
    expect(await screen.findByText(/手机现在看不到电脑上的文件/)).toBeTruthy()

    const fixed = snapshot({ setup_alerts: { accessibility: false, file_access: false } })
    rerender(<WorkbenchOverlay {...props(fakeServer(fixed).fetchImpl)} />)
    await waitFor(() => expect(screen.queryByText(/手机现在看不到电脑上的文件/)).toBeNull())
  })
})

/**
 * 第三条横幅:「模型服务还没接上 → 重试」(2026-09-18,决策记录同日「新用户零凭据」)。
 *
 * 正常新用户**一辈子看不到它** —— 注册那一刻服务端已经替他领好令牌了。
 * 它只在"替他领过、而且没领到"的时候出;领不到的原因(中转没部署、网不通)不该拦住登录,
 * 但也不能不声不响。
 */
describe('模型服务那一条', () => {
  it('那一格缺席:不画(没试过不是没缺)', () => {
    const { container } = render(
      <NeedBar
        baseUrl="http://x"
        fetchImpl={fakeServer(snapshot()).fetchImpl}
        alerts={{ accessibility: false, deepseek_key: false }}
        onOpenSettings={() => {}}
      />,
    )
    expect(container.textContent).toBe('')
  })

  it('没接上:一条横幅 +「重试」,点了就打 /model/auto-setup,并把服务端那句话显示出来', async () => {
    const server = fakeServer(snapshot())
    render(
      <NeedBar
        baseUrl="http://x"
        fetchImpl={server.fetchImpl}
        alerts={{ model_service: true }}
        onOpenSettings={() => {}}
      />,
    )
    expect(screen.getByText(/模型服务还没接上/)).toBeTruthy()

    await userEvent.click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() => {
      expect(server.calls.some(call => call.url === '/model/auto-setup' && call.method === 'POST')).toBe(true)
    })
    // 重试走的**不是** /model/reissue:那颗按钮的语义是"不管三七二十一重领一把",
    // 会绕过"他自己填了 Key 就别动"那条判据。
    expect(server.calls.some(call => call.url === '/model/reissue')).toBe(false)
  })

  it('只有这一条缺的时候,另外两条不跟着冒出来', () => {
    render(
      <NeedBar
        baseUrl="http://x"
        fetchImpl={fakeServer(snapshot()).fetchImpl}
        alerts={{ model_service: true }}
        onOpenSettings={() => {}}
      />,
    )
    expect(screen.queryByText(/还差一个授权/)).toBeNull()
    expect(screen.queryByText(/用自己的 DeepSeek Key,但还没填/)).toBeNull()
  })

  it('挂在工作台上:接上了(下一拍那一格变假)→ 这条消失', async () => {
    const state = snapshot({ setup_alerts: { model_service: true } })
    const { rerender } = render(<WorkbenchOverlay {...props(fakeServer(state).fetchImpl)} />)
    expect(await screen.findByText(/模型服务还没接上/)).toBeTruthy()

    const fixed = snapshot({ setup_alerts: { model_service: false } })
    rerender(<WorkbenchOverlay {...props(fakeServer(fixed).fetchImpl)} />)
    await waitFor(() => expect(screen.queryByText(/模型服务还没接上/)).toBeNull())
  })
})
