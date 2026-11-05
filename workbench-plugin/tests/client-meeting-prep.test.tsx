/**
 * 电脑上的会前准备(2026-10-10,卡「会前画像与预案」):一问一答、目的说不清先拦(只拟不发)、预案卡全本、
 * 会后那一句「定下来没有」。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ButlerScene } from '../src/client/ButlerScene.tsx'
import { MeetingPrepAsk, meetingPrepRowText } from '../src/client/MeetingPrepAsk.tsx'
import type { ButlerInboxItem, MeetingView, WorkbenchState } from '../src/protocol.ts'

afterEach(cleanup)

const BASE: MeetingView = {
  id: 'm1', title: '跟 B 客户谈下季度合作', date: '2026-10-10', started_at: '2026-10-10T02:00:00.000Z', status: 'planned',
  segments: 0, todos: [], unsure: [],
  prep: {
    said: '下午三点跟 B 客户谈下季度合作', when: '下午三点',
    scope: { value: '外部', from: 'said' },
    ask: { id: 'kind', text: '什么类型的会?', choices: ['例会', '谈判会'] },
    card_status: 'answers',
  },
}

function fetchOk(): ReturnType<typeof vi.fn> {
  return vi.fn(async () => new Response(JSON.stringify({ ok: true, note: '还差一问:谁来' })))
}

describe('会前准备那张卡', () => {
  it('认出来的写明出处;点选项就答这一问(带这场的 id 与问题)', async () => {
    const fetchImpl = fetchOk()
    render(<MeetingPrepAsk meeting={BASE} baseUrl="http://x" fetchImpl={fetchImpl as unknown as typeof fetch} />)
    expect(screen.getByText('(你那句话里说的)')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '谈判会' }))
    await waitFor(() => expect(fetchImpl).toHaveBeenCalled())
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://x/meeting/answer')
    expect(JSON.parse(String(init.body))).toEqual({ id: 'm1', question: 'kind', answer: '谈判会' })
    expect(await screen.findByText('还差一问:谁来')).toBeInTheDocument()
    expect(meetingPrepRowText(BASE)).toContain('还差一问')
  })

  it('目的说不清:摆出拟好的那句,只有「复制」与「先照现在的准备」,没有「发送」', async () => {
    const fetchImpl = fetchOk()
    const { ask: _asked, ...rest } = BASE.prep!
    const blocked: MeetingView = { ...BASE, prep: { ...rest, goal_unclear: true, organizer_ask: '这次会主要想定哪几件事?我好提前准备。', card_status: 'goal' } }
    render(<MeetingPrepAsk meeting={blocked} baseUrl="http://x" fetchImpl={fetchImpl as unknown as typeof fetch} />)
    expect(screen.getByText('这次会主要想定哪几件事?我好提前准备。')).toBeInTheDocument()
    expect(screen.getByText(/发不发、发给谁由你/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /发送|发出去/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '先照现在的准备' }))
    await waitFor(() => expect(fetchImpl).toHaveBeenCalled())
    expect(JSON.parse(String((fetchImpl.mock.calls[0] as [string, RequestInit])[1].body))).toEqual({ id: 'm1', proceed: true })
  })

  it('预案卡:一个数带出处,没有的写「没有这个数」', () => {
    const ready: MeetingView = { ...BASE, prep: { said: 's', card_status: 'ready', card: { made_at: 'x', questions: [
      { q: '涨粉?', number: { text: '净涨粉 32', source: '小红书创作者数据' }, line: '涨了 32。', fallback: '会后补。' },
      { q: '预算?', none: true, line: '看这次谈的。', fallback: '会后补。' },
    ] } } }
    render(<MeetingPrepAsk meeting={ready} baseUrl="http://x" fetchImpl={vi.fn() as unknown as typeof fetch} />)
    expect(screen.getByText('(出处:小红书创作者数据)')).toBeInTheDocument()
    expect(screen.getByText('一个数:没有这个数')).toBeInTheDocument()
  })
})

describe('会后那一句(收件箱会议那一档)', () => {
  it('登记时要定的那件事 → 问定下来没有,按下去带 id 与答案', () => {
    const item: ButlerInboxItem = { id: 'meeting:m1', kind: 'meeting', title: '会议「谈合作」的纪要好了', at: '2026-10-10T10:00:00.000Z', meeting: { id: 'm1', ask_outcome: '敲定报价' } }
    const state = { agents: [], sessions: [], quota: {}, stale: false, now: '2026-10-10T10:00:00.000Z', tasks: { tasks: [], sprints: [], modules: [], project_meta: [] }, butler_inbox: { items: [item] } } as unknown as WorkbenchState
    const onMeetingOutcome = vi.fn()
    render(<ButlerScene state={state} onOpen={vi.fn()} onConfirm={vi.fn()} onMeetingOutcome={onMeetingOutcome}>粒子</ButlerScene>)
    fireEvent.click(screen.getByRole('button', { name: `查看事项:${item.title}` }))
    expect(screen.getByText('这场要定「敲定报价」,定下来了吗?')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '定了一部分' }))
    expect(onMeetingOutcome).toHaveBeenCalledWith('m1', 'partly')
  })
})
