/**
 * 窗口槽里「还没拉进来」的那几格(2026-09-25,卡 fix/quota-and-slot-apps)。
 *
 * 维护者 09-24 引导 ④ 说「你刚刚讲那几个都放进去」(Claude、Codex、Kimi、微信、企业微信),
 * 窗口槽却一个标签都没有。断言写的是他在屏幕上看得到什么、点下去发生什么:
 *   ① 五个标签都在,没拉进来的写「点一下拉进来」;
 *   ② 点一下 = POST /dock/claim {app};拉的那几秒写「正在拉…」;
 *   ③ 那一格的 ✕ = 不要这个标签了(POST /apps/remove),不是"放出";
 *   ④ 认领了的照旧是正常标签,排在前面。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DockTabBar } from '../src/client/DockTabBar.tsx'
import { emptyStateFor } from '../src/client/emptyState.ts'

afterEach(cleanup)

const FIVE = [
  { key: 'claude', label: 'Claude' },
  { key: 'codex', label: 'Codex' },
  { key: 'kimi', label: 'Kimi' },
  { key: 'wechat', label: '微信' },
  { key: 'wecom', label: '企业微信' },
]

function recordingFetch() {
  const calls: { url: string, body: unknown }[] = []
  let release: (() => void) | undefined
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined })
    // /dock/claim 挂住,好看见「正在拉…」;测试里手动放行。
    if (String(input).endsWith('/dock/claim')) await new Promise<void>((resolve) => { release = resolve })
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  return { calls, impl, release: () => release?.() }
}

function bar(dock: Parameters<typeof DockTabBar>[0]['dock'], fetchImpl: typeof fetch = vi.fn() as unknown as typeof fetch) {
  return render(
    <DockTabBar dock={dock} sessions={[]} badges={{}} baseUrl="http://x" fetchImpl={fetchImpl} butlerActive onSelectButler={() => {}} />,
  )
}

describe('窗口槽:他要的五家都有标签', () => {
  it('★叠是空的、五家都在 pending → 五个标签,每个写着「点一下拉进来」', () => {
    bar({ stack: [], pending: FIVE })
    for (const { label } of FIVE) {
      expect(screen.getByRole('button', { name: `${label}:点一下拉进来` })).toBeInTheDocument()
    }
    expect(screen.getAllByText('点一下拉进来')).toHaveLength(5)
  })

  it('认领了的是正常标签(排在前面、能放出);没拉进来的跟在后面', () => {
    bar({
      stack: [{ key: 'claude', label: 'Claude', current: false, running: true }],
      pending: FIVE.slice(1),
    })
    const names = screen.getAllByRole('button').map(button => button.getAttribute('aria-label') ?? button.textContent)
    expect(names.indexOf('Claude')).toBeLessThan(names.indexOf('Codex:点一下拉进来'))
    expect(screen.getByRole('button', { name: '放出 Claude' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Claude:点一下拉进来' })).toBeNull()
  })

  it('★点一下 = POST /dock/claim {app};拉的那几秒写「正在拉…」,回来之后以服务端为准', async () => {
    const fetchImpl = recordingFetch()
    bar({ stack: [], pending: FIVE }, fetchImpl.impl)
    fireEvent.click(screen.getByRole('button', { name: '微信:点一下拉进来' }))
    expect(fetchImpl.calls).toEqual([{ url: 'http://x/dock/claim', body: { app: 'wechat' } }])
    expect(await screen.findByText('正在拉…')).toBeInTheDocument()
    fetchImpl.release()
    await waitFor(() => expect(screen.queryByText('正在拉…')).toBeNull())
  })

  it('那一格的 ✕ = 不要这个标签了(POST /apps/remove),不是「放出」', () => {
    const fetchImpl = recordingFetch()
    bar({ stack: [], pending: FIVE }, fetchImpl.impl)
    fireEvent.click(screen.getByRole('button', { name: '从窗口槽拿掉 企业微信' }))
    expect(fetchImpl.calls).toEqual([{ url: 'http://x/apps/remove', body: { key: 'wecom' } }])
  })

  it('没有 pending(老服务端 / enabled 是空的)→ 跟这一版之前一模一样,一个虚标签都没有', () => {
    bar({ stack: [{ key: 'claude', label: 'Claude', current: true, running: true }] })
    expect(screen.queryByText('点一下拉进来')).toBeNull()
  })
})

describe('窗口槽空着时那一句话', () => {
  it('有「点一下拉进来」的标签 → 先指那条一步就到的路;没有 → 照旧说拖进来', () => {
    expect(emptyStateFor('slot', { dock: { stack: [], pending: FIVE } })?.line).toContain('点一下就把那家的窗拉进来')
    expect(emptyStateFor('slot', { dock: { stack: [] } })?.line).toBe('把常用的应用从屏幕上拖进这块槽里,它就会出现在这排标签里。')
    // 拉进来一家之后空态就退场(槽里有窗了)。
    expect(emptyStateFor('slot', { dock: { stack: [{}], pending: FIVE.slice(1) } })).toBeUndefined()
  })
})
