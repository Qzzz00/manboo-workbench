/**
 * 电脑抽屉里那家的**权限弹窗**(2026-10-01,卡 AP「手机替她批准」;手机那一份见 butler-app/tests/sessionApprove.test.tsx)。
 *
 * 守:① 不摆输入框;② 读得了就去读,摆壳读到的原字(底下一句中文);③ 按下去走 `/asks/answer`、核实过才说批了;
 * ④ 读不到如实说 + 「再看一次」;旧壳照旧一句到电脑上点 +「去回答」;⑤ 打字撞上 → 切到按键。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionView } from '../src/protocol.ts'
import { SessionAsk } from '../src/client/SessionAsk.tsx'

afterEach(() => cleanup())

const BASE = 'http://127.0.0.1:8791'
const KEYS = [{ label: 'Allow once', does: 'once' }, { label: 'Deny', does: 'deny' }]

function stub(reply: (path: string, body: unknown) => unknown) {
  const calls: { path: string, body: unknown }[] = []
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    calls.push({ path: url.pathname, body })
    return new Response(JSON.stringify(reply(url.pathname, body)), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  return { impl, calls }
}

function approving(permission: NonNullable<SessionView['ask']>['permission'], patch: Partial<NonNullable<SessionView['ask']>> = {}): SessionView {
  return {
    agent: 'claude', session_id: 'h1', project: 'desktop-workbench', status: 'waiting', wait_reason: 'approval', title: '修手机横屏',
    elapsed_sec: 300, unread: false, updated_at: '2026-10-01T04:10:00.000Z',
    ask: {
      kind: 'approve', question: 'Claude 要跑一条命令,等你批准', since: '2026-10-01T04:10:00.000Z', by: 'form', reply: 'desk',
      where: '这一问得在电脑上的 Claude 里回答(它那边弹了个框等你点)', reveal: true,
      ...(permission === undefined ? {} : { permission }), ...patch,
    },
  }
}

describe('抽屉里的权限弹窗', () => {
  it('★读过了:摆那两颗键,不摆输入框;点「Allow once」→ /asks/answer → 回执', async () => {
    const { impl, calls } = stub(() => ({ ok: true, picked: 'Allow once', confirmed: true, note: '已替你批准了这一次(按的是「Allow once」)' }))
    const receipts: string[] = []
    render(<SessionAsk session={approving({ keys: KEYS as never })} baseUrl={BASE} fetchImpl={impl} onReceipt={t => receipts.push(t)} />)
    expect(screen.queryByLabelText('我自己说')).toBeNull()
    expect(screen.getByRole('button', { name: /Deny/ })).toHaveTextContent('不批')
    await userEvent.click(screen.getByRole('button', { name: /Allow once/ }))
    await waitFor(() => expect(receipts).toEqual(['已替你批准了这一次(按的是「Allow once」)']))
    expect(calls).toEqual([{ path: '/asks/answer', body: { key: 'session:claude/h1', choice: 'Allow once' } }])
  })

  it('★读得了:打开就去读,读到了摆键', async () => {
    const { impl, calls } = stub(() => ({ ok: true, keys: KEYS, held: ['Allow for this session'] }))
    render(<SessionAsk session={approving({ readable: true })} baseUrl={BASE} fetchImpl={impl} />)
    expect(await screen.findByRole('button', { name: /Allow once/ })).toBeInTheDocument()
    expect(calls[0]).toEqual({ path: '/sessions/approval/read', body: { agent: 'claude', session_id: 'h1' } })
    expect(screen.queryByRole('button', { name: /this session/ })).toBeNull()
  })

  it('★读不到:如实说 + 「再看一次」', async () => {
    const { impl, calls } = stub(() => ({ ok: false, where: 'desk', why: '这一问得在电脑上的 Claude 里回答(没在它窗口里认出这一步的批准弹窗)', reveal: true }))
    render(<SessionAsk session={approving({ readable: true })} baseUrl={BASE} fetchImpl={impl} />)
    expect(await screen.findByText('这一问得在电脑上的 Claude 里回答(没在它窗口里认出这一步的批准弹窗)')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '再看一次' }))
    await waitFor(() => expect(calls.length).toBe(2))
  })

  it('★旧壳:不摆输入框,一句到电脑上点 + 「去回答」', () => {
    render(<SessionAsk session={approving({})} baseUrl={BASE} fetchImpl={stub(() => ({})).impl} />)
    expect(screen.queryByLabelText('我自己说')).toBeNull()
    expect(screen.getByText('这一问得在电脑上的 Claude 里回答(它那边弹了个框等你点)')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '去回答' })).toBeInTheDocument()
  })

  it('★打字撞上(老版工作台没给 permission):收起输入框,去读键', async () => {
    const { impl } = stub(path => path === '/sessions/answer'
      ? { ok: false, where: 'desk', why: '这是权限弹窗,打字批不了它 —— 点「批准」或「拒绝」那颗键', reveal: true, permission: true }
      : { ok: true, keys: KEYS })
    const old = approving(undefined, { reply: 'window' })
    delete (old.ask as { where?: string }).where
    render(<SessionAsk session={old} baseUrl={BASE} fetchImpl={impl} />)
    await userEvent.type(screen.getByLabelText('我自己说'), '可以')
    await userEvent.click(screen.getByRole('button', { name: '回复' }))
    expect(await screen.findByRole('button', { name: /Allow once/ })).toBeInTheDocument()
    expect(screen.queryByLabelText('我自己说')).toBeNull()
    expect(screen.getByText('这是权限弹窗,打字批不了它 —— 点「批准」或「拒绝」那颗键')).toBeInTheDocument()
  })
})
