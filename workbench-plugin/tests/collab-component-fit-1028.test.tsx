// 协作区组件态(嵌在格子里、非全屏)按空间自适应(2026-10-28 18:5x 维护者拍板,决策记录同日):
// 组件态去掉「事项轨迹」整节,高度全给阅读区,轨迹只在全屏显示;「卡片颜色 = 完成情况」图例本身可点,点哪个颜色就只看那种卡
// (所有目标都筛、可多选、再点取消),与筛选行里新加的「进行中」同一份状态;窄窗里卡按可用宽度排一列 / 两列,高度按内容。
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { CollabGoal, CollabPresence, TaskView, WorkbenchState } from '../src/protocol.ts'
import { CollabZone } from '../src/client/collab/CollabZone.tsx'
import { matchesFilter } from '../src/client/collab/collabModel.ts'
import { COLLAB_STYLE } from '../src/client/collab/collabStyle.ts'
import { PROGRESS_EMPTY_TEXT } from '../src/client/collab/ReadingBoard.tsx'

afterEach(() => { cleanup(); localStorage.clear() })
beforeAll(() => { globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never })

const AT = '2026-10-28T09:00:00.000Z'
const goal = (id: string, title: string): CollabGoal => ({ id, title, owner: 'me', status: 'open', created_at: AT, updated_at: AT }) as CollabGoal
const task = (id: string, goalId: string, status: TaskView['status']): TaskView => ({ id, title: `事项-${id}`, status, source: { kind: 'manual' }, created_at: AT, updated_at: AT, goal_id: goalId })
const tasks = [task('a', 'g1', 'doing'), task('b', 'g1', 'todo'), task('c', 'g2', 'doing'), task('d', 'g2', 'confirm'), task('e', 'g2', 'done')]
const state = {
  now: AT, sessions: [],
  tasks: { tasks, sprints: [], modules: [], project_meta: [], goals: [goal('g1', '座机出门也能接'), goal('g2', '周五发样片')], goal_sprints: [], agent_cards: [], session_proposals: [] },
  agent_registry: { entries: [], asking: [], notices: [] },
} as unknown as WorkbenchState
const fetchImpl = (async (input: string) => new Response(JSON.stringify(new URL(input).pathname === '/collab/canvas' ? { layout: { goals: {}, notes: {} } } : { ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch
const zone = (full: boolean) => render(
  <div style={{ width: 785, height: 766, position: 'relative' }}>
    <CollabZone state={state} baseUrl="http://127.0.0.1:8791" fetchImpl={fetchImpl} presence={[] as CollabPresence[]} visible initialView="goals" {...(full ? { onExitFull: () => {} } : { onExpand: () => {} })} />
  </div>,
)
const cardsShown = (): string[] => [...screen.getByRole('region', { name: '目标阅读区' }).querySelectorAll<HTMLElement>('[data-note-id]')].map(one => one.dataset.noteId ?? '')
const legend = () => screen.getByRole('note', { name: '卡片颜色表示完成情况' })

describe('组件态不画事项轨迹,全屏照画', () => {
  it('★组件态:没有「事项轨迹」那一节', async () => {
    zone(false)
    await screen.findByRole('region', { name: '目标阅读区' })
    expect(screen.queryByRole('region', { name: '事项轨迹' })).toBeNull()
  })
  it('全屏:「事项轨迹」照旧在', async () => {
    zone(true)
    expect(await screen.findByRole('region', { name: '事项轨迹' })).toBeInTheDocument()
  })
})

describe('图例可点:点哪个颜色只看那种卡', () => {
  it('★点「进行中」:所有目标里只剩进行中的卡;按钮是按下态;再点一次全回来', async () => {
    zone(false)
    await screen.findByRole('region', { name: '目标阅读区' })
    expect(cardsShown().sort()).toEqual(['a', 'b', 'c', 'd', 'e'])
    const doing = within(legend()).getByRole('button', { name: '只看 进行中' })
    expect(doing).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(doing)
    expect(doing).toHaveAttribute('aria-pressed', 'true')
    expect(cardsShown().sort()).toEqual(['a', 'c'])
    fireEvent.click(doing)
    expect(cardsShown().sort()).toEqual(['a', 'b', 'c', 'd', 'e'])
  })
  it('★几个颜色可多选:进行中 + 待验收', async () => {
    zone(false)
    await screen.findByRole('region', { name: '目标阅读区' })
    fireEvent.click(within(legend()).getByRole('button', { name: '只看 进行中' }))
    fireEvent.click(within(legend()).getByRole('button', { name: '只看 待验收' }))
    expect(cardsShown().sort()).toEqual(['a', 'c', 'd'])
  })
  it('一张都没有:说一句怎么取消,不留白', async () => {
    zone(false)
    await screen.findByRole('region', { name: '目标阅读区' })
    fireEvent.click(within(legend()).getByRole('button', { name: '只看 受阻' }))
    expect(cardsShown()).toEqual([])
    expect(screen.getByRole('region', { name: '目标阅读区' })).toHaveTextContent(PROGRESS_EMPTY_TEXT(['受阻']))
  })
})

describe('筛选行的「进行中」与图例同一份状态', () => {
  it('★筛选行点「进行中」= 图例「进行中」按下;图例取消 = 筛选行弹起', async () => {
    zone(false)
    await screen.findByRole('region', { name: '目标阅读区' })
    const row = screen.getByRole('button', { name: '筛选:只看进行中' })
    fireEvent.click(row)
    expect(row).toHaveAttribute('aria-pressed', 'true')
    expect(within(legend()).getByRole('button', { name: '只看 进行中' })).toHaveAttribute('aria-pressed', 'true')
    expect(cardsShown().sort()).toEqual(['a', 'c'])
    fireEvent.click(within(legend()).getByRole('button', { name: '只看 进行中' }))
    expect(row).toHaveAttribute('aria-pressed', 'false')
  })
  it('matchesFilter 认 progress(时间线、画布同用这一份)', () => {
    expect(matchesFilter(task('x', 'g1', 'doing'), [], [], { progress: ['doing'] })).toBe(true)
    expect(matchesFilter(task('x', 'g1', 'confirm'), [], [], { progress: ['doing'] })).toBe(false)
    expect(matchesFilter(task('x', 'g1', 'confirm'), [], [], { progress: ['doing', 'review'] })).toBe(true)
  })
})

describe('窄窗里卡按可用宽度排', () => {
  it('★卡格最小宽不超过容器(460 宽一列不横向溢出;785 宽放得下两列就两列),高度按内容不写死', () => {
    const rule = COLLAB_STYLE.split('\n').find(line => line.startsWith('.ben-cl__rgrid{'))
    // 轨道按 1fr 分:放得下两张 260 就两列(370 的上限放在卡上,不放在轨道上 —— 轨道写死 370 时 auto-fill 按 370 算,785 宽只排得下一列)。
    expect(rule).toMatch(/minmax\(min\(260px,100%\),1fr\)/)
    expect(rule).not.toMatch(/[^-]height:/)
    expect(COLLAB_STYLE).toMatch(/\.ben-cl__rgrid>\.ben-cl__note\{max-width:370px\}/)
  })
})
