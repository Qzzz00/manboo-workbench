import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ButlerPanel } from '../src/client/ButlerPanel.tsx'
import { SettingsDialog } from '../src/client/SettingsDialog.tsx'
import { GROUP, openGroup } from './settingsGroup.ts'

afterEach(cleanup)

const okFetch = vi.fn(async () => ({
  ok: true, json: async () => ({ deepseek: false, kimi_web: false, claude_api: false, ok: true }),
})) as unknown as typeof fetch

// 2026-10-22 起照评审页 `section('voice', '形象与音色', …)`:一行状态 + 描边「打开配置 ↗」,底下文字「停止服务 / 启动服务」;
// 怎么上传形象、浏览器里直接开那一页,收进「怎么换形象」折叠。
describe('设置里的「形象与音色」一节(2026-09-11)', () => {
  it('★ 在跑:一句人话说状态 + 两个数字;主按钮只有「打开配置 ↗」,停它是文字链接(2026-09-28 卡 SG)', async () => {
    render(<ButlerPanel baseUrl="http://x" fetchImpl={okFetch} butler={{ running: true, port: 8792, avatarCount: 3, voiceCount: 5 }} />)
    expect(screen.getByRole('heading', { name: '形象与音色' })).toBeTruthy()
    // 不再说「本机后端」「端口 8792」——她不是程序员(卡 SG:界面上不出现那一类词)。
    expect(screen.getByText('服务运行中')).toBeTruthy()
    expect(screen.getByText(/形象与音色仍在独立配置页管理。现在有形象 3 个 · 音色绑定 5 条。/)).toBeTruthy()
    const open = screen.getByRole('button', { name: '打开配置 ↗' })
    expect(open).toBeEnabled()
    expect(open).toHaveAttribute('data-kind', 'outline')
    // 启停是次要动作:文字链接,不是第二颗一样重的按钮。
    const stop = screen.getByRole('button', { name: '停止服务' })
    expect(stop).toHaveAttribute('data-kind', 'text')
    expect(screen.queryByRole('button', { name: '启动服务' })).toBeNull()
    // 浏览器里直接开那一页的链接收在「怎么换形象」里
    expect(screen.queryByRole('link')).toBeNull()
    await userEvent.click(screen.getByText('怎么换形象'))
    expect(screen.getByRole('link', { name: '也可以自己在浏览器里打开那一页' })).toHaveAttribute('href', 'http://127.0.0.1:8792/admin/')
  })

  it('未启动:不显示任何数字(不编数),「打开配置 ↗」禁用,按钮是「启动服务」', async () => {
    const { container } = render(<ButlerPanel baseUrl="http://x" fetchImpl={okFetch} butler={{ running: false, port: 8792 }} />)
    expect(screen.getByText(/形象与音色这一套这会儿没起来/)).toBeTruthy()
    expect(container.textContent).not.toMatch(/形象 \d/)
    expect(container.textContent).not.toMatch(/音色绑定 \d/)
    expect(screen.getByText('服务没在跑')).toBeTruthy()
    expect(screen.getByRole('button', { name: '打开配置 ↗' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '启动服务' })).toBeTruthy()
  })

  it('★ 形象靠上传(2026-10-21 仓库不带模型):说清从哪传、传完要发布;一个都没有时明说手机和展示台先用粒子球', async () => {
    const { container, rerender } = render(<ButlerPanel baseUrl="http://x" fetchImpl={okFetch} butler={{ running: true, port: 8792, avatarCount: 0, voiceCount: 0 }} />)
    // 从哪传、传完要发布:收在「怎么换形象」里,一点就开
    await userEvent.click(screen.getByText('怎么换形象'))
    expect(container.textContent).not.toContain('Aiboo')
    expect(container.textContent).toMatch(/上传 Live2D 形象包\(zip\)/)
    expect(container.textContent).toContain('发布')
    expect(screen.getByText(/还没有形象:手机和展示台先用粒子球/)).toBeTruthy()
    rerender(<ButlerPanel baseUrl="http://x" fetchImpl={okFetch} butler={{ running: true, port: 8792, avatarCount: 2 }} />)
    expect(screen.queryByText(/还没有形象/)).toBeNull()
    // 没在跑 / 没给数:不猜有没有形象
    rerender(<ButlerPanel baseUrl="http://x" fetchImpl={okFetch} butler={{ running: true, port: 8792 }} />)
    expect(screen.queryByText(/还没有形象/)).toBeNull()
  })

  it('只给了一个数字就只显示那一个', async () => {
    const { container } = render(<ButlerPanel baseUrl="http://x" fetchImpl={okFetch} butler={{ running: true, port: 8792, avatarCount: 1 }} />)
    expect(container.textContent).toContain('形象 1 个')
    expect(container.textContent).not.toContain('音色绑定')
  })

  it('点「启动服务」POST /butler/start;点「打开配置 ↗」POST /butler/open', async () => {
    const calls: string[] = []
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`)
      return { ok: true, json: async () => ({ ok: true }) }
    }) as unknown as typeof fetch
    const { rerender } = render(<ButlerPanel baseUrl="http://x" fetchImpl={fetchImpl} butler={{ running: false, port: 8792 }} />)
    await userEvent.click(screen.getByRole('button', { name: '启动服务' }))
    expect(calls).toEqual(['POST http://x/butler/start'])
    expect(await screen.findByText(/已发送启动/)).toBeTruthy()
    rerender(<ButlerPanel baseUrl="http://x" fetchImpl={fetchImpl} butler={{ running: true, port: 8792 }} />)
    await userEvent.click(screen.getByRole('button', { name: '打开配置 ↗' }))
    expect(calls).toEqual(['POST http://x/butler/start', 'POST http://x/butler/open'])
  })

  it('服务端拒绝时把它的原话摆出来,不自己编一句', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true, json: async () => ({ ok: false, error: 'launchd 里没有 ai.deepseek.butler,也找不到 /Users/example/.dsh/bin/butler-start:先按交接文档装 plist' }),
    })) as unknown as typeof fetch
    render(<ButlerPanel baseUrl="http://x" fetchImpl={fetchImpl} butler={{ running: false, port: 8792 }} />)
    await userEvent.click(screen.getByRole('button', { name: '启动服务' }))
    expect(await screen.findByText(/launchd 里没有 ai.deepseek.butler/)).toBeTruthy()
  })
})

describe('SettingsDialog 里的这一节', () => {
  it('没接本机后端(/state 里没有 butler)时这一节不出现', async () => {
    render(<SettingsDialog baseUrl="http://x" fetchImpl={okFetch} onClose={() => {}} />)
    await openGroup(GROUP.butler)
    expect(screen.queryByRole('heading', { name: '形象与音色' })).toBeNull()
  })

  it('接了就出现在设置弹窗里', async () => {
    render(<SettingsDialog baseUrl="http://x" fetchImpl={okFetch} onClose={() => {}} butler={{ running: true, port: 8792 }} />)
    await openGroup(GROUP.butler)
    expect(screen.getByRole('heading', { name: '形象与音色' })).toBeTruthy()
  })
})
