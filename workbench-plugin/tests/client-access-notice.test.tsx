/**
 * 「还差辅助功能」那一句 —— 三种文案(2026-09-18,分支 fix/landscape-firstrun-glitches)。
 *
 * Ben 09-18 真机截图第三处:顶上横幅说「还差一个授权:辅助功能」,而**系统设置里
 * 「工作台」那个开关是开着的** —— 那条记录对应的是换固定证书之前那一份壳
 * (TCC 认签名不认路径,见 docs/交接-0918-壳稳定签名.md)。照着横幅再去开一次开关,
 * 一点用都没有。
 *
 * 这份用例钉三件事,每一件都是 Ben 在屏幕上看得见的:
 *   ① 没授权过 → 还是今天这句「还差一个授权:辅助功能」,一个字没改;
 *   ② 旧记录   → 换成「把它移除(选中按 −)再重新添加……以后更新不会再要」;
 *   ③ 已授权   → 一条都不出。
 * 外加一条:**窗位槽里那行红字跟横幅是同一句**,而且各带一颗「去授权」。
 * (2026-10-23:files 那一格改成 Graphify 图谱,不依赖辅助功能 —— 那条旧「系统文件夹也贴不了
 * Finder」的断言迁成「图谱不索取 Finder 权限」的反例,红字只剩窗位槽一处。)
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NeedBar } from '../src/client/NeedBar.tsx'
import { WorkbenchOverlay, type MinimalWebSocket, type WorkbenchOverlayProps } from '../src/client/Workbench.tsx'
import { createWorkbenchStore } from '../src/client/store.ts'
import { accessNotice } from '../src/client/accessNotice.ts'
import type { WorkbenchState } from '../src/protocol.ts'
import { UNUSED_STANDARD_PROPS } from './helpers/standardProps.ts'

afterEach(cleanup)

const STALE_HEAD = '系统设置里的『工作台』还是旧版本的记录'

function snapshot(over: Partial<WorkbenchState> = {}): WorkbenchState {
  return { agents: [], sessions: [], quota: {}, now: '2026-09-18T10:00:00+08:00', stale: false, ...over }
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
    if (path === '/setup/status') return ok({ items: [], all_ok: true, optional_pending: 0, checked_at: '2026-09-18T10:00:00.000Z' })
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

// ───────────────────────────────────────────────────────────────────────────
describe('算哪一句(accessNotice,纯函数)', () => {
  it('还没体检过(alerts 缺席)→ 什么都不说。「没查过」不是「差着」', () => {
    expect(accessNotice(undefined)).toBeUndefined()
  })

  it('★第三种:已授权 → 一条都不出', () => {
    expect(accessNotice({ accessibility: false })).toBeUndefined()
  })

  it('★第一种:真没给过 → 还是今天那一句,一个字没改', () => {
    expect(accessNotice({ accessibility: true, accessibility_kind: 'unauthorized' })?.line)
      .toBe('还差一个授权:辅助功能 —— 替你摆窗位、拖窗认领、把话送进 Claude/Codex 都要它。点「去授权」会弹系统框,点「打开系统设置」把「工作台」打开就行。')
  })

  it('★第二种:旧记录 → 说的是"移除再重新添加",而且把"以后更新不会再要"讲出来', () => {
    const notice = accessNotice({ accessibility: true, accessibility_kind: 'stale_record' })
    expect(notice?.kind).toBe('stale_record')
    expect(notice?.line).toContain(STALE_HEAD)
    expect(notice?.line).toContain('选中按 −')
    expect(notice?.line).toContain('/Applications/工作台.app')
    expect(notice?.line).toContain('以后更新不会再要')
  })

  it('老服务端(没有 accessibility_kind 这个字段)→ 按"真没给过"读,界面一个字不变', () => {
    expect(accessNotice({ accessibility: true })?.kind).toBe('unauthorized')
  })
})

// ───────────────────────────────────────────────────────────────────────────
describe('顶上那条横幅', () => {
  it('旧记录那一种:横幅换成那段话,「去授权」照旧打开系统设置那一页', async () => {
    const server = fakeServer(snapshot())
    render(
      <NeedBar
        baseUrl="http://x"
        fetchImpl={server.fetchImpl}
        alerts={{ accessibility: true, deepseek_key: false, accessibility_kind: 'stale_record' }}
        onOpenSettings={() => {}}
      />,
    )
    expect(screen.getByText(new RegExp(STALE_HEAD))).toBeTruthy()
    expect(screen.queryByText(/还差一个授权:辅助功能/)).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: '去授权' }))
    await waitFor(() => {
      expect(server.calls.some(call => call.url === '/setup/open' && call.body?.pane === 'accessibility')).toBe(true)
    })
  })

  it('点过「去授权」回来(窗口重新拿到焦点)仍然自己复查一次 —— 这条纪律搬家之后没丢', async () => {
    const server = fakeServer(snapshot())
    render(
      <NeedBar
        baseUrl="http://x"
        fetchImpl={server.fetchImpl}
        alerts={{ accessibility: true, deepseek_key: false, accessibility_kind: 'stale_record' }}
        onOpenSettings={() => {}}
      />,
    )
    window.dispatchEvent(new Event('focus'))
    expect(server.calls.some(call => call.url === '/setup/status')).toBe(false)
    await userEvent.click(screen.getByRole('button', { name: '去授权' }))
    window.dispatchEvent(new Event('focus'))
    await waitFor(() => expect(server.calls.some(call => call.url === '/setup/status')).toBe(true))
  })
})

// ───────────────────────────────────────────────────────────────────────────
describe('窗位槽里那行红字(图谱那一格不索取 Finder 权限)', () => {
  /** 壳连上了、只是没授权 —— 这才是那句话该出现的场合。 */
  function unauthorizedState(kind: 'unauthorized' | 'stale_record'): WorkbenchState {
    return snapshot({
      helper: { connected: true, authorized: false, reason: '辅助功能未授权' },
      dock: { stack: [{ key: 'claude', label: 'Claude', running: true, current: true }] },
      setup_alerts: { accessibility: true, deepseek_key: false, accessibility_kind: kind },
    })
  }

  it('★跟横幅同一句,而且窗位槽那行红字各带一颗「去授权」(任务卡:两处同一句)', async () => {
    const state = unauthorizedState('stale_record')
    const server = fakeServer(state)
    const { container } = render(<WorkbenchOverlay {...props(server.fetchImpl)} />)
    await screen.findByRole('heading', { name: '工作台' })

    // ★ 2026-10-23(卡「系统文件夹改成Graphify图谱」):files 那一格本体换成 GraphView,
    // 不依赖辅助功能 —— 旧「贴不了 Finder」那一句随 Finder 贴合一起删了,这一格**不申请**
    // 辅助功能授权。要授权的红字只剩窗位槽那一处,跟横幅同一句。
    await waitFor(() => {
      expect(container.querySelectorAll('.ben-wb__accessnote').length).toBe(1)
    })
    const note = container.querySelector('.ben-wb__accessnote') as HTMLElement
    // 那一处就是窗位槽的「未接入」,后半句跟横幅一模一样,带一颗「去授权」。
    expect(note.textContent?.split(':')[0]).toBe('未接入')
    expect(note.textContent).toContain(STALE_HEAD)
    expect(note.querySelector('.ben-wb__accessnote-go')?.textContent).toBe('去授权')
    // 顶上那条横幅说的是同一句 —— 两处一共两句一模一样的话。
    expect(screen.getAllByText(new RegExp(STALE_HEAD)).length).toBe(2)
    // 图谱那一格不索取 Finder 权限:全页一句「贴不了 Finder」都不剩,也不调旧的 pin 入口。
    expect(screen.queryByText(/贴不了 Finder/)).toBeNull()
    expect(server.calls.some(call => call.url === '/files/pin')).toBe(false)
  })

  it('壳压根没连上(App 没在跑)→ 仍旧照实说 helper.reason,不把授权那段话摆在这儿', async () => {
    const state = snapshot({
      helper: { connected: false, authorized: false, reason: '工作台.app 没在运行' },
      dock: { stack: [{ key: 'claude', label: 'Claude', running: true, current: true }] },
      setup_alerts: { accessibility: true, deepseek_key: false, accessibility_kind: 'unauthorized' },
    })
    const { container } = render(<WorkbenchOverlay {...props(fakeServer(state).fetchImpl)} />)
    await screen.findByRole('heading', { name: '工作台' })

    await waitFor(() => {
      expect(screen.getByText('未接入:工作台.app 没在运行')).toBeTruthy()
    })
    expect(container.querySelectorAll('.ben-wb__accessnote').length).toBe(0)
  })

  it('已授权:红字与横幅一起消失', async () => {
    const state = snapshot({
      helper: { connected: true, authorized: true },
      dock: { stack: [{ key: 'claude', label: 'Claude', running: true, current: true }] },
      setup_alerts: { accessibility: false, deepseek_key: false },
    })
    const { container } = render(<WorkbenchOverlay {...props(fakeServer(state).fetchImpl)} />)
    await screen.findByRole('heading', { name: '工作台' })
    await waitFor(() => expect(container.querySelector('.ben-wb__needbar')).toBeNull())
    expect(container.querySelectorAll('.ben-wb__accessnote').length).toBe(0)
    expect(screen.queryByRole('button', { name: '去授权' })).toBeNull()
  })
})
