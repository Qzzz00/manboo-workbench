/**
 * 「图谱」格的图谱体 GraphView(2026-10-23,卡「系统文件夹改成Graphify图谱」)。
 *
 * 三档状态与两条作业流(install / build)都在这里钉,页面级的那一份
 * (client-notes-files.test.tsx)只看「这一格在工作台上接对了没有」。
 * fetch 全 mock;轮询间隔是 1 秒,job 的 running→done 用「第几次问」来翻。
 */
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ArchifyStatusView, GraphifyJobView, GraphifyStatusView, WorkbenchProject } from '../src/protocol.ts'
import { GraphView, graphAgeText } from '../src/client/GraphView.tsx'

afterEach(cleanup)

const PROJECTS: readonly WorkbenchProject[] = [
  { id: 'p1', name: '样板项目', stage: 'MVP 开发', path: '/Users/example/Code/样板项目', links: [], session_count: 0, idle: true },
  { id: 'p2', name: '另一个项目', stage: 'MVP 开发', path: '/Users/example/Code/另一个项目', links: [], session_count: 0, idle: true },
  { id: 'no-path', name: '没路径的', stage: '待整理', links: [], session_count: 0, idle: true },
]

/** 路由式假 fetch:graphify 端点按表回,其余空 ok。job 与 status 都按调用次数翻状态。 */
function fakeFetch(routes: {
  status?: GraphifyStatusView
  statusSequence?: GraphifyStatusView[]
  jobSequence?: GraphifyJobView[]
  /** /graphify/job 一回这个状态码(404 = 服务重启,作业没了)。 */
  jobStatus?: number
  installBody?: unknown
  buildStatus?: number
  buildBody?: unknown
}) {
  const calls: { url: string, body?: unknown }[] = []
  let jobAsks = 0
  let statusAsks = 0
  const impl = (vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url)
    calls.push({ url: u, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) })
    if (u.includes('/graphify/status')) {
      const seq = routes.statusSequence
      const view = seq !== undefined
        ? seq[Math.min(statusAsks, seq.length - 1)]
        : routes.status ?? { installed: false, generatedAt: null, hasHtml: true, running: false }
      statusAsks += 1
      return { ok: true, json: async () => view } as Response
    }
    if (u.includes('/graphify/job')) {
      if (routes.jobStatus !== undefined) {
        jobAsks += 1
        return { ok: false, status: routes.jobStatus, json: async () => ({ error: '没有这条作业' }) } as Response
      }
      const seq = routes.jobSequence ?? []
      const view = seq[Math.min(jobAsks, seq.length - 1)]
      jobAsks += 1
      return { ok: true, json: async () => view } as Response
    }
    if (u.endsWith('/graphify/install')) {
      if (routes.installBody !== undefined) return routes.installBody as Response
      return { ok: true, json: async () => ({ jobId: 'job-install' }) } as Response
    }
    if (u.endsWith('/graphify/build')) {
      if (routes.buildStatus !== undefined) {
        return { ok: false, status: routes.buildStatus, json: async () => routes.buildBody ?? { error: 'build 被拒的那句原话' } } as Response
      }
      return { ok: true, json: async () => ({ jobId: 'job-build' }) } as Response
    }
    return { ok: true, json: async () => ({ ok: true }) } as Response
  }) as unknown) as typeof fetch
  return { impl, calls, get jobAsks() { return jobAsks } }
}

describe('graphAgeText(相对时间)', () => {
  const NOW = Date.parse('2026-10-23T12:00:00+08:00')
  it('刚刚 / N 分钟前 / N 小时前 / N 天前', () => {
    expect(graphAgeText(NOW - 10_000, NOW)).toBe('刚刚')
    expect(graphAgeText(NOW - 5 * 60_000, NOW)).toBe('5 分钟前')
    expect(graphAgeText(NOW - 3 * 3_600_000, NOW)).toBe('3 小时前')
    expect(graphAgeText(NOW - 2 * 86_400_000, NOW)).toBe('2 天前')
  })
  it('认不出的值回 undefined,不编', () => {
    expect(graphAgeText(Number.NaN, NOW)).toBeUndefined()
    expect(graphAgeText(NOW + 60_000, NOW)).toBeUndefined()
  })
})

