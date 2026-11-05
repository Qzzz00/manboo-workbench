import '@testing-library/jest-dom/vitest'
import { act } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DockTabBar } from '../src/client/DockTabBar.tsx'
import type { DockTab } from '../src/protocol.ts'

beforeEach(() => vi.useFakeTimers())
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks() })

function mount(tab: Partial<DockTab> = {}, pending = false) {
  const fetchImpl = vi.fn(async () => new Response('{}'))
  const app = { key: 'wechat', label: '微信', running: true, current: false, ...tab }
  const view = render(<div className="ben-wb"><div className="ben-wb__land-rail">
    <DockTabBar dock={pending ? { stack: [], pending: [app] } : { stack: [app] }} sessions={[]} badges={{}}
      baseUrl="http://test" fetchImpl={fetchImpl} butlerActive={false} onSelectButler={() => {}} />
  </div></div>)
  return { ...view, fetchImpl, button: screen.getByRole('button', { name: /^微信/ }) }
}

function pause(ms = 400) { act(() => vi.advanceTimersByTime(ms)) }

describe('应用标签的轻提示', () => {
  it('清楚显示名称的普通应用无需重复弹出名称，也不保留系统 title', () => {
    const { button } = mount()
    expect(button).not.toHaveAttribute('title')
    fireEvent.mouseEnter(button)
    pause()
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('双窗说明在停留片刻后出现，并关联应用按钮', () => {
    const { button } = mount({ dual: true })
    fireEvent.mouseEnter(button)
    pause(200)
    expect(screen.queryByRole('tooltip')).toBeNull()
    pause(200)
    const hint = screen.getByRole('tooltip')
    expect(hint).toHaveTextContent('微信')
    expect(hint).toHaveTextContent('同时切换两扇窗口')
    expect(button).toHaveAttribute('aria-describedby', hint.id)
  })

  it('快速经过时不弹出，离开后不会补弹', () => {
    const { button } = mount({ dual: true })
    fireEvent.mouseEnter(button)
    pause(200)
    fireEvent.mouseLeave(button)
    pause()
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('点击立即关闭提示并照常切换应用，点击产生的焦点不会再次弹出', () => {
    const { button, fetchImpl } = mount({ dual: true })
    fireEvent.mouseEnter(button)
    pause()
    expect(screen.getByRole('tooltip')).toBeInTheDocument()
    fireEvent.pointerDown(button)
    fireEvent.focus(button)
    fireEvent.click(button)
    pause()
    expect(screen.queryByRole('tooltip')).toBeNull()
    expect(fetchImpl).toHaveBeenCalledWith('http://test/dock/switch', expect.objectContaining({ body: JSON.stringify({ app: 'wechat' }) }))
  })

  it('键盘聚焦能读到说明，Escape 收起且不触发切换', () => {
    const { button, fetchImpl } = mount({ dual: true })
    fireEvent.focus(button)
    expect(screen.getByRole('tooltip')).toBeInTheDocument()
    fireEvent.keyDown(button, { key: 'Escape' })
    expect(screen.queryByRole('tooltip')).toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it.each(['scroll', 'resize', 'blur'])('%s 时收起，避免提示停留在旧位置', event => {
    const { button } = mount({ dual: true })
    fireEvent.mouseEnter(button)
    pause()
    expect(screen.getByRole('tooltip')).toBeInTheDocument()
    fireEvent(window, new Event(event))
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('已被截断的应用名称仍能查看全名', () => {
    const { button } = mount()
    Object.defineProperties(button, { scrollWidth: { value: 240 }, clientWidth: { value: 120 } })
    fireEvent.mouseEnter(button)
    pause()
    expect(screen.getByRole('tooltip')).toHaveTextContent('微信')
  })

  it('未放入窗口槽的应用保留原因和操作说明', () => {
    const { button } = mount({ unplaced: '窗口已关闭' })
    fireEvent.mouseEnter(button)
    pause()
    expect(screen.getByRole('tooltip')).toHaveTextContent('窗口已关闭')
    expect(screen.getByRole('tooltip')).toHaveTextContent('点一下拉进来')
  })

  it('待认领应用使用相同的提示，并照常发出认领请求', () => {
    const { button, fetchImpl } = mount({}, true)
    fireEvent.mouseEnter(button)
    pause()
    expect(button).not.toHaveAttribute('title')
    expect(screen.getByRole('tooltip')).toHaveTextContent('没开着会先打开')
    fireEvent.click(button)
    expect(screen.queryByRole('tooltip')).toBeNull()
    expect(fetchImpl).toHaveBeenCalledWith('http://test/dock/claim', expect.objectContaining({ body: JSON.stringify({ app: 'wechat' }) }))
  })

  it('提示宽度与位置限制在侧栏内，靠顶部时向下显示', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('ben-wb__land-rail')) return new DOMRect(0, 0, 200, 800)
      if (this.classList.contains('ben-wb__dock-app-hint')) return new DOMRect(0, 0, 184, 54)
      return new DOMRect(10, 20, 180, 30)
    })
    const { button } = mount({ dual: true })
    fireEvent.mouseEnter(button)
    pause()
    const hint = screen.getByRole('tooltip')
    expect(hint.style.maxWidth).toBe('184px')
    expect(hint.style.left).toBe('8px')
    expect(hint.style.top).toBe('58px')
  })

  it('有空间时显示在应用上方，无安全空间时不会落入真实窗口区域', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('ben-wb__land-rail')) return new DOMRect(0, 0, 200, 800)
      if (this.classList.contains('ben-wb__dock-app-hint')) return new DOMRect(0, 0, 184, 54)
      if (this.classList.contains('ben-wb__slot-body')) return new DOMRect(0, 20, 200, 780)
      return new DOMRect(10, 200, 180, 30)
    })
    const { button, container } = mount({ dual: true })
    fireEvent.mouseEnter(button)
    pause()
    expect(screen.getByRole('tooltip').style.top).toBe('138px')
    fireEvent.mouseLeave(button)
    const slot = document.createElement('div')
    slot.className = 'ben-wb__slot-body'
    container.querySelector('.ben-wb')?.append(slot)
    fireEvent.mouseEnter(button)
    pause()
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('等待显示期间滚动也取消延迟，卸载后不遗留计时器', () => {
    const { button, unmount } = mount({ dual: true })
    fireEvent.mouseEnter(button)
    fireEvent.scroll(window)
    pause()
    expect(screen.queryByRole('tooltip')).toBeNull()
    fireEvent.mouseLeave(button)
    fireEvent.mouseEnter(button)
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('聚焦发生在悬停延迟中途时，不遗留会让提示跳位的定时器', () => {
    const { button } = mount({ dual: true })
    fireEvent.mouseEnter(button)
    pause(200)
    fireEvent.focus(button)
    expect(screen.getByRole('tooltip')).toBeInTheDocument()
    expect(vi.getTimerCount()).toBe(0)
    const style = screen.getByRole('tooltip').getAttribute('style')
    pause()
    expect(screen.getByRole('tooltip')).toHaveAttribute('style', style)
  })
})
