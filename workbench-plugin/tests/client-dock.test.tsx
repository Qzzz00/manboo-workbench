/**
 * 窗位叠标签栏 + 窗位矩形上报 + 会话区点击路由(spec 2026-08-24 窗位叠 v2 V1–V9,Task 4)。
 *
 * 旧的"SLOT_APPS 贴合按钮"覆盖已经在 tests/client-slot-scenes.test.tsx / workbenchLayout.test.tsx
 * 里下线,会话区点击也不再走 helper 就绪+槽体可见 才发 /snap 的那条 S3 老路——切换/放出全部
 * 改成服务端 dockService 决策,客户端只管把 state.dock 如实摆出来、把点击原样转发。
 */
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkbenchOverlay, type MinimalWebSocket, type WorkbenchOverlayProps } from '../src/client/Workbench.tsx'
import { createWorkbenchStore } from '../src/client/store.ts'
import { STYLE } from '../src/client/style.ts'
import type { SessionView, WorkbenchState } from '../src/protocol.ts'
import { UNUSED_STANDARD_PROPS } from './helpers/standardProps.ts'

afterEach(cleanup)

/**
 * 2026-09-17:根因同 tests/client-pure-mode.test.tsx 头部那段注释(那里写了完整的取证过程),
 * 这个文件照搬。判据一样:用例的**第一句**就是 `render()` 紧跟
 * `waitFor(() => getByRole(...))` / `findByRole(...)`,中间夹着那一次 500~900 毫秒、
 * 堵住主线程的同步重渲 —— 默认 1000 毫秒的 `asyncUtilTimeout` 一次重试都不剩。
 * 这个文件有 60 多条用例、跑到后面堵得更久,「有窗在台前 → 不渲染收件箱」因此偶发翻红。
 * 同样只对本文件放宽,不动全局默认值。
 *
 * 2026-09-21 补:「跑到后面堵得更久」的真正原因查清了——不是机器忙,是 jsdom 29.1.1 把每次
 * 卸载的 `<style>` 样式表漏在 `document.styleSheets` 里,越攒越多、每次重渲越慢(第 90 条之后
 * 一条 10~20 秒,九条超时假红)。已在 `tests/setup/jsdomStyleSheetLeak.ts` 全局清理,这里的
 * 5 秒放宽保留:首帧那次同步重渲本身就有 500~900 毫秒,那是真实存在的。
 *
 * 2026-09-28 去抖卡:本文件整个换成假时钟 + `tick`(见下面 useFakeClock),不再有
 * `findBy*`/`waitFor`,也就不再有这 5 秒墙钟上限——那条 `configure({ asyncUtilTimeout })`
 * 随之撤掉。首帧那次同步重渲仍然是真实存在的,只是不再有谁掐着表等它。
 */

function session(over: Partial<SessionView> = {}): SessionView {
  return {
    agent: 'dsh',
    session_id: 'a7c1ffff',
    project: '扣扣直聘',
    status: 'running',
    elapsed_sec: 720,
    unread: false,
    updated_at: '2026-08-24T10:03:00.000Z',
    ...over,
  }
}

function snapshot(over: Partial<WorkbenchState> = {}): WorkbenchState {
  return {
    agents: [],
    sessions: [],
    quota: {},
    now: '2026-08-24T10:03:00+08:00',
    stale: false,
    ...over,
  }
}

/**
 * W4:「有一扇原生窗在台前」的 dock 快照——一堆窗位矩形上报的既有用例本来跟 dock 内容
 * 毫不相干,只是恰好用 `snapshot({})` 的默认值(dock 缺省)。W4 把"dock 缺省或叠上没有
 * 任何窗在台前"接成了 butlerActive(事务官选中,槽体整个不挂载、改渲染 iframe)——这些
 *
 * 2026-09-10:事务官那一档的内容从「内嵌 DSH 对话页的 iframe」换成了**事项收件箱**
 * (client/ButlerInbox.tsx)。下面注释里凡是说 "iframe" 的,讲的都是当时那个决定的来龙去脉,
 * 结论一字未改——懒挂载 + 常驻 + display:none、槽体永远挂载,只是被盖住的那层换了内容。
 * 用例原本要测的是槽体本身的矩形上报逻辑,得先确保槽体真的挂载了才测得到,补一个
 * current:true 的 tab 就够。
 */
function dockWithCurrent(): { stack: readonly { key: string, label: string, running: boolean, current: boolean }[] } {
  return { stack: [{ key: 'claude', label: 'Claude', running: true, current: true }] }
}

/** 假 fetch:/state 返回给定快照,任何 POST 都原样记录 { url, body }(先例:workbenchLayout.test.tsx)。 */
function fakeFetchRecording(state: WorkbenchState, calls: { url: string, body: unknown }[]) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      calls.push({ url: String(url), body: init.body === undefined ? undefined : JSON.parse(String(init.body)) })
      return { ok: true, json: async () => ({ ok: true }) }
    }
    return { ok: true, json: async () => state }
  }) as unknown as typeof fetch
}

/**
 * 悬停高亮 v1 起 WorkbenchOverlay 会开一条 WS 订 /live——测试必须喂一个假类,不然会退回
 * 全局 WebSocket 真的去连 baseUrl(真机实测踩过:会连到 Ben 本机正在跑的真实工作台服务,
 * 而且 jsdom 的 Event 类和 Node WebSocket 实现内部用的 Event 不是同一个东西,真连上时
 * 会在 dispatchEvent 里炸出一条 uncaught exception)。不测悬停高亮的用例用这个空壳。
 */
function fakeWebSocket(): (url: string) => MinimalWebSocket {
  return () => ({ onmessage: null, onclose: null, close: () => {} })
}

/**
 * 能捕获实例、手动喂消息/触发关闭的假 WS——悬停高亮用例专用。每次 open() 调 factory 都
 * 产生一个新条目(reconnect 场景会开第二个 socket),instances 按开出的顺序排列。
 */
function fakeHoverSocket() {
  const instances: {
    send: (data: unknown) => void
    triggerClose: () => void
    closeCalls: number
  }[] = []
  const factory = (): MinimalWebSocket => {
    const entry = {
      send: (data: unknown) => { socket.onmessage?.({ data: JSON.stringify(data) }) },
      triggerClose: () => { socket.onclose?.() },
      closeCalls: 0,
    }
    const socket: MinimalWebSocket = {
      onmessage: null,
      onclose: null,
      close: () => { entry.closeCalls++ },
    }
    instances.push(entry)
    return socket
  }
  return { factory, instances }
}

function props(options: {
  state?: WorkbenchState
  fetchImpl?: typeof fetch
  webSocketImpl?: (url: string) => MinimalWebSocket
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
    serviceWebSocket: options.webSocketImpl ?? fakeWebSocket(),
  }
}

/** 槽体测量固定为一个矩形,先例:client-slot-scenes.test.tsx 的贴合用例。 */
function stubSlotRect(rect: { x: number, y: number, width: number, height: number }): void {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    ...rect,
    top: rect.y,
    left: rect.x,
    right: rect.x + rect.width,
    bottom: rect.y + rect.height,
    toJSON() {},
  } as DOMRect)
}

/**
 * 假时钟(2026-09-28 去抖动卡,过程见 `docs/交接-0928-client-dock确定化.md`)。
 *
 * 这个文件原来全靠真实计时器:真实的 200ms/10ms 轮询自己往前走、真实的 800ms 去抖与
 * 80ms 稳定性门、`sleep(300)` 之后断言"没发生"、`findBy*`/`waitFor` 以 5 秒墙钟为限等首帧。
 * 机器一忙就错拍——轮询在 waitFor 看见中间态之前就翻到下一拍、稳定性门的重测在测试
 * "卡点换矩形"之前就量完、基线在一次已排队的 POST 落地之前就数了,首帧那次 500~900ms
 * 的同步重渲被饿到 5 秒以上——每次红的那条都不一样。
 *
 * 现在整个文件每条用例从 render 之前就换上假时钟(下面的 beforeEach),由测试自己推进:
 * `tick(ms)` 把时钟往前拨 ms,
 * 并在 `act` 里把这段时间里落地的一切(轮询回包 → setState → effect → 计时器 → POST)
 * 刷完,之后直接同步断言。只接管 setTimeout/setInterval:React 自己的调度(setImmediate/
 * MessageChannel)照走真实的,`act` 负责把它收拢;Date 也不碰(本文件没有按墙钟判断的逻辑)。
 * 假时钟下别用 `waitFor`/`findBy*`/`userEvent`:它们的超时、重试与收尾(Testing Library 的
 * asyncWrapper 用一次 setTimeout(0) 等微任务排空)也挂在 setTimeout/setInterval 上,会卡死;
 * 点按钮改用 `fireEvent.click`(这几条要验的是 onClick 之后的上报,不是指针事件序列)。
 */
function useFakeClock(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
}

/**
 * 超时隔离。一条用例撞了 15 秒 `testTimeout`,vitest 就去跑下一条,但**那条的 async 函数体
 * 并不会停**——它还会接着 `tick`,而 `act` 的队列是 React 全局一份:僵尸的 `act` 没收口,
 * 下一条的更新就被吞进它的作用域,渲染出一个空 `<div/>`,后面几十条跟着连坐
 * (2026-09-28 负载 280 的机器上实测:一条超时带倒 40 条)。
 * 所以每条收尾时先把代数加一——僵尸再调 `tick` 当场抛错、不再开新的 `act`——再等它
 * 手上那个 `act` 收口,之后才轮到 cleanup 与下一条。
 */
let clockGeneration = 0
let actInFlight: Promise<void> | undefined

/** 假时钟往前拨 ms(0 = 只把眼下已就绪的微任务与 React 更新刷完)。 */
async function tick(ms = 0): Promise<void> {
  const generation = clockGeneration
  // act 回的是 thenable,没有 .catch——包一层才能挂"等它收口"的尾巴。
  const run = Promise.resolve(act(async () => {
    if (generation !== clockGeneration) throw new Error('这条用例已经超时收尾,不再推进时钟')
    await vi.advanceTimersByTimeAsync(ms)
  }))
  actInFlight = run.catch(() => {})
  await run
  if (generation !== clockGeneration) throw new Error('这条用例已经超时收尾,不再推进时钟')
}

/** 与 Workbench.tsx 的 SLOT_RECT_STABILITY_DELAY_MS / SLOT_RECT_DEBOUNCE_MS 同值(源码没导出,这里照抄)。 */
const GATE_MS = 80
const DEBOUNCE_MS = 800

/** 挂载落定:第一份快照回来(layoutReady),挂载那次被动上报走完稳定性门。 */
async function settleMount(): Promise<void> {
  await tick(0)
  await tick(GATE_MS)
}

beforeEach(() => { useFakeClock() })
// 注册在文件头 `afterEach(cleanup)` 之后,按 vitest 默认的 stack 顺序先于 cleanup 跑(见 clockGeneration)。
afterEach(async () => {
  clockGeneration++
  await actInFlight
  actInFlight = undefined
  vi.useRealTimers()
})

describe('窗位叠标签栏(spec V1:current 高亮、running:false 置灰、note 如实显示)', () => {
  // W4:事务官固定格无条件渲染,这条断言从"整个标签栏 group 都不渲染"改成"group 只剩
  // 事务官这一格、没有任何应用标签"——dock 缺省不再意味着标签栏彻底消失。
  //
  // 行为变更(W4 接线后复核):dock 缺省现在也满足 butlerActive(叠上没有任何窗在台前,
  // 见 Workbench.tsx 的派生公式),槽体那一支因此整个不挂载、改渲染内嵌 iframe——
  // SlotZone 自己的"未接入"横幅是槽体内部的东西,这时候不会出现了。断言从"横幅照旧
  // 显示"改成"改显 iframe",标签栏本身(事务官固定格)的断言不变。
  it('state.dock 缺省 → 只渲染事务官固定格,不渲染任何应用标签;槽体那一支改渲染收件箱', async () => {
    const state = snapshot({})
    render(<WorkbenchOverlay {...props({ state })} />)

    await tick(0)
    expect(screen.getByLabelText('事项收件箱')).toBeInTheDocument()
    const group = screen.getByRole('group', { name: '窗位叠标签' })
    // 2026-09-20:这一排里除了标签还多了一颗动作(「开发一个小工具」,不是标签、不进 dock.stack),
    // 所以「没有任何应用标签」改数**标签**本身,不再数 group 里的按钮总数。
    expect(group.querySelectorAll('.ben-wb__dock-tab')).toHaveLength(0)
    // 2026-10-27 已拍板:去掉各处独立的事务官标签页,事务官入口只剩悬浮球。标签栏里不再有「事务官」这一格。
    expect(within(group).queryByRole('button', { name: BUTLER_TAB_LABEL })).toBeNull()
  })

  it('渲染 state.dock.stack:current 高亮、running:false 置灰(但仍是可点的标签)', async () => {
    const state = snapshot({
      dock: {
        stack: [
          { key: 'codex', label: 'Codex', running: true, current: true },
          { key: 'claude', label: 'Claude', running: false, current: false },
        ],
      },
    })
    render(<WorkbenchOverlay {...props({ state })} />)

    await tick(0)
    const codexTab = screen.getByRole('button', { name: 'Codex' }).closest('.ben-wb__dock-tab')
    expect(codexTab?.getAttribute('data-current')).toBe('true')
    expect(codexTab?.getAttribute('data-running')).toBe('true')

    const claudeTab = screen.getByRole('button', { name: 'Claude' }).closest('.ben-wb__dock-tab')
    expect(claudeTab?.getAttribute('data-current')).toBe('false')
    expect(claudeTab?.getAttribute('data-running')).toBe('false')
    // 置灰只是样式提示,按钮本身不禁用——服务端会把它拉起来(D13:多一步不等于做不到)。
    expect(screen.getByRole('button', { name: 'Claude' })).not.toBeDisabled()
  })

  it('点标签(即便 running:false)→ POST /dock/switch {app:key}', async () => {
    const calls: { url: string, body: unknown }[] = []
    const state = snapshot({
      dock: { stack: [{ key: 'claude', label: 'Claude', running: false, current: false }] },
    })
    render(<WorkbenchOverlay {...props({ state, fetchImpl: fakeFetchRecording(state, calls) })} />)

    await tick(0)
    fireEvent.click(screen.getByRole('button', { name: 'Claude' }))
    await tick(0)

    await tick(0)
    expect(calls.some(c => c.url.endsWith('/dock/switch'))).toBe(true)
    expect(calls.find(c => c.url.endsWith('/dock/switch'))?.body).toEqual({ app: 'claude' })
  })

  it('点每标签的 ✕(aria-label「放出 X」)→ POST /dock/release {app:key}', async () => {
    const calls: { url: string, body: unknown }[] = []
    const state = snapshot({
      dock: { stack: [{ key: 'codex', label: 'Codex', running: true, current: true }] },
    })
    render(<WorkbenchOverlay {...props({ state, fetchImpl: fakeFetchRecording(state, calls) })} />)

    await tick(0)
    fireEvent.click(screen.getByRole('button', { name: '放出 Codex' }))
    await tick(0)

    await tick(0)
    expect(calls.some(c => c.url.endsWith('/dock/release'))).toBe(true)
    expect(calls.find(c => c.url.endsWith('/dock/release'))?.body).toEqual({ app: 'codex' })
  })

  it('dock.note 如实显示,role=status(不是红色 alert)', async () => {
    // W4:note 渲染在 SlotZone 内部,而 SlotZone 只在"有窗在台前"(butlerActive===false)
    // 那一支才挂载——这里补一个 current:true 的 tab,不然 dock.stack 为空会被判定成
    // "叠上没窗"从而改渲染 iframe,note 也就无处可显了。
    const state = snapshot({
      dock: { stack: [{ key: 'claude', label: 'Claude', running: true, current: true }], note: '切换失败:窗口未找到' },
    })
    render(<WorkbenchOverlay {...props({ state })} />)

    await tick(0)
    const note = screen.getByText('切换失败:窗口未找到')
    expect(note.getAttribute('role')).toBe('status')
  })

  // W4:同上——group 本身不再因为 stack 为空而消失,事务官固定格仍在,只是没有应用标签。
  it('dock.stack 为空且无 note → 只渲染事务官固定格,不渲染应用标签行,也不报错', async () => {
    const state = snapshot({ dock: { stack: [] } })
    render(<WorkbenchOverlay {...props({ state })} />)

    await tick(0)
    screen.getByRole('heading', { name: '窗口槽' }) // 等首帧渲染完
    const group = screen.getByRole('group', { name: '窗位叠标签' })
    // 同上(2026-09-20):数标签,不数按钮——那一排末尾还站着一颗「开发一个小工具」。
    expect(group.querySelectorAll('.ben-wb__dock-tab')).toHaveLength(0)
    // 2026-10-27 已拍板:去掉各处独立的事务官标签页,事务官入口只剩悬浮球。标签栏里不再有「事务官」这一格。
    expect(within(group).queryByRole('button', { name: BUTLER_TAB_LABEL })).toBeNull()
  })
})

