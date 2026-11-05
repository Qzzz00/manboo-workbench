// 浮窗「事务官处理结果」(2026-10-27,维护者在装机版 0.4.161 撞到:盖住、滑不动、关不掉;统筹定按 A 并进「浮窗四样」)。
// 已经处理完、不要你再点的结果:收成「最近结果」那一处的一行,能看详情、能标为已读;不再单独占一块挤掉滚动区。
// 还要你点的(确认、改选、建议)照旧摆在输入框上方。
import '@testing-library/jest-dom/vitest'
import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ButlerInbox } from '../src/client/ButlerInbox.tsx'
import type { WorkbenchState } from '../src/protocol.ts'
import { sayNeedsAction, sayResultLine, type SayCardPayload } from '../src/client/sayCards.ts'

const state: WorkbenchState = { agents: [], sessions: [], quota: {}, now: '2026-10-27T00:00:00Z', stale: false }
const controls = { paused: false, testRinging: false, proposals: [], onPause() {}, onTestRing() {}, onCancelWatch() {}, onDismissBrief() {} }
const response = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
const handled = (id: string, items: NonNullable<SayCardPayload['items']>): SayCardPayload => ({ say_id: id, say: { screen: `${id}办好了` }, items })
function App({ fetchImpl }: { fetchImpl: typeof fetch }) {
  const [draft, setDraft] = useState('')
  return <ButlerInbox state={state} controls={controls} fetchImpl={fetchImpl} baseUrl="http://127.0.0.1:9" draft={draft} onDraftChange={setDraft} visible onOpenConversation={() => {}} />
}
async function send(text: string) {
  fireEvent.change(screen.getByLabelText('交给事务官一件事'), { target: { value: text } })
  fireEvent.click(screen.getByRole('button', { name: '交给事务官' }))
  await screen.findByText(`${text}办好了`)
}
afterEach(cleanup)

describe('处理结果的判据(纯函数)', () => {
  it('只有确认、改选、建议算「还要你点」;只报处理结果的不算', () => {
    expect(sayNeedsAction(handled('A', [{ title: '整理', status: 'done' }]))).toBe(false)
    expect(sayNeedsAction({ ask: { ask_id: 'a', question: '?' } })).toBe(true)
    expect(sayNeedsAction({ asks: [{ ask_id: 'a', question: '?' }] })).toBe(true)
    expect(sayNeedsAction({ hold: { hold_id: 'h', reason: 'x', question: '?' } })).toBe(true)
    expect(sayNeedsAction({ suggest: { suggest_id: 's', line: 'l', default_action: 'keep', options: [] } })).toBe(true)
    expect(sayNeedsAction({ decided: [{ decided_id: 'd', item_index: 0, field: 'who', chosen: 'c', why: 'w', alternatives: [] }] })).toBe(true)
  })
  it('一行里照服务端那一句,数几件、失败几件照每件状态数,不编', () => {
    expect(sayResultLine(handled('A', [{ status: 'done' }, { status: 'done' }]))).toEqual({ screen: 'A办好了', count: '刚处理 2 件' })
    expect(sayResultLine(handled('A', [{ status: 'done' }, { status: 'failed' }]))).toEqual({ screen: 'A办好了', count: '刚处理 2 件 · 1 件失败' })
    expect(sayResultLine({ say: { screen: '记下了' } })).toEqual({ screen: '记下了' })
  })
})

describe('浮窗里处理完的结果收成一行', () => {
  it('不再单独占一块:输入框上方没有结果块,「最近结果」那一处是一行', async () => {
    const fetchImpl = (async () => response(handled('A', [{ title: '资料整理', status: 'done' }, { title: '派给 Kimi', status: 'done' }]))) as typeof fetch
    const view = render(<App fetchImpl={fetchImpl} />)
    await send('A')
    expect(view.container.querySelector('.ben-wb__say-cards')).toBeNull()
    const line = view.container.querySelector('.ben-wb__items-center .ben-wb__say-line')
    expect(line).not.toBeNull()
    expect(line).toHaveTextContent('刚处理 2 件')
  })
  it('看详情在滚动区里摊开,能收起', async () => {
    const fetchImpl = (async () => response(handled('A', [{ title: '资料整理', status: 'done' }]))) as typeof fetch
    const view = render(<App fetchImpl={fetchImpl} />)
    await send('A')
    fireEvent.click(screen.getByRole('button', { name: '看详情' }))
    const cards = view.container.querySelector('.ben-wb__say-cards')
    expect(cards).not.toBeNull()
    expect(cards!.closest('.ben-wb__scene-below')).not.toBeNull()
    expect(cards).toHaveTextContent('资料整理 · 已处理')
    expect(cards).not.toHaveTextContent('A办好了')
    fireEvent.click(screen.getByRole('button', { name: '收起详情' }))
    expect(view.container.querySelector('.ben-wb__say-cards')).toBeNull()
  })
  it('标为已读后不占位,下次交代出新的一行', async () => {
    let n = 0
    const fetchImpl = (async () => response(handled(n++ === 0 ? 'A' : 'B', [{ title: '一件', status: 'done' }]))) as typeof fetch
    const view = render(<App fetchImpl={fetchImpl} />)
    await send('A')
    fireEvent.click(screen.getByRole('button', { name: '标为已读' }))
    expect(view.container.querySelector('.ben-wb__say-line')).toBeNull()
    expect(view.container.querySelector('.ben-wb__say-cards')).toBeNull()
    await send('B')
    expect(view.container.querySelector('.ben-wb__say-line')).toHaveTextContent('B办好了')
  })
  it('还要你点的照旧在输入框上方,按钮可点', async () => {
    const fetchImpl = (async () => response({ say_id: 'A', say: { screen: 'A办好了' }, ask: { ask_id: 'ask-A', question: 'A确认吗' } })) as typeof fetch
    const view = render(<App fetchImpl={fetchImpl} />)
    await send('A')
    const cards = view.container.querySelector('.ben-wb__say-cards')
    expect(cards).not.toBeNull()
    expect(cards!.closest('.ben-wb__scene-below')).toBeNull()
    expect(screen.getByRole('button', { name: '确认' })).toBeEnabled()
    expect(view.container.querySelector('.ben-wb__say-line')).toBeNull()
  })
})
