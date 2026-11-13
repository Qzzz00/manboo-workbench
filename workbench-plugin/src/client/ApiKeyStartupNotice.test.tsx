/**
 * 启动时的「没有配置大模型 api key」弹窗:提示语、3 秒自动跳转、手动立即去、稍后再说。
 *
 * 纪律:这一屏不收 Key、不读剪贴板、不联网,只是个带倒计时的提示。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ApiKeyStartupNotice } from './ApiKeyStartupNotice.tsx'
import { API_KEY_STARTUP_COPY, API_KEY_STARTUP_DELAY_MS } from './apiKeyStartup.ts'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function notice(over: Partial<Parameters<typeof ApiKeyStartupNotice>[0]> = {}) {
  const props = {
    onGo: vi.fn(),
    onSkip: vi.fn(),
    ...over,
  }
  const view = render(<ApiKeyStartupNotice {...props} />)
  return { props, view }
}

describe('弹窗出现时', () => {
  it('是一个模态框,提示语用原话,不显示任何 Key', () => {
    notice()
    const dialog = screen.getByRole('dialog', { name: '未配置大模型密钥' })
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(dialog.textContent).toContain(API_KEY_STARTUP_COPY.title)
    expect(dialog.textContent).not.toContain('sk-')
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('默认倒计时从 3 秒开始', () => {
    notice()
    expect(screen.getByRole('status').textContent).toContain('3')
    expect(API_KEY_STARTUP_DELAY_MS).toBe(3000)
  })
})

describe('3 秒后自动跳到配置界面', () => {
  it('到点自动调一次 onGo(不是每帧调)', () => {
    vi.useFakeTimers()
    const { props } = notice()
    expect(props.onGo).not.toHaveBeenCalled()
    act(() => { vi.advanceTimersByTime(2999) })
    expect(props.onGo).not.toHaveBeenCalled()
    act(() => { vi.advanceTimersByTime(1) })
    expect(props.onGo).toHaveBeenCalledTimes(1)
    act(() => { vi.advanceTimersByTime(5000) })
    expect(props.onGo).toHaveBeenCalledTimes(1)
  })

  it('倒数到 2、1,给人看得见在走', () => {
    vi.useFakeTimers()
    notice()
    act(() => { vi.advanceTimersByTime(1000) })
    expect(screen.getByRole('status').textContent).toContain('2')
    act(() => { vi.advanceTimersByTime(1000) })
    expect(screen.getByRole('status').textContent).toContain('1')
  })

  it('点了「立即去配置」就立刻跳,之后到点不再重复跳', () => {
    vi.useFakeTimers()
    const { props } = notice()
    fireEvent.click(screen.getByRole('button', { name: API_KEY_STARTUP_COPY.go }))
    expect(props.onGo).toHaveBeenCalledTimes(1)
    act(() => { vi.advanceTimersByTime(API_KEY_STARTUP_DELAY_MS + 1000) })
    expect(props.onGo).toHaveBeenCalledTimes(1)
  })
})

describe('稍后再说', () => {
  it('点它只关弹窗,不跳配置页,倒计时到点也不再跳', () => {
    vi.useFakeTimers()
    const { props } = notice()
    fireEvent.click(screen.getByRole('button', { name: API_KEY_STARTUP_COPY.skip }))
    expect(props.onSkip).toHaveBeenCalledTimes(1)
    expect(props.onGo).not.toHaveBeenCalled()
    act(() => { vi.advanceTimersByTime(API_KEY_STARTUP_DELAY_MS + 1000) })
    expect(props.onGo).not.toHaveBeenCalled()
  })
})

describe('卸载要收干净', () => {
  it('弹窗被撤掉之后,计时器不再触发跳转', () => {
    vi.useFakeTimers()
    const { props, view } = notice()
    view.unmount()
    act(() => { vi.advanceTimersByTime(API_KEY_STARTUP_DELAY_MS + 1000) })
    expect(props.onGo).not.toHaveBeenCalled()
  })

  it('父组件重渲染换了回调引用,倒计时不重置、仍指向最新回调', () => {
    vi.useFakeTimers()
    const first = vi.fn()
    const second = vi.fn()
    const view = render(<ApiKeyStartupNotice onGo={first} onSkip={vi.fn()} />)
    act(() => { vi.advanceTimersByTime(1500) })
    view.rerender(<ApiKeyStartupNotice onGo={second} onSkip={vi.fn()} />)
    act(() => { vi.advanceTimersByTime(1500) })
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })
})