describe('窗位叠标签的彩色圆点徽章(spec A3:会话区退休,徽章接过"谁在等我"的职责)', () => {
  it('黄=等确认、红=出错、蓝=刚完成未读——三档各自独立的圆点+计数,同一标签可以同时出现多个', async () => {
    const state = snapshot({
      dock: { stack: [{ key: 'claude', label: 'Claude', running: true, current: true }] },
      sessions: [
        session({ agent: 'claude', session_id: 'w1', status: 'waiting', title: 'A' }),
        session({ agent: 'claude', session_id: 'w2', status: 'waiting', title: 'B' }),
        session({ agent: 'claude', session_id: 'e1', status: 'error', title: 'C' }),
        session({ agent: 'claude', session_id: 'd1', status: 'done', unread: true, title: 'D' }),
        // 2026-09-02「看过就该消失」修订后:已读的 done 会话**不再进任何档**
        // (0827 曾把它算进白点,代价是看过的会话要挂到 2 小时闲置才消失)。
        session({ agent: 'claude', session_id: 'd2', status: 'done', unread: false, title: 'E' }),
        // 白点改为只数"正在跑",所以这里补一条真在跑的,四档才凑得齐。
        session({ agent: 'claude', session_id: 'r1', status: 'running', title: 'G' }),
        session({ agent: 'codex', session_id: 'x1', status: 'waiting', title: 'F' }), // 别的 agent,不计入 claude 标签
      ],
    })
    render(<WorkbenchOverlay {...props({ state })} />)

    await tick(0)
    const claudeTab = screen.getByRole('button', { name: 'Claude' }).closest('.ben-wb__dock-tab')
    const badges = claudeTab?.querySelectorAll('.ben-wb__dock-badge-dot')
    expect(badges).toHaveLength(4) // 白(G 在跑;E 已读完成不出点)+ 黄 2 + 红 1 + 蓝 1
    expect(claudeTab?.querySelector('[data-tone=running] .ben-wb__dock-badge-dot')?.textContent).toBe('1')
    expect(claudeTab?.querySelector('[data-tone=waiting] .ben-wb__dock-badge-dot')?.textContent).toBe('2')
    expect(claudeTab?.querySelector('[data-tone=error] .ben-wb__dock-badge-dot')?.textContent).toBe('1')
    expect(claudeTab?.querySelector('[data-tone=done] .ben-wb__dock-badge-dot')?.textContent).toBe('1')
  })

  /**
   * ★★09-26 维护者截图那一幕(卡 V 补):Claude 标签上是「1 白 + 1 橙」,而他桌面里是
   * **一条在跑、三条做完了**。他的原话:「现在应该是 3 完成 1 进行中」。
   *
   * 这一条把那一幕整个摆进来:四条会话喂同一份状态,断言标签上就是**白 1 + 蓝 3**、**一颗橙点都没有**。
   * 三条做完的里有一条(`d4ac442e`)最后那段话里顺口问了他一句 —— 卡 T 会给它挂 `ask`,
   * 但那**不改运行状态**(见 src/server/waitingForYou.ts 的 overlayWaiting),所以它照旧算「完成 · 未读」。
   * 那一问去哪儿了:「事务官」标签的琥珀气泡与球下「等你 n」(src/waiting.ts 的 waitingOnHim 数它)。
   */
  it('★★维护者 09-26 那一幕:一条在跑 + 三条做完 → 白 1 + 蓝 3,没有橙点', async () => {
    const state = snapshot({
      dock: { stack: [{ key: 'claude', label: 'Claude', running: true, current: true }] },
      sessions: [
        session({ agent: 'claude', session_id: 'd9991aac', status: 'running', title: 'Desktop-workbench 统筹交接' }),
        // 做完了、还顺口问了他一句(卡 T 挂了 ask):照旧是「完成 · 未读」,不是「等确认」。
        session({
          agent: 'claude', session_id: 'd4ac442e', status: 'done', unread: true,
          title: '修 profile 补丁里 cookie 那一行的 id 写错',
          ask: { kind: 'approve', question: '要不要提示他重新登一次?', since: '2026-09-26T04:39:00.000Z', by: 'rules' },
        }),
        session({ agent: 'claude', session_id: '6302f07d', status: 'done', unread: true, title: 'Fix flaky wiki-view viewBox transition test' }),
        session({ agent: 'claude', session_id: 'ff8b7326', status: 'done', unread: true, title: '让「到上限了」那一问也跨过重启' }),
      ],
    })
    render(<WorkbenchOverlay {...props({ state })} />)

    await tick(0)
    const claudeTab = screen.getByRole('button', { name: 'Claude' }).closest('.ben-wb__dock-tab')
    expect(claudeTab?.querySelector('[data-tone=running] .ben-wb__dock-badge-dot')?.textContent).toBe('1')
    expect(claudeTab?.querySelector('[data-tone=done] .ben-wb__dock-badge-dot')?.textContent).toBe('3')
    // 一颗橙点都没有 —— 「哪有要确认的」。
    expect(claudeTab?.querySelector('[data-tone=waiting]')).toBeNull()
    expect(claudeTab?.querySelectorAll('.ben-wb__dock-badge-dot')).toHaveLength(2)
  })

  /**
   * ★★维护者 09-26 的第二问:「新加的是不是状态不全,只有完成的,但是没有弹过待确认还有执行中的气泡」。
   *
   * 根因在这一档的数法:卡 V 把白点的数改成从 `/state.running` 切,切的判据写的是
   * `item.agent === tab.key` —— 而 `running.items[].agent` 是**登记表里的 id**(运行时接上的一家
   * 就是它的包标识),坞上那一格的键是 App 注册表的键(`c-antigravity`)。两者对不上 → 切出空数组 →
   * `[].length` 是 0、`?? open.length` 那条退路够不着 → **白点整个消失**。
   *
   * 真机实证(09-26 16:2x 生产 8791 的 `/state`,只读):Antigravity 的窗口会话 `status: 'running'`、
   * `running.items` 里有 `{ agent: 'com.google.antigravity', session_id: 'window:5e0b9399' }`,
   * 而 `dock.bundles['c-antigravity'] === 'com.google.antigravity'`。
   */
  it('★★窗口型 Agent(坞上的键与登记表 id 不一样)照样有白点:按登记表对,不按键名对', async () => {
    const state = snapshot({
      dock: {
        stack: [{ key: 'c-antigravity', label: 'Antigravity', running: true, current: true }],
        bundles: { 'c-antigravity': 'com.google.antigravity' },
      },
      agent_registry: {
        entries: [{
          id: 'com.google.antigravity',
          bundle_id: 'com.google.antigravity',
          name: 'Antigravity',
          found: { how: 'activate', at: '2026-09-26T08:08:00.000Z', basis: '模型判成 Agent' },
          sources: [{ kind: 'window', label: '读它的窗口', ok: true }],
          app_running: true,
          status: 'running',
          gaps: {},
          sessions: [{
            agent: 'com.google.antigravity',
            session_id: 'window:5e0b9399',
            project: 'Antigravity',
            status: 'running',
            title: 'Initiating A New Conversa…',
            elapsed_sec: 42,
            unread: false,
            updated_at: '2026-09-26T08:08:00.000Z',
            via: 'window',
          }],
          counts: { running: 1, waiting: 0, unread: 0 },
        }],
        asking: [],
        notices: [],
      },
      // 服务端算好的那一份(src/running.ts):窗口会话的 agent 是登记表 id = 包标识。
      running: {
        count: 1,
        items: [{ key: 'session:com.google.antigravity:window:5e0b9399', agent: 'com.google.antigravity', session_id: 'window:5e0b9399', text: 'Initiating A New Conversa…' }],
      },
    })
    render(<WorkbenchOverlay {...props({ state })} />)

    await tick(0)
    const tab = screen.getByRole('button', { name: 'Antigravity' }).closest('.ben-wb__dock-tab')
    expect(tab?.querySelector('[data-tone=running] .ben-wb__dock-badge-dot')?.textContent).toBe('1')
  })

  it('★窗口型 Agent 做完了、他还没看 → 蓝点;内容判出来的那一问只挂 ask,不在这一格出橙点', async () => {
    const state = snapshot({
      dock: {
        stack: [{ key: 'c-grokbot', label: 'Grok Bot', running: true, current: false }],
        bundles: { 'c-grokbot': 'com.anysphere.sand' },
      },
      agent_registry: {
        entries: [{
          id: 'com.anysphere.sand',
          bundle_id: 'com.anysphere.sand',
          name: 'Grok Bot',
          found: { how: 'activate', at: '2026-09-26T07:54:00.000Z', basis: '模型判成 Agent' },
          sources: [{ kind: 'window', label: '读它的窗口', ok: true }],
          app_running: true,
          status: 'idle',
          gaps: {},
          sessions: [{
            agent: 'com.anysphere.sand',
            session_id: 'window:1a2b3c4d',
            project: 'Grok Bot',
            status: 'done',
            unread: true,
            title: '帮我查一下这条报错',
            elapsed_sec: 90,
            updated_at: '2026-09-26T07:56:00.000Z',
            via: 'window',
            ask: { kind: 'choose', question: '两种改法你选哪个', since: '2026-09-26T07:56:00.000Z', by: 'rules' },
          }],
          counts: { running: 0, waiting: 0, unread: 1 },
        }],
        asking: [],
        notices: [],
      },
      running: { count: 0, items: [] },
    })
    render(<WorkbenchOverlay {...props({ state })} />)

    await tick(0)
    const tab = screen.getByRole('button', { name: 'Grok Bot' }).closest('.ben-wb__dock-tab')
    expect(tab?.querySelector('[data-tone=done] .ben-wb__dock-badge-dot')?.textContent).toBe('1')
    // 一颗橙点都没有:那一问走「事务官」标签的琥珀气泡 / 球下「等你 n」,不占这一格的运行状态档。
    expect(tab?.querySelector('[data-tone=waiting]')).toBeNull()
    expect(tab?.querySelectorAll('.ben-wb__dock-badge-dot')).toHaveLength(1)
  })

  it('全零分类不占位置——没有等待/出错/未读完成/进行中的会话时,标签上不渲染任何徽章', async () => {
    const state = snapshot({
      dock: { stack: [{ key: 'claude', label: 'Claude', running: true, current: true }] },
      // offline 不在任何一档的判定范围内(running/waiting/error/未读done 都不成立)——
      // 用它而不是 'running' 状态,因为 running 现在本身就是新增的一档(见下方新测试)。
      sessions: [session({ agent: 'claude', session_id: 'r1', status: 'offline' })],
    })
    render(<WorkbenchOverlay {...props({ state })} />)

    await tick(0)
    const claudeTab = screen.getByRole('button', { name: 'Claude' }).closest('.ben-wb__dock-tab')
    expect(claudeTab?.querySelectorAll('.ben-wb__dock-badge-dot')).toHaveLength(0)
  })

  it('新增「进行中」档(running):白色圆点,四档顺序按 Ben 钦定的 进行中→等确认→已完成待验收→出错 排列,IM 仍排最后', async () => {
    const state = snapshot({
      dock: { stack: [{ key: 'claude', label: 'Claude', running: true, current: true, im: 'wechat' }] },
      sessions: [
        // 刻意乱序传入,断言的是渲染顺序而非数组顺序——tabBadges 自己必须按钦定档位排列。
        session({ agent: 'claude', session_id: 'e1', status: 'error', title: 'E' }),
        session({ agent: 'claude', session_id: 'd1', status: 'done', unread: true, title: 'D' }),
        session({ agent: 'claude', session_id: 'r1', status: 'running', title: 'R' }),
        session({ agent: 'claude', session_id: 'w1', status: 'waiting', title: 'W' }),
      ],
      badges: { wechat: 2 },
    })
    render(<WorkbenchOverlay {...props({ state })} />)

    await tick(0)
    const claudeTab = screen.getByRole('button', { name: 'Claude' }).closest('.ben-wb__dock-tab')
    // im 也命中(badges.wechat:2)——五档全部渲染,断言顺序时把它算进去,确认它仍固定殿后。
    const badgeEls = claudeTab?.querySelectorAll('.ben-wb__dock-badge')
    expect(badgeEls).toHaveLength(5)
    const tones = Array.from(badgeEls ?? []).map(el => el.getAttribute('data-tone'))
    expect(tones).toEqual(['running', 'waiting', 'done', 'error', 'im'])

    const runningDot = claudeTab?.querySelector('[data-tone=running] .ben-wb__dock-badge-dot')
    expect(runningDot?.textContent).toBe('1')
    // 2026-08-27 方案 A:白点语义从"进行中"扩为"会话还开着",无障碍文案跟着改,
    // 否则屏幕阅读器会把一个闲着的会话念成"进行中"。
    expect(runningDot?.getAttribute('aria-label')).toBe('开着 1')
  })

  it('running 档气泡行尾:last_output_sec 存在时带「上次输出 Xs 前」(复用 humanDuration),不存在就不带', async () => {
    const state = snapshot({
      dock: { stack: [{ key: 'claude', label: 'Claude', running: true, current: true }] },
      sessions: [
        session({ agent: 'claude', session_id: 'r1', status: 'running', title: '在跑', elapsed_sec: 65, last_output_sec: 12 }),
        session({ agent: 'claude', session_id: 'r2', status: 'running', title: '在跑2', elapsed_sec: 30 }),
      ],
    })
    render(<WorkbenchOverlay {...props({ state })} />)

    await tick(0)
    const claudeTab = screen.getByRole('button', { name: 'Claude' }).closest('.ben-wb__dock-tab')
    const runningBadge = claudeTab?.querySelector('[data-tone=running]')
    expect(runningBadge).not.toBeNull()
    fireEvent.mouseEnter(runningBadge!)
    const bubble = runningBadge?.querySelector('.ben-wb__dock-badge-bubble')
    expect(bubble?.textContent).toContain('在跑 · 1 分 5 秒 · 上次输出 12 秒前')
    expect(bubble?.textContent).toContain('在跑2 · 30 秒')
    // 没有 last_output_sec 字段的会话不该凭空带出这句后缀。
    expect(bubble?.textContent).not.toContain('在跑2 · 30 秒 · 上次输出')
  })

  it('点蓝色「未读完成」圆点=标记已读:对每条未读完成会话各发一次 POST /read(2026-08-26 症状:会话区退休后 /read 没有任何入口,蓝点永不消失)', async () => {
    const calls: { url: string, body: unknown }[] = []
    const state = snapshot({
      dock: { stack: [{ key: 'claude', label: 'Claude', running: true, current: true }] },
      sessions: [
        session({ agent: 'claude', session_id: 'd1', status: 'done', unread: true, title: '完成甲' }),
        session({ agent: 'claude', session_id: 'd2', status: 'done', unread: true, title: '完成乙' }),
        session({ agent: 'claude', session_id: 'd3', status: 'done', unread: false, title: '早已读' }), // 已读,不该重复上报
      ],
    })
    render(<WorkbenchOverlay {...props({ state, fetchImpl: fakeFetchRecording(state, calls) })} />)

    await tick(0)
    const claudeTab = screen.getByRole('button', { name: 'Claude' }).closest('.ben-wb__dock-tab')
    const doneDot = claudeTab?.querySelector('[data-tone=done] .ben-wb__dock-badge-dot')
    expect(doneDot).not.toBeNull()
    fireEvent.click(doneDot!)

    await tick(0)
    expect(calls.filter(c => c.url.endsWith('/read'))).toHaveLength(2)
    const bodies = calls.filter(c => c.url.endsWith('/read')).map(c => c.body)
    expect(bodies).toContainEqual({ agent: 'claude', session_id: 'd1' })
    expect(bodies).toContainEqual({ agent: 'claude', session_id: 'd2' })
    // 点已读不该顺带触发 /dock/switch——它是"收掉提醒",不是"切过去"。
    expect(calls.some(c => c.url.endsWith('/dock/switch'))).toBe(false)
  })

  it('其余各档圆点(黄/红/白/灰)不可点已读——它们没有"未读"语义,点了不发 /read', async () => {
    const calls: { url: string, body: unknown }[] = []
    const state = snapshot({
      dock: { stack: [{ key: 'claude', label: 'Claude', running: true, current: true, im: 'wechat' }] },
      sessions: [
        session({ agent: 'claude', session_id: 'w1', status: 'waiting', title: 'W' }),
        session({ agent: 'claude', session_id: 'r1', status: 'running', title: 'R' }),
      ],
      badges: { wechat: 2 },
    })
    render(<WorkbenchOverlay {...props({ state, fetchImpl: fakeFetchRecording(state, calls) })} />)

    await tick(0)
    const claudeTab = screen.getByRole('button', { name: 'Claude' }).closest('.ben-wb__dock-tab')
    for (const tone of ['waiting', 'running', 'im']) {
      const dot = claudeTab?.querySelector(`[data-tone=${tone}] .ben-wb__dock-badge-dot`)
      expect(dot).not.toBeNull()
      fireEvent.click(dot!)
    }
    await tick(20)
    expect(calls.filter(c => c.url.endsWith('/read'))).toHaveLength(0)
  })

  /**
   * 白点 = 「此刻正在跑」(2026-09-02 Ben 选定「看过就该消失」,**修订 0827 的方案 A**)。
   *
   * 0827 曾把白点扩成"会话还开着"(在跑 + 跑完已读),为的是让"开着、等他下一句"这个
   * 状态有归宿。真机用下来代价更大:Ben 点开看过的完成会话**不会消失,只是从蓝变白**,
   * 一直挂到 2 小时闲置为止。2026-09-02 重启后 4 条 15:22 完成、他也都看过的 Codex 会话
   * 就这么占着白点到 17:22,他连着两次报"气泡一直是 4,什么都没跑也是 4"。
   *
   * 新语义:**看过就该消失**。分桶仍互不重叠(一个会话只进一档):
   * 等确认→黄、出错→红、完成未读→蓝、正在跑→白;跑完且已读的**不再显示任何点**
   * ——它既不需要你回来看,也不在等你。
   */
  describe('圆点几何在各档之间必须一致(2026-09-02 Ben:"完成的图标和文字和左侧的不一致,很难受")', () => {
    // 真机截图:Codex 标签上白点与蓝点并排,白点因为多了一圈 1px 实边框(基类是 border:0)
    // 外径大 2px、数字基线也差一点。这条用例把"几何一致"这个不变量钉在样式表上:
    // 所有档共用同一条透明边框 + border-box,有色档只覆盖 border-color。
    it('★圆点规则必须带 .ben-wb 前缀——否则 <button> 档的数字被 `.ben-wb button{font:inherit}` 拔大', () => {
      // 真机截图:蓝点(<button>,点它标已读)里的数字明显比白点(<span>)大。
      // 真因是权重:".ben-wb button{font:inherit}" 是 (0,1,1),font 简写把字号字重
      // 整个重置成继承值;不带前缀的 ".ben-wb__dock-badge-dot" 只有 (0,1,0),压不住它。
      const dot = STYLE.split('\n').find(line => line.includes('.ben-wb__dock-badge-dot{'))
      expect(dot).toBeDefined()
      expect(dot!.startsWith('.ben-wb .ben-wb__dock-badge-dot{')).toBe(true)
      expect(dot).toContain('font-size:9.5px')
      expect(dot).toContain('box-sizing:border-box')
      expect(dot).toContain('border:1px solid transparent')
    })

    it('那条 font:inherit 仍在(它是别处按钮要的),所以前缀这道防护不能撤', () => {
      expect(STYLE).toContain('.ben-wb button{font:inherit}')
    })

    it('白点档只改颜色,不再改边框宽度(改宽度就会把几何撑大)', () => {
      const running = STYLE.split('\n').find(line => line.includes('[data-tone=running] .ben-wb__dock-badge-dot'))
      expect(running).toBeDefined()
      expect(running).toContain('border-color:')
      expect(running).not.toContain('border:1px')
    })
  })

  describe('白点=正在跑(2026-09-02 修订:看过就该消失)', () => {
    it('★跑完且已读的会话不再显示任何点——看过了就该消失', async () => {
      const state = snapshot({
        dock: { stack: [{ key: 'claude', label: 'Claude', running: true, current: true }] },
        sessions: [session({ agent: 'claude', session_id: 'idle1', status: 'done', unread: false, title: '闲着的' })],
      })
      render(<WorkbenchOverlay {...props({ state })} />)

      await tick(0)
      const tab = screen.getByRole('button', { name: 'Claude' }).closest('.ben-wb__dock-tab')
      expect(tab?.querySelectorAll('.ben-wb__dock-badge-dot')).toHaveLength(0)
    })

    it('★白点只数正在跑的:1 个在跑 + 1 个已读完成 → 白点是 1,不是 2', async () => {
      const state = snapshot({
        dock: { stack: [{ key: 'claude', label: 'Claude', running: true, current: true }] },
        sessions: [
          session({ agent: 'claude', session_id: 'r1', status: 'running', title: '正在跑' }),
          session({ agent: 'claude', session_id: 'i1', status: 'done', unread: false, title: '闲着的' }),
        ],
      })
      render(<WorkbenchOverlay {...props({ state })} />)

      await tick(0)
      const tab = screen.getByRole('button', { name: 'Claude' }).closest('.ben-wb__dock-tab')
      expect(tab?.querySelector('[data-tone=running] .ben-wb__dock-badge-dot')?.textContent).toBe('1')
    })

    it('★未读完成只进蓝点,不重复计进白点(一个会话只占一档,不双计)', async () => {
      const state = snapshot({
        dock: { stack: [{ key: 'claude', label: 'Claude', running: true, current: true }] },
        sessions: [session({ agent: 'claude', session_id: 'd1', status: 'done', unread: true, title: '未读' })],
      })
      render(<WorkbenchOverlay {...props({ state })} />)

      await tick(0)
      const tab = screen.getByRole('button', { name: 'Claude' }).closest('.ben-wb__dock-tab')
      expect(tab?.querySelector('[data-tone=done] .ben-wb__dock-badge-dot')?.textContent).toBe('1')
      expect(tab?.querySelector('[data-tone=running]')).toBeNull()
    })

    it('★offline 是真结束了,不算"还开着"', async () => {
      const state = snapshot({
        dock: { stack: [{ key: 'claude', label: 'Claude', running: true, current: true }] },
        sessions: [session({ agent: 'claude', session_id: 'o1', status: 'offline', title: '已结束' })],
      })
      render(<WorkbenchOverlay {...props({ state })} />)

      await tick(0)
      const tab = screen.getByRole('button', { name: 'Claude' }).closest('.ben-wb__dock-tab')
      expect(tab?.querySelectorAll('.ben-wb__dock-badge-dot')).toHaveLength(0)
    })

    it('★气泡只列在跑的那些;已读完成的连气泡都不该出现', async () => {
      const state = snapshot({
        dock: { stack: [{ key: 'claude', label: 'Claude', running: true, current: true }] },
        sessions: [
          session({ agent: 'claude', session_id: 'r1', status: 'running', title: '正在跑', elapsed_sec: 30 }),
          session({ agent: 'claude', session_id: 'i1', status: 'done', unread: false, title: '闲着的', elapsed_sec: 600 }),
        ],
      })
      render(<WorkbenchOverlay {...props({ state })} />)

      await tick(0)
      const tab = screen.getByRole('button', { name: 'Claude' }).closest('.ben-wb__dock-tab')
      const dot = tab?.querySelector('[data-tone=running]')
      fireEvent.mouseEnter(dot!)
      const bubble = dot?.querySelector('.ben-wb__dock-badge-bubble')
      expect(bubble?.textContent).toContain('正在跑')
      expect(bubble?.textContent).not.toContain('闲着的')
    })
  })

  /**
   * 「看过了就该灭」(2026-08-27 Ben 真机反馈,等效授权)。
   *
   * 他的真实动线是:点 Codex 标签 → 真窗口到前台 → 在 Codex 里把结果看完 →
   * 点别的标签离开。工作台明明知道他把 Codex 调到前台看过了,却还要求他回来戳一下
   * 蓝点才肯灭——反直觉。所以在「点蓝点=批量已读」之外,补一条:**切到某个应用标签
   * 并停留够久,就把该应用当时已亮的蓝点标已读**。
   *
   * 两条边界(Ben 点名):
   * - 只清「切过去那一刻已经亮着」的,停留期间新完成的不顺手清掉;
   * - 要有停留阈值,路过式切一下不算看过。
   */
  describe('切到标签并停留够久 → 自动把当时亮着的蓝点标已读', () => {
    const DWELL = 60
    /** 轮询间隔。假时钟下每 tick(POLL) 恰好一拍,"停了多久"由测试说了算,不看机器忙不忙。 */
    const POLL = 10

    /** 轮询依次吐出给定的几份快照(最后一份之后保持不变);POST 原样记录。 */
    function fetchSequence(states: readonly WorkbenchState[], calls: { url: string, body: unknown }[]) {
      let i = 0
      return vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === 'POST') {
          calls.push({ url: String(url), body: init.body === undefined ? undefined : JSON.parse(String(init.body)) })
          return { ok: true, json: async () => ({ ok: true }) }
        }
        // 2026-09-17(账号登录):挂载时还会问一次 /account —— 只有 /state 才推进序列。
        if (!String(url).includes('/state')) return { ok: false, status: 404, json: async () => ({ error: '未启用' }) }
        const state = states[Math.min(i, states.length - 1)]!
        i += 1
        return { ok: true, json: async () => state }
      }) as unknown as typeof fetch
    }

    const codexTab = (current: boolean) => ({ key: 'codex', label: 'Codex', running: true, current })
    const claudeTab = (current: boolean) => ({ key: 'claude', label: 'Claude', running: true, current })
    const doneUnread = (id: string) =>
      session({ agent: 'codex', session_id: id, status: 'done', unread: true, title: `完成${id}` })

    it('★切到 Codex 并停留够久 → 对当时亮蓝点的会话逐条 POST /read', async () => {
      const calls: { url: string, body: unknown }[] = []
      const before = snapshot({
        dock: { stack: [codexTab(false), claudeTab(true)] },
        sessions: [doneUnread('d1'), doneUnread('d2')],
      })
      const after = snapshot({
        dock: { stack: [codexTab(true), claudeTab(false)] },
        sessions: [doneUnread('d1'), doneUnread('d2')],
      })
      render(
        <WorkbenchOverlay
          {...props({ state: before, fetchImpl: fetchSequence([before, after], calls) })}
          servicePollMs={POLL}
          dockDwellReadMs={DWELL}
        />,
      )

      await tick(0) // 第一拍:before
      await tick(POLL) // 第二拍:切到 Codex,停留计时开始
      await tick(DWELL)
      expect(calls.filter(c => c.url.endsWith('/read'))).toHaveLength(2)
      const bodies = calls.filter(c => c.url.endsWith('/read')).map(c => c.body)
      expect(bodies).toContainEqual({ agent: 'codex', session_id: 'd1' })
      expect(bodies).toContainEqual({ agent: 'codex', session_id: 'd2' })
    })

    /**
     * 窗口型的家(2026-09-26,卡 ST)。维护者 19:45:「一堆蓝色气泡,我点过了也不消失」。
     *
     * 核过的结论:**这条路客户端是对的** —— `sessionsOfTab` 早就按 `dock.bundles` 认登记表
     * (与卡 WS 修过的白点那一格 `agentIdsOfTab` 同一个办法),所以坞上的键是 `c-kimi`、
     * 登记表 id 是 `kimi` 也照样对得上,`/agents/read {id}` 真的发得出去。
     * 「点了不消失」的真因在服务端那一半:界面字 / 额度页 / App 标牌变了被当成「它回了一句」,
     * 他点掉、下一拍又亮(见 server-agent-window-model 里那一组)。这条用例把客户端这一半钉住,
     * 免得以后有人为了「修蓝点」来改这里。
     */
    it('★窗口型的家(坞上的键 c-kimi ≠ 登记表 id kimi):切过去停够 → 发 POST /agents/read {id}', async () => {
      const calls: { url: string, body: unknown }[] = []
      const kimiTab = (current: boolean) => ({ key: 'c-kimi', label: 'Kimi', running: true, current })
      const registry = (): NonNullable<WorkbenchState['agent_registry']> => ({
        entries: [{
          id: 'kimi', bundle_id: 'com.moonshot.kimi', name: 'Kimi', color: '#5b8cff',
          found: { how: 'patrol', at: '', basis: '' }, sources: [], status: 'idle', gaps: {},
          sessions: [{ agent: 'kimi', session_id: 'window:7d0d8c03', project: 'Kimi', status: 'done', unread: true, elapsed_sec: 60, updated_at: '2026-09-26T11:45:00.000Z', via: 'window', title: '检测树莓派连接' }],
          counts: { running: 0, waiting: 0, unread: 1 },
        }],
        asking: [], notices: [],
      })
      const before = snapshot({ dock: { stack: [kimiTab(false), claudeTab(true)], bundles: { 'c-kimi': 'com.moonshot.kimi' } }, agent_registry: registry() })
      const after = snapshot({ dock: { stack: [kimiTab(true), claudeTab(false)], bundles: { 'c-kimi': 'com.moonshot.kimi' } }, agent_registry: registry() })
      render(
        <WorkbenchOverlay
          {...props({ state: before, fetchImpl: fetchSequence([before, after], calls) })}
          servicePollMs={POLL}
          dockDwellReadMs={DWELL}
        />,
      )
      await tick(0)
      await tick(POLL) // 切到 Kimi
      await tick(DWELL)
      expect(calls.filter(c => c.url.endsWith('/agents/read'))).toHaveLength(1)
      expect(calls.filter(c => c.url.endsWith('/agents/read')).map(c => c.body)).toEqual([{ id: 'kimi' }])
      // 走的是窗口那一口,不是会话文件那一口(`/read`)。
      expect(calls.filter(c => c.url.endsWith('/read') && !c.url.endsWith('/agents/read'))).toHaveLength(0)
    })

    it('★停留不够就切走 → 一条 /read 都不发(路过式切换不算看过)', async () => {
      const calls: { url: string, body: unknown }[] = []
      const away = snapshot({
        dock: { stack: [codexTab(false), claudeTab(true)] },
        sessions: [doneUnread('d1')],
      })
      const onCodex = snapshot({
        dock: { stack: [codexTab(true), claudeTab(false)] },
        sessions: [doneUnread('d1')],
      })
      // 第二拍切到 Codex、第三拍立刻又切走——两拍间隔(10ms)远小于停留阈值(60ms)。
      render(
        <WorkbenchOverlay
          {...props({ state: away, fetchImpl: fetchSequence([away, onCodex, away], calls) })}
          servicePollMs={POLL}
          dockDwellReadMs={DWELL}
        />,
      )

      await tick(0) // away
      await tick(POLL) // onCodex:停留计时开始
      await tick(POLL) // away:只停了 10ms 就切走
      await tick(DWELL * 6)
      expect(calls.filter(c => c.url.endsWith('/read'))).toHaveLength(0)
    })

    it('★只清切过去那一刻已亮的;停留期间新完成的不顺手清掉', async () => {
      const calls: { url: string, body: unknown }[] = []
      const before = snapshot({
        dock: { stack: [codexTab(false), claudeTab(true)] },
        sessions: [doneUnread('old')],
      })
      const arrived = snapshot({
        dock: { stack: [codexTab(true), claudeTab(false)] },
        sessions: [doneUnread('old')],
      })
      // 停留期间又完成了一个 new——它不该被这一次"看过了"顺带清掉。
      const newDone = snapshot({
        dock: { stack: [codexTab(true), claudeTab(false)] },
        sessions: [doneUnread('old'), doneUnread('new')],
      })
      render(
        <WorkbenchOverlay
          {...props({ state: before, fetchImpl: fetchSequence([before, arrived, newDone], calls) })}
          servicePollMs={POLL}
          dockDwellReadMs={DWELL}
        />,
      )

      await tick(0) // before
      await tick(POLL) // arrived:切过去,停留计时开始
      await tick(POLL) // newDone:停留期间新完成一个
      await tick(DWELL)
      expect(calls.filter(c => c.url.endsWith('/read')).length).toBeGreaterThan(0)
      await tick(DWELL * 4)
      const bodies = calls.filter(c => c.url.endsWith('/read')).map(c => c.body)
      expect(bodies).toEqual([{ agent: 'codex', session_id: 'old' }])
    })

    it('★首屏就已经是 current(不是他刚切过去)→ 不清,别把没看过的替他灭掉', async () => {
      const calls: { url: string, body: unknown }[] = []
      const state = snapshot({
        dock: { stack: [codexTab(true), claudeTab(false)] },
        sessions: [doneUnread('d1')],
      })
      render(
        <WorkbenchOverlay
          {...props({ state, fetchImpl: fetchSequence([state], calls) })}
          servicePollMs={POLL}
          dockDwellReadMs={DWELL}
        />,
      )

      await tick(0)
      await tick(DWELL * 6)
      expect(calls.filter(c => c.url.endsWith('/read'))).toHaveLength(0)
    })

    it('切到的标签没有蓝点 → 一个请求都不发', async () => {
      const calls: { url: string, body: unknown }[] = []
      const before = snapshot({
        dock: { stack: [codexTab(false), claudeTab(true)] },
        sessions: [session({ agent: 'codex', session_id: 'r1', status: 'running' })],
      })
      const after = snapshot({
        dock: { stack: [codexTab(true), claudeTab(false)] },
        sessions: [session({ agent: 'codex', session_id: 'r1', status: 'running' })],
      })
      render(
        <WorkbenchOverlay
          {...props({ state: before, fetchImpl: fetchSequence([before, after], calls) })}
          servicePollMs={POLL}
          dockDwellReadMs={DWELL}
        />,
      )

      await tick(0)
      await tick(DWELL * 6)
      expect(calls.filter(c => c.url.endsWith('/read'))).toHaveLength(0)
    })
  })

  it('IM 未读(wechat/wecom)渲染成中性灰徽章,取自 state.badges,不是 sessions', async () => {
    const state = snapshot({
      // S4(review 修复,真机截图实证):tab.im 现在是服务端按 bundle_id 判定好写进
      // dock.view() 的字段——客户端不再靠 key==='wechat' 这种字符串比对(微信的 bundle
      // id 反复漂移,一旦漂移触发自愈注册,key 可能变成 c-<slug>,字符串比对会失配)。
      dock: { stack: [{ key: 'wechat', label: '微信', running: true, current: true, im: 'wechat' }] },
      badges: { wechat: 5 },
    })
    render(<WorkbenchOverlay {...props({ state })} />)

    await tick(0)
    const wechatTab = screen.getByRole('button', { name: '微信' }).closest('.ben-wb__dock-tab')
    const imBadge = wechatTab?.querySelector('[data-tone=im] .ben-wb__dock-badge-dot')
    expect(imBadge?.textContent).toBe('5')
  })

  it('S4(review,真机截图实证):微信被自愈注册成 c-<slug> 这样的自定义 key,徽章仍然靠 tab.im 认得出、正常渲染', async () => {
    // 真机复现的确切场景:微信的 bundle id 又漂移了一次,handleMoved 查不到基础键,
    // A2(b) 自愈注册把它记成一条自定义应用——key 因此不再是字面量 'wechat',但服务端
    // dock.view() 是按 bundle_id 判定 im 的,所以 im 字段依然正确标了 'wechat'。
    const state = snapshot({
      dock: { stack: [{ key: 'c-wechat', label: 'WeChat2', running: true, current: true, im: 'wechat' }] },
      badges: { wechat: 1 },
    })
    render(<WorkbenchOverlay {...props({ state })} />)

    await tick(0)
    const tab = screen.getByRole('button', { name: 'WeChat2' }).closest('.ben-wb__dock-tab')
    const imBadge = tab?.querySelector('[data-tone=im] .ben-wb__dock-badge-dot')
    expect(imBadge?.textContent).toBe('1')
  })

  it('badges[key] 为 0 或 null 时不渲染 IM 徽章(未接入/无未读都不该显示一个空圆点)', async () => {
    const state = snapshot({
      dock: { stack: [{ key: 'wecom', label: '企业微信', running: true, current: true, im: 'wecom' }] },
      badges: { wecom: 0 },
    })
    render(<WorkbenchOverlay {...props({ state })} />)

    await tick(0)
    const wecomTab = screen.getByRole('button', { name: '企业微信' }).closest('.ben-wb__dock-tab')
    expect(wecomTab?.querySelectorAll('.ben-wb__dock-badge-dot')).toHaveLength(0)
  })

  it('悬停气泡内容:列出该分类的会话(标题+耗时),IM 徽章显示「未读 N 条」', async () => {
    const state = snapshot({
      dock: { stack: [
        { key: 'claude', label: 'Claude', running: true, current: true },
        { key: 'wechat', label: '微信', running: true, current: false, im: 'wechat' },
      ] },
      sessions: [session({ agent: 'claude', session_id: 'w1', status: 'waiting', title: '要改 schema', elapsed_sec: 90 })],
      badges: { wechat: 3 },
    })
    render(<WorkbenchOverlay {...props({ state })} />)

    // 真机反馈修订:气泡不再常驻 DOM(靠 CSS :hover 显隐)——现在是鼠标移上圆点那一刻才
    // 挂载(position:fixed,坐标现算),不 hover 就查不到这个元素,得先触发一次 mouseEnter。
    await tick(0)
    const claudeTab = screen.getByRole('button', { name: 'Claude' }).closest('.ben-wb__dock-tab')
    const claudeBadge = claudeTab?.querySelector('[data-tone=waiting]')
    expect(claudeBadge).not.toBeNull()
    fireEvent.mouseEnter(claudeBadge!)
    const bubble = claudeBadge?.querySelector('.ben-wb__dock-badge-bubble')
    expect(bubble?.textContent).toContain('要改 schema')
    expect(bubble?.textContent).toContain('1 分 30 秒') // humanDuration(90) → 分/秒格式,不是纯秒数

    await tick(0)
    const wechatTab = screen.getByRole('button', { name: '微信' }).closest('.ben-wb__dock-tab')
    const wechatBadge = wechatTab?.querySelector('[data-tone=im]')
    expect(wechatBadge).not.toBeNull()
    fireEvent.mouseEnter(wechatBadge!)
    const imBubble = wechatBadge?.querySelector('.ben-wb__dock-badge-bubble')
    expect(imBubble?.textContent).toBe('未读 3 条')
  })

  it('真机反馈修订:气泡默认不挂载(不 hover 查不到),mouseLeave 后又卸载', async () => {
    const state = snapshot({
      dock: { stack: [{ key: 'wechat', label: '微信', running: true, current: true, im: 'wechat' }] },
      badges: { wechat: 2 },
    })
    render(<WorkbenchOverlay {...props({ state })} />)

    await tick(0)
    const tab = screen.getByRole('button', { name: '微信' }).closest('.ben-wb__dock-tab')
    const badge = tab?.querySelector('[data-tone=im]')
    expect(badge).not.toBeNull()
    expect(badge?.querySelector('.ben-wb__dock-badge-bubble')).toBeNull()

    fireEvent.mouseEnter(badge!)
    expect(badge?.querySelector('.ben-wb__dock-badge-bubble')).not.toBeNull()

    fireEvent.mouseLeave(badge!)
    expect(badge?.querySelector('.ben-wb__dock-badge-bubble')).toBeNull()
  })

  it('dsh 会话没有对应的 dock 标签,不渲染徽章(也不报错)', async () => {
    const state = snapshot({
      dock: { stack: [{ key: 'claude', label: 'Claude', running: true, current: true }] },
      sessions: [session({ agent: 'dsh', session_id: 'd1', status: 'waiting' })],
    })
    render(<WorkbenchOverlay {...props({ state })} />)

    await tick(0)
    const claudeTab = screen.getByRole('button', { name: 'Claude' }).closest('.ben-wb__dock-tab')
    expect(claudeTab?.querySelectorAll('.ben-wb__dock-badge-dot')).toHaveLength(0)
  })

  it('未知 agent/尚未接入应用键的会话不会让标签栏崩溃(不存在的键天然没有匹配的标签)', async () => {
    const state = snapshot({
      dock: { stack: [{ key: 'claude', label: 'Claude', running: true, current: true }] },
      sessions: [session({ agent: 'kimi', session_id: 'k1', status: 'waiting' })],
    })
    expect(() => render(<WorkbenchOverlay {...props({ state })} />)).not.toThrow()
    await tick(0)
    screen.getByRole('button', { name: 'Claude' })
  })

  // C1(review 修复):真机上气泡曾经被两层 overflow:hidden(标签本身 + .ben-wb__mod)裁没,
  // jsdom 的 textContent 断言测不出裁剪——只能靠钉住样式规则本身来防回归。
  it('style:标签不再靠 overflow:hidden 裁圆角', async () => {
    const { STYLE } = await import('../src/client/style.ts')
    expect(STYLE).toMatch(/\.ben-wb__dock-tab\{[^}]*border-radius:7px\}/)
    expect(STYLE).not.toMatch(/\.ben-wb__dock-tab\{[^}]*overflow:hidden/)
  })

  // 真机反馈修订(取代原来"朝下开、position:absolute"那版——被认领窗位的原生窗口整个
  // 盖住,肉眼看不见):气泡改 position:fixed,坐标由 JS 现算写成行内 style,不再是靠
  // 静态 CSS 的 top/bottom 摆位,这里改成钉住"是 fixed 定位,不是 absolute"。
  it('style:悬停气泡是 position:fixed(逃出标签/模块两层裁剪),不是 absolute', async () => {
    const { STYLE } = await import('../src/client/style.ts')
    expect(STYLE).toMatch(/\.ben-wb__dock-badge-bubble\{[^}]*position:fixed/)
    expect(STYLE).not.toMatch(/\.ben-wb__dock-badge-bubble\{[^}]*position:absolute/)
  })

  // 真机反馈(Ben):running 档要有别于其余三档的静态圆点——白色 + 周期性 opacity 渐变
  // 提示"这条还在跑",幅度别晃眼(1→0.45→1,周期约 2s)。
  it('style:running 档圆点是白色 + 呼吸闪烁动效(opacity keyframes,不晃眼)', async () => {
    const { STYLE } = await import('../src/client/style.ts')
    expect(STYLE).toMatch(
      /\.ben-wb__dock-badge\[data-tone=running\] \.ben-wb__dock-badge-dot\{[^}]*background:#fff[^}]*animation:ben-wb-dock-badge-breathe 2s/,
    )
    expect(STYLE).toMatch(/@keyframes ben-wb-dock-badge-breathe\{0%,100%\{opacity:1\}50%\{opacity:\.45\}\}/)
  })

  // 真机反馈(Ben):悬停气泡在真机上偏小,加大一档——字号 +2px、padding 1.5 倍、
  // max-width 放宽(配合 Workbench.tsx 里同步调大的 BUBBLE_HALF_WIDTH_ESTIMATE_PX)。
  it('style:悬停气泡加大一档——字号/内边距/最大宽度都比旧值(11px/6px 8px/无上限)更大', async () => {
    const { STYLE } = await import('../src/client/style.ts')
    expect(STYLE).toMatch(/\.ben-wb__dock-badge-bubble\{[^}]*padding:9px 12px/)
    expect(STYLE).toMatch(/\.ben-wb__dock-badge-bubble\{[^}]*max-width:260px/)
    expect(STYLE).toMatch(/\.ben-wb__dock-badge-bubble p\{[^}]*font-size:13px/)
  })

  // review 修复:running 档只覆盖了 background/border/animation,没覆盖 color——数字
  // 会吃基类 .ben-wb__dock-badge-dot 的 color:var(--dsw-alias-label-primary-foreground),
  // 那是配深色/饱和填色背景的浅色前景 token,盖在白底上大概率糊成看不清。白底必须显式
  // 配一个不随主题变浅的深色,不能指望继承基类的前景 token。
  it('style(review 修复):running 档圆点显式覆盖 color(白底不能吃基类的浅色前景 token)', async () => {
    const { STYLE } = await import('../src/client/style.ts')
    expect(STYLE).toMatch(
      /\.ben-wb__dock-badge\[data-tone=running\] \.ben-wb__dock-badge-dot\{[^}]*color:#1d1d1f/,
    )
  })

  // review 修复:气泡原来是 white-space:nowrap + max-width:260px 的组合——nowrap 会
  // 拒绝换行,超长标题(running 档还拼上「上次输出」后缀,更容易超)会把文字视觉撑出
  // 260px 的盒子,水平夹紧算的 130px 半宽假设就不成立了。改成不再 nowrap,行内文字改由
  // overflow-wrap:anywhere 兜底折行,max-width 才是真的上限。
  it('style(review 修复):气泡不再 white-space:nowrap,p 加 overflow-wrap:anywhere 让 max-width 真正生效', async () => {
    const { STYLE } = await import('../src/client/style.ts')
    expect(STYLE).not.toMatch(/\.ben-wb__dock-badge-bubble\{[^}]*white-space:nowrap/)
    expect(STYLE).toMatch(/\.ben-wb__dock-badge-bubble p\{[^}]*overflow-wrap:anywhere/)
  })
})

