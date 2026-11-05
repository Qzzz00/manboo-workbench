/**
 * 电脑上那张批准卡也要一眼看清(2026-09-28,卡 UX)。与手机同一句字(src/waiting.ts 的 dispatchApprovalFace)。
 *
 * 维护者 09-28 在手机上点了「允许这一次」,批出去的是另一件事 —— 根因是那张卡的正文是一整面各家额度,
 * 「哪件事、派给谁」只在最上面一小行灰字。电脑端是同一张卡的同一套内容,所以一起改。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import type { PendingApprovalView } from '../src/protocol.ts'
import { ApprovalAsk } from '../src/client/ApprovalAsk.tsx'

afterEach(() => cleanup())

const DISPATCH: PendingApprovalView = {
  id: 'a-1',
  session_id: 'dispatch:t-9',
  task_id: 't-9',
  task_title: '验证自我迭代能力',
  tool: '派给 Claude(本周还剩约 28%)',
  say: '派给 Claude(本周还剩约 28%)',
  at: '2026-09-28T02:00:00.000Z',
  options: [
    { family: 'claude', title: 'Claude', quota: '本周还剩约 28%', chosen: true },
    { family: 'codex', title: 'Codex', quota: '5 小时窗口还剩约 46%' },
    { family: 'doubao', title: '豆包办公', quota: '当前时段已用 99%' },
  ],
}

const fetchImpl = (async () => new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch

describe('派活那张批准卡:大字写着哪件事、派给谁;额度收起', () => {
  it('第一行是这一问;「允许」带着对象;别家收成一行,展开才看额度', async () => {
    render(<ApprovalAsk approval={DISPATCH} baseUrl="http://127.0.0.1:8791" fetchImpl={fetchImpl} />)
    expect(screen.getByText('把「验证自我迭代能力」派给 Claude?')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '允许派给 Claude' })).toBeInTheDocument()
    // 这次问的那一家在卡上,别家的额度默认不在。
    expect(screen.getByLabelText('这次问的那一家')).toHaveTextContent('本周还剩约 28%')
    expect(screen.queryByText('5 小时窗口还剩约 46%')).not.toBeInTheDocument()
    expect(screen.getByText(/其他可选:Codex \/ 豆包办公/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '展开看额度' }))
    expect(screen.getByLabelText('能派给的几家')).toHaveTextContent('5 小时窗口还剩约 46%')
  })

  it('不是派活那一问的:一个字没变(那句人话 + 「允许这一次」)', () => {
    render(<ApprovalAsk
      approval={{ id: 'a-2', session_id: 's-1', tool: 'bash', say: '要开一个看不见的浏览器,把页面截下来看', at: '2026-09-28T02:00:00.000Z' }}
      baseUrl="http://127.0.0.1:8791"
      fetchImpl={fetchImpl}
    />)
    expect(screen.getByText('要开一个看不见的浏览器,把页面截下来看')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '允许这一次' })).toBeInTheDocument()
    expect(screen.queryByText(/其他可选/)).not.toBeInTheDocument()
  })
})
