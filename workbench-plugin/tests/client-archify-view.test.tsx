/**
 * 「图谱」格 Archify 架构图视图组件测试 (2026-10-23, 卡「图谱显示修复与Archify产品图接入」)。
 */
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ArchifyStatusView, GraphifyStatusView, WorkbenchProject } from '../src/protocol.ts'
import { GraphView } from '../src/client/GraphView.tsx'

afterEach(cleanup)

const PROJECTS: readonly WorkbenchProject[] = [
  { id: 'desktop-workbench', name: '事务官座机', stage: 'MVP 开发', path: '/Users/example/Code/desktop-workbench', links: [], session_count: 0, idle: true },
  { id: 'doudou', name: 'DouDou', stage: 'MVP 开发', path: '/Users/example/Code/DouDou', links: [], session_count: 0, idle: true },
]

function fakeFetchImpl(options: {
  archifyDesktopStatus?: ArchifyStatusView
  archifyDoudouStatus?: ArchifyStatusView
  onGenerateAgent?: (body: any) => void
  generateAgentResult?: { ok: boolean, diagramId?: string, error?: string }
}) {
  let doudouGenerated = false

  return vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url)

    // Graphify status
    if (u.includes('/graphify/status')) {
      const graphifyStatus: GraphifyStatusView = {
        installed: true,
        generatedAt: 1755500000000,
        hasHtml: true,
        running: false,
      }
      return { ok: true, status: 200, json: async () => graphifyStatus } as Response
    }

    // Archify status
    if (u.includes('/archify/status')) {
      if (u.includes('project=desktop-workbench')) {
        const desktopStatus: ArchifyStatusView = options.archifyDesktopStatus ?? {
          projectId: 'desktop-workbench',
          hasDiagrams: true,
          pinnedCommit: 'c55ff4c1',
          sourceNote: '钉点: c55 (desktop-workbench 运行时与生命周期等五图)',
          diagrams: [
            { id: 'architecture-runtime', name: '运行时总览', type: 'architecture', pinnedCommit: 'c55ff4c1', generatedAt: 1755500000000, hasHtml: true, hasSpec: true },
            { id: 'tree-repo', name: '目录与模块树', type: 'tree', pinnedCommit: 'c55ff4c1', generatedAt: 1755500000000, hasHtml: true, hasSpec: true },
            { id: 'sequence-call', name: '提挂机与通话时序', type: 'sequence', pinnedCommit: 'c55ff4c1', generatedAt: 1755500000000, hasHtml: true, hasSpec: true },
            { id: 'sequence-video', name: '视频作者协作流程', type: 'sequence', pinnedCommit: 'c55ff4c1', generatedAt: 1755500000000, hasHtml: true, hasSpec: true },
            { id: 'lifecycle-card', name: '任务卡生命周期', type: 'lifecycle', pinnedCommit: 'c55ff4c1', generatedAt: 1755500000000, hasHtml: true, hasSpec: true },
          ],
          selectedDiagramId: 'architecture-runtime',
        }
        return { ok: true, status: 200, json: async () => desktopStatus } as Response
      }

      if (u.includes('project=doudou')) {
        if (doudouGenerated || options.archifyDoudouStatus !== undefined) {
          const doudouStatus: ArchifyStatusView = options.archifyDoudouStatus ?? {
            projectId: 'doudou',
            hasDiagrams: true,
            diagrams: [
              { id: 'doudou-arch', name: 'DouDou · 架构简图', type: 'architecture', generatedAt: Date.now(), hasHtml: true, hasSpec: true },
            ],
            selectedDiagramId: 'doudou-arch',
          }
          return { ok: true, status: 200, json: async () => doudouStatus } as Response
        }
        const doudouStatus: ArchifyStatusView = {
          projectId: 'doudou',
          hasDiagrams: false,
          diagrams: [],
        }
        return { ok: true, status: 200, json: async () => doudouStatus } as Response
      }
    }

    // 「由 Agent 生成」:只发 projectId,不带规格(规格由 Agent 现场读项目产出)
    if (u.includes('/archify/generate-agent')) {
      const body = JSON.parse(String(init?.body))
      options.onGenerateAgent?.(body)
      const result = options.generateAgentResult ?? { ok: true, diagramId: 'doudou-arch' }
      doudouGenerated = result.ok === true
      return {
        ok: result.ok === true,
        status: result.ok === true ? 200 : 400,
        json: async () => (result.ok === true ? result : { error: result.error ?? '生成失败' }),
      } as Response
    }

    return { ok: true, status: 200, json: async () => ({}) } as Response
  }) as typeof fetch
}

