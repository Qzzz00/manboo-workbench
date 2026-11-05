import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkbenchOverlay, type MinimalWebSocket, type WorkbenchOverlayProps } from '../src/client/Workbench.tsx'
import { RESET_LAYOUT_LABEL } from '../src/client/TopBar.tsx'
import { CONFIRMS } from '../src/client/ui/index.tsx'
import { createWorkbenchStore } from '../src/client/store.ts'
import type { WorkbenchLayout, WorkbenchProject, WorkbenchState } from '../src/protocol.ts'
import { UNUSED_STANDARD_PROPS } from './helpers/standardProps.ts'

afterEach(cleanup)

/**
 * 悬停高亮 v1 起 WorkbenchOverlay 会开一条 WS 订 /live——测试必须喂一个假类,不然会退回
 * 全局 WebSocket 真的去连 baseUrl(真机实测踩过:会连到 Ben 本机正在跑的真实工作台服务)。
 * 这份文件不测悬停高亮,给个什么都不做的空壳就够。
 */
function fakeWebSocket(): (url: string) => MinimalWebSocket {
  return () => ({ onmessage: null, onclose: null, close: () => {} })
}

function snapshot(over: Partial<WorkbenchState> = {}): WorkbenchState {
  return {
    agents: [
      { id: 'dsh', online: true, connected: true, waiting: 1, running: 1 },
      { id: 'claude', online: true, connected: true, waiting: 0, running: 0 },
      { id: 'codex', online: true, connected: true, waiting: 0, running: 2 },
      { id: 'kimi', online: false, connected: false, waiting: 0, running: 0 },
    ],
    sessions: [],
    quota: {},
    now: '2026-08-18T10:03:00+08:00',
    stale: false,
    // 2026-09-11:事务官档露出时右下角浮窗隐藏(功能并进了那一档)。这份文件里的用例
    // 绝大多数要看的是浮窗本身,默认给一扇在台前的窗,让浮窗露着;要测事务官档的
    // 去 tests/client-pure-mode.test.tsx / client-dock.test.tsx。
    dock: dockWithCurrent(),
    ...over,
  }
}

/**
 * W4:「有一扇原生窗在台前」的 dock 快照——先例见 tests/client-dock.test.tsx 的
 * dockWithCurrent。dock 缺省或叠上没有任何窗在台前会被判定成 butlerActive(事务官选中,
 * 槽体整个不挂载、改渲染 iframe),这份文件里有用例要看到槽体本身(.ben-wb__slot-body)
 * 真的挂载,跟 dock 内容本身无关,补一个 current:true 的 tab 就够。
 */
function dockWithCurrent(): { stack: readonly { key: string, label: string, running: boolean, current: boolean }[] } {
  return { stack: [{ key: 'claude', label: 'Claude', running: true, current: true }] }
}

/** 假 fetch：/state 返回给定快照，/read 记录调用。 */
function fakeFetch(state: WorkbenchState, onRead?: (body: unknown) => void) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).endsWith('/read')) {
      onRead?.(JSON.parse(String(init?.body)))
      return { ok: true, json: async () => ({ ok: true }) }
    }
    return { ok: true, json: async () => state }
  }) as unknown as typeof fetch
}

/** 假 fetch：/state 返回给定快照，任何 POST 都原样记录 { url, body }。 */
function fakeFetchRecording(state: WorkbenchState, calls: { url: string, body: unknown }[]) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      calls.push({ url: String(url), body: init.body === undefined ? undefined : JSON.parse(String(init.body)) })
      return { ok: true, json: async () => ({ ok: true }) }
    }
    return { ok: true, json: async () => state }
  }) as unknown as typeof fetch
}

function props(options: {
  state?: WorkbenchState
  fetchImpl?: typeof fetch
} = {}): WorkbenchOverlayProps {
  const instance = createWorkbenchStore().create()
  const workspaceState = {
    items: [],
    phase: 'ready',
    archivedSessionIds: [],
    state: 'idle',
    error: null,
    baselinesReady: true,
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
    serviceFetch: options.fetchImpl ?? fakeFetch(options.state ?? snapshot()),
    servicePollMs: 0,
    serviceWebSocket: fakeWebSocket(),
  }
}

