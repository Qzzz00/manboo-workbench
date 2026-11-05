import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkbenchOverlay, type MinimalWebSocket, type WorkbenchOverlayProps } from '../src/client/Workbench.tsx'
import { createUserLayerRegistry } from '../src/client/userLayer.tsx'
import { createWorkbenchStore } from '../src/client/store.ts'
import type { GraphifyJobView, GraphifyStatusView, WorkbenchLayout, WorkbenchProject, WorkbenchState } from '../src/protocol.ts'
import { UNUSED_STANDARD_PROPS } from './helpers/standardProps.ts'

afterEach(cleanup)

/** 见 workbenchLayout.test.tsx 顶部注释:不喂假 WS 会真的去连 8791 端口。 */
function fakeWebSocket(): (url: string) => MinimalWebSocket {
  return () => ({ onmessage: null, onclose: null, close: () => {} })
}

function snapshot(over: Partial<WorkbenchState> = {}): WorkbenchState {
  return {
    agents: [
      { id: 'dsh', online: true, connected: true, waiting: 0, running: 0 },
      { id: 'claude', online: true, connected: true, waiting: 0, running: 0 },
      { id: 'codex', online: true, connected: true, waiting: 0, running: 0 },
      { id: 'kimi', online: false, connected: false, waiting: 0, running: 0 },
    ],
    sessions: [],
    quota: {},
    now: '2026-08-25T10:03:00+08:00',
    stale: false,
    ...over,
  }
}

/**
 * 页面级假 fetch:GET /state 每拍回一份新浅拷贝(同 client-notes-files 旧例),graphify
 * 端点按表回。顺手把**所有** POST 记下来 —— 「Finder 那一摊一条都不许再发」这条用
 * 它钉(/files/rect、/files/pin、/files/unpin 一个都不该出现)。
 */
function fakeFetchPage(read: () => WorkbenchState, calls: { url: string, body: unknown }[], graphify: {
  statusSequence?: GraphifyStatusView[]
  jobSequence?: GraphifyJobView[]
} = {}) {
  let statusAsks = 0
  let jobAsks = 0
  return vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url)
    // GET 也记下来(url,body undefined)——「status 是按项目现取的」这条要靠它钉。
    if (init?.method !== 'POST') calls.push({ url: u, body: undefined })
    if (init?.method === 'POST') {
      calls.push({ url: u, body: init.body === undefined ? undefined : JSON.parse(String(init.body)) })
      if (u.endsWith('/graphify/install') || u.endsWith('/graphify/build')) {
        return { ok: true, json: async () => ({ jobId: 'job-1' }) } as unknown as Response
      }
      return { ok: true, json: async () => ({ ok: true }) } as unknown as Response
    }
    if (u.includes('/graphify/status')) {
      const seq = graphify.statusSequence ?? [{ installed: false, generatedAt: null, hasHtml: true, running: false }]
      const view = seq[Math.min(statusAsks, seq.length - 1)]
      statusAsks += 1
      return { ok: true, json: async () => view } as unknown as Response
    }
    if (u.includes('/graphify/job')) {
      const seq = graphify.jobSequence ?? []
      const view = seq[Math.min(jobAsks, seq.length - 1)]
      jobAsks += 1
      return { ok: true, json: async () => view } as unknown as Response
    }
    return { ok: true, json: async () => ({ ...read() }) } as unknown as Response
  }) as unknown as typeof fetch
}

function props(options: { state?: WorkbenchState, fetchImpl?: typeof fetch, emptyLayer?: boolean } = {}): WorkbenchOverlayProps {
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
    serviceFetch: options.fetchImpl ?? fakeFetchPage(() => options.state ?? snapshot(), []),
    servicePollMs: 0,
    serviceWebSocket: fakeWebSocket(),
    /**
     * 2026-10-23:`emptyLayer` 的用例(图谱格、素材排)测的是**本体**那一格,传一份空
     * 登记表 —— 全局那份默认装着起步层(素材管理小组件会替掉 files 这一格),不隔开
     * 测到的就是她的格子不是本体的。其余用例照旧走全局登记表,和别页面用例一致。
     */
    ...(options.emptyLayer === true ? { userLayer: createUserLayerRegistry() } : {}),
  }
}

/** 底部两栏:notes(40%) 与 files(60%) 同 row 并排。 */
const BOTTOM_LAYOUT: WorkbenchLayout = {
  modules: [
    { id: 'projects', order: 0, basis_pct: 40, row: 0 },
    { id: 'notes', order: 1, basis_pct: 24, row: 2, width_pct: 40 },
    { id: 'files', order: 2, basis_pct: 24, row: 2, width_pct: 60 },
  ],
  butler: { corner: 'br', min: false },
}