describe('项目选择', () => {
  it('★项目区从空到加载出来(loading→ready):Hook 顺序稳定,图谱格照常挂上(2026-10-24 整包红回归)', async () => {
    const { impl } = fakeFetch({ status: { installed: true, generatedAt: 1792755923230, hasHtml: true, running: false } })
    const noPath: readonly WorkbenchProject[] = [{ id: 'no-path', name: '没路径的', stage: '待整理', links: [], session_count: 0, idle: true }]
    const { rerender } = render(<GraphView baseUrl="http://x" fetchImpl={impl} projects={noPath} />)
    expect(screen.getByText('项目区里还没有带本机路径的项目')).toBeTruthy()
    // 项目区一拍之后有了带 path 的项目:同一组件实例换档 —— early return 之后有 Hook 时,
    // 这里会抛「Rendered more hooks than during the previous render」(d79e 整包 7 失败根因)
    rerender(<GraphView baseUrl="http://x" fetchImpl={impl} projects={PROJECTS} currentProjectId="p2" />)
    const iframe = await screen.findByTitle('项目图谱')
    expect(iframe.getAttribute('src')).toContain('/graphify/view/p2/graph.html')
    // 状态再切:架构图 Tab 一个来回,渲染照常不炸
    fireEvent.click(screen.getByRole('tab', { name: /架构图/ }))
    await screen.findByText('这个项目还没有架构图')
    fireEvent.click(screen.getByRole('tab', { name: /关系图/ }))
    await screen.findByTitle('项目图谱')
  })

  it('一个带 path 的项目也没有 → 如实一句,不摆点不动的键(D13)', () => {
    render(<GraphView baseUrl="http://x" fetchImpl={fakeFetch({}).impl} projects={[{ id: 'no-path', name: '没路径的', stage: '待整理', links: [], session_count: 0, idle: true }]} />)
    expect(screen.getByText('项目区里还没有带本机路径的项目')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '重建图谱' })).toBeNull()
  })

  it('只有一个带 path 的项目 → 顶行写名字,不给 select', async () => {
    const { impl, calls } = fakeFetch({ status: { installed: true, generatedAt: null, hasHtml: true, running: false } })
    render(<GraphView baseUrl="http://x" fetchImpl={impl} projects={[PROJECTS[0]!]} />)
    expect(screen.getByText('样板项目')).toBeTruthy()
    expect(screen.queryByRole('combobox')).toBeNull()
    await waitFor(() => expect(calls.some(c => c.url.includes('/graphify/status?project=p1'))).toBe(true))
  })

  it('多个带 path 的项目 → 顶行给 select;没给 currentProjectId 时选第一个', async () => {
    const { impl, calls } = fakeFetch({ status: { installed: true, generatedAt: null, hasHtml: true, running: false } })
    render(<GraphView baseUrl="http://x" fetchImpl={impl} projects={PROJECTS} />)
    const select = screen.getByRole('combobox', { name: '图谱项目' }) as HTMLSelectElement
    expect(select.value).toBe('p1')
    // 多项目时顶行是 select,不再是干写名字那一颗。
    expect(document.querySelector('.ben-wb__graph-name')).toBeNull()
    await waitFor(() => expect(calls.some(c => c.url.includes('/graphify/status?project=p1'))).toBe(true))
  })

  it('currentProjectId 指向的项目优先;换了它 → 重新拉那个项目的 status', async () => {
    const { impl, calls } = fakeFetch({ status: { installed: true, generatedAt: null, hasHtml: true, running: false } })
    const { rerender } = render(<GraphView baseUrl="http://x" fetchImpl={impl} projects={PROJECTS} currentProjectId="p1" />)
    await waitFor(() => expect(calls.some(c => c.url.includes('/graphify/status?project=p1'))).toBe(true))
    rerender(<GraphView baseUrl="http://x" fetchImpl={impl} projects={PROJECTS} currentProjectId="p2" />)
    await waitFor(() => expect(calls.some(c => c.url.includes('/graphify/status?project=p2'))).toBe(true))
  })

  it('currentProjectId 指向的项目没有 path → 退回本地选择', async () => {
    const { impl, calls } = fakeFetch({ status: { installed: true, generatedAt: null, hasHtml: true, running: false } })
    render(<GraphView baseUrl="http://x" fetchImpl={impl} projects={PROJECTS} currentProjectId="no-path" />)
    await waitFor(() => expect(calls.some(c => c.url.includes('/graphify/status?project=p1'))).toBe(true))
  })

  it('★项目区展开着项目时下拉选另一个 → 以显式选择为准,不被 currentProjectId 盖回', async () => {
    const { impl, calls } = fakeFetch({ status: { installed: true, generatedAt: null, hasHtml: true, running: false } })
    render(<GraphView baseUrl="http://x" fetchImpl={impl} projects={PROJECTS} currentProjectId="p1" />)
    await waitFor(() => expect(calls.some(c => c.url.includes('/graphify/status?project=p1'))).toBe(true))
    // 用户显式切到 p2:此后拉的是 p2 的 status,不会因为 p1 还展开着就跳回去。
    await userEvent.selectOptions(screen.getByRole('combobox', { name: '图谱项目' }), 'p2')
    await waitFor(() => expect(calls.filter(c => c.url.includes('/graphify/status?project=p2')).length).toBeGreaterThan(0))
    expect(calls[calls.length - 1]?.url).toContain('/graphify/status?project=p2')
  })

  it('★项目区换了展开(他明摆着换了「当前项目」)→ 显式选择清掉,格子跟过去', async () => {
    const { impl, calls } = fakeFetch({ status: { installed: true, generatedAt: null, hasHtml: true, running: false } })
    const { rerender } = render(<GraphView baseUrl="http://x" fetchImpl={impl} projects={PROJECTS} currentProjectId="p1" />)
    await waitFor(() => expect(calls.some(c => c.url.includes('/graphify/status?project=p1'))).toBe(true))
    await userEvent.selectOptions(screen.getByRole('combobox', { name: '图谱项目' }), 'p2')
    await waitFor(() => expect(calls.filter(c => c.url.includes('/graphify/status?project=p2')).length).toBeGreaterThan(0))
    // 展开从 p1 换成 p2:跟项目区走(p2),不是留在刚才手动挑的那个。
    rerender(<GraphView baseUrl="http://x" fetchImpl={impl} projects={PROJECTS} currentProjectId="p2" />)
    await waitFor(() => {
      const last = calls.filter(c => c.url.includes('/graphify/status')).at(-1)
      expect(last?.url).toContain('/graphify/status?project=p2')
    })
  })
})

