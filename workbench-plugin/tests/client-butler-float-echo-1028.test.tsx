/**
 * 2026-10-28,交接-1027「12:0x 气泡」那节的三条治本,对着渲染出来的 WorkbenchOverlay 验:
 *
 * 1. 回声按**内容**判:服务端 parseLayout 会按自己的字段顺序重建布局再存盘,`/state`
 *    回声回来的键序几乎必然跟页面 POST 出去的那份不同、内容一字没变。键序不同的回声
 *    必须被认成"自己刚发的"(keep),不能当成"别人改了"(adopt)—— adopt 会 setLayout,
 *    而 dirty 标记还在,800ms 去抖会跟着再 POST 一次:POST → 回声 → POST,就是维护者
 *    看到的「气泡一直在打开又收起」那个环的燃料之一。
 * 2. 开/收只认用户动作:角标(「等你 n 件」)连点两下是**同一个意图**连发,set 语义的
 *    展开只该动一次;旧写法"if (min) 翻一下"在同一份闭包上翻两下 = 原地没动,浮窗
 *    怎么点都不开。
 * 3. 夹位置只在渲染时算、不回写(组件级,见 tests/client-butler-view.test.tsx 的
 *    C2 那组;这份只管端到端的"渲染路径不产生第二次写盘")。
 *
 * 回声判据本身逐条钉在 tests/client-layout-adopt.test.ts。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkbenchOverlay, type MinimalWebSocket, type WorkbenchOverlayProps } from '../src/client/Workbench.tsx'
import { createWorkbenchStore } from '../src/client/store.ts'
import type { WorkbenchLayout, WorkbenchState } from '../src/protocol.ts'
import { UNUSED_STANDARD_PROPS } from './helpers/standardProps.ts'

afterEach(cleanup)

function fakeWebSocket(): (url: string) => MinimalWebSocket {
  return () => ({ onmessage: null, onclose: null, close: () => {} })
}

/** 打开那一刻服务端那份:随手记在最后,事务官收成球。 */
const BEFORE: WorkbenchLayout = {
  modules: [
    { id: 'slot', order: 0, basis_pct: 42, row: 0 },
    { id: 'notes', order: 1, basis_pct: 24, row: 1 },
  ],
  butler: { corner: 'br', min: true },
}

/** 切模板之后那套:多出「选题池」——真变了内容的那一种回声。 */
const AFTER: WorkbenchLayout = {
  modules: [
    { id: 'slot', order: 0, basis_pct: 42, row: 0 },
    { id: 'notes', order: 1, basis_pct: 24, row: 1 },
    { id: 'todo', order: 2, basis_pct: 24, row: 2 },
  ],
  butler: { corner: 'br', min: false },
}

