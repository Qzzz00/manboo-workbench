/**
 * 事务官档与纯净模式(2026-09-11,Ben 拍板:「点到事务官的时候,就留中间一个圆球就好了,
 * 然后事项在旁边堆几个卡片」「纯净模式,就是全屏幕只有一个球,事项卡片都不留」)。
 *
 * 页面级用例,守的是接缝:
 * - 事务官档露出时右下角浮窗隐藏(它的功能并进了这一档),切到别的标签浮窗回来;
 * - 纯净模式 = 顶栏 + 一颗球:没有卡片、汇报条、输入框;点球临时展开,Esc 收回;
 * - pureMode 落在 layout 里(刷新后仍是纯净),切换不丢任何布局;
 * - 纯净模式下壳不再往窗口槽贴窗(/unsnap + /slot/rect {rect:null}),切回完整时重报矩形。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkbenchOverlay, type MinimalWebSocket, type WorkbenchOverlayProps } from '../src/client/Workbench.tsx'
import { createWorkbenchStore } from '../src/client/store.ts'
import { DEFAULT_LAYOUT } from '../src/client/layout.ts'
import type { WorkbenchLayout, WorkbenchState } from '../src/protocol.ts'
import { UNUSED_STANDARD_PROPS } from './helpers/standardProps.ts'

afterEach(cleanup)

/**
 * 2026-09-17:这个文件里「点球展开」两条用例被当作「已知假红」记了好几天,量下来根因是
 * **`waitFor` 的预算被一次长同步任务整个吃掉**,不是隔离脏、也不是产品代码有 bug。
 *
 * 量到的事实(探针见交接 docs/交接-0917-纯净模式用例抖动.md):
 * - 隔离是干净的:每条用例开头 `styles=0 nodes=3 bodyKids=0`,活着的
 *   `timeouts=0 intervals=0 MutationObserver=0`,window/document 上的监听也不增长
 *   —— `afterEach(cleanup)` 该做的都做了,上一条用例什么都没留下。
 * - 真正的开销是**一次不可中断的同步渲染**:`render()` 之后 `/state` 落地把界面切进纯净模式,
 *   这一拍要重渲整棵工作台树(含 13.8 万字符的内联 <style>),jsdom 里实测把主线程堵住
 *   **500~900 毫秒**(探针 5 毫秒一跳的 `setInterval` 在这段里只跳了 2~3 次,`maxGap` 就是
 *   这个量级);堵住期间 `waitFor` 的回调根本没机会跑。
 * - 而 testing-library 的 `asyncUtilTimeout` 默认只有 **1000 毫秒**:第一拍在 t≈1ms 跑一次
 *   (那时球还没出现,失败),然后线程被堵 500~900 毫秒,等回过神来预算已经见底
 *   —— 于是「一次重试都没有」。机器一忙(实测 load average 16 时报错时长 1.6~2.1 秒)就翻红。
 *   用 `-t` 单条跑必绿,只是因为同文件前面的用例没跑、那一拍堵得短(实测 180~260 毫秒)。
 *
 * 所以按实测放宽到 5 秒:约等于最坏那一拍(~0.9 秒,负载高时 ~2 秒)的 2.5~5 倍余量,
 * 同时给 vitest.config.ts 的 `testTimeout: 15_000` 留足空间。**只对这个文件生效**,
 * 全局默认值一个字没动。这不会遮住真 bug:断言错依然立即报,真卡死照样超时,只是晚几秒。
 *
 * 老实说一句边界:这个值是照「这台机器正常负载(load average 5 上下)」定的。实测在同时
 * 跑两套测试、load average 冲到 17 的病态负载下,那一拍堵了 6.8 秒,5 秒照样不够。真遇上
 * 先看是不是自己同时开了两份在跑,别顺手把这个数调大 —— 再大就会撞上 15 秒的 testTimeout。
 */
configure({ asyncUtilTimeout: 5_000 })

