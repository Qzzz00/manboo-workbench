/**
 * 第三轮 1(维护者 10-22 装 0.4.143 后):接入的智能体只在协作区「成员」那排出现一次,顶栏那排去掉;
 * 协作区里每一家照顶栏原来的样子:受保护的 `AgentIcon`(在干活的状态角标同一判据)、悬停小浮窗(同一张卡)。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { AgentEntryView, TaskView, WorkbenchState } from '../src/protocol.ts'
import { CollabZone, TIMELINE_MODE_KEY } from '../src/client/collab/CollabZone.tsx'
import type { TopBarLamp } from '../src/client/TopBar.tsx'

// 这些用例看的是「按日期」那张日程。时间线缺省是人和 Agent 占用(决策记录 10-27「已拍板:呈现语义」),
// 先把偏好选成按日期,同用户切过一次一样。
beforeEach(() => { localStorage.setItem(TIMELINE_MODE_KEY, 'days') })

afterEach(cleanup)
beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never
})

const NOW = Date.parse('2026-10-21T12:24:00+08:00')
const ENTRIES = [{ id: 'claude', name: 'Claude', status: 'running' }] as unknown as AgentEntryView[]
const STATE = {
  now: new Date(NOW).toISOString(),
  sessions: [],
  tasks: { tasks: [], sprints: [], modules: [], project_meta: [], goals: [], goal_sprints: [], agent_cards: [], session_proposals: [], squads: [], timers: [], mcp: [] },
  agent_registry: { entries: ENTRIES, asking: [], notices: [] },
} as unknown as WorkbenchState
const LAMP: TopBarLamp = { id: 'claude', name: 'Claude', color: 'running', icon: true, detail: { state: '在跑 · 2 条会话', latest: '正在改登录页' } }

describe('成员那排里的智能体', () => {
  it('图标用受保护的 AgentIcon、带状态角标;悬停出顶栏原来那张说明卡', () => {
    const impl = (async () => new Response('{}', { status: 200 })) as typeof fetch
    render(<div style={{ position: 'relative' }}><CollabZone state={STATE} baseUrl="http://x" fetchImpl={impl} presence={[]} visible nowMs={NOW} timelineWidth={1228} lamps={[LAMP]} /></div>)
    const strip = screen.getByRole('group', { name: '成员' })
    const chip = within(strip).getByRole('button', { name: '看 Claude 的相关事项' })
    expect(chip.querySelector('.ben-wb__agenticon')).not.toBeNull()
    expect(chip).toHaveAttribute('data-status', 'running')
    fireEvent.mouseEnter(chip.parentElement as HTMLElement)
    const card = screen.getByRole('dialog', { name: 'Claude' })
    expect(card).toHaveTextContent('在跑 · 2 条会话')
    expect(card).toHaveTextContent('正在改登录页')
    fireEvent.mouseLeave(chip.parentElement as HTMLElement)
    expect(screen.queryByRole('dialog', { name: 'Claude' })).toBeNull()
  })
})

/*
 * 第三轮 6(维护者):「点一个成员标签,显示跟它有关的所有事项」必须保留 —— 成员换成灯的样子之后照样能点。
 * 改前(PersonLabel)与改后(LampHover 里那颗)都验「点 Claude 只剩 Claude 的事项」。
 */
describe('点成员只看它的事项', () => {
  const local = (hm: string): string => new Date(`2026-10-21T${hm}:00`).toISOString()
  const note = (id: string, assignee: string, hm: string): TaskView => ({ id, title: id, status: 'todo', source: { kind: 'manual' }, created_at: local('08:00'), updated_at: local('08:00'), start: local(hm), end: local(hm.replace(/^(\d\d)/, h => String(Number(h) + 1).padStart(2, '0'))), assignee } as TaskView)
  const withNotes = { ...STATE, tasks: { ...STATE.tasks, tasks: [note('Claude 的', 'claude', '10:00'), note('我的', 'me', '14:00')] } } as unknown as WorkbenchState
  const impl = (async () => new Response('{}', { status: 200 })) as typeof fetch

  for (const [title, lamps] of [['灯的样子(有 lamps)', [LAMP]], ['没有 lamps(PersonLabel)', undefined]] as const) {
    it(`${title}:点 Claude 只剩 Claude 的事项,再点一次回到全部`, () => {
      render(<div style={{ position: 'relative' }}><CollabZone state={withNotes} baseUrl="http://x" fetchImpl={impl} presence={[]} visible nowMs={NOW} timelineWidth={1228} {...(lamps === undefined ? {} : { lamps })} /></div>)
      const strip = screen.getByRole('group', { name: '成员' })
      const chip = within(strip).getByRole('button', { name: '看 Claude 的相关事项' })
      fireEvent.click(chip)
      expect(chip).toHaveAttribute('aria-pressed', 'true')
      expect(screen.getByLabelText('便签 Claude 的')).toHaveAttribute('data-related', 'true')
      expect(screen.getByLabelText('便签 我的')).toHaveAttribute('data-dim', 'true')
      fireEvent.click(chip)
      expect(screen.getByLabelText('便签 我的')).toHaveAttribute('data-dim', 'false')
    })
  }
})

