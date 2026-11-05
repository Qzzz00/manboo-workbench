/**
 * 真实 React 验收 harness 的浏览器入口(2026-10-23,卡「图谱显示修复与Archify接入」)。
 *
 * 独立审 Major:旧 real-browser-graph-drag.mjs 是手工搭的静态 fixture —— 自写 DOM、
 * 自写拖拽,验的只是 CSS。这个入口**什么都不复刻**:
 * - 组件是 shipped 的:FilesModule / GraphView / ModuleBox / ModuleHeader 直接 import 源码;
 * - 用户层小组件跑的是 `user-layer/起步/小组件/files/index.js` 真文件,经本体加载口
 *   `evaluateWidget`(userLayer.tsx)同一个白名单 require 求值;
 * - 拖柄是 ModuleBox 真把手,换算走真 `resizeModule`(layout.ts),胶水只 mirrors
 *   Workbench.tsx handleModuleResizeStart/Move 的接线(Δpx→Δpct 对容器高),一行数学不多写。
 *
 * 页面骨架由 tests/real-browser-graph-drag.mjs(真服务 + 代理)提供,本文件只负责把
 * 真实组件树挂进 DOM。
 */
import { createElement, useMemo, useRef, useState, type FunctionComponent, type PointerEvent as ReactPointerEvent } from 'react'
import { createRoot } from 'react-dom/client'

// react-dom 的 cjs 构建引用 process.env.NODE_ENV;浏览器里没有 process,给个最小 shim
// (development 路径,保留警告;不影响产品代码,只在这个测试入口里)
;(globalThis as { process?: unknown }).process ??= { env: {} }
import { TOKENS_STYLE } from '../../src/client/tokens.ts'
import { STYLE } from '../../src/client/style.ts'
import { ModuleHeader } from '../../src/client/ModuleBox.tsx'
import { FilesModule as BuiltinFilesModule } from '../../src/client/FilesModule.tsx'
import { DEFAULT_LAYOUT, resizeModule } from '../../src/client/layout.ts'
import { evaluateWidget } from '../../src/client/userLayer.tsx'
import type { WorkbenchLayout, WorkbenchProject } from '../../src/protocol.ts'

interface DragState {
  pointerId: number
  startY: number
  startLayout: WorkbenchLayout
}

/**
 * 挂载真实小组件树。props 与生产 Workbench.tsx 给 files 那一格的一致
 * (box/header/headingId/baseUrl/fetchImpl/projects/currentProjectId)。
 */
interface MountOptions {
  widgetCode: string
  baseUrl: string
  projects: readonly WorkbenchProject[]
  currentProjectId?: string | null
  columnHeight: number
  /**
   * widget(默认)= 用户层 files 小组件真文件嵌 shipped FilesModule;
   * builtin = 直出本体 FilesModule(Workbench 传真实 header 的那条旧路/兄弟路)。
   */
  variant?: 'widget' | 'builtin'
}

/**
 * 挂载真实小组件树。props 与生产 Workbench.tsx 给 files 那一格的一致
 * (box/header/headingId/baseUrl/fetchImpl/projects/currentProjectId)。
 */
