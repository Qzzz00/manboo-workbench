/**
 * 体检页「出错怎么让人知道」里那颗「发诊断包」(2026-10-21,内测发版底座)。
 *
 * 按下去:在打包、在传 → 编号(把它发给统筹)。传不上去:原样说为什么,并说包留在电脑哪儿。
 * 与手机设置里那颗是同一条路(`POST /diag/send` 起作业、`GET /diag/send` 看结果)。
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'

import { SetupPage } from '../src/client/setup/SetupPage.tsx'
import type { DiagSendView } from '../src/diag.ts'
import type { WorkbenchState } from '../src/protocol.ts'

afterEach(cleanup)

const STATE = { sessions: [], quota: {} } as unknown as WorkbenchState
const RUNNING: DiagSendView = { id: 'send-1', state: 'running', started_at: '2026-10-21T02:00:00.000Z' }

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function harness(finalView: DiagSendView) {
  const calls: { url: string, method: string }[] = []
  let gets = 0
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    calls.push({ url, method })
    if (url.endsWith('/diag/settings')) return reply({ report_enabled: true, notice_seen: true, sent_this_hour: 0, hourly_limit: 20 })
    if (url.endsWith('/diag/send') && method === 'POST') return reply(RUNNING)
    if (url.endsWith('/diag/send')) {
      gets += 1
      return reply(gets < 2 ? RUNNING : finalView)
    }
    if (url.endsWith('/setup/status')) return reply({ items: [], all_ok: true, optional_pending: 0, checked_at: '2026-10-21T02:00:00Z' })
    if (url.endsWith('/setup/apk.json')) return reply({ available: false, path: '' })
    return reply({}, 404)
  }) as unknown as typeof fetch
  render(<SetupPage baseUrl="http://127.0.0.1:8791" fetchImpl={fetchImpl} state={STATE} onClose={() => {}} jobPollMs={5} />)
  return { calls }
}

describe('发诊断包', () => {
  it('★按下去 → 在打包、在传 → 编号,并说把它发给统筹、几天后自动删', async () => {
    const h = harness({ ...RUNNING, state: 'done', code: '7KQ2MX', expires_at: '2026-10-28T02:00:00.000Z', bytes: 240_000 })
    await userEvent.click(await screen.findByRole('button', { name: '发诊断包' }))
    const box = await screen.findByLabelText('发诊断包')
    await waitFor(() => expect(box).toHaveTextContent('7KQ2MX'))
    expect(box).toHaveTextContent('发给统筹')
    expect(box).toHaveTextContent('7 天')
    expect(h.calls.filter(call => call.url.endsWith('/diag/send') && call.method === 'POST')).toHaveLength(1)
  })

  it('★传不上去:原样说为什么,并说包留在电脑哪儿(微信发也行)', async () => {
    harness({
      ...RUNNING,
      state: 'failed',
      error: '连不上服务器,诊断包传不上去(多半是这会儿没网)。',
      kept: { file: '/Users/example/Desktop/工作台诊断包-20261021-100000.zip', file_redacted: '/Users/<用户>/Desktop/工作台诊断包-20261021-100000.zip', name: '工作台诊断包-20261021-100000.zip' },
    })
    await userEvent.click(await screen.findByRole('button', { name: '发诊断包' }))
    const box = await screen.findByLabelText('发诊断包')
    await waitFor(() => expect(box).toHaveTextContent('传不上去'))
    expect(box).toHaveTextContent('/Users/example/Desktop/工作台诊断包-20261021-100000.zip')
    expect(box).toHaveTextContent('微信')
  })
})