function fakeWebSocket(): (url: string) => MinimalWebSocket {
  return () => ({ onmessage: null, onclose: null, close: () => {} })
}

function snapshot(over: Partial<WorkbenchState> = {}): WorkbenchState {
  return {
    agents: [],
    sessions: [],
    quota: {},
    now: '2026-09-11T10:03:00+08:00',
    stale: false,
    ...over,
  }
}

/** 有一扇原生窗在台前:浮窗该露出、收件箱不渲染的那一档。 */
function dockWithCurrent() {
  return { stack: [{ key: 'claude', label: 'Claude', running: true, current: true }] }
}
/** 叠非空但没人在台前 = 选中「事务官」标签。 */
function dockButlerPicked() {
  return { stack: [{ key: 'claude', label: 'Claude', running: true, current: false }] }
}

/** 假 fetch:/state 返回给定快照(可按轮次换),任何 POST 都原样记录 { url, body }。 */
function fakeFetchRecording(states: WorkbenchState | WorkbenchState[], calls: { url: string, body: unknown }[]) {
  const list = Array.isArray(states) ? states : [states]
  let polls = 0
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      calls.push({ url: String(url), body: init.body === undefined ? undefined : JSON.parse(String(init.body)) })
      return { ok: true, json: async () => ({ ok: true }) }
    }
    const state = list[Math.min(polls, list.length - 1)] as WorkbenchState
    polls++
    return { ok: true, json: async () => state }
  }) as unknown as typeof fetch
}

function props(options: { state?: WorkbenchState | WorkbenchState[], calls?: { url: string, body: unknown }[] } = {}): WorkbenchOverlayProps {
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
    serviceFetch: fakeFetchRecording(options.state ?? snapshot(), options.calls ?? []),
    servicePollMs: 0,
    serviceWebSocket: fakeWebSocket(),
  }
}

const layoutPosts = (calls: { url: string, body: unknown }[]) =>
  calls.filter(c => c.url.endsWith('/layout')).map(c => (c.body as { layout: WorkbenchLayout }).layout)

async function settledPureOrb() {
  // jsdom 没有 Canvas backend,初始化 effect 会替换初始 hit button。
  // 等实际 fallback 就绪并重新查询,避免点击已脱离 DOM 的初始按钮。
  await waitFor(() => expect(screen.getByRole('button', { name: /^事务官:/ })).toHaveClass('ben-wb__orb'))
  return screen.getByRole('button', { name: /^事务官:/ })
}

describe('事务官只在悬浮窗里(2026-10-27 已拍板:去掉独立的事务官标签页;PRD §9 浮窗与叫停入口一直在)', () => {
  it('★台前有没有应用窗,浮窗都露着;窗口槽里不再挂一份事务官页,全页只有一份', async () => {
    const first = snapshot({ dock: dockButlerPicked() })
    const later = snapshot({ dock: dockWithCurrent() })
    let switched = false
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return { ok: true, json: async () => ({ ok: true }) }
      return { ok: true, json: async () => (switched ? later : first) }
    }) as unknown as typeof fetch
    const p = props()
    render(<WorkbenchOverlay {...p} serviceFetch={fetchImpl} servicePollMs={50} />)

    await waitFor(() => expect(within(screen.getByLabelText('事务官')).getByLabelText('事项收件箱')).toBeVisible())
    expect(screen.getAllByLabelText('事项收件箱')).toHaveLength(1)
    switched = true
    await waitFor(() => expect(screen.getByLabelText('事务官')).toBeVisible())
    expect(screen.getAllByLabelText('事项收件箱')).toHaveLength(1)
  })

  it('「全部暂停」「试铃」在悬浮窗那一页的抽屉里各打各的路由', async () => {
    const calls: { url: string, body: unknown }[] = []
    render(<WorkbenchOverlay {...props({ state: snapshot({ dock: dockButlerPicked() }), calls })} />)
    const inbox = await waitFor(() => within(screen.getByLabelText('事务官')).getByLabelText('事项收件箱'))
    await userEvent.click(within(inbox).getByRole('button', { name: '事务官抽屉' }))
    await userEvent.click(within(inbox).getByRole('button', { name: '⏸ 全部暂停' }))
    await userEvent.click(within(inbox).getByRole('button', { name: '🔔 试铃' }))
    await waitFor(() => {
      expect(calls.some(c => c.url.endsWith('/pause'))).toBe(true)
      expect(calls.some(c => c.url.endsWith('/ring/test'))).toBe(true)
    })
  })
})

