import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { inShellApp } from '../src/client/shell.ts'
import { SceneBar } from '../src/client/SceneBar.tsx'
import { WorkbenchOverlay, type MinimalWebSocket, type WorkbenchOverlayProps } from '../src/client/Workbench.tsx'
import { createWorkbenchStore } from '../src/client/store.ts'
import type { SceneView, WorkbenchState } from '../src/protocol.ts'
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

function snapshot(overrides: Partial<WorkbenchState> = {}): WorkbenchState {
  return {
    agents: [],
    sessions: [],
    quota: {},
    now: '2026-08-21T10:03:00+08:00',
    stale: false,
    ...overrides,
  }
}

/**
 * W4:「有一扇原生窗在台前」的 dock 快照——这份文件里一批 SlotZone 相关用例本来跟 dock
 * 内容毫不相干,只是恰好用 snapshot({}) 的默认值(dock 缺省)。W4 把"dock 缺省或叠上
 * 没有任何窗在台前"接成了 butlerActive(事务官选中,槽体整个不挂载、改渲染 iframe)——
 * 这些用例要测的是 SlotZone 自己的展示逻辑,得先确保槽体真的挂载了才测得到,补一个
 * current:true 的 tab 就够(先例:tests/client-dock.test.tsx 的 dockWithCurrent)。
 */
function dockWithCurrent(): { stack: readonly { key: string, label: string, running: boolean, current: boolean }[] } {
  return { stack: [{ key: 'claude', label: 'Claude', running: true, current: true }] }
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
  const fetchImpl = options.fetchImpl ?? (vi.fn(async () => ({
    ok: true, json: async () => options.state ?? snapshot(),
  })) as unknown as typeof fetch)
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
    serviceWebSocket: fakeWebSocket(),
  }
}

describe('inShellApp', () => {
  it('search 带 ben-workbench=app → true;hash 带也 true;都不带 false', () => {
    expect(inShellApp('?ben-workbench=app', '')).toBe(true)
    expect(inShellApp('', '#ben-workbench=app')).toBe(true)
    expect(inShellApp('?x=1', '#y')).toBe(false)
  })

  it('DSH 路由"路径+查询串"形态的 hash(#/route?ben-workbench=app)同样判真', () => {
    expect(inShellApp('', '#/some/route?ben-workbench=app')).toBe(true)
    expect(inShellApp('', '#/some/route?foo=1&ben-workbench=app')).toBe(true)
  })

  /**
   * 评审补(2026-08-25):hash 那一半以前是子串匹配(includes),`ben-workbench=applesauce`
   * 这种 value 只是碰巧以 'app' 开头的合法 hash 会被误判成壳内页面——改成 URLSearchParams
   * 精确解析 key=value 之后,这类误判不该再出现。search 那一半本来就走 URLSearchParams,
   * 一并用同一个用例覆盖,确认两边行为对称。
   */
  it('value 只是碰巧以 "app" 开头(如 applesauce)→ 不误判为壳内页面', () => {
    expect(inShellApp('', '#ben-workbench=applesauce')).toBe(false)
    expect(inShellApp('', '#/route?ben-workbench=applesauce')).toBe(false)
    expect(inShellApp('?ben-workbench=applesauce', '')).toBe(false)
  })
})