describe('窗位矩形上报(spec V3:挂载/布局变化立即上报,window resize 800ms 去抖)', () => {
  // 真机实证(2026-08-25 矩形上报只认壳内页面):发起这批上报的既有用例本来就是在模拟壳
  // 加载的那个页面(真机上唯一有资格上报窗位矩形的客户端)——ben-workbench=app 是壳内
  // 页面的身份标识(先例见 tests/client-slot-scenes.test.tsx「壳模式下不渲染返回对话」),
  // 这里统一挂上,不然这些用例会被下面新加的"只认壳内页面"门槛整批挡在外面。
  beforeEach(() => { window.history.replaceState(null, '', '/?ben-workbench=app') })
  afterEach(() => { window.history.replaceState(null, '', '/') })

  it('槽体挂载 → POST /slot/rect {rect} 取自 getBoundingClientRect', async () => {
    stubSlotRect({ x: 40, y: 900, width: 1360, height: 1200 })
    const calls: { url: string, body: unknown }[] = []
    // W4:补 current:true 的 dock tab——见 dockWithCurrent 注释。
    const state = snapshot({ dock: dockWithCurrent() })
    render(<WorkbenchOverlay {...props({ state, fetchImpl: fakeFetchRecording(state, calls) })} />)

    await settleMount()
    expect(calls.some(c => c.url.endsWith('/slot/rect'))).toBe(true)
    expect(calls.find(c => c.url.endsWith('/slot/rect'))?.body).toEqual({
      rect: { x: 40, y: 900, w: 1360, h: 1200 }, source: 'app',
    })
  })

  it('window resize → 去抖 800ms 后再次 POST /slot/rect,短时间内多次触发只落一次', async () => {
    stubSlotRect({ x: 0, y: 0, width: 100, height: 100 })
    const calls: { url: string, body: unknown }[] = []
    const state = snapshot({ dock: dockWithCurrent() })
    render(<WorkbenchOverlay {...props({ state, fetchImpl: fakeFetchRecording(state, calls) })} />)

    await settleMount()
    expect(calls.filter(c => c.url.endsWith('/slot/rect'))).toHaveLength(1)

    stubSlotRect({ x: 10, y: 10, width: 200, height: 200 })
    window.dispatchEvent(new Event('resize'))
    window.dispatchEvent(new Event('resize'))

    // 800ms 去抖期内不该有新请求(哪怕连发两次 resize)。
    await tick(300)
    expect(calls.filter(c => c.url.endsWith('/slot/rect'))).toHaveLength(1)

    // 去抖到期(800ms)+ 稳定性门重测(80ms)。
    await tick(DEBOUNCE_MS - 300 + GATE_MS)
    expect(calls.filter(c => c.url.endsWith('/slot/rect'))).toHaveLength(2)
    expect(calls.filter(c => c.url.endsWith('/slot/rect'))[1]?.body).toEqual({
      rect: { x: 10, y: 10, w: 200, h: 200 }, source: 'app',
    })
  })

  it('Workbench 卸载后 resize 监听器已清理,不再触发上报', async () => {
    stubSlotRect({ x: 0, y: 0, width: 100, height: 100 })
    const calls: { url: string, body: unknown }[] = []
    const state = snapshot({ dock: dockWithCurrent() })
    const { unmount } = render(<WorkbenchOverlay {...props({ state, fetchImpl: fakeFetchRecording(state, calls) })} />)

    await settleMount()
    expect(calls.filter(c => c.url.endsWith('/slot/rect'))).toHaveLength(1)

    unmount()
    window.dispatchEvent(new Event('resize'))

    await tick(900)
    expect(calls.filter(c => c.url.endsWith('/slot/rect'))).toHaveLength(1)
  })

  it('槽体不在(窗位模块被收起)→ 布局落定后 resize 量不到,静默不发新上报', async () => {
    stubSlotRect({ x: 0, y: 0, width: 100, height: 100 })
    const calls: { url: string, body: unknown }[] = []
    const state = snapshot({
      layout: {
        modules: [
          { id: 'projects', order: 0, basis_pct: 28 },
          { id: 'slot', order: 2, basis_pct: 44, hidden: true },
          { id: 'notes', order: 3, basis_pct: 8 },
        ],
        butler: { corner: 'br', min: false },
      },
    })
    render(<WorkbenchOverlay {...props({ state, fetchImpl: fakeFetchRecording(state, calls) })} />)

    // 首帧用的是本地默认布局(槽位可见)，量得到就会先报一次；等服务端回来的
    // 隐藏布局落定后(窗位模块从 DOM 消失)，槽体 ref 拿不到元素，之后的事件不该再发。
    // 用"窗口槽"标题消失做落定判据(不是"会话区"标题——那个默认/隐藏两种布局下都在,
    // 证明不了隐藏布局真的落地了),模块盒子化多包了一层 ModuleBox,这里改用更精确的
    // 判据避免时序竞争。
    // 去抖卡(2026-09-28):基线要等隐藏布局落定**连同它排下的一切**(I3 那次 {rect:null}
    // 清除、挂着的稳定性门)都落地之后再数——原来 waitFor 一看到标题消失就数,那次清除
    // 的 POST 偶尔晚半拍才到,被算成"resize 之后多发的一次"。
    await settleMount()
    expect(screen.queryByRole('heading', { name: '窗口槽' })).toBeNull()
    const before = calls.filter(c => c.url.endsWith('/slot/rect')).length

    window.dispatchEvent(new Event('resize'))
    await tick(900)

    expect(calls.filter(c => c.url.endsWith('/slot/rect'))).toHaveLength(before)
  })

  it('I3:窗位模块被收起 → POST /slot/rect {rect:null} 清除服务端上一次矩形', async () => {
    stubSlotRect({ x: 0, y: 0, width: 100, height: 100 })
    const calls: { url: string, body: unknown }[] = []
    const state = snapshot({
      layout: {
        modules: [
          { id: 'projects', order: 0, basis_pct: 28 },
          { id: 'slot', order: 2, basis_pct: 44, hidden: true },
          { id: 'notes', order: 3, basis_pct: 8 },
        ],
        butler: { corner: 'br', min: false },
      },
    })
    render(<WorkbenchOverlay {...props({ state, fetchImpl: fakeFetchRecording(state, calls) })} />)

    await settleMount()
    const nullPost = calls.find(c => c.url.endsWith('/slot/rect') && JSON.stringify(c.body) === JSON.stringify({ rect: null, source: 'app' }))
    expect(nullPost).toBeTruthy()
  })

  // 2026-08-25 版面重排:原来这条走的是"展开日历面板借占槽位"那条触发路径,日历整块
  // 下线后改用「收起窗口槽」这条同样让槽体整个卸载的真实用户动作——验的仍是 I3 本身
  // (槽体不在了,残留的旧矩形必须能失效,否则拖进/切换会贴到一块看不见的区域上)。
  it('I3:收起窗口槽(槽体卸载) → POST /slot/rect {rect:null}', async () => {
    stubSlotRect({ x: 0, y: 0, width: 100, height: 100 })
    const calls: { url: string, body: unknown }[] = []
    const state = snapshot({})
    render(<WorkbenchOverlay {...props({ state, fetchImpl: fakeFetchRecording(state, calls) })} />)
    await settleMount()
    screen.getByRole('heading', { name: '窗口槽' }) // 首帧就绪

    fireEvent.click(screen.getByRole('button', { name: '窗口槽 收起' }))

    await settleMount()
    const nullPost = calls.find(c => c.url.endsWith('/slot/rect') && JSON.stringify(c.body) === JSON.stringify({ rect: null, source: 'app' }))
    expect(nullPost).toBeTruthy()
  })

  it('I3:窗位模块从收起恢复可见 → 挂载 effect 自动用新测出的矩形重报(不再是 null)', async () => {
    stubSlotRect({ x: 5, y: 6, width: 200, height: 300 })
    const calls: { url: string, body: unknown }[] = []
    const state = snapshot({
      // W4:展开后要看到槽体真的重新挂载测出矩形——不补 current:true 的话「叠上没窗
      // 在台前」会被判定成 butlerActive,展开的是 iframe 不是槽体,永远量不到矩形。
      dock: dockWithCurrent(),
      layout: {
        modules: [
          { id: 'projects', order: 0, basis_pct: 28 },
          { id: 'slot', order: 2, basis_pct: 44, hidden: true },
          { id: 'notes', order: 3, basis_pct: 8 },
        ],
        butler: { corner: 'br', min: false },
      },
    })
    render(<WorkbenchOverlay {...props({ state, fetchImpl: fakeFetchRecording(state, calls) })} />)

    // 先等隐藏态那次 {rect:null} 清除落定。
    await settleMount()
    const nullPost = calls.find(c => c.url.endsWith('/slot/rect') && JSON.stringify(c.body) === JSON.stringify({ rect: null, source: 'app' }))
    expect(nullPost).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '窗口槽 展开' }))

    await settleMount()
    const realPost = calls.find(c => c.url.endsWith('/slot/rect')
      && JSON.stringify(c.body) === JSON.stringify({ rect: { x: 5, y: 6, w: 200, h: 300 }, source: 'app' }))
    expect(realPost).toBeTruthy()
  })

  it('真机验收:state.dock.stack.length 变化(标签栏出现,ResizeObserver 在 jsdom 里没有的后备触发)→ 重新量测并 POST /slot/rect', async () => {
    // jsdom 没有 ResizeObserver,真机上标签栏冒出来是靠它抓住槶体尺寸变化;这里用
    // dockStackLen 这条后备依赖项模拟同一条行为——认领前后槶体量出来的矩形不一样
    // (标签栏把槶体往下挤了),用一个可变下标切换 getBoundingClientRect 的返回值。
    let rectIndex = 0
    const rects = [
      { x: 40, y: 900, width: 1360, height: 1200 },
      { x: 40, y: 940, width: 1360, height: 1160 },
    ]
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(() => {
      const r = rects[rectIndex]!
      return { ...r, top: r.y, left: r.x, right: r.x + r.width, bottom: r.y + r.height, toJSON() {} } as DOMRect
    })

    const calls: { url: string, body: unknown }[] = []
    // W4:两份快照都补一个 current:true 的 claude tab,不再让 stateBefore 的 dock.stack
    // 是空数组——空数组会被 butlerActive 的派生公式(stack.every(tab => !tab.current))
    // 判定成"叠上没窗在台前"(空数组 .every 恒真),槽体因此整个不挂载、量不到矩形。
    // 这条用例本来要测的是 dockStackLen(0→1→2 均可)这条 ResizeObserver 后备依赖项,
    // 跟 butlerActive 无关——保持 claude 全程 current,只让 codex 后来加入把标签栏撑高。
    const stateBefore = snapshot({ dock: dockWithCurrent() })
    const stateAfter = snapshot({
      dock: {
        stack: [
          { key: 'claude', label: 'Claude', running: true, current: true },
          { key: 'codex', label: 'Codex', running: true, current: false },
        ],
      },
    })
    let pollCount = 0
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        calls.push({ url: String(url), body: init.body === undefined ? undefined : JSON.parse(String(init.body)) })
        return { ok: true, json: async () => ({ ok: true }) }
      }
      // 2026-09-17(账号登录):工作台挂载时还会问一次 /account —— 这条计数只数 /state 的轮询。
      // 别的 GET 一律回 404「没接」,免得把"第几拍"算错(账号没接时界面照旧直接是工作台)。
      if (!String(url).includes('/state')) return { ok: false, status: 404, json: async () => ({ error: '未启用' }) }
      pollCount++
      return { ok: true, json: async () => (pollCount === 1 ? stateBefore : stateAfter) }
    }) as unknown as typeof fetch

    // servicePollMs 要留出比稳定性门(SLOT_RECT_STABILITY_DELAY_MS=80ms)更宽的余量——
    // 被动上报的第一次 POST 现在要等一轮"重测确认稳定"才会发出,poll 太快的话第二轮
    // 轮询会在那次重测完成前就把 dockStackLen 翻成 1,提前把这个 effect 实例连同它
    // 挂起的重测计时器一起清掉,首次上报反而永远发不出去。
    render(<WorkbenchOverlay {...props({ state: stateBefore, fetchImpl })} servicePollMs={200} />)

    await settleMount()
    expect(calls.some(c => c.url.endsWith('/slot/rect'))).toBe(true)
    expect(calls.find(c => c.url.endsWith('/slot/rect'))?.body).toEqual({
      rect: { x: 40, y: 900, w: 1360, h: 1200 }, source: 'app',
    })

    // 下一次轮询会拿到 dock.stack.length:1→2 的新快照,槶体这时也真的量出了新尺寸。
    rectIndex = 1

    await tick(200 - GATE_MS) // 第二拍轮询
    await tick(GATE_MS)
    const later = calls.filter(c => c.url.endsWith('/slot/rect'))
    expect(later.some(c => JSON.stringify(c.body) === JSON.stringify({
      rect: { x: 40, y: 940, w: 1360, h: 1160 }, source: 'app',
    }))).toBe(true)
  })

  it('S2(a)(review,真机截图实证):服务端第一次响应到达之前(哪怕挂载完就有槽体)不上报矩形', async () => {
    stubSlotRect({ x: 40, y: 900, width: 1360, height: 1200 })
    const calls: { url: string, body: unknown }[] = []
    // 故意让 /state 一直不 resolve(模拟"第一次响应还没到达"这段窗口),POST 正常记录。
    let resolveState: ((value: { ok: boolean, json: () => Promise<WorkbenchState> }) => void) | undefined
    const fetchImpl = vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        calls.push({ url: String(url), body: init.body === undefined ? undefined : JSON.parse(String(init.body)) })
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) })
      }
      // 2026-09-17(账号登录):只让 /state 挂着不 resolve —— /account 照旧立刻回"没接",
      // 不然那个 deferred 会被后一条 GET 覆盖掉,resolveState 解的就不是 /state 那一条了。
      if (!String(url).includes('/state')) {
        return Promise.resolve({ ok: false, status: 404, json: async () => ({ error: '未启用' }) as never })
      }
      return new Promise<{ ok: boolean, json: () => Promise<WorkbenchState> }>((resolve) => { resolveState = resolve })
    }) as unknown as typeof fetch

    render(<WorkbenchOverlay {...props({ fetchImpl })} />)

    await tick(0)
    screen.getByRole('heading', { name: '窗口槽' }) // 首帧(本地 DEFAULT_LAYOUT)已经渲染完
    await tick(50) // 给"万一真上报了"留够反应时间
    expect(calls.filter(c => c.url.endsWith('/slot/rect'))).toHaveLength(0)

    // 服务端响应到达(不带自定义 layout,退回 DEFAULT_LAYOUT 也算"问过一次了")→ 这才
    // 开始报。补一个 current:true 的 dock tab(W4:不然「叠上没窗在台前」会被判定成
    // butlerActive,槽体改渲染 iframe,永远等不到这条真实测量结果)。
    resolveState?.({ ok: true, json: async () => snapshot({ dock: dockWithCurrent() }) })
    await settleMount()
    expect(calls.some(c => c.url.endsWith('/slot/rect'))).toBe(true)
  })

  it('S2(a)(review,真机截图实证):dock.note 渲染在槽体内部(.ben-wb__slot-body 的子元素),不是槽体上方的独立行——出现/消失不改变槽体的盒子结构', async () => {
    stubSlotRect({ x: 40, y: 900, width: 1360, height: 1200 })
    // W4:补一个 current:true 的 tab——note 渲染在 SlotZone 内部,SlotZone 只在
    // butlerActive===false(叠上有窗在台前)那一支才挂载。
    const state = snapshot({
      dock: { stack: [{ key: 'claude', label: 'Claude', running: true, current: true }], note: '切换失败:窗口未找到' },
    })
    render(<WorkbenchOverlay {...props({ state })} />)

    await tick(0)
    const note = screen.getByText('切换失败:窗口未找到')
    const slotBody = document.querySelector('.ben-wb__slot-body')
    expect(slotBody).not.toBeNull()
    expect(slotBody?.contains(note)).toBe(true) // 挂在槽体内部,不是槽体的兄弟/祖先元素
  })

  it('S2(a)(review,真机截图实证):dock.note 出现/消失(轮询前后)不触发额外的 /slot/rect 上报', async () => {
    stubSlotRect({ x: 40, y: 900, width: 1360, height: 1200 })
    const calls: { url: string, body: unknown }[] = []
    const stateWithNote = snapshot({ dock: { stack: [], note: '切换失败:窗口未找到' } })
    const stateWithoutNote = snapshot({ dock: { stack: [] } })
    let pollCount = 0
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        calls.push({ url: String(url), body: init.body === undefined ? undefined : JSON.parse(String(init.body)) })
        return { ok: true, json: async () => ({ ok: true }) }
      }
      // 2026-09-17(账号登录):工作台挂载时还会问一次 /account —— 这条计数只数 /state 的轮询。
      // 别的 GET 一律回 404「没接」,免得把"第几拍"算错(账号没接时界面照旧直接是工作台)。
      if (!String(url).includes('/state')) return { ok: false, status: 404, json: async () => ({ error: '未启用' }) }
      pollCount++
      return { ok: true, json: async () => (pollCount === 1 ? stateWithNote : stateWithoutNote) }
    }) as unknown as typeof fetch

    render(<WorkbenchOverlay {...props({ state: stateWithNote, fetchImpl })} servicePollMs={20} />)

    await settleMount()
    expect(calls.some(c => c.url.endsWith('/slot/rect'))).toBe(true)
    const before = calls.filter(c => c.url.endsWith('/slot/rect')).length

    // 等下一次轮询把 note 从"有"变"没有"——dockStackLen/scenesLen 两个依赖项都没变
    // (stack 一直是空数组),不应该触发这个 effect 重新量测/上报。
    await tick(20)
    expect(screen.queryByText('切换失败:窗口未找到')).toBeNull()
    await tick(300) // 给"万一真的多报了"留够反应时间

    expect(calls.filter(c => c.url.endsWith('/slot/rect'))).toHaveLength(before)
  })

  it('S5(review,真机截图实证):/state 回 stale:true(页面态瞬断,轮询失败退回的占位快照)→ 完全不上报矩形', async () => {
    // 根因:轮询漏一拍/DSH 重启/WS 抖一下都会让 useWorkbenchState 退回 stale 空快照——
    // 这段时间里标签栏/滚动条可能瞬间不渲染,槽体测出的矩形是假的(跳到模块顶部),连量
    // 都不该量,更不该上报,不然存的 slotRect 会被这条假值污染,之后哪怕 reason:'resize'
    // 跟随重贴也会用错矩形。保守到底:state.stale 时干脆不发这次 POST。
    stubSlotRect({ x: 40, y: 900, width: 1360, height: 1200 })
    const calls: { url: string, body: unknown }[] = []
    // W4:补一个 current:true 的 dock tab——不然 stale:true 这份快照本身也会被判定成
    // "叠上没窗在台前"(dock 缺省),混进另一条 butlerActive 触发的 {rect:null} 清除,
    // 干扰这条用例本来要测的"state.stale 时测量 effect 完全不上报"这件事。
    const state = snapshot({ stale: true, dock: dockWithCurrent() })
    render(<WorkbenchOverlay {...props({ state, fetchImpl: fakeFetchRecording(state, calls) })} />)

    await tick(0)
    screen.getByRole('heading', { name: '窗口槽' }) // 首帧(本地 DEFAULT_LAYOUT)照常渲染
    await tick(300) // 给"万一真上报了"留够反应时间——包含首次响应落定
    expect(calls.filter(c => c.url.endsWith('/slot/rect'))).toHaveLength(0)
  })

  it('S5(review,真机截图实证):dock 曾经认领过、下一轮轮询整个 dock 字段消失(不是空数组)→ 那一轮不上报', async () => {
    // 跟上面 stale:true 是同一类根因的另一种表现:有的过渡态不设 stale,而是让
    // dock 字段整个从响应里消失(轮询用的是"上一次已知状态"退回逻辑的另一分支)——
    // 单看 dockStackLen(0)分辨不出"从没认领过"和"认领过但这一拍丢了",必须记住
    // "曾经非空过"这个历史事实(dockEverAdoptedRef)才挡得住。
    stubSlotRect({ x: 40, y: 900, width: 1360, height: 1200 })
    const calls: { url: string, body: unknown }[] = []
    const stateAdopted = snapshot({ dock: { stack: [{ key: 'claude', label: 'Claude', running: true, current: true }] } })
    const stateDockGone = snapshot({}) // dock 字段整个不带,不是 { dock: { stack: [] } }
    let pollCount = 0
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        calls.push({ url: String(url), body: init.body === undefined ? undefined : JSON.parse(String(init.body)) })
        return { ok: true, json: async () => ({ ok: true }) }
      }
      // 2026-09-17(账号登录):工作台挂载时还会问一次 /account —— 这条计数只数 /state 的轮询。
      // 别的 GET 一律回 404「没接」,免得把"第几拍"算错(账号没接时界面照旧直接是工作台)。
      if (!String(url).includes('/state')) return { ok: false, status: 404, json: async () => ({ error: '未启用' }) }
      pollCount++
      return { ok: true, json: async () => (pollCount === 1 ? stateAdopted : stateDockGone) }
    }) as unknown as typeof fetch

    // servicePollMs 留出比稳定性门(SLOT_RECT_STABILITY_DELAY_MS=80ms)更宽的余量——理由
    // 同上面"真机验收"用例:poll 太快会在第一次被动上报的重测计时器完成前就把 dockStackLen
    // 从 1 翻回 0,提前清掉那个 effect 实例,首次上报永远发不出去。
    render(<WorkbenchOverlay {...props({ state: stateAdopted, fetchImpl })} servicePollMs={200} />)

    // 先等第一轮(dock.stack 非空)落定的那次上报出现,确认 dockEverAdoptedRef 真的被
    // 点亮了。
    await settleMount()
    expect(calls.some(c => c.url.endsWith('/slot/rect'))).toBe(true)
    const before = calls.filter(c => c.url.endsWith('/slot/rect')).length

    // 等下一轮轮询把 dock 字段整个吃掉——dockStackLen 0→0(不触发依赖项变化的那条路),
    // 但即便某种时序巧合触发了这个 effect 重跑,也不该量测/上报。dockEverAdoptedRef
    // 曾经点亮过之后 dock 又消失属于"过渡态"(dockUnknown),round 2/3 的修复已经让
    // butlerActive 不为此翻转、I3 清除 effect 也不为此额外发 {rect:null}——这里不需要
    // 再额外过滤什么,直接统计全部 /slot/rect 调用即可。
    await tick(300) // 覆盖第二拍轮询(200ms)及其后的稳定性门
    expect(calls.filter(c => c.url.endsWith('/slot/rect'))).toHaveLength(before)
  })
})

