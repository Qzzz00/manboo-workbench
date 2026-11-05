/**
 * 设置里「派活与办完提醒」那一节(2026-10-23,卡「分层第二刀一」前两条)。
 *
 * 钉这几件:
 *   ① 没接偏好(404)→ 整节不出现;
 *   ② 两行:办完要告诉你的事(勾着的几类顿号连)/ 在电脑上动手的活(开或关);
 *   ③ 改勾打 `POST /dispatch/prefs` 带整组 tell_scope;开关那一颗只带 auto_desk;
 *   ④ 一个都没勾:副行如实写「先都不提醒」。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, configure, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { DispatchPrefsPanel, tellScopeLine } from '../src/client/DispatchPrefsPanel.tsx'
import { DISPATCH_PREFS_DEFAULT } from '../src/protocol.ts'

configure({ asyncUtilTimeout: 5_000 })
afterEach(() => { cleanup() })

/** 一台假服务:记下每一次 POST,GET 回当前那份偏好。 */
function fakeServer(initial: typeof DISPATCH_PREFS_DEFAULT | null) {
  let prefs = initial
  const posts: { path: string, body: Record<string, unknown> }[] = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const path = url.replace('http://wb', '')
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      posts.push({ path, body })
      return new Response(JSON.stringify({ ok: true, ...prefs }), { status: 200 })
    }
    if (prefs === null) return new Response(JSON.stringify({ error: '偏好未启用' }), { status: 404 })
    return new Response(JSON.stringify(prefs), { status: 200 })
  }) as typeof fetch
  return { fetchImpl, posts }
}

describe('派活与办完提醒', () => {
  it('① 没接偏好 → 整节不出现', async () => {
    const { fetchImpl } = fakeServer(null)
    const { container } = render(<DispatchPrefsPanel baseUrl="http://wb" fetchImpl={fetchImpl} />)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(container.querySelector('.ben-wb__dispatch-prefs')).toBeNull()
    expect(container.textContent ?? '').not.toContain('派活与办完提醒')
  })

  it('② 两行:范围那一行勾着的顿号连;开关那一行照 auto_desk 说', async () => {
    const { fetchImpl } = fakeServer({ ...DISPATCH_PREFS_DEFAULT, auto_desk: true })
    render(<DispatchPrefsPanel baseUrl="http://wb" fetchImpl={fetchImpl} />)
    expect(await screen.findByText('办完要告诉你的事')).toBeInTheDocument()
    expect(screen.getByText('交办、会议、例程')).toBeInTheDocument()
    expect(screen.getByText('在电脑上动手的活')).toBeInTheDocument()
    expect(screen.getByText('交代了不问就派')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '关' })).toBeInTheDocument()
  })

  it('③ 改勾:打 POST /dispatch/prefs 带整组 tell_scope;开关那一颗只带 auto_desk', async () => {
    const { fetchImpl, posts } = fakeServer(DISPATCH_PREFS_DEFAULT)
    const user = userEvent.setup()
    render(<DispatchPrefsPanel baseUrl="http://wb" fetchImpl={fetchImpl} />)
    await screen.findByText('办完要告诉你的事')

    await user.click(screen.getByRole('button', { name: '改' }))
    await user.click(screen.getByLabelText('办完提醒:派活'))
    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(posts).toContainEqual({
      path: '/dispatch/prefs',
      body: { tell_scope: { mine: true, dispatch: true, meeting: true, routine: true } },
    }))

    await user.click(screen.getByRole('button', { name: '开' }))
    await waitFor(() => expect(posts).toContainEqual({ path: '/dispatch/prefs', body: { auto_desk: true } }))
  })

  it('④ 一个都没勾:副行写「先都不提醒」;副行那一句的字', () => {
    expect(tellScopeLine({ mine: false, dispatch: false, meeting: false, routine: false })).toBe('先都不提醒')
    expect(tellScopeLine({ mine: true, dispatch: false, meeting: false, routine: true })).toBe('交办、例程')
  })
})