describe('顶条（PRD §5.1）', () => {
  it('Agent 登记表里的每一家都列出来(运行时新接上的一家也在,卡 Q),时间是 HH:MM;额度提词已抹掉(2026-08-25 版面重排)', async () => {
    const entry = (id: string, name: string) => ({ id, name, found: { how: 'sessions' as const, at: '', basis: '' }, sources: [], status: 'idle' as const, gaps: {}, sessions: [], counts: { running: 0, waiting: 0, unread: 0 } })
    render(<WorkbenchOverlay {...props({
      state: snapshot({
        quota: {
          dsh: { kind: 'balance', currency: 'CNY', total: '218.40', available: true },
          claude: { kind: 'quota', windows: [{ label: '5h', left_pct: 31 }] },
        },
        agent_registry: { entries: [entry('dsh', '事务官'), entry('claude', 'Claude'), entry('com.meta.endo', 'Muse')], asking: [], notices: [] },
      }),
    })} />)

    const topbar = await screen.findByRole('group', { name: '来源与额度概览' })
    for (const name of ['事务官', 'Claude', 'Muse']) {
      expect(within(topbar).getByText(name)).toBeTruthy()
    }
    // 不在登记表里的不画(不再是写死的四家)。
    expect(within(topbar).queryByText('Kimi')).toBeNull()
    // 2026-09-26 顶栏那一格是「公历 · 农历 · 时刻」(clockText.ts),时刻在末尾。
    expect(within(topbar).getByText(/ · 10:03$/)).toBeTruthy()
    // 2026-08-25 版面重排(Ben 定):余额与额度已经在「消耗数据」下面有了自己的模块
    // (QuotaPanel),同一个数字不在两处各说一遍——顶条那条提词整条抹掉。
    expect(within(topbar).queryByText(/218\.40/)).toBeNull()
    // 抹掉的是额度提词,不是整条顶条:存储/性能两格是这一版新搬进来的常显项。
    expect(within(topbar).getByRole('group', { name: '存储' })).toBeTruthy()
    expect(within(topbar).getByRole('group', { name: '性能' })).toBeTruthy()
    expect(within(topbar).getByRole('button', { name: '设置' })).toBeTruthy()
  })
})

// A3(2026-08-24 UX 波):会话区(PRD §5.3 原型)整块下线——原来这里的分组渲染/摘要显示/
// 已读标记覆盖已经没有对应 UI 了(职责转移给窗位叠标签上的彩色圆点徽章,见
// tests/client-dock.test.tsx「窗位叠标签的彩色圆点徽章」describe)。会话*数据*本身
// (state.sessions)不受影响,继续走既有上报路径。

describe('架构约束 C1：Agent 掉线看板不能死', () => {
  it('服务连不上时明示「Agent 掉线」，不白屏不报错弹窗', async () => {
    const failing = vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch
    render(<WorkbenchOverlay {...props({ fetchImpl: failing })} />)

    // role="status" 不止一处（窗口槽的「未接入」横幅也是），等到带"Agent 掉线"文案的那条出现。
    // A3 起这条提示挂在顶条正下方(见 Workbench.tsx),不再是会话区内部的一部分。
    await waitFor(() => {
      const match = screen.getAllByRole('status').find(el => el.textContent?.includes('Agent 掉线'))
      expect(match).toHaveTextContent('Agent 掉线')
    })
    // 界面主体仍在，没有因为服务挂了而整体消失。
    expect(screen.getByRole('heading', { name: '工作台' })).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('服务标记 stale 时同样明示', async () => {
    render(<WorkbenchOverlay {...props({
      state: snapshot({ stale: true }),
    })} />)

    await waitFor(() => {
      const match = screen.getAllByRole('status').find(el => el.textContent?.includes('Agent 掉线'))
      expect(match).toHaveTextContent('Agent 掉线')
    })
  })
})

describe('右列与底部条', () => {
  // 2026-08-25 版面重排:随手记从"前端内存一个数组"改成服务端落盘(server/notes.ts)。
  // 回车不再本地乐观插一条——真相以下一拍轮询回来的 state.notes 为准(跟 markRead/
  // confirmStatus 同一套"失败静默、服务端为准"的规矩),所以这条拆成两半各验一件事。
  it('随手记回车即收下：POST /note/add，输入框清空（PRD §5.5）', async () => {
    const calls: { url: string, body: unknown }[] = []
    const state = snapshot()
    render(<WorkbenchOverlay {...props({ state, fetchImpl: fakeFetchRecording(state, calls) })} />)

    const input = await screen.findByLabelText('记录灵感或当天安排')
    await userEvent.type(input, '展示台的铃声要不要分白天黑夜{Enter}')

    await waitFor(() => expect(calls.some(c => c.url.endsWith('/note/add'))).toBe(true))
    expect(calls.find(c => c.url.endsWith('/note/add'))?.body)
      .toEqual({ text: '展示台的铃声要不要分白天黑夜' })
    expect(input).toHaveValue('')
  })

  it('随手记不分类不打标签：服务端来的条目原样列出，每条可删（PRD §5.5）', async () => {
    const calls: { url: string, body: unknown }[] = []
    const state = snapshot({
      notes: [{ id: 'n1', text: '展示台的铃声要不要分白天黑夜', created_at: '2026-08-25T01:00:00.000Z' }],
    })
    render(<WorkbenchOverlay {...props({ state, fetchImpl: fakeFetchRecording(state, calls) })} />)

    expect(await screen.findByText('展示台的铃声要不要分白天黑夜')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: '删除随手记 展示台的铃声要不要分白天黑夜' }))
    await waitFor(() => expect(calls.some(c => c.url.endsWith('/note/remove'))).toBe(true))
    expect(calls.find(c => c.url.endsWith('/note/remove'))?.body).toEqual({ id: 'n1' })
  })

  // 2026-08-25 版面重排:「工作台自己的提议」这张卡连同「今晨快报」一起从组件条里删掉了
  // ——两张都是空壳(快报没有数据源、提议区只显示"证据不足"),由「DSH 入口与浮窗」那一
  // 单元在事务官浮窗里重建。中间这段真空不丢任何真实内容(设计稿 §四"快报与提议区的交接"),
  // 所以这条断言不是改口径,是它验的那块 UI 已经不在这里了,原地删掉而不是搬到别处将就。

  it('日结与 AI 悬浮窗都在，且悬浮窗标明不可改（PRD §9）', async () => {
    render(<WorkbenchOverlay {...props()} />)

    expect(await screen.findByText(/^日结/)).toBeTruthy()
    expect(screen.getByText(/AI 悬浮窗.*不可改/)).toBeTruthy()
  })
})

