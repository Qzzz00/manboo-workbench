import '@testing-library/jest-dom/vitest'
/**
 * ★ **卡上看得见排队、堵了、重置的原因;每一家有一颗「重置这一家」**(2026-10-21,卡「派活按家隔离」)。
 *
 * 「做完的样子」那一句:卡上看得见排队、超时、重置的原因。原因由服务端写进 `dispatch_lane.note`,
 * 卡面原样画一行(不藏在悬停里);「N 家」面板每行的「⋯」里多一颗「重置这一家」。
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TaskView } from '../src/protocol.ts'
import { AgentActions } from '../src/client/AgentActions.tsx'
import { TaskCard } from '../src/client/TaskCard.tsx'

afterEach(() => { cleanup() })

const AT = '2026-10-21T08:00:00Z'
const task = (over: Partial<TaskView>): TaskView => ({ id: 'a', title: '起三个标题', status: 'doing', source: { kind: 'manual' }, created_at: AT, updated_at: AT, ...over }) as TaskView
const card = (one: TaskView) => render(<TaskCard task={one} sessions={[]} sessionUsage={{}} nowMs={Date.parse(AT)} onOpen={() => {}} onDragStart={() => {}} onDragEnd={() => {}} />)

describe('卡面上那一行', () => {
  it('★排着:「排在 X 后面」原样画在卡面上', () => {
    card(task({ dispatch_lane: { family: 'doubao', state: 'queued', since: AT, note: '排在「写一段开场白」后面:豆包 同一时刻只送一件,前一件收回来就送这一件', behind: 'b' } }))
    const line = screen.getByText(/排在「写一段开场白」后面/)
    expect(line).toHaveAttribute('data-state', 'queued')
  })

  it('★读不动:「通道堵了」那一句(哪家、哪一步、等了多久)画在卡面上', () => {
    card(task({ dispatch_lane: { family: 'doubao', state: 'jammed', since: AT, note: '豆包 的窗口卡住了:读回话那一步等了 20 秒没回应 —— 先跳过它,别家照常;点「重置这一家」可以清掉这条通道' } }))
    expect(screen.getByText(/读回话那一步等了 20 秒/)).toHaveAttribute('data-state', 'jammed')
  })

  it('没有那一格:一行都不画', () => {
    card(task({}))
    expect(document.querySelector('.ben-wb__task-lane')).toBeNull()
  })
})

describe('「重置这一家」那颗键', () => {
  it('★点了发 /dispatch/family/reset,把服务端那一句摆出来', async () => {
    const calls: { path: string, body: unknown }[] = []
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ path: String(input).replace('http://wb', ''), body: JSON.parse(String(init?.body ?? '{}')) })
      return new Response(JSON.stringify({ ok: true, note: '已重置 豆包:撤了 2 下在等的读窗' }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    render(<AgentActions item={{ title: '豆包', agent: { id: 'doubao' } }} talk={{ baseUrl: 'http://wb', fetchImpl }} />)
    fireEvent.click(screen.getByRole('button', { name: '重置这一家:豆包' }))
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]).toEqual({ path: '/dispatch/family/reset', body: { family: 'doubao' } })
    expect(await screen.findByRole('status')).toHaveTextContent('已重置 豆包')
  })
})