describe('SceneBar', () => {
  const scenes: SceneView[] = [
    { id: 'work', name: '干活', app_count: 2, saved_at: '2026-08-21T10:00:00Z' },
    { id: 'talk', name: '沟通', app_count: 0 },
  ]

  it('未保存场景「恢复」禁用并标「未保存」', () => {
    render(<SceneBar baseUrl="http://x" scenes={scenes} fetchImpl={vi.fn() as unknown as typeof fetch} />)

    expect(screen.getByText('未保存')).toBeTruthy()
    expect(screen.getByRole('button', { name: '恢复 沟通' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '恢复 干活' })).not.toBeDisabled()
  })

  it('点「恢复 干活」POST /scene/restore 并逐应用展示报告,失败行带 reason', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(String(url)).toBe('http://x/scene/restore')
      return {
        ok: true,
        json: async () => ({
          ok: false,
          apps: [
            { app: 'term', ok: true },
            { app: 'wechat', ok: false, reason: '窗口数不符…' },
          ],
        }),
      }
    }) as unknown as typeof fetch

    render(<SceneBar baseUrl="http://x" scenes={scenes} fetchImpl={fetchImpl} />)
    await userEvent.click(screen.getByRole('button', { name: '恢复 干活' }))

    expect(await screen.findByText('term ✓')).toBeTruthy()
    expect(await screen.findByText('wechat:窗口数不符…')).toBeTruthy()
  })

  it('点「覆盖保存」失败时 reason 原样显示(如「辅助功能未授权」)', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(String(url)).toBe('http://x/scene/save')
      return { ok: true, json: async () => ({ ok: false, reason: '辅助功能未授权' }) }
    }) as unknown as typeof fetch

    render(<SceneBar baseUrl="http://x" scenes={scenes} fetchImpl={fetchImpl} />)
    await userEvent.click(screen.getByRole('button', { name: '覆盖保存 干活' }))

    expect(await screen.findByText('辅助功能未授权')).toBeTruthy()
  })

  // A4:「保存为新场景」输入框+按钮整体下线,/scene/create 覆盖随之移除——
  // 每个已有场景的恢复/覆盖保存/删除不受影响,见上面几条用例。

  it('点场景名 → 出输入框 → 改名回车 → POST /scene/rename', async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(String(url)).toBe('http://x/scene/rename')
      expect(JSON.parse(String(init?.body))).toEqual({ id: 'work', name: '摸鱼时间' })
      return { ok: true, json: async () => ({ ok: true }) }
    }) as unknown as typeof fetch

    render(<SceneBar baseUrl="http://x" scenes={scenes} fetchImpl={fetchImpl} />)
    await userEvent.click(screen.getByRole('button', { name: '干活' }))
    const input = screen.getByRole('textbox', { name: '重命名 干活' })
    await userEvent.clear(input)
    await userEvent.type(input, '摸鱼时间{Enter}')

    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1))
  })

  it('点「删除」→ POST /scene/delete', async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(String(url)).toBe('http://x/scene/delete')
      expect(JSON.parse(String(init?.body))).toEqual({ id: 'work' })
      return { ok: true, json: async () => ({ ok: true }) }
    }) as unknown as typeof fetch

    render(<SceneBar baseUrl="http://x" scenes={scenes} fetchImpl={fetchImpl} />)
    await userEvent.click(screen.getByRole('button', { name: '删除 干活' }))

    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1))
  })

  it('恢复请求 fetch 抛出(而非业务失败)→ 结果区落一行「操作失败:…」,不能一片空白', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('网络断了') }) as unknown as typeof fetch

    render(<SceneBar baseUrl="http://x" scenes={scenes} fetchImpl={fetchImpl} />)
    await userEvent.click(screen.getByRole('button', { name: '恢复 干活' }))

    expect(await screen.findByText('操作失败:网络断了')).toBeTruthy()
  })

  it('覆盖保存 fetch 抛出 → 同样落一行「操作失败:…」', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('服务没起') }) as unknown as typeof fetch

    render(<SceneBar baseUrl="http://x" scenes={scenes} fetchImpl={fetchImpl} />)
    await userEvent.click(screen.getByRole('button', { name: '覆盖保存 干活' }))

    expect(await screen.findByText('操作失败:服务没起')).toBeTruthy()
  })

  it('恢复请求进行中「恢复」按钮禁用,响应回来后恢复可点', async () => {
    let resolveFetch: (value: { ok: boolean, json: () => Promise<unknown> }) => void = () => {}
    const fetchImpl = vi.fn(() => new Promise((resolve) => { resolveFetch = resolve })) as unknown as typeof fetch

    render(<SceneBar baseUrl="http://x" scenes={scenes} fetchImpl={fetchImpl} />)
    const button = screen.getByRole('button', { name: '恢复 干活' })
    expect(button).not.toBeDisabled()

    await userEvent.click(button)
    expect(button).toBeDisabled()

    resolveFetch({ ok: true, json: async () => ({ ok: true, apps: [] }) })

    await waitFor(() => expect(button).not.toBeDisabled())
  })
})