describe('矩形上报只认壳内页面(2026-08-25 真机实证:壳内 WKWebView、Chrome 里开的工作台标签、浏览器窗格各自按自己的视口量矩形并上报,互相矛盾的合法值交替覆盖会把窗位贴合位置搞乱)', () => {
  afterEach(() => { window.history.replaceState(null, '', '/') })

  it('不在壳内(URL 不带 ben-workbench=app)→ 挂载、window resize 都不 POST /slot/rect', async () => {
    stubSlotRect({ x: 40, y: 900, width: 1360, height: 1200 })
    const calls: { url: string, body: unknown }[] = []
    const state = snapshot({})
    render(<WorkbenchOverlay {...props({ state, fetchImpl: fakeFetchRecording(state, calls) })} />)

    await tick(0)
    screen.getByRole('heading', { name: '窗口槽' }) // 首帧渲染完成
    await tick(300) // 给"万一真上报了"留够反应时间
    expect(calls.filter(c => c.url.endsWith('/slot/rect'))).toHaveLength(0)

    // 浏览器里随手开的工作台标签也会经历 resize/去抖这条路径,但整个不该打这条服务——
    // 它的视口矩形对壳所在屏幕毫无意义,发了就是错的、会覆盖壳内页面刚报的真值。
    stubSlotRect({ x: 10, y: 10, width: 200, height: 200 })
    window.dispatchEvent(new Event('resize'))
    await tick(900)
    expect(calls.filter(c => c.url.endsWith('/slot/rect'))).toHaveLength(0)
  })

  it('不在壳内 → 拖拽窗口槽底边把手松手(handleModuleResizeEnd 的显式补发路径)也不 POST /slot/rect', async () => {
    stubSlotRect({ x: 0, y: 0, width: 100, height: 100 })
    const calls: { url: string, body: unknown }[] = []
    const state = snapshot({})
    render(<WorkbenchOverlay {...props({ state, fetchImpl: fakeFetchRecording(state, calls) })} />)
    await tick(0)
    screen.getByRole('heading', { name: '窗口槽' }) // 首帧就绪

    // 三处上报点(挂载/被动上报 effect、I3 清除 effect、这处拖把手松手的显式补发)
    // 唯独这处此前没有非壳内负向断言——拖拽本身照常触发 layout 变化,但松手那一刻
    // 的显式补发不该无视 shellMode 门槛,径直打这条服务。
    const handle = screen.getByLabelText('窗口槽 调整高度')
    fireEvent.pointerDown(handle, { clientY: 100, pointerId: 1 })
    fireEvent.pointerMove(handle, { clientY: 220, pointerId: 1 })
    fireEvent.pointerUp(handle, { pointerId: 1 })

    await tick(300) // 给"万一真上报了"留够反应时间
    expect(calls.filter(c => c.url.endsWith('/slot/rect'))).toHaveLength(0)
  })

  it('不在壳内 → 窗位隐藏也不 POST /slot/rect {rect:null} 清除', async () => {
    stubSlotRect({ x: 0, y: 0, width: 100, height: 100 })
    const calls: { url: string, body: unknown }[] = []
    const state = snapshot({})
    render(<WorkbenchOverlay {...props({ state, fetchImpl: fakeFetchRecording(state, calls) })} />)
    await tick(0)
    screen.getByRole('heading', { name: '窗口槽' }) // 首帧就绪

    fireEvent.click(screen.getByRole('button', { name: '窗口槽 收起' }))

    await tick(300) // 给"万一真发了清除"留够反应时间
    expect(calls.filter(c => c.url.endsWith('/slot/rect'))).toHaveLength(0)
  })

  it('壳内页面(search 带 ?ben-workbench=app)→ POST /slot/rect body 带 source:"app"', async () => {
    window.history.replaceState(null, '', '/?ben-workbench=app')
    stubSlotRect({ x: 40, y: 900, width: 1360, height: 1200 })
    const calls: { url: string, body: unknown }[] = []
    // W4:补一个 current:true 的 dock tab——不然 dock 缺省会被判定成"叠上没窗在台前",
    // 槽体改渲染 iframe,永远量不到矩形。
    const state = snapshot({ dock: dockWithCurrent() })
    render(<WorkbenchOverlay {...props({ state, fetchImpl: fakeFetchRecording(state, calls) })} />)

    await settleMount()
    expect(calls.some(c => c.url.endsWith('/slot/rect'))).toBe(true)
    expect(calls.find(c => c.url.endsWith('/slot/rect'))?.body).toEqual({
      rect: { x: 40, y: 900, w: 1360, h: 1200 }, source: 'app',
    })
  })

  it('壳内页面(hash 带 #ben-workbench=app,DSH 客户端路由可能吃掉 search)→ 同样 POST', async () => {
    window.history.replaceState(null, '', '/#ben-workbench=app')
    stubSlotRect({ x: 40, y: 900, width: 1360, height: 1200 })
    const calls: { url: string, body: unknown }[] = []
    const state = snapshot({ dock: dockWithCurrent() })
    render(<WorkbenchOverlay {...props({ state, fetchImpl: fakeFetchRecording(state, calls) })} />)

    await settleMount()
    expect(calls.some(c => c.url.endsWith('/slot/rect'))).toBe(true)
    expect(calls.find(c => c.url.endsWith('/slot/rect'))?.body).toEqual({
      rect: { x: 40, y: 900, w: 1360, h: 1200 }, source: 'app',
    })
  })
})

