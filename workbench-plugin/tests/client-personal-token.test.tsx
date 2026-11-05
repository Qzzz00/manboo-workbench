import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import type { PersonalTokenView } from '../src/protocol.ts'
import { PersonalTokenPanel } from '../src/client/PersonalTokenPanel.tsx'

afterEach(cleanup)

function fake(initial: PersonalTokenView[]) {
  const calls: { path: string, body?: unknown }[] = []
  let tokens = [...initial]
  const impl = (async (input: string, init?: RequestInit) => {
    const path = new URL(input).pathname
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body)) as Record<string, string>
    calls.push({ path, body })
    if (path === '/token/personal/issue') {
      const view = { id: `pat-${tokens.length + 1}`, purpose: String(body?.purpose), hint: 'wbp_abcd', created_at: '2026-10-21T09:00:00.000Z' }
      tokens = [...tokens, view]
      return new Response(JSON.stringify({ ok: true, token: 'wbp_abcdef', view, tokens }))
    }
    if (path === '/token/personal/revoke') { tokens = tokens.filter(one => one.id !== body?.id); return new Response(JSON.stringify({ ok: true, tokens })) }
    return new Response(JSON.stringify({ tokens }))
  }) as typeof fetch
  return { calls, impl }
}

describe('设置里的个人访问令牌(多枚,先写用途)', () => {
  it('不写用途发不了;写了 → 明文只在这一下摆出来,列表多一行', async () => {
    const user = userEvent.setup()
    const f = fake([])
    render(<PersonalTokenPanel baseUrl="http://127.0.0.1:8791" fetchImpl={f.impl} />)
    expect(await screen.findByText('还没发过。')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '发一枚' })).toBeDisabled()
    await user.type(screen.getByLabelText('用途'), '本机脚本')
    await user.click(screen.getByRole('button', { name: '发一枚' }))
    expect(await screen.findByLabelText('刚发的令牌')).toHaveTextContent('wbp_abcdef')
    expect(f.calls.find(one => one.path === '/token/personal/issue')?.body).toEqual({ purpose: '本机脚本' })
    expect(within(screen.getByRole('list', { name: '已发的令牌' })).getByText('本机脚本')).toBeInTheDocument()
  })
  it('列表:用途、开头、上次用的时间;撤销一枚', async () => {
    const user = userEvent.setup()
    const f = fake([{ id: 'pat-1', purpose: 'Codex 读板', hint: 'wbp_old0', created_at: '2026-10-20T09:00:00.000Z', last_used_at: '2026-10-21T08:00:00.000Z' }])
    render(<PersonalTokenPanel baseUrl="http://127.0.0.1:8791" fetchImpl={f.impl} />)
    expect(await screen.findByText(/上次用 2026-10-21 08:00/)).toBeInTheDocument()
    expect(screen.queryByLabelText('刚发的令牌')).toBeNull()
    await user.click(screen.getByRole('button', { name: '撤销 Codex 读板' }))
    expect(await screen.findByText(/撤了/)).toBeInTheDocument()
    expect(f.calls.find(one => one.path === '/token/personal/revoke')?.body).toEqual({ id: 'pat-1' })
    expect(screen.getByText('还没发过。')).toBeInTheDocument()
  })
  it('没接(404)整节不出现', async () => {
    const impl = (async () => new Response('{}', { status: 404 })) as typeof fetch
    const { container } = render(<PersonalTokenPanel baseUrl="http://x" fetchImpl={impl} />)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(container).toBeEmptyDOMElement()
  })
})
