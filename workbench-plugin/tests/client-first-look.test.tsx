/**
 * 卡 feat/first-look-orb-top(2026-09-25)界面那一半。维护者 09-24 晚的原话:
 *   「最上面不应该是我精心制作的那张粒子球吗,怎么会是一堆文字呢???」
 *   「一打开中间是空的窗口槽,事务官缩成右下角一张小卡」(统筹转述)
 *   「那卡片的光效呢,拖拽进窗口槽的光效呢」
 *   「引导说了两个项目,看板里还是一堆」
 *   「codex 和 Claude 都有会话在跑,它说 0 执行」「球是蓝的」(20:05)
 *
 * 每一条断言写的是**他在屏幕上看得到什么**,不是组件内部长什么样。
 */
import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ButlerInbox, type ButlerControls, type ButlerInboxProps } from '../src/client/ButlerInbox.tsx'
import { buildButlerScene, externalRunningSessions } from '../src/client/butlerSceneModel.ts'
import { strongFx, BEAM, beamTuneCss } from '../src/client/fx/fxModel.ts'
import { FX_THEME } from '../src/client/fx/Fx.tsx'
import { renderBold } from '../src/client/EvolveAsk.tsx'
import { SlotZone } from '../src/client/SlotZone.tsx'
import { TaskBoard } from '../src/client/TaskBoard.tsx'
import { ProjectZone } from '../src/client/ProjectZone.tsx'
import { buildProjectRows, confirmedSplit } from '../src/client/portfolio.ts'
import { coreNoticeOf } from '../src/client/particleScene.ts'
import { HOME_SHOWN_KEY, WorkbenchOverlay, type MinimalWebSocket, type WorkbenchOverlayProps } from '../src/client/Workbench.tsx'
import { createWorkbenchStore } from '../src/client/store.ts'
import type { EvolveProposalView, SessionView, TaskView, WorkbenchProject, WorkbenchState } from '../src/protocol.ts'
import { UNUSED_STANDARD_PROPS } from './helpers/standardProps.ts'

afterEach(cleanup)

const NOW = '2026-09-24T11:05:00.000Z'
function state(over: Partial<WorkbenchState> = {}): WorkbenchState {
  return { agents: [], sessions: [], quota: {}, now: NOW, stale: false, ...over }
}
function task(over: Partial<TaskView> = {}): TaskView {
  return { id: 't1', title: '参赛网页架构收尾', status: 'doing', direction: 'mine', source: { kind: 'manual' }, created_at: NOW, updated_at: NOW, ...over }
}
function session(over: Partial<SessionView> = {}): SessionView {
  return { agent: 'codex', session_id: 'cx-1', project: 'desktop-workbench', status: 'running', title: '参赛网页', elapsed_sec: 600, unread: false, updated_at: NOW, ...over }
}
function tasksOf(...tasks: TaskView[]) {
  return { tasks, sprints: [], modules: [], project_meta: [] }
}
const EVOLVE: EvolveProposalView = {
  id: 'evolve:x', ask: '这 3 次你都在说「整理选题」—— 要不要把它固化下来?', sample: '整理选题', times: 3,
  says: ['整理选题 A', '整理选题 B', '整理选题 C'], suggested_way: 'skill',
  plans: { skill: '我起草一份文档,**先是草稿**,你过一遍再说。', tool: '**不替你发出去**', template: '这一版**还没做**' },
  created_at: NOW,
}
function controls(): ButlerControls {
  return { paused: false, testRinging: false, onPause: vi.fn(), onTestRing: vi.fn(), onCancelWatch: vi.fn(), onDismissBrief: vi.fn(), proposals: [] }
}
function inboxProps(over: Partial<ButlerInboxProps> = {}): ButlerInboxProps {
  return {
    state: state(), baseUrl: 'http://127.0.0.1:8791',
    fetchImpl: vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) })) as unknown as typeof fetch,
    onOpenConversation: vi.fn(), draft: '', onDraftChange: vi.fn(), visible: true, controls: controls(), ...over,
  }
}