describe('install 流(graphify 还没装)', () => {
  it('未装 → 一句实话 + 「装上」键', async () => {
    const { impl } = fakeFetch({ status: { installed: false, generatedAt: null, hasHtml: true, running: false } })
    render(<GraphView baseUrl="http://x" fetchImpl={impl} projects={[PROJECTS[0]!]} />)
    expect(await screen.findByText('生成图谱要先装 graphify')).toBeTruthy()
    expect(screen.getByRole('button', { name: '装上' })).toBeTruthy()
    // 没装的时候「重建图谱」是灰的 —— 装了之前没有「重建」这回事。
    expect(screen.getByRole('button', { name: '重建图谱' })).toBeDisabled()
  })

  it('点「装上」→ POST /graphify/install,轮询 job 到 done 后重拉 status', async () => {
    const { impl, calls } = fakeFetch({
      // 装之前没装;job done 之后重拉的那一遍说「装好了、还没生成」。
      statusSequence: [
        { installed: false, generatedAt: null, hasHtml: true, running: false },
        { installed: true, generatedAt: null, hasHtml: true, running: false },
        { installed: true, generatedAt: null, hasHtml: true, running: false },
      ],
      jobSequence: [
        { id: 'job-install', status: 'running', startedAt: 1 },
        { id: 'job-install', status: 'done', startedAt: 1, finishedAt: 2 },
      ],
    })
    render(<GraphView baseUrl="http://x" fetchImpl={impl} projects={[PROJECTS[0]!]} />)
    await screen.findByText('生成图谱要先装 graphify')
    await userEvent.click(screen.getByRole('button', { name: '装上' }))
    await waitFor(() => expect(calls.some(c => c.url.endsWith('/graphify/install'))).toBe(true))
    // 轮询到 done,重拉 status(installed 了) → 未装那一句退场。
    await waitFor(() => expect(screen.queryByText('生成图谱要先装 graphify')).toBeNull(), { timeout: 4000 })
    expect(calls.some(c => c.url.includes('/graphify/status?project=p1'))).toBe(true)
  })

  it('job 落在 error 上 → 把 job.error 原文贴出来(role=status)', async () => {
    const { impl } = fakeFetch({
      jobSequence: [{ id: 'job-install', status: 'error', startedAt: 1, finishedAt: 2, error: 'npm 装不上的那句原话' }],
    })
    render(<GraphView baseUrl="http://x" fetchImpl={impl} projects={[PROJECTS[0]!]} />)
    await screen.findByText('生成图谱要先装 graphify')
    await userEvent.click(screen.getByRole('button', { name: '装上' }))
    expect(await screen.findByText('npm 装不上的那句原话')).toHaveAttribute('role', 'status')
  })
})

describe('build 流(已装,生成 / 重建)', () => {
  it('已装、还没生成 → 「这个项目还没有图谱」+ 一颗能点的「重建图谱」', async () => {
    const { impl } = fakeFetch({ status: { installed: true, generatedAt: null, hasHtml: true, running: false } })
    render(<GraphView baseUrl="http://x" fetchImpl={impl} projects={[PROJECTS[0]!]} />)
    expect(await screen.findByText('这个项目还没有图谱')).toBeTruthy()
    expect(screen.getByRole('button', { name: '重建图谱' })).toBeEnabled()
  })

  it('点「重建图谱」→ POST /graphify/build 带 projectId;running 期间键禁用、说「正在生成…」;done 后重拉 status', async () => {
    const { impl, calls } = fakeFetch({
      // 生成前 installed、没图谱;build done 之后重拉的那一遍带来 generatedAt(刷新 iframe)。
      statusSequence: [
        { installed: true, generatedAt: null, hasHtml: true, running: false },
        { installed: true, generatedAt: 1729650000000, hasHtml: true, running: false },
      ],
      jobSequence: [
        { id: 'job-build', status: 'running', startedAt: 1 },
        { id: 'job-build', status: 'done', startedAt: 1, finishedAt: 2 },
      ],
    })
    render(<GraphView baseUrl="http://x" fetchImpl={impl} projects={[PROJECTS[0]!]} />)
    await screen.findByText('这个项目还没有图谱')
    await userEvent.click(screen.getByRole('button', { name: '重建图谱' }))
    await waitFor(() => expect(calls.some(c => c.url.endsWith('/graphify/build'))).toBe(true))
    expect(calls.find(c => c.url.endsWith('/graphify/build'))?.body).toEqual({ projectId: 'p1' })
    expect(screen.getByText('正在生成…')).toBeTruthy()
    expect(screen.getByRole('button', { name: '重建图谱' })).toBeDisabled()
    // done 后重拉 status(新的 generatedAt 会刷新 iframe)——这里等到 iframe 出现即算重拉生效。
    expect(await screen.findByTitle('项目图谱', undefined, { timeout: 4000 })).toBeTruthy()
  })

  it('build 被 4xx 拒 → 把服务端 error 原文贴出来,不发 job 轮询', async () => {
    const { impl, calls } = fakeFetch({
      status: { installed: true, generatedAt: null, hasHtml: true, running: false },
      buildStatus: 409,
      buildBody: { error: '这个项目没有本机路径' },
    })
    render(<GraphView baseUrl="http://x" fetchImpl={impl} projects={[PROJECTS[0]!]} />)
    await screen.findByText('这个项目还没有图谱')
    await userEvent.click(screen.getByRole('button', { name: '重建图谱' }))
    expect(await screen.findByText('这个项目没有本机路径')).toHaveAttribute('role', 'status')
    expect(calls.some(c => c.url.includes('/graphify/job'))).toBe(false)
  })

  it('job 落在 error 上 → 原文贴出来(role=status)', async () => {
    const { impl } = fakeFetch({
      status: { installed: true, generatedAt: null, hasHtml: true, running: false },
      jobSequence: [{ id: 'job-build', status: 'error', startedAt: 1, finishedAt: 2, error: 'graphify 跑挂了的那句' }],
    })
    render(<GraphView baseUrl="http://x" fetchImpl={impl} projects={[PROJECTS[0]!]} />)
    await screen.findByText('这个项目还没有图谱')
    await userEvent.click(screen.getByRole('button', { name: '重建图谱' }))
    expect(await screen.findByText('graphify 跑挂了的那句')).toHaveAttribute('role', 'status')
  })
})

