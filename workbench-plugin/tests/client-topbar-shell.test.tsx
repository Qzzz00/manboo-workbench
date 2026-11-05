/**
 * 壳顶上那一条并成一行(2026-09-25,卡 TB;维护者原话「客户端没法全屏、顶部空隙难受」)。
 *
 * 顶上原来叠三层:系统菜单栏、壳自己的窗口标题栏、网页里的「工作台」标题行 + 状态行。
 * 壳那一半在 workbench-app/Sources/TitleBar.swift(标题栏透明、内容顶到窗顶,用例在 run-tests.sh);
 * 这里守网页这一半:
 *   ① 一行:名字、各家小灯、存储 / 性能、额度摘要、时间、纯净开关都在同一条里,页头那一行没了;
 *   ② 左边给红绿灯留出位置(data-shell=app → CSS padding-left:78px),那一截下面不放能点的东西;
 *   ③ 空白处按住 → 壳去拖窗口;按在能点的东西上 → 不拖(点一下不该把窗口带走);双击 → 交给壳;
 *   ④ 纯净模式下这一行只剩必要的(名字、恢复默认布局收起)。
 */

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RESET_LAYOUT_LABEL, TopBar } from '../src/client/TopBar.tsx'
import { isDragBlank, TITLEBAR_DBLCLICK, TITLEBAR_DRAG } from '../src/client/topbarDrag.ts'

const WIDGET = { error: false, valueText: '62% · 剩 180G', alert: false }
const PERF = { error: false, valueText: '54% 空闲 · 16G' }
const LAMPS = [{ id: 'dsh', name: '事务官', color: 'teal' }, { id: 'muse', name: 'Muse', color: 'amber' }]

/** 壳的通道:jsdom 里没有 webkit,测试自己挂一个,断言发出去的是什么。 */
function stubShellBridge(): { postMessage: ReturnType<typeof vi.fn> } {
  const handler = { postMessage: vi.fn() }
  Object.defineProperty(window, 'webkit', {
    value: { messageHandlers: { benWorkbenchShell: handler } },
    configurable: true,
    writable: true,
  })
  return handler
}

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'webkit')
})

describe('顶栏并成一行(卡 TB)', () => {
  it('★一行里就有:小字「工作台」、各家小灯、存储 / 性能、额度摘要、时间、纯净开关', () => {
    render(
      <TopBar
        lamps={LAMPS}
        now="10:03"
        storage={WIDGET}
        performance={PERF}
        onOpenSettings={() => {}}
        quotaSummary="Claude 还剩 62%"
        onTogglePureMode={() => {}}
        shell
      />,
    )
    const bar = screen.getByRole('group', { name: '来源与额度概览' })
    // 标题就是这一行里的小字,不再是上面单独一行的大标题。
    expect(within(bar).getByRole('heading', { name: '工作台' })).toBeTruthy()
    expect(within(bar).getByText('事务官')).toBeTruthy()
    expect(within(bar).getByText('Muse')).toBeTruthy()
    expect(within(bar).getByRole('group', { name: '存储' })).toBeTruthy()
    expect(within(bar).getByRole('group', { name: '性能' })).toBeTruthy()
    expect(within(bar).getByRole('group', { name: '额度摘要' })).toBeTruthy()
    expect(within(bar).getByText('10:03')).toBeTruthy()
    expect(within(bar).getByRole('button', { name: '纯净' })).toBeTruthy()
  })

  it('★壳里才给红绿灯让位(data-shell=app);浏览器标签页里没有这一说', () => {
    const { unmount } = render(
      <TopBar lamps={LAMPS} now="10:03" storage={WIDGET} performance={PERF} onOpenSettings={() => {}} shell />,
    )
    expect(screen.getByRole('group', { name: '来源与额度概览' })).toHaveAttribute('data-shell', 'app')
    unmount()
    render(<TopBar lamps={LAMPS} now="10:03" storage={WIDGET} performance={PERF} onOpenSettings={() => {}} />)
    expect(screen.getByRole('group', { name: '来源与额度概览' })).not.toHaveAttribute('data-shell')
  })

  it('★纯净模式:这一行只剩必要的——小字标题与「恢复默认布局」收起,小灯与开关还在', () => {
    render(
      <TopBar
        lamps={LAMPS}
        now="10:03"
        storage={WIDGET}
        performance={PERF}
        onOpenSettings={() => {}}
        onResetLayout={() => {}}
        onTogglePureMode={() => {}}
        pureMode
        shell
      />,
    )
    expect(screen.queryByRole('heading', { name: '工作台' })).toBeNull()
    expect(screen.queryByRole('button', { name: RESET_LAYOUT_LABEL })).toBeNull()
    expect(screen.getByText('事务官')).toBeTruthy()
    expect(screen.getByRole('button', { name: '完整' })).toBeTruthy()
  })

  it('页头没了之后,「恢复默认布局」「返回对话」在这一行里(没有丢功能)', () => {
    const onResetLayout = vi.fn()
    const onReturn = vi.fn()
    render(
      <TopBar
        lamps={LAMPS}
        now="10:03"
        storage={WIDGET}
        performance={PERF}
        onOpenSettings={() => {}}
        onResetLayout={onResetLayout}
        onReturn={onReturn}
      />,
    )
    const bar = screen.getByRole('group', { name: '来源与额度概览' })
    expect(within(bar).getByRole('button', { name: RESET_LAYOUT_LABEL })).toBeTruthy()
    expect(within(bar).getByRole('button', { name: '返回对话' })).toBeTruthy()
  })
})