describe('纯净模式 = 整屏只有一颗球', () => {
  it('★点顶栏「纯净」→ 正文只剩球与「执行 n · 排队 m · 等你 k」;卡片、汇报条、输入框、窗口槽、日结条、浮窗全部不显示;开关落盘 pureMode:true', async () => {
    const calls: { url: string, body: unknown }[] = []
    const state = snapshot({
      dock: dockWithCurrent(),
      tasks: { tasks: [], sprints: [], modules: [], project_meta: [] },
      butler_inbox: { items: [] },
    })
    render(<WorkbenchOverlay {...props({ state, calls })} />)
    await screen.findByRole('button', { name: '纯净' })
    expect(screen.getByLabelText('事务官')).toBeVisible()

    await userEvent.click(screen.getByRole('button', { name: '纯净' }))

    const orb = await settledPureOrb()
    expect(orb).toBeVisible()
    expect(screen.getByText('执行 0 · 排队 0 · 等你 0')).toBeVisible()
    expect(screen.queryByLabelText('当前聚焦事项')).toBeNull()
    expect(screen.queryByLabelText('事项收纳')).toBeNull()
    expect(screen.queryByLabelText('交给事务官一件事')).toBeNull()
    expect(screen.queryByRole('status', { name: '汇报条' })).toBeNull()
    expect(document.querySelector('.ben-wb__body')).not.toBeVisible()
    expect(document.querySelector('.ben-wb__footbar')).not.toBeVisible()
    expect(screen.getByLabelText('事务官')).not.toBeVisible()
    // 顶栏还在:四家状态、设置、开关(现在写「完整」)。
    const topbar = screen.getByRole('group', { name: '来源与额度概览' })
    expect(within(topbar).getByRole('button', { name: '设置' })).toBeVisible()
    expect(within(topbar).getByRole('button', { name: '完整' })).toBeVisible()
    // 模块没卸载,只是不显示。
    expect(document.querySelector('.ben-wb__slot-body')).not.toBeNull()

    await waitFor(() => expect(layoutPosts(calls).at(-1)?.pureMode).toBe(true), { timeout: 3000 })
  })

  it('★点球临时展开当前聚焦事项、事项收纳与输入框;查看不确认,确认使用任务身份;Esc 收回,仍是纯净', async () => {
    const calls: { url: string, body: unknown }[] = []
    const state = snapshot({
      dock: dockWithCurrent(),
      layout: { ...DEFAULT_LAYOUT, pureMode: true },
      tasks: { tasks: [], sprints: [], modules: [], project_meta: [] },
      butler_inbox: { items: [{ id: 'confirm:t1', kind: 'confirm', title: '黄历接上了', status: 'confirm', task_id: 't1' }] },
    })
    render(<WorkbenchOverlay {...props({ state, calls })} />)
    const orb = await settledPureOrb()
    // 确认通知由粒子容器表达,不依赖 jsdom 是否已切换成旧 Orb fallback。
    expect(orb.closest('.ben-wb__particle-orb')).toHaveAttribute('data-notice', 'confirmation')
    expect(screen.getByText('执行 0 · 排队 0 · 等你 1')).toBeVisible()
    expect(screen.queryByLabelText('当前聚焦事项')).toBeNull()
    expect(screen.queryByLabelText('事项收纳')).toBeNull()

    await userEvent.click(orb)
    // 还没点开哪一件:没有聚焦那一张(卡 M 起它是点开一件时才摊出来的一层,不再是球下一个空框)。
    expect(screen.queryByLabelText('当前聚焦事项')).toBeNull()
    const storage = screen.getByLabelText('事项收纳')
    expect(storage).toBeVisible()
    const confirmation = within(storage).getByRole('region', { name: '待确认' })
    expect(within(confirmation).getByText('黄历接上了')).toBeVisible()
    expect(screen.getByLabelText('交给事务官一件事')).toBeVisible()
    // 展开是临时的:正文模块仍然不显示。
    expect(document.querySelector('.ben-wb__body')).not.toBeVisible()

    await userEvent.click(within(confirmation).getByRole('button', { name: '查看事项:黄历接上了' }))
    const focus = screen.getByRole('dialog', { name: '当前聚焦事项' })
    expect(within(focus).getByRole('heading', { name: '黄历接上了' })).toBeVisible()
    expect(calls.filter(c => c.url.endsWith('/task/move'))).toEqual([])
    expect(screen.getByText('执行 0 · 排队 0 · 等你 1')).toBeVisible()
    await userEvent.click(within(focus).getByRole('button', { name: '确认收下:黄历接上了' }))
    await waitFor(() => expect(calls.filter(c => c.url.endsWith('/task/move')).map(c => c.body))
      .toEqual([{ id: 't1', status: 'done' }]))
    // 回执成功不改写服务端快照,等你数量仍由原始状态决定。
    expect(state.butler_inbox?.items[0]?.status).toBe('confirm')
    expect(screen.getByText('执行 0 · 排队 0 · 等你 1')).toBeVisible()

    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByLabelText('当前聚焦事项')).toBeNull())
    expect(screen.queryByLabelText('事项收纳')).toBeNull()
    expect(screen.queryByLabelText('交给事务官一件事')).toBeNull()
    expect(screen.getByRole('button', { name: /^事务官:/ })).toBeVisible()
    expect(screen.getByRole('button', { name: '完整' })).toBeVisible()
  })

  it('展开后点空白处也收回', async () => {
    const state = snapshot({ dock: dockWithCurrent(), layout: { ...DEFAULT_LAYOUT, pureMode: true } })
    render(<WorkbenchOverlay {...props({ state })} />)
    await userEvent.click(await settledPureOrb())
    expect(screen.queryByLabelText('当前聚焦事项')).toBeNull()
    expect(screen.getByLabelText('事项收纳')).toBeVisible()
    await userEvent.click(screen.getByTestId('ben-wb-pure-backdrop'))
    await waitFor(() => expect(screen.queryByLabelText('当前聚焦事项')).toBeNull())
    expect(screen.queryByLabelText('事项收纳')).toBeNull()
    expect(screen.queryByLabelText('交给事务官一件事')).toBeNull()
    expect(screen.getByRole('button', { name: /^事务官:/ })).toBeVisible()
    expect(screen.getByRole('button', { name: '完整' })).toBeVisible()
  })

  it('★刷新后仍是纯净:/state.layout.pureMode 为 true 就直接进纯净', async () => {
    const state = snapshot({ dock: dockWithCurrent(), layout: { ...DEFAULT_LAYOUT, pureMode: true } })
    render(<WorkbenchOverlay {...props({ state })} />)
    await screen.findByRole('button', { name: /^事务官:/ })
    expect(screen.getByRole('button', { name: '完整' })).toBeVisible()
    expect(document.querySelector('.ben-wb__body')).not.toBeVisible()
  })

  it('★点「完整」全部回来,布局与切之前一致(切换不丢任何布局)', async () => {
    const calls: { url: string, body: unknown }[] = []
    const custom: WorkbenchLayout = {
      ...DEFAULT_LAYOUT,
      modules: DEFAULT_LAYOUT.modules.map(m => (m.id === 'notes' ? { ...m, hidden: true, basis_pct: 30 } : m)),
      butler: { corner: 'tl', min: true },
      pureMode: true,
    }
    const state = snapshot({ dock: dockWithCurrent(), layout: custom })
    render(<WorkbenchOverlay {...props({ state, calls })} />)
    await userEvent.click(await screen.findByRole('button', { name: '完整' }))

    expect(document.querySelector('.ben-wb__body')).toBeVisible()
    expect(document.querySelector('.ben-wb__footbar')).toBeVisible()
    expect(screen.getByLabelText('事务官')).toBeVisible()
    // 纯净那颗全屏球退场;收起的悬浮球(min)照旧在,它的读屏名也以「事务官:」开头,所以按纯净球的类名认。
    expect(screen.queryAllByRole('button', { name: /^事务官:/ }).filter(b => b.classList.contains('ben-wb__orb'))).toEqual([])
    expect(screen.getByRole('button', { name: '纯净' })).toBeVisible()
    await waitFor(() => expect(layoutPosts(calls).length).toBeGreaterThan(0), { timeout: 3000 })
    const { pureMode: _off, ...rest } = layoutPosts(calls).at(-1) as WorkbenchLayout
    const { pureMode: _on, ...before } = custom
    expect(_off).toBe(false)
    expect(rest).toEqual(before)
  })

  it('纯净模式没有卡片时也不显示汇报条(它是「话」,纯净只留球)', async () => {
    const state = snapshot({ dock: dockWithCurrent(), layout: { ...DEFAULT_LAYOUT, pureMode: true } })
    render(<WorkbenchOverlay {...props({ state })} />)
    await screen.findByRole('button', { name: /^事务官:/ })
    expect(screen.queryByRole('status', { name: '汇报条' })).toBeNull()
  })
})