describe('有图谱(iframe)', () => {
  it('已装且 generatedAt 有值 → iframe src 带 /graphify/view/<id>/graph.html?t=<generatedAt>,title「项目图谱」', async () => {
    const { impl } = fakeFetch({ status: { installed: true, generatedAt: 1729650000000, hasHtml: true, running: false } })
    render(<GraphView baseUrl="http://x" fetchImpl={impl} projects={[PROJECTS[0]!]} />)
    const frame = await screen.findByTitle('项目图谱')
    expect(frame).toHaveAttribute('src', 'http://x/graphify/view/p1/graph.html?t=1729650000000')
    // graph.html 要能点节点、取同目录的 graph.json —— scripts 与同 origin 都得给。
    expect(frame).toHaveAttribute('sandbox', 'allow-scripts allow-same-origin')
    expect(screen.getByText(/上次生成:/)).toBeTruthy()
  })

  it('★没有 html(hasHtml:false)→ 如实一句,不嵌空 iframe(5000 节点死文案已修,大图恒有图页)', async () => {
    const { impl } = fakeFetch({ status: { installed: true, generatedAt: 1729650000000, hasHtml: false, running: false } })
    render(<GraphView baseUrl="http://x" fetchImpl={impl} projects={[PROJECTS[0]!]} />)
    expect(await screen.findByText(/图谱页没有生成出来/)).toBeTruthy()
    expect(screen.queryByTitle('项目图谱')).toBeNull()
  })

  it('「上次生成:」写相对时间', async () => {
    const generatedAt = Date.now() - 5 * 60_000
    const { impl } = fakeFetch({ status: { installed: true, generatedAt, hasHtml: true, running: false } })
    render(<GraphView baseUrl="http://x" fetchImpl={impl} projects={[PROJECTS[0]!]} />)
    await screen.findByTitle('项目图谱')
    expect(screen.getByText(/上次生成:/).textContent).toContain('5 分钟前')
  })
})

describe('作业 404(服务重启)与同 id 重渲染(第三轮验收)', () => {
  it('job 轮询吃到 404 → 停轮询、重拉 status、给一句可以再点的错', async () => {
    const { impl, calls } = fakeFetch({
      status: { installed: true, generatedAt: null, hasHtml: true, running: false },
      jobStatus: 404,
    })
    render(<GraphView baseUrl="http://x" fetchImpl={impl} projects={[PROJECTS[0]!]} />)
    await screen.findByText('这个项目还没有图谱')
    await userEvent.click(screen.getByRole('button', { name: '重建图谱' }))
    expect(await screen.findByText(/作业找不到了/)).toHaveAttribute('role', 'status')
    // 404 之后不再轮询:job 询问次数定格;status 重拉过(重启判据后的恢复动作)。
    const asksAt404 = calls.filter(c => c.url.includes('/graphify/job')).length
    await new Promise(resolve => setTimeout(resolve, 2_600))
    expect(calls.filter(c => c.url.includes('/graphify/job')).length).toBe(asksAt404)
    expect(calls.filter(c => c.url.includes('/graphify/status')).length).toBeGreaterThanOrEqual(2)
    // 「重建图谱」键回到能点的状态(错误可重试,不是死忙)。
    expect(screen.getByRole('button', { name: '重建图谱' })).toBeEnabled()
  })

  it('同 id 换了新 project 对象(每拍快照)期间,正在跑的作业不被清掉,终态照常可见', async () => {
    const { impl } = fakeFetch({
      statusSequence: [
        { installed: true, generatedAt: null, hasHtml: true, running: false },
        { installed: true, generatedAt: 1729650000000, hasHtml: true, running: false },
      ],
      jobSequence: [
        { id: 'job-build', status: 'running', startedAt: 1 },
        { id: 'job-build', status: 'running', startedAt: 1 },
        { id: 'job-build', status: 'done', startedAt: 1, finishedAt: 2 },
      ],
    })
    const fresh = (over: Partial<WorkbenchProject>): WorkbenchProject =>
      ({ ...PROJECTS[0]!, ...over } as WorkbenchProject)
    const first = render(<GraphView baseUrl="http://x" fetchImpl={impl} projects={[fresh({})]} />)
    await screen.findByText('这个项目还没有图谱')
    await userEvent.click(screen.getByRole('button', { name: '重建图谱' }))
    expect(screen.getByText(/正在生成|正在/)).toBeTruthy()
    // 轮询中途 projects 整组换新对象(同 id)——作业照跑。
    first.rerender(<GraphView baseUrl="http://x" fetchImpl={impl} projects={[fresh({ name: '换了新对象' })]} />)
    // 终态:done 后重拉 status → iframe 出现;若作业被误清,这里永远等不到。
    expect(await screen.findByTitle('项目图谱', undefined, { timeout: 5_000 })).toBeTruthy()
  })
})