function Harness({
  widgetCode, baseUrl, projects, currentProjectId, columnHeight, variant = 'widget',
}: MountOptions) {
  /** 模块容器:resizeModule 的 Δpct 换算参考的就是它的高度(同 Workbench moduleBodyRef) */
  const bodyRef = useRef<HTMLDivElement | null>(null)
  // 起点给 files 一格 30%:向上拖有 70% 的 clamp 空间可展示传导(60% 起步两拍就顶到 clamp)
  const [layout, setLayout] = useState<WorkbenchLayout>(() => ({
    ...DEFAULT_LAYOUT,
    modules: DEFAULT_LAYOUT.modules.map(m => (m.id === 'files' ? { ...m, basis_pct: 30 } : m)),
  }))
  const [dragging, setDragging] = useState(false)
  const dragRef = useRef<DragState | null>(null)
  const filesModule = layout.modules.find(m => m.id === 'files')
  const basisPct = filesModule?.basis_pct ?? 24

  // —— 以下三枚回调 mirrors Workbench.tsx handleModuleResizeStart/Move/End 的竖屏路径 ——
  const onResizeStart = (event: ReactPointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    // 同生产:指针捕获,拖出 12px 热区也不断流(可选调用,jsdom 没有)
    event.currentTarget.setPointerCapture?.(event.pointerId)
    dragRef.current = { pointerId: event.pointerId, startY: event.clientY, startLayout: layout }
    setDragging(true)
  }
  const onResizeMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    if (drag === null || drag.pointerId !== event.pointerId) return
    const containerHeight = bodyRef.current?.getBoundingClientRect().height
    if (containerHeight === undefined || containerHeight <= 0) return
    const deltaPct = ((event.clientY - drag.startY) / containerHeight) * 100
    setLayout(resizeModule(drag.startLayout, 'files', deltaPct))
  }
  const onResizeEnd = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (dragRef.current?.pointerId !== event.pointerId) return
    dragRef.current = null
    setDragging(false)
  }

  // 求值结果必须稳定:每次渲染重新 evaluateWidget 会得到一个全新的组件类型,
  // Harness 一 setState(拖柄)React 就把整棵小组件子树当新类型 remount —— 现状回到
  // library、图谱格整个消失。只在挂载时求值一次。
  const [ran] = useState(() => evaluateWidget(widgetCode, '起步/小组件/files/index.js'))
  // fetchImpl 必须稳定:GraphView 的 effect 依赖它,每帧新建会让拖柄移动每一拍都
  // 把 status 清掉、iframe 卸载(生产里它是 serviceFetch,一份恒定的引用)
  const fetchImpl = useMemo(() => window.fetch.bind(window), [])

  const boxProps = {
    box: {
      id: 'files',
      title: '图谱',
      basisPct,
      dragging,
      onResizeStart,
      onResizeMove,
      onResizeEnd,
    },
    headingId: 'h-files',
    baseUrl,
    fetchImpl,
    projects,
    ...(currentProjectId === undefined || currentProjectId === null ? {} : { currentProjectId }),
  }
  const headerEl = createElement(ModuleHeader, {
    title: '图谱',
    headingId: 'h-files',
    draggable: false,
    onToggleHidden: () => {},
  })
  const columnStyle = { display: 'flex', flexDirection: 'column', height: columnHeight, minHeight: 0 } as const

  // 直出本体:Workbench.tsx 传真实 header 的那条兄弟路(FilesModule 自己套 ModuleBox)
  if (variant === 'builtin') {
    return (
      <div ref={bodyRef} className="ben-wb__mods" style={columnStyle}>
        {createElement(BuiltinFilesModule, { ...boxProps, header: headerEl })}
      </div>
    )
  }
  if (!ran.ok) {
    return <p role="status">小组件加载失败:{ran.problem}</p>
  }
  const WidgetFiles = (ran.exports as { FilesModule?: unknown }).FilesModule
  if (typeof WidgetFiles !== 'function') {
    return <p role="status">小组件没有导出 FilesModule</p>
  }

  return (
    <div ref={bodyRef} className="ben-wb__mods" style={columnStyle}>
      {createElement(WidgetFiles as FunctionComponent<Record<string, unknown>>, {
        ...boxProps,
        header: headerEl,
      })}
    </div>
  )
}

;(window as unknown as {
  __wbHarness: {
    mount: (container: HTMLElement, props: Parameters<typeof Harness>[0]) => void
    styles: string
  }
}).__wbHarness = {
  mount: (container, props) => {
    container.className = 'ben-wb'
    container.innerHTML = ''
    const root = createRoot(container)
    root.render(createElement(Harness, props))
  },
  styles: `${TOKENS_STYLE}\n${STYLE}`,
}
