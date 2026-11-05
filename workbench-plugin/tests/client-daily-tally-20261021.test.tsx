/**
 * 日结条(2026-10-21,视觉 A「日结」):推进、没动静、点子各给数字和对应的点,一点一件,没有补到一百的装饰点;
 * 0 照写不画点;点开看完整四段,名字照旧以「日结 日期」开头。
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { DailyReport } from '../src/protocol.ts'
import { DailyBar } from '../src/client/DailyBar.tsx'

afterEach(cleanup)

const REPORT: DailyReport = {
  date: '2026-10-20',
  generated_at: '2026-10-21T09:00:05+08:00',
  progress: ['a', 'b', 'c'],
  missing: [],
  ideas: ['x'],
  proposals: [],
}

describe('日结条的点列', () => {
  it('三项各自一列点,一点一件;0 不画点', () => {
    const { container } = render(<DailyBar daily={REPORT} />)
    expect(screen.getByRole('img', { name: '推进 3' })).toBeTruthy()
    expect(screen.getByRole('img', { name: '没动静 0' })).toBeTruthy()
    expect(screen.getByRole('img', { name: '点子 1' })).toBeTruthy()
    expect(container.querySelectorAll('.wb-ui-dot')).toHaveLength(4)
  })

  it('整条还是一颗键,点开四段', () => {
    render(<DailyBar daily={REPORT} />)
    fireEvent.click(screen.getByRole('button', { name: /^日结 2026-10-20/ }))
    expect(screen.getByRole('dialog', { name: '日结 2026-10-20' })).toBeTruthy()
  })

  /* 10-22 拍板 12 / 25(评审页 `.daily-strip` / 「日结 · 10 月 20 日」那张 `.modal`):整条一颗键,不带「展开完整日结 ↗」;
     点开是居中一张:头「日结 · 10 月 20 日」+ ✕,顶上三个大数,再是各节。日结本身(四段、分账)不动。 */
  it('条上「日结 10 月 20 日」、三项、「一点一件」排最后;没有「展开完整日结」', () => {
    const { container } = render(<DailyBar daily={REPORT} />)
    const toggle = screen.getByRole('button', { name: /^日结 2026-10-20/ })
    expect(toggle.firstElementChild?.textContent).toBe('日结 10 月 20 日')
    expect(toggle.lastElementChild?.textContent).toBe('一点一件')
    expect(toggle.textContent).not.toContain('展开完整日结')
    expect(container.querySelector('.ben-wb__daily-more')).toBeNull()
  })

  it('点开:头「日结 · 10 月 20 日」、三个大数,✕ / Esc / 点遮罩都收', () => {
    render(<DailyBar daily={REPORT} />)
    const toggle = screen.getByRole('button', { name: /^日结 2026-10-20/ })
    fireEvent.click(toggle)
    const dlg = screen.getByRole('dialog', { name: '日结 2026-10-20' })
    expect(within(dlg).getByRole('heading', { name: '日结 · 10 月 20 日' })).toBeTruthy()
    expect([...dlg.querySelectorAll('.ben-wb__daily-stats strong')].map(one => one.textContent)).toEqual(['3', '0', '1'])
    fireEvent.click(within(dlg).getByRole('button', { name: '关闭日结' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(toggle)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(toggle)
    fireEvent.click(screen.getByRole('dialog').parentElement as HTMLElement)
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