describe('自定义布局（spec D12：拖拽/收起/恢复默认，标题栏键盘入口；2026-08-25 起 projects/usage/quota/slot/notes/files）', () => {
  it('标题栏 Alt+↑ 后 DOM 顺序变化，且 debounce 后 POST /layout 带正确顺序', async () => {
    const calls: { url: string, body: unknown }[] = []
    render(<WorkbenchOverlay {...props({ fetchImpl: fakeFetchRecording(snapshot(), calls) })} />)

    // 默认布局自 2026-08-25 起是 projects / usage / quota / slot / notes / files。
    const headingsBefore = (await screen.findAllByRole('heading', { level: 2 })).map(h => h.textContent)
    // 默认布局:项目区/消耗数据 并排在顶部行,然后是余额、窗口槽、底部的随手记 + 系统文件夹。
    // 窗口槽上移一位换掉的是紧邻它的「余额 / 额度」。
    expect(headingsBefore.indexOf('窗口槽')).toBeGreaterThan(headingsBefore.indexOf('余额 / 额度'))

    const moveUp = screen.getByRole('heading', { name: '窗口槽' }).closest('.ben-wb__modhead')!
    fireEvent.keyDown(moveUp, { altKey: true, key: 'ArrowUp' })

    const headingsAfter = screen.getAllByRole('heading', { level: 2 }).map(h => h.textContent)
    expect(headingsAfter.indexOf('窗口槽')).toBeLessThan(headingsAfter.indexOf('余额 / 额度'))

    await waitFor(() => {
      expect(calls.some(c => c.url.endsWith('/layout'))).toBe(true)
    }, { timeout: 2000 })

    const layoutCall = calls.find(c => c.url.endsWith('/layout'))
    const body = layoutCall?.body as { layout: WorkbenchLayout }
    const slotOrder = body.layout.modules.find(m => m.id === 'slot')?.order
    const quotaOrder = body.layout.modules.find(m => m.id === 'quota')?.order
    expect(slotOrder).toBeLessThan(quotaOrder as number)
  })

  /**
   * 2026-10-13:这一条原来验的是「收起项目区(含 stale 项目)后,项目名上浮到顶条下的
   * 固定通知行」。那条通知行退休了 —— 维护者看着真机截图问「顶部这个黄色框是啥意思」,
   * 那个框里只有一个项目名,一个字不说为什么。理由与"要让收起的信号继续说话该接在哪儿"
   * 记在 src/client/layout.ts 原 hoistedAlerts 那一处。
   *
   * 现在钉的是**收起这条路本身没变**:点了收起,那一格走了、还原钮出现,顶上不多出任何
   * 横条。渲染层的完整那一份在 tests/client-hoisted-alert-bar-gone-20261013.test.tsx。
   */
  it('收起项目区(含 stale 项目)后:只剩那颗还原钮,顶上不多出一条横条', async () => {
    const staleProject: WorkbenchProject = {
      id: 'aiboo', name: 'Aiboo', stage: 'MVP 开发', links: [], session_count: 0, idle: false,
      status: { text: '旧的', review: 'confirmed', author: '你', updated_at: '2026-08-18T00:00:00.000Z', stale: true },
    }
    const state = snapshot({
      projects: { projects: [staleProject], pending: [], scan_errors: [], scanned_at: '2026-08-18T00:00:00.000Z' },
    })
    const { container } = render(<WorkbenchOverlay {...props({ state })} />)

    const collapse = await screen.findByRole('button', { name: '项目区 收起' })
    await userEvent.click(collapse)

    expect(await screen.findByRole('button', { name: '项目区 展开' })).toBeTruthy()
    expect(screen.queryByRole('status', { name: '收起模块的提醒' })).toBeNull()
    expect(container.querySelector('.ben-wb__fixedalerts')).toBeNull()
  })

  /**
   * 2026-08-25:「收起」按钮的图标版被静默改回了文字版。
   *
   * 来龙去脉:图标那次改动(08eee5a)是内联在 Workbench.tsx 里的,而「地基」重构
   * (c38dce5)是从**不含它**的版本切出 ModuleBox.tsx 的,合流(e93ab76)时按
   * "内联块取一侧"解冲突就把它吃掉了——不报错、测试也不红,只有 Ben 看出来。
   *
   * 这个按钮的样式是 22×22 的固定方块(style.ts 的 .ben-wb__modbtns button),
   * 两个汉字塞不进去必然挤成上下两行,而四个模块头共用这一个组件,一犯就是四处一起犯。
   * 所以这里钉死:可访问名仍是「XX 收起」(给屏幕阅读器),但**按钮里必须是图标不是文字**。
   */
  it('模块头的「收起」是图标,不是两个汉字(22×22 的方按钮塞不下,会挤成两行)', async () => {
    render(<WorkbenchOverlay {...props()} />)

    const collapse = await screen.findByRole('button', { name: '项目区 收起' })
    expect(collapse.querySelector('svg')).toBeTruthy()
    expect(collapse.textContent).toBe('')
    // 鼠标悬停仍要说得出这是干嘛的——图标不自带语义。
    expect(collapse).toHaveAttribute('title', '收起')
  })

  it('"恢复默认布局"把顺序还原', async () => {
    render(<WorkbenchOverlay {...props()} />)

    const header = (await screen.findByRole('heading', { name: '窗口槽' })).closest('.ben-wb__modhead')!
    fireEvent.keyDown(header, { altKey: true, key: 'ArrowUp' })
    let headings = screen.getAllByRole('heading', { level: 2 }).map(h => h.textContent)
    expect(headings.indexOf('窗口槽')).toBeLessThan(headings.indexOf('余额 / 额度'))

    await userEvent.click(screen.getByRole('button', { name: RESET_LAYOUT_LABEL }))
    const ask = screen.getByRole('dialog', { name: CONFIRMS.restoreLayout.title })
    await userEvent.click(within(ask).getByRole('button', { name: CONFIRMS.restoreLayout.confirm }))
    headings = screen.getAllByRole('heading', { level: 2 }).map(h => h.textContent)
    expect(headings.indexOf('余额 / 额度')).toBeLessThan(headings.indexOf('窗口槽'))
  })

  it('模块盒子化 W-B(真机反馈)：拖拽底边手柄调高 → basis 实时变化,debounce 后 POST /layout 带新值', async () => {
    // .ben-wb__body(模块列容器)量出的高度是 Δpct 换算的分母——jsdom 不做真实布局,
    // 统一 mock 成固定 1000px,数学好算:ΔY=200 / 1000 = +20pct。
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, width: 800, height: 1000, top: 0, left: 0, right: 800, bottom: 1000, toJSON() {},
    } as DOMRect)
    const calls: { url: string, body: unknown }[] = []
    render(<WorkbenchOverlay {...props({ fetchImpl: fakeFetchRecording(snapshot(), calls) })} />)

    const handle = await screen.findByLabelText('随手记 调整高度')
    fireEvent.pointerDown(handle, { clientY: 100, pointerId: 1 })
    fireEvent.pointerMove(handle, { clientY: 300, pointerId: 1 }) // 起点 100 → 300,ΔY=200
    fireEvent.pointerUp(handle, { pointerId: 1 })

    await waitFor(() => {
      expect(calls.some(c => c.url.endsWith('/layout'))).toBe(true)
    }, { timeout: 2000 })

    const layoutCall = calls.find(c => c.url.endsWith('/layout'))
    const body = layoutCall?.body as { layout: WorkbenchLayout }
    // 2026-08-25 版面重排后,默认布局里随手记起点 24,+20pct → 44(在 8–70 clamp 区间内)。
    expect(body.layout.modules.find(m => m.id === 'notes')?.basis_pct).toBe(44)
  })

  it('模块盒子化 W-B：拖拽过程中不同 pointerId 的事件被忽略(比如触屏多指误触)', async () => {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, width: 800, height: 1000, top: 0, left: 0, right: 800, bottom: 1000, toJSON() {},
    } as DOMRect)
    const calls: { url: string, body: unknown }[] = []
    render(<WorkbenchOverlay {...props({ fetchImpl: fakeFetchRecording(snapshot(), calls) })} />)

    const handle = await screen.findByLabelText('随手记 调整高度')
    fireEvent.pointerDown(handle, { clientY: 100, pointerId: 1 })
    fireEvent.pointerMove(handle, { clientY: 900, pointerId: 2 }) // 不同 pointerId,应被忽略
    fireEvent.pointerUp(handle, { pointerId: 1 })

    // 给 debounce 一点时间落定;没有 /layout 请求说明没有任何一次 move 真的生效过。
    await new Promise(resolve => setTimeout(resolve, 900))
    expect(calls.some(c => c.url.endsWith('/layout'))).toBe(false)
  })

  it('抓手可见化(真机反馈"为什么还没实现")：常显一根圆角短杠,拖拽期间 data-dragging=true,松手后归 false', async () => {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, width: 800, height: 1000, top: 0, left: 0, right: 800, bottom: 1000, toJSON() {},
    } as DOMRect)
    render(<WorkbenchOverlay {...props()} />)

    const handle = await screen.findByLabelText('随手记 调整高度')
    // 短杠是常显的子元素,不是靠 hover 才挂载出来的东西。
    expect(handle.querySelector('.ben-wb__mod-handle-grip')).not.toBeNull()
    expect(handle.getAttribute('data-dragging')).toBe('false')
    // F3(review):鼠标悬停给个原生 tooltip,aria-label(屏幕阅读器用)不受影响。
    expect(handle.getAttribute('title')).toBe('拖动调整高度')

    fireEvent.pointerDown(handle, { clientY: 100, pointerId: 1 })
    expect(handle.getAttribute('data-dragging')).toBe('true')

    fireEvent.pointerMove(handle, { clientY: 150, pointerId: 1 })
    expect(handle.getAttribute('data-dragging')).toBe('true') // 拖拽过程中持续为 true

    fireEvent.pointerUp(handle, { pointerId: 1 })
    expect(handle.getAttribute('data-dragging')).toBe('false')
  })

  it('拖拽调高不受相邻模块显隐影响：目标模块下方的模块被收起时,抓手照常生效', async () => {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, width: 800, height: 1000, top: 0, left: 0, right: 800, bottom: 1000, toJSON() {},
    } as DOMRect)
    const calls: { url: string, body: unknown }[] = []
    const state = snapshot({
      layout: {
        modules: [
          { id: 'projects', order: 0, basis_pct: 34 },
          { id: 'slot', order: 1, basis_pct: 54 },
          { id: 'notes', order: 2, basis_pct: 8, hidden: true }, // 窗口槽下方的模块被收起
        ],
        butler: { corner: 'br', min: false },
      },
    })
    render(<WorkbenchOverlay {...props({ fetchImpl: fakeFetchRecording(state, calls) })} />)

    // 收起的模块不该再有自己的抓手。
    await waitFor(() => expect(screen.queryByLabelText('随手记 调整高度')).toBeNull())

    const handle = await screen.findByLabelText('窗口槽 调整高度')
    fireEvent.pointerDown(handle, { clientY: 100, pointerId: 1 })
    fireEvent.pointerMove(handle, { clientY: 200, pointerId: 1 }) // ΔY=100 → +10pct
    fireEvent.pointerUp(handle, { pointerId: 1 })

    await waitFor(() => {
      expect(calls.some(c => c.url.endsWith('/layout'))).toBe(true)
    }, { timeout: 2000 })
    const layoutCall = calls.find(c => c.url.endsWith('/layout'))
    const body = layoutCall?.body as { layout: WorkbenchLayout }
    expect(body.layout.modules.find(m => m.id === 'slot')?.basis_pct).toBe(64)
  })
})

