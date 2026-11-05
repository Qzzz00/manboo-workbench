import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SettingsDialog } from '../src/client/SettingsDialog.tsx'
import { GROUP, openGroup } from './settingsGroup.ts'

afterEach(cleanup)

const okFetch = vi.fn(async () => ({
  ok: true, json: async () => ({ deepseek: false, kimi_web: false, claude_api: false }),
})) as unknown as typeof fetch

describe('齿轮弹窗(2026-08-25 版面重排:凭据从组件条收进来)', () => {
  it('是个 modal 对话框,标题「设置」', async () => {
    render(<SettingsDialog baseUrl="http://x" fetchImpl={okFetch} onClose={() => {}} />)
    expect(screen.getByRole('dialog', { name: '设置' })).toHaveAttribute('aria-modal', 'true')
  })

  it('密钥那一节在「各家 AI 与账号」那一组里', async () => {
    render(<SettingsDialog baseUrl="http://x" fetchImpl={okFetch} onClose={() => {}} />)
    await openGroup(GROUP.agents)
    // 2026-10-22 起节名照评审页:「各家的登录与密钥」
    expect(await screen.findByRole('heading', { name: '各家的登录与密钥' })).toBeTruthy()
  })

  it('点「关闭设置」回调 onClose', async () => {
    const onClose = vi.fn()
    render(<SettingsDialog baseUrl="http://x" fetchImpl={okFetch} onClose={onClose} />)
    await userEvent.click(screen.getByRole('button', { name: '关闭设置' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('按 Esc 关闭', async () => {
    const onClose = vi.fn()
    render(<SettingsDialog baseUrl="http://x" fetchImpl={okFetch} onClose={onClose} />)
    await userEvent.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('点内容区不关(只有点遮罩才关)', async () => {
    const onClose = vi.fn()
    render(<SettingsDialog baseUrl="http://x" fetchImpl={okFetch} onClose={onClose} />)
    await userEvent.click(screen.getByRole('dialog', { name: '设置' }))
    expect(onClose).not.toHaveBeenCalled()
  })

  /**
   * 2026-08-26 Ben 实机反馈:弹窗开在视口正中,正好落在应用区——那块盖着认领进来的
   * **真原生窗口**,弹窗整个被挡住,肉眼看不见。CSS z-index 排不到操作系统窗口前面,
   * 唯一的解法是开在画面上不会被真窗盖住的地方(顶部那一条)。
   *
   * 断言样式字符串而不是渲染后的计算样式:jsdom 不做布局,getComputedStyle 拿不到
   * flex 对齐的实际效果——这里要钉住的是"别再改回居中"这件事,样式源文本足够。
   */
  it('弹窗贴顶开,不落在应用区中央(被真窗盖住的那块)', async () => {
    const { STYLE } = await import('../src/client/style.ts')
    const backdrop = STYLE.slice(STYLE.indexOf('.ben-wb__setdlg-backdrop{'))
    const rule = backdrop.slice(0, backdrop.indexOf('}') + 1)
    expect(rule).toContain('align-items:flex-start')
    expect(rule).not.toContain('align-items:center')
    // 高度封顶:内容长了自己卷,而不是往下长进应用区。
    const dlg = STYLE.slice(STYLE.indexOf('.ben-wb__setdlg{'))
    expect(dlg.slice(0, dlg.indexOf('}') + 1)).toMatch(/max-height:min\(\d+vh,\d+px\)/)
  })
})

describe('峰谷时段设置(2026-09-09,借 save-money 的时间窗语义)', () => {
  const PEAK = {
    phase: 'peak' as const,
    next_phase: 'offpeak' as const,
    next_switch: '12:02',
    periods: [{ start: '08:58', end: '12:02' }, { start: '13:58', end: '18:02' }],
  }

  it('没接峰谷(服务端没启用)时这一节不出现', async () => {
    render(<SettingsDialog baseUrl="http://x" fetchImpl={okFetch} onClose={() => {}} />)
    expect(screen.queryByRole('heading', { name: 'DeepSeek 峰谷时段' })).toBeNull()
  })

  it('回填当前时间表,并说清现在是高峰还是低谷', async () => {
    render(<SettingsDialog baseUrl="http://x" fetchImpl={okFetch} onClose={() => {}} peak={PEAK} />)
    await openGroup(GROUP.advanced)
    expect(screen.getByLabelText('第 1 段高峰开始')).toHaveValue('08:58')
    expect(screen.getByLabelText('第 2 段高峰结束')).toHaveValue('18:02')
    expect(screen.getByText(/现在是高峰 · 12:02 转低谷/)).toBeTruthy()
  })

  it('★这一节里没有任何"自动暂停"的开关——纪律是只给意识,不替 Ben 做决定', async () => {
    const { container } = render(
      <SettingsDialog baseUrl="http://x" fetchImpl={okFetch} onClose={() => {}} peak={PEAK} />,
    )
    await openGroup(GROUP.advanced)
    expect(container.textContent).toContain('不会自动暂停任何任务')
    expect(screen.queryByRole('checkbox')).toBeNull()
  })

  it('改完保存:POST /peak-schedule,带上改后的时间表', async () => {
    const calls: { url: string, body: unknown }[] = []
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) })
      return { ok: true, json: async () => ({ deepseek: false, kimi_web: false, claude_api: false, ok: true }) }
    }) as unknown as typeof fetch

    render(<SettingsDialog baseUrl="http://x" fetchImpl={fetchImpl} onClose={() => {}} peak={PEAK} />)
    await openGroup(GROUP.advanced)
    await userEvent.clear(screen.getByLabelText('第 1 段高峰开始'))
    await userEvent.type(screen.getByLabelText('第 1 段高峰开始'), '09:00')
    await userEvent.click(screen.getByRole('button', { name: '保存时段' }))

    const saved = calls.find(call => call.url === 'http://x/peak-schedule')
    expect(saved?.body).toEqual({ periods: [{ start: '09:00', end: '12:02' }, { start: '13:58', end: '18:02' }] })
    expect(await screen.findByText('已保存')).toBeTruthy()
  })

  it('服务端拒绝时把它的原话摆出来,不自己编一句', async () => {
    const fetchImpl = vi.fn(async (url: string) => (url.endsWith('/peak-schedule')
      ? { ok: false, json: async () => ({ error: '第 1 段的起点要早于终点' }) }
      : { ok: true, json: async () => ({ deepseek: false, kimi_web: false, claude_api: false }) }
    )) as unknown as typeof fetch

    render(<SettingsDialog baseUrl="http://x" fetchImpl={fetchImpl} onClose={() => {}} peak={PEAK} />)
    await openGroup(GROUP.advanced)
    await userEvent.click(screen.getByRole('button', { name: '保存时段' }))
    expect(await screen.findByText('第 1 段的起点要早于终点')).toBeTruthy()
  })

  it('可以删一段、加一段', async () => {
    render(<SettingsDialog baseUrl="http://x" fetchImpl={okFetch} onClose={() => {}} peak={PEAK} />)
    await openGroup(GROUP.advanced)
    await userEvent.click(screen.getByRole('button', { name: '删掉第 2 段' }))
    expect(screen.queryByLabelText('第 2 段高峰开始')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: '加一段' }))
    expect(screen.getByLabelText('第 2 段高峰开始')).toHaveValue('')
  })
})