function snapshot(layout: WorkbenchLayout, waiting?: WorkbenchState['waiting']): WorkbenchState {
  return {
    agents: [],
    sessions: [],
    quota: {},
    now: '2026-10-28T13:00:00+08:00',
    stale: false,
    layout,
    ...(waiting === undefined ? {} : { waiting }),
    dock: { stack: [{ key: 'claude', label: 'Claude', running: true, current: true }] },
  }
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

/** POST 请求体(解析好的 JSON)台账。 */
interface PostRecord { path: string, body: unknown }

function layoutPosts(posts: PostRecord[]): PostRecord[] {
  return posts.filter(one => one.path.endsWith('/layout'))
}

function butlerAside(): HTMLElement {
  return screen.getByLabelText('事务官')
}

describe('悬浮窗反复开合:回声按内容判 + 开/收只认用户动作', () => {
  it('★ 服务端重排键序的回声(内容没变)不当成别人改的:不二次写盘,min 也不翻回去', async () => {
    const posts: PostRecord[] = []
    let phase: 'before' | 'echo' | 'after' = 'before'
    let readsAfterExpand = 0
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url)
      if (init?.method === 'POST') {
        posts.push({ path, body: JSON.parse(String(init.body)) })
        // 我们自己的 POST 已被服务端"重建":下一步开始回键序重排过的同内容布局。
        if (path.endsWith('/layout')) phase = 'echo'
        return { ok: true, json: async () => ({ ok: true }) }
      }
      if (path.endsWith('/state')) {
        if (phase === 'before') return { ok: true, json: async () => snapshot(BEFORE) }
        readsAfterExpand += 1
        // 回声阶段拉长(~1s):期间只断言"没有第二次写盘",模板切换留到回声之后再发生。
        if (phase === 'echo' && readsAfterExpand <= 200) {
          // parseLayout 重建的形状:butler 在前、min 在 corner 前——内容一字不差。
          return {
            ok: true,
            json: async () => snapshot({
              butler: { min: false, corner: 'br' },
              modules: [
                { id: 'slot', order: 0, basis_pct: 42, row: 0 },
                { id: 'notes', order: 1, basis_pct: 24, row: 1 },
              ],
            } as unknown as WorkbenchLayout),
          }
        }
        // 回声认对之后,服务端那份又真变了一次(他在设置里切了模板)。
        phase = 'after'
        return { ok: true, json: async () => snapshot(AFTER) }
      }
      return { ok: false, status: 404, json: async () => ({}) }
    }) as unknown as typeof fetch

    render(<WorkbenchOverlay {...props(fetchImpl)} />)

    // 打开时是球(存档里 min: true)。
    await waitFor(() => expect(butlerAside().getAttribute('data-min')).toBe('true'))
    const ball = screen.getByRole('button', { name: /点一下展开/ })

    // 他点了一下球:展开。这一次用户动作会产生唯一一次"内容变了"的写盘。
    fireEvent.click(ball)
    await waitFor(() => expect(layoutPosts(posts).length).toBeGreaterThanOrEqual(1), { timeout: 4000 })
    expect((layoutPosts(posts)[0]!.body as { layout: WorkbenchLayout }).layout.butler.min).toBe(false)

    // 键序重排的回声到了:内容没变,不能当成别人改的——浮窗保持展开,整个回声阶段
    // (~1s,足够旧写法 false-adopt 后再去抖出第二次写盘)都不再有写盘。
    await new Promise(resolve => setTimeout(resolve, 1200))
    expect(butlerAside().getAttribute('data-min')).toBe('false')
    expect(layoutPosts(posts).length).toBe(1)

    // 此后服务端真变了内容(切模板):界面照旧要换过去(回声豁免不能豁免到连真变化都吞掉),
    // 事务官保持他刚展开的样子;这次 adopt 之后的回写是既有行为,内容是刚 adopt 的那份。
    await waitFor(() => expect(document.querySelector('[data-module-box="todo"]')).not.toBeNull(), { timeout: 4000 })
    expect(butlerAside().getAttribute('data-min')).toBe('false')
    await waitFor(() => expect(layoutPosts(posts).length).toBe(2), { timeout: 4000 })
    const second = (layoutPosts(posts)[1]!.body as { layout: WorkbenchLayout }).layout
    expect(second.modules.map(one => one.id)).toContain('todo')
    expect(second.butler.min).toBe(false)
  }, 20000)

  it('★ 角标连点两下 = 同一个"展开"意图连发:浮窗展开并保持,绝不翻回球(开/收只认用户动作)', async () => {
    const posts: PostRecord[] = []
    const waiting: WorkbenchState['waiting'] = {
      count: 1,
      items: [{ key: 'confirm:t-1', kind: 'confirm', verb: '验收', text: '有一件事等你验收' }],
    }
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url)
      if (init?.method === 'POST') {
        posts.push({ path, body: JSON.parse(String(init.body)) })
        return { ok: true, json: async () => ({ ok: true }) }
      }
      if (path.endsWith('/state')) return { ok: true, json: async () => snapshot(BEFORE, waiting) }
      return { ok: false, status: 404, json: async () => ({}) }
    }) as unknown as typeof fetch

    render(<WorkbenchOverlay {...props(fetchImpl)} />)

    // 球态 + 等你 1 件 → 角标在。
    const badge = await screen.findByRole('button', { name: /等你 1 件,点一下摊开/ })
    expect(butlerAside().getAttribute('data-min')).toBe('true')

    // 同一拍里连点两下:旧写法在同一份闭包上"翻转"两次 = 原地没动;正确行为是展开并保持。
    fireEvent.click(badge)
    fireEvent.click(badge)

    await waitFor(() => expect(butlerAside().getAttribute('data-min')).toBe('false'), { timeout: 4000 })
    // 意图落盘只有一次,而且是"展开"。
    await waitFor(() => expect(layoutPosts(posts).length).toBe(1), { timeout: 4000 })
    expect((layoutPosts(posts)[0]!.body as { layout: WorkbenchLayout }).layout.butler.min).toBe(false)
    // 多等一拍:没有第二次写盘,也没有翻回球。
    await new Promise(resolve => setTimeout(resolve, 1200))
    expect(butlerAside().getAttribute('data-min')).toBe('false')
    expect(layoutPosts(posts).length).toBe(1)
  }, 15000)
})
