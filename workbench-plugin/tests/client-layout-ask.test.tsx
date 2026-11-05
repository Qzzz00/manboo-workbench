/**
 * 「我把 X 挪到 Y,对吗?」那张确认卡(2026-09-22「用自然语言改布局」)。
 *
 * 钉的是**那道门**:在他按下「就这样」之前,一条请求都不发;按下之后发的是
 * `/layout/confirm`,按「不动」发的是 `/layout/cancel`。两颗按钮的字是 Ben 定的那两个词。
 */
import { cleanup, render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import type { LayoutAskView } from '../src/protocol.ts'
import { LayoutAsk } from '../src/client/LayoutAsk.tsx'

afterEach(cleanup)

const ASK: LayoutAskView = {
  id: 'ask-1',
  request: '把消耗数据挪到项目区下面',
  restate: '我把「消耗数据」挪到右侧栏、「项目区」下面,对吗?',
  orientation: 'landscape',
  actions: [{ kind: 'region', module: 'usage', region: 'side' }],
  created_at: '2026-09-22T02:00:00.000Z',
}

function stub(reply: { ok?: boolean, error?: string } = { ok: true }) {
  const calls: { path: string, body: unknown }[] = []
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      path: new URL(String(input)).pathname,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined,
    })
    return new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  return { impl, calls }
}

describe('待确认的布局改动', () => {
  it('卡上原样写着复述那一句,两颗按钮是「就这样」/「不动」', () => {
    const net = stub()
    render(<LayoutAsk ask={ASK} baseUrl="http://x" fetchImpl={net.impl} />)
    expect(screen.getByText(ASK.restate)).toBeTruthy()
    expect(screen.getByRole('button', { name: '就这样' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '不动' })).toBeTruthy()
  })

  it('**渲染出来的那一刻一条请求都没发**(这道门是人做的)', () => {
    const net = stub()
    render(<LayoutAsk ask={ASK} baseUrl="http://x" fetchImpl={net.impl} />)
    expect(net.calls).toEqual([])
  })

  it('点「就这样」→ POST /layout/confirm,带上这条的 id', async () => {
    const net = stub()
    render(<LayoutAsk ask={ASK} baseUrl="http://x" fetchImpl={net.impl} />)
    await userEvent.click(screen.getByRole('button', { name: '就这样' }))
    expect(net.calls).toHaveLength(1)
    expect(net.calls[0]?.path).toBe('/layout/confirm')
    expect(net.calls[0]?.body).toEqual({ id: 'ask-1' })
  })

  it('点「不动」→ POST /layout/cancel', async () => {
    const net = stub()
    render(<LayoutAsk ask={ASK} baseUrl="http://x" fetchImpl={net.impl} />)
    await userEvent.click(screen.getByRole('button', { name: '不动' }))
    expect(net.calls[0]?.path).toBe('/layout/cancel')
  })

  it('说的是哪一版布局,卡上写着', () => {
    const net = stub()
    render(<LayoutAsk ask={ASK} baseUrl="http://x" fetchImpl={net.impl} />)
    expect(screen.getByText('(说的是横屏这一版布局)')).toBeTruthy()
    cleanup()
    render(<LayoutAsk ask={{ ...ASK, orientation: 'portrait' }} baseUrl="http://x" fetchImpl={net.impl} />)
    expect(screen.getByText('(说的是竖屏这一版布局)')).toBeTruthy()
  })

  it('服务端说没办成 → 原样把那句话摆出来,卡还在(他能再点一次)', async () => {
    const net = stub({ ok: false, error: '此刻读不到布局,没改。' })
    render(<LayoutAsk ask={ASK} baseUrl="http://x" fetchImpl={net.impl} />)
    await userEvent.click(screen.getByRole('button', { name: '就这样' }))
    expect((await screen.findByRole('alert')).textContent).toBe('此刻读不到布局,没改。')
    expect(screen.getByRole('button', { name: '就这样' })).toBeTruthy()
  })

  it('服务没应答 → 如实说"布局一格没动"', async () => {
    const impl = (async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch
    render(<LayoutAsk ask={ASK} baseUrl="http://x" fetchImpl={impl} />)
    await userEvent.click(screen.getByRole('button', { name: '就这样' }))
    expect((await screen.findByRole('alert')).textContent).toContain('一格没动')
  })
})
