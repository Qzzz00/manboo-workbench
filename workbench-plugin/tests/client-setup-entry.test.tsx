/**
 * 「体检与修复」的入口(2026-09-17 卡 A 的三条路,当天晚些按拍板「三个环节分开」改掉两条)。
 *
 * 新规矩:
 * - **`setup_required` 不再让它自己弹出来**。第一次开机看到的第一屏是登录,不是一页体检
 *   (Ben:「用户可能都不知道要做什么」)。
 * - **顶栏那颗「初始化」没了**,入口只剩设置里那一行。
 * - 地址栏 `?setup=1` / `#setup` 留着:那是自己点名要开的,不是自动弹的。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TopBar } from '../src/client/TopBar.tsx'
import { WorkbenchOverlay, type MinimalWebSocket, type WorkbenchOverlayProps } from '../src/client/Workbench.tsx'
import { createWorkbenchStore } from '../src/client/store.ts'
import type { WorkbenchState } from '../src/protocol.ts'
import { UNUSED_STANDARD_PROPS } from './helpers/standardProps.ts'
import { GROUP, openGroup } from './settingsGroup.ts'

afterEach(cleanup)

const WIDGET = { valueText: '未接入', error: true, alert: false } as const

function snapshot(over: Partial<WorkbenchState> = {}): WorkbenchState {
  return { agents: [], sessions: [], quota: {}, now: '2026-09-17T10:00:00+08:00', stale: false, ...over }
}

/** 假 fetch:/state 回给定快照;/setup/status 回一份"什么都没装"的体检;账号与首次流程都没接。 */
function fakeFetch(state: WorkbenchState) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const reply = (body: unknown): Response => ({ ok: true, status: 200, json: async () => body }) as unknown as Response
    const miss = (): Response => ({ ok: false, status: 404, json: async () => ({ error: 'x' }) }) as unknown as Response
    if (String(url).endsWith('/setup/status')) {
      return reply({ items: [], all_ok: false, optional_pending: 0, checked_at: '2026-09-17T10:00:00.000Z' })
    }
    if (String(url).endsWith('/setup/apk.json')) return reply({ available: false, path: '/x' })
    if (String(url).includes('/account') || String(url).includes('/first-run')) return miss()
    if (String(url).includes('/config/')) return miss()
    if (init?.method === 'POST') return reply({ ok: true })
    return reply(state)
  }) as unknown as typeof fetch
}

function props(state: WorkbenchState): WorkbenchOverlayProps {
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
    serviceFetch: fakeFetch(state),
    servicePollMs: 0,
    serviceWebSocket: (): MinimalWebSocket => ({ onmessage: null, onclose: null, close: () => {} }),
  }
}

describe('顶栏', () => {
  it('那颗「初始化」已经没了 —— 体检与修复只从设置进', () => {
    render(<TopBar lamps={[]} now="10:00" storage={WIDGET} performance={WIDGET} onOpenSettings={() => {}} />)
    expect(screen.queryByRole('button', { name: '初始化' })).toBeNull()
    expect(screen.queryByRole('button', { name: '体检与修复' })).toBeNull()
    // 齿轮还在:那才是回去的路。
    expect(screen.getByRole('button', { name: '设置' })).toBeTruthy()
  })
})

describe('不再自动弹', () => {
  it('setup_required 为真也不自己出现(第一屏该是登录,不是一页体检)', async () => {
    render(<WorkbenchOverlay {...props(snapshot({ setup_required: true }))} />)
    await waitFor(() => expect(screen.getByLabelText('工作台')).toBeTruthy())
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(screen.queryByRole('dialog', { name: '体检与修复' })).toBeNull()
  })

  it('字段缺席(还没体检过)时同样什么都不弹', async () => {
    render(<WorkbenchOverlay {...props(snapshot())} />)
    await waitFor(() => expect(screen.getByLabelText('工作台')).toBeTruthy())
    expect(screen.queryByRole('dialog', { name: '体检与修复' })).toBeNull()
  })
})

describe('设置里那一行', () => {
  it('齿轮 → 「开始体检」把那一页叫出来(10-22 前那颗叫「打开体检与修复」)', async () => {
    render(<WorkbenchOverlay {...props(snapshot({ setup_required: true }))} />)
    await userEvent.click(await screen.findByRole('button', { name: '设置' }))
    // 2026-09-28(卡 SG):体检是"出了事才来"的地方,收进「高级」那一组。入口一个没少。
    await openGroup(GROUP.advanced)
    await userEvent.click(await screen.findByRole('button', { name: '开始体检' }))
    expect(await screen.findByRole('dialog', { name: '体检与修复' })).toBeTruthy()
  })
})