describe('拖拽悬停高亮(悬停高亮 v1:页面 1s 轮询做不了实时反馈,靠壳侧事件驱动经 /live 推送)', () => {
  it('WS 收到 {kind:hover,inside:true} → 槽体 data-hover=true,提示文案「松手认领到窗位」可见', async () => {
    const hoverSocket = fakeHoverSocket()
    // W4:补一个 current:true 的 dock tab——悬停高亮的 data-hover/提示文案都挂在槽体
    // (.ben-wb__slot-body,SlotZone 内部)上,SlotZone 只在 butlerActive===false(叠上
    // 有窗在台前)那一支才挂载。
    const state = snapshot({ dock: dockWithCurrent() })
    render(<WorkbenchOverlay {...props({ state, webSocketImpl: hoverSocket.factory })} />)

    await tick(0)
    screen.getByRole('heading', { name: '窗口槽' }) // 等首帧就绪,此时 WS 已经开好
    expect(hoverSocket.instances).toHaveLength(1)

    expect(screen.queryByText('松手认领到窗位')).toBeNull() // 悬停之前不挂载提示文案

    hoverSocket.instances[0]?.send({ kind: 'hover', inside: true })

    await tick(0)
    expect(screen.getByText('松手认领到窗位')).toBeInTheDocument()
    const slotBody = document.querySelector('.ben-wb__slot-body')
    expect(slotBody?.getAttribute('data-hover')).toBe('true')
  })

  it('随后收到 {kind:hover,inside:false} → data-hover=false,提示文案消失', async () => {
    const hoverSocket = fakeHoverSocket()
    // W4:补一个 current:true 的 dock tab——悬停高亮的 data-hover/提示文案都挂在槽体
    // (.ben-wb__slot-body,SlotZone 内部)上,SlotZone 只在 butlerActive===false(叠上
    // 有窗在台前)那一支才挂载。
    const state = snapshot({ dock: dockWithCurrent() })
    render(<WorkbenchOverlay {...props({ state, webSocketImpl: hoverSocket.factory })} />)
    await tick(0)
    screen.getByRole('heading', { name: '窗口槽' })

    hoverSocket.instances[0]?.send({ kind: 'hover', inside: true })
    await tick(0)
    expect(screen.getByText('松手认领到窗位')).toBeInTheDocument()

    hoverSocket.instances[0]?.send({ kind: 'hover', inside: false })

    await tick(0)
    expect(screen.queryByText('松手认领到窗位')).toBeNull()
    const slotBody = document.querySelector('.ben-wb__slot-body')
    expect(slotBody?.getAttribute('data-hover')).toBe('false')
  })

  it('别的 kind(snapshot/ring/...)原样忽略,不点亮悬停高亮', async () => {
    const hoverSocket = fakeHoverSocket()
    // W4:补一个 current:true 的 dock tab——悬停高亮的 data-hover/提示文案都挂在槽体
    // (.ben-wb__slot-body,SlotZone 内部)上,SlotZone 只在 butlerActive===false(叠上
    // 有窗在台前)那一支才挂载。
    const state = snapshot({ dock: dockWithCurrent() })
    render(<WorkbenchOverlay {...props({ state, webSocketImpl: hoverSocket.factory })} />)
    await tick(0)
    screen.getByRole('heading', { name: '窗口槽' })

    hoverSocket.instances[0]?.send({ kind: 'snapshot', state })
    hoverSocket.instances[0]?.send({ kind: 'ring', agent: 'dsh', session_id: 'x' })
    hoverSocket.instances[0]?.send('不是 JSON 对象,是个裸字符串')

    await tick(30)
    expect(screen.queryByText('松手认领到窗位')).toBeNull()
    const slotBody = document.querySelector('.ben-wb__slot-body')
    expect(slotBody?.getAttribute('data-hover')).toBe('false')
  })

  it('断线(onclose)后 3s 内重连一次;卸载时关闭连接、不再重连', async () => {
    vi.useFakeTimers()
    try {
      const hoverSocket = fakeHoverSocket()
      const state = snapshot({})
      const { unmount } = render(<WorkbenchOverlay {...props({ state, webSocketImpl: hoverSocket.factory })} />)
      await vi.waitFor(() => expect(hoverSocket.instances).toHaveLength(1))

      hoverSocket.instances[0]?.triggerClose()
      await vi.advanceTimersByTimeAsync(3000)

      expect(hoverSocket.instances).toHaveLength(2) // 断线后 3s 重连了一次

      // 第二次也断——不该再重连第三次(只重试一次,不是无限重连)。
      hoverSocket.instances[1]?.triggerClose()
      await vi.advanceTimersByTimeAsync(5000)
      expect(hoverSocket.instances).toHaveLength(2)

      unmount()
      expect(hoverSocket.instances[1]?.closeCalls).toBeGreaterThan(0) // 卸载时关掉了当前连接
    }
    finally {
      vi.useRealTimers()
    }
  })
})