// A3+A4(2026-08-24 UX 波):"会话区点击激活应用"(点会话行/「人找我」chip 发 /activate)
// 整块下线——会话区连同它的可点行、PeopleChips 一起随 SessionFeed 停用移除了,
// handleActivate/handleSessionOpen 也随之从 Workbench.tsx 删掉(没有任何 UI 再调用它们)。
// 现在打开一个应用只有一条路:把它的窗口拖进窗位(A2 自愈认领);已经在窗位叠里的应用
// 靠标签本身切换(POST /dock/switch,覆盖见 tests/client-dock.test.tsx「窗位叠标签栏」)。
// IM 未读的展示位置变成窗位叠标签上的中性灰徽章(纯信息展示,不可点),覆盖见
// tests/client-dock.test.tsx「窗位叠标签的彩色圆点徽章」describe。

describe('顶条·存储/性能（spec §3 组件条定案；2026-08-25 版面重排后搬到顶条常显）', () => {
  it('machine 正常采样 → 存储/性能两格都渲染出数值', async () => {
    const state = snapshot({
      machine: { disk_pct: 62, disk_free_gb: 180, mem_gb: 16, cpu_idle_pct: 54, sampled_at: '2026-08-20T00:00:00.000Z' },
    })
    render(<WorkbenchOverlay {...props({ state })} />)

    const storage = await screen.findByRole('group', { name: '存储' })
    expect(within(storage).getByText('62% · 剩 180G')).toBeTruthy()

    const performance = screen.getByRole('group', { name: '性能' })
    expect(within(performance).getByText('54% 空闲 · 16G')).toBeTruthy()
  })

  it('disk_pct >= 95 → 存储格带告警态', async () => {
    const state = snapshot({
      machine: { disk_pct: 97, disk_free_gb: 16, mem_gb: 16, cpu_idle_pct: 54, sampled_at: '2026-08-20T00:00:00.000Z' },
    })
    render(<WorkbenchOverlay {...props({ state })} />)

    const storage = await screen.findByRole('group', { name: '存储' })
    expect(storage).toHaveAttribute('data-alert', 'true')
  })

  it('machine 为 { error } → 两格都显示"未接入:<原因>"，不编数(D13)', async () => {
    const state = snapshot({ machine: { error: 'df 失败' } })
    render(<WorkbenchOverlay {...props({ state })} />)

    const storage = await screen.findByRole('group', { name: '存储' })
    expect(within(storage).getByText('未接入:df 失败')).toBeTruthy()

    const performance = screen.getByRole('group', { name: '性能' })
    expect(within(performance).getByText('未接入:df 失败')).toBeTruthy()
  })
})

