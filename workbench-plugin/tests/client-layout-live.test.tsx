/**
 * 卡 TM(2026-09-27):设置里切了自媒体布局,**界面要当场换过去**。
 *
 * 维护者原话:「在设置里切换自媒体布局,压根没有切换布局成功。」根因见
 * `src/client/layoutAdopt.ts` 的文件头:切模板这条路服务端全做对了(写盘 + 下一拍
 * `/state.layout` 就是新排布),而页面**只在第一次**读一次 `/state.layout`,之后
 * 每秒轮询回来的布局一律丢掉 —— 模块标题、泳道那些读 `/state.template` 的东西都变了,
 * 只有「模块怎么排」一格没动。
 *
 * 这一份对着**渲染出来的模块盒子**(`[data-module-box]`)验,不是对着内部 state ——
 * 「切了就要看得见」这句话只有这么验才算验过。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkbenchOverlay, type MinimalWebSocket, type WorkbenchOverlayProps } from '../src/client/Workbench.tsx'
import { createWorkbenchStore } from '../src/client/store.ts'
import type { WorkbenchLayout, WorkbenchState } from '../src/protocol.ts'
import { UNUSED_STANDARD_PROPS } from './helpers/standardProps.ts'

afterEach(cleanup)

function fakeWebSocket(): (url: string) => MinimalWebSocket {
  return () => ({ onmessage: null, onclose: null, close: () => {} })
}

/** 做产品那套里的一条:随手记在最后。 */
const BEFORE: WorkbenchLayout = {
  modules: [
    { id: 'slot', order: 0, basis_pct: 42, row: 0 },
    { id: 'notes', order: 1, basis_pct: 24, row: 1 },
  ],
  butler: { corner: 'br', min: false },
}

/** 切到自媒体运营之后那套:多出「选题池」(todo)与「发布计划」(publish)两格。 */
const AFTER: WorkbenchLayout = {
  modules: [
    { id: 'slot', order: 0, basis_pct: 30, row: 0 },
    { id: 'todo', order: 1, basis_pct: 14, row: 1 },
    { id: 'publish', order: 2, basis_pct: 12, row: 1 },
    { id: 'notes', order: 3, basis_pct: 24, row: 2 },
  ],
  butler: { corner: 'br', min: false },
}

function snapshot(layout: WorkbenchLayout): WorkbenchState {
  return {
    agents: [],
    sessions: [],
    quota: {},
    now: '2026-09-27T13:00:00+08:00',
    stale: false,
    layout,
    dock: { stack: [{ key: 'claude', label: 'Claude', running: true, current: true }] },
  }
}

/**
 * `/state` 前两拍回切之前那份,之后回切之后那份 —— 模拟「他在设置里点了确定切换」。
 * POST 一律记下来(这份用例里不该有任何 `/layout` 的 POST)。
 */
function switchingFetch(posts: string[]) {
  let reads = 0
  return vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url)
    if (init?.method === 'POST') {
      posts.push(path)
      return { ok: true, json: async () => ({ ok: true }) }
    }
    if (path.endsWith('/state')) {
      reads += 1
      return { ok: true, json: async () => snapshot(reads <= 2 ? BEFORE : AFTER) }
    }
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

function boxes(): string[] {
  return [...document.querySelectorAll('[data-module-box]')]
    .map(el => el.getAttribute('data-module-box') ?? '')
}

describe('服务端换了布局(切模板 / 回退 / 说一句话改布局),界面当场跟上', () => {
  it('★ 切模板之后新排布的模块真的出现在屏上,不用刷新页面', async () => {
    const posts: string[] = []
    render(<WorkbenchOverlay {...props(switchingFetch(posts))} />)

    // 打开那一刻:还是切之前那套,没有「选题池」。
    await waitFor(() => expect(boxes()).toContain('notes'))
    expect(boxes()).not.toContain('todo')

    // 他点了「确定切换」→ 服务端写盘 → 下一拍 /state.layout 就是新排布。
    await waitFor(() => {
      expect(boxes()).toContain('todo')
      expect(boxes()).toContain('publish')
    })

    // 期间页面一次都没有把自己手里那份布局 POST 回去(否则就是把刚切好的模板覆盖掉)。
    expect(posts.filter(one => one.endsWith('/layout'))).toEqual([])
  })
})