const PATH_PROJECTS: readonly WorkbenchProject[] = [
  { id: 'p1', name: '样板项目', stage: 'MVP 开发', path: '/Users/example/Code/样板项目', links: [], session_count: 0, idle: false },
]

/**
 * **先等自定义布局落定再取节点**:第一帧渲染的是本地 DEFAULT_LAYOUT(那时底部还是组件条),
 * 服务端布局要等第一次轮询回来才套上,套上那一刻整片模块会重新挂载。先 findBy 拿到的
 * 节点会变成游离节点——对着它断言 contains、往它里面打字,都不会作用在真正在页面上的那个
 * 元素上(并行会话 2026-08-25 也在行/列 key 上踩过同一个坑)。「图谱」这个标题只在
 * 新布局里存在,拿它当"布局已落定"的信号最稳。
 */
async function waitForBottomRow(): Promise<void> {
  // 判据必须是**自定义布局独有**的东西。「图谱」这个标题在 DEFAULT_LAYOUT 里
  // 也有(2026-08-25 版面重排之后),拿它当信号会在默认布局那一帧就返回,取到的仍是
  // 随后会被替换掉的游离节点。BOTTOM_LAYOUT 里没有消耗数据/余额两块,"消耗数据这个
  // 标题消失了"才真正意味着服务端布局已经套上。
  await screen.findByRole('heading', { name: '图谱' })
  await waitFor(() => expect(screen.queryByRole('heading', { name: '消耗数据' })).toBeNull())
}

describe('底部两栏(2026-08-25 版面重排:widgets 拆成 notes + files 并排)', () => {
  it('两个模块同 row → 渲染在同一个 .ben-wb__row 容器里(复用既有的并排机制)', async () => {
    const state = snapshot({ layout: BOTTOM_LAYOUT })
    render(<WorkbenchOverlay {...props({ state })} />)
    await waitForBottomRow()
    const notesHeading = screen.getByRole('heading', { name: '随手记' })
    const filesHeading = screen.getByRole('heading', { name: '图谱' })
    const row = document.querySelector('.ben-wb__row')
    expect(row?.contains(notesHeading)).toBe(true)
    expect(row?.contains(filesHeading)).toBe(true)
  })

  it('随手记:服务端来的条目原样列出,一个框不分类不打标签(PRD §5.5)', async () => {
    const state = snapshot({
      layout: BOTTOM_LAYOUT,
      notes: [{ id: 'n1', text: '记一句', created_at: '2026-08-25T01:00:00.000Z' }],
    })
    render(<WorkbenchOverlay {...props({ state })} />)
    await waitForBottomRow()
    expect(screen.getByText('记一句')).toBeTruthy()
    expect(screen.getByLabelText('记录灵感或当天安排')).toBeTruthy()
  })

  it('随手记回车 → POST /note/add', async () => {
    const calls: { url: string, body: unknown }[] = []
    const state = snapshot({ layout: BOTTOM_LAYOUT })
    render(<WorkbenchOverlay {...props({ state, fetchImpl: fakeFetchPage(() => state, calls) })} />)
    await waitForBottomRow()
    await userEvent.type(screen.getByLabelText('记录灵感或当天安排'), '新的一条{Enter}')
    await waitFor(() => expect(calls.some(c => c.url.endsWith('/note/add'))).toBe(true))
    expect(calls.find(c => c.url.endsWith('/note/add'))?.body).toEqual({ text: '新的一条' })
  })
})