describe('SlotZone 贴合(经 Workbench 渲染,先例:workbench.test.tsx 的整树 render)', () => {
  // V9(2026-08-24 窗位叠 v2):SlotZone 里"点应用按钮发 /snap 或 /activate"的那一整排
  // 按钮已经下线——认领改由壳的拖动落定事件驱动,不再是点出来的。这条只保留
  // helper 未接入横幅本身仍会显示的断言,点按钮走 /snap/activate 的旧覆盖搬去
  // tests/client-dock.test.tsx 的会话区点击路由用例。
  it('helper 未接入:显示「未接入:工作台 App 未运行」', async () => {
    // W4:补一个 current:true 的 dock tab——这条用例测的是 helper 未接入的横幅(SlotZone
    // 内部渲染),跟 dock 内容无关,只是不然会被判定成 butlerActive,槽体整个不挂载。
    const state = snapshot({ dock: dockWithCurrent() })
    render(<WorkbenchOverlay {...props({ state })} />)

    expect(await screen.findByText('未接入:工作台 App 未运行')).toBeTruthy()
  })

  it('★2026-09-21(去掉「存成新布局」):一条布局都没存过 → 场景条整条不画;F2 那条装饰横条仍然不许回来', async () => {
    // 这一条的来历绕了一圈:F2 当初是「没有场景就整个不画」;0920 去预置场景时为了给那句
    // 「还没存过窗口布局……」腾地方改成"空清单也画";0921 Ben 把那句提示连同「存成新布局」
    // 一起去掉(「这个部分不要有了」),空清单下已经没有任何内容可画,闸回到 F2 那一版。
    const state = snapshot({ scenes: [], dock: dockWithCurrent() })
    render(<WorkbenchOverlay {...props({ state })} />)

    await screen.findByRole('heading', { name: '窗口槽' }) // 等首帧渲染完
    expect(document.querySelector('.ben-wb__slot-scroll')).toBeNull()
    expect(screen.queryByText('还没存过窗口布局。先把常用的应用拖进窗口槽,摆好了再在这里保存。')).toBeNull()
    expect(screen.queryByRole('button', { name: '存成新布局' })).toBeNull()
    expect(document.querySelector('.ben-wb__slot-handle')).toBeNull()
    // 槽体本身(实际的拖拽认领目标)不受影响,仍然渲染。
    expect(document.querySelector('.ben-wb__slot-body')).not.toBeNull()
  })

  it('这台服务压根没接 scenes(整格缺席)→ 场景条一个字都不画', async () => {
    const state = snapshot({ dock: dockWithCurrent() })
    render(<WorkbenchOverlay {...props({ state })} />)

    await screen.findByRole('heading', { name: '窗口槽' })
    expect(document.querySelector('.ben-wb__slot-scroll')).toBeNull()
    expect(screen.queryByRole('button', { name: '存成新布局' })).toBeNull()
  })

  it('F2(review,真机截图实证):有场景时 .ben-wb__slot-scroll 容器照常渲染', async () => {
    const state = snapshot({
      scenes: [{ id: 'work', name: '干活', app_count: 2, saved_at: '2026-08-24T10:00:00Z' }],
      dock: dockWithCurrent(),
    })
    render(<WorkbenchOverlay {...props({ state })} />)

    await screen.findByRole('heading', { name: '窗口槽' })
    expect(document.querySelector('.ben-wb__slot-scroll')).not.toBeNull()
    expect(screen.getByText('干活')).toBeTruthy()
  })

  it('snap.state=failed:reason 原样显示', async () => {
    const state = snapshot({
      helper: { connected: true, authorized: true },
      snap: { app: 'codex', state: 'failed', reason: '窗口未找到' },
      dock: dockWithCurrent(),
    })
    render(<WorkbenchOverlay {...props({ state })} />)

    expect(await screen.findByText('贴合失败:窗口未找到')).toBeTruthy()
  })

  it('snap.state=snapped 带 reason(F2 尺寸偏差如实标注):低调 status,不是红色 alert', async () => {
    const reason = '已贴合,尺寸受应用限制:实际 960×640(槽位 900×600)'
    const state = snapshot({
      helper: { connected: true, authorized: true },
      snap: { app: 'codex', state: 'snapped', reason },
      dock: dockWithCurrent(),
    })
    render(<WorkbenchOverlay {...props({ state })} />)

    const note = await screen.findByText(reason)
    expect(note.getAttribute('role')).toBe('status')
  })

  it('snap.state=snapped 无 reason(精确贴合):不渲染任何状态说明行', async () => {
    const state = snapshot({
      helper: { connected: true, authorized: true },
      snap: { app: 'codex', state: 'snapped' },
      dock: dockWithCurrent(),
    })
    render(<WorkbenchOverlay {...props({ state })} />)

    await screen.findByRole('heading', { name: '窗口槽' }) // 等首帧渲染完
    expect(screen.queryByText(/已贴合,尺寸受应用限制/)).toBeNull()
  })

  it('收起窗口槽模块 → POST /unsnap', async () => {
    const calls: string[] = []
    const state = snapshot({ helper: { connected: true, authorized: true } })
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).endsWith('/unsnap')) calls.push(String(url))
      return { ok: true, json: async () => (String(url).endsWith('/state') ? state : { ok: true }) }
    }) as unknown as typeof fetch

    render(<WorkbenchOverlay {...props({ state, fetchImpl })} />)
    await userEvent.click(await screen.findByRole('button', { name: '窗口槽 收起' }))

    await waitFor(() => expect(calls.length).toBeGreaterThan(0))
  })

  // 2026-08-25 版面重排:日历整块下线,原来"展开日历借占槽位"这条触发路径改用
  // 「收起窗口槽」——验的仍是同一件事:槽体没了就必须先把贴住的窗口收起来(spec W4)。
  it('收起窗口槽(槽体卸载) → POST /unsnap', async () => {
    const calls: string[] = []
    const state = snapshot({ helper: { connected: true, authorized: true } })
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).endsWith('/unsnap')) calls.push(String(url))
      return { ok: true, json: async () => (String(url).endsWith('/state') ? state : { ok: true }) }
    }) as unknown as typeof fetch

    render(<WorkbenchOverlay {...props({ state, fetchImpl })} />)
    await screen.findByRole('heading', { name: '窗口槽' }) // 等首帧就绪
    expect(calls).toHaveLength(0)

    await userEvent.click(screen.getByRole('button', { name: '窗口槽 收起' }))

    await waitFor(() => expect(calls.length).toBeGreaterThan(0))
  })

  it('Workbench 卸载 → POST /unsnap', async () => {
    const calls: string[] = []
    const state = snapshot({ helper: { connected: true, authorized: true } })
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).endsWith('/unsnap')) calls.push(String(url))
      return { ok: true, json: async () => (String(url).endsWith('/state') ? state : { ok: true }) }
    }) as unknown as typeof fetch

    const { unmount } = render(<WorkbenchOverlay {...props({ state, fetchImpl })} />)
    await screen.findByRole('heading', { name: '窗口槽' })
    expect(calls).toHaveLength(0)

    unmount()

    await waitFor(() => expect(calls.length).toBeGreaterThan(0))
  })

  it('壳模式下不渲染「返回对话」', () => {
    window.history.replaceState(null, '', '/?ben-workbench=app')
    render(<WorkbenchOverlay {...props()} />)

    expect(screen.queryByRole('button', { name: '返回对话' })).toBeNull()

    window.history.replaceState(null, '', '/')
  })
})

