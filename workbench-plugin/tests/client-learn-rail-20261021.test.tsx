/**
 * 左栏「它学到了什么」(2026-10-21,视觉 A「左栏与学习」):计数、试用、验证三行各自数,一点一条,0 明示;
 * 标题键开设置那一节(机制解释在那一节里);取不到 `/habits` 整块缺席。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LearnRail, learnTally } from '../src/client/LearnRail.tsx'
import type { HabitView, HabitsView } from '../src/protocol.ts'

afterEach(cleanup)

const habit = (id: string, status: HabitView['status'], evidence: number): HabitView => ({
  id,
  kind: 'dispatch',
  kind_title: '默认派给谁',
  text: `做法 ${id}`,
  status,
  evidence: Array.from({ length: evidence }, (_, at) => ({ at: '2026-10-20T10:00:00Z', what: `第 ${at + 1} 次` })),
  applied: 0,
  adopted_at: '2026-10-20T10:00:00Z',
  updated_at: '2026-10-20T10:00:00Z',
})

const VIEW: HabitsView = {
  trial: [habit('a', 'trial', 3), habit('b', 'trial', 2)],
  kept: [habit('c', 'kept', 4)],
  retired: [habit('d', 'removed', 5)],
}

const answer = (body: unknown, ok = true) => vi.fn(async () => new Response(JSON.stringify(body), { status: ok ? 200 : 500 })) as unknown as typeof fetch

describe('learnTally', () => {
  it('记录数试用中与留下的依据条数;撤掉的不算', () => {
    expect(learnTally(VIEW)).toEqual({ records: 9, trial: 2, kept: 1 })
  })
})

describe('LearnRail', () => {
  it('三行各自一列点,一点一条', async () => {
    const { container } = render(<LearnRail baseUrl="http://x" fetchImpl={answer(VIEW)} onOpen={() => {}} />)
    await screen.findByRole('img', { name: '计数 9' })
    expect(screen.getByRole('img', { name: '试用 2' })).toBeTruthy()
    expect(screen.getByRole('img', { name: '验证 1' })).toBeTruthy()
    expect(container.querySelectorAll('.wb-ui-dot')).toHaveLength(12)
  })

  it('一条都没有:三行照写 0,不画点', async () => {
    const { container } = render(<LearnRail baseUrl="http://x" fetchImpl={answer({ trial: [], kept: [], retired: [] })} onOpen={() => {}} />)
    await screen.findByRole('img', { name: '验证 0' })
    expect(container.querySelectorAll('.wb-ui-dot')).toHaveLength(0)
  })

  it('取不到就整块缺席', async () => {
    const fetchImpl = answer({}, false)
    const { container } = render(<LearnRail baseUrl="http://x" fetchImpl={fetchImpl} onOpen={() => {}} />)
    await waitFor(() => expect(fetchImpl).toHaveBeenCalled())
    expect(container.textContent).toBe('')
  })

  it('标题本身是键「它学到了什么 ›」,点开设置那一节;不另画 ⓘ 与「查看与撤回」(评审页 `.rail-learning`,10-22 拍板照稿)', async () => {
    const onOpen = vi.fn()
    const { container } = render(<LearnRail baseUrl="http://x" fetchImpl={answer(VIEW)} onOpen={onOpen} />)
    await screen.findByRole('img', { name: '计数 9' })
    expect(screen.queryByRole('button', { name: /怎么数的/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /查看与撤回/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '它学到了什么' }))
    expect(onOpen).toHaveBeenCalled()
    expect(container.querySelector('.ben-wb__learn-cap')?.textContent).toBe('一点一次 · 分别计数')
    expect([...container.querySelectorAll('.ben-wb__learn-label')].map(one => one.textContent)).toEqual(['计数', '试用', '验证'])
  })
})
