/**
 * 会议那一档的「重新来」(2026-10-09,卡「会后真机走通」)。转写或梳理没成时,电脑收件箱那一档摆一颗键,
 * 按下去打 `/meeting/retry`;服务端说不能重来(`meeting.retryable` 缺席)就不摆 —— 一颗按了不起作用的键比没有更糟。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ButlerScene } from '../src/client/ButlerScene.tsx'
import type { ButlerInboxItem, WorkbenchState } from '../src/protocol.ts'

afterEach(cleanup)

const NOW = '2026-10-09T10:00:00.000Z'

function state(item: ButlerInboxItem): WorkbenchState {
  return {
    agents: [], sessions: [], quota: {}, stale: false, now: NOW,
    tasks: { tasks: [], sprints: [], modules: [], project_meta: [] },
    butler_inbox: { items: [item] },
  } as unknown as WorkbenchState
}

const FAILED: ButlerInboxItem = {
  id: 'meeting:m1', kind: 'meeting', title: '会议「周会」没整理成', note: '转写没接上', at: NOW,
  meeting: { id: 'm1', retryable: true },
}

describe('会议那一档的「重新来」', () => {
  it('能重来的那一场:点开摆「重新整理」,按下去带着这一场的 id', () => {
    const onRetryMeeting = vi.fn()
    render(<ButlerScene state={state(FAILED)} onOpen={vi.fn()} onConfirm={vi.fn()} onRetryMeeting={onRetryMeeting}>粒子</ButlerScene>)
    fireEvent.click(screen.getByRole('button', { name: `查看事项:${FAILED.title}` }))
    fireEvent.click(screen.getByRole('button', { name: `重新整理这场会:${FAILED.title}` }))
    expect(onRetryMeeting).toHaveBeenCalledWith('m1')
  })

  it('服务端没说能重来(做完了 / 正在整理)→ 不摆那颗键', () => {
    const done: ButlerInboxItem = { ...FAILED, title: '会议「周会」的纪要好了', meeting: { id: 'm1' } }
    render(<ButlerScene state={state(done)} onOpen={vi.fn()} onConfirm={vi.fn()} onRetryMeeting={vi.fn()}>粒子</ButlerScene>)
    fireEvent.click(screen.getByRole('button', { name: `查看事项:${done.title}` }))
    expect(screen.queryByRole('button', { name: /重新整理这场会/ })).toBeNull()
  })
})