describe('① 事务官档:球在最上面,要你处理的卡在球下面自己滚', () => {
  it('★有一张长长的固化提议时,球的舞台照样在最上面;那张卡在「球下面」那一区里,排在舞台之后', () => {
    const { container } = render(<ButlerInbox {...inboxProps({ state: state({ tasks: tasksOf(), butler_inbox: { items: [] }, evolve: { pending: [EVOLVE] } }) })} />)
    const stage = screen.getByTestId('ben-wb-orb-stage')
    const below = screen.getByRole('region', { name: /球下面/ })
    const ask = screen.getByRole('region', { name: '待确认的固化提议' })
    expect(below).toContainElement(ask)
    expect(stage).not.toContainElement(ask)
    // 文档顺序:舞台在前、那一区在后(以前那张卡排在滚动区外面、挤着同一列)。
    expect(stage.compareDocumentPosition(below) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // 舞台里有那颗球(粒子画布或它的兜底)。
    expect(stage.querySelector('.ben-wb__task-orb-anchor')).not.toBeNull()
    // 输入框不在那一区里(它是底下那一条,永远在)。
    expect(below).not.toContainElement(screen.getByRole('textbox', { name: '交给事务官一件事' }))
    expect(container.querySelector('.ben-wb__particle-scroll')).toBeNull()
  })

  it('★那张固化提议是深色卡:文案里的 ** 不再原样露出来,画成加粗', () => {
    render(<ButlerInbox {...inboxProps({ state: state({ tasks: tasksOf(), butler_inbox: { items: [] }, evolve: { pending: [EVOLVE] } }) })} />)
    const ask = screen.getByRole('region', { name: '待确认的固化提议' })
    expect(ask.textContent).not.toContain('**')
    expect(within(ask).getByText('先是草稿').tagName).toBe('STRONG')
    expect(ask.closest('.ben-wb__ask')).not.toBeNull()
  })

  it('renderBold:成对的 ** 画成加粗,落单的照原样', () => {
    const out = render(<p>{renderBold('一 **二** 三 **四** 五 * 六')}</p>)
    expect(out.container.querySelectorAll('strong')).toHaveLength(2)
    expect(out.container.textContent).toBe('一 二 三 四 五 * 六')
  })

  it('★要你处理的最前面那张卡走光(强效果),台上在办的卡这时让一让;交办在路上时输入框优先', () => {
    expect(strongFx({ visible: true, composerBusy: false, ask: true })).toBe('ask')
    expect(strongFx({ visible: true, composerBusy: true, ask: true })).toBe('composer')
    // 台上在跑的卡不再单独走光(卡 P 补三):没有要他处理的、也没在交办 → 这一屏没有强效果。
    expect(strongFx({ visible: true, composerBusy: false, ask: false })).toBeNull()
    expect(strongFx({ visible: false, composerBusy: false, ask: true })).toBeNull()
    render(<ButlerInbox {...inboxProps({ state: state({ tasks: tasksOf(), butler_inbox: { items: [] }, evolve: { pending: [EVOLVE] } }) })} />)
    const beams = document.querySelectorAll('[data-fx="ask"]')
    expect(beams).toHaveLength(1)
    expect(beams[0]).toHaveAttribute('data-fx-active', 'true')
  })
})

describe('② 各家客户端里在跑的会话算「执行」,摆在球周围', () => {
  it('★Codex 有一条在跑、没挂在事项上 → 执行 1,球周围一张「Codex · 参赛网页」', () => {
    const scene = buildButlerScene(state({ tasks: tasksOf(), butler_inbox: { items: [] }, sessions: [session(), session({ agent: 'claude', session_id: 'cl-1', status: 'waiting', title: '统筹' })] }))
    expect(scene.running).toBe(1)
    const external = scene.items.filter(item => item.external !== undefined)
    expect(external.map(item => [item.title, item.external?.agent])).toEqual([['参赛网页', 'codex']])
    // 进行中多久从它进入 running 那一刻算(elapsed 600 秒 = 10 分钟前)。
    expect(external[0]!.at).toBe('2026-09-24T10:55:00.000Z')
  })

  it('★事务官派出去、又挂在事项上的同一条会话只数一次;事务官自己(dsh)的会话不单列', () => {
    const linked = task({ links: [{ agent: 'codex', session_id: 'cx-1' }] })
    const s = state({ tasks: tasksOf(linked), butler_inbox: { items: [] }, sessions: [session(), session({ agent: 'dsh', session_id: 'd-9' })] })
    expect(externalRunningSessions(s)).toEqual([])
    const scene = buildButlerScene(s)
    expect(scene.running).toBe(1)
    expect(scene.items.filter(item => item.external !== undefined)).toEqual([])
  })

  it('快照不新鲜(Agent 掉线)时不凭上一拍的会话编「在跑」', () => {
    const scene = buildButlerScene(state({ stale: true, tasks: tasksOf(), butler_inbox: { items: [] }, sessions: [session()] }))
    expect(scene.items.filter(item => item.external !== undefined)).toEqual([])
  })

  it('★界面上:球下那一行与汇报条说的是同一个数(执行 1、运行会话 1 个)', () => {
    render(<ButlerInbox {...inboxProps({ state: state({ tasks: tasksOf(), butler_inbox: { items: [] }, sessions: [session()] }) })} />)
    expect(screen.getByText(/执行 1 · 排队 0 · 等你 0/)).toBeInTheDocument()
    expect(screen.getByText(/运行会话 1 个/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '查看事项:参赛网页' })).toBeInTheDocument()
  })
})