describe('模块盒子化 W-C(真机反馈联动收尾):拖拽窗口槽底边手柄调高 → 触发新一次 /slot/rect', () => {
  // 真机实证(2026-08-25 矩形上报只认壳内页面):同上,这些用例模拟的是壳内页面。
  beforeEach(() => { window.history.replaceState(null, '', '/?ben-workbench=app') })
  afterEach(() => { window.history.replaceState(null, '', '/') })

  it('既有 layout 依赖路径覆盖拖拽调高——不依赖 jsdom 没有的 ResizeObserver', async () => {
    stubSlotRect({ x: 0, y: 0, width: 100, height: 100 })
    const calls: { url: string, body: unknown }[] = []
    // W4:补一个 current:true 的 dock tab——拖拽调高松手那一刻的显式补发要靠 slotBodyRef
    // 真的挂在 SlotZone 上才测得到,不然「叠上没窗在台前」会被判定成 butlerActive,
    // 槽体改渲染 iframe,ref 拿不到元素。
    const state = snapshot({ dock: dockWithCurrent() })
    render(<WorkbenchOverlay {...props({ state, fetchImpl: fakeFetchRecording(state, calls) })} />)

    await settleMount()
    expect(calls.some(c => c.url.endsWith('/slot/rect'))).toBe(true)
    const before = calls.filter(c => c.url.endsWith('/slot/rect')).length

    const handle = screen.getByLabelText('窗口槽 调整高度')
    fireEvent.pointerDown(handle, { clientY: 100, pointerId: 1 })
    fireEvent.pointerMove(handle, { clientY: 220, pointerId: 1 })
    fireEvent.pointerUp(handle, { pointerId: 1 })
    await settleMount() // 松手的显式补发 + layout 联动那次被动上报(若有)都落地

    // 拖拽改的是 layout state,而 /slot/rect 上报的 effect 本来就吃 layout 这个依赖项
    // (先例见 Workbench.tsx 那个 effect 的依赖数组)——服务端已经会对新矩形做跟随重贴,
    // 这里只确认客户端这一半的联动确实触发了,不重复断言服务端逻辑(dock.ts 已有专门测试)。
    expect(calls.filter(c => c.url.endsWith('/slot/rect')).length).toBeGreaterThan(before)

    // S5:拖拽窗位模块把手松手是"明确的用户动作",这次(以及/或紧随其后的 layout 变化
    // 联动那次)/slot/rect 上报必须带 reason:'resize'——不然服务端不会跟随重贴,窗口
    // 停在拖拽前的旧位置上,真机上就是"调高了槽位、窗口却没跟着长高"这条 bug。
    const resizePost = calls.find(c => c.url.endsWith('/slot/rect')
      && (c.body as { reason?: string } | undefined)?.reason === 'resize')
    expect(resizePost).toBeTruthy()
  })
})

describe('稳定性门(2026-08-25 真机实证):被动上报路径 POST 前的双测一致校验', () => {
  // 真机根因:页面瞬态重排(项目区短暂缺席导致行高骤降)量出的单帧矩形此前被无条件存储,
  // 之后每次切换标签都会把窗口贴到这个错误位置——延迟发作,很难现场抓。这里在被动路径
  // (不带 reason 的 reportSlotRect)真正 POST 前补一道门:隔约 80ms(SLOT_RECT_STABILITY_
  // DELAY_MS)重测一次,两次矩形四边都在 8px 内才当真、才 POST;不稳定就整次丢弃。
  //
  // 用 window resize(800ms 去抖)而不是挂载时机来触发被动路径,把矩形变化卡在"第一测
  // 已经发生(800ms)、第二测还没发生(880ms)"的那个 80ms 缝隙里。
  //
  // 去抖卡(2026-09-28):原来这里写的是"800ms 去抖给了足够宽裕的真实时间,不需要 fake
  // timers"——真机一忙,真实的 sleep(850) 就会睡过 880ms,重测已经量完、毒矩形被判稳定
  // 发了出去,这条随机翻红。现在整组走假时钟(见 useFakeClock),缝隙是精确的。

  // 真机实证(2026-08-25 矩形上报只认壳内页面):同上,这些用例模拟的是壳内页面。
  beforeEach(() => { window.history.replaceState(null, '', '/?ben-workbench=app') })
  afterEach(() => { window.history.replaceState(null, '', '/') })

  it('两帧矩形不一致(模拟瞬态重排的毒矩形)→ 稳定性门判定不稳定,整次丢弃,不 POST', async () => {
    stubSlotRect({ x: 0, y: 0, width: 100, height: 100 })
    const calls: { url: string, body: unknown }[] = []
    // W4:补一个 current:true 的 dock tab——不然「叠上没窗在台前」会被判定成
    // butlerActive,槽体改渲染 iframe,ref 拿不到元素,这条用例原本要测的稳定性门
    // 逻辑压根没有机会跑到。
    const state = snapshot({ dock: dockWithCurrent() })
    render(<WorkbenchOverlay {...props({ state, fetchImpl: fakeFetchRecording(state, calls) })} />)

    await settleMount()
    expect(calls.some(c => c.url.endsWith('/slot/rect'))).toBe(true)
    const before = calls.filter(c => c.url.endsWith('/slot/rect')).length

    // 800ms 去抖到期后的"第一测"会用这个矩形——瞬态重排产生的毒矩形。
    stubSlotRect({ x: 40, y: 600, width: 1420, height: 900 })
    window.dispatchEvent(new Event('resize'))

    // 去抖(800ms)到期、第一测已经发生,但稳定性门的重测(+80ms)还没发生的这个窗口内,
    // 把矩形切成一个跟第一测明显不同(四边差远超 8px)的值,模拟"页面下一帧就变回去了"。
    await tick(850)
    stubSlotRect({ x: 40, y: 900, width: 1360, height: 1200 })

    // 给稳定性门的重测(80ms)留够时间,确认它没有因为矩形"看起来变了"就照样 POST。
    await tick(200)
    expect(calls.filter(c => c.url.endsWith('/slot/rect'))).toHaveLength(before)
  })

  it('两帧矩形一致(真的稳定)→ 稳定性门放行,POST 携带该矩形', async () => {
    stubSlotRect({ x: 0, y: 0, width: 100, height: 100 })
    const calls: { url: string, body: unknown }[] = []
    const state = snapshot({ dock: dockWithCurrent() })
    render(<WorkbenchOverlay {...props({ state, fetchImpl: fakeFetchRecording(state, calls) })} />)

    await settleMount()
    expect(calls.some(c => c.url.endsWith('/slot/rect'))).toBe(true)
    const before = calls.filter(c => c.url.endsWith('/slot/rect')).length

    // 全程保持同一个矩形——第一测与稳定性门的重测量到的是同一份值,理应判定稳定并放行。
    stubSlotRect({ x: 40, y: 900, width: 1360, height: 1200 })
    window.dispatchEvent(new Event('resize'))

    await tick(DEBOUNCE_MS + GATE_MS) // 800ms 去抖 + 80ms 稳定性门
    const after = calls.filter(c => c.url.endsWith('/slot/rect'))
    expect(after.length).toBeGreaterThan(before)
    expect(after.at(-1)?.body).toEqual({ rect: { x: 40, y: 900, w: 1360, h: 1200 }, source: 'app' })
  })

  it('reason:"resize" 路径(拖把手松手/slot basis 变化)不经过稳定性门——测一次就直接 POST,不会被随后的矩形变化连累丢弃', async () => {
    stubSlotRect({ x: 0, y: 0, width: 100, height: 100 })
    const calls: { url: string, body: unknown }[] = []
    const state = snapshot({ dock: dockWithCurrent() })
    render(<WorkbenchOverlay {...props({ state, fetchImpl: fakeFetchRecording(state, calls) })} />)
    await settleMount()
    expect(calls.some(c => c.url.endsWith('/slot/rect'))).toBe(true)

    const RECT_AT_DRAG = { x: 10, y: 10, width: 300, height: 300 }
    stubSlotRect(RECT_AT_DRAG)
    const handle = screen.getByLabelText('窗口槽 调整高度')
    fireEvent.pointerDown(handle, { clientY: 100, pointerId: 1 })
    fireEvent.pointerMove(handle, { clientY: 220, pointerId: 1 }) // 触发 layout 变化→basisChanged
    fireEvent.pointerUp(handle, { pointerId: 1 }) // 触发 handleModuleResizeEnd 的显式补发

    // 松手后立刻把矩形换成一个跟拖拽时明显不同的值——如果 reason:'resize' 路径错误地
    // 也经过了稳定性门(延迟重测),重测会读到这个新值,跟第一次量到的 RECT_AT_DRAG
    // 差远超 8px 阈值,POST 就会被判定"不稳定"整个丢弃或者被换成这个新值。
    stubSlotRect({ x: 999, y: 999, width: 5, height: 5 })

    await tick(0) // 不拨时钟:reason:'resize' 是立即 POST,不该等任何计时器
    {
      const resizePosts = calls.filter(c => c.url.endsWith('/slot/rect')
        && (c.body as { reason?: string } | undefined)?.reason === 'resize')
      expect(resizePosts.length).toBeGreaterThan(0)
      resizePosts.forEach((post) => {
        expect(post.body).toMatchObject({ rect: { x: 10, y: 10, w: 300, h: 300 }, reason: 'resize' })
      })
    }

    // 稳定性门的延迟窗口(80ms)过去之后,确认没有迟到的、被后来那个矩形污染的 reason:
    // 'resize' POST 冒出来——证明这条路径全程没有排过重测计时器。
    await tick(150)
    const resizePosts = calls.filter(c => c.url.endsWith('/slot/rect')
      && (c.body as { reason?: string } | undefined)?.reason === 'resize')
    resizePosts.forEach((post) => {
      expect(post.body).toMatchObject({ rect: { x: 10, y: 10, w: 300, h: 300 } })
    })
  })

  it('评审(计时器生命周期):拖拽其它模块把手期间被动上报被推迟(矩形还在动,不 POST),停顿后稳定性门仍补发最终矩形', async () => {
    // 上报 effect 的依赖含 layout 这类拖拽期间每次 pointermove 都变的值——评审关注的
    // 风险是:挂起的稳定性门计时器的生死要是被这类高频依赖抖动牵着走(cleanup 一律清、
    // 或"已有门就跳过"这类朴素写法),整段拖拽结束后最终矩形就可能再也发不出来。这条
    // 测试钉死两半语义:
    //   1) 拖拽进行中(槽体矩形每步都差出 8px 阈值)被动上报被推迟——不 POST 中间态;
    //   2) 手一停(矩形定格),稳定性门重测确认后仍然要把最终矩形补发出去,不能丢。
    //
    // 拖拽时序段用假时钟,而不是本 describe 其它用例的真实 setTimeout+waitFor:这条要
    // 卡的是"相邻 pointermove 间隔(25ms)始终小于稳定性门窗口(80ms),且最后一次 move
    // 落在第一步排起的那个门的窗口之内"这样一条精确到几十毫秒的时序——真实时钟下 jsdom
    // 事件开销的抖动足以把最后一次 move 漂到 80ms 之外,让"末帧矩形被旧门连累丢失"
    // 这类回归恰好溜过断言。(去抖卡 2026-09-28:挂载落定那段原来仍走真实时钟+waitFor,
    // 现在整组从 render 之前就是假时钟,挂载也由 settleMount 精确推进,见 useFakeClock。)
    stubSlotRect({ x: 0, y: 0, width: 100, height: 100 })
    const calls: { url: string, body: unknown }[] = []
    // 合并注(2026-08-26):原来这里是 snapshot({})。W4 之后 dock **整个缺省**会被
    // butlerActive 派生算成"事务官在台前"(见 Workbench.tsx 那段推导),槽体因此不挂载,
    // 量不到矩形也就没有任何 POST——这条用例要测的是稳定性门,不是"没接 dockService
    // 时画什么",所以补一个 current:true 的 dock tab 把槽体摆出来(同本文件其它用例)。
    const state = snapshot({ dock: dockWithCurrent() })
    render(<WorkbenchOverlay {...props({ state, fetchImpl: fakeFetchRecording(state, calls) })} />)

    // 挂载那次被动上报走完稳定性门(80ms)落定,作为后续"没有新 POST"断言的基线。
    await settleMount()
    expect(calls.some(c => c.url.endsWith('/slot/rect'))).toBe(true)
    const before = calls.filter(c => c.url.endsWith('/slot/rect')).length

    try {
      // 拖的是项目区(不是窗口槽)的把手:resizeModule 只改被拖模块自己的 basis_pct,
      // slot 的 basis 不变→不走 reason:'resize' 立即路径,全程都是被动上报,正好对准
      // 稳定性门。每步把槽体矩形往下挪 20px(> 8px 稳定阈值),模拟真实拖拽中槽体被
      // 上方模块连续挤压。
      const handle = screen.getByLabelText('项目区 调整高度')
      fireEvent.pointerDown(handle, { clientY: 100, pointerId: 7 })
      const dragRects = [
        { x: 0, y: 20, width: 100, height: 100 },
        { x: 0, y: 40, width: 100, height: 100 },
        { x: 0, y: 60, width: 100, height: 100 },
        { x: 0, y: 80, width: 100, height: 100 },
      ]
      for (const [step, rect] of dragRects.entries()) {
        stubSlotRect(rect)
        fireEvent.pointerMove(handle, { clientY: 110 + step * 10, pointerId: 7 })
        if (step < dragRects.length - 1) await vi.advanceTimersByTimeAsync(25)
      }
      // 断言点卡在最后一次 pointerMove 刚发生之后(拖拽开始后的虚拟时刻 75ms,任何一个
      // 门都还没到点):拖拽期间矩形一直不稳定,不该有任何新的 /slot/rect POST——既不该
      // 发中间态,也不该发抢跑的"最终值"。
      expect(calls.filter(c => c.url.endsWith('/slot/rect'))).toHaveLength(before)

      // 手停住(矩形定格在最终值)→ 稳定性门重测确认一致后补发,且发的就是定格矩形。
      // 200ms 覆盖"最后一次 move 排起的门(+80ms)"充分触发;要是实现让末帧请求被拖拽
      // 中途的旧门顶掉/丢弃(见上),这里就等不来任何新 POST。
      fireEvent.pointerUp(handle, { pointerId: 7 })
      await vi.advanceTimersByTimeAsync(200)
      const after = calls.filter(c => c.url.endsWith('/slot/rect'))
      expect(after.length).toBeGreaterThan(before)
      expect(after.at(-1)?.body).toEqual({ rect: { x: 0, y: 80, w: 100, h: 100 }, source: 'app' })
    } finally {
      vi.useRealTimers()
    }
  })
})

import { DockTabBar, BUTLER_TAB_LABEL } from '../src/client/DockTabBar.tsx'

/** 窗口槽里那一份那页事务官(10-22 第三轮起只挂一处:浮窗露着且展开时它在浮窗里,窗口槽里就没有)。 */
const slotInbox = (): HTMLElement | null => document.querySelector('[data-module-box="slot"] [aria-label="事项收件箱"]')

