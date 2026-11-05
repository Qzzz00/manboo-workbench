/**
 * 设置里的「我的设备」(2026-09-21)。三条:
 *   ① 账号还在本机时**整节不出现**(`on_server` 缺席 = 本机,一律 `=== true` 判);
 *   ② 列出来的每一行说得出类型与上次在线;
 *   ③ 移除要二次确认,确认了才真的发请求。
 * 2026-10-22 起照评审页:「我的设备」收在「工作台账号」那一节的折叠里,点开才列(也才去拉)。
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AccountPanel } from '../src/client/account/AccountPanel.tsx'
import { lastSeenText } from '../src/client/account/accountApi.ts'

afterEach(cleanup)

const DEVICES = [
  { device_id: 'mac-1', name: '我的 Mac', kind: 'mac', created_at: '2026-09-21T00:00:00.000Z', last_seen_at: '2026-09-21T03:00:00.000Z', current: true },
  { device_id: 'phone-1', name: '我的手机', kind: 'phone', created_at: '2026-09-21T01:00:00.000Z' },
]

/** 只认这两条路的假 fetch。回 `calls` 让用例看得到发生过什么。 */
function fakeFetch(devices = DEVICES) {
  const calls: string[] = []
  let current = devices
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push(`${init?.method ?? 'GET'} ${url}`)
    if (url.endsWith('/account/devices')) {
      return new Response(JSON.stringify({ devices: current }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.endsWith('/account/devices/revoke')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { device_id?: string }
      current = current.filter(d => d.device_id !== body.device_id)
      return new Response(JSON.stringify({ devices: current }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return { impl, calls }
}

describe('lastSeenText', () => {
  const now = Date.parse('2026-09-21T12:00:00.000Z')

  it('没上线过就说没上线过,不编一个时间出来', () => {
    expect(lastSeenText(undefined, now)).toBe('还没上线过')
    expect(lastSeenText('不是个时间', now)).toBe('还没上线过')
  })

  it('分钟 / 小时 / 天各说各的', () => {
    expect(lastSeenText('2026-09-21T11:59:30.000Z', now)).toBe('刚刚在线')
    expect(lastSeenText('2026-09-21T11:30:00.000Z', now)).toBe('30 分钟前')
    expect(lastSeenText('2026-09-21T06:00:00.000Z', now)).toBe('6 小时前')
    expect(lastSeenText('2026-09-18T12:00:00.000Z', now)).toBe('3 天前')
  })
})

describe('「我的设备」那一节', () => {
  it('账号还在本机时整节不出现', async () => {
    const { impl, calls } = fakeFetch()
    render(<AccountPanel baseUrl="http://x" fetchImpl={impl} view={{ registered: true, logged_in: true, username: 'ben' }} onChanged={() => {}} />)
    expect(screen.getByText(/只在这台机器上/)).toBeTruthy()
    expect(screen.queryByText('我的设备')).toBeNull()
    expect(calls).toHaveLength(0)
  })

  it('账号在服务器上时列出每一台,说得出类型、哪一台是自己、上次在线', async () => {
    const { impl } = fakeFetch()
    render(<AccountPanel baseUrl="http://x" fetchImpl={impl} view={{ registered: true, logged_in: true, username: 'ben', on_server: true }} onChanged={() => {}} />)
    expect(screen.getByText(/在工作台的服务器上/)).toBeTruthy()
    await userEvent.click(screen.getByText('我的设备'))
    await waitFor(() => { expect(screen.getByText('我的 Mac')).toBeTruthy() })
    expect(screen.getByText('我的手机')).toBeTruthy()
    const list = screen.getByLabelText('我的设备')
    expect(list.textContent).toContain('Mac')
    expect(list.textContent).toContain('这一台')
    expect(list.textContent).toContain('手机')
    expect(list.textContent).toContain('还没上线过')
  })

  it('移除要二次确认;点了取消就什么都不发', async () => {
    const { impl, calls } = fakeFetch()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<AccountPanel baseUrl="http://x" fetchImpl={impl} view={{ registered: true, logged_in: true, username: 'ben', on_server: true }} onChanged={() => {}} />)
    await userEvent.click(screen.getByText('我的设备'))
    await waitFor(() => { expect(screen.getByText('我的手机')).toBeTruthy() })
    await userEvent.click(screen.getAllByRole('button', { name: '移除' })[1] as HTMLElement)
    expect(calls.some(c => c.includes('revoke'))).toBe(false)
    confirm.mockRestore()
  })

  it('确认之后那一台就从列表里消失了', async () => {
    const { impl, calls } = fakeFetch()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<AccountPanel baseUrl="http://x" fetchImpl={impl} view={{ registered: true, logged_in: true, username: 'ben', on_server: true }} onChanged={() => {}} />)
    await userEvent.click(screen.getByText('我的设备'))
    await waitFor(() => { expect(screen.getByText('我的手机')).toBeTruthy() })
    await userEvent.click(screen.getAllByRole('button', { name: '移除' })[1] as HTMLElement)
    await waitFor(() => { expect(screen.queryByText('我的手机')).toBeNull() })
    expect(calls.some(c => c.includes('POST') && c.includes('revoke'))).toBe(true)
    confirm.mockRestore()
  })

  it('读不到时说一句为什么,而不是空着', async () => {
    const impl = (async () => new Response(JSON.stringify({ error: '还没登录账号,先登录再看设备列表。' }), {
      status: 503, headers: { 'content-type': 'application/json' },
    })) as typeof fetch
    render(<AccountPanel baseUrl="http://x" fetchImpl={impl} view={{ registered: true, logged_in: true, username: 'ben', on_server: true }} onChanged={() => {}} />)
    await userEvent.click(screen.getByText('我的设备'))
    await waitFor(() => { expect(screen.getByText('还没登录账号,先登录再看设备列表。')).toBeTruthy() })
  })
})
