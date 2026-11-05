import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { FilesModule } from '../src/client/FilesModule.tsx'
import { GraphView } from '../src/client/GraphView.tsx'
import { STYLE } from '../src/client/style.ts'
import { starterSource, starterWidget } from './helpers/starterLayer.ts'
import type { WorkbenchProject } from '../src/protocol.ts'

afterEach(cleanup)

const StarterFiles = starterWidget('files')

const PROJECTS: readonly WorkbenchProject[] = [
  {
    id: 'desktop-workbench',
    name: 'desktop-workbench',
    path: '/Users/example/Documents/GitHub/desktop-workbench',
    stage: 'MVP 开发',
    links: [],
    session_count: 0,
    idle: true,
  },
  {
    id: 'doudou',
    name: 'DouDou',
    path: '/Users/example/Documents/GitHub/DouDou',
    stage: 'MVP 开发',
    links: [],
    session_count: 0,
    idle: true,
  },
]

const BOX = {
  id: 'files',
  title: '图谱',
  basisPct: 40,
  stacked: true,
  dragging: false,
  onResizeStart: () => {},
  onResizeMove: () => {},
  onResizeEnd: () => {},
}

function fakeFetchImpl(options: { hasHtml?: boolean, generatedAt?: number }) {
  return (async (url: string) => {
    const u = String(url)
    if (u.includes('/graphify/status')) {
      return {
        ok: true,
        json: async () => ({
          installed: true,
          generatedAt: options.generatedAt ?? 1792755923230,
          hasHtml: options.hasHtml ?? true,
          running: false,
        }),
      } as Response
    }
    return { ok: true, json: async () => ({ ok: true }) } as Response
  }) as unknown as typeof fetch
}

describe('图谱显示高度链与展开功能', () => {
  it('1. 起步层files小组件切换至「整理与图谱」时，不应渲染出内层重复的.ben-wb__mod-handle', async () => {
    const fetchImpl = fakeFetchImpl({ hasHtml: true })
    const { container } = render(
      <StarterFiles
        box={BOX}
        header={<h2 id="h-files">图谱</h2>}
        headingId="h-files"
        baseUrl="http://127.0.0.1:3493"
        fetchImpl={fetchImpl}
        projects={PROJECTS}
        currentProjectId="desktop-workbench"
      />,
    )

    // 点击切换到「整理与图谱」
    const tabBtn = screen.getByRole('button', { name: '整理与图谱' })
    act(() => {
      tabBtn.click()
    })

    // 等待 GraphView 渲染出来
    expect(await screen.findByTitle('项目图谱')).toBeInTheDocument()

    // 检查是否有内层嵌套的重复 handle
    // 外层 ModuleBox 有 handle (如果不是 noHandle)，但内层不应有
    const handles = container.querySelectorAll('.ben-wb__mod-handle')
    expect(handles.length).toBeLessThanOrEqual(1)
  })

  it('2. 无论直接使用Builtin还是用户层嵌套，图谱iframe均挂载有.ben-wb__graph-frame并包含展开按钮', async () => {
    const fetchImpl = fakeFetchImpl({ hasHtml: true })
    render(
      <FilesModule
        box={BOX}
        header={<h2 id="h-files">图谱</h2>}
        headingId="h-files"
        baseUrl="http://127.0.0.1:3493"
        fetchImpl={fetchImpl}
        projects={PROJECTS}
        currentProjectId="desktop-workbench"
      />,
    )

    const iframe = await screen.findByTitle('项目图谱')
    expect(iframe).toHaveClass('ben-wb__graph-frame')

    // 检查「展开」按钮
    const expandBtn = await screen.findByRole('button', { name: '展开查看图谱' })
    expect(expandBtn).toBeInTheDocument()

    // 点击展开，打开弹层
    act(() => {
      expandBtn.click()
    })

    const modal = screen.getByRole('dialog', { name: '全屏项目图谱' })
    expect(modal).toBeInTheDocument()

    // 按 Escape 退出
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: '全屏项目图谱' })).toBeNull()
  })

  it('3. 当header为null时，FilesModule作为内嵌组件直接返回fill区域，不套多余ModuleBox', async () => {
    const fetchImpl = fakeFetchImpl({ hasHtml: true })
    const { container } = render(
      <FilesModule
        box={BOX}
        header={null}
        headingId="h-sub"
        baseUrl="http://127.0.0.1:3493"
        fetchImpl={fetchImpl}
        projects={PROJECTS}
      />,
    )

    // 因为 header 为 null，FilesModule 不应再产生自己的 .ben-wb__mod
    expect(container.querySelector('.ben-wb__mod')).toBeNull()
    const fillSection = container.querySelector('.ben-wb__card--fill')
    expect(fillSection).not.toBeNull()
    expect(fillSection?.getAttribute('style')).toContain('height: 100%')
  })

  it('4. 矮态不裁图注:files 模块有合理最小高度默认,起步 cf-advanced 撤掉 180px 地板', () => {
    // 本体样式:files 那一格有最小高度 —— 低于它,GraphView 内容(tabs+图体+图注)
    // 会高过外壳被 .ben-wb__mod 的 overflow:hidden 裁掉(独审 S1/S3 截图实证)
    expect(STYLE).toMatch(/\.ben-wb__mod\[data-module-box="files"\]\{[^}]*min-height:\s*\d+px/)
    // 起步层真文件:cf-advanced 的 min-height:180px 地板撤掉,让位给 flex 收缩链
    // (180px 地板会让 GraphView 恒定 180px,外壳拖矮时内容比盒子高、图注被裁)
    expect(starterSource('files')).toContain('.cf-advanced{min-height:0')
    expect(starterSource('files')).not.toContain('.cf-advanced{min-height:180px')
  })

  it('5. 旧高度适配走嵌入槽位协议:本体样式不认识用户层 class,嵌入式节带 data-embed 标记', () => {
    // 分层硬门(skin-guard):本体 src/client 与编译 lib/client.js 都不得含 creator-/cf-
    // 用户层 class。旧小组件容器不参与 flex 链的适配在 FilesModule 用 ref+ResizeObserver
    // 量本体 .ben-wb__mod 完成 —— 样式层一个用户层 class 名都不留。
    // 与 skin-guard 同源:从小组件真文件抽 class 名,逐个不得出现在本体样式里
    const widgetClasses = new Set<string>()
    for (const m of starterSource('files').matchAll(/\.(creator-[a-z0-9-]+|cf-[a-z0-9-]+)\b/g)) widgetClasses.add(m[1] as string)
    expect(widgetClasses.size).toBeGreaterThan(0)
    for (const cls of widgetClasses) {
      expect(STYLE).not.toContain(`.${cls}`)
    }
    // 嵌入式(header==null)渲染的节带槽位标记(直出本体的节不带)
    const { container } = render(
      <FilesModule box={BOX} header={null} headingId="h-embed" baseUrl="http://x" fetchImpl={fakeFetchImpl({ hasHtml: true })} projects={PROJECTS} />,
    )
    expect(container.querySelector('section[data-embed="graph"]')).not.toBeNull()
  })
})
