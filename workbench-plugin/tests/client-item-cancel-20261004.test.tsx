/**
 * ★ 2026-10-04「取消事项」(运营同学交回的那一版,维护者当天合入)。
 *
 * 规矩三条:
 *
 * ① **每一件非终态事项**都有这一颗 —— 「非终态」= 不是 `done`、不是 `canceled`;
 * ② 走**现成那一条**改状态的路:`POST /task/move {id, status:'canceled'}`(状态只在那一条路上改);
 * ③ 取消后**记录保留** —— 服务端把它挪进「已取消」,不删(这一份只钉客户端发了什么)。
 *
 * 样式上**不给它自己的配色**(维护者:不要那个红色调,也不要紫),所以这里顺手钉一条:
 * 它身上没有 class(用的是这一排按钮现成那一套)。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { ItemControls } from '../src/client/ItemControls.tsx'
import type { TaskView } from '../src/protocol.ts'

afterEach(cleanup)

function task(patch: Partial<TaskView>): TaskView {
  return { id: 't-1', title: '写一条小红书', status: 'doing', direction: 'mine', source: { kind: 'manual' }, created_at: '', updated_at: '', ...patch }
}

function fakeServer() {
  const posts: { path: string, body: Record<string, unknown> }[] = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).replace('http://wb', '')
    if (init?.method === 'POST') {
      posts.push({ path, body: JSON.parse(String(init.body)) as Record<string, unknown> })
      return new Response(JSON.stringify({ ok: true, note: '取消了,记录留着' }), { status: 200 })
    }
    return new Response('{}', { status: 404 })
  }) as typeof fetch
  return { fetchImpl, posts }
}

/** 七态里除 done / canceled 之外的那几种 —— 每一种都该有那一颗。 */
const LIVE: TaskView['status'][] = ['backlog', 'todo', 'doing', 'blocked', 'confirm']

describe('取消事项这一颗什么时候出现', () => {
  it.each(LIVE)('%s(非终态)→ 有', (status) => {
    const { fetchImpl } = fakeServer()
    render(<ItemControls task={task({ status })} sessions={[]} baseUrl="http://wb" fetchImpl={fetchImpl} />)
    expect(screen.getByRole('button', { name: '取消事项' })).toBeInTheDocument()
  })

  it.each(['done', 'canceled'] as const)('%s(终态)→ 没有', (status) => {
    const { fetchImpl } = fakeServer()
    render(<ItemControls task={task({ status })} sessions={[]} baseUrl="http://wb" fetchImpl={fetchImpl} />)
    expect(screen.queryByRole('button', { name: '取消事项' })).toBeNull()
  })

  it('终态又没别的可做 → 整块不画(加这一颗之前的行为逐字不变)', () => {
    const { fetchImpl } = fakeServer()
    const { container } = render(<ItemControls task={task({ status: 'done' })} sessions={[]} baseUrl="http://wb" fetchImpl={fetchImpl} />)
    expect(container.querySelector('[data-testid="item-controls"]')).toBeNull()
  })
})

describe('点下去发什么、回执怎么说', () => {
  it('POST /task/move {status:canceled},回执原样说出来', async () => {
    const { fetchImpl, posts } = fakeServer()
    render(<ItemControls task={task({ status: 'doing' })} sessions={[]} baseUrl="http://wb" fetchImpl={fetchImpl} />)
    await userEvent.click(screen.getByRole('button', { name: '取消事项' }))
    await waitFor(() => expect(posts).toEqual([{ path: '/task/move', body: { id: 't-1', status: 'canceled' } }]))
    expect(await screen.findByText('取消了,记录留着')).toBeInTheDocument()
  })

  it('不给它自己的配色:身上没有 class(用这一排现成那一套)', () => {
    const { fetchImpl } = fakeServer()
    render(<ItemControls task={task({ status: 'doing' })} sessions={[]} baseUrl="http://wb" fetchImpl={fetchImpl} />)
    expect(screen.getByRole('button', { name: '取消事项' }).getAttribute('class')).toBeNull()
  })
})