// A4(2026-08-24 UX 波):「管理」按钮 + AppManagePanel 整体移除——标签的 ✕(放出到本机)
// 加拖拽认领(A2)取代了它,增删应用变成纯服务端能力,不再有 UI 挂着(/apps/* 路由与
// appsRegistry 本身仍在,server-apps-registry.test.ts 覆盖)。上面这一整块 UI 覆盖随之删除。

describe('窗位盒完整收容(真机截图实证:场景多了槽体压成一条缝;A4 起不再有管理钮飘移的问题)', () => {
  it('样式:.ben-wb__mod overflow:hidden + .ben-wb__slot-scroll/.ben-wb__slot-body/.ben-wb__slot 的 flex 规则', async () => {
    const { STYLE } = await import('../src/client/style.ts')
    // 模块盒子本身裁掉一切外溢——这是"绝不外溢"的最后一道防线。
    expect(STYLE).toMatch(/\.ben-wb__mod\{[^}]*overflow:hidden/)
    // "高度会变"的场景条/管理面板独立成自己的滚动区,shrink 优先级比槽体高(先卷起来的是它)。
    expect(STYLE).toMatch(/\.ben-wb__slot-scroll\{[^}]*flex:0 1 auto[^}]*overflow-y:auto/)
    // 槽体:平时吃满剩余空间,真被挤到底线也有 120px(不是旧的 240px)兜底,不会压成一条缝。
    expect(STYLE).toMatch(/\.ben-wb__slot-body\{[^}]*flex:1 1 auto;min-height:120px/)
    // 槽体所在的 .ben-wb__slot 自己 shrink:0——真正让步的是 .ben-wb__slot-scroll,不是它。
    expect(STYLE).toMatch(/\.ben-wb__slot\{[^}]*flex:1 0 auto/)
    // 滚动区保底(真机反馈:窗位盒矮时场景行整个消失,"窗口显示不完整")——留够约两行的高度。
    expect(STYLE).toMatch(/\.ben-wb__slot-scroll\{[^}]*min-height:84px/)
  })

  it('样式:拖高抓手可见化(真机反馈"为什么还没实现"——原来 6px 纯光标区找不到)', async () => {
    const { STYLE } = await import('../src/client/style.ts')
    // 12px 满宽热区,不再是几乎看不见的 6px。
    expect(STYLE).toMatch(/\.ben-wb__mod-handle\{[^}]*height:12px/)
    // 居中一根圆角短杠,常显(不依赖 hover 才现身)。
    expect(STYLE).toMatch(/\.ben-wb__mod-handle-grip\{[^}]*width:36px[^}]*height:4px[^}]*border-radius:999px/)
    // 悬停变亮、拖拽变强调色两档反馈都在。
    expect(STYLE).toMatch(/\.ben-wb__mod-handle:hover \.ben-wb__mod-handle-grip\{/)
    expect(STYLE).toMatch(/\.ben-wb__mod-handle\[data-dragging=true\] \.ben-wb__mod-handle-grip\{/)
  })

  it('场景很多+窗位篇幅压到最小 → 场景行/槽体全都收在同一个模块盒子内,不外溢到下一个模块', async () => {
    const manyScenes: SceneView[] = Array.from({ length: 20 }, (_, i) => ({
      id: `scene-${i}`, name: `场景 ${i}`, app_count: 3, saved_at: '2026-08-21T10:00:00Z',
    }))
    const state = snapshot({
      scenes: manyScenes,
      dock: dockWithCurrent(),
      layout: {
        modules: [
          { id: 'projects', order: 0, basis_pct: 34 },
          { id: 'slot', order: 1, basis_pct: 8 }, // MIN_BASIS_PCT——窗位盒压到最小
          { id: 'notes', order: 2, basis_pct: 58 },
        ],
        butler: { corner: 'br', min: false },
      },
    })

    render(<WorkbenchOverlay {...props({ state })} />)

    // 窗位模块自己的盒子:从"窗口槽"标题往上找最近的 .ben-wb__mod。
    const slotHeading = await screen.findByRole('heading', { name: '窗口槽' })
    const slotMod = slotHeading.closest('.ben-wb__mod')
    expect(slotMod).not.toBeNull()

    // 场景行、槽体两样都在同一个模块盒子内(A4 起没有管理面板要一起收容了)。
    expect(screen.getByText('场景 0').closest('.ben-wb__mod')).toBe(slotMod)
    const slotBody = document.querySelector('.ben-wb__slot-body')
    expect(slotBody).not.toBeNull()
    expect(slotMod?.contains(slotBody)).toBe(true)

    // 下一个模块(随手记)的标题确实存在、且不是窗位盒子的后代——两个盒子互不越界。
    // (2026-08-25 版面重排前这里是「组件条」,那个模块已经退休。)
    const nextModuleHeading = screen.getByRole('heading', { name: '随手记' })
    expect(slotMod?.contains(nextModuleHeading)).toBe(false)
  })
})
