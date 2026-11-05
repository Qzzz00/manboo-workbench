/**
 * 设置 → 「更新」里那一格「收哪条更新」(2026-10-21,内测发版底座)。
 *
 * 两个单选,**不是按钮**:这一节「同一时刻屏上最多一颗主按钮」(卡 UP)的规矩照旧,
 * 选通道不是这一页要她做的事,只是维护者与统筹偶尔切一下。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UpdatePanel } from '../src/client/update/UpdatePanel.tsx'
import { CHANNEL_FALLBACK_HINT, channelHintOf } from '../src/client/update/updateModel.ts'
import { UPDATE_CHANNEL_TITLES, type UpdateCheckView } from '../src/server/update/types.ts'

afterEach(cleanup)

function checkView(over: Partial<UpdateCheckView> = {}): UpdateCheckView {
  return { current: '0.4.142', available: false, checked_at: '2026-10-21T10:00:00.000Z', channel: 'stable', ...over }
}

function fakeFetch(views: { check: UpdateCheckView, switched?: UpdateCheckView, switchFails?: string }) {
  const posts: unknown[] = []
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const text = String(url)
    if (text.endsWith('/update/check')) return { ok: true, status: 200, json: async () => views.check } as unknown as Response
    if (text.endsWith('/update/channel') && init?.method === 'POST') {
      posts.push(JSON.parse(String(init.body)))
      if (views.switchFails !== undefined) {
        return { ok: false, status: 409, json: async () => ({ error: views.switchFails }) } as unknown as Response
      }
      return { ok: true, status: 200, json: async () => views.switched } as unknown as Response
    }
    return { ok: true, status: 200, json: async () => ({}) } as unknown as Response
  }) as unknown as typeof fetch
  return { fetchImpl, posts }
}

describe('收哪条更新', () => {
  it('查回来之后出两个单选,勾着这台机器收的那条;整节照旧没有多出一颗按钮', async () => {
    const { fetchImpl } = fakeFetch({ check: checkView() })
    render(<UpdatePanel baseUrl="http://x" fetchImpl={fetchImpl} jobPollMs={0} />)
    await waitFor(() => expect(screen.getByRole('radiogroup', { name: '收哪条更新' })).toBeInTheDocument())
    expect(screen.getByRole('radio', { name: UPDATE_CHANNEL_TITLES.stable })).toBeChecked()
    expect(screen.getByRole('radio', { name: UPDATE_CHANNEL_TITLES.hotfix })).not.toBeChecked()
    expect(screen.queryAllByRole('button')).toHaveLength(0)
  })

  it('点「热修」→ POST /update/channel,用回来的那一趟重画(看得见热修版)', async () => {
    const { fetchImpl, posts } = fakeFetch({
      check: checkView(),
      switched: checkView({ channel: 'hotfix', latest: '0.4.145', available: true }),
    })
    render(<UpdatePanel baseUrl="http://x" fetchImpl={fetchImpl} jobPollMs={0} />)
    await waitFor(() => expect(screen.getByRole('radio', { name: UPDATE_CHANNEL_TITLES.hotfix })).toBeInTheDocument())
    await userEvent.click(screen.getByRole('radio', { name: UPDATE_CHANNEL_TITLES.hotfix }))
    await waitFor(() => expect(screen.getByText(/有新版:0\.4\.145/)).toBeInTheDocument())
    expect(posts).toEqual([{ channel: 'hotfix' }])
    expect(screen.getByRole('radio', { name: UPDATE_CHANNEL_TITLES.hotfix })).toBeChecked()
  })

  it('切不过去(比如正在更新)→ 原样说服务端那句,勾不动', async () => {
    const { fetchImpl } = fakeFetch({ check: checkView(), switchFails: '正在更新,装完再切通道' })
    render(<UpdatePanel baseUrl="http://x" fetchImpl={fetchImpl} jobPollMs={0} />)
    await waitFor(() => expect(screen.getByRole('radio', { name: UPDATE_CHANNEL_TITLES.hotfix })).toBeInTheDocument())
    await userEvent.click(screen.getByRole('radio', { name: UPDATE_CHANNEL_TITLES.hotfix }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('正在更新,装完再切通道'))
    expect(screen.getByRole('radio', { name: UPDATE_CHANNEL_TITLES.stable })).toBeChecked()
  })

  it('那一行小字:稳定版说演练过;热修说切回去不会退回旧版;热修跟着稳定版走时如实说', () => {
    expect(channelHintOf(checkView())).toContain('演练')
    expect(channelHintOf(checkView({ channel: 'hotfix' }))).toContain('不会退回')
    expect(channelHintOf(checkView({ channel: 'hotfix', channel_fallback: true }))).toBe(CHANNEL_FALLBACK_HINT)
    const { channel: _unknown, ...noChannel } = checkView()
    expect(channelHintOf(noChannel)).toBeUndefined()
  })
})