describe('DockTabBar 的固定「事务官」标签(W4)', () => {
  const noop = (): void => {}

  it('dock 未启用时也照样渲染「事务官」这一格', () => {
    render(
      <DockTabBar
        dock={undefined} sessions={[]} badges={{}} baseUrl="http://x" fetchImpl={vi.fn()}
        butlerActive onSelectButler={noop}
      />,
    )
    expect(screen.getByRole('button', { name: BUTLER_TAB_LABEL })).toBeInTheDocument()
  })

  it('「事务官」永远是第一格,且没有除名按钮', () => {
    render(
      <DockTabBar
        dock={{ stack: [{ key: 'claude', label: 'Claude', current: true, running: true }] }}
        sessions={[]} badges={{}} baseUrl="http://x" fetchImpl={vi.fn()}
        butlerActive={false} onSelectButler={noop}
      />,
    )
    const names = screen.getAllByRole('button').map(b => b.textContent)
    expect(names[0]).toBe(BUTLER_TAB_LABEL)
    // 除名按钮的 aria-label 是「放出 <label>」——事务官这一格不该有
    expect(screen.queryByRole('button', { name: `放出 ${BUTLER_TAB_LABEL}` })).toBeNull()
  })

  it('current 为 null(叠上没窗在台前)时,「事务官」是选中态', () => {
    render(
      <DockTabBar
        dock={{ stack: [{ key: 'claude', label: 'Claude', current: false, running: true }] }}
        sessions={[]} badges={{}} baseUrl="http://x" fetchImpl={vi.fn()}
        butlerActive onSelectButler={noop}
      />,
    )
    expect(screen.getByRole('button', { name: BUTLER_TAB_LABEL }).closest('span'))
      .toHaveAttribute('data-current', 'true')
  })

  it('点「事务官」触发 onSelectButler,不发 /dock/switch', async () => {
    const onSelectButler = vi.fn()
    const fetchImpl = vi.fn()
    render(
      <DockTabBar
        dock={{ stack: [{ key: 'claude', label: 'Claude', current: true, running: true }] }}
        sessions={[]} badges={{}} baseUrl="http://x" fetchImpl={fetchImpl}
        butlerActive={false} onSelectButler={onSelectButler}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: BUTLER_TAB_LABEL }))
    await tick(0)
    expect(onSelectButler).toHaveBeenCalledTimes(1)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('事务官标签那一档:事项收件箱(2026-09-10 起,原来是内嵌 DSH 对话页的 iframe)', () => {
  // 清除服务端槽体矩形(I3 先例)那个 effect 只认壳内页面——跟 tests/client-dock.test.tsx
  // 里其余矩形相关 describe 同一个先例(见「窗位矩形上报」「矩形上报只认壳内页面」两个
  // describe 块的 beforeEach)。
  beforeEach(() => { window.history.replaceState(null, '', '/?ben-workbench=app') })
  afterEach(() => { window.history.replaceState(null, '', '/') })

  it('叠上没有窗在台前 → 渲染收件箱,但**保留**服务端的槽体矩形', async () => {
    const calls: { url: string, body: unknown }[] = []
    const state = snapshot({ dock: { stack: [{ key: 'claude', label: 'Claude', current: false, running: true }] } })
    render(<WorkbenchOverlay {...props({ state, fetchImpl: fakeFetchRecording(state, calls) })} />)

    await tick(0)
    expect(screen.getByLabelText('事项收件箱')).toBeInTheDocument()
    // 2026-08-26 真机事故后改:原来这里断言"顺手清掉矩形"。清掉 = 切换回应用的路一起断了
    // (switchTo 没有矩形就直接失败),Ben 实机上被钉死在事务官。理由全文见 Workbench.tsx
    // 那个 I3 清除 effect 的注释,以及本文件下方「事务官驱动的 I3 清除」那一组。
    await tick(300)
    expect(calls.some(c => c.url.endsWith('/slot/rect')
      && (c.body as { rect: unknown }).rect === null)).toBe(false)
  })

  it('有窗在台前 → 不渲染收件箱(那会儿它会被原生窗盖住,画了也看不见)', async () => {
    const calls: { url: string, body: unknown }[] = []
    const state = snapshot({ dock: { stack: [{ key: 'claude', label: 'Claude', current: true, running: true }] } })
    render(<WorkbenchOverlay {...props({ state, fetchImpl: fakeFetchRecording(state, calls) })} />)

    await tick(0)
    expect(screen.getByRole('button', { name: 'Claude' })).toBeInTheDocument()
    expect(slotInbox()).toBeNull()
  })

  it('标签栏与窗口槽卡头都不再有「事务官」(2026-10-27 已拍板:入口只剩悬浮球)', async () => {
    const calls: { url: string, body: unknown }[] = []
    const state = snapshot({ dock: { stack: [{ key: 'claude', label: 'Claude', current: true, running: true }] } })
    render(<WorkbenchOverlay {...props({ state, fetchImpl: fakeFetchRecording(state, calls) })} />)

    await tick(0)
    const group = screen.getByRole('group', { name: '窗位叠标签' })
    expect(within(group).queryByRole('button', { name: BUTLER_TAB_LABEL })).toBeNull()
    expect(screen.queryByRole('button', { name: '窗口槽:事务官' })).toBeNull()
    expect(calls.some(c => c.url.endsWith('/dock/hide'))).toBe(false)
  })
})

describe('butlerActive 过渡态不翻转(coordinator 修复轮 1/5:dock 缺省不等于"没有窗在台前")', () => {
  // 同上,I3 清除矩形那条 effect 只认壳内页面。
  beforeEach(() => { window.history.replaceState(null, '', '/?ben-workbench=app') })
  afterEach(() => { window.history.replaceState(null, '', '/') })

  it('认领过之后 dock 整个字段消失(过渡态,不是空数组)→ butlerActive 不翻转,收件箱不挂载,不额外发 {rect:null}', async () => {
    const calls: { url: string, body: unknown }[] = []
    const stateAdopted = snapshot({ dock: { stack: [{ key: 'claude', label: 'Claude', current: true, running: true }] } })
    // dock 字段整个不带,不是 { dock: { stack: [] } }——先例见「S5」describe 的
    // dockEverAdoptedRef 用法,轮询漏一拍/DSH 重启/WS 抖一下都是这种"字段整个消失"的形态。
    const stateDockGone = snapshot({})
    let pollCount = 0
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        calls.push({ url: String(url), body: init.body === undefined ? undefined : JSON.parse(String(init.body)) })
        return { ok: true, json: async () => ({ ok: true }) }
      }
      // 2026-09-17(账号登录):工作台挂载时还会问一次 /account —— 这条计数只数 /state 的轮询。
      // 别的 GET 一律回 404「没接」,免得把"第几拍"算错(账号没接时界面照旧直接是工作台)。
      if (!String(url).includes('/state')) return { ok: false, status: 404, json: async () => ({ error: '未启用' }) }
      pollCount++
      return { ok: true, json: async () => (pollCount === 1 ? stateAdopted : stateDockGone) }
    }) as unknown as typeof fetch

    // servicePollMs 留出比稳定性门更宽的余量——同文件里「真机验收」「S5」两条既有用例
    // 同一个理由:poll 太快会在被动上报的重测计时器完成前就抢跑,搅乱这条用例本来要看的
    // 那次状态转换。
    render(<WorkbenchOverlay {...props({ state: stateAdopted, fetchImpl })} servicePollMs={200} />)

    // 第一轮(dock.stack 非空、claude current)落定——标签栏出现 Claude 标签,这时
    // dockEverAdoptedRef 真的被点亮,iframe 没有挂载(有窗在台前)。
    await settleMount()
    expect(screen.getByRole('button', { name: 'Claude' })).toBeInTheDocument()
    expect(slotInbox()).toBeNull()
    const nullClearsBefore = calls.filter(c => c.url.endsWith('/slot/rect')
      && (c.body as { rect: unknown }).rect === null).length

    // 下一轮轮询把 dock 字段整个吃掉——这是"这一拍不知道",不是"没有窗在台前"。
    await tick(200)
    expect(pollCount).toBeGreaterThan(1)
    await tick(300) // 给"万一真翻转/真多清了一次"留够反应时间

    // butlerActive 没有翻转:iframe 始终没有挂载。
    expect(slotInbox()).toBeNull()
    // 也没有因为这次过渡态额外发一次 {rect:null}——那扇原生窗还贴在屏幕上没动,
    // 不该被清掉。轮 3(I3 清除 effect 加 !dockUnknown 门槛)之后挂载瞬间已经不再
    // 有噪声性质的 {rect:null},nullClearsBefore 这里实际上恒为 0——继续用"转换
    // 前后差值"而不是硬编码 0,是为了不对"挂载瞬间到底发不发"这件事重复断言
    // (那是另一个 describe 的职责,见「事务官驱动的 I3 清除只在真知道时才发」)。
    const nullClearsAfter = calls.filter(c => c.url.endsWith('/slot/rect')
      && (c.body as { rect: unknown }).rect === null).length
    expect(nullClearsAfter).toBe(nullClearsBefore)
  })

  it('state.stale 为真(轮询失败退回占位快照)→ butlerActive 同样不翻转', async () => {
    const calls: { url: string, body: unknown }[] = []
    const stateAdopted = snapshot({ dock: { stack: [{ key: 'claude', label: 'Claude', current: true, running: true }] } })
    let pollCount = 0
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        calls.push({ url: String(url), body: init.body === undefined ? undefined : JSON.parse(String(init.body)) })
        return { ok: true, json: async () => ({ ok: true }) }
      }
      // 2026-09-17(账号登录):工作台挂载时还会问一次 /account —— 这条计数只数 /state 的轮询。
      // 别的 GET 一律回 404「没接」,免得把"第几拍"算错(账号没接时界面照旧直接是工作台)。
      if (!String(url).includes('/state')) return { ok: false, status: 404, json: async () => ({ error: '未启用' }) }
      pollCount++
      if (pollCount === 1) return { ok: true, json: async () => stateAdopted }
      // 模拟"轮询漏一拍"——fetchState 捕获异常后退回 offlineState()(stale:true,
      // 不带 dock 字段),不用手写一份 stale:true 快照,更贴近真实故障路径。
      throw new Error('network blip')
    }) as unknown as typeof fetch

    render(<WorkbenchOverlay {...props({ state: stateAdopted, fetchImpl })} servicePollMs={200} />)

    await settleMount()
    expect(screen.getByRole('button', { name: 'Claude' })).toBeInTheDocument()
    expect(slotInbox()).toBeNull()
    const nullClearsBefore = calls.filter(c => c.url.endsWith('/slot/rect')
      && (c.body as { rect: unknown }).rect === null).length

    await tick(200)
    expect(pollCount).toBeGreaterThan(1)
    await tick(300)

    expect(slotInbox()).toBeNull()
    const nullClearsAfter = calls.filter(c => c.url.endsWith('/slot/rect')
      && (c.body as { rect: unknown }).rect === null).length
    expect(nullClearsAfter).toBe(nullClearsBefore)
  })

  it('从没认领过 + dock 缺省(dockService 没接)→ 仍然判真,收件箱正常挂载(既有行为,本轮修复不能改掉它)', async () => {
    // 跟上面两条的区别就是这次修复的全部要点:dockEverAdoptedRef 从未点亮过时,
    // dock 缺省是"dockService 压根没接"的确定判断,不是"这一拍不知道"的过渡态——
    // 该判真,让 iframe 正常挂载(没有任何原生窗会盖住它)。
    const calls: { url: string, body: unknown }[] = []
    const state = snapshot({}) // 从未认领过,dock 整体缺省
    render(<WorkbenchOverlay {...props({ state, fetchImpl: fakeFetchRecording(state, calls) })} />)

    await tick(0)
    expect(screen.getByLabelText('事项收件箱')).toBeInTheDocument()
  })
})

describe('事务官驱动的 I3 清除只在真知道时才发(coordinator 修复轮 2/5)', () => {
  beforeEach(() => { window.history.replaceState(null, '', '/?ben-workbench=app') })
  afterEach(() => { window.history.replaceState(null, '', '/') })

  it('壳内 + 挂载那一拍(dockUnknown:还没拿到第一份快照)→ 不发 {rect:null}', async () => {
    const calls: { url: string, body: unknown }[] = []
    // 故意让 /state 一直不 resolve(先例:S2(a)「服务端第一次响应到达之前」),模拟
    // "挂载了、但还不知道叠上有没有窗在台前"这段窗口——feed.state 停在 offlineState()
    // (stale:true),dockUnknown 为真,butlerActiveRef 走的是初值 true 那条路。
    const fetchImpl = vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        calls.push({ url: String(url), body: init.body === undefined ? undefined : JSON.parse(String(init.body)) })
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) })
      }
      return new Promise<{ ok: boolean, json: () => Promise<WorkbenchState> }>(() => {}) // 永不 resolve
    }) as unknown as typeof fetch

    render(<WorkbenchOverlay {...props({ fetchImpl })} />)

    await tick(0)
    screen.getByRole('heading', { name: '窗口槽' }) // 首帧(本地 DEFAULT_LAYOUT)已经渲染完
    await tick(300) // 给"万一真发了"留够反应时间
    // 这一拍真相是"不知道叠上有没有窗",不是"确定没有槽体"——事务官驱动的清除不该发。
    expect(calls.some(c => c.url.endsWith('/slot/rect')
      && (c.body as { rect: unknown }).rect === null)).toBe(false)
  })

  /**
   * 2026-08-26 真机事故(0.1.68,Ben:"应用标签被钉死在事务官上了,我点击其他的完全不响应")。
   *
   * 死锁链条,四步全是既有代码各自"合理"的行为凑出来的:
   *   ① 点「事务官」→ POST /dock/hide,服务端 current 置空;
   *   ② 客户端算出 butlerActive=true(叠非空但没人在台前)→ 槽体整个卸载;
   *   ③ 原来的 I3 清除据此发 {rect:null},服务端**忘掉槽位矩形**;
   *   ④ 点任何应用标签 → server/dock.ts 的 switchTo 在 slotScreenRect() 为空时直接
   *      抛 NOTE_SWITCH_SLOT_UNKNOWN → 没有任何标签能变 current → butlerActive 恒为真。
   * 回不去了。W4 终审注释里预见过"一条谁也出不来的死路",但只堵了「叠为空」那一支。
   *
   * 正解是**别清**:事务官在台前时,那块屏幕区域并没有消失——事务官 iframe 就铺在同一个
   * 矩形上,几何依然成立。真正该清的只有 slotHidden(模块被收起,那块地方换成别的模块了,
   * 再往那儿贴窗会盖住不相干的内容)。两者不是一回事,不能共用一条清除理由。
   */
  /**
   * 第二道:光"不清"还不够——**从来没量过**的情况下也得量得到。
   *
   * 0.1.69 只堵住了"把已有矩形清掉"。真机上还剩一条路:点过「事务官」之后 current 被
   * 持久化成 null,下次 DSH 重启(发版、重启机器)一开机 butlerActive 就是真,槽体从头
   * 到尾没挂载过 → 一份矩形都没量出来 → switchTo 照样失败 → 一开机就钉死。
   *
   * 所以槽位几何**不能取决于当下选中哪个标签**:它描述的是"工作台上那块区域在屏幕的
   * 什么位置",跟这会儿在那儿画 iframe 还是画虚线区无关。事务官在台前时槽体照常挂载、
   * 照常量、照常报,事务官 iframe 盖在它上面。
   */
  it('事务官在台前(且从没量过)→ 槽体仍挂载,照常报出真实矩形', async () => {
    stubSlotRect({ x: 40, y: 900, width: 1360, height: 1200 })
    const calls: { url: string, body: unknown }[] = []
    const state = snapshot({ dock: { stack: [{ key: 'claude', label: 'Claude', current: false, running: true }] } })
    render(<WorkbenchOverlay {...props({ state, fetchImpl: fakeFetchRecording(state, calls) })} />)

    await settleMount()
    expect(screen.getByLabelText('事项收件箱')).toBeInTheDocument()
    const real = calls.find(c => c.url.endsWith('/slot/rect') && (c.body as { rect: unknown }).rect !== null)
    expect(real).toBeDefined()
  })

  it('叠非空、事务官在台前 → **不发** {rect:null}(矩形是点回应用标签的唯一凭据)', async () => {
    const calls: { url: string, body: unknown }[] = []
    const state = snapshot({ dock: { stack: [{ key: 'claude', label: 'Claude', current: false, running: true }] } })
    render(<WorkbenchOverlay {...props({ state, fetchImpl: fakeFetchRecording(state, calls) })} />)

    await tick(0)
    expect(screen.getByLabelText('事项收件箱')).toBeInTheDocument()
    await tick(300) // 给"万一真发了"留够反应时间
    expect(calls.some(c => c.url.endsWith('/slot/rect')
      && (c.body as { rect: unknown }).rect === null)).toBe(false)
  })

  it('slotHidden 为真时,即便 dockUnknown 也照常发(独立理由不受这道门槛影响,既有行为)', async () => {
    const calls: { url: string, body: unknown }[] = []
    // 合并注(2026-08-26):原来这条用 calendarOpen(纯本地 UI 态)当"独立理由"。版面重排
    // 把工作台自带日历整块下线,那条理由不存在了,改用剩下的那条——slotHidden。
    // stale:true 让 dockUnknown 全程为真,布局里把窗位模块收起来提供独立理由,
    // 两者同时成立时清除仍应照发。
    const state = snapshot({
      stale: true,
      layout: {
        modules: [
          { id: 'projects', order: 0, basis_pct: 28 },
          { id: 'slot', order: 1, basis_pct: 44, hidden: true },
          { id: 'notes', order: 2, basis_pct: 14 },
        ],
        butler: { corner: 'br', min: false },
      },
    })
    render(<WorkbenchOverlay {...props({ state, fetchImpl: fakeFetchRecording(state, calls) })} />)

    await settleMount()
    expect(calls.some(c => c.url.endsWith('/slot/rect')
      && (c.body as { rect: unknown }).rect === null)).toBe(true)
  })
})

describe('测量/上报 effect 的依赖数组必须带 butlerActive(coordinator 修复轮 3/5,C1 review jsdom 复现)', () => {
  beforeEach(() => { window.history.replaceState(null, '', '/?ben-workbench=app') })
  afterEach(() => { window.history.replaceState(null, '', '/') })

  it('事务官↔应用窗来回切之后,槽体重新挂载 → 有一次真实矩形上报(不是 null)', async () => {
    // 去抖卡(2026-09-28):这条今晚在 main 上随机红过。真实 200ms 轮询下,机器一忙
    // 第三拍(切回应用窗)会在测试换矩形之前就到,新槽体量到的还是旧矩形,新矩形永远等不来。
    // 改假时钟,每一拍由 tick 推进:换矩形一定落在第二拍与第三拍之间。
    stubSlotRect({ x: 40, y: 900, width: 1360, height: 1200 })
    const calls: { url: string, body: unknown }[] = []
    // 三轮快照:有窗在台前 → 切到事务官(dock.stack 长度不变,只是没有 current)→
    // 切回应用窗。dockStackLen/scenesLen/layout/calendarOpen/stale 全程不变——
    // C1 描述的真机路径正是这三个字段一个都不变、唯独 butlerActive 在变。
    const stateWithWindow = snapshot({
      dock: { stack: [{ key: 'claude', label: 'Claude', current: true, running: true }] },
    })
    const stateButlerActive = snapshot({
      dock: { stack: [{ key: 'claude', label: 'Claude', current: false, running: true }] },
    })
    let pollCount = 0
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        calls.push({ url: String(url), body: init.body === undefined ? undefined : JSON.parse(String(init.body)) })
        return { ok: true, json: async () => ({ ok: true }) }
      }
      // 2026-09-17(账号登录):工作台挂载时还会问一次 /account —— 这条计数只数 /state 的轮询。
      // 别的 GET 一律回 404「没接」,免得把"第几拍"算错(账号没接时界面照旧直接是工作台)。
      if (!String(url).includes('/state')) return { ok: false, status: 404, json: async () => ({ error: '未启用' }) }
      pollCount++
      if (pollCount === 1) return { ok: true, json: async () => stateWithWindow }
      if (pollCount === 2) return { ok: true, json: async () => stateButlerActive }
      return { ok: true, json: async () => stateWithWindow }
    }) as unknown as typeof fetch

    // servicePollMs 留出比稳定性门更宽的余量——同文件里其余多轮轮询用例同一个理由。
    render(<WorkbenchOverlay {...props({ state: stateWithWindow, fetchImpl })} servicePollMs={200} />)

    // 第一轮:有窗在台前,槽体挂载,量到第一次真实矩形。
    await settleMount()
    expect(calls.some(c => c.url.endsWith('/slot/rect')
      && (c.body as { rect: unknown }).rect !== null)).toBe(true)

    // 第二轮:切到事务官——iframe 挂载,槽体卸载。
    // 2026-08-26 真机事故后:这里**不再**发 {rect:null}(清掉矩形 = 切换回应用的路一起断了,
    // 见 Workbench.tsx 的 I3 清除注释)。这条用例本来要守的也不是清除,而是下面那件事:
    // 槽体重新挂载时 effect 必须重跑、量到并上报新矩形——依赖数组带 butlerActive 才做得到。
    await tick(200 - GATE_MS) // 第二拍轮询
    await tick(GATE_MS) // 这一拍 effect 重跑排下的稳定性门也走完,别漏到下一段
    expect(screen.getByLabelText('事项收件箱')).toBeInTheDocument()

    // 换一个跟第一次明显不同的矩形,模拟切回应用窗后槽体的真实尺寸——如果依赖数组
    // 没有 butlerActive,槽体重新挂载不会触发这个 effect 重跑,这个新矩形永远不会
    // 被量到、也永远不会被上报,服务端会一直停在上一步的 {rect:null}。
    stubSlotRect({ x: 10, y: 20, width: 500, height: 400 })
    const callsBeforeSwitchBack = calls.length

    // 第三轮:切回应用窗——槽体重新挂载。
    // 断言从"iframe 不在 DOM 里"改成"槽体挂载"(产品决策 2026-08-26:事务官 iframe
    // 改成懒挂载+常驻,切走不再卸载,只是 display:none 藏起来——iframe 这时候仍在
    // DOM 里、只是不可见,見「事务官 iframe 懒挂载 + 常驻」describe;这条测试真正要
    // 守的是槽体重新挂载、effect 重跑、量到并上报了新矩形,不是 iframe 存在与否)。
    await tick(200 - GATE_MS) // 第三拍轮询
    expect(document.querySelector('.ben-wb__slot-body')).not.toBeNull()

    await tick(GATE_MS)
    const newRealPost = calls.slice(callsBeforeSwitchBack).find(c => c.url.endsWith('/slot/rect')
      && (c.body as { rect: unknown }).rect !== null)
    expect(newRealPost?.body).toEqual({ rect: { x: 10, y: 20, w: 500, h: 400 }, source: 'app' })
  })
})

describe('butlerActiveRef 初值(coordinator 修复轮 3/5,I1)', () => {
  beforeEach(() => { window.history.replaceState(null, '', '/?ben-workbench=app') })
  afterEach(() => { window.history.replaceState(null, '', '/') })

  it('挂载第一拍(dockUnknown 为真,还没有任何"上一次已知值"可沿用)→ 不渲染收件箱', async () => {
    const calls: { url: string, body: unknown }[] = []
    // 让 /state 永不 resolve——全程停在挂载第一拍那个 dockUnknown 为真的状态
    // (offlineState 自带 stale:true)。
    const fetchImpl = vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        calls.push({ url: String(url), body: init.body === undefined ? undefined : JSON.parse(String(init.body)) })
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) })
      }
      return new Promise<{ ok: boolean, json: () => Promise<WorkbenchState> }>(() => {}) // 永不 resolve
    }) as unknown as typeof fetch

    render(<WorkbenchOverlay {...props({ fetchImpl })} />)

    // 不用 waitFor 宽限——要看的正是"第一次渲染"这一刻,不是"最终稳定态"。
    await tick(0)
    screen.getByRole('heading', { name: '窗口槽' }) // 确认首帧已经渲染完
    // I1(review):挂载第一拍没有"上一次已知值"可沿用,这是一次猜测——猜 false
    // (不渲染 iframe)的代价远低于猜 true(白白开始加载整份同源 DSH 应用再销毁),
    // 所以初值定为 false,这一刻不该渲染 iframe。
    expect(slotInbox()).toBeNull()
  })
})