describe('异步回包按「项目 + 代次」隔离(2026-10-23 第五轮,真实 Chrome 交错响应复现的两条)', () => {
  // 全部用**手动把持的 promise**(deferred)控制响应到达顺序,不靠 sleep;
  // 轮询拍由 fake timers 推进,推进只触发生效,不是等时间。
  const A: WorkbenchProject & { path: string } = { id: 'p1', name: '项目A', stage: 'MVP 开发', path: '/a', links: [], session_count: 0, idle: true }
  const B: WorkbenchProject & { path: string } = { id: 'p2', name: '项目B', stage: 'MVP 开发', path: '/b', links: [], session_count: 0, idle: true }
  const EMPTY_A: GraphifyStatusView = { installed: true, generatedAt: null, hasHtml: true, running: false }
  const WITH_B: GraphifyStatusView = { installed: true, generatedAt: 1729650000000, hasHtml: true, running: false }

  function deferred<T>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((res) => { resolve = res })
    return { promise, resolve }
  }

  /** A 的 status 把持、B 立即回;作业端点按 jobId 把持表走。 */
  function holdingFetch(holds: {
    aStatus?: { promise: Promise<Response>, resolve: (r: Response) => void }
    jobById?: Record<string, { promise: Promise<Response>, resolve: (r: Response) => void }>
  }) {
    const statusCalls: string[] = []
    const jobCalls: string[] = []
    const impl = (async (url: string, init?: RequestInit) => {
      const u = String(url)
      if (u.includes('/graphify/status')) {
        const project = new URL(u, 'http://x').searchParams.get('project')
        statusCalls.push(project ?? '')
        if (project === 'p1' && holds.aStatus !== undefined) return holds.aStatus.promise
        return { ok: true, json: async () => (project === 'p2' ? WITH_B : EMPTY_A) } as unknown as Response
      }
      if (u.includes('/graphify/job')) {
        const id = new URL(u, 'http://x').searchParams.get('id') ?? ''
        jobCalls.push(id)
        const held = holds.jobById?.[id]
        if (held !== undefined) return held.promise
        return { ok: true, json: async () => ({ id, status: 'done' as const, startedAt: 1, finishedAt: 2 }) } as unknown as Response
      }
      if (u.endsWith('/graphify/build')) {
        return { ok: true, json: async () => ({ jobId: 'job-build' }) } as unknown as Response
      }
      return { ok: true, json: async () => ({ ok: true }) } as unknown as Response
    }) as unknown as typeof fetch
    return { impl, statusCalls, jobCalls }
  }

  afterEach(() => { vi.useRealTimers() })

  it('★A 的 status 延后,B 已显示 → 放回 A 空图,不得把 B 的图清掉', async () => {
    const held = deferred<Response>()
    const { impl } = holdingFetch({ aStatus: held })
    render(<GraphView baseUrl="http://x" fetchImpl={impl} projects={[A, B]} />)
    // 初始:current=A,status 被把持(还没回来)。
    await act(async () => { await Promise.resolve() })
    // 切到 B:B 的 status 立即回 → B 的 iframe 挂上。
    fireEvent.change(screen.getByRole('combobox', { name: '图谱项目' }) as HTMLSelectElement, { target: { value: 'p2' } })
    await act(async () => { await Promise.resolve() })
    const frame = screen.getByTitle('项目图谱')
    expect(frame).toHaveAttribute('src', 'http://x/graphify/view/p2/graph.html?t=1729650000000')
    // 放回 A 的「空图」status:不许污染 B(红:iframe 消失 + 「这个项目还没有图谱」)。
    held.resolve({ ok: true, json: async () => EMPTY_A } as unknown as Response)
    await act(async () => { await Promise.resolve() })
    expect(screen.queryByText('这个项目还没有图谱')).toBeNull()
    expect(screen.getByTitle('项目图谱')).toHaveAttribute('src', 'http://x/graphify/view/p2/graph.html?t=1729650000000')
  })

  it('★A 的作业轮询在途,B 已显示 → 放回 A running,不得让 B 假忙', async () => {
    vi.useFakeTimers()
    const held = deferred<Response>()
    const { impl, jobCalls } = holdingFetch({ jobById: { 'job-build': held } })
    render(<GraphView baseUrl="http://x" fetchImpl={impl} projects={[A, B]} />)
    await act(async () => { await Promise.resolve() })
    // 点 A 的重建:build 回 jobId 'job-build',作业轮询起;第一拍被把持。
    fireEvent.click(screen.getByRole('button', { name: '重建图谱' }))
    await act(async () => { await Promise.resolve() })
    await act(async () => { vi.advanceTimersByTime(1000) })
    expect(jobCalls).toContain('job-build')
    // 切到 B:B 显示图。
    fireEvent.change(screen.getByRole('combobox', { name: '图谱项目' }) as HTMLSelectElement, { target: { value: 'p2' } })
    await act(async () => { await Promise.resolve() })
    expect(screen.getByTitle('项目图谱')).toBeTruthy()
    // 放回 A 的 running/extract:不许让 B 的重建键假忙(红:disabled + 正在抽节点)。
    held.resolve({ ok: true, json: async () => ({ id: 'job-build', status: 'running', startedAt: 1, stage: 'extract' }) } as unknown as Response)
    await act(async () => { await Promise.resolve() })
    const rebuild = screen.getByRole('button', { name: '重建图谱' }) as HTMLButtonElement
    expect(rebuild.disabled).toBe(false)
    expect(screen.queryByText(/正在/)).toBeNull()
  })

  it('★同项目重建后,旧作业的回包不得覆盖新结果', async () => {
    vi.useFakeTimers()
    const oldJob = deferred<Response>()
    let buildSeq = 0
    let j1Polls = 0
    const impl = (async (url: string, init?: RequestInit) => {
      const u = String(url)
      if (u.endsWith('/graphify/build')) {
        buildSeq += 1
        return { ok: true, json: async () => ({ jobId: buildSeq === 1 ? 'j1' : 'j2' }) } as unknown as Response
      }
      if (u.includes('/graphify/job')) {
        const id = new URL(u, 'http://x').searchParams.get('id') ?? ''
        if (id === 'j1') {
          j1Polls += 1
          // 第 1 拍被网络把持;第 2 拍顺利返回 done 让第一次作业完结。
          if (j1Polls === 1) return oldJob.promise
          return { ok: true, json: async () => ({ id: 'j1', status: 'done' as const, startedAt: 1, finishedAt: 2 }) } as unknown as Response
        }
        return { ok: true, json: async () => ({ id: 'j2', status: 'done' as const, startedAt: 1, finishedAt: 2 }) } as unknown as Response
      }
      if (u.includes('/graphify/status')) return { ok: true, json: async () => EMPTY_A } as unknown as Response
      return { ok: true, json: async () => ({ ok: true }) } as unknown as Response
    }) as unknown as typeof fetch
    render(<GraphView baseUrl="http://x" fetchImpl={impl} projects={[A]} />)
    await act(async () => { await Promise.resolve() })
    // 第一次重建:轮询第一拍被把持。
    fireEvent.click(screen.getByRole('button', { name: '重建图谱' }))
    await act(async () => { await Promise.resolve() })
    await act(async () => { vi.advanceTimersByTime(1000) })
    // 第一次作业第 2 拍返回 done → 第一次作业结束,重建按钮恢复可用。
    await act(async () => { vi.advanceTimersByTime(1000) })
    expect((screen.getByRole('button', { name: '重建图谱' }) as HTMLButtonElement).disabled).toBe(false)
    // 第二次重建(同项目):新作业立即 done。
    fireEvent.click(screen.getByRole('button', { name: '重建图谱' }))
    await act(async () => { await Promise.resolve() })
    await act(async () => { vi.advanceTimersByTime(1000) })
    // 放回旧作业(j1)第 1 拍的迟到 error:不许覆盖新结果(不出现「旧作业失败」)。
    oldJob.resolve({ ok: true, json: async () => ({ id: 'j1', status: 'error', startedAt: 1, finishedAt: 2, error: '旧作业失败' }) } as unknown as Response)
    await act(async () => { await Promise.resolve() })
    expect(screen.queryByText('旧作业失败')).toBeNull()
    expect((screen.getByRole('button', { name: '重建图谱' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('★同项目重建后,旧的 status 回包不得覆盖新结果', async () => {
    vi.useFakeTimers()
    const heldOld = deferred<Response>()
    let buildSeq = 0
    let statusSeq = 0
    const WITH_GRAPH_A: GraphifyStatusView = { installed: true, generatedAt: 1729650000000, hasHtml: true, running: false }
    const impl = (async (url: string, init?: RequestInit) => {
      const u = String(url)
      if (u.includes('/graphify/status')) {
        statusSeq += 1
        // 挂载第 1 拍返回初始空图;第 1 次重建完成后的重拉(第 2 拍)把持在途;第 2 次重建完成后的重拉(第 3 拍)返回有图。
        if (statusSeq === 1) return { ok: true, json: async () => EMPTY_A } as unknown as Response
        if (statusSeq === 2) return heldOld.promise
        return { ok: true, json: async () => WITH_GRAPH_A } as unknown as Response
      }
      if (u.includes('/graphify/job')) {
        return { ok: true, json: async () => ({ id: 'j', status: 'done' as const, startedAt: 1, finishedAt: 2 }) } as unknown as Response
      }
      if (u.endsWith('/graphify/build')) {
        buildSeq += 1
        return { ok: true, json: async () => ({ jobId: `j${buildSeq}` }) } as unknown as Response
      }
      return { ok: true, json: async () => ({ ok: true }) } as unknown as Response
    }) as unknown as typeof fetch
    render(<GraphView baseUrl="http://x" fetchImpl={impl} projects={[A]} />)
    // 挂载第 1 拍返回(installed: true)。
    await act(async () => { await Promise.resolve() })
    // 第 1 次重建 → job done → watchJob 触发 statusSeq=2 重拉(被 heldOld 把持)。
    fireEvent.click(screen.getByRole('button', { name: '重建图谱' }))
    await act(async () => { await Promise.resolve() })
    await act(async () => { vi.advanceTimersByTime(1000) })
    // 第 2 次重建(同项目) → 代次递增 → job done → statusSeq=3 顺利返回有图 → iframe 出现。
    fireEvent.click(screen.getByRole('button', { name: '重建图谱' }))
    await act(async () => { await Promise.resolve() })
    await act(async () => { vi.advanceTimersByTime(1000) })
    expect(screen.getByTitle('项目图谱')).toBeTruthy()
    // 放回旧代次的「空图」status(statusSeq=2):不许覆盖新结果(不许 iframe 消失 + 这个项目还没有图谱)。
    heldOld.resolve({ ok: true, json: async () => EMPTY_A } as unknown as Response)
    await act(async () => { await Promise.resolve() })
    expect(screen.queryByText('这个项目还没有图谱')).toBeNull()
    expect(screen.getByTitle('项目图谱')).toBeTruthy()
  })

  it('卸载后,在途回包不得再写状态(不崩、不留痕)', async () => {
    const held = deferred<Response>()
    const { impl } = holdingFetch({ aStatus: held })
    const { unmount } = render(<GraphView baseUrl="http://x" fetchImpl={impl} projects={[A, B]} />)
    await act(async () => { await Promise.resolve() })
    unmount()
    held.resolve({ ok: true, json: async () => EMPTY_A } as unknown as Response)
    await act(async () => { await Promise.resolve() })
    // 到了这一步没抛就是过了(守卫在 mounted 之外直接丢弃)。
    expect(true).toBe(true)
  })

  it('★running 轮询在 running 翻 false 后主动停(不新造永远轮询)', async () => {
    vi.useFakeTimers()
    let statusAsks = 0
    const impl = (async (url: string) => {
      const u = String(url)
      if (u.includes('/graphify/status')) {
        statusAsks += 1
        // 第 1 拍 running:true → 起 running 轮询;第 2 拍 running:false → 应主动停。
        const view: GraphifyStatusView = statusAsks === 1
          ? { installed: true, generatedAt: null, hasHtml: true, running: true }
          : { installed: true, generatedAt: null, hasHtml: true, running: false }
        return { ok: true, json: async () => view } as unknown as Response
      }
      return { ok: true, json: async () => ({ ok: true }) } as unknown as Response
    }) as unknown as typeof fetch
    render(<GraphView baseUrl="http://x" fetchImpl={impl} projects={[A]} />)
    // 第 1 拍返回(running:true)→ watchRunning 起轮询。
    await act(async () => { await Promise.resolve() })
    // 推进一秒:第 2 拍 running:false → running 轮询应清掉。
    await act(async () => { vi.advanceTimersByTime(1000) })
    // 再推进两秒:若没停,会有第 3、4 拍(红:statusAsks 到 4)。
    await act(async () => { vi.advanceTimersByTime(2000) })
    expect(statusAsks).toBe(2)
  })
})

describe('同 job 轮询拍次与终态单调性(2026-10-23 第七轮,解决重叠 fetch 导致迟到 running 污染 done/error/404)', () => {
  const P: WorkbenchProject & { path: string } = { id: 'p1', name: '项目P', stage: 'MVP 开发', path: '/p', links: [], session_count: 0, idle: true }

  function deferred<T>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((res) => { resolve = res })
    return { promise, resolve }
  }

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('★同 job 迟到的旧 running 回包不得覆盖 done,使重建按钮永久假忙', async () => {
    vi.useFakeTimers()
    const held = deferred<Response>()
    let polls = 0
    const response = (body: unknown, status = 200) => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }) as Response
    const fetchImpl = (async (url: string) => {
      const u = String(url)
      if (u.includes('/graphify/status')) return response({ installed: true, generatedAt: null, hasHtml: false, running: false })
      if (u.endsWith('/graphify/build')) return response({ jobId: 'same-job' })
      if (u.includes('/graphify/job')) {
        polls += 1
        if (polls === 1) return held.promise
        return response({ id: 'same-job', status: 'done', startedAt: 1, finishedAt: 2 })
      }
      return response({ ok: true })
    }) as typeof fetch

    render(<GraphView baseUrl="http://example.test" fetchImpl={fetchImpl} projects={[P]} />)
    await act(async () => { await Promise.resolve() })
    fireEvent.click(screen.getByRole('button', { name: '重建图谱' }))
    await act(async () => { await Promise.resolve() })
    await act(async () => { vi.advanceTimersByTime(1000) })
    expect(polls).toBe(1)
    await act(async () => { vi.advanceTimersByTime(1000) })
    expect(polls).toBe(2)

    const button = () => screen.getByRole('button', { name: '重建图谱' }) as HTMLButtonElement
    expect(button().disabled).toBe(false)

    // 第 1 拍迟到返回 running:
    held.resolve(response({ id: 'same-job', status: 'running', startedAt: 1, stage: 'extract' }))
    await act(async () => { await Promise.resolve() })

    // 不得被旧拍覆盖为 busy
    expect(button().disabled).toBe(false)
    // 5 秒后仍不得变为 busy
    await act(async () => { vi.advanceTimersByTime(5000) })
    expect(button().disabled).toBe(false)
  })

  it('★同 job 迟到的旧 running 回包不得覆盖 error 终态', async () => {
    vi.useFakeTimers()
    const held = deferred<Response>()
    let polls = 0
    const response = (body: unknown, status = 200) => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }) as Response
    const fetchImpl = (async (url: string) => {
      const u = String(url)
      if (u.includes('/graphify/status')) return response({ installed: true, generatedAt: null, hasHtml: false, running: false })
      if (u.endsWith('/graphify/build')) return response({ jobId: 'error-job' })
      if (u.includes('/graphify/job')) {
        polls += 1
        if (polls === 1) return held.promise
        return response({ id: 'error-job', status: 'error', error: '生成失败了', startedAt: 1, finishedAt: 2 })
      }
      return response({ ok: true })
    }) as typeof fetch

    render(<GraphView baseUrl="http://example.test" fetchImpl={fetchImpl} projects={[P]} />)
    await act(async () => { await Promise.resolve() })
    fireEvent.click(screen.getByRole('button', { name: '重建图谱' }))
    await act(async () => { await Promise.resolve() })
    await act(async () => { vi.advanceTimersByTime(1000) })
    expect(polls).toBe(1)
    await act(async () => { vi.advanceTimersByTime(1000) })
    expect(polls).toBe(2)

    expect(screen.getByText('生成失败了')).toBeTruthy()

    // 第 1 拍迟到返回 running: 不得清掉已有的 error 终态提示
    held.resolve(response({ id: 'error-job', status: 'running', startedAt: 1, stage: 'extract' }))
    await act(async () => { await Promise.resolve() })

    expect(screen.getByText('生成失败了')).toBeTruthy()
    const button = screen.getByRole('button', { name: '重建图谱' }) as HTMLButtonElement
    expect(button.disabled).toBe(false)
  })

  it('★同 job 迟到的旧 running 回包不得覆盖 404 作业丢失终态', async () => {
    vi.useFakeTimers()
    const held = deferred<Response>()
    let polls = 0
    const response = (body: unknown, status = 200) => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }) as Response
    const fetchImpl = (async (url: string) => {
      const u = String(url)
      if (u.includes('/graphify/status')) return response({ installed: true, generatedAt: null, hasHtml: false, running: false })
      if (u.endsWith('/graphify/build')) return response({ jobId: 'lost-job' })
      if (u.includes('/graphify/job')) {
        polls += 1
        if (polls === 1) return held.promise
        return response({ error: 'not found' }, 404)
      }
      return response({ ok: true })
    }) as typeof fetch

    render(<GraphView baseUrl="http://example.test" fetchImpl={fetchImpl} projects={[P]} />)
    await act(async () => { await Promise.resolve() })
    fireEvent.click(screen.getByRole('button', { name: '重建图谱' }))
    await act(async () => { await Promise.resolve() })
    await act(async () => { vi.advanceTimersByTime(1000) })
    expect(polls).toBe(1)
    await act(async () => { vi.advanceTimersByTime(1000) })
    expect(polls).toBe(2)

    expect(screen.getByText('这次作业找不到了(工作台可能重启过),再点一次就好')).toBeTruthy()

    // 第 1 拍迟到返回 running: 不得覆盖 404 错误提示
    held.resolve(response({ id: 'lost-job', status: 'running', startedAt: 1, stage: 'extract' }))
    await act(async () => { await Promise.resolve() })

    expect(screen.getByText('这次作业找不到了(工作台可能重启过),再点一次就好')).toBeTruthy()
    const button = screen.getByRole('button', { name: '重建图谱' }) as HTMLButtonElement
    expect(button.disabled).toBe(false)
  })

  it('★同 job 乱序到达的旧 stage 不得倒回新 stage', async () => {
    vi.useFakeTimers()
    const heldExtract = deferred<Response>()
    let polls = 0
    const response = (body: unknown) => ({
      ok: true,
      status: 200,
      json: async () => body,
    }) as Response
    const fetchImpl = (async (url: string) => {
      const u = String(url)
      if (u.includes('/graphify/status')) return response({ installed: true, generatedAt: null, hasHtml: false, running: false })
      if (u.endsWith('/graphify/build')) return response({ jobId: 'stage-job' })
      if (u.includes('/graphify/job')) {
        polls += 1
        if (polls === 1) return heldExtract.promise
        return response({ id: 'stage-job', status: 'running', startedAt: 1, stage: 'cluster' })
      }
      return response({ ok: true })
    }) as typeof fetch

    render(<GraphView baseUrl="http://example.test" fetchImpl={fetchImpl} projects={[P]} />)
    await act(async () => { await Promise.resolve() })
    fireEvent.click(screen.getByRole('button', { name: '重建图谱' }))
    await act(async () => { await Promise.resolve() })
    await act(async () => { vi.advanceTimersByTime(1000) })
    expect(polls).toBe(1)
    await act(async () => { vi.advanceTimersByTime(1000) })
    expect(polls).toBe(2)

    // 第 2 拍返回 cluster
    expect(screen.getByText('正在聚类…')).toBeTruthy()

    // 第 1 拍 extract 迟到返回: 不得把 stage 倒回 extract
    heldExtract.resolve(response({ id: 'stage-job', status: 'running', startedAt: 1, stage: 'extract' }))
    await act(async () => { await Promise.resolve() })

    expect(screen.getByText('正在聚类…')).toBeTruthy()
    expect(screen.queryByText('正在提取代码…')).toBeNull()
  })
})

