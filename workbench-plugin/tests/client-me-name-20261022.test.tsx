/**
 * 第三轮 8(维护者 10-22):协作区名片、便签负责人等写用户自己的地方不写「你」,写账号名
 * (`/state.me.name`:称呼优先,没有就本机账号用户名);两样都没有时写「我」。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { AgentEntryView, TaskView, WorkbenchState } from '../src/protocol.ts'
import { CollabZone } from '../src/client/collab/CollabZone.tsx'
import { railCards } from '../src/client/collab/collabModel.ts'
import { ME_FALLBACK, MeNameProvider } from '../src/client/meName.tsx'
import { todayCardFace } from '../src/client/TodayModule.tsx'

afterEach(cleanup)
beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never
})

const NOW = Date.parse('2026-10-21T12:24:00+08:00')
const TASK: TaskView = {
  id: 't1', title: '改登录页', status: 'todo', assignee: 'me', source: { kind: 'manual' },
  due: '2026-10-21', created_at: '2026-10-21T01:00:00.000Z', updated_at: '2026-10-21T01:00:00.000Z',
}
const STATE = {
  now: new Date(NOW).toISOString(),
  sessions: [],
  tasks: { tasks: [TASK], sprints: [], modules: [], project_meta: [], goals: [], goal_sprints: [], agent_cards: [], session_proposals: [], squads: [], timers: [], mcp: [] },
  agent_registry: { entries: [] as AgentEntryView[], asking: [], notices: [] },
} as unknown as WorkbenchState

function zone(name: string | undefined) {
  const impl = (async () => new Response('{}', { status: 200 })) as typeof fetch
  render(
    <MeNameProvider name={name}>
      <div style={{ position: 'relative' }}><CollabZone state={STATE} baseUrl="http://x" fetchImpl={impl} presence={[]} visible nowMs={NOW} timelineWidth={1228} /></div>
    </MeNameProvider>,
  )
  return screen.getByRole('region', { name: '协作区' })
}

describe('写用户自己的地方用账号名', () => {
  it('名片栏第一张、便签上的负责人:写账号名,不写「你」', () => {
    const region = zone('小本')
    const strip = within(region).getByRole('group', { name: '成员' })
    expect(within(strip).getByRole('button', { name: '看 小本 的相关事项' })).toBeInTheDocument()
    expect(within(region).getAllByText('小本').length).toBeGreaterThan(1)
    expect(within(region).queryByText('你', { exact: true })).toBeNull()
  })

  it('没有称呼也没有账号:写「我」', () => {
    const region = zone(undefined)
    expect(ME_FALLBACK).toBe('我')
    expect(within(within(region).getByRole('group', { name: '成员' })).getByRole('button', { name: '看 我 的相关事项' })).toBeInTheDocument()
    expect(within(region).queryByText('你', { exact: true })).toBeNull()
  })

  it('名片表、今天那张卡的负责人:同一个名字', () => {
    expect(railCards([], [], [], '小本')[0]).toMatchObject({ id: 'me', name: '小本' })
    expect(todayCardFace({ id: 't1', title: '改登录页', due: '2026-10-21', done: false } as never, TASK, { date: '2026-10-21', tomorrow: '2026-10-22' }, '小本').owner).toBe('小本')
  })
})
