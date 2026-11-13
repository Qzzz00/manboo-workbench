/**
 * 全屏界面窗口拖拽:装监听、发壳消息、把手组件(2026-11-13)。
 *
 * 这一层验的是「DOM 事件 → 既有壳通道」这一段:判定纯函数见 windowDrag.test.ts,
 * 壳那侧 performDrag 在 workbench-app 的 Swift 测试里。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { installWindowDrag, WINDOW_DRAG_ATTR, WINDOW_DRAG_COPY } from './windowDrag.ts'
import { WindowDragHandle } from './WindowDragHandle.tsx'

interface Posted { type: string }

function shellWindow(): { win: unknown; calls: Posted[] } {
  const calls: Posted[] = []
  const win = {
    webkit: {
      messageHandlers: {
        benWorkbenchShell: { postMessage: (message: Posted): void => { calls.push(message) } },
      },
    },
  }
  return { win, calls }
}

const teardown: Array<() => void> = []

afterEach(() => {
  teardown.splice(0).forEach((fn) => fn())
  cleanup()
  document.body.innerHTML = ''
})

/** 造一个 mousedown 打在指定 HTML 的第一个元素上,返回这一下的事件。 */
function press(options: {
  html?: string
  x?: number
  y?: number
  button?: number
}): MouseEvent {
  document.body.innerHTML = options.html ?? '<div id="blank">空白</div>'
  // 有可交互子元素时把这一下打在子元素上,验的才是「按在按钮上」而不是「按在按钮的爹上」。
  const target = document.body.querySelector('button,a,input,select,textarea,label,[data-no-drag]')
    ?? document.body.firstElementChild!
  const event = new MouseEvent('mousedown', {
    bubbles: true,
    cancelable: true,
    button: options.button ?? 0,
    clientX: options.x ?? 480,
    clientY: options.y ?? 14,
  })
  target.dispatchEvent(event)
  return event
}

describe('installWindowDrag', () => {
  it('没有顶栏时,顶部空白按下 → 发 titlebar_drag 给壳', () => {
    const { win, calls } = shellWindow()
    teardown.push(installWindowDrag(document, win))
    const event = press({})
    expect(calls).toEqual([{ type: 'titlebar_drag' }])
    expect(event.defaultPrevented).toBe(true)
  })

  it('按在按钮/输入框/链接上不拖,点击照旧', () => {
    const { win, calls } = shellWindow()
    teardown.push(installWindowDrag(document, win))
    for (const html of [
      '<button id="go">去配置</button>',
      '<div id="wrap"><a href="#x">外链</a></div>',
      '<input id="key" />',
      '<div data-no-drag id="no">别拖</div>',
    ]) {
      const event = press({ html })
      expect(event.defaultPrevented).toBe(false)
    }
    expect(calls).toEqual([])
  })

  it('红绿灯那一截与顶部带之外都不拖', () => {
    const { win, calls } = shellWindow()
    teardown.push(installWindowDrag(document, win))
    press({ x: 40 })
    press({ y: 31 })
    press({ y: 200 })
    expect(calls).toEqual([])
  })

  it('右键不拖', () => {
    const { win, calls } = shellWindow()
    teardown.push(installWindowDrag(document, win))
    press({ button: 2 })
    expect(calls).toEqual([])
  })

  it('主工作台渲染着 TopBar 时整体让开,不重复发', () => {
    const { win, calls } = shellWindow()
    teardown.push(installWindowDrag(document, win))
    document.body.innerHTML = '<div class="ben-wb__topbar">顶栏</div><div id="blank">空白</div>'
    document.querySelector('#blank')!.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true, cancelable: true, button: 0, clientX: 480, clientY: 14,
    }))
    expect(calls).toEqual([])
  })

  it(`标了 ${WINDOW_DRAG_ATTR} 的把手,多高都能拖`, () => {
    const { win, calls } = shellWindow()
    teardown.push(installWindowDrag(document, win))
    press({ html: '<div data-wb-drag><span>按住这里可以拖动窗口</span></div>', y: 700, x: 10 })
    expect(calls).toEqual([{ type: 'titlebar_drag' }])
  })

  it('浏览器标签页里没有壳通道:不报错、也不吃掉这一下', () => {
    teardown.push(installWindowDrag(document, {}))
    const event = press({})
    expect(event.defaultPrevented).toBe(false)
  })

  it('壳通道 postMessage 抛错也不吃掉这一下', () => {
    const win = { webkit: { messageHandlers: { benWorkbenchShell: { postMessage: (): void => { throw new Error('壳没接上') } } } } }
    teardown.push(installWindowDrag(document, win))
    const event = press({})
    expect(event.defaultPrevented).toBe(false)
  })

  it('返回的清理函数把监听摘干净', () => {
    const { win, calls } = shellWindow()
    const stop = installWindowDrag(document, win)
    press({})
    stop()
    press({})
    expect(calls).toEqual([{ type: 'titlebar_drag' }])
  })
})

describe('WindowDragHandle', () => {
  it('顶部一条可见提示,带把手属性与无障碍标签', () => {
    render(<WindowDragHandle />)
    const bar = screen.getByLabelText('拖动窗口')
    expect(bar.getAttribute(WINDOW_DRAG_ATTR)).not.toBeNull()
    expect(screen.getByText(WINDOW_DRAG_COPY.hint)).toBeTruthy()
  })

  it('提示条不拦截点击(样式里 pointer-events:none)', () => {
    const { container } = render(<WindowDragHandle />)
    expect(container.querySelector('style')?.textContent).toContain('pointer-events:none')
  })
})
