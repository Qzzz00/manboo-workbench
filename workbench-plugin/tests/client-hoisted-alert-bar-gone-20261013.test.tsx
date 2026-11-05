/**
 * 顶上那条**只写着一个项目名**的琥珀横条:去掉了(2026-10-13,维护者看着真机截图
 * 「顶部这个黄色框是啥意思」→「我认为是去掉这个黄框和里面的内容」)。
 *
 * 那条横条是本插件自己画的 `.ben-wb__fixedalerts`(spec §4「收起必有通知」的最后一支,
 * 判据原来在 `client/layout.ts` 的 `hoistedAlerts`):项目区被收起时,把 stale 或
 * 「DDL 剩 <=1 天」的项目**名字**上浮一行。它只有名字、没有一个字说为什么 —— 真机上
 * 那一行就是三个字「工作台」。而 `daysLeftFromNow` 对**早就过去**的 DDL 回负数、同样
 * <=1,所以一条过期九天的 DDL 会把这条横条永久钉在屏幕顶上。
 *
 * 退休的理由与 sessions / widgets 两支一样(见 layout.ts 那一处的注释):**补偿的前提
 * 消失了** —— DDL / 排期这条信号有一个常显的主人,事务官浮窗按 `butlerConclusions`
 * 用整句话说,不看模块收没收起;而「把它展开」那颗键就在原来那条横条底下那一行。
 *
 * 这一份钉三件事:收起 + 过期 DDL + 另一个 stale 都在的那一刻**屏幕上没有这条横条**、
 * 展开那颗键原样在、样式表里不留孤规则。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkbenchOverlay, type MinimalWebSocket, type WorkbenchOverlayProps } from '../src/client/Workbench.tsx'
import { DEFAULT_LAYOUT, toggleHidden } from '../src/client/layout.ts'
import { STYLE } from '../src/client/style.ts'
import { createWorkbenchStore } from '../src/client/store.ts'
import type { WorkbenchProject, WorkbenchState } from '../src/protocol.ts'
import { UNUSED_STANDARD_PROPS } from './helpers/standardProps.ts'

afterEach(cleanup)

/** 维护者截图那一刻;下面那条 DDL 就是按它算成「过期九天」的。 */
const NOW_ISO = '2026-10-13T12:36:31+08:00'

function project(over: Partial<WorkbenchProject> & Pick<WorkbenchProject, 'id' | 'name'>): WorkbenchProject {
  return { stage: '待整理', links: [], session_count: 0, idle: false, ...over }
}

/** 真机 `/state` 那一份的形状:项目区收起 + 一个 DDL 早就过去的项目(名字正是「工作台」)。 */
function snapshot(): WorkbenchState {
  return {
    agents: [{ id: 'dsh', online: true, connected: true, waiting: 0, running: 0 }],
    sessions: [],
    quota: {},
    now: NOW_ISO,
    stale: false,
    layout: toggleHidden(DEFAULT_LAYOUT, 'projects'),
    projects: {
      projects: [
        project({ id: 'wb', name: '工作台', ddl: { date: '2026-10-04', title: 'Spotlight 报名截止' } }),
        project({
          id: 'lapis', name: 'Lapis',
          status: { text: '旧的', review: 'confirmed', author: '你', updated_at: NOW_ISO, stale: true },
        }),
      ],
      pending: [],
      scan_errors: [],
      scanned_at: NOW_ISO,
    },
  }
}

/** 见 client-notes-files.test.tsx 顶部注释:不喂假 WS 会真的去连 8791 端口。 */
function fakeWebSocket(): (url: string) => MinimalWebSocket {
  return () => ({ onmessage: null, onclose: null, close: () => {} })
}

/**
 * 只答 `/state`,别的一律 404(同 client-layout-live.test.tsx):拿同一份快照去答
 * `/first-run`、`/account` 会把页面推进别的形态,那就不是我们要看的那一屏了。
 */
function fakeFetch(state: WorkbenchState): typeof fetch {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return { ok: true, json: async () => ({ ok: true }) }
    if (String(url).endsWith('/state')) return { ok: true, json: async () => ({ ...state }) }
    return { ok: false, status: 404, json: async () => ({}) }
  }) as unknown as typeof fetch
}

function props(fetchImpl: typeof fetch): WorkbenchOverlayProps {
  const instance = createWorkbenchStore().create()
  const workspaceState = {
    items: [], phase: 'ready', archivedSessionIds: [], state: 'idle',
    error: null, baselinesReady: true, recentWorkspaceId: undefined,
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
    servicePollMs: 5,
    serviceWebSocket: fakeWebSocket(),
  }
}

/**
 * 等到**服务端那份布局真的套上了**为止。判据用那颗还原钮:它只有在"项目区已收起"
 * 这一份布局生效之后才在 —— 在它出现之前断言"没有那条横条"等于什么都没验到。
 */
async function waitForHiddenProjects(): Promise<HTMLElement> {
  await waitFor(
    () => expect(screen.getByRole('button', { name: '项目区 展开' })).toBeTruthy(),
    { timeout: 5000 },
  )
  return screen.getByRole('button', { name: '项目区 展开' })
}

describe('顶上那条只写项目名的琥珀横条', () => {
  it('项目区收起 + DDL 过期 + 另一个 stale:屏幕上没有那条横条', async () => {
    const { container } = render(<WorkbenchOverlay {...props(fakeFetch(snapshot()))} />)
    await waitForHiddenProjects()

    expect(container.querySelector('.ben-wb__fixedalerts')).toBeNull()
    expect(screen.queryByLabelText('收起模块的提醒')).toBeNull()
  })

  it('「把它展开」那条路一个字没动', async () => {
    render(<WorkbenchOverlay {...props(fakeFetch(snapshot()))} />)

    expect(await waitForHiddenProjects()).toBeTruthy()
  })

  it('样式表里不留孤规则:.ben-wb__fixedalerts 那两条跟着走了', () => {
    expect(STYLE).not.toContain('ben-wb__fixedalerts{')
    expect(STYLE).not.toContain('ben-wb__fixedalerts p{')
  })
})