describe('事务官浮窗（spec D11，不可改清单第 1 条）', () => {
  // W4:这个 describe 块测的是 Butler 本体的 min/展开机制,跟"事务官标签是否选中"
  // (butlerActive/narrowForced)是两件事——不喂 dockWithCurrent() 的话 dock 缺省会被
  // 判定成 butlerActive,narrowForced 常真,盖住这里想测的 min 单独生效的路径。
  // 10-22 第三轮 2(维护者):浮窗里放的就是窗口槽里那页事务官(同一个组件两个入口),老那套话不再单独画;
  // 「全部暂停 / 试铃」在那一页的抽屉里,收成球时照旧在——球上右键 / 长按出这两键(不可改清单第 1 条:永远有叫停入口)。
  // 10-22 统筹验收回修:浮窗收成球后 DOM 里不再有直接的「全部暂停」键,用例锚到球右键菜单这一新交互。
  const headOf = (butler: HTMLElement) => butler.querySelector('.ben-wb__butler-head') as HTMLElement
  const openDrawer = async (butler: HTMLElement) => { await userEvent.click(within(butler).getByRole('button', { name: '事务官抽屉' })) }

  it('常驻显示;身里是那页事务官,老那套话不画', async () => {
    render(<WorkbenchOverlay {...props({ state: snapshot({ dock: dockWithCurrent() }) })} />)
    const butler = await screen.findByRole('complementary', { name: '事务官' })
    expect(within(butler).getByLabelText('事项收件箱')).toBeTruthy()
    expect(within(butler).queryByText('一切正常，没什么要说的')).toBeNull()
  })

  it('点标题栏收成球:那一页收起;球上右键出「全部暂停 / 试铃」且能点;再点球展开', async () => {
    const calls: { url: string, body: unknown }[] = []
    const state = snapshot({ dock: dockWithCurrent() })
    render(<WorkbenchOverlay {...props({ state, fetchImpl: fakeFetchRecording(state, calls) })} />)
    const butler = await screen.findByRole('complementary', { name: '事务官' })
    await userEvent.click(headOf(butler))
    expect(within(butler).queryByLabelText('事项收件箱')).toBeNull()
    // 两态设计:球面本身没有直接暴露的暂停键,入口在右键 / 长按菜单里(不可改清单第 1 条:永远有叫停入口)。
    expect(within(butler).queryByRole('button', { name: /全部暂停/ })).toBeNull()
    const ball = within(butler).getByRole('button', { name: /^事务官.*\(点一下展开\)$/ })
    fireEvent.contextMenu(ball)
    await userEvent.click(within(within(butler).getByRole('region', { name: '事务官叫停入口' })).getByRole('button', { name: '⏸ 全部暂停' }))
    await waitFor(() => expect(calls.some(c => c.url.endsWith('/pause'))).toBe(true))
    fireEvent.contextMenu(ball)
    await userEvent.click(within(within(butler).getByRole('region', { name: '事务官叫停入口' })).getByRole('button', { name: '🔔 试铃' }))
    await waitFor(() => expect(calls.some(c => c.url.endsWith('/ring/test'))).toBe(true))
    await userEvent.click(ball)
    expect(within(butler).getByLabelText('事项收件箱')).toBeTruthy()
  })

  it('那一页抽屉里的「⏸ 全部暂停」:fetch 收到 POST /pause', async () => {
    const calls: { url: string, body: unknown }[] = []
    const state = snapshot({ dock: dockWithCurrent() })
    render(<WorkbenchOverlay {...props({ state, fetchImpl: fakeFetchRecording(state, calls) })} />)
    const butler = await screen.findByRole('complementary', { name: '事务官' })
    await openDrawer(butler)
    await userEvent.click(within(butler).getByRole('button', { name: '⏸ 全部暂停' }))
    await waitFor(() => expect(calls.some(c => c.url.endsWith('/pause'))).toBe(true))
  })

  it('paused=true 时浮窗标红;抽屉里写「不控制 Agent 进程」、按钮变「▶ 恢复」', async () => {
    const state = snapshot({ paused: true, dock: dockWithCurrent() })
    render(<WorkbenchOverlay {...props({ state })} />)
    const butler = await screen.findByRole('complementary', { name: '事务官' })
    expect(butler).toHaveAttribute('data-paused', 'true')
    await openDrawer(butler)
    expect(within(butler).getByText(/不控制 Agent 进程/)).toBeTruthy()
    expect(within(butler).getByRole('button', { name: '▶ 恢复' })).toBeTruthy()
  })

  it('抽屉里「🔔 试铃」:fetch 收到 POST /ring/test;文案跟 /state.test_ringing 走', async () => {
    const calls: { url: string, body: unknown }[] = []
    const state = snapshot({ dock: dockWithCurrent() })
    const { unmount } = render(<WorkbenchOverlay {...props({ state, fetchImpl: fakeFetchRecording(state, calls) })} />)
    let butler = await screen.findByRole('complementary', { name: '事务官' })
    await openDrawer(butler)
    await userEvent.click(within(butler).getByRole('button', { name: '🔔 试铃' }))
    await waitFor(() => expect(calls.some(c => c.url.endsWith('/ring/test'))).toBe(true))
    unmount()
    render(<WorkbenchOverlay {...props({ state: snapshot({ test_ringing: true, dock: dockWithCurrent() }) })} />)
    butler = await screen.findByRole('complementary', { name: '事务官' })
    await openDrawer(butler)
    expect(within(butler).getByRole('button', { name: '🔕 停铃' })).toBeTruthy()
    expect(within(butler).queryByRole('button', { name: '🔔 试铃' })).toBeNull()
  })

  describe('A6:事务官浮窗可拖动', () => {
    it('没有 pos 时按 corner 定位(没有行内 left/top 覆盖)', async () => {
      render(<WorkbenchOverlay {...props()} />)
      const butler = await screen.findByRole('complementary', { name: '事务官' })

      expect(butler.getAttribute('data-corner')).toBe('br')
      expect(butler.style.left).toBe('')
      expect(butler.style.top).toBe('')
    })

    it('拖动标题栏 → 行内 left/top 按"抓取偏移量"实时更新(不传送),debounce 后 POST /layout 带 butler.pos', async () => {
      vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1000)
      vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(500)
      // M4(review 修复):浮窗当前的屏幕矩形——按下时不是按在左上角(50,60),而是按在
      // (90,100),即偏移量(40,40)。松手后浮窗左上角要跟着"移动的距离"走,不是瞬间
      // 传送到指针最终位置。
      vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
        left: 50, top: 60, width: 250, height: 80, right: 300, bottom: 140, x: 50, y: 60, toJSON() {},
      } as DOMRect)
      const calls: { url: string, body: unknown }[] = []
      const state = snapshot()
      render(<WorkbenchOverlay {...props({ state, fetchImpl: fakeFetchRecording(state, calls) })} />)

      const butler = await screen.findByRole('complementary', { name: '事务官' })
      const head = butler.querySelector('.ben-wb__butler-head') as HTMLElement

      fireEvent.pointerDown(head, { clientX: 90, clientY: 100, pointerId: 1, isPrimary: true, button: 0 })
      fireEvent.pointerMove(head, { clientX: 290, clientY: 200, pointerId: 1 }) // dx=200,dy=100,移动超过阈值
      fireEvent.pointerUp(head, { pointerId: 1 })

      // leftPx = 290 − 40(抓取偏移) = 250 → 250/1000 = 25%;topPx = 200 − 40 = 160 → 160/500 = 32%。
      expect(butler.style.left).toBe('25%')
      expect(butler.style.top).toBe('32%')
      expect(butler).toHaveAttribute('data-min', 'false') // 拖拽不该顺带触发"点击切换收小"

      await waitFor(() => {
        const layoutCall = calls.find(c => c.url.endsWith('/layout'))
        expect(layoutCall).toBeTruthy()
      }, { timeout: 2000 })
      const layoutCall = calls.find(c => c.url.endsWith('/layout'))
      const body = layoutCall?.body as { layout: { butler: { pos?: { x_pct: number, y_pct: number } } } }
      expect(body.layout.butler.pos).toEqual({ x_pct: 25, y_pct: 32 })
    })

    it('小幅抖动(< 4px)算点击，不算拖拽——正常触发"切换收小"', async () => {
      render(<WorkbenchOverlay {...props({ state: snapshot({ dock: dockWithCurrent() }) })} />)
      const butler = await screen.findByRole('complementary', { name: '事务官' })
      const head = butler.querySelector('.ben-wb__butler-head') as HTMLElement
      expect(within(butler).getByLabelText('事项收件箱')).toBeTruthy()

      fireEvent.pointerDown(head, { clientX: 100, clientY: 100, pointerId: 1, isPrimary: true, button: 0 })
      fireEvent.pointerMove(head, { clientX: 101, clientY: 100, pointerId: 1 }) // 1px,小于阈值
      fireEvent.pointerUp(head, { pointerId: 1 })
      fireEvent.click(head)

      expect(within(butler).queryByLabelText('事项收件箱')).toBeNull() // 收小生效了
    })

    it('M3:非主指针(isPrimary=false)或非左键(button!==0)按下不启动拖拽', async () => {
      vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1000)
      vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(500)
      render(<WorkbenchOverlay {...props()} />)
      const butler = await screen.findByRole('complementary', { name: '事务官' })
      const head = butler.querySelector('.ben-wb__butler-head') as HTMLElement

      // 第二根手指(多点触控):isPrimary=false。
      fireEvent.pointerDown(head, { clientX: 100, clientY: 100, pointerId: 2, isPrimary: false, button: 0 })
      fireEvent.pointerMove(head, { clientX: 400, clientY: 400, pointerId: 2 })
      fireEvent.pointerUp(head, { pointerId: 2 })
      expect(butler.style.left).toBe('')

      // 右键(button=2)。
      fireEvent.pointerDown(head, { clientX: 100, clientY: 100, pointerId: 3, isPrimary: true, button: 2 })
      fireEvent.pointerMove(head, { clientX: 400, clientY: 400, pointerId: 3 })
      fireEvent.pointerUp(head, { pointerId: 3 })
      expect(butler.style.left).toBe('')
    })
  })
})