describe('右端一排照评审页 `.top-actions`(10-22 拍板 2 / 3 / 4)', () => {
  it('时刻之后依次:学到的做法、设置(写字,不再是 ⚙)、纯净、恢复布局', () => {
    const onOpenLearned = vi.fn()
    render(
      <TopBar
        lamps={LAMPS}
        now="10:03"
        storage={WIDGET}
        performance={PERF}
        onOpenSettings={() => {}}
        onOpenLearned={onOpenLearned}
        onTogglePureMode={() => {}}
        onResetLayout={() => {}}
      />,
    )
    const bar = screen.getByRole('group', { name: '来源与额度概览' })
    const names = within(bar).getAllByRole('button').map(one => one.textContent)
    expect(names.slice(-4)).toEqual(['学到的做法', '设置', '纯净', '恢复布局'])
    expect(RESET_LAYOUT_LABEL).toBe('恢复布局')
    within(bar).getByRole('button', { name: '学到的做法' }).click()
    expect(onOpenLearned).toHaveBeenCalled()
  })
})

describe('表头可拖(卡 TB:标题栏透明之后拖窗口的落点就是这一条)', () => {
  it('★空白处按下左键 → 让壳去拖窗口', () => {
    const handler = stubShellBridge()
    render(<TopBar lamps={LAMPS} now="10:03" storage={WIDGET} performance={PERF} onOpenSettings={() => {}} shell />)
    const bar = screen.getByRole('group', { name: '来源与额度概览' })
    bar.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
    expect(handler.postMessage).toHaveBeenCalledWith({ type: TITLEBAR_DRAG })
  })

  it('★按在能点的东西上不算拖动(点一下齿轮不该把窗口带走)', () => {
    const handler = stubShellBridge()
    render(<TopBar lamps={LAMPS} now="10:03" storage={WIDGET} performance={PERF} onOpenSettings={() => {}} shell />)
    screen.getByRole('button', { name: '设置' }).dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
    expect(handler.postMessage).not.toHaveBeenCalled()
  })

  it('右键不算拖动(右键另有去处)', () => {
    const handler = stubShellBridge()
    render(<TopBar lamps={LAMPS} now="10:03" storage={WIDGET} performance={PERF} onOpenSettings={() => {}} shell />)
    const bar = screen.getByRole('group', { name: '来源与额度概览' })
    bar.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 2 }))
    expect(handler.postMessage).not.toHaveBeenCalled()
  })

  it('★双击表头 → 交给壳(它照系统设置「连按标题栏来」那一项做)', () => {
    const handler = stubShellBridge()
    render(<TopBar lamps={LAMPS} now="10:03" storage={WIDGET} performance={PERF} onOpenSettings={() => {}} shell />)
    const bar = screen.getByRole('group', { name: '来源与额度概览' })
    bar.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    expect(handler.postMessage).toHaveBeenCalledWith({ type: TITLEBAR_DBLCLICK })
  })

  it('不在壳里(浏览器标签页):按顶栏什么也不发', () => {
    const handler = stubShellBridge()
    render(<TopBar lamps={LAMPS} now="10:03" storage={WIDGET} performance={PERF} onOpenSettings={() => {}} />)
    const bar = screen.getByRole('group', { name: '来源与额度概览' })
    bar.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
    bar.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    expect(handler.postMessage).not.toHaveBeenCalled()
  })
})

describe('纯函数:哪里算「顶栏的空白处」', () => {
  it('底色、纯文字算空白;按钮、链接、输入框及它们里面的东西不算', () => {
    const bar = document.createElement('div')
    const text = document.createElement('span')
    const button = document.createElement('button')
    const dot = document.createElement('i')
    button.append(dot)
    const marked = document.createElement('span')
    marked.dataset.noDrag = 'true'
    bar.append(text, button, marked)
    document.body.append(bar)

    expect(isDragBlank(bar, bar)).toBe(true)
    expect(isDragBlank(text, bar)).toBe(true)
    expect(isDragBlank(button, bar)).toBe(false)
    expect(isDragBlank(dot, bar)).toBe(false)
    // 以后往顶栏加东西,标一个 data-no-drag 就不会被当成拖动区。
    expect(isDragBlank(marked, bar)).toBe(false)
    bar.remove()
  })

  it('不在顶栏里的东西、以及拿不到节点时一律不算(宁可拖不动,也不要点一下窗口就跑)', () => {
    const bar = document.createElement('div')
    const outside = document.createElement('div')
    document.body.append(bar, outside)
    expect(isDragBlank(outside, bar)).toBe(false)
    expect(isDragBlank(null, bar)).toBe(false)
    expect(isDragBlank(bar, null)).toBe(false)
    expect(isDragBlank({}, bar)).toBe(false)
    bar.remove()
    outside.remove()
  })
})