describe('③ 球不再是蓝的', () => {
  it('「办完了、还没看」交给核心时按中性色;琥珀、红照旧', () => {
    expect(coreNoticeOf('completed')).toBe('neutral')
    expect(coreNoticeOf('confirmation')).toBe('confirmation')
    expect(coreNoticeOf('failed')).toBe('failed')
    expect(coreNoticeOf('neutral')).toBe('neutral')
  })
})

describe('④ 光效:同一套、按深色画、三层分开抬', () => {
  it('要你处理的卡、拖窗进槽是同一组参数;深色写死(台上在跑的卡卡 P 补三起不单独走光)', () => {
    expect('currentCard' in BEAM).toBe(false)
    expect(BEAM.slotHover.tune).toEqual(BEAM.ask.tune)
    expect(FX_THEME).toBe('dark')
    expect(beamTuneCss(BEAM.ask.tune)).toBe('[data-beam="{id}"]{--beam-stroke-opacity:6;--beam-bloom-opacity:4;--beam-inner-opacity:1.5}')
    expect(beamTuneCss(undefined)).toBeUndefined()
  })

  it('★拖窗悬停只亮提示字、不亮光;光只在「放下」那一下(dropFlash)亮(2026-09-25 卡 P)', () => {
    const ref = { current: null }
    const { rerender } = render(<SlotZone helper={{ connected: true, authorized: true }} snap={undefined} dockNote={undefined} bodyRef={ref} dropHover />)
    expect(screen.getByText('松手认领到窗位')).toBeInTheDocument()
    expect(document.querySelector('[data-fx="slot-hover"]')).toHaveAttribute('data-fx-active', 'false')
    rerender(<SlotZone helper={{ connected: true, authorized: true }} snap={undefined} dockNote={undefined} bodyRef={ref} dropHover={false} dropFlash />)
    expect(document.querySelector('[data-fx="slot-hover"]')).toHaveAttribute('data-fx-active', 'true')
  })
})

