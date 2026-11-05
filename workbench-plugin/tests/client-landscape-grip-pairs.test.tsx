/**
 * 横屏的分隔把手**一条边界只有一根**(2026-09-27,卡 LY)。
 *
 * 现场:维护者在新 Air(0.4.50,自媒体布局)截图 ——「每个模块组件之间的小横线居然是
 * 成对出现了」。右侧栏三格竖排(账号 / 选题池 / 发布计划)的每一条界缝上、窗口槽与
 * 底部一排之间,都能看到上下挨着的两根短横线;底部一排各格底下还各有一根。
 *
 * 根因不在模板数据里:两根里有一根是 `SplitHandle`(2026-09-18 给横屏四条边界补的),
 * 另一根是 `ModuleBox` 自己那根底边抓手(竖屏时代的调高入口,每个模块盒子无条件画一根)。
 * 做产品那套模板右侧栏只有项目区一格,成对的只剩「窗口槽 | 底部一排」那一处,
 * 混在两块大区之间不显眼,所以一直没被报出来 —— **两套模板的渲染路径完全相同**。
 *
 * 这一份数的是**个数**:横屏下 `.ben-wb__split` 的根数恰好等于相邻关系的条数,
 * 而 `.ben-wb__mod-handle` 一根都没有。竖屏那一版一根都不能少 —— 那里模块底边那根
 * 抓手就是那条边界本身,是唯一的调高入口。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, configure, render, screen, waitFor } from '@testing-library/react'
import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkbenchOverlay, type MinimalWebSocket, type WorkbenchOverlayProps } from '../src/client/Workbench.tsx'
import { createWorkbenchStore } from '../src/client/store.ts'
import type { ProjectsState, TemplateStateView, WorkbenchState } from '../src/protocol.ts'
import { PRODUCT_TEMPLATE, type WorkbenchTemplate } from '../src/templates.ts'
import { loadStarterLayoutTemplate } from './helpers/starterLayer.ts'
import { templateStateView } from '../src/server/templateStore.ts'
import { UNUSED_STANDARD_PROPS } from './helpers/standardProps.ts'
const OPS_TEMPLATE = await loadStarterLayoutTemplate()

configure({ asyncUtilTimeout: 5_000 })

const REAL_WIDTH = window.innerWidth
const REAL_HEIGHT = window.innerHeight

function setViewport(width: number, height: number): void {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true, writable: true })
  Object.defineProperty(window, 'innerHeight', { value: height, configurable: true, writable: true })
  act(() => { window.dispatchEvent(new Event('resize')) })
}

afterEach(() => {
  cleanup()
  setViewport(REAL_WIDTH, REAL_HEIGHT)
  window.history.replaceState(null, '', '/')
})

function fakeWebSocket(): (url: string) => MinimalWebSocket {
  return () => ({ onmessage: null, onclose: null, close: () => {} })
}

/** 一个项目 / 账号(假数据):项目区那一格空着也画,补一条只是让它有内容。 */
function onePro(name: string): ProjectsState {
  return {
    projects: [{ id: 'p-1', name, stage: '项目策划', links: [], session_count: 0, idle: false }],
    pending: [],
    scan_errors: [],
    scanned_at: '2026-09-27T02:00:00.000Z',
  }
}

/** 某个模板那一份 `/state`:布局取模板自己的两份排布,`template` 由服务端那个纯函数现拼。 */
function stateOf(template: WorkbenchTemplate): WorkbenchState {
  const view: TemplateStateView = templateStateView(template, { butlerCwd: '/Users/example/工作', hasBackup: true })
  return {
    agents: [{ id: 'dsh', online: true, connected: true, waiting: 0, running: 0 }],
    sessions: [],
    quota: {},
    now: '2026-09-27T10:03:00+08:00',
    stale: false,
    dock: { stack: [{ key: 'codex', label: 'ChatGPT', running: true, current: true }] },
    projects: onePro('某个号'),
    template: view,
    layout: {
      modules: template.portrait.map(m => ({ ...m })),
      butler: { corner: 'br', min: false },
      landscape: { modules: template.landscape.map(m => ({ ...m })) },
    },
  }
}

function props(state: WorkbenchState): WorkbenchOverlayProps {
  const instance = createWorkbenchStore().create()
  const workspaceState = {
    items: [], phase: 'ready', archivedSessionIds: [], state: 'idle', error: null,
    baselinesReady: true, recentWorkspaceId: undefined,
  }
  return {
    useStore: selector => selector(instance.getSnapshot()),
    actions: instance.actions,
    useWorkspaces: selector => selector(workspaceState as never),
    useSessions: selector => selector({} as never),
    ...UNUSED_STANDARD_PROPS,
    openWorkspace: async () => {},
    openSession: () => {},
    serviceFetch: vi.fn(async () => ({ ok: true, json: async () => state })) as unknown as typeof fetch,
    servicePollMs: 0,
    serviceWebSocket: fakeWebSocket(),
  }
}

