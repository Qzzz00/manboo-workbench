/**
 * 协作区读事项类型表(2026-10-22,统筹转维护者:类型名不写死,做成设置)。
 * 名字、图标、暗亮两套底色都从 `/state.tasks.work_types` 读;表里没有的类型照中性灰画。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { CollabWorkTypeView, TaskView, WorkbenchState } from '../src/protocol.ts'
import { DEFAULT_WORK_TYPES, WORK_TYPE_ICONS } from '../src/protocol.ts'
import { CollabZone, TIMELINE_MODE_KEY } from '../src/client/collab/CollabZone.tsx'
import { workTypeStyle } from '../src/client/collab/workTypes.tsx'
import { Icon } from '../src/client/ui/icons.tsx'

// 这些用例看的是「按日期」那张日程。时间线缺省是人和 Agent 占用(决策记录 10-27「已拍板:呈现语义」),
// 先把偏好选成按日期,同用户切过一次一样。
beforeEach(() => { localStorage.setItem(TIMELINE_MODE_KEY, 'days') })

afterEach(cleanup)
beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never
})

const DAY = '2026-10-21'
const local = (hm: string): string => new Date(`${DAY}T${hm}:00`).toISOString()
const NOW = Date.parse(local('12:24'))
const note = (id: string, patch: Partial<TaskView>): TaskView => ({ id, title: id, status: 'todo', source: { kind: 'manual' }, created_at: local('08:00'), updated_at: local('08:00'), ...patch })
const GROWTH: CollabWorkTypeView = { id: 'growth', title: '推广获客', icon: 'megaphone', color: { dark: '#dce4c5', light: '#eff4df' } }

function zone(types: readonly CollabWorkTypeView[] | undefined, tasks: TaskView[]) {
  const state = {
    now: new Date(NOW).toISOString(),
    sessions: [],
    tasks: { tasks, sprints: [], modules: [], project_meta: [], goals: [], goal_sprints: [], agent_cards: [], session_proposals: [], squads: [], timers: [], mcp: [], ...(types === undefined ? {} : { work_types: types }) },
    agent_registry: { entries: [], asking: [], notices: [] },
  } as unknown as WorkbenchState
  const impl = (async () => new Response(JSON.stringify({ layout: { goals: {}, notes: {} } }), { status: 200 })) as typeof fetch
  return render(<div style={{ position: 'relative' }}><CollabZone state={state} baseUrl="http://127.0.0.1:8791" fetchImpl={impl} presence={[]} visible nowMs={NOW} timelineWidth={1228} /></div>)
}

describe('协作区读类型表', () => {
  it('没给表:图例是缺省四类(会议 / 研发与设计 / 内容与推广 / 经营与其他)', () => {
    zone(undefined, [note('甲', { start: local('09:00'), end: local('10:00') })])
    expect([...within(screen.getByLabelText('类型')).getAllByText(/./)].map(one => one.textContent)).toEqual(['会议', '研发与设计', '内容与推广', '经营与其他'])
  })

  it('表里新加一类:图例、卡头、底色都跟着;表里没有的类型照中性灰', () => {
    const { container } = zone([...DEFAULT_WORK_TYPES, GROWTH], [
      note('投广告', { start: local('09:00'), end: local('11:00'), work_type: 'growth' }),
      note('旧类型', { start: local('14:00'), end: local('15:00'), work_type: 'gone' }),
    ])
    expect(within(screen.getByLabelText('类型')).getByText('推广获客')).toBeInTheDocument()
    const card = screen.getByLabelText('便签 投广告')
    expect(card).toHaveAttribute('data-type', 'growth')
    expect(within(card).getByText('推广获客')).toBeInTheDocument()
    expect(screen.getByLabelText('便签 旧类型')).toHaveAttribute('data-type', 'none')
    expect(container.querySelector('style')?.textContent).toContain('--t-growth:#dce4c5')
  })

  it('底色样式:暗亮各一份,按 data-type 认', () => {
    const css = workTypeStyle([GROWTH])
    expect(css).toContain('.ben-cl[data-theme=dark]{--t-growth:#dce4c5}')
    expect(css).toContain('.ben-cl[data-theme=light]{--t-growth:#eff4df}')
    expect(css).toContain('.ben-cl [data-type="growth"]{--cl-tbg:var(--t-growth)}')
  })

  it('能挑的图标每一枚都画得出来(协议里的单子与客户端那套一一对应)', () => {
    for (const name of WORK_TYPE_ICONS) {
      const { container, unmount } = render(<Icon name={name} />)
      expect(container.querySelector('svg')?.children.length, name).toBeGreaterThan(0)
      unmount()
    }
  })
})