describe('⑤ 项目区只排他确认过的项目', () => {
  function project(id: string, confirmed: boolean): WorkbenchProject {
    return { id, name: id, stage: confirmed ? 'MVP 开发' : '待整理', links: [], session_count: 0, idle: false, ...(confirmed ? { confirmed: true as const } : {}) }
  }
  const projects = [project('boss', false), project('qq-recruit-k3', false), project('desktop-workbench', true), project('Aiboo', false), project('lapis', true)]

  it('confirmedSplit:有确认过的就分两摞;一个都没带标记(老服务)时照旧全排', () => {
    expect(confirmedSplit(projects).mine.map(p => p.id)).toEqual(['desktop-workbench', 'lapis'])
    expect(confirmedSplit(projects).others.map(p => p.id)).toEqual(['boss', 'qq-recruit-k3', 'Aiboo'])
    const legacy = projects.map(({ confirmed: _c, ...rest }): WorkbenchProject => rest)
    expect(confirmedSplit(legacy).mine).toHaveLength(5)
  })

  it('★看板页签:只有 desktop-workbench、lapis;其余三个收进「其他仓库(3)」,点开才排出来', async () => {
    render(<TaskBoard tasks={[]} sprints={[]} modules={[]} projectMeta={[]} projects={projects} sessions={[]} now={NOW} axis="module-rows" onAxisChange={vi.fn()} actions={{} as never} />)
    const tabs = screen.getByRole('group', { name: '项目' })
    expect(within(tabs).getByRole('button', { name: /desktop-workbench/ })).toBeInTheDocument()
    expect(within(tabs).queryByRole('button', { name: /boss/ })).toBeNull()
    const others = within(tabs).getByRole('button', { name: /其他仓库\(3\)/ })
    expect(others).toHaveAttribute('aria-expanded', 'false')
    await userEvent.click(others)
    expect(within(tabs).getByRole('button', { name: /boss/ })).toBeInTheDocument()
  })

  it('★总览:正文只有确认过的两行;扫到的在末尾「其他仓库(N)」里', () => {
    const view = buildProjectRows({ projects, pending: [], scan_errors: [], scanned_at: NOW }, Math.floor(Date.parse(NOW) / 1000))
    expect(view.rows.map(row => row.id)).toEqual(['desktop-workbench', 'lapis'])
    expect(view.otherRows.map(row => row.id)).toEqual(['boss', 'qq-recruit-k3', 'Aiboo'])
    render(<ProjectZone rows={view.rows} otherRows={view.otherRows} idleText="" pendingText="0 组 / 0 条" scanErrorTexts={[]} expandedId={null} onToggle={vi.fn()} onConfirmStatus={vi.fn()} />)
    expect(screen.getByText('其他仓库(3)')).toBeInTheDocument()
    expect(screen.getByText('其他仓库(3)').closest('details')).not.toHaveAttribute('open')
  })
})