describe('图谱格(2026-10-23,卡「系统文件夹改成Graphify图谱」)', () => {
  it('graphify 没装 → 「生成图谱要先装 graphify」+ 「装上」键', async () => {
    const calls: { url: string, body: unknown }[] = []
    const state = snapshot({ layout: BOTTOM_LAYOUT, projects: { projects: PATH_PROJECTS, pending: [], scan_errors: [], scanned_at: '2026-10-23T00:00:00.000Z' } })
    render(<WorkbenchOverlay {...props({ state, fetchImpl: fakeFetchPage(() => state, calls), emptyLayer: true })} />)
    await waitForBottomRow()
    expect(await screen.findByText('生成图谱要先装 graphify')).toBeTruthy()
    expect(screen.getByRole('button', { name: '装上' })).toBeTruthy()
    // status 是按项目现取的。
    await waitFor(() => expect(calls.some(c => c.url.includes('/graphify/status?project=p1'))).toBe(true))
  })

  it('点「装上」→ POST /graphify/install,轮询 job;done 后这一格切到「重建图谱」那一档', async () => {
    const calls: { url: string, body: unknown }[] = []
    const state = snapshot({ layout: BOTTOM_LAYOUT, projects: { projects: PATH_PROJECTS, pending: [], scan_errors: [], scanned_at: '2026-10-23T00:00:00.000Z' } })
    const fetchImpl = fakeFetchPage(() => state, calls, {
      statusSequence: [
        { installed: false, generatedAt: null, hasHtml: true, running: false },
        { installed: true, generatedAt: null, hasHtml: true, running: false },
      ],
      jobSequence: [
        { id: 'job-1', status: 'running', startedAt: 1 },
        { id: 'job-1', status: 'done', startedAt: 1, finishedAt: 2 },
      ],
    })
    render(<WorkbenchOverlay {...props({ state, fetchImpl, emptyLayer: true })} />)
    await waitForBottomRow()
    await userEvent.click(await screen.findByRole('button', { name: '装上' }))
    await waitFor(() => expect(calls.some(c => c.url.endsWith('/graphify/install'))).toBe(true))
    // 装好了、还没生成 → 「这个项目还没有图谱」+ 能点的「重建图谱」。
    expect(await screen.findByText('这个项目还没有图谱', undefined, { timeout: 4000 })).toBeTruthy()
    expect(screen.getByRole('button', { name: '重建图谱' })).toBeEnabled()
  })

  it('点「重建图谱」→ POST /graphify/build 带 projectId;done 后 iframe 挂上 graph.html', async () => {
    const calls: { url: string, body: unknown }[] = []
    const state = snapshot({ layout: BOTTOM_LAYOUT, projects: { projects: PATH_PROJECTS, pending: [], scan_errors: [], scanned_at: '2026-10-23T00:00:00.000Z' } })
    const fetchImpl = fakeFetchPage(() => state, calls, {
      statusSequence: [
        { installed: true, generatedAt: null, hasHtml: true, running: false },
        { installed: true, generatedAt: 1729650000000, hasHtml: true, running: false },
      ],
      jobSequence: [
        { id: 'job-1', status: 'running', startedAt: 1 },
        { id: 'job-1', status: 'done', startedAt: 1, finishedAt: 2 },
      ],
    })
    render(<WorkbenchOverlay {...props({ state, fetchImpl, emptyLayer: true })} />)
    await waitForBottomRow()
    await userEvent.click(await screen.findByRole('button', { name: '重建图谱' }))
    await waitFor(() => expect(calls.some(c => c.url.endsWith('/graphify/build'))).toBe(true))
    expect(calls.find(c => c.url.endsWith('/graphify/build'))?.body).toEqual({ projectId: 'p1' })
    const frame = await screen.findByTitle('项目图谱', undefined, { timeout: 4000 })
    expect(frame).toHaveAttribute('src', expect.stringContaining('/graphify/view/p1/graph.html?t=1729650000000'))
  })

  it('已生成 → iframe 挂上,t 用 generatedAt 绕缓存', async () => {
    const calls: { url: string, body: unknown }[] = []
    const state = snapshot({ layout: BOTTOM_LAYOUT, projects: { projects: PATH_PROJECTS, pending: [], scan_errors: [], scanned_at: '2026-10-23T00:00:00.000Z' } })
    const fetchImpl = fakeFetchPage(() => state, calls, {
      statusSequence: [{ installed: true, generatedAt: 1729650000000, hasHtml: true, running: false }],
    })
    render(<WorkbenchOverlay {...props({ state, fetchImpl, emptyLayer: true })} />)
    await waitForBottomRow()
    const frame = await screen.findByTitle('项目图谱')
    expect(frame).toHaveAttribute('src', 'http://127.0.0.1:8791/graphify/view/p1/graph.html?t=1729650000000')
    expect(screen.getByText(/上次生成:/)).toBeTruthy()
  })

  it('一个带 path 的项目都没有 → 如实一句', async () => {
    const state = snapshot({
      layout: BOTTOM_LAYOUT,
      projects: { projects: [{ id: 'p1', name: '没路径的', stage: '待整理', links: [], session_count: 0, idle: false }], pending: [], scan_errors: [], scanned_at: '2026-10-23T00:00:00.000Z' },
    })
    render(<WorkbenchOverlay {...props({ state, emptyLayer: true })} />)
    await waitForBottomRow()
    expect(await screen.findByText('项目区里还没有带本机路径的项目')).toBeTruthy()
  })

  it('素材那一排按钮照旧(ops 模板给了路径就画),走 /files/reveal', async () => {
    const calls: { url: string, body: unknown }[] = []
    const state = snapshot({
      layout: BOTTOM_LAYOUT,
      projects: { projects: PATH_PROJECTS, pending: [], scan_errors: [], scanned_at: '2026-10-23T00:00:00.000Z' },
      template: {
        id: 'product', name: '做产品', project_word: '项目', project_empty_line: '',
        module_titles: {}, board_lanes: [], has_backup: false,
        asset_dirs: { 脚本: '/Users/example/运营/素材/脚本' },
        asset_files: { 收藏网址: '/Users/example/运营/素材/收藏网址.md' },
      },
    })
    render(<WorkbenchOverlay {...props({ state, fetchImpl: fakeFetchPage(() => state, calls), emptyLayer: true })} />)
    await waitForBottomRow()
    await userEvent.click(await screen.findByRole('button', { name: '收藏网址' }))
    await waitFor(() => expect(calls.some(c => c.url.endsWith('/files/reveal'))).toBe(true))
    expect(calls.find(c => c.url.endsWith('/files/reveal'))?.body).toEqual({ path: '/Users/example/运营/素材/收藏网址.md' })
  })
})