describe('卡面上负责人芯片用各家 logo', () => {
  const local = (hm: string): string => new Date(`2026-10-21T${hm}:00`).toISOString()
  const note = (id: string, assignee: string): TaskView => ({
    id, title: id, status: 'todo', source: { kind: 'manual' },
    created_at: local('08:00'), updated_at: local('08:00'),
    start: local('10:00'), end: local('11:00'),
    assignee,
  } as TaskView)

  it('Codex 负责的卡芯片是 Codex logo', async () => {
    const state: WorkbenchState = {
      ...STATE,
      tasks: {
        ...STATE.tasks,
        tasks: [note('Codex 事项', 'codex')],
        goals: [{ id: 'g-1', title: '目标一', why: '', owner: 'me', status: 'open', created_at: local('08:00'), updated_at: local('08:00') }],
      },
      agent_registry: { entries: [{ id: 'codex', name: 'Codex', status: 'idle' } as unknown as AgentEntryView], asking: [], notices: [] },
    } as unknown as WorkbenchState
    const impl = (async () => new Response('{}', { status: 200 })) as typeof fetch
    render(<div style={{ position: 'relative' }}><CollabZone state={state} baseUrl="http://x" fetchImpl={impl} presence={[]} visible nowMs={NOW} timelineWidth={1228} initialView="timeline" /></div>)

    // 卡面上的负责人芯片
    const noteCard = screen.getByLabelText('便签 Codex 事项')
    const ownerChip = within(noteCard).getByRole('button', { name: '看 Codex 的相关事项' })
    const icon = ownerChip.querySelector('.ben-wb__agenticon')
    expect(icon).not.toBeNull()
    const img = icon?.querySelector('img')
    expect(img).toHaveAttribute('src', expect.stringContaining('/agents/icon/codex'))
  })

  it('名片负责人的卡芯片按 runtime.family 取 logo', async () => {
    const cardId = 'agent:local:1'
    const state: WorkbenchState = {
      ...STATE,
      tasks: {
        ...STATE.tasks,
        tasks: [note('小K 事项', cardId)],
        agent_cards: [{
          id: cardId,
          name: '小K',
          hand: 'kimi',
          duty: '写代码',
          runtime: { family: 'kimi' },
          status: 'idle',
        }],
        goals: [{ id: 'g-1', title: '目标一', why: '', owner: 'me', status: 'open', created_at: local('08:00'), updated_at: local('08:00') }],
      },
      agent_registry: { entries: [{ id: 'kimi', name: 'Kimi', status: 'idle' } as unknown as AgentEntryView], asking: [], notices: [] },
    } as unknown as WorkbenchState
    const impl = (async () => new Response('{}', { status: 200 })) as typeof fetch
    render(<div style={{ position: 'relative' }}><CollabZone state={state} baseUrl="http://x" fetchImpl={impl} presence={[]} visible nowMs={NOW} timelineWidth={1228} initialView="timeline" /></div>)

    // 卡面上的负责人芯片
    const noteCard = screen.getByLabelText('便签 小K 事项')
    const ownerChip = within(noteCard).getByRole('button', { name: '看 小K 的相关事项' })
    const icon = ownerChip.querySelector('.ben-wb__agenticon')
    expect(icon).not.toBeNull()
    const img = icon?.querySelector('img')
    expect(img).toHaveAttribute('src', expect.stringContaining('/agents/icon/kimi'))
  })
})

