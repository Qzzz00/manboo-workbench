/**
 * 全屏界面的窗口拖拽(2026-11-13):先写判定,再接线。
 *
 * 现有拖拽只在主工作台的 `TopBar.tsx` 上:网页顶栏空白处 mousedown → `titlebar_drag`
 * → 壳 `performDrag(with:)`。但登录屏、启动弹窗、首次引导、整屏密钥引导都是
 * `WorkbenchOverlay` 的 early-return,**一屏都不渲染 TopBar** —— 装完到配完 Key 这一路
 * 窗口完全没有落点,维护者反馈「主窗口无法拖拽」。
 *
 * 这里补的是「没有 TopBar 时」的兜底:窗口顶部一条空白带(避开红绿灯)按住就能拖,
 * 不改 DOM 布局、不盖一层会吃掉点击的东西。判定写成纯函数,安装函数只负责把 DOM
 * 事件翻译成同一条壳消息。主工作台(TopBar 在)原样交给 TopBar,两套不叠。
 */
/** @vitest-environment node */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  WINDOW_DRAG_BAND_PX, WINDOW_DRAG_TRAFFIC_INSET_PX, WINDOW_DRAG_ATTR,
  WINDOW_DRAG_COPY, shouldWindowDrag,
} from './windowDrag.ts'

const source = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8')

const blank = {
  button: 0,
  clientX: 480,
  clientY: 14,
  defaultPrevented: false,
  interactive: false,
  inHandle: false,
  hasTopBar: false,
}

describe('shouldWindowDrag', () => {
  it('没有顶栏时,窗口顶部空白按住可以拖', () => {
    expect(shouldWindowDrag(blank)).toBe(true)
  })

  it('只认左键:右键要留给菜单,中键留给粘贴', () => {
    expect(shouldWindowDrag({ ...blank, button: 2 })).toBe(false)
    expect(shouldWindowDrag({ ...blank, button: 1 })).toBe(false)
  })

  it('别人已经处理过的事件不插手', () => {
    expect(shouldWindowDrag({ ...blank, defaultPrevented: true })).toBe(false)
  })

  it('按在能点的东西上不算拖动,把手内也一样', () => {
    expect(shouldWindowDrag({ ...blank, interactive: true })).toBe(false)
    expect(shouldWindowDrag({ ...blank, interactive: true, inHandle: true })).toBe(false)
  })

  it('显式标了 data-wb-drag 的把手,多高都能拖', () => {
    expect(shouldWindowDrag({ ...blank, inHandle: true, clientY: 700 })).toBe(true)
    expect(shouldWindowDrag({ ...blank, inHandle: true, clientX: 10 })).toBe(true)
  })

  it('顶部带之外不拖,免得点正文把窗口拖走', () => {
    expect(shouldWindowDrag({ ...blank, clientY: WINDOW_DRAG_BAND_PX })).toBe(true)
    expect(shouldWindowDrag({ ...blank, clientY: WINDOW_DRAG_BAND_PX + 1 })).toBe(false)
    expect(shouldWindowDrag({ ...blank, clientY: -1 })).toBe(false)
  })

  it('左上角红绿灯那一截不拖,按下去要点的是系统按钮', () => {
    expect(shouldWindowDrag({ ...blank, clientX: 40 })).toBe(false)
    expect(shouldWindowDrag({ ...blank, clientX: WINDOW_DRAG_TRAFFIC_INSET_PX })).toBe(false)
    expect(shouldWindowDrag({ ...blank, clientX: WINDOW_DRAG_TRAFFIC_INSET_PX + 1 })).toBe(true)
  })

  it('主工作台有 TopBar,这一路整体让开,不和 TopBar 重复发消息', () => {
    expect(shouldWindowDrag({ ...blank, hasTopBar: true })).toBe(false)
    expect(shouldWindowDrag({ ...blank, hasTopBar: true, inHandle: true })).toBe(false)
  })
})

describe('常量与文案', () => {
  it('红绿灯留白与壳侧 ShellTitleBar.trafficLightInset 是同一个数', () => {
    expect(WINDOW_DRAG_TRAFFIC_INSET_PX).toBe(78)
    const titleBar = source('../../../workbench-app/Sources/TitleBar.swift')
    expect(titleBar).toContain('trafficLightInset: CGFloat = 78')
  })

  it('拖拽带高度是 30px 这一档:够按,又不至于盖住内容', () => {
    expect(WINDOW_DRAG_BAND_PX).toBe(30)
  })

  it('把手属性与提示文案', () => {
    expect(WINDOW_DRAG_ATTR).toBe('data-wb-drag')
    expect(WINDOW_DRAG_COPY.hint).toBe('按住这里可以拖动窗口')
  })
})

describe('接线(源码对照,防漂移)', () => {
  it('client/index.ts 在 apply 里装了全局拖拽监听', () => {
    const entry = source('./index.ts')
    expect(entry).toContain("import { installWindowDrag } from './windowDrag.ts'")
    expect(entry).toContain('installWindowDrag(document, window)')
  })

  it('Workbench 每个全屏 early-return 都挂了可见把手', () => {
    const workbench = source('./Workbench.tsx')
    expect(workbench).toContain("import { WindowDragHandle } from './WindowDragHandle.tsx'")
    const count = workbench.split('<WindowDragHandle />').length - 1
    expect(count).toBeGreaterThanOrEqual(6)
  })

  it('把手只做提示,不吃掉底下内容的点击', () => {
    const handle = source('./WindowDragHandle.tsx')
    expect(handle).toContain(WINDOW_DRAG_ATTR)
    expect(handle).toContain('pointer-events:none')
  })

  it('壳侧:窗口背景可拖 + 拖动消息有最近一次按下事件兜底', () => {
    expect(source('../../../workbench-app/Sources/TitleBar.swift')).toContain('static let movableByWindowBackground = true')
    const app = source('../../../workbench-app/Sources/AppDelegate.swift')
    expect(app).toContain('window.isMovableByWindowBackground = ShellTitleBar.movableByWindowBackground')
    expect(app).toContain('lastMouseDownEvent')
  })

  it('用的是既有壳通道,没有另开一条', () => {
    expect(source('./windowDrag.ts')).toContain("from './topbarDrag.ts'")
    expect(source('./windowDrag.ts')).toContain('requestShellDrag(win)')
  })
})