describe('Finder 那一摊已经拆干净了(2026-10-23)', () => {
  // 同 client-dock.test.tsx:壳内身份标识,走「上报只认壳内页面」那条老路。
  beforeEach(() => { window.history.replaceState(null, '', '/?ben-workbench=app') })
  afterEach(() => { window.history.replaceState(null, '', '/') })

  it('页面开多久都不再有 /files/rect、/files/pin、/files/unpin', async () => {
    const calls: { url: string, body: unknown }[] = []
    const state = snapshot({ layout: BOTTOM_LAYOUT, projects: { projects: PATH_PROJECTS, pending: [], scan_errors: [], scanned_at: '2026-10-23T00:00:00.000Z' } })
    render(<WorkbenchOverlay {...props({ state, fetchImpl: fakeFetchPage(() => state, calls) })} servicePollMs={50} />)
    await waitForBottomRow()
    await new Promise(resolve => setTimeout(resolve, 300))
    for (const call of calls) {
      expect(call.url).not.toContain('/files/rect')
      expect(call.url).not.toContain('/files/pin')
      expect(call.url).not.toContain('/files/unpin')
    }
  })
})

describe('起步层分模板适配(2026-10-23 第三轮:files 小组件只替 ops)', () => {
  // 这两份用例走**默认登记表**(全局那份装着真起步层,见 tests/setup/starterLayer.ts),
  // template.id 决定小组件替不替这一格 —— 与模板分层的接缝一起钉,不许只单测 GraphView。

  it('product:files 格直接是本体图谱格 —— 没有素材入口/整理与图谱/Wiki,一上来就是 graphify 那一档', async () => {
    const state = snapshot({
      layout: BOTTOM_LAYOUT,
      template: {
        id: 'product', name: '做产品', project_word: '项目', project_empty_line: '',
        module_titles: {}, board_lanes: [], has_backup: false,
      },
      projects: { projects: PATH_PROJECTS, pending: [], scan_errors: [], scanned_at: '2026-10-23T00:00:00.000Z' },
    })
    render(<WorkbenchOverlay {...props({ state, fetchImpl: fakeFetchPage(() => state, []) })} />)
    await waitForBottomRow()
    expect(await screen.findByText('生成图谱要先装 graphify')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '素材入口' })).toBeNull()
    expect(screen.queryByRole('button', { name: '整理与图谱' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Wiki' })).toBeNull()
  })

  it('ops:files 格是素材管理小组件 —— 素材入口 8 个分类都在,定位走 /files/reveal', async () => {
    const calls: { url: string, body: unknown }[] = []
    const assetDirs = Object.fromEntries(
      Array.from({ length: 8 }, (_, index) => [`分类${index + 1}`, `/Users/example/运营/素材/分类${index + 1}`]),
    )
    const state = snapshot({
      layout: BOTTOM_LAYOUT,
      template: {
        id: 'ops', name: '自媒体运营', project_word: '账号', project_empty_line: '',
        module_titles: { files: '素材管理' }, board_lanes: [], has_backup: false,
        asset_dirs: assetDirs,
      },
      projects: { projects: PATH_PROJECTS, pending: [], scan_errors: [], scanned_at: '2026-10-23T00:00:00.000Z' },
    })
    render(<WorkbenchOverlay {...props({ state, fetchImpl: fakeFetchPage(() => state, calls) })} />)
    // ops 布局里 files 的标题是「素材管理」,不是「图谱」。
    await screen.findByRole('heading', { name: '素材管理' })
    await waitFor(() => expect(screen.queryByRole('heading', { name: '消耗数据' })).toBeNull())
    expect(screen.getByRole('button', { name: '素材入口' })).toBeTruthy()
    for (let index = 1; index <= 8; index += 1) {
      expect(screen.getByRole('button', { name: `定位分类${index}` })).toBeTruthy()
    }
    await userEvent.click(screen.getByRole('button', { name: '定位分类3' }))
    await waitFor(() => expect(calls.some(c => c.url.endsWith('/files/reveal'))).toBe(true))
    expect(calls.find(c => c.url.endsWith('/files/reveal'))?.body).toEqual({ path: '/Users/example/运营/素材/分类3' })
  })
})