describe('套娃防护:薄壳真的在非顶层帧挡住渲染(coordinator 修复轮 3/5,I3)', () => {
  // 只测薄壳本身的条件返回,不牵扯壳内/壳外(ben-workbench=app)——两件事互相独立。
  afterEach(() => { window.history.replaceState(null, '', '/') })

  it('window.top !== window.self(被 iframe 嵌着)→ WorkbenchOverlay 整体不渲染', () => {
    // isTopFrame 三条纯函数单测只覆盖了它自己——没有任何既有测试确认 WorkbenchOverlay
    // 这层薄壳真的在调用它、真的在非顶层帧 return null。把两个实参写反(仍然对称通过)、
    // 写成 window.parent、或者后人顺手把薄壳删了,那三条单测照样全绿——这条测试才是
    // 真正钉住这条防线的地方。
    const topSpy = vi.spyOn(window, 'top', 'get').mockReturnValue({} as Window)
    try {
      const { container } = render(<WorkbenchOverlay {...props({ state: snapshot({}) })} />)
      expect(container.innerHTML).toBe('')
    }
    finally {
      topSpy.mockRestore()
    }
  })

  it('window.top === window.self(顶层帧,jsdom 默认态)→ 正常渲染(对照组,证明上面那条测的是"被挡住"而不是"组件本来就渲染不出来")', async () => {
    render(<WorkbenchOverlay {...props({ state: snapshot({}) })} />)
    await tick(0)
    expect(screen.getByRole('main', { name: '工作台' })).toBeInTheDocument()
  })
})

describe('事务官那一档懒挂载 + 常驻(产品决策 2026-08-26 定于 iframe,2026-09-10 收件箱沿用:切走再切回来,输入框里那句话与滚动位置不能丢)', () => {
  beforeEach(() => { window.history.replaceState(null, '', '/?ben-workbench=app') })
  afterEach(() => { window.history.replaceState(null, '', '/') })

  /** 有窗在台前的一份快照(butlerActive 为假)。 */
  const stateWithWindow = () => snapshot({
    dock: { stack: [{ key: 'claude', label: 'Claude', current: true, running: true }] },
  })
  /** 叠上没有窗在台前的一份快照(butlerActive 为真,事务官选中)。 */
  const stateButlerActive = () => snapshot({
    dock: { stack: [{ key: 'claude', label: 'Claude', current: false, running: true }] },
  })

  /** 按给定序列依次返回快照的假 fetch,序列跑完后停在最后一项——先例见 C1 用例的 pollCount 写法。 */
  function fetchCycling(sequence: WorkbenchState[], calls: { url: string, body: unknown }[]) {
    let pollCount = 0
    return vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        calls.push({ url: String(url), body: init.body === undefined ? undefined : JSON.parse(String(init.body)) })
        return { ok: true, json: async () => ({ ok: true }) }
      }
      // 2026-09-17(账号登录):工作台挂载时还会问一次 /account —— 这条计数只数 /state 的轮询。
      // 别的 GET 一律回 404「没接」,免得把"第几拍"算错(账号没接时界面照旧直接是工作台)。
      if (!String(url).includes('/state')) return { ok: false, status: 404, json: async () => ({ error: '未启用' }) }
      const state = sequence[Math.min(pollCount, sequence.length - 1)]
      pollCount++
      return { ok: true, json: async () => state }
    }) as unknown as typeof fetch
  }

  it('1. 从没选中过事务官时,DOM 里没有收件箱', async () => {
    const calls: { url: string, body: unknown }[] = []
    const state = stateWithWindow()
    render(<WorkbenchOverlay {...props({ state, fetchImpl: fakeFetchRecording(state, calls) })} />)

    // 先确认组件真的渲染完成(标签栏出现 Claude 标签),不是"还没跑到"就侥幸看不到 iframe。
    await tick(0)
    expect(screen.getByRole('button', { name: 'Claude' })).toBeInTheDocument()
    expect(slotInbox()).toBeNull()
  })

  it('2. 选中事务官 → 收件箱出现且可见', async () => {
    const calls: { url: string, body: unknown }[] = []
    const round1 = stateWithWindow()
    const sequence = [round1, stateButlerActive()]
    render(<WorkbenchOverlay {...props({ state: round1, fetchImpl: fetchCycling(sequence, calls) })} servicePollMs={200} />)

    await tick(0)
    expect(screen.getByRole('button', { name: 'Claude' })).toBeInTheDocument()
    await tick(200)
    expect(screen.getByLabelText('事项收件箱')).toBeInTheDocument()
    const inbox = screen.getByLabelText('事项收件箱')
    // 可见:没有被 display:none 藏起来(懒挂载的第一拍就是"要显示"这一拍,不需要
    // 额外再切一次)。
    expect(inbox.style.display).not.toBe('none')
  })

  it('3. 切回应用标签 → 那一页进了浮窗、窗口槽里不留;槽体一直在', async () => {
    const calls: { url: string, body: unknown }[] = []
    const round1 = stateWithWindow()
    const sequence = [round1, stateButlerActive(), stateWithWindow()]
    // 去抖卡(2026-09-28):这条今晚在 main 上随机红过——第二拍(收件箱可见)只持续 200ms
    // 真实时间,waitFor 一慢就整个错过,之后永远是 display:none。改假时钟逐拍推进。
    render(<WorkbenchOverlay {...props({ state: round1, fetchImpl: fetchCycling(sequence, calls) })} servicePollMs={200} />)

    // 第一轮:有窗在台前,槽体挂载。
    await tick(0)
    expect(document.querySelector('.ben-wb__slot-body')).not.toBeNull()
    // 第二轮:切到事务官——收件箱挂载并可见。
    // 2026-08-26 真机事故后:事务官在台前时槽体**不再卸载**(它是矩形的唯一来源,卸载会把
    // 切回应用的路一起断掉),收件箱盖在槽体上的浮层。所以"这会儿在看事务官"的判据
    // 从"槽体没了"改成"收件箱可见"。
    await tick(200)
    expect(screen.getByLabelText('事项收件箱')).toBeInTheDocument()
    expect(screen.getByLabelText('事项收件箱').style.display).not.toBe('none')
    // 第三轮:切回应用窗——收件箱**仍在 DOM 里**但被 CSS 藏起来。
    // getByLabelText 找不到就直接抛错,所以这一句同时断言了"收件箱还在 DOM 里"。
    await tick(200)
    // 10-22 第三轮:有窗在台前时那一页进了浮窗(同一份只挂一处),窗口槽里不再留一份藏着的。
    expect(slotInbox()).toBeNull()
    expect(within(screen.getByRole('complementary', { name: '事务官' })).getByLabelText('事项收件箱')).toBeInTheDocument()
    // 槽体自始至终都在——三轮下来一次都没卸载过。
    expect(document.querySelector('.ben-wb__slot-body')).not.toBeNull()
  })

  it('4. 再切回事务官 → 那一页回到窗口槽,始终只有一份', async () => {
    const calls: { url: string, body: unknown }[] = []
    const round1 = stateWithWindow()
    const sequence = [round1, stateButlerActive(), stateWithWindow(), stateButlerActive()]
    render(<WorkbenchOverlay {...props({ state: round1, fetchImpl: fetchCycling(sequence, calls) })} servicePollMs={200} />)

    // 第二轮:第一次选中事务官,记住这个 iframe 节点。
    await tick(0)
    await tick(200)
    expect(screen.getByLabelText('事项收件箱')).toBeInTheDocument()
    const firstInbox = screen.getByLabelText('事项收件箱')

    expect(firstInbox).toBeInTheDocument()

    // 第三轮:切回应用窗——那一页进了浮窗。
    await tick(200)
    expect(slotInbox()).toBeNull()

    // 第四轮:再切回事务官——那一页回到窗口槽,始终只有一份(10-22 第三轮;草稿在外层 butlerDraft 不丢)。
    await tick(200)
    expect(slotInbox()?.style.display).not.toBe('none')
    expect(document.querySelectorAll('[aria-label="事项收件箱"]')).toHaveLength(1)
  })
})

describe('C1(整分支终审):叠为空时不能把拖拽落点也一起藏掉', () => {
  // 矩形上报/清除那两条 effect 只认壳内页面——同文件其余矩形相关 describe 一个先例。
  beforeEach(() => { window.history.replaceState(null, '', '/?ben-workbench=app') })
  afterEach(() => { window.history.replaceState(null, '', '/') })

  /**
   * 叠里一个成员都没有:①全新安装(dock.json 还没成员)②点 ✕ 放出了最后一个应用。
   * **注意跟 `snapshot({})`(dock 字段整个缺省)是两回事**:那种是 dockService 压根
   * 没接线,窗位叠这个能力整个不存在,没有落点可言;这里是接了线、只是还没认领过谁,
   * 而"把窗拖进 .ben-wb__slot-body"正是认领第一扇窗的唯一入口。
   */
  const stateEmptyStack = () => snapshot({ dock: { stack: [] } })

  it('叠为空 → 槽体仍然挂载,且上报的是真实矩形(不是 {rect:null})', async () => {
    stubSlotRect({ x: 40, y: 900, width: 1360, height: 1200 })
    const calls: { url: string, body: unknown }[] = []
    const state = stateEmptyStack()
    render(<WorkbenchOverlay {...props({ state, fetchImpl: fakeFetchRecording(state, calls) })} />)

    // 落点本身在 DOM 里(空数组 .every() 恒真那条老路会让整个 SlotZone 不挂载)。
    await settleMount()
    expect(document.querySelector('.ben-wb__slot-body')).not.toBeNull()
    // 而且真的量过、报过——只挂载不上报的话,服务端 handleMoved 仍会在
    // screenRect===undefined 那里早退,拖进去照样认领不了。
    const real = calls.find(c => c.url.endsWith('/slot/rect') && (c.body as { rect: unknown }).rect !== null)
    expect(real?.body).toEqual({ rect: { x: 40, y: 900, w: 1360, h: 1200 }, source: 'app' })
    // 没有任何一次 I3 清除——清了就等于告诉服务端"这里没有落点",拖拽认领当场失效。
    expect(calls.some(c => c.url.endsWith('/slot/rect') && (c.body as { rect: unknown }).rect === null)).toBe(false)
  })

  it('叠为空时槽体照常挂载(它是矩形的唯一来源);标签栏里没有「事务官」那一格', async () => {
    const calls: { url: string, body: unknown }[] = []
    const state = stateEmptyStack()
    render(<WorkbenchOverlay {...props({ state, fetchImpl: fakeFetchRecording(state, calls) })} />)

    await tick(0)
    expect(document.querySelector('.ben-wb__slot-body')).not.toBeNull()
    const group = screen.getByRole('group', { name: '窗位叠标签' })
    // 2026-10-27 已拍板:去掉各处独立的事务官标签页,事务官入口只剩悬浮球。标签栏里不再有「事务官」这一格。
    expect(within(group).queryByRole('button', { name: BUTLER_TAB_LABEL })).toBeNull()
    // 事务官那一页不再挂在窗口槽里。
    expect(slotInbox()).toBeNull()
  })

  it('放出最后一个应用(叠从非空变空)→ 自动回到落点,不会停在"选中事务官"的死路上', async () => {
    const calls: { url: string, body: unknown }[] = []
    const stateOne = snapshot({ dock: { stack: [{ key: 'claude', label: 'Claude', current: true, running: true }] } })
    const stateNone = stateEmptyStack()
    let pollCount = 0
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        calls.push({ url: String(url), body: init.body === undefined ? undefined : JSON.parse(String(init.body)) })
        return { ok: true, json: async () => ({ ok: true }) }
      }
      // 2026-09-17(账号登录):工作台挂载时还会问一次 /account —— 这条计数只数 /state 的轮询。
      // 别的 GET 一律回 404「没接」,免得把"第几拍"算错(账号没接时界面照旧直接是工作台)。
      if (!String(url).includes('/state')) return { ok: false, status: 404, json: async () => ({ error: '未启用' }) }
      pollCount++
      return { ok: true, json: async () => (pollCount === 1 ? stateOne : stateNone) }
    }) as unknown as typeof fetch

    render(<WorkbenchOverlay {...props({ state: stateOne, fetchImpl })} servicePollMs={50} />)

    await tick(0)
    expect(screen.getByRole('button', { name: 'Claude' })).toBeInTheDocument()
    // 下一拍叠空了:落点必须还在(这正是终审说的"点 ✕ 放出最后一个应用"那条触发路径)。
    await tick(50)
    expect(screen.queryByRole('button', { name: 'Claude' })).toBeNull()
    expect(document.querySelector('.ben-wb__slot-body')).not.toBeNull()
  })
})

/* 合并注(2026-08-26):原「日历借位时点「事务官」」那组用例整组删除——版面重排把工作台
   自带日历整块下线(应用区已能认领系统日历),"日历借位优先级高于事务官"这条行为连同
   它要测的代码一起不存在了。留一个空 describe 只会让人以为覆盖还在。 */

describe('标签拖拽排序(2026-09-02 Ben:想把 AI 的都放一块)', () => {
  it('★把 codex 拖到 claude 前面 → POST /dock/reorder 带上新顺序', async () => {
    const calls: { url: string, body: unknown }[] = []
    const state = snapshot({
      dock: {
        stack: [
          { key: 'claude', label: 'Claude', running: true, current: true },
          { key: 'codex', label: 'Codex', running: true, current: false },
          { key: 'wechat', label: '微信', running: true, current: false },
        ],
      },
    })
    render(<WorkbenchOverlay {...props({ state, fetchImpl: fakeFetchRecording(state, calls) })} />)

    await tick(0)
    screen.getByRole('button', { name: 'Codex' })
    const tabs = document.querySelectorAll('.ben-wb__dock-tab[draggable]')
    expect(tabs).toHaveLength(3) // 事务官那格不参与拖拽

    const codex = [...tabs].find(t => t.textContent?.includes('Codex'))!
    const claude = [...tabs].find(t => t.textContent?.includes('Claude'))!
    const dt = { setData: () => {}, getData: () => 'codex', effectAllowed: '', dropEffect: '' }
    fireEvent.dragStart(codex, { dataTransfer: dt })
    fireEvent.dragOver(claude, { dataTransfer: dt })
    fireEvent.drop(claude, { dataTransfer: dt })

    await tick(0)
    expect(calls.some(c => c.url.endsWith('/dock/reorder'))).toBe(true)
    const sent = calls.find(c => c.url.endsWith('/dock/reorder'))!.body as { keys: string[] }
    expect(sent.keys).toEqual(['codex', 'claude', 'wechat'])
  })

  it('拖到自己身上 → 不发请求(没有变化就别打服务端)', async () => {
    const calls: { url: string, body: unknown }[] = []
    const state = snapshot({
      dock: { stack: [{ key: 'claude', label: 'Claude', running: true, current: true }] },
    })
    render(<WorkbenchOverlay {...props({ state, fetchImpl: fakeFetchRecording(state, calls) })} />)
    await tick(0)
    screen.getByRole('button', { name: 'Claude' })
    const tab = document.querySelector('.ben-wb__dock-tab[draggable]')!
    const dt = { setData: () => {}, getData: () => 'claude', effectAllowed: '', dropEffect: '' }
    fireEvent.dragStart(tab, { dataTransfer: dt })
    fireEvent.drop(tab, { dataTransfer: dt })
    await tick(30)
    expect(calls.filter(c => c.url.endsWith('/dock/reorder'))).toHaveLength(0)
  })
})

describe('拖拽后要立刻看到(2026-09-02 Ben:"松手他进不去,又回到队尾,过一会才跳过去")', () => {
  it('★松手瞬间本地就按新序渲染,不等服务端那一拍', async () => {
    // 真机:服务端其实是瞬时的(POST 0.02s、/state 0.03s 就反映),dock.json 也确实写了新序。
    // 但客户端当时不做本地重排,标签要等下一拍轮询才跳位——机器一忙那一拍就拖长,
    // 松手瞬间看着就是"没进去、弹回原位"。所以这里必须乐观重排。
    const calls: { url: string, body: unknown }[] = []
    const state = snapshot({
      dock: {
        stack: [
          { key: 'claude', label: 'Claude', running: true, current: true },
          { key: 'codex', label: 'Codex', running: true, current: false },
          { key: 'wechat', label: '微信', running: true, current: false },
        ],
      },
    })
    // fetchImpl 恒回旧序:模拟"服务端那一拍还没到"
    render(<WorkbenchOverlay {...props({ state, fetchImpl: fakeFetchRecording(state, calls) })} />)
    await tick(0)
    screen.getByRole('button', { name: '微信' })

    const order = () => [...document.querySelectorAll('.ben-wb__dock-tab-name')]
      .map(el => el.textContent?.trim()).filter(t => t !== '事务官')
    expect(order()).toEqual(['Claude', 'Codex', '微信'])

    const tabs = [...document.querySelectorAll('.ben-wb__dock-tab[draggable]')]
    const wechat = tabs.find(t => t.textContent?.includes('微信'))!
    const claude = tabs.find(t => t.textContent?.includes('Claude'))!
    const dt = { setData: () => {}, getData: () => 'wechat', effectAllowed: '', dropEffect: '' }
    fireEvent.dragStart(wechat, { dataTransfer: dt })
    fireEvent.drop(claude, { dataTransfer: dt })

    // 服务端还没换序(fetchImpl 一直回旧的),界面必须已经是新序
    await tick(0)
    expect(order()).toEqual(['微信', 'Claude', 'Codex'])
  })
})

describe('标签悬停气泡里的等待原因(2026-09-09 傍晚拍板第 4 条)', () => {
  it('黄点气泡每行行尾带原因;没判出原因的行不带', async () => {
    const state = snapshot({
      dock: { stack: [{ key: 'claude', label: 'Claude', running: true, current: true }] },
      sessions: [
        session({ agent: 'claude', session_id: 'w1', status: 'waiting', title: '改配置', elapsed_sec: 65, reason: 'permission_prompt', wait_reason: 'approval' }),
        session({ agent: 'claude', session_id: 'w2', status: 'waiting', title: '问你', elapsed_sec: 30, reason: 'idle_prompt' }),
        session({ agent: 'claude', session_id: 'e1', status: 'error', title: '炸了', elapsed_sec: 9, wait_reason: 'quota' }),
      ],
    })
    render(<WorkbenchOverlay {...props({ state })} />)

    await tick(0)
    const claudeTab = screen.getByRole('button', { name: 'Claude' }).closest('.ben-wb__dock-tab')
    const waitingBadge = claudeTab?.querySelector('[data-tone=waiting]')
    fireEvent.mouseEnter(waitingBadge!)
    const bubble = waitingBadge?.querySelector('.ben-wb__dock-badge-bubble')
    expect(bubble?.textContent).toContain('改配置 · 1 分 5 秒 · 等审批')
    expect(bubble?.textContent).toContain('问你 · 30 秒')
    expect(bubble?.textContent).not.toContain('问你 · 30 秒 ·')

    const errorBadge = claudeTab?.querySelector('[data-tone=error]')
    fireEvent.mouseEnter(errorBadge!)
    expect(errorBadge?.querySelector('.ben-wb__dock-badge-bubble')?.textContent).toContain('炸了 · 9 秒 · 额度不足')
  })
})