/**
 * 这个模板的横屏排布里有几条相邻关系 —— **从模板数据数出来,不写死**:
 *   ① 左栏 | 窗口槽(窗口槽在就有);
 *   ② 窗口槽 | 右侧栏(两边都有才算);
 *   ③ 右侧栏里上下相邻(n 格 = n-1 条);
 *   ④ 上半条 | 底部一排(底部一排非空才有);
 *   ⑤ 底部一排里左右相邻(n 格 = n-1 条)。
 * 收起的格子不参与(渲染也不画它们)。
 */
function adjacencies(template: WorkbenchTemplate): number {
  const shown = template.landscape.filter(m => m.hidden !== true)
  const slot = shown.some(m => m.id === 'slot')
  const deck = shown.filter(m => m.region === 'deck').length
  const side = shown.filter(m => m.id !== 'slot' && m.region !== 'deck').length
  return (slot ? 1 : 0)
    + (slot && side > 0 ? 1 : 0)
    + Math.max(0, side - 1)
    + (deck > 0 ? 1 : 0)
    + Math.max(0, deck - 1)
}

function grips(): { splits: number, modHandles: number } {
  const root = document.querySelector('.ben-wb')
  return {
    splits: root?.querySelectorAll('.ben-wb__split').length ?? -1,
    modHandles: root?.querySelectorAll('.ben-wb__mod-handle').length ?? -1,
  }
}

// ───────────────────────────────────────────────────────────────────────────
describe('横屏:一条边界一根把手', () => {
  it('自媒体布局(运营模板)横屏 —— 把手根数 = 相邻关系条数,模块自己那根底边抓手一根都不画', async () => {
    setViewport(2560, 1440)
    render(<WorkbenchOverlay {...props(stateOf(OPS_TEMPLATE))} />)
    await screen.findByRole('heading', { name: '选题池' })
    await waitFor(() => expect(grips().splits).toBeGreaterThan(0))

    // 运营模板横屏:右侧栏四格(账号/选题池/今天的待办/发布计划,2026-10-12 多了今天的待办)+ 底部三格
    // = 1(左栏|槽)+1(槽|右栏)+3(右栏上下)+1(上|下)+2(底部之间)= 8 条。
    expect(adjacencies(OPS_TEMPLATE)).toBe(8)
    expect(grips()).toEqual({ splits: 8, modHandles: 0 })
  })

  it('做产品布局横屏 —— 同一条规则,一根不多一根不少', async () => {
    setViewport(2560, 1440)
    render(<WorkbenchOverlay {...props(stateOf(PRODUCT_TEMPLATE))} />)
    await screen.findByRole('heading', { name: '随手记' })
    await waitFor(() => expect(grips().splits).toBeGreaterThan(0))

    // 做产品横屏:右侧栏只有项目区一格 + 底部四格 = 1+1+0+1+3 = 6 条。
    expect(adjacencies(PRODUCT_TEMPLATE)).toBe(6)
    expect(grips()).toEqual({ splits: 6, modHandles: 0 })
  })

  it('横屏下每一根都是同一个组件:role=separator + 一颗短杠', async () => {
    setViewport(2560, 1440)
    render(<WorkbenchOverlay {...props(stateOf(OPS_TEMPLATE))} />)
    await screen.findByRole('heading', { name: '选题池' })
    await waitFor(() => expect(grips().splits).toBeGreaterThan(0))

    for (const node of document.querySelectorAll('.ben-wb__split')) {
      expect(node.getAttribute('role')).toBe('separator')
      expect(node.querySelector('.ben-wb__split-grip')).not.toBeNull()
    }
  })
})

describe('竖屏:模块底边那根抓手照旧 —— 那里它就是那条边界', () => {
  it('自媒体布局竖屏:每个画出来的模块都还有自己那根调高抓手', async () => {
    setViewport(1440, 2560)
    render(<WorkbenchOverlay {...props(stateOf(OPS_TEMPLATE))} />)
    await screen.findByRole('heading', { name: '选题池' })

    const shown = OPS_TEMPLATE.portrait.filter(m => m.hidden !== true).length
    await waitFor(() => expect(grips().modHandles).toBe(shown))
    expect(screen.getByLabelText('选题池 调整高度')).toBeTruthy()
  })
})