describe('纯净模式下壳不贴合:窗口槽不显示时不能再往上贴 App 窗口', () => {
  beforeEach(() => { window.history.replaceState(null, '', '/?ben-workbench=app') })
  afterEach(() => { window.history.replaceState(null, '', '/') })

  it('★切到纯净 → POST /unsnap 与 /slot/rect {rect:null};切回完整 → 重新上报槽体矩形', async () => {
    const calls: { url: string, body: unknown }[] = []
    const state = snapshot({ dock: dockWithCurrent() })
    render(<WorkbenchOverlay {...props({ state, calls })} />)
    await screen.findByRole('button', { name: '纯净' })
    // 完整模式下先报过一次矩形(既有行为)。
    await waitFor(() => expect(calls.some(c => c.url.endsWith('/slot/rect')
      && (c.body as { rect: unknown }).rect !== null)).toBe(true))
    const unsnapBefore = calls.filter(c => c.url.endsWith('/unsnap')).length

    await userEvent.click(screen.getByRole('button', { name: '纯净' }))
    await waitFor(() => {
      expect(calls.filter(c => c.url.endsWith('/unsnap')).length).toBeGreaterThan(unsnapBefore)
      expect(calls.some(c => c.url.endsWith('/slot/rect') && (c.body as { rect: unknown }).rect === null)).toBe(true)
    })
    const before = calls.length

    await userEvent.click(screen.getByRole('button', { name: '完整' }))
    await waitFor(() => {
      const after = calls.slice(before)
      expect(after.some(c => c.url.endsWith('/slot/rect') && (c.body as { rect: unknown }).rect !== null)).toBe(true)
    })
  })

  it('纯净模式下一次都不报带矩形的 /slot/rect(display:none 量出来的 0 矩形不是真几何)', async () => {
    const calls: { url: string, body: unknown }[] = []
    const state = snapshot({ dock: dockWithCurrent(), layout: { ...DEFAULT_LAYOUT, pureMode: true } })
    render(<WorkbenchOverlay {...props({ state, calls })} />)
    await screen.findByRole('button', { name: /^事务官:/ })
    await new Promise(r => setTimeout(r, 300))
    expect(calls.some(c => c.url.endsWith('/slot/rect') && (c.body as { rect: unknown }).rect !== null)).toBe(false)
  })
})
