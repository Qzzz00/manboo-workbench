/**
 * 习惯的小尾巴 · 电脑这一半(2026-10-10):
 *   ① 收件箱「新学到一条」那一张:点开有「撤掉」(`POST /habits/revoke`)与「知道了」(`POST /habits/seen`),回执原样摆;
 *   ② 「它学到了什么」撤掉的那几条有「恢复」(`POST /habits/restore`);
 *   ③ 进化日志摘要取**最新**那一句结论(恢复过的那条不再显示成「她撤掉了」)。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { HabitNoticeActions } from '../src/client/HabitNoticeActions.tsx'
import { HABITS_RETIRED_NOTE, HabitsPanel, evolveLogDigest } from '../src/client/HabitsPanel.tsx'
import { buildButlerScene } from '../src/client/butlerSceneModel.ts'
import { inboxCard } from '../src/client/orb.ts'
import type { ButlerInboxItem, HabitsView, HabitView, WorkbenchState } from '../src/protocol.ts'

configure({ asyncUtilTimeout: 5_000 })
afterEach(() => { cleanup() })

const ITEM: ButlerInboxItem = {
  id: 'habit:时段:13',
  kind: 'habit',
  title: '新学到一条:13:00–14:00 不打电话,改发消息,正在试用',
  note: '依据:10-05 13:10 那一通没接;10-06 13:40 那一通没接。下一次同类的事你没纠正就留下;不对就点「撤掉」。',
  at: '2026-10-06T12:00:00.000Z',
  habit: { id: '时段:13' },
}

function fakeFetch(reply: Record<string, unknown>) {
  const calls: { path: string, body: unknown }[] = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ path: String(input).replace('http://wb', ''), body: JSON.parse(String(init?.body ?? '{}')) })
    return new Response(JSON.stringify(reply), { status: 200 })
  }) as typeof fetch
  return { calls, fetchImpl }
}

describe('① 收件箱「新学到一条」', () => {
  it('收件箱条目带着习惯 id 上卡;台上归「需留意」、不染红', () => {
    expect(inboxCard(ITEM).habit).toEqual({ id: '时段:13' })
    const state = { now: '2026-10-07T01:00:00.000Z', sessions: [], agents: [], stale: false, butler_inbox: { items: [ITEM] } } as unknown as WorkbenchState
    const item = buildButlerScene(state, {}, []).items.find(one => one.id === ITEM.id)
    expect(item).toMatchObject({ habit: { id: '时段:13' }, group: 'attention', notice: 'neutral' })
  })

  it('点开:「撤掉」打 /habits/revoke,「知道了」打 /habits/seen,回执原样摆', async () => {
    const { calls, fetchImpl } = fakeFetch({ ok: true, note: '撤掉了:「13:00–14:00 不打电话」。撤错了在「它学到了什么」里点「恢复」。' })
    render(<HabitNoticeActions item={{ title: ITEM.title, habit: { id: '时段:13' } }} talk={{ baseUrl: 'http://wb', fetchImpl }} />)
    fireEvent.click(screen.getByRole('button', { name: `撤掉:${ITEM.title}` }))
    expect(await screen.findByRole('status')).toHaveTextContent('撤错了在「它学到了什么」里点「恢复」')
    fireEvent.click(screen.getByRole('button', { name: `知道了:${ITEM.title}` }))
    await waitFor(() => expect(calls).toHaveLength(2))
    expect(calls).toEqual([
      { path: '/habits/revoke', body: { id: '时段:13' } },
      { path: '/habits/seen', body: { id: '时段:13' } },
    ])
  })

  it('不是这一档、或没接对话那一段 → 一颗键都不画', () => {
    const { fetchImpl } = fakeFetch({})
    const { container } = render(<>
      <HabitNoticeActions item={{ title: 'x' }} talk={{ baseUrl: 'http://wb', fetchImpl }} />
      <HabitNoticeActions item={{ title: 'x', habit: { id: 'a' } }} talk={undefined} />
    </>)
    expect(container.querySelectorAll('button')).toHaveLength(0)
  })
})

const GONE: HabitView = {
  id: '时段:12', kind: 'quiet', kind_title: '什么时候打电话', text: '12 点这个钟点不打电话,改成消息',
  status: 'removed', evidence: [], applied: 0,
  adopted_at: '2026-10-05T04:00:00.000Z', updated_at: '2026-10-06T04:00:00.000Z', verdict: '她点了撤掉',
}

describe('② 撤错能恢复', () => {
  it('撤掉的每条一颗「恢复」→ POST /habits/restore;恢复后挪回「正在试用」', async () => {
    let habits: HabitsView = { trial: [], kept: [], retired: [GONE] }
    const posts: { path: string, body: unknown }[] = []
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).replace('http://wb', '')
      if (init?.method === 'POST') {
        posts.push({ path, body: JSON.parse(String(init.body)) })
        habits = { trial: [{ ...GONE, status: 'trial' }], kept: [], retired: [] }
        return new Response(JSON.stringify({ ok: true, note: '恢复了:「12 点…」,重新试用,下一次同类的事照常验证。' }), { status: 200 })
      }
      if (path === '/habits') return new Response(JSON.stringify(habits), { status: 200 })
      return new Response('{}', { status: 404 })
    }) as typeof fetch
    const user = userEvent.setup()
    render(<HabitsPanel baseUrl="http://wb" fetchImpl={fetchImpl} />)
    // 撤掉的那几条收在「已撤下 N 条 · 展开 ›」里(2026-10-22 照评审页)
    await user.click(await screen.findByText('已撤下 1 条'))
    await screen.findByText(GONE.text)
    expect(screen.getByText(HABITS_RETIRED_NOTE)).toBeInTheDocument()
    expect(HABITS_RETIRED_NOTE).toContain('恢复')
    expect(screen.queryByRole('button', { name: '撤回' })).toBeNull()
    await user.click(screen.getByRole('button', { name: '恢复' }))
    await waitFor(() => expect(posts).toEqual([{ path: '/habits/restore', body: { id: GONE.id } }]))
    expect(await screen.findByText(/照常验证/u)).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: '撤回' })).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: '恢复' })).toBeNull()
  })
})

describe('③ 进化日志摘要取最新那一句', () => {
  it('撤了又恢复:摘要写「她恢复了」', () => {
    const log = [
      '# 进化日志',
      '',
      '## 2026-10-06 试用习惯(什么时候打电话):12 点这个钟点不打电话,改成消息',
      '- **提议 id**:`时段:12`',
      // annotateLog 把新的一行插在 id 那一行正下方:新的在上
      '- **她恢复了**:2026-10-07 —— 重新试用,照常验证(习惯 id `时段:12`)',
      '- **她撤掉了**:2026-10-06 —— 她点了撤掉(习惯 id `时段:12`)',
      '',
    ].join('\n')
    expect(evolveLogDigest(log, 5)[0]?.latest).toBe('她恢复了:2026-10-07 —— 重新试用,照常验证')
  })
})
