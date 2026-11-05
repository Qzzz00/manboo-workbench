// 悬浮窗 say 挂住与超时(2026-10-28 卡)的客户端一半(用例 1):
// say 请求挂着不回 → 90 秒后发送键复原、草稿还在、回执「这句还在办,办完我说」;
// 回包晚到了(同一个 say_id)→ 回话补上、不重复发;她已发第二句时,第一句的晚到回包不盖第二句。
import '@testing-library/jest-dom/vitest'
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ButlerInbox, SAY_CLIENT_TIMEOUT_MS, SAY_STILL_WORKING } from '../src/client/ButlerInbox.tsx'
import type { WorkbenchState } from '../src/protocol.ts'

const state: WorkbenchState = { agents: [], sessions: [], quota: {}, now: '2026-10-28T00:00:00Z', stale: false }
const controls = { paused: false, testRinging: false, proposals: [], onPause() {}, onTestRing() {}, onCancelWatch() {}, onDismissBrief() {} }

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function App({ fetchImpl }: { fetchImpl: typeof fetch }) {
  const [draft, setDraft] = useState('')
  return <ButlerInbox state={state} controls={controls} fetchImpl={fetchImpl} baseUrl="http://127.0.0.1:9" draft={draft} onDraftChange={setDraft} visible onOpenConversation={() => {}} />
}

/** 只挡 /butler/say:每次调用发一个手控的 deferred,别的口(外观同步等)照常用空响。 */
function sayGate() {
  const says: ReturnType<typeof deferred<Response>>[] = []
  const fetchImpl = vi.fn((url: unknown) => {
    if (String(url).endsWith('/butler/say')) {
      const d = deferred<Response>()
      says.push(d)
      return d.promise
    }
    return Promise.resolve(new Response('{}', { status: 200 }))
  }) as unknown as typeof fetch
  return { fetchImpl, says }
}

const response = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }) })
afterEach(() => { vi.useRealTimers(); cleanup() })

describe('悬浮窗 say 超时(卡:客户端 90 秒上限)', () => {
  it('挂着不回 → 90 秒后键复原、草稿还在、回执说还在办;回包到了补上,不重复发', async () => {
    const { fetchImpl, says } = sayGate()
    const view = render(<App fetchImpl={fetchImpl} />)
    const input = screen.getByLabelText('交给事务官一件事')
    fireEvent.change(input, { target: { value: '让小K查一下 8791 空转' } })
    const btn = screen.getByRole('button', { name: '交给事务官' })
    fireEvent.click(btn)
    // 在路上:键灰着、请求已发出一次。
    expect(btn).toBeDisabled()
    expect(says).toHaveLength(1)
    // 90 秒到点:键复原、草稿还在、回执如实说还在办。
    await act(async () => { await vi.advanceTimersByTimeAsync(SAY_CLIENT_TIMEOUT_MS) })
    expect(btn).toBeEnabled()
    expect(input).toHaveValue('让小K查一下 8791 空转')
    expect(view.container.querySelector('.ben-wb__items-receipt')).toHaveTextContent(SAY_STILL_WORKING)
    // 回包这时才到(同一个 say_id):回话补上、不重复发。
    await act(async () => {
      says[0]!.resolve(response({ say_id: 'say-1', say: { screen: '派好了,小K 在查' }, items: [{ kind: '办', title: '查 8791 空转', status: 'done' }] }))
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    })
    expect(view.container.querySelector('.ben-wb__say-line')).toHaveTextContent('派好了,小K 在查')
    expect(view.container.querySelector('.ben-wb__items-receipt')).toBeNull()
    expect(says).toHaveLength(1)
  })

  it('到点后第二句照常发;第一句晚到的回包不盖第二句的回话', async () => {
    const { fetchImpl, says } = sayGate()
    const view = render(<App fetchImpl={fetchImpl} />)
    const input = screen.getByLabelText('交给事务官一件事')
    // 第一句:挂着不回,到点。
    fireEvent.change(input, { target: { value: '第一句' } })
    fireEvent.click(screen.getByRole('button', { name: '交给事务官' }))
    await act(async () => { await vi.advanceTimersByTimeAsync(SAY_CLIENT_TIMEOUT_MS) })
    expect(view.container.querySelector('.ben-wb__items-receipt')).toHaveTextContent(SAY_STILL_WORKING)
    // 第二句:照常发得出去(键已复原)。
    fireEvent.change(input, { target: { value: '第二句' } })
    const btn2 = screen.getByRole('button', { name: '交给事务官' })
    fireEvent.click(btn2)
    expect(btn2).toBeDisabled()
    expect(says).toHaveLength(2)
    // 第一句的回包这时才到:不盖第二句(第二句还在路上,回执不变成第一句的结果)。
    await act(async () => {
      says[0]!.resolve(response({ say_id: 'say-1', say: { screen: '第一句办好了' }, items: [{ kind: '办', title: '一', status: 'done' }] }))
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    })
    expect(view.container.querySelector('.ben-wb__say-line')).toBeNull()
    // 第二句的回包到了:摆第二句那一句。
    await act(async () => {
      says[1]!.resolve(response({ say_id: 'say-2', say: { screen: '第二句办好了' }, items: [{ kind: '办', title: '二', status: 'done' }] }))
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    })
    expect(view.container.querySelector('.ben-wb__say-line')).toHaveTextContent('第二句办好了')
    expect(screen.queryByText('第一句办好了')).toBeNull()
    // 第二句办成了清框;她给第二句打的字没被第一句的晚到回包清掉(已在第二句发送时清过,这里保持空)。
    expect(input).toHaveValue('')
  })
})