describe('⑥ 首页:事务官在悬浮窗里(2026-10-27 起,原「首页默认是事务官档」)', () => {
  function sockets() {
    const made: MinimalWebSocket[] = []
    const factory = () => { const ws: MinimalWebSocket = { onmessage: null, onclose: null, close: () => {} }; made.push(ws); return ws }
    return { made, factory }
  }
  function fakeFetch(read: () => WorkbenchState, posts: string[]) {
    return vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') { posts.push(new URL(String(url)).pathname); return { ok: true, json: async () => ({ ok: true }) } }
      if (String(url).endsWith('/state')) return { ok: true, json: async () => ({ ...read() }) }
      return { ok: false, status: 404, json: async () => ({}) }
    }) as unknown as typeof fetch
  }
  function props(fetchImpl: typeof fetch, ws: () => MinimalWebSocket): WorkbenchOverlayProps {
    const instance = createWorkbenchStore().create()
    const workspaceState = { items: [], phase: 'ready', archivedSessionIds: [], state: 'idle', error: null, baselinesReady: true, recentWorkspaceId: undefined }
    return {
      useStore: selector => selector(instance.getSnapshot()),
      actions: instance.actions,
      useWorkspaces: selector => selector(workspaceState as never),
      useSessions: selector => selector({} as never),
      ...UNUSED_STANDARD_PROPS,
      openWorkspace: async () => {}, openSession: () => {},
      serviceFetch: fetchImpl, servicePollMs: 0, serviceWebSocket: ws,
    }
  }
  // 这台 node 带的 localStorage 是个没接文件的空壳(方法都没有),换成一份内存的。
  const stored = new Map<string, string>()
  const memoryStorage = { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => { stored.set(key, value) }, removeItem: (key: string) => { stored.delete(key) }, clear: () => stored.clear() }
  beforeEach(() => {
    stored.clear()
    Object.defineProperty(window, 'localStorage', { value: memoryStorage, configurable: true })
  })

  it('★叠里一扇窗都没有、引导走完了 → 事务官那页在悬浮窗里,窗口槽空着时说一句并给「打开协作区」', async () => {
    const posts: string[] = []
    render(<WorkbenchOverlay {...props(fakeFetch(() => state({ onboarding: { stage: 'done', done: true }, dock: { stack: [] }, tasks: tasksOf(), butler_inbox: { items: [] } }), posts), sockets().factory)} />)
    // 2026-10-27 已拍板:去掉独立的事务官标签页,入口只剩悬浮球;窗口槽里不再挂一份事务官页。
    await waitFor(() => expect(screen.getByLabelText('交给事务官一件事')).toBeVisible())
    expect(await screen.findByRole('button', { name: '打开协作区' })).toBeInTheDocument()
  })

  it('叠里一扇窗都没有、引导还没走完 → 照旧是窗位落点(首次那几句空态还在)', async () => {
    const posts: string[] = []
    render(<WorkbenchOverlay {...props(fakeFetch(() => state({ onboarding: { stage: 'opening', done: false }, dock: { stack: [] } }), posts), sockets().factory)} />)
    expect(await screen.findByText('把常用的应用从屏幕上拖进这块槽里,它就会出现在这排标签里。')).toBeInTheDocument()
  })

  it('★引导刚走完(done_at 第一次出现)→ 展开悬浮窗一次,同一次走完只做一次', async () => {
    const posts: string[] = []
    const snapshot = () => state({
      onboarding: { stage: 'done', done: true, done_at: '2026-09-24T10:51:50.678Z' },
      dock: { stack: [{ key: 'claude', label: 'Claude', running: true, current: true }] },
    })
    const first = render(<WorkbenchOverlay {...props(fakeFetch(snapshot, posts), sockets().factory)} />)
    // 2026-10-27 起走完引导 = 展开悬浮窗(事务官入口只剩它),不再去藏台前那扇窗。
    await waitFor(() => expect(window.localStorage.getItem(HOME_SHOWN_KEY)).toBe('2026-09-24T10:51:50.678Z'))
    expect(screen.getByLabelText('交给事务官一件事')).toBeVisible()
    expect(posts).not.toContain('/dock/hide')
    first.unmount()
    // 重开:同一次走完,不再抢(他之后点哪个标签就是哪个)。
    const again: string[] = []
    render(<WorkbenchOverlay {...props(fakeFetch(snapshot, again), sockets().factory)} />)
    await screen.findByText('工作台')
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(again).not.toContain('/dock/hide')
  })

  it('★悬停那条 /live 断了就一直重连(以前只重试一次:DSH 同版本重启两下之后,拖窗进槽再也没有光)', async () => {
    vi.useFakeTimers()
    try {
      const posts: string[] = []
      const ws = sockets()
      render(<WorkbenchOverlay {...props(fakeFetch(() => state(), posts), ws.factory)} />)
      expect(ws.made).toHaveLength(1)
      for (let round = 0; round < 4; round++) {
        act(() => { ws.made.at(-1)!.onclose?.() })
        await act(async () => { await vi.advanceTimersByTimeAsync(16_000) })
      }
      expect(ws.made.length).toBe(5)
      // 连上之后收到一条悬停:只有提示字,不亮光(卡 P);收到「放下」(没带 native)才亮一轮,过一圈自己灭。
      act(() => { ws.made.at(-1)!.onmessage?.({ data: JSON.stringify({ kind: 'hover', inside: true, native: true }) }) })
      expect(document.querySelector('[data-fx="slot-hover"]')).toHaveAttribute('data-fx-active', 'false')
      act(() => { ws.made.at(-1)!.onmessage?.({ data: JSON.stringify({ kind: 'slot_drop' }) }) })
      expect(document.querySelector('[data-fx="slot-hover"]')).toHaveAttribute('data-fx-active', 'true')
      await act(async () => { await vi.advanceTimersByTimeAsync(3300) })
      expect(document.querySelector('[data-fx="slot-hover"]')).toHaveAttribute('data-fx-active', 'false')
    }
    finally { vi.useRealTimers() }
  })
})