describe('GraphView Archify 切换与展示', () => {
  it('1. 渲染图谱类型切换 Tab [关系图 (Graphify)] [架构图 (Archify)]', async () => {
    const fetchImpl = fakeFetchImpl({})
    render(<GraphView baseUrl="http://wb.test" fetchImpl={fetchImpl} projects={PROJECTS} />)
    await act(async () => { await Promise.resolve() })

    expect(screen.getByRole('tab', { name: /关系图/ })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /架构图/ })).toBeInTheDocument()
  })

  it('2. 切换至架构图 Tab，desktop-workbench 加载 5 张已验图，显示钉点 c55', async () => {
    const fetchImpl = fakeFetchImpl({})
    render(<GraphView baseUrl="http://wb.test" fetchImpl={fetchImpl} projects={PROJECTS} currentProjectId="desktop-workbench" />)
    await act(async () => { await Promise.resolve() })

    // 切换到架构图 Tab
    fireEvent.click(screen.getByRole('tab', { name: /架构图/ }))
    await waitFor(() => {
      expect(screen.getByLabelText('架构图选择')).toBeInTheDocument()
    })

    // 检查钉点与五图选项
    expect(screen.getAllByText(/c55/).length).toBeGreaterThanOrEqual(1)
    const select = screen.getByLabelText('架构图选择') as HTMLSelectElement
    expect(select.options.length).toBe(5)
    expect(select.value).toBe('architecture-runtime')

    // 检查挂载的 iframe src
    const iframe = screen.getByTitle(/架构图/) as HTMLIFrameElement
    expect(iframe.src).toContain('/archify/view/desktop-workbench/architecture-runtime.html')
    // 2026-10-26 回归:不许加 ?embed=1 —— 原图 embed 模式会隐藏缩放导航与节点详情,
    // 维护者验收「Archify 无缩放与节点详情」的根因就是这个参数(排查-1026 实证)。
    expect(iframe.src).not.toContain('embed')
  })

  it('3. 切换架构图下拉，能够切换选中的图并更新 iframe src', async () => {
    const fetchImpl = fakeFetchImpl({})
    render(<GraphView baseUrl="http://wb.test" fetchImpl={fetchImpl} projects={PROJECTS} currentProjectId="desktop-workbench" />)
    await act(async () => { await Promise.resolve() })

    fireEvent.click(screen.getByRole('tab', { name: /架构图/ }))
    await waitFor(() => {
      expect(screen.getByLabelText('架构图选择')).toBeInTheDocument()
    })

    // 切换至目录与模块树
    const select = screen.getByLabelText('架构图选择')
    fireEvent.change(select, { target: { value: 'tree-repo' } })

    const iframe = screen.getByTitle(/架构图/) as HTMLIFrameElement
    expect(iframe.src).toContain('/archify/view/desktop-workbench/tree-repo.html')
  })

  it('4. 切换到未生成架构图的项目 DouDou，提示未生成并提供「由 Agent 生成」按键', async () => {
    const fetchImpl = fakeFetchImpl({})
    render(<GraphView baseUrl="http://wb.test" fetchImpl={fetchImpl} projects={PROJECTS} currentProjectId="doudou" />)
    await act(async () => { await Promise.resolve() })

    fireEvent.click(screen.getByRole('tab', { name: /架构图/ }))
    await waitFor(() => {
      expect(screen.getByText('这个项目还没有架构图')).toBeInTheDocument()
    })

    const agentBtn = screen.getByRole('button', { name: /由 Agent 生成/ })
    expect(agentBtn).toBeInTheDocument()
  })

  it('5. 点击「由 Agent 生成」真实走 generate-agent(不带硬编码规格),成功后展示生成的架构图', async () => {
    let capturedBody: any = null
    let generateUrl = ''
    const fetchImpl = fakeFetchImpl({
      onGenerateAgent: (body) => { capturedBody = body },
    })
    const wrapped = (async (url: string, init?: RequestInit) => {
      if (String(url).includes('/archify/generate-agent')) generateUrl = String(url)
      return fetchImpl(url, init)
    }) as typeof fetch
    render(<GraphView baseUrl="http://wb.test" fetchImpl={wrapped} projects={PROJECTS} currentProjectId="doudou" />)
    await act(async () => { await Promise.resolve() })

    fireEvent.click(screen.getByRole('tab', { name: /架构图/ }))
    await waitFor(() => {
      expect(screen.getByText('这个项目还没有架构图')).toBeInTheDocument()
    })

    const agentBtn = screen.getByRole('button', { name: /由 Agent 生成/ })
    fireEvent.click(agentBtn)

    await waitFor(() => {
      expect(capturedBody).not.toBeNull()
    })
    // 真实接线:只发 projectId,服务端派 Agent 读项目现场产规格 —— 前端绝不再带两框硬编码模板
    expect(generateUrl).toContain('/archify/generate-agent')
    expect(capturedBody.projectId).toBe('doudou')
    expect(capturedBody.spec).toBeUndefined()

    // 生成后显示出架构图
    await waitFor(() => {
      expect(screen.getByLabelText('架构图选择')).toBeInTheDocument()
      const iframe = screen.getByTitle(/架构图/) as HTMLIFrameElement
      expect(iframe.src).toContain('/archify/view/doudou/doudou-arch.html')
    })
  })

  it('6. Agent 生成失败时如实报错,不摆假图', async () => {
    const fetchImpl = fakeFetchImpl({
      generateAgentResult: { ok: false, error: 'Agent 运行失败(exit 1):网络不可达' },
    })
    render(<GraphView baseUrl="http://wb.test" fetchImpl={fetchImpl} projects={PROJECTS} currentProjectId="doudou" />)
    await act(async () => { await Promise.resolve() })

    fireEvent.click(screen.getByRole('tab', { name: /架构图/ }))
    await waitFor(() => {
      expect(screen.getByText('这个项目还没有架构图')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('button', { name: /由 Agent 生成/ }))

    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toContain('Agent 运行失败')
    })
    // 没有图就是没有图,不嵌 iframe
    expect(screen.queryByTitle(/架构图 ·/)).not.toBeInTheDocument()
  })

  it('7. 生成时间如实呈现;超过 7 天标注已较旧', async () => {
    const staleAt = Date.now() - 8 * 24 * 3600 * 1000
    const fetchImpl = fakeFetchImpl({
      archifyDoudouStatus: {
        projectId: 'doudou',
        hasDiagrams: true,
        diagrams: [
          { id: 'doudou-arch', name: 'DouDou · 架构简图', type: 'architecture', generatedAt: staleAt, hasHtml: true, hasSpec: true },
        ],
        selectedDiagramId: 'doudou-arch',
      },
    })
    // 直接以生成后的状态起步
    const warmFetch = (async (url: string, init?: RequestInit) => {
      const res = await fetchImpl(url, init)
      return res
    }) as typeof fetch
    render(<GraphView baseUrl="http://wb.test" fetchImpl={warmFetch} projects={PROJECTS} currentProjectId="doudou" />)
    await act(async () => { await Promise.resolve() })

    fireEvent.click(screen.getByRole('tab', { name: /架构图/ }))
    await waitFor(() => {
      expect(screen.getByText(/生成于:/)).toBeInTheDocument()
    })
    expect(screen.getByText(/生成于:/).textContent).toContain('8 天前')
    expect(screen.getByText(/生成于:/).textContent).toContain('已较旧')
  })

  it('8. 架构图支持「展开」全屏弹层查看与退出', async () => {
    const fetchImpl = fakeFetchImpl({})
    render(<GraphView baseUrl="http://wb.test" fetchImpl={fetchImpl} projects={PROJECTS} currentProjectId="desktop-workbench" />)
    await act(async () => { await Promise.resolve() })

    fireEvent.click(screen.getByRole('tab', { name: /架构图/ }))
    await waitFor(() => {
      expect(screen.getByLabelText('架构图选择')).toBeInTheDocument()
    })

    // 点击展开
    const expandBtn = screen.getByRole('button', { name: /展开/ })
    fireEvent.click(expandBtn)

    expect(screen.getByRole('dialog', { name: /全屏/ })).toBeInTheDocument()
    // 弹层打开时焦点落进对话框(可访问性:键盘用户不被丢在背景里)
    expect(screen.getByRole('dialog', { name: /全屏/ }).contains(document.activeElement)).toBe(true)
    // 全屏弹层里的 iframe 同样不许 embed:展开窗口也要能缩放、看节点详情
    const modalIframe = document.querySelector('[role="dialog"] iframe') as HTMLIFrameElement
    expect(modalIframe.src).toContain('/archify/view/desktop-workbench/architecture-runtime.html')
    expect(modalIframe.src).not.toContain('embed')
    const closeBtn = screen.getByRole('button', { name: /退出全屏/ })
    fireEvent.click(closeBtn)

    expect(screen.queryByRole('dialog', { name: /全屏/ })).not.toBeInTheDocument()
  })
})