describe('矮格收拢条(2026-10-26 视觉验收退回:极小尺寸不许塞一根读不清的细线,必须给明确可用的展开方式)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  /** jsdom 没有 ResizeObserver、clientHeight 恒 0 —— 按测试需要打桩布局尺寸。 */
  function stubLayout(px: number) {
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      unobserve() {}
      disconnect() {}
    })
    // clientHeight 定义在哪个原型上因 jsdom 版本而异,找到真正的宿主再 spy。
    let proto: object | null = HTMLElement.prototype
    while (proto !== null && !Object.getOwnPropertyNames(proto).includes('clientHeight')) {
      proto = Object.getPrototypeOf(proto)
    }
    if (proto === null) throw new Error('jsdom 里没有 clientHeight 可桩')
    vi.spyOn(proto as HTMLElement, 'clientHeight', 'get').mockReturnValue(px)
  }

  const HAS_HTML = { installed: true, generatedAt: 1792992000000, hasHtml: true, running: false }

  it('★图区低于可读下限 → 不挂细线 iframe,给一颗诚实说明的收拢条;点它真开全屏弹层', async () => {
    stubLayout(40)
    const { impl } = fakeFetch({ status: HAS_HTML })
    render(<GraphView baseUrl="http://x" fetchImpl={impl} projects={[PROJECTS[0]!]} />)
    // 收拢条在、细线 iframe 不在 —— 二十几 px 的「图」不许再冒充可读。
    const bar = await screen.findByRole('button', { name: /展开全屏/ })
    expect(bar.textContent).toContain('项目图谱')
    expect(bar.textContent).toContain('读不清')
    expect(screen.queryByTitle('项目图谱')).toBeNull()
    // 点收拢条 = 明确可用的展开方式:全屏弹层真的打开。
    fireEvent.click(bar)
    expect(await screen.findByText('退出全屏')).toBeTruthy()
  })

  it('图区高度够 → 照常挂 iframe,不收拢', async () => {
    stubLayout(260)
    const { impl } = fakeFetch({ status: HAS_HTML })
    render(<GraphView baseUrl="http://x" fetchImpl={impl} projects={[PROJECTS[0]!]} />)
    expect(await screen.findByTitle('项目图谱')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /展开全屏/ })).toBeNull()
  })

  it('架构图同样适用:矮 → 收拢条,点它开全屏', async () => {
    stubLayout(40)
    const archView: ArchifyStatusView = {
      projectId: 'p1',
      hasDiagrams: true,
      pinnedCommit: 'c55abc',
      sourceNote: 'Archify 3.2.0 离线交付 · c55 来源',
      diagrams: [{ id: 'ctx', name: '上下文', type: 'context-map', hasHtml: true, hasSpec: true }],
    }
    const impl = (vi.fn(async (url: string) => {
      const u = String(url)
      if (u.includes('/archify/status')) return { ok: true, json: async () => archView } as Response
      return { ok: true, json: async () => ({}) } as Response
    }) as unknown) as typeof fetch
    render(<GraphView baseUrl="http://x" fetchImpl={impl} projects={[PROJECTS[0]!]} />)
    fireEvent.click(screen.getByRole('tab', { name: /架构图/ }))
    const bar = await screen.findByRole('button', { name: /展开全屏/ })
    expect(bar.textContent).toContain('架构图')
    fireEvent.click(bar)
    expect(await screen.findByText('退出全屏')).toBeTruthy()
  })
})
